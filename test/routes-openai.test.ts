import { describe, expect, it } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createLogger } from "../src/logger";
import type { Pool } from "../src/pool/types";
import type { Credential } from "../src/credentials/types";
import { UpstreamClient } from "../src/upstream/client";
import { UpstreamError } from "../src/upstream/errors";
import type { UpstreamChatRequest, UpstreamChunk } from "../src/upstream/types";

const fakeCred: Credential = {
  uid: "test-uid-123",
  label: "test",
  domain: "www.codebuddy.cn",
  apiBase: "https://copilot.tencent.com",
  consoleBase: "https://www.codebuddy.cn",
  auth: {
    accessToken: "eyJ.test",
    refreshToken: "rt.test",
    tokenType: "Bearer",
    expiresAt: Date.now() + 60_000 * 60,
    refreshExpiresAt: Date.now() + 60_000 * 120,
    capturedAt: Date.now(),
    source: "test",
  },
  apiKey: { name: "test", fullKey: "ck_test_12345678" },
};

function makeMockPool(cred: Credential | null = fakeCred): Pool {
  return {
    pick: async () => cred,
    size: () => (cred ? 1 : 0),
  };
}

class MockUpstream extends UpstreamClient {
  constructor(
    private chunks: UpstreamChunk[] = [
      { id: "chatcmpl-1", choices: [{ delta: { content: "Hello" }, finish_reason: null, index: 0 }] },
      { id: "chatcmpl-1", choices: [{ delta: { content: " world" }, finish_reason: "stop", index: 0 }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    ],
    private modelsRaw: unknown = ["auto", "test-model"],
  ) {
    super(loadConfig({}, () => null) as never, createLogger(loadConfig({}, () => null) as never) as never);
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override async *streamChat(_req: UpstreamChatRequest, _cred: Credential): AsyncIterable<UpstreamChunk> {
    for (const c of this.chunks) yield c;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override async fetchModels(_cred: Credential): Promise<unknown> {
    return this.modelsRaw;
  }
}
class ErrorUpstream extends MockUpstream {
  constructor(private err: UpstreamError) {
    super();
  }
  override async *streamChat(): AsyncIterable<UpstreamChunk> {
    throw this.err;
  }
}
class MidStreamErrorUpstream extends UpstreamClient {
  constructor(private err: UpstreamError) {
    super(loadConfig({}, () => null) as never, createLogger(loadConfig({}, () => null) as never) as never);
  }
  override async *streamChat(): AsyncIterable<UpstreamChunk> {
    yield { id: "1", choices: [{ delta: { content: "Hello" }, finish_reason: null, index: 0 }] };
    throw this.err;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override async fetchModels(_cred: Credential): Promise<unknown> {
    return [];
  }
}

/** Fails the first streamChat attempt with `err`, then serves `chunks`. */
class AuthRetryUpstream extends UpstreamClient {
  calls = 0;
  readonly credsSeen: Credential[] = [];
  constructor(
    private err: UpstreamError,
    private chunks: UpstreamChunk[] = [
      { id: "chatcmpl-1", choices: [{ delta: { content: "Hello" }, finish_reason: null, index: 0 }] },
      { id: "chatcmpl-1", choices: [{ delta: { content: " world" }, finish_reason: "stop", index: 0 }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    ],
  ) {
    super(loadConfig({}, () => null) as never, createLogger(loadConfig({}, () => null) as never) as never);
  }
  override async *streamChat(_req: UpstreamChatRequest, cred: Credential): AsyncIterable<UpstreamChunk> {
    this.calls++;
    this.credsSeen.push(cred);
    if (this.calls === 1) throw this.err;
    for (const c of this.chunks) yield c;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override async fetchModels(_cred: Credential): Promise<unknown> {
    return [];
  }
}

interface SpyPool extends Pool {
  successes: string[];
  failures: Array<[string, number | string]>;
}

function makeSpyPool(cred: Credential | null = fakeCred): SpyPool {
  const successes: string[] = [];
  const failures: Array<[string, number | string]> = [];
  return {
    pick: async () => cred,
    size: () => (cred ? 1 : 0),
    reportSuccess: (uid: string) => {
      successes.push(uid);
    },
    reportFailure: (uid: string, code: number | string) => {
      failures.push([uid, code]);
    },
    successes,
    failures,
  };
}

function buildApp(opts: { downstreamKeys?: string[]; pool?: Pool; upstream?: UpstreamClient; refresh?: { refreshNow(uid: string): Promise<Credential> } } = {}) {
  const config = loadConfig(
    opts.downstreamKeys ? { CODEBUFFY_API_KEYS: opts.downstreamKeys.join(",") } : {},
    () => null,
  );
  const logger = createLogger({ ...config, logLevel: "silent" } as never);
  const pool = opts.pool ?? makeMockPool();
  const upstream = opts.upstream ?? new MockUpstream();
  return createApp({ config, logger, startedAt: Date.now(), pool, upstream, refresh: opts.refresh });
}

describe("downstream auth", () => {
  it("open mode allows without key", async () => {
    const app = buildApp({ downstreamKeys: [] });
    const res = await app.request("/v1/models", { headers: {} });
    expect(res.status).not.toBe(401);
  });

  it("rejects missing key when configured", async () => {
    const app = buildApp({ downstreamKeys: ["sk-test-12345678"] });
    const res = await app.request("/v1/models");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_api_key");
  });

  it("rejects invalid key", async () => {
    const app = buildApp({ downstreamKeys: ["sk-test-12345678"] });
    const res = await app.request("/v1/models", { headers: { Authorization: "Bearer wrong-key-12345678" } });
    expect(res.status).toBe(401);
  });

  it("accepts valid key", async () => {
    const app = buildApp({ downstreamKeys: ["sk-test-12345678"] });
    const res = await app.request("/v1/models", { headers: { Authorization: "Bearer sk-test-12345678" } });
    expect(res.status).toBe(200);
  });
});

describe("POST /v1/chat/completions", () => {
  it("non-stream aggregates to JSON", async () => {
    const app = buildApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }], stream: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; choices: Array<{ message: { content: string; role: string } }>; usage: unknown };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]!.message.content).toBe("Hello world");
    expect(body.choices[0]!.message.role).toBe("assistant");
  });

  it("stream returns SSE with DONE", async () => {
    const app = buildApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data: {");
    expect(text).toContain("Hello");
    expect(text).toContain("data: [DONE]");
  });

  it("handles array content (vision) without 400", async () => {
    const app = buildApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "https://example.com/img.jpg" } }] }],
      }),
    });
    expect(res.status).toBe(200);
  });

  it("non-stream tool_calls aggregated", async () => {
    const toolChunks: UpstreamChunk[] = [
      { id: "1", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":' } }] }, finish_reason: null, index: 0 }] },
      { id: "1", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"NYC"}' } }] }, finish_reason: null, index: 0 }] },
      { id: "1", choices: [{ delta: {}, finish_reason: null, index: 0 }] },
    ];
    const app = buildApp({ upstream: new MockUpstream(toolChunks) });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "weather" }], stream: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { tool_calls: Array<{ function: { name: string; arguments: string } }> }; finish_reason: string }> };
    expect(body.choices[0]!.message.tool_calls[0]!.function.name).toBe("get_weather");
    expect(body.choices[0]!.message.tool_calls[0]!.function.arguments).toBe('{"city":"NYC"}');
    expect(body.choices[0]!.finish_reason).toBe("tool_calls");
  });

  it("returns 400 on invalid body", async () => {
    const app = buildApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 503 when no credentials", async () => {
    const app = buildApp({ pool: makeMockPool(null) });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(503);
  });

  it("maps upstream business error to 400", async () => {
    const err = new UpstreamError(11101, "missing system", 200, false);
    const app = buildApp({ upstream: new ErrorUpstream(err) });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/models", () => {
  it("returns OpenAI list shape", async () => {
    const app = buildApp();
    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: unknown[] };
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);
  });

  it("GET /v1/models/:id returns single model", async () => {
    const app = buildApp();
    const res = await app.request("/v1/models/auto");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("auto");
  });

  it("GET /v1/models/:id 404 for unknown", async () => {
    const app = buildApp();
    const res = await app.request("/v1/models/does-not-exist-xyz");
    expect(res.status).toBe(404);
  });
});

