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
      {
        id: "chatcmpl-1",
        choices: [{ delta: { content: " world" }, finish_reason: "stop", index: 0 }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
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

function buildApp(opts: { downstreamKeys?: string[]; pool?: Pool; upstream?: UpstreamClient } = {}) {
  const config = loadConfig(
    opts.downstreamKeys ? { CODEBUFFY_API_KEYS: opts.downstreamKeys.join(",") } : {},
    () => null,
  );
  const logger = createLogger({ ...config, logLevel: "silent" } as never);
  const pool = opts.pool ?? makeMockPool();
  const upstream = opts.upstream ?? new MockUpstream();
  return createApp({ config, logger, startedAt: Date.now(), pool, upstream });
}

function baseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "auto",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

function parseSSE(text: string): Array<{ event: string; data: unknown }> {
  const frames = text.split("\n\n").filter((f) => f.trim().length > 0);
  const out: Array<{ event: string; data: unknown }> = [];
  for (const frame of frames) {
    const lines = frame.split("\n");
    let event = "message";
    let dataRaw = "";
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) dataRaw = line.slice("data:".length).trim();
    }
    let data: unknown = dataRaw;
    if (dataRaw && dataRaw !== "[DONE]") {
      try {
        data = JSON.parse(dataRaw);
      } catch {
        data = dataRaw;
      }
    }
    out.push({ event, data });
  }
  return out;
}

//

describe("downstream auth anthropic", () => {
  it("open mode allows without key", async () => {
    const app = buildApp({ downstreamKeys: [] });
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseBody()),
    });
    expect(res.status).not.toBe(401);
  });

  it("rejects missing key when configured", async () => {
    const app = buildApp({ downstreamKeys: ["sk-test-12345678"] });
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseBody()),
    });
    expect(res.status).toBe(401);
  });

  it("rejects invalid key", async () => {
    const app = buildApp({ downstreamKeys: ["sk-test-12345678"] });
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseBody()),
    });
    // also test with wrong Authorization header explicitly
    const res2 = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer wrong-key-12345678" },
      body: JSON.stringify(baseBody()),
    });
    expect(res.status).toBe(401);
    expect(res2.status).toBe(401);
  });

  it("accepts valid key", async () => {
    const app = buildApp({ downstreamKeys: ["sk-test-12345678"] });
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer sk-test-12345678" },
      body: JSON.stringify(baseBody()),
    });
    expect(res.status).toBe(200);
  });
});

