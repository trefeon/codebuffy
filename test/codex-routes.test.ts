import { describe, expect, it } from "bun:test";
import type { Hono } from "hono";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createLogger } from "../src/logger";
import type { Pool } from "../src/pool/types";
import type { Credential } from "../src/credentials/types";
import { UpstreamClient } from "../src/upstream/client";
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
  apiKey: { name: "test", fullKey: "ck_notarealkey0000" },
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
  ) {
    super(
      loadConfig({}, () => null) as never,
      createLogger(loadConfig({}, () => null) as never) as never,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override async *streamChat(_req: UpstreamChatRequest, _cred: Credential, _signal?: AbortSignal): AsyncIterable<UpstreamChunk> {
    for (const c of this.chunks) yield c;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override async fetchModels(_cred: Credential): Promise<unknown> {
    return ["auto", "test-model"];
  }
}

function buildApp(opts: { downstreamKeys?: string[]; pool?: Pool; upstream?: UpstreamClient } = {}) {
  const config = loadConfig(
    opts.downstreamKeys ? { CODEBUFFY_API_KEYS: opts.downstreamKeys.join(",") } : {},
    () => null,
  );
  const logger = createLogger({ ...config, logLevel: "silent" } as never);
  return createApp({
    config,
    logger,
    startedAt: Date.now(),
    pool: opts.pool ?? makeMockPool(),
    upstream: opts.upstream ?? new MockUpstream(),
  });
}

function postResponses(app: Hono, body: unknown, headers: Record<string, string> = {}) {
  return app.request(
    "/codex/responses",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
  );
}

function responseText(body: Record<string, unknown>): string {
  const output = "output" in body ? body.output : undefined;
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    if (typeof item !== "object" || item === null || !("type" in item) || item.type !== "message") continue;
    if (!("content" in item) || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (typeof block !== "object" || block === null || !("text" in block)) continue;
      if (typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join("");
}

describe("codex routes (Responses API under /codex prefix)", () => {
  it("POST /codex/responses returns a responses-shaped body", async () => {
    const app = buildApp();
    const res = await postResponses(app, { model: "auto", input: "hello" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.object).toBe("response");
    expect(typeof body.id).toBe("string");
    expect(String(body.id).startsWith("resp_")).toBe(true);
    expect(Array.isArray(body.output)).toBe(true);
    expect(responseText(body)).toBe("Hello world");
  });

  it("POST /codex/responses matches POST /v1/responses output shape", async () => {
    const app = buildApp();
    const payload = { model: "auto", input: "hello" };
    const viaCodex = (await (await postResponses(app, payload)).json()) as Record<string, unknown>;
    const viaV1 = (await (
      await app.request("/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    ).json()) as Record<string, unknown>;
    expect(viaCodex.object).toBe(viaV1.object);
    expect(viaCodex.model).toBe(viaV1.model);
    expect(responseText(viaCodex)).toBe(responseText(viaV1));
  });

  it("passes a Codex CLI user-agent through untouched", async () => {
    const app = buildApp();
    const res = await postResponses(app, { model: "auto", input: "hello" }, { "User-Agent": "codex-cli/0.30.0" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.object).toBe("response");
  });

  it("streams SSE when stream:true", async () => {
    const app = buildApp();
    const res = await postResponses(app, { model: "auto", input: "hello", stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("response.completed");
    expect(text).toContain("Hello");
  });

  it("returns 400 invalid_request_error for an unparsable body", async () => {
    const app = buildApp();
    const res = await postResponses(app, { model: "auto" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("GET /codex/models aliases the models fetch", async () => {
    const app = buildApp();
    const res = await app.request("/codex/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: Array<{ id: string }> };
    expect(body.object).toBe("list");
    expect(body.data.map((m) => m.id)).toEqual(["auto", "test-model"]);
  });

  it("enforces downstream auth on /codex/* when keys are configured", async () => {
    const app = buildApp({ downstreamKeys: ["dk_secret_123"] });
    const denied = await postResponses(app, { model: "auto", input: "hello" });
    expect(denied.status).toBe(401);
    const allowed = await postResponses(
      app,
      { model: "auto", input: "hello" },
      { Authorization: "Bearer dk_secret_123" },
    );
    expect(allowed.status).toBe(200);
    const modelsDenied = await app.request("/codex/models");
    expect(modelsDenied.status).toBe(401);
  });
});
