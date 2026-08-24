/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "bun:test";
import { parseAnthropicRequest } from "../src/adapters/anthropic/parser";
import { ParseError } from "../src/ir/types";

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 100,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  };
}

describe("parseAnthropicRequest", () => {
  // system handling
  it("maps system string to IR system message", () => {
    const ir = parseAnthropicRequest(base({ system: "you are helpful" }));
    expect(ir.messages[0]).toEqual({ role: "system", content: "you are helpful" });
    expect(ir.messages[1]).toEqual({ role: "user", content: "hello" });
  });

  it("maps system array of text blocks (joined)", () => {
    const ir = parseAnthropicRequest(
      base({ system: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] }),
    );
    expect(ir.messages[0]).toEqual({ role: "system", content: "hello world" });
  });

  it("ignores empty system string (no system message)", () => {
    const ir = parseAnthropicRequest(base({ system: "" }));
    expect(ir.messages[0]!.role).toBe("user");
  });

  it("rejects system with invalid type", () => {
    expect(() => parseAnthropicRequest(base({ system: 123 as any }))).toThrow(ParseError);
  });

  // user string
  it("maps user string content", () => {
    const ir = parseAnthropicRequest(base());
    expect(ir.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  // user array with text + tool_results
  it("maps user array with text + tool_results (text first then tool messages)", () => {
    const ir = parseAnthropicRequest(
      base({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hello " },
              { type: "text", text: "world" },
              { type: "tool_result", tool_use_id: "toolu_1", content: "result1" },
              { type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "result2" }] },
            ],
          },
        ],
      }),
    );
    expect(ir.messages).toEqual([
      { role: "user", content: "hello world" },
      { role: "tool", content: "result1", tool_call_id: "toolu_1" },
      { role: "tool", content: "result2", tool_call_id: "toolu_2" },
    ]);
  });

  it("maps user array with only tool_results (no empty user message)", () => {
    const ir = parseAnthropicRequest(
      base({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: "a" },
              { type: "tool_result", tool_use_id: "toolu_2", content: "b" },
            ],
          },
        ],
      }),
    );
    expect(ir.messages).toEqual([
      { role: "tool", content: "a", tool_call_id: "toolu_1" },
      { role: "tool", content: "b", tool_call_id: "toolu_2" },
    ]);
  });

  it("drops image blocks in user array (empty array → empty user)", () => {
    const ir = parseAnthropicRequest(
      base({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "abc" },
              },
            ],
          },
        ],
      }),
    );
    // no text, no tool_results => emits empty user "" to preserve turn
    expect(ir.messages).toEqual([{ role: "user", content: "" }]);
  });

  it("drops image blocks but keeps text and tool_results", () => {
    const ir = parseAnthropicRequest(
      base({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hi" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
              { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
            ],
          },
        ],
      }),
    );
    expect(ir.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "tool", content: "ok", tool_call_id: "toolu_1" },
    ]);
  });

  it("handles thinking in user array (joins thinking text)", () => {
    const ir = parseAnthropicRequest(
      base({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "a" },
              { type: "thinking", thinking: " think" },
            ],
          },
        ],
      }),
    );
    expect(ir.messages).toEqual([{ role: "user", content: "a think" }]);
  });

  it("drops redacted_thinking in user array", () => {
    const ir = parseAnthropicRequest(
      base({
        messages: [
          {
            role: "user",
            content: [
              { type: "redacted_thinking", data: "secret" },
              { type: "text", text: "hi" },
            ],
          },
        ],
      }),
    );
    expect(ir.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("redacted_thinking alone in user array becomes empty user", () => {
    const ir = parseAnthropicRequest(
      base({
        messages: [
          {
            role: "user",
            content: [{ type: "redacted_thinking", data: "secret" }],
          },
        ],
      }),
    );
    expect(ir.messages).toEqual([{ role: "user", content: "" }]);
  });

  it("handles empty user content array → empty user", () => {
    const ir = parseAnthropicRequest(
      base({
        messages: [{ role: "user", content: [] as any }],
      }),
    );
    expect(ir.messages).toEqual([{ role: "user", content: "" }]);
  });

  it("stringifies tool_result with array text blocks", () => {
    const ir = parseAnthropicRequest(
      base({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: [
                  { type: "text", text: "part1 " },
                  { type: "text", text: "part2" },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(ir.messages).toEqual([{ role: "tool", content: "part1 part2", tool_call_id: "toolu_1" }]);
  });

  it("preserves tool_result content with is_error flag (same content)", () => {
    const ir = parseAnthropicRequest(
      base({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: "oops", is_error: true },
              { type: "tool_result", tool_use_id: "toolu_2", content: "ok", is_error: false },
            ],
          },
        ],
      }),
    );
    expect(ir.messages).toEqual([
      { role: "tool", content: "oops", tool_call_id: "toolu_1" },
      { role: "tool", content: "ok", tool_call_id: "toolu_2" },
    ]);
  });

  // assistant
  it("maps assistant string content", () => {
    const ir = parseAnthropicRequest(
      base({
        messages: [{ role: "assistant", content: "hi there" }],
      }),
    );
    expect(ir.messages).toEqual([{ role: "assistant", content: "hi there" }]);
  });

  it("maps assistant array text + tool_use", () => {
    const ir = parseAnthropicRequest(
      base({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "call " },
              { type: "text", text: "tool" },
              { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
            ],
          },
        ],
      }),
    );
    expect(ir.messages.length).toBe(1);
    expect(ir.messages[0]!.role).toBe("assistant");
    expect(ir.messages[0]!.content).toBe("call tool");
    expect(ir.messages[0]!.tool_calls).toEqual([
      { id: "toolu_1", type: "function", function: { name: "get_weather", arguments: JSON.stringify({ city: "Paris" }) } },
    ]);
  });

  it("maps assistant array with multiple tool_use", () => {
    const ir = parseAnthropicRequest(
      base({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "a", name: "foo", input: {} },
              { type: "tool_use", id: "b", name: "bar", input: null },
            ],
          },
        ],
      }),
    );
    expect(ir.messages[0]!.content).toBe("");
    expect(ir.messages[0]!.tool_calls).toHaveLength(2);
    expect(ir.messages[0]!.tool_calls![1]!.function.arguments).toBe("{}");
  });

  it("handles thinking in assistant array (joins thinking text)", () => {
    const ir = parseAnthropicRequest(
      base({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "let me think " },
              { type: "text", text: "answer" },
            ],
          },
        ],
      }),
    );
    expect(ir.messages[0]!.content).toBe("let me think answer");
  });

  it("drops redacted_thinking in assistant array", () => {
    const ir = parseAnthropicRequest(
      base({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "redacted_thinking", data: "xxx" },
              { type: "text", text: "hi" },
            ],
          },
        ],
      }),
    );
    expect(ir.messages[0]!.content).toBe("hi");
    expect(ir.messages[0]!.tool_calls).toBeUndefined();
  });

  it("drops image in assistant array", () => {
    const ir = parseAnthropicRequest(
      base({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "hi" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
            ],
          },
        ],
      }),
    );
    expect(ir.messages[0]!.content).toBe("hi");
  });

  it("validates tool_use requires id and name", () => {
    expect(() =>
      parseAnthropicRequest(
        base({
          messages: [
            {
              role: "assistant",
              content: [{ type: "tool_use", id: "a", name: "" } as any],
            },
          ],
        }),
      ),
    ).not.toThrow(); // empty name allowed? spec says name required string, but we test missing name
    expect(() =>
      parseAnthropicRequest(
        base({
          messages: [
            {
              role: "assistant",
              content: [{ type: "tool_use", name: "foo" } as any],
            },
          ],
        }),
      ),
    ).toThrow(ParseError);
    expect(() =>
      parseAnthropicRequest(
        base({
          messages: [
            {
              role: "assistant",
              content: [{ type: "tool_use", id: "a" } as any],
            },
          ],
        }),
      ),
    ).toThrow(ParseError);
  });

  // error cases for wrong role blocks
  it("rejects tool_use in user role", () => {
    expect(() =>
      parseAnthropicRequest(
        base({
          messages: [
            {
              role: "user",
              content: [{ type: "tool_use", id: "a", name: "foo", input: {} } as any],
            },
          ],
        }),
      ),
    ).toThrow(ParseError);
  });

  it("rejects tool_result in assistant role", () => {
    expect(() =>
      parseAnthropicRequest(
        base({
          messages: [
            {
              role: "assistant",
              content: [{ type: "tool_result", tool_use_id: "a", content: "x" } as any],
            },
          ],
        }),
      ),
    ).toThrow(ParseError);
  });

  it("rejects unknown block type in user role", () => {
    expect(() =>
      parseAnthropicRequest(
        base({
          messages: [
            {
              role: "user",
              content: [{ type: "unknown_block", text: "hi" } as any],
            },
          ],
        }),
      ),
    ).toThrow(ParseError);
  });

  it("rejects unknown block type in assistant role", () => {
    expect(() =>
      parseAnthropicRequest(
        base({
          messages: [
            {
              role: "assistant",
              content: [{ type: "weird", text: "hi" } as any],
            },
          ],
        }),
      ),
    ).toThrow(ParseError);
  });

  it("rejects invalid block without type", () => {
    expect(() =>
      parseAnthropicRequest(
        base({
          messages: [{ role: "user", content: [{ text: "hi" } as any] }],
        }),
      ),
    ).toThrow(ParseError);
  });

  // tools mapping
  it("maps tools with description and input_schema", () => {
    const ir = parseAnthropicRequest(
      base({
        tools: [
          {
            name: "get_weather",
            description: "Get weather",
            input_schema: { type: "object", properties: { city: { type: "string" } } },
          },
        ],
      }),
    );
    expect(ir.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ]);
  });

  it("maps tools gracefully when description/input_schema missing", () => {
    const ir = parseAnthropicRequest(
      base({
        tools: [{ name: "foo" }],
      }),
    );
    expect(ir.tools).toEqual([
      {
        type: "function",
        function: { name: "foo", description: undefined, parameters: undefined },
      },
    ]);
  });

  it("rejects tools when not an array", () => {
    expect(() => parseAnthropicRequest(base({ tools: {} as any }))).toThrow(ParseError);
  });

  it("rejects tools when name missing or empty", () => {
    expect(() => parseAnthropicRequest(base({ tools: [{ description: "x" } as any] }))).toThrow(ParseError);
    expect(() => parseAnthropicRequest(base({ tools: [{ name: "" } as any] }))).toThrow(ParseError);
  });

  // tool_choice mapping
  it("maps tool_choice auto", () => {
    const ir = parseAnthropicRequest(base({ tool_choice: { type: "auto" } }));
    expect(ir.tool_choice).toBe("auto");
  });

  it("maps tool_choice any → required", () => {
    const ir = parseAnthropicRequest(base({ tool_choice: { type: "any" } }));
    expect(ir.tool_choice).toBe("required");
  });

  it("maps tool_choice tool → function", () => {
    const ir = parseAnthropicRequest(base({ tool_choice: { type: "tool", name: "get_weather" } }));
    expect(ir.tool_choice).toEqual({ type: "function", function: { name: "get_weather" } });
  });

  it("rejects tool_choice tool without name", () => {
    expect(() => parseAnthropicRequest(base({ tool_choice: { type: "tool" } as any }))).toThrow(ParseError);
    expect(() => parseAnthropicRequest(base({ tool_choice: { type: "tool", name: 123 as any } }))).toThrow(ParseError);
  });

  it("rejects tool_choice unknown type", () => {
    expect(() => parseAnthropicRequest(base({ tool_choice: { type: "weird" } as any }))).toThrow(ParseError);
  });

  it("rejects tool_choice missing type", () => {
    expect(() => parseAnthropicRequest(base({ tool_choice: {} as any }))).toThrow(ParseError);
    expect(() => parseAnthropicRequest(base({ tool_choice: { name: "foo" } as any }))).toThrow(ParseError);
  });

  // stop_sequences
  it("maps stop_sequences to IR stop", () => {
    const ir = parseAnthropicRequest(base({ stop_sequences: ["stop1", "stop2"] as any }));
    expect(ir.stop).toEqual(["stop1", "stop2"]);
  });

  it("maps single stop_sequences", () => {
    const ir = parseAnthropicRequest(base({ stop_sequences: ["end"] as any }));
    expect(ir.stop).toEqual(["end"]);
  });

  // passthrough fields
  it("passes through stream, temperature, top_p, max_tokens", () => {
    const ir = parseAnthropicRequest(
      base({
        stream: true,
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 200,
      }),
    );
    expect(ir.stream).toBe(true);
    expect(ir.temperature).toBe(0.7);
    expect(ir.top_p).toBe(0.9);
    expect(ir.max_tokens).toBe(200);
  });

  it("strips undefined keys before IR validation (no spurious errors)", () => {
    const ir = parseAnthropicRequest(base({ temperature: undefined as any, top_p: undefined as any }));
    expect(ir.temperature).toBeUndefined();
    expect(ir.top_p).toBeUndefined();
  });

  // validation
  it("rejects empty messages array", () => {
    expect(() => parseAnthropicRequest(base({ messages: [] as any }))).toThrow(ParseError);
  });

  it("rejects messages not an array", () => {
    expect(() => parseAnthropicRequest(base({ messages: "hi" as any }))).toThrow(ParseError);
  });

  it("rejects message with invalid role", () => {
    expect(() =>
      parseAnthropicRequest(base({ messages: [{ role: "system", content: "hi" } as any] })),
    ).toThrow(ParseError);
  });

  it("rejects message not an object", () => {
    expect(() => parseAnthropicRequest(base({ messages: ["hi" as any] }))).toThrow(ParseError);
  });

  it("rejects user content with invalid type", () => {
    expect(() =>
      parseAnthropicRequest(base({ messages: [{ role: "user", content: 123 as any }] })),
    ).toThrow(ParseError);
  });

  it("rejects assistant content with invalid type", () => {
    expect(() =>
      parseAnthropicRequest(base({ messages: [{ role: "assistant", content: 123 as any }] })),
    ).toThrow(ParseError);
  });

  it("rejects missing max_tokens", () => {
    const b = base();
    delete (b as any).max_tokens;
    expect(() => parseAnthropicRequest(b)).toThrow(ParseError);
  });

  it("rejects max_tokens zero / negative / float / string", () => {
    expect(() => parseAnthropicRequest(base({ max_tokens: 0 as any }))).toThrow(ParseError);
    expect(() => parseAnthropicRequest(base({ max_tokens: -1 as any }))).toThrow(ParseError);
    expect(() => parseAnthropicRequest(base({ max_tokens: 1.5 as any }))).toThrow(ParseError);
    expect(() => parseAnthropicRequest(base({ max_tokens: "100" as any }))).toThrow(ParseError);
  });

  it("rejects missing model", () => {
    const b = base();
    delete (b as any).model;
    expect(() => parseAnthropicRequest(b)).toThrow(ParseError);
  });

  it("rejects empty model", () => {
    expect(() => parseAnthropicRequest(base({ model: "" as any }))).toThrow(ParseError);
    expect(() => parseAnthropicRequest(base({ model: 123 as any }))).toThrow(ParseError);
  });

  it("rejects non-object body", () => {
    expect(() => parseAnthropicRequest(null as any)).toThrow(ParseError);
    expect(() => parseAnthropicRequest([] as any)).toThrow(ParseError);
    expect(() => parseAnthropicRequest("hi" as any)).toThrow(ParseError);
  });

  it("throws ParseError with status 400", () => {
    try {
      parseAnthropicRequest(base({ model: "" as any }));
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).status).toBe(400);
      expect((e as ParseError).code).toBe("invalid_request_error");
      return;
    }
    throw new Error("should have thrown");
  });

  it("supports system string + user string together", () => {
    const ir = parseAnthropicRequest({
      model: "claude-3",
      max_tokens: 10,
      system: "system prompt",
      messages: [{ role: "user", content: "hi" }],
    } as any);
    expect(ir.messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "hi" },
    ]);
  });

  it("multi-turn preserves order: user, assistant, user", () => {
    const ir = parseAnthropicRequest(
      base({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "how are you" },
        ],
      }),
    );
    expect(ir.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "how are you" },
    ]);
  });
});
