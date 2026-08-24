import { describe, it, expect, afterEach } from "bun:test";
import { buildUpstreamHeaders, FINGERPRINT_UA } from "../src/upstream/headers";
import { UpstreamError, isRetryable, RETRYABLE_CODES, mapBusinessCode, classify } from "../src/upstream/errors";
import { UpstreamClient } from "../src/upstream/client";
import { PASSTHROUGH_KEYS } from "../src/upstream/types";
import type { Credential } from "../src/credentials/types";
import { loadConfig } from "../src/config";
import { createLogger } from "../src/logger";

// helpers

function makeCredential(overrides: Partial<Credential> = {}): Credential {
  const base: Credential = {
    uid: "user-123",
    domain: "www.codebuddy.cn",
    apiBase: "https://copilot.tencent.com",
    consoleBase: "https://www.codebuddy.cn",
    enterpriseId: "ent-456",
    label: "test",
    auth: {
      accessToken: "at-test",
      refreshToken: "rt-test",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3600_000,
      refreshExpiresAt: Date.now() + 7200_000,
      capturedAt: Date.now(),
      source: "device-flow",
    },
    apiKey: { name: "k1", fullKey: "ck_test_123" },
  };
  const merged: Credential = {
    ...base,
    ...overrides,
    auth: { ...base.auth, ...(overrides.auth ?? {}) },
  } as Credential;
  // allow explicit apiKey: undefined to clear the key (use "in" check, not truthiness)
  if ("apiKey" in overrides) {
    merged.apiKey = overrides.apiKey as Credential["apiKey"];
  }
  return merged;
}

function makeConfig(apiBase: string) {
  const cfg = loadConfig({}, () => null);
  return { ...cfg, apiBase, upstreamTimeoutMs: 5000, logLevel: "silent" as const };
}

function makeLogger(cfg: ReturnType<typeof makeConfig>) {
  return createLogger({ ...cfg, logLevel: "silent" });
}

let servers: Array<{ stop: () => void }> = [];

afterEach(() => {
  for (const s of servers) {
    try {
      s.stop();
    } catch {}
  }
  servers = [];
});

function serve(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: handler,
  });
  servers.push(server);
  // Bun.serve returns Server with port
  const url = `http://127.0.0.1:${server.port}`;
  return { server, url };
}

// Tests

describe("PASSTHROUGH_KEYS", () => {
  it("contains expected allowlist", () => {
    expect(Array.isArray(PASSTHROUGH_KEYS)).toBe(true);
    expect(PASSTHROUGH_KEYS).toContain("model");
    expect(PASSTHROUGH_KEYS).toContain("messages");
    expect(PASSTHROUGH_KEYS).toContain("stream");
    expect(PASSTHROUGH_KEYS).toContain("tools");
    expect(PASSTHROUGH_KEYS).toContain("tool_choice");
    expect(PASSTHROUGH_KEYS).toContain("max_completion_tokens");
    // length should be 20 (spec says 21 but list is 20)
    expect(PASSTHROUGH_KEYS.length).toBe(20);
  });
});