describe("pool outcome reporting + live auth refresh", () => {
  const chatBody = (overrides: Record<string, unknown> = {}) => ({
    model: "auto",
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  });

  function freshCredential(): Credential {
    return { ...fakeCred, auth: { ...fakeCred.auth, accessToken: "fresh.token" } };
  }

  it("success path reports recordSuccess to the pool", async () => {
    const pool = makeSpyPool();
    const app = buildApp({ pool });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatBody()),
    });
    expect(res.status).toBe(200);
    expect(pool.successes).toEqual([fakeCred.uid]);
    expect(pool.failures).toEqual([]);
  });

  it("upstream error reports reportFailure with the code before mapping", async () => {
    const err = new UpstreamError(500, "server error", 500, true);
    const pool = makeSpyPool();
    const app = buildApp({ pool, upstream: new ErrorUpstream(err) });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatBody()),
    });
    expect(res.status).toBe(500);
    expect(pool.failures).toEqual([[fakeCred.uid, 500]]);
    expect(pool.successes).toEqual([]);
  });

  it("401 on first consumption triggers exactly one refreshNow and succeeds (non-stream)", async () => {
    const upstream = new AuthRetryUpstream(new UpstreamError(401, "token revoked", 401, true));
    const fresh = freshCredential();
    let refreshCalls = 0;
    const refresh = {
      refreshNow: async (uid: string) => {
        refreshCalls++;
        expect(uid).toBe(fakeCred.uid);
        return fresh;
      },
    };
    const pool = makeSpyPool();
    const app = buildApp({ pool, upstream, refresh });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatBody({ stream: false })),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]!.message.content).toBe("Hello world");
    expect(refreshCalls).toBe(1);
    expect(upstream.calls).toBe(2);
    expect(upstream.credsSeen[1]).toBe(fresh);
    // Healed outcome lands as success, not failure.
    expect(pool.successes).toEqual([fakeCred.uid]);
  });

  it("401 before first streamed chunk retries once and streams normally", async () => {
    const upstream = new AuthRetryUpstream(new UpstreamError(403, "forbidden", 403, true));
    let refreshCalls = 0;
    const refresh = {
      refreshNow: async () => {
        refreshCalls++;
        return freshCredential();
      },
    };
    const app = buildApp({ upstream, refresh });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatBody({ stream: true })),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Hello");
    expect(text).toContain("data: [DONE]");
    expect(text).not.toContain("event: error");
    expect(refreshCalls).toBe(1);
    expect(upstream.calls).toBe(2);
  });

  it("401 after first chunk does NOT retry; emits SSE error event as today", async () => {
    const err = new UpstreamError(401, "token expired mid-stream", 401, true);
    let refreshCalls = 0;
    const refresh = {
      refreshNow: async () => {
        refreshCalls++;
        return freshCredential();
      },
    };
    const pool = makeSpyPool();
    const app = buildApp({ pool, upstream: new MidStreamErrorUpstream(err), refresh });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatBody({ stream: true })),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Hello");
    expect(text).toContain("event: error");
    expect(text).toContain("\"code\":\"401\"");
    expect(refreshCalls).toBe(0); // no restart post-first-byte
    expect(pool.failures).toEqual([[fakeCred.uid, 401]]);
  });

  it("refresh throwing surfaces the original upstream error (non-stream)", async () => {
    const err = new UpstreamError(401, "token revoked", 401, true);
    const refresh = {
      refreshNow: async () => {
        throw new Error("refresh endpoint down");
      },
    };
    const app = buildApp({ upstream: new AuthRetryUpstream(err), refresh });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatBody()),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("401");
  });

  it("without a refresh dep, live 401 maps straight to HTTP (no retry)", async () => {
    const upstream = new AuthRetryUpstream(new UpstreamError(401, "token revoked", 401, true));
    const app = buildApp({ upstream });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatBody()),
    });
    expect(res.status).toBe(401);
    expect(upstream.calls).toBe(1);
  });
});
