import { describe, it, expect } from "bun:test";
import { parseOpenAIChatRequest } from "../src/adapters/openai-chat/parser";
import { formatSSEChunk, DONE_SSE, formatSSEError } from "../src/adapters/openai-chat/emitter";
import { aggregateStream } from "../src/adapters/openai-chat/aggregator";
import { UpstreamError } from "../src/upstream/errors";
import type { UpstreamChunk } from "../src/upstream/types";

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

describe("parseOpenAIChatRequest", () => {
  it("accepts a valid OpenAI body", () => {
    const body = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "hi" },
      ],
      temperature: 0.7,
      stream: false,
    };
    const ir = parseOpenAIChatRequest(body);
    expect(ir.model).toBe("gpt-4o");
    expect(ir.messages.length).toBe(2);
    expect(ir.messages[0]?.role).toBe("system");
    expect(ir.messages[0]?.content).toBe("you are helpful");
    expect(ir.messages[1]?.role).toBe("user");
    expect(ir.temperature).toBe(0.7);
    expect(ir.stream).toBe(false);
  });

  it("accepts assistant message with tool_calls", () => {
    const body = {
      model: "auto",
      messages: [
        { role: "user", content: "call a tool" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_123",
              type: "function" as const,
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            },
          ],
        },
      ],
    };
    const ir = parseOpenAIChatRequest(body);
    expect(ir.messages[1]?.tool_calls?.length).toBe(1);
    expect(ir.messages[1]?.tool_calls?.[0]?.function.name).toBe("get_weather");
  });

  it("normalizes function role to tool", () => {
    const body = {
      model: "auto",
      messages: [
        { role: "user", content: "hi" },
        { role: "function", content: "result", name: "my_func" },
      ],
    };
    const ir = parseOpenAIChatRequest(body);
    expect(ir.messages[1]?.role).toBe("tool");
    expect(ir.messages[1]?.content).toBe("result");
  });

  it("rejects missing model with 400", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
    };
    try {
      parseOpenAIChatRequest(body);
      expect(true).toBe(false); // should not reach
    } catch (e) {
      const err = e as Error & { status?: number; code?: string };
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/model/i);
    }
  });

  it("rejects missing messages with 400", () => {
    const body = { model: "auto" };
    try {
      parseOpenAIChatRequest(body);
      expect(true).toBe(false);
    } catch (e) {
      const err = e as Error & { status?: number };
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/messages/i);
    }
  });

  it("rejects invalid role with 400", () => {
    const body = {
      model: "auto",
      messages: [{ role: "invalid", content: "hi" }],
    };
    try {
      parseOpenAIChatRequest(body as unknown);
      expect(true).toBe(false);
    } catch (e) {
      const err = e as Error & { status?: number };
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/role/i);
    }
  });

  it("rejects non-object body with 400", () => {
    try {
      parseOpenAIChatRequest(null);
      expect(true).toBe(false);
    } catch (e) {
      const err = e as Error & { status?: number };
      expect(err.status).toBe(400);
    }
  });

  it("rejects empty messages array with 400", () => {
    const body = { model: "auto", messages: [] };
    try {
      parseOpenAIChatRequest(body);
      expect(true).toBe(false);
    } catch (e) {
      const err = e as Error & { status?: number };
      expect(err.status).toBe(400);
    }
  });

  it("rejects message without string content with 400", () => {
    const body = {
      model: "auto",
      messages: [{ role: "user", content: 123 }],
    };
    try {
      parseOpenAIChatRequest(body as unknown);
      expect(true).toBe(false);
    } catch (e) {
      const err = e as Error & { status?: number };
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/content/i);
    }
  });

  it("delegates to IR validation for temperature out of range (400)", () => {
    const body = {
      model: "auto",
      messages: [{ role: "user", content: "hi" }],
      temperature: 5,
    };
    try {
      parseOpenAIChatRequest(body);
      expect(true).toBe(false);
    } catch (e) {
      const err = e as Error & { status?: number };
      expect(err.status).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// emitter
// ---------------------------------------------------------------------------

describe("emitter", () => {
  it("DONE_SSE constant is correct", () => {
    expect(DONE_SSE).toBe("data: [DONE]\n\n");
  });

  it("formats chunk exactly as data: JSON + double newline", () => {
    const chunk: UpstreamChunk = {
      id: "chatcmpl-123",
      choices: [{ delta: { content: "Hello" }, finish_reason: null, index: 0 }],
    };
    const out = formatSSEChunk(chunk);
    expect(out).toBe(`data: ${JSON.stringify(chunk)}\n\n`);
  });

  it("handles chunk with undefined id gracefully", () => {
    const chunk: UpstreamChunk = {
      choices: [{ delta: { content: "hi" }, finish_reason: null }],
    };
    const out = formatSSEChunk(chunk);
    // JSON.stringify omits undefined id, should still be valid SSE
    expect(out).toBe(`data: ${JSON.stringify(chunk)}\n\n`);
    expect(out.startsWith("data: ")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(true);
    // parsed payload should not have id
    const payload = JSON.parse(out.slice(6).trim());
    expect(payload.id).toBeUndefined();
    expect(payload.choices[0].delta.content).toBe("hi");
  });

  it("formats realistic upstream fixtures", () => {
    // fixtures taken from test/upstream.test.ts streamChat parsing
    const c1: UpstreamChunk = {
      id: "1",
      choices: [{ delta: { content: "Hello" }, finish_reason: null }],
    };
    const c2: UpstreamChunk = {
      id: "1",
      choices: [{ delta: { content: " world" }, finish_reason: "stop" }],
    };
    expect(formatSSEChunk(c1)).toBe(`data: ${JSON.stringify(c1)}\n\n`);
    expect(formatSSEChunk(c2)).toBe(`data: ${JSON.stringify(c2)}\n\n`);
  });

  it("formatSSEError emits data line with error message and code", () => {
    const err = new UpstreamError(429, "rate limited", 429, true);
    const out = formatSSEError(err);
    expect(out.startsWith("data: ")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(true);
    const payload = JSON.parse(out.slice(6).trim());
    expect(payload.error.message).toBe("rate limited");
    expect(String(payload.error.code)).toBe("429");
  });
});

// ---------------------------------------------------------------------------
// aggregator
// ---------------------------------------------------------------------------

describe("aggregateStream", () => {
  it("concatenates two chunks correctly", async () => {
    const created = 1700000000;
    async function* gen(): AsyncIterable<UpstreamChunk> {
      yield { id: "1", choices: [{ delta: { content: "Hello" }, finish_reason: null, index: 0 }] };
      yield { id: "1", choices: [{ delta: { content: " world" }, finish_reason: null, index: 0 }] };
    }
    const result = await aggregateStream(gen(), { id: "chatcmpl-abc", model: "auto", created });
    expect(result.id).toBe("chatcmpl-abc");
    expect(result.object).toBe("chat.completion");
    expect(result.created).toBe(created);
    expect(result.model).toBe("auto");
    const choices = result.choices as Array<{ index: number; message: { role: string; content: string }; finish_reason: string | null }>;
    expect(choices.length).toBe(1);
    expect(choices[0]?.index).toBe(0);
    expect(choices[0]?.message.role).toBe("assistant");
    expect(choices[0]?.message.content).toBe("Hello world");
  });

  it("captures finish_reason from last chunk", async () => {
    async function* gen(): AsyncIterable<UpstreamChunk> {
      yield { id: "1", choices: [{ delta: { content: "Hello" }, finish_reason: null }] };
      yield { id: "1", choices: [{ delta: { content: " world" }, finish_reason: "stop" }] };
    }
    const result = await aggregateStream(gen(), { id: "chatcmpl-123", model: "auto", created: 1 });
    const choices = result.choices as Array<{ finish_reason: string | null }>;
    expect(choices[0]?.finish_reason).toBe("stop");
  });

  it("includes usage from final chunk when present", async () => {
    const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };
    async function* gen(): AsyncIterable<UpstreamChunk> {
      yield { id: "1", choices: [{ delta: { content: "Hi" }, finish_reason: null }] };
      yield { id: "1", choices: [{ delta: { content: "!" }, finish_reason: "stop" }], usage } as UpstreamChunk;
    }
    const result = await aggregateStream(gen(), { id: "id1", model: "auto", created: 2 });
    expect(result.usage).toEqual(usage);
  });

  it("handles empty stream -> content \"\"", async () => {
    async function* empty(): AsyncIterable<UpstreamChunk> {
      // no yields
    }
    const result = await aggregateStream(empty(), { id: "chatcmpl-empty", model: "auto", created: 999 });
    expect(result.id).toBe("chatcmpl-empty");
    expect(result.object).toBe("chat.completion");
    const choices = result.choices as Array<{ message: { content: string }; finish_reason: string | null }>;
    expect(choices[0]?.message.content).toBe("");
    expect(choices[0]?.finish_reason).toBeNull();
    expect(result.usage).toBeUndefined();
  });

  it("uses fixtures mirroring upstream SSE parsing", async () => {
    // Same shapes as upstream.test.ts "parses SSE frames and tolerates split chunks"
    const chunk1: UpstreamChunk = { id: "1", choices: [{ delta: { content: "Hello" }, finish_reason: null }] };
    const chunk2: UpstreamChunk = { id: "1", choices: [{ delta: { content: " world" }, finish_reason: "stop" }] };
    async function* gen(): AsyncIterable<UpstreamChunk> {
      yield chunk1;
      yield chunk2;
    }
    const result = await aggregateStream(gen(), { id: "chatcmpl-1", model: "gpt-auto", created: 1234567890 });
    expect(result).toEqual({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1234567890,
      model: "gpt-auto",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello world" },
          finish_reason: "stop",
        },
      ],
    });
  });

  it("overwrites finish_reason with later non-null value", async () => {
    async function* gen(): AsyncIterable<UpstreamChunk> {
      yield { choices: [{ delta: { content: "a" }, finish_reason: "length" }] };
      yield { choices: [{ delta: { content: "b" }, finish_reason: "stop" }] };
    }
    const result = await aggregateStream(gen(), { id: "x", model: "auto", created: 0 });
    const choices = result.choices as Array<{ finish_reason: string | null }>;
    expect(choices[0]?.finish_reason).toBe("stop");
  });
});
