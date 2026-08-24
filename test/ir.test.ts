/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "bun:test";
import { parseIRRequest, toUpstreamRequest, ParseError } from "../src/ir/types";
import { PASSTHROUGH_KEYS } from "../src/upstream/types";

describe("parseIRRequest", () => {
  it("parses valid minimal request", () => {
    const raw = {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
    };
    const ir = parseIRRequest(raw);
    expect(ir.model).toBe("gpt-4o-mini");
    expect(ir.messages).toHaveLength(1);
    expect(ir.messages[0]?.role).toBe("user");
    expect(ir.messages[0]?.content).toBe("hello");
    expect(ir.stream).toBeUndefined();
  });

  it("preserves content as-is (no concatenation side effect)", () => {
    const raw = {
      model: "m",
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "part A" },
        { role: "assistant", content: "reply" },
      ],
    };
    const ir = parseIRRequest(raw);
    expect(ir.messages[0]?.content).toBe("you are helpful");
    expect(ir.messages[1]?.content).toBe("part A");
    expect(ir.messages[2]?.content).toBe("reply");
    expect(ir.messages.map((m) => m.content).join("|")).toBe("you are helpful|part A|reply");
  });

  it("normalizes array content by joining text blocks (OpenAI vision format)", () => {
    const raw = {
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello " },
            { type: "text", text: "world" },
            { type: "image_url", image_url: { url: "https://example.com/img.png" } },
          ],
        },
      ],
    };
    const ir = parseIRRequest(raw as unknown);
    expect(ir.messages[0]?.content).toBe("hello world");
  });

  it("normalizes null content to empty string (tool_calls case)", () => {
    const raw = {
      model: "m",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "1", type: "function", function: { name: "foo", arguments: "{}" } }],
        },
      ],
    };
    const ir = parseIRRequest(raw as unknown);
    expect(ir.messages[0]?.content).toBe("");
    expect(ir.messages[0]?.tool_calls?.[0]?.id).toBe("1");
  });

  it("parses tool_calls passthrough", () => {
    const raw = {
      model: "m",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            },
          ],
        },
        { role: "tool", content: '{"temp":20}', tool_call_id: "call_123", name: "get_weather" },
      ],
    };
    const ir = parseIRRequest(raw as unknown);
    expect(ir.messages).toHaveLength(2);
    expect(ir.messages[0]?.tool_calls).toBeDefined();
    expect(ir.messages[0]?.tool_calls?.[0]?.id).toBe("call_123");
    expect(ir.messages[0]?.tool_calls?.[0]?.function.name).toBe("get_weather");
    expect(ir.messages[1]?.tool_call_id).toBe("call_123");
    expect(ir.messages[1]?.name).toBe("get_weather");
  });

  it("rejects empty model with 400 ParseError", () => {
    const raw = { model: "", messages: [{ role: "user", content: "hi" }] };
    try {
      parseIRRequest(raw);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).status).toBe(400);
      expect((e as ParseError).code).toBe("invalid_request_error");
      expect((e as Error).message).toMatch(/model/i);
    }
  });

  it("rejects missing model with 400", () => {
    const raw = { messages: [{ role: "user", content: "hi" }] };
    expect(() => parseIRRequest(raw)).toThrow(expect.objectContaining({ status: 400 }));
    try {
      parseIRRequest(raw);
    } catch (e) {
      expect((e as ParseError).code).toBe("invalid_request_error");
    }
  });

  it("rejects empty messages array with 400", () => {
    const raw = { model: "m", messages: [] };
    expect(() => parseIRRequest(raw)).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("rejects missing messages with 400", () => {
    const raw = { model: "m" } as unknown;
    expect(() => parseIRRequest(raw)).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("rejects invalid role with 400", () => {
    const raw = { model: "m", messages: [{ role: "invalid_role", content: "hi" }] };
    expect(() => parseIRRequest(raw)).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("rejects non-string content with 400", () => {
    const raw = { model: "m", messages: [{ role: "user", content: 123 }] } as unknown;
    expect(() => parseIRRequest(raw)).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("validates temperature range 0-2", () => {
    const base = { model: "m", messages: [{ role: "user", content: "hi" }] };
    expect(() => parseIRRequest({ ...base, temperature: 1.5 })).not.toThrow();
    expect(() => parseIRRequest({ ...base, temperature: -0.1 })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => parseIRRequest({ ...base, temperature: 2.1 })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => parseIRRequest({ ...base, temperature: 0 })).not.toThrow();
    expect(() => parseIRRequest({ ...base, temperature: 2 })).not.toThrow();
  });

  it("validates optional passthrough types", () => {
    const base = { model: "m", messages: [{ role: "user", content: "hi" }] };
    // top_p 0-1
    expect(() => parseIRRequest({ ...base, top_p: 0.9 })).not.toThrow();
    expect(() => parseIRRequest({ ...base, top_p: 1.5 })).toThrow(expect.objectContaining({ status: 400 }));
    // presence_penalty -2 to 2
    expect(() => parseIRRequest({ ...base, presence_penalty: 1 })).not.toThrow();
    expect(() => parseIRRequest({ ...base, presence_penalty: 3 })).toThrow(expect.objectContaining({ status: 400 }));
    // n int >=1
    expect(() => parseIRRequest({ ...base, n: 2 })).not.toThrow();
    expect(() => parseIRRequest({ ...base, n: 0 })).toThrow(expect.objectContaining({ status: 400 }));
    // stop union
    expect(() => parseIRRequest({ ...base, stop: "END" })).not.toThrow();
    expect(() => parseIRRequest({ ...base, stop: ["a", "b"] })).not.toThrow();
    // seed int
    expect(() => parseIRRequest({ ...base, seed: 42 })).not.toThrow();
    // reasoning_effort unknown passthrough
    expect(() => parseIRRequest({ ...base, reasoning_effort: "high" })).not.toThrow();
  });

  it("preserves optional fields when provided", () => {
    const raw = {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 100,
      max_completion_tokens: 200,
      stop: ["\n"],
      presence_penalty: 0.5,
      frequency_penalty: -0.5,
      n: 1,
      seed: 123,
      user: "user-123",
      tools: [{ type: "function", function: { name: "foo" } }],
      tool_choice: "auto",
      reasoning_effort: "medium",
      verbosity: "low",
      reasoning_summary: "auto",
      response_format: { type: "json_object" },
    };
    const ir = parseIRRequest(raw);
    expect(ir.temperature).toBe(0.7);
    expect(ir.stream_options?.include_usage).toBe(true);
    expect(ir.max_tokens).toBe(100);
    expect(ir.tools).toBeDefined();
  });
});

describe("toUpstreamRequest", () => {
  it("forces stream:true regardless of IR stream value", () => {
    const irFalse = parseIRRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    const outFalse = toUpstreamRequest(irFalse);
    expect(outFalse.stream).toBe(true);

    const irTrue = parseIRRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    const outTrue = toUpstreamRequest(irTrue);
    expect(outTrue.stream).toBe(true);

    const irUndef = parseIRRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    const outUndef = toUpstreamRequest(irUndef);
    expect(outUndef.stream).toBe(true);
  });

  it("copies only PASSTHROUGH_KEYS and filters non-allowlist keys", () => {
    const ir: any = {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.8,
      top_p: 0.9,
      max_tokens: 123,
      stream: false,
      // extra non-allowlist keys
      bogus: "should-be-dropped",
      evil: 42,
      frequency_penalty: 0.1,
    };

    const out = toUpstreamRequest(ir);
    expect(out.model).toBe("m");
    expect(out.temperature).toBe(0.8);
    expect(out.top_p).toBe(0.9);
    expect(out.max_tokens).toBe(123);
    expect(out.frequency_penalty).toBe(0.1);
    expect((out as Record<string, unknown>).bogus).toBeUndefined();
    expect((out as Record<string, unknown>).evil).toBeUndefined();
    // must not leak allowlist check: ensure keys not in PASSTHROUGH are absent
    const allowSet = new Set<string>([...PASSTHROUGH_KEYS]);
    for (const k of Object.keys(out)) {
      if (k === "stream") continue; // forced
      expect(allowSet.has(k)).toBe(true);
    }
  });

  it("copies all allowlisted keys when present", () => {
    const raw = {
      model: "upstream-model",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.7,
      max_tokens: 50,
      max_completion_tokens: 60,
      top_p: 0.95,
      stream_options: { include_usage: true },
      stop: "END",
      presence_penalty: 0,
      frequency_penalty: 0,
      n: 1,
      response_format: { type: "text" },
      seed: 999,
      user: "u123",
      tools: [{ type: "function", function: { name: "t" } }],
      tool_choice: "auto",
      reasoning_effort: "high",
      verbosity: "medium",
      reasoning_summary: "auto",
    };
    const ir = parseIRRequest(raw);
    const out = toUpstreamRequest(ir);
    expect(out.model).toBe("upstream-model");
    expect(out.temperature).toBe(0.7);
    expect(out.max_tokens).toBe(50);
    expect(out.max_completion_tokens).toBe(60);
    expect(out.top_p).toBe(0.95);
    expect(out.stream_options).toEqual({ include_usage: true });
    expect(out.stop).toBe("END");
    expect(out.presence_penalty).toBe(0);
    expect(out.frequency_penalty).toBe(0);
    expect(out.n).toBe(1);
    expect(out.response_format).toEqual({ type: "text" });
    expect(out.seed).toBe(999);
    expect(out.user).toBe("u123");
    expect(out.tools).toEqual([{ type: "function", function: { name: "t" } }]);
    expect(out.tool_choice).toBe("auto");
    expect(out.reasoning_effort).toBe("high");
    expect(out.verbosity).toBe("medium");
    expect(out.reasoning_summary).toBe("auto");
    expect(out.stream).toBe(true);
  });

  it("does not copy undefined optional keys", () => {
    const ir = parseIRRequest({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const out = toUpstreamRequest(ir);
    // only model, messages, stream should be present
    const keys = Object.keys(out);
    expect(keys).toEqual(expect.arrayContaining(["model", "messages", "stream"]));
    expect(out.temperature).toBeUndefined();
    expect(out.top_p).toBeUndefined();
  });
});