describe("POST /v1/messages", () => {
  it("non-stream text response shape", async () => {
    const app = buildApp();
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseBody({ stream: false })),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      type: string;
      role: string;
      content: Array<{ type: string; text?: string }>;
      model: string;
      stop_reason: string;
      stop_sequence: null;
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(body.id.startsWith("msg_")).toBe(true);
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(Array.isArray(body.content)).toBe(true);
    expect(body.content[0]!.type).toBe("text");
    expect((body.content[0] as { text: string }).text).toBe("Hello world");
    expect(body.model).toBe("auto");
    expect(body.stop_reason).toBe("end_turn");
    expect(body.stop_sequence).toBeNull();
    expect(body.usage.input_tokens).toBe(5);
    expect(body.usage.output_tokens).toBe(2);
  });

  it("non-stream tool_use response", async () => {
    const toolChunks: UpstreamChunk[] = [
      {
        id: "1",
        choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":' } }] }, finish_reason: null, index: 0 }],
      },
      {
        id: "1",
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"NYC"}' } }] }, finish_reason: null, index: 0 }],
      },
      { id: "1", choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] },
    ];
    const app = buildApp({ upstream: new MockUpstream(toolChunks) });
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseBody({ stream: false })),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      content: Array<{ type: string; id?: string; name?: string; input?: unknown }>;
      stop_reason: string;
    };
    expect(body.stop_reason).toBe("tool_use");
    // At least one tool_use block; may also contain text block if content empty -> only tool_use
    const toolBlock = body.content.find((c) => c.type === "tool_use");
    expect(toolBlock).toBeDefined();
    expect(toolBlock!.id).toBe("call_1");
    expect(toolBlock!.name).toBe("get_weather");
    expect(toolBlock!.input).toEqual({ city: "NYC" });
  });

  it("non-stream tool_use with preceding text", async () => {
    const toolChunks: UpstreamChunk[] = [
      { id: "1", choices: [{ delta: { content: "let me check " }, finish_reason: null, index: 0 }] },
      {
        id: "1",
        choices: [{ delta: { tool_calls: [{ index: 0, id: "call_2", type: "function", function: { name: "lookup", arguments: '{"q":"hi"}' } }] }, finish_reason: null, index: 0 }],
      },
      { id: "1", choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] },
    ];
    const app = buildApp({ upstream: new MockUpstream(toolChunks) });
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseBody({ stream: false })),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ type: string }>; stop_reason: string };
    expect(body.content.length).toBe(2);
    expect(body.content[0]!.type).toBe("text");
    expect(body.content[1]!.type).toBe("tool_use");
  });

  it("stream SSE single text event sequence", async () => {
    const app = buildApp();
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseBody({ stream: true })),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const frames = parseSSE(text);
    const events = frames.map((f) => f.event);
    expect(events).toContain("message_start");
    expect(events).toContain("content_block_start");
    expect(events).toContain("content_block_delta");
    expect(events).toContain("content_block_stop");
    expect(events).toContain("message_delta");
    expect(events).toContain("message_stop");
    // verify content_block_delta carries text
    const textDeltas = frames.filter((f) => f.event === "content_block_delta").map((f) => (f.data as { delta: { text?: string } }).delta.text);
    expect(textDeltas.join("")).toContain("Hello");
    // verify message_start shape
    const start = frames.find((f) => f.event === "message_start")!.data as { message: { id: string; model: string; role: string } };
    expect(start.message.id.startsWith("msg_")).toBe(true);
    expect(start.message.model).toBe("auto");
    expect(start.message.role).toBe("assistant");
    // verify message_delta stop_reason
    const delta = frames.find((f) => f.event === "message_delta")!.data as { delta: { stop_reason: string }; usage: { output_tokens: number } };
    expect(delta.delta.stop_reason).toBe("end_turn");
    expect(typeof delta.usage.output_tokens).toBe("number");
  });

  it("stream SSE tool_use", async () => {
    const toolChunks: UpstreamChunk[] = [
      {
        id: "1",
        choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":' } }] }, finish_reason: null, index: 0 }],
      },
      {
        id: "1",
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"NYC"}' } }] }, finish_reason: null, index: 0 }],
      },
      { id: "1", choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }], usage: { prompt_tokens: 10, completion_tokens: 8 } },
    ];
    const app = buildApp({ upstream: new MockUpstream(toolChunks) });
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseBody({ stream: true })),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const frames = parseSSE(text);
    const events = frames.map((f) => f.event);
    expect(events).toContain("message_start");
    expect(events).toContain("message_delta");
    expect(events).toContain("message_stop");
    // should contain tool_use start at index 1
    const starts = frames.filter((f) => f.event === "content_block_start");
    expect(starts.length).toBeGreaterThanOrEqual(1);
    const toolStart = starts.find((f) => (f.data as { content_block: { type: string } }).content_block.type === "tool_use");
    expect(toolStart).toBeDefined();
    expect((toolStart!.data as { index: number }).index).toBe(1);
    expect((toolStart!.data as { content_block: { id: string; name: string } }).content_block.id).toBe("call_1");
    // deltas for tool args
    const deltas = frames.filter((f) => f.event === "content_block_delta" && (f.data as { delta: { type: string } }).delta.type === "input_json_delta");
    expect(deltas.length).toBeGreaterThan(0);
    const joined = deltas.map((f) => (f.data as { delta: { partial_json: string } }).delta.partial_json).join("");
    expect(joined).toBe('{"city":"NYC"}');
    // message_delta stop_reason tool_use
    const msgDelta = frames.find((f) => f.event === "message_delta")!.data as { delta: { stop_reason: string } };
    expect(msgDelta.delta.stop_reason).toBe("tool_use");
  });

  it("handles array content user with tool_result", async () => {
    const app = buildApp();
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        max_tokens: 100,
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }, { type: "tool_result", tool_use_id: "toolu_abc", content: "result text" }] },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { type: string; content: unknown };
    expect(body.type).toBe("message");
  });

  it("handles array content user with tool_result stringified array", async () => {
    const app = buildApp();
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        max_tokens: 100,
        messages: [
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "array result" }] }] },
        ],
      }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 400 on invalid JSON body", async () => {
    const app = buildApp();
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{invalid json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("returns 400 on ParseError missing model", async () => {
    const app = buildApp();
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("returns 400 on ParseError missing max_tokens", async () => {
    const app = buildApp();
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 on ParseError unknown block type", async () => {
    const app = buildApp();
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        max_tokens: 100,
        messages: [{ role: "user", content: [{ type: "unknown_block", text: "hi" }] }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 503 when no credentials", async () => {
    const app = buildApp({ pool: makeMockPool(null) });
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseBody()),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("api_error");
  });

  it("maps upstream business error 11101 to 400", async () => {
    const err = new UpstreamError(11101, "missing system", 200, false);
    const app = buildApp({ upstream: new ErrorUpstream(err) });
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseBody()),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
  });

  it("maps upstream business error 11140 to 403", async () => {
    const err = new UpstreamError(11140, "banned", 200, false);
    const app = buildApp({ upstream: new ErrorUpstream(err) });
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseBody()),
    });
    expect(res.status).toBe(403);
  });

  it("maps upstream business error 14018 to 429", async () => {
    const err = new UpstreamError(14018, "quota", 200, false);
    const app = buildApp({ upstream: new ErrorUpstream(err) });
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseBody()),
    });
    expect(res.status).toBe(429);
  });

  it("maps upstream 429 to 429", async () => {
    const err = new UpstreamError(429, "rate limit", 429, true);
    const app = buildApp({ upstream: new ErrorUpstream(err) });
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseBody()),
    });
    expect(res.status).toBe(429);
  });

  it("maps upstream 500 to 500", async () => {
    const err = new UpstreamError(500, "server error", 500, true);
    const app = buildApp({ upstream: new ErrorUpstream(err) });
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseBody()),
    });
    expect(res.status).toBe(500);
  });

  it("stream emits error event on mid-stream failure", async () => {
    const err = new UpstreamError(500, "mid failure", 500, true);
    const app = buildApp({ upstream: new MidStreamErrorUpstream(err) });
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseBody({ stream: true })),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const frames = parseSSE(text);
    const errFrame = frames.find((f) => f.event === "error");
    expect(errFrame).toBeDefined();
    expect((errFrame!.data as { type: string }).type).toBe("error");
  });
});

describe("app wiring", () => {
  it("both openai and anthropic routes mounted when pool+upstream present", async () => {
    const app = buildApp();
    const r1 = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r1.status).toBe(200);

    const r2 = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseBody()),
    });
    expect(r2.status).toBe(200);
  });

  it("health probes work without pool", async () => {
    const config = loadConfig({}, () => null);
    const logger = createLogger({ ...config, logLevel: "silent" } as never);
    const app = createApp({ config, logger, startedAt: Date.now() });
    const h = await app.request("/healthz");
    expect(h.status).toBe(200);
    const m = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseBody()),
    });
    // without pool/upstream, routes not mounted -> 404
    expect(m.status).toBe(404);
  });
});

describe("POST /v1/messages/count_tokens", () => {
  it("returns input_tokens estimate", async () => {
    const app = buildApp();
    const res = await app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseBody()),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { input_tokens: number };
    expect(typeof body.input_tokens).toBe("number");
    expect(body.input_tokens).toBeGreaterThan(0);
  });

  it("returns 400 on invalid JSON", async () => {
    const app = buildApp();
    const res = await app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad",
    });
    expect(res.status).toBe(400);
  });
});
