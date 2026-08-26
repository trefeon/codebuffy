import { describe, it, expect, afterEach } from "bun:test";
import { serve } from "bun";
import { stripEmptyToolCallDeltas } from "../src/upstream/chunk-sanitize";
import { UpstreamClient } from "../src/upstream/client";
import type { UpstreamChunk } from "../src/upstream/types";
import type { Credential } from "../src/credentials/types";
import { loadConfig } from "../src/config";
import { createLogger } from "../src/logger";

function makeCredential(): Credential {
  return {
    uid: "user-123",
    domain: "www.codebuddy.cn",
    apiBase: "" as unknown as string,
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
}

function makeClient(url: string) {
  const cfg = { ...loadConfig({}, () => null), apiBase: url, upstreamTimeoutMs: 5000, logLevel: "silent" as const };
  return new UpstreamClient(cfg, createLogger({ ...cfg, logLevel: "silent" }));
}

describe("stripEmptyToolCallDeltas", () => {
  it("strips empty tool_calls arrays in place", () => {
    const chunk = {
      id: "1",
      choices: [{ delta: { content: "hi", tool_calls: [] }, finish_reason: null }],
    } as unknown as UpstreamChunk;
    stripEmptyToolCallDeltas(chunk);
    expect(chunk.choices[0]?.delta).toEqual({ content: "hi" });
  });

  it("preserves non-empty tool_calls arrays", () => {
    const toolCall = { index: 0, id: "call_1", type: "function", function: { name: "f", arguments: "{}" } };
    const chunk = {
      choices: [{ delta: { tool_calls: [toolCall] }, finish_reason: null }],
    } as unknown as UpstreamChunk;
    stripEmptyToolCallDeltas(chunk);
    expect((chunk.choices[0]?.delta.tool_calls as unknown[]).length).toBe(1);
  });

  it("is safe on chunks without choices or delta", () => {
    expect(() => stripEmptyToolCallDeltas({} as UpstreamChunk)).not.toThrow();
    expect(() => stripEmptyToolCallDeltas({ choices: [] } as UpstreamChunk)).not.toThrow();
    expect(() =>
      stripEmptyToolCallDeltas({ choices: [{ delta: {} }] } as unknown as UpstreamChunk),
    ).not.toThrow();
    expect(() => stripEmptyToolCallDeltas(null as unknown as UpstreamChunk)).not.toThrow();
  });

  it("leaves finish_reason and tool-id chunks untouched", () => {
    const finish = {
      choices: [{ delta: {}, finish_reason: "stop" }],
    } as unknown as UpstreamChunk;
    stripEmptyToolCallDeltas(finish);
    expect(finish.choices[0]?.finish_reason).toBe("stop");

    const usage = { choices: [], usage: { total_tokens: 5 } } as unknown as UpstreamChunk;
    stripEmptyToolCallDeltas(usage);
    expect(usage.usage).toEqual({ total_tokens: 5 });
  });
});

describe("streamChat sanitization integration", () => {
  let servers: Array<{ stop: () => void }> = [];

  afterEach(() => {
    for (const s of servers) {
      try {
        s.stop();
      } catch {}
    }
    servers = [];
  });

  it("yields deltas with empty tool_calls stripped across the stream", async () => {
    const encoder = new TextEncoder();
    const server = serve({
      port: 0,
      fetch: () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: {"id":"1","choices":[{"delta":{"role":"assistant","tool_calls":[]},"finish_reason":null}]}\n\n`,
              ),
            );
            // envelope-wrapped chunk (proxy variant)
            controller.enqueue(
              encoder.encode(
                `data: {"code":0,"data":{"id":"1","choices":[{"delta":{"content":"Hello","tool_calls":[]},"finish_reason":null}]}}\n\n`,
              ),
            );
            controller.enqueue(
              encoder.encode(
                `data: {"id":"1","choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n`,
              ),
            );
            controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    servers.push(server);

    const client = makeClient(`http://localhost:${server.port}`);
    const cred = makeCredential();

    const chunks: UpstreamChunk[] = [];
    for await (const c of client.streamChat({ model: "auto", messages: [{ role: "user", content: "hi" }] }, cred)) {
      chunks.push(c);
    }

    expect(chunks.length).toBe(3);
    expect(chunks[0]?.choices[0]?.delta).toEqual({ role: "assistant" });
    expect(chunks[1]?.choices[0]?.delta).toEqual({ content: "Hello" });
    expect(chunks[2]?.choices[0]?.delta).toEqual({ content: " world" });
    expect(chunks[2]?.choices[0]?.finish_reason).toBe("stop");
    for (const c of chunks) {
      for (const choice of c.choices ?? []) {
        expect(Array.isArray(choice.delta.tool_calls)).toBe(false);
      }
    }
  });
});