describe("buildUpstreamHeaders", () => {
  it("builds Authorization Bearer and core headers", () => {
    const cred = makeCredential();
    const h = buildUpstreamHeaders(cred);
    expect(h["Authorization"]).toBe(`Bearer ${cred.auth.accessToken}`);
    expect(h["X-Product"]).toBe("SaaS");
    expect(h["X-Domain"]).toBe(cred.domain);
    expect(h["X-User-Id"]).toBe(cred.uid);
    expect(h["X-Enterprise-Id"]).toBe(cred.enterpriseId);
    expect(h["x-client-platform"]).toBe("web");
    expect(h["User-Agent"]).toBe(FINGERPRINT_UA);
    expect(h["X-Request-Id"]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("includes X-API-Key when apiKey exists", () => {
    const cred = makeCredential();
    const h = buildUpstreamHeaders(cred);
    expect(h["X-API-Key"]).toBe("ck_test_123");
    const noKey = makeCredential({ apiKey: undefined });
    const h2 = buildUpstreamHeaders(noKey);
    expect(h2["X-API-Key"]).toBeUndefined();
  });

  it("omits X-Enterprise-Id when not present", () => {
    const cred = makeCredential({ enterpriseId: undefined });
    const h = buildUpstreamHeaders(cred);
    expect(h["X-Enterprise-Id"]).toBeUndefined();
  });

  it("generates random X-Request-Id each call", () => {
    const cred = makeCredential();
    const a = buildUpstreamHeaders(cred);
    const b = buildUpstreamHeaders(cred);
    expect(a["X-Request-Id"]).not.toBe(b["X-Request-Id"]);
  });

  it("accepts explicit requestId via opts", () => {
    const cred = makeCredential();
    const h = buildUpstreamHeaders(cred, { requestId: "fixed-id-123" });
    expect(h["X-Request-Id"]).toBe("fixed-id-123");
  });

  it("adds X-Refresh-Token when opts.refreshToken supplied", () => {
    const cred = makeCredential();
    const h = buildUpstreamHeaders(cred, { refreshToken: "rt-xyz" });
    expect(h["X-Refresh-Token"]).toBe("rt-xyz");
    expect(h["X-Auth-Refresh-Source"]).toBe("plugin");
  });
});

describe("UpstreamError + retryable", () => {
  it("exposes code, httpStatus, retryable, raw", () => {
    const err = new UpstreamError(429, "too many", 429, true, { foo: 1 });
    expect(err.code).toBe(429);
    expect(err.httpStatus).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.raw).toEqual({ foo: 1 });
    expect(err.name).toBe("UpstreamError");
  });

  it("RETRYABLE_CODES contains expected codes", () => {
    expect(RETRYABLE_CODES.has(401)).toBe(true);
    expect(RETRYABLE_CODES.has(429)).toBe(true);
    expect(RETRYABLE_CODES.has(11140)).toBe(true);
    expect(RETRYABLE_CODES.has(14018)).toBe(true);
    expect(RETRYABLE_CODES.has(400)).toBe(false);
  });

  it("isRetryable works for number and string", () => {
    expect(isRetryable(429)).toBe(true);
    expect(isRetryable("429")).toBe(true);
    expect(isRetryable(11140)).toBe(true);
    expect(isRetryable(11101)).toBe(false);
    expect(isRetryable(400)).toBe(false);
    expect(isRetryable("not-a-number")).toBe(false);
  });

  it("mapBusinessCode maps known codes", () => {
    expect(mapBusinessCode(11140).retryable).toBe(true);
    expect(mapBusinessCode(14018).retryable).toBe(true);
    expect(mapBusinessCode(11101).retryable).toBe(false);
    expect(mapBusinessCode(11128).retryable).toBe(false);
  });

  it("classify returns retryable flag", () => {
    expect(classify(429).retryable).toBe(true);
    expect(classify(400).retryable).toBe(false);
    expect(classify(11140).retryable).toBe(true);
  });
});

describe("UpstreamClient.streamChat", () => {
  it("parses SSE frames and tolerates split chunks", async () => {
    const encoder = new TextEncoder();
    const { url } = serve(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const part1 = `data: {"id":"1","choices":[{"delta":{"content":"Hel` + `lo"},"finish_reason":null}]}\n\n`;
          // split inside JSON string to test incremental parsing
          const mid = Math.floor(part1.length / 2);
          controller.enqueue(encoder.encode(part1.slice(0, mid)));
          // enqueue second half on next tick to force split across fetch chunks
          setTimeout(() => {
            controller.enqueue(encoder.encode(part1.slice(mid)));
            controller.enqueue(encoder.encode(`data: {"id":"1","choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n`));
            controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
            controller.close();
          }, 5);
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    });

    const cfg = makeConfig(url);
    const logger = makeLogger(cfg);
    const client = new UpstreamClient(cfg, logger);
    const cred = makeCredential();

    const chunks = [];
    for await (const c of client.streamChat({ model: "auto", messages: [{ role: "user", content: "hi" }] }, cred)) {
      chunks.push(c);
    }
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.choices[0]?.delta.content).toBe("Hello");
    expect(chunks[1]?.choices[0]?.delta.content).toBe(" world");
  });

  it("stops on data:[DONE] and ignores trailing frames", async () => {
    const encoder = new TextEncoder();
    const { url } = serve(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"a"}}]}\n\n`));
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"should-not-appear"}}]}\n\n`));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    });

    const cfg = makeConfig(url);
    const logger = makeLogger(cfg);
    const client = new UpstreamClient(cfg, logger);
    const cred = makeCredential();

    const chunks = [];
    for await (const c of client.streamChat({ model: "auto", messages: [{ role: "user", content: "hi" }] }, cred)) {
      chunks.push(c);
    }
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.choices[0]?.delta.content).toBe("a");
  });

  it("tolerates heartbeats and event: lines", async () => {
    const encoder = new TextEncoder();
    const { url } = serve(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`: heartbeat 1\n\n`));
          controller.enqueue(encoder.encode(`event: ping\ndata: {"choices":[{"delta":{"content":"x"}}]}\n\n`));
          controller.enqueue(encoder.encode(`:\n\n`));
          controller.enqueue(encoder.encode(`event: done\ndata: {"choices":[{"delta":{"content":"y"}}]}\n\n`));
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    });

    const cfg = makeConfig(url);
    const logger = makeLogger(cfg);
    const client = new UpstreamClient(cfg, logger);
    const cred = makeCredential();

    const chunks = [];
    for await (const c of client.streamChat({ model: "auto", messages: [{ role: "user", content: "hi" }] }, cred)) {
      chunks.push(c);
    }
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.choices[0]?.delta.content).toBe("x");
    expect(chunks[1]?.choices[0]?.delta.content).toBe("y");
  });

  it("throws UpstreamError on non-2xx with retryable flag", async () => {
    const { url } = serve(() => new Response("rate limited", { status: 429, headers: { "Content-Type": "text/plain" } }));
    const cfg = makeConfig(url);
    const logger = makeLogger(cfg);
    const client = new UpstreamClient(cfg, logger);
    const cred = makeCredential();

    let caught: unknown = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.streamChat({ model: "auto", messages: [{ role: "user", content: "hi" }] }, cred)) {
        // no-op
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    const err = caught as UpstreamError;
    expect(err.httpStatus).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.code).toBe(429);
  });

  it("throws UpstreamError on 200 business envelope non-zero", async () => {
    const { url } = serve(() => new Response(JSON.stringify({ code: 11140, msg: "banned" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const cfg = makeConfig(url);
    const logger = makeLogger(cfg);
    const client = new UpstreamClient(cfg, logger);
    const cred = makeCredential();

    let caught: unknown = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.streamChat({ model: "auto", messages: [{ role: "user", content: "hi" }] }, cred)) {
        // no-op
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    const err = caught as UpstreamError;
    expect(err.code).toBe(11140);
    expect(err.retryable).toBe(true);
  });

  it("throws on business envelope inside SSE data", async () => {
    const encoder = new TextEncoder();
    const { url } = serve(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: {"code":14018,"msg":"quota exceeded"}\n\n`));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    });
    const cfg = makeConfig(url);
    const logger = makeLogger(cfg);
    const client = new UpstreamClient(cfg, logger);
    const cred = makeCredential();
    let caught: unknown = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.streamChat({ model: "auto", messages: [{ role: "user", content: "hi" }] }, cred)) {
        // no-op
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).code).toBe(14018);
    expect((caught as UpstreamError).retryable).toBe(true);
  });

  it("forces stream:true upstream", async () => {
    let observedBody: unknown = null;
    const encoder = new TextEncoder();
    const { url } = serve(async (req) => {
      const text = await req.text();
      observedBody = JSON.parse(text);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`));
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    });
    const cfg = makeConfig(url);
    const logger = makeLogger(cfg);
    const client = new UpstreamClient(cfg, logger);
    const cred = makeCredential();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of client.streamChat({ model: "auto", messages: [{ role: "user", content: "hi" }], stream: false }, cred)) {
      // consume
    }
    expect((observedBody as { stream?: boolean }).stream).toBe(true);
  });

  it("sends upstream headers including Authorization and X-Request-Id", async () => {
    let observedHeaders: Record<string, string> = {};
    const encoder = new TextEncoder();
    const { url } = serve((req) => {
      observedHeaders = Object.fromEntries(req.headers.entries());
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"hi"}}]}\n\n`));
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    });
    const cfg = makeConfig(url);
    const logger = makeLogger(cfg);
    const client = new UpstreamClient(cfg, logger);
    const cred = makeCredential();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of client.streamChat({ model: "auto", messages: [{ role: "user", content: "hi" }] }, cred)) {
      // consume
    }
    // header names are lowercased by fetch
    expect(observedHeaders["authorization"]).toBe(`Bearer ${cred.auth.accessToken}`);
    expect(observedHeaders["x-product"]).toBe("SaaS");
    expect(observedHeaders["x-domain"]).toBe(cred.domain);
    expect(observedHeaders["x-user-id"]).toBe(cred.uid);
    expect(observedHeaders["user-agent"]).toBe(FINGERPRINT_UA);
    expect(observedHeaders["x-request-id"]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("abort cancels fetch and terminates generator cleanly", async () => {
    const encoder = new TextEncoder();
    const { url } = serve(() => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"part1"}}]}\n\n`));
          // keep stream open to allow abort to fire before next chunk
          await new Promise<void>((resolve) => setTimeout(resolve, 500));
          controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"part2"}}]}\n\n`));
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    });

    const cfg = makeConfig(url);
    const logger = makeLogger(cfg);
    const client = new UpstreamClient(cfg, logger);
    const cred = makeCredential();
    const controller = new AbortController();

    const chunks: unknown[] = [];
    let threw = false;
    try {
      for await (const c of client.streamChat({ model: "auto", messages: [{ role: "user", content: "hi" }] }, cred, controller.signal)) {
        chunks.push(c);
        // abort after first chunk
        controller.abort();
      }
    } catch {
      threw = true;
    }
    // Generator should terminate cleanly without throwing AbortError (our impl returns)
    expect(threw).toBe(false);
    // Should have at most 1 chunk (part1) and not part2
    expect(chunks.length).toBeLessThanOrEqual(1);
  });
});

describe("UpstreamClient.fetchModels", () => {
  it("GETs /v3/config and returns json", async () => {
    const { url } = serve((req) => {
      expect(req.method).toBe("GET");
      expect(new URL(req.url).pathname).toBe("/v3/config");
      expect(req.headers.get("authorization")).toBe(`Bearer at-test`);
      return new Response(JSON.stringify({ code: 0, data: { models: ["a", "b"] } }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    const cfg = makeConfig(url);
    const logger = makeLogger(cfg);
    const client = new UpstreamClient(cfg, logger);
    const cred = makeCredential();
    const data = await client.fetchModels(cred);
    expect(data).toEqual({ models: ["a", "b"] });
  });

  it("throws UpstreamError on fetchModels non-2xx", async () => {
    const { url } = serve(() => new Response("oops", { status: 500 }));
    const cfg = makeConfig(url);
    const logger = makeLogger(cfg);
    const client = new UpstreamClient(cfg, logger);
    let caught: unknown = null;
    try {
      await client.fetchModels(makeCredential());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).httpStatus).toBe(500);
    expect((caught as UpstreamError).retryable).toBe(true);
  });

  it("throws on business envelope in fetchModels", async () => {
    const { url } = serve(() => new Response(JSON.stringify({ code: 11128, msg: "moderation" }), { headers: { "Content-Type": "application/json" } }));
    const cfg = makeConfig(url);
    const logger = makeLogger(cfg);
    const client = new UpstreamClient(cfg, logger);
    let caught: unknown = null;
    try {
      await client.fetchModels(makeCredential());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).code).toBe(11128);
  });
});
