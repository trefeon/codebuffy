/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "bun:test";
import { parseResponsesRequest, stringifyOutput } from "../src/adapters/responses/parser";
import { ParseError } from "../src/ir/types";

// helper to make base valid body
function base(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    model: "gpt-4o",
    input: "hello",
    ...overrides,
  };
}

describe("parseResponsesRequest", () => {
  // instructions -> system
  it("maps instructions to first system message", () => {
    const ir = parseResponsesRequest(base({ instructions: "you are helpful", input: "hi" }));
    expect(ir.messages[0]).toEqual({ role: "system", content: "you are helpful" });
    expect(ir.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("prepends instructions system before input system/developer messages (order: instructions first)", () => {
    const ir = parseResponsesRequest(
      base({
        instructions: "inst system",
        input: [
          { role: "system", content: "sys from input" },
          { role: "developer", content: "dev guidance" },
          { role: "user", content: "hello" },
        ],
      }),
    );
    expect(ir.messages[0]).toEqual({ role: "system", content: "inst system" });
    expect(ir.messages[1]).toEqual({ role: "system", content: "sys from input" });
    expect(ir.messages[2]).toEqual({ role: "system", content: "dev guidance" });
    expect(ir.messages[3]).toEqual({ role: "user", content: "hello" });
  });

  it("handles instructions empty string -> no system message", () => {
    const ir = parseResponsesRequest(base({ instructions: "", input: "hi" }));
    expect(ir.messages[0]!.role).toBe("user");
  });

  // input string -> user
  it("maps input string to single user message", () => {
    const ir = parseResponsesRequest(base({ input: "plain string" }));
    expect(ir.messages).toEqual([{ role: "user", content: "plain string" }]);
  });

  it("input string with instructions creates system + user", () => {
    const ir = parseResponsesRequest(base({ instructions: "sys", input: "user text" }));
    expect(ir.messages.length).toBe(2);
    expect(ir.messages[0]!.role).toBe("system");
    expect(ir.messages[1]!.role).toBe("user");
  });

  // input array user+system+developer
  it("maps input array user+system+developer with string contents", () => {
    const ir = parseResponsesRequest(
      base({
        input: [
          { role: "system", content: "sys" },
          { role: "developer", content: "dev" },
          { role: "user", content: "usr" },
        ],
      }),
    );
    expect(ir.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "system", content: "dev" },
      { role: "user", content: "usr" },
    ]);
  });

  it("maps input array user with content array input_text and text joined", () => {
    const ir = parseResponsesRequest(
      base({
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "hello " },
              { type: "text", text: "world" },
            ],
          },
        ],
      }),
    );
    expect(ir.messages).toEqual([{ role: "user", content: "hello world" }]);
  });

  it("drops input_image in user content array", () => {
    const ir = parseResponsesRequest(
      base({
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "hi" },
              { type: "input_image", image_url: "https://example.com/img.png" },
              { type: "text", text: " there" },
            ],
          },
        ],
      }),
    );
    expect(ir.messages[0]!.content).toBe("hi there");
  });

  it("maps input array with system content array and developer content string", () => {
    const ir = parseResponsesRequest(
      base({
        input: [
          { role: "system", content: [{ type: "input_text", text: "sys " }, { type: "text", text: "block" }] },
          { role: "developer", content: "dev string" },
        ],
      }),
    );
    expect(ir.messages[0]!.content).toBe("sys block");
    expect(ir.messages[0]!.role).toBe("system");
    expect(ir.messages[1]!.content).toBe("dev string");
    expect(ir.messages[1]!.role).toBe("system");
  });

  it("handles typed message role user/system/developer", () => {
    const ir = parseResponsesRequest(
      base({
        input: [
          { type: "message", role: "user", content: "typed user" },
          { type: "message", role: "system", content: "typed sys" },
          { type: "message", role: "developer", content: "typed dev" },
        ],
      }),
    );
    expect(ir.messages).toEqual([
      { role: "user", content: "typed user" },
      { role: "system", content: "typed sys" },
      { role: "system", content: "typed dev" },
    ]);
  });

  // assistant message pending
  it("buffers assistant message pending (type message role assistant with output_text)", () => {
    const ir = parseResponsesRequest(
      base({
        input: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello " }, { type: "output_text", text: "world" }] },
          { role: "user", content: "next" },
        ],
      }),
    );
    expect(ir.messages[0]).toEqual({ role: "assistant", content: "hello world" });
    expect(ir.messages[1]!).toEqual({ role: "user", content: "next" });
  });

  it("buffers assistant message via bare role assistant string content", () => {
    const ir = parseResponsesRequest(
      base({
        input: [{ role: "assistant", content: "assistant bare" }, { role: "user", content: "hi" }],
      }),
    );
    expect(ir.messages[0]!.role).toBe("assistant");
    expect(ir.messages[0]!.content).toBe("assistant bare");
  });

  it("concatenates multiple output_text within same assistant message", () => {
    const ir = parseResponsesRequest(
      base({
        input: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "part1-" }, { type: "output_text", text: "part2" }] },
        ],
      }),
    );
    expect(ir.messages[0]!.content).toBe("part1-part2");
  });

  it("handles assistant message with string content (not array)", () => {
    const ir = parseResponsesRequest(
      base({
        input: [{ type: "message", role: "assistant", content: "string assistant" as any }],
      }),
    );
    expect(ir.messages[0]!.content).toBe("string assistant");
  });

  it("flushes pending assistant correctly after loop (no following user)", () => {
    const ir = parseResponsesRequest(
      base({
        input: [
          { role: "user", content: "hi" },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "response at end" }] },
        ],
      }),
    );
    expect(ir.messages[1]!.role).toBe("assistant");
    expect(ir.messages[1]!.content).toBe("response at end");
    expect(ir.messages.length).toBe(2);
  });

  it("handles multiple pending assistant messages separated by tool output (each flushed)", () => {
    const ir = parseResponsesRequest(
      base({
        input: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "first" }] },
          { type: "function_call", call_id: "call_1", name: "foo", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: "result" },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "second" }] },
        ],
      }),
    );
    // First assistant with tool_calls, then tool, then second assistant
    expect(ir.messages[0]!.role).toBe("assistant");
    expect(ir.messages[0]!.content).toBe("first");
    expect(ir.messages[0]!.tool_calls!.length).toBe(1);
    expect(ir.messages[1]!.role).toBe("tool");
    expect(ir.messages[2]!.role).toBe("assistant");
    expect(ir.messages[2]!.content).toBe("second");
  });

  // function_call buffering
  it("buffers function_call as pending assistant tool_calls (call_id preferred)", () => {
    const ir = parseResponsesRequest(
      base({
        input: [
          { role: "user", content: "call tool" },
          { type: "function_call", call_id: "call_123", id: "id_999", name: "shell", arguments: '{"cmd":"ls"}' },
        ],
      }),
    );
    expect(ir.messages[1]!.role).toBe("assistant");
    expect(ir.messages[1]!.tool_calls).toEqual([
      { id: "call_123", type: "function", function: { name: "shell", arguments: '{"cmd":"ls"}' } },
    ]);
  });

  it("function_call uses id when call_id missing", () => {
    const ir = parseResponsesRequest(
      base({
        input: [{ type: "function_call", id: "my_id", name: "foo", arguments: "{}" }],
      }),
    );
    expect(ir.messages[0]!.tool_calls![0]!.id).toBe("my_id");
  });

  it("function_call generates call_ id when neither call_id nor id", () => {
    const ir = parseResponsesRequest(
      base({
        input: [{ type: "function_call", name: "gen", arguments: "{}" }],
      }),
    );
    expect(ir.messages[0]!.tool_calls![0]!.id).toMatch(/^call_/);
  });

  it("function_call arguments string kept as-is", () => {
    const ir = parseResponsesRequest(
      base({
        input: [{ type: "function_call", call_id: "c1", name: "fn", arguments: '{"a":1}' }],
      }),
    );
    expect(ir.messages[0]!.tool_calls![0]!.function.arguments).toBe('{"a":1}');
  });

  it("function_call arguments object JSON.stringify", () => {
    const ir = parseResponsesRequest(
      base({
        input: [{ type: "function_call", call_id: "c1", name: "fn", arguments: { a: 1, b: "hi" } as any }],
      }),
    );
    expect(ir.messages[0]!.tool_calls![0]!.function.arguments).toBe(JSON.stringify({ a: 1, b: "hi" }));
  });

  it("function_call arguments undefined defaults to {}", () => {
    const ir = parseResponsesRequest(
      base({
        input: [{ type: "function_call", call_id: "c1", name: "fn" } as any],
      }),
    );
    expect(ir.messages[0]!.tool_calls![0]!.function.arguments).toBe("{}");
  });

  it("buffers multiple function_calls into same assistant tool_calls", () => {
    const ir = parseResponsesRequest(
      base({
        input: [
          { type: "function_call", call_id: "c1", name: "a", arguments: "{}" },
          { type: "function_call", call_id: "c2", name: "b", arguments: "{}" },
        ],
      }),
    );
    expect(ir.messages.length).toBe(1);
    expect(ir.messages[0]!.tool_calls!.length).toBe(2);
    expect(ir.messages[0]!.tool_calls![0]!.id).toBe("c1");
    expect(ir.messages[0]!.tool_calls![1]!.id).toBe("c2");
  });

  it("merges assistant message + function_call into single assistant with content + tool_calls", () => {
    const ir = parseResponsesRequest(
      base({
        input: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "text before" }] },
          { type: "function_call", call_id: "call_1", name: "toolA", arguments: "{}" },
          { role: "user", content: "after" },
        ],
      }),
    );
    expect(ir.messages[0]!.role).toBe("assistant");
    expect(ir.messages[0]!.content).toBe("text before");
    expect(ir.messages[0]!.tool_calls!.length).toBe(1);
    expect(ir.messages[1]!.role).toBe("user");
  });

  // function_call_output -> tool
  it("maps function_call_output to tool message", () => {
    const ir = parseResponsesRequest(
      base({
        input: [{ type: "function_call_output", call_id: "call_123", output: "tool result" }],
      }),
    );
    expect(ir.messages[0]).toEqual({ role: "tool", tool_call_id: "call_123", content: "tool result" });
  });

  it("stringifies function_call_output object output via JSON", () => {
    const ir = parseResponsesRequest(
      base({
        input: [{ type: "function_call_output", call_id: "c1", output: { result: "ok", code: 0 } as any }],
      }),
    );
    expect(ir.messages[0]!.content).toBe(JSON.stringify({ result: "ok", code: 0 }));
  });

  it("flushes pending assistant before tool output (tool follows assistant)", () => {
    const ir = parseResponsesRequest(
      base({
        input: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "will call" }] },
          { type: "function_call", call_id: "call_1", name: "exec", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: "output text" },
          { role: "user", content: "next" },
        ],
      }),
    );
    // order: assistant (with tool_calls), tool, user
    expect(ir.messages[0]!.role).toBe("assistant");
    expect(ir.messages[0]!.tool_calls!.length).toBe(1);
    expect(ir.messages[0]!.content).toBe("will call");
    expect(ir.messages[1]).toEqual({ role: "tool", tool_call_id: "call_1", content: "output text" });
    expect(ir.messages[2]!.role).toBe("user");
  });

  it("handles function_call_output with empty assistant pending (just tool)", () => {
    const ir = parseResponsesRequest(
      base({
        input: [
          { type: "function_call_output", call_id: "c1", output: "out1" },
          { type: "function_call_output", call_id: "c2", output: "out2" },
        ],
      }),
    );
    expect(ir.messages[0]).toEqual({ role: "tool", tool_call_id: "c1", content: "out1" });
    expect(ir.messages[1]).toEqual({ role: "tool", tool_call_id: "c2", content: "out2" });
  });

  // tools mapping + unsupported
  it("maps tools flat format to IR nested", () => {
    const ir = parseResponsesRequest(
      base({
        input: "hi",
        tools: [{ type: "function", name: "shell", description: "run cmd", parameters: { type: "object", properties: { cmd: { type: "string" } } }, strict: true }],
      }),
    );
    expect(ir.tools).toEqual([
      {
        type: "function",
        function: {
          name: "shell",
          description: "run cmd",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
          strict: true,
        },
      },
    ]);
  });

  it("maps tools with minimal fields", () => {
    const ir = parseResponsesRequest(base({ input: "hi", tools: [{ type: "function", name: "foo" }] }));
    expect(ir.tools).toEqual([{ type: "function", function: { name: "foo" } }]);
  });

  it("handles tools already nested Chat format (has function key)", () => {
    const ir = parseResponsesRequest(
      base({
        input: "hi",
        tools: [{ type: "function", function: { name: "bar", description: "d", parameters: { type: "object" } } } as any],
      }),
    );
    expect((ir.tools as any)[0].function.name).toBe("bar");
  });

  it("throws 400 for unsupported tool type", () => {
    try {
      parseResponsesRequest(base({ input: "hi", tools: [{ type: "code_interpreter", name: "foo" } as any] }));
      expect(true).toBe(false);
    } catch (e) {
      const err = e as Error & { status?: number };
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/unsupported tool type/i);
    }
  });

  it("throws 400 for tool without type field (unsupported)", () => {
    try {
      parseResponsesRequest(base({ input: "hi", tools: [{ name: "foo" } as any] }));
      expect(true).toBe(false);
    } catch (e) {
      const err = e as Error & { status?: number };
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/unsupported tool type/i);
    }
  });

  it("throws 400 for tool with type != function and verifies error message", () => {
    expect(() => parseResponsesRequest(base({ input: "hi", tools: [{ type: "image_generation", name: "x" } as any] }))).toThrow(ParseError);
    try {
      parseResponsesRequest(base({ input: "hi", tools: [{ type: "web_search", name: "ws" } as any] }));
      expect(true).toBe(false);
    } catch (e) {
      expect((e as Error).message).toMatch(/unsupported tool type/);
    }
  });

  it("throws 400 for tools not an array", () => {
    expect(() => parseResponsesRequest(base({ input: "hi", tools: {} as any }))).toThrow(ParseError);
  });

  it("throws 400 for tool missing name in flat format", () => {
    expect(() => parseResponsesRequest(base({ input: "hi", tools: [{ type: "function" } as any] }))).toThrow(ParseError);
    expect(() => parseResponsesRequest(base({ input: "hi", tools: [{ type: "function", name: "" } as any] }))).toThrow(ParseError);
  });

  // previous_response_id ignored
  it("ignores previous_response_id but validates string (not forwarded)", () => {
    const ir = parseResponsesRequest(base({ input: "hi", previous_response_id: "resp_123" }));
    expect(ir.messages[0]!.content).toBe("hi");
    // IR has no field, ensure not throwing and not adding to messages
    expect((ir as any).previous_response_id).toBeUndefined();
    expect((ir as any)._previous_response_id).toBeUndefined();
  });

  it("previous_response_id present as string does not affect messages count", () => {
    const without = parseResponsesRequest(base({ input: "hi" }));
    const withPrev = parseResponsesRequest(base({ input: "hi", previous_response_id: "resp_abc" }));
    expect(withPrev.messages).toEqual(without.messages);
    expect(withPrev.model).toEqual(without.model);
  });

  it("throws 400 for previous_response_id not string", () => {
    expect(() => parseResponsesRequest(base({ input: "hi", previous_response_id: 123 as any }))).toThrow(ParseError);
    expect(() => parseResponsesRequest(base({ input: "hi", previous_response_id: {} as any }))).toThrow(ParseError);
  });

  // reasoning drop
  it("drops reasoning object without throwing", () => {
    const ir = parseResponsesRequest(
      base({ input: "hi", reasoning: { effort: "high", summary: "test" } as any }),
    );
    expect(ir.messages[0]!.content).toBe("hi");
    expect((ir as any).reasoning).toBeUndefined();
  });

  it("drops reasoning when empty object", () => {
    const ir = parseResponsesRequest(base({ input: "hi", reasoning: {} as any }));
    expect(ir.messages.length).toBe(1);
  });

  it("drops reasoning even with invalid shape (not throwing)", () => {
    const ir = parseResponsesRequest(base({ input: "hi", reasoning: "not an object" as any }));
    expect(ir.messages[0]!.content).toBe("hi");
  });

  // empty input error
  it("throws 400 for empty input string", () => {
    try {
      parseResponsesRequest(base({ input: "" }));
      expect(true).toBe(false);
    } catch (e) {
      const err = e as Error & { status?: number };
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/input/i);
    }
  });

  it("throws 400 for empty input array", () => {
    try {
      parseResponsesRequest(base({ input: [] }));
      expect(true).toBe(false);
    } catch (e) {
      const err = e as Error & { status?: number };
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/input/i);
    }
  });

  it("throws 400 for missing input", () => {
    const body: any = { model: "gpt-4o" };
    try {
      parseResponsesRequest(body);
      expect(true).toBe(false);
    } catch (e) {
      const err = e as Error & { status?: number };
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/input/i);
    }
  });

  it("throws 400 for input not string nor array", () => {
    expect(() => parseResponsesRequest(base({ input: 123 as any }))).toThrow(ParseError);
    expect(() => parseResponsesRequest(base({ input: {} as any }))).toThrow(ParseError);
    expect(() => parseResponsesRequest(base({ input: null as any }))).toThrow(ParseError);
  });

  // model missing error
  it("throws 400 for missing model", () => {
    try {
      parseResponsesRequest({ input: "hi" } as any);
      expect(true).toBe(false);
    } catch (e) {
      const err = e as Error & { status?: number };
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/model/i);
    }
  });

  it("throws 400 for empty model string", () => {
    try {
      parseResponsesRequest(base({ model: "" }));
      expect(true).toBe(false);
    } catch (e) {
      const err = e as Error & { status?: number };
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/model/i);
    }
  });

  it("throws 400 for model not string", () => {
    expect(() => parseResponsesRequest(base({ model: 123 as any }))).toThrow(ParseError);
    expect(() => parseResponsesRequest(base({ model: null as any }))).toThrow(ParseError);
  });

  it("throws 400 for request not an object", () => {
    expect(() => parseResponsesRequest(null as any)).toThrow(ParseError);
    expect(() => parseResponsesRequest("string" as any)).toThrow(ParseError);
    expect(() => parseResponsesRequest([] as any)).toThrow(ParseError);
  });

  // unknown fields not throw
  it("ignores unknown top-level fields without throwing", () => {
    const ir = parseResponsesRequest(
      base({ input: "hi", unknownField: "value", extra: { nested: 123 }, text: { format: "plain" } as any, random: 999 as any }),
    );
    expect(ir.messages[0]!.content).toBe("hi");
  });

  it("ignores unknown fields in input items without throwing (unknown type without role)", () => {
    const ir = parseResponsesRequest(
      base({
        input: [
          { role: "user", content: "hi" },
          { type: "unknown_custom", foo: "bar" } as any,
          { role: "user", content: "after" },
        ],
      }),
    );
    expect(ir.messages.length).toBe(2);
    expect(ir.messages[1]!.content).toBe("after");
  });

  it("ignores unknown item type reasoning (dropped)", () => {
    const ir = parseResponsesRequest(
      base({
        input: [
          { role: "user", content: "hi" },
          { type: "reasoning", reasoning: "thinking..." } as any,
          { role: "assistant", content: "response" } as any,
        ],
      }),
    );
    // reasoning dropped, but assistant should still be buffered
    expect(ir.messages[1]!.role).toBe("assistant");
  });

  // max_output_tokens
  it("maps max_output_tokens to max_tokens", () => {
    const ir = parseResponsesRequest(base({ input: "hi", max_output_tokens: 500 }));
    expect(ir.max_tokens).toBe(500);
  });

  it("maps max_tokens when max_output_tokens absent", () => {
    const ir = parseResponsesRequest(base({ input: "hi", max_tokens: 300 }));
    expect(ir.max_tokens).toBe(300);
  });

  it("prefers max_output_tokens over max_tokens when both present", () => {
    const ir = parseResponsesRequest(base({ input: "hi", max_output_tokens: 800, max_tokens: 200 }));
    expect(ir.max_tokens).toBe(800);
  });

  it("throws 400 for invalid max_output_tokens (zero, negative, float, string)", () => {
    expect(() => parseResponsesRequest(base({ input: "hi", max_output_tokens: 0 as any }))).toThrow(ParseError);
    expect(() => parseResponsesRequest(base({ input: "hi", max_output_tokens: -5 as any }))).toThrow(ParseError);
    expect(() => parseResponsesRequest(base({ input: "hi", max_output_tokens: 1.5 as any }))).toThrow(ParseError);
    expect(() => parseResponsesRequest(base({ input: "hi", max_output_tokens: "500" as any }))).toThrow(ParseError);
  });

  it("throws 400 for invalid max_tokens", () => {
    expect(() => parseResponsesRequest(base({ input: "hi", max_tokens: 0 as any }))).toThrow(ParseError);
    expect(() => parseResponsesRequest(base({ input: "hi", max_tokens: -1 as any }))).toThrow(ParseError);
  });

  // stream
  it("maps stream true and false", () => {
    const irTrue = parseResponsesRequest(base({ input: "hi", stream: true }));
    expect(irTrue.stream).toBe(true);
    const irFalse = parseResponsesRequest(base({ input: "hi", stream: false }));
    expect(irFalse.stream).toBe(false);
  });

  it("throws 400 for stream not boolean", () => {
    expect(() => parseResponsesRequest(base({ input: "hi", stream: "true" as any }))).toThrow(ParseError);
    expect(() => parseResponsesRequest(base({ input: "hi", stream: 1 as any }))).toThrow(ParseError);
  });

  // temperature/top_p and other passthrough
  it("passes through temperature and top_p", () => {
    const ir = parseResponsesRequest(base({ input: "hi", temperature: 0.7, top_p: 0.9 }));
    expect(ir.temperature).toBe(0.7);
    expect(ir.top_p).toBe(0.9);
  });

  it("throws 400 for temperature not number", () => {
    expect(() => parseResponsesRequest(base({ input: "hi", temperature: "0.7" as any }))).toThrow(ParseError);
  });

  it("throws 400 for top_p not number", () => {
    expect(() => parseResponsesRequest(base({ input: "hi", top_p: "0.9" as any }))).toThrow(ParseError);
  });

  it("throws 400 for instructions not string", () => {
    expect(() => parseResponsesRequest(base({ input: "hi", instructions: 123 as any }))).toThrow(ParseError);
    expect(() => parseResponsesRequest(base({ input: "hi", instructions: {} as any }))).toThrow(ParseError);
  });

  it("passes through user field", () => {
    const ir = parseResponsesRequest(base({ input: "hi", user: "user-123" }));
    expect(ir.user).toBe("user-123");
  });

  it("passes through tool_choice", () => {
    const ir = parseResponsesRequest(base({ input: "hi", tool_choice: "auto" as any }));
    expect(ir.tool_choice).toBe("auto");
    const ir2 = parseResponsesRequest(base({ input: "hi", tool_choice: { type: "function", function: { name: "foo" } } as any }));
    expect(ir2.tool_choice).toEqual({ type: "function", function: { name: "foo" } });
  });

  // validation edge cases for input items
  it("throws 400 for input item not an object", () => {
    expect(() => parseResponsesRequest(base({ input: ["not object" as any] }))).toThrow(ParseError);
    expect(() => parseResponsesRequest(base({ input: [null as any] }))).toThrow(ParseError);
    expect(() => parseResponsesRequest(base({ input: [123 as any] }))).toThrow(ParseError);
  });

  it("throws 400 for input item invalid role", () => {
    expect(() => parseResponsesRequest(base({ input: [{ role: "invalid", content: "hi" } as any] }))).toThrow(ParseError);
    expect(() => parseResponsesRequest(base({ input: [{ role: "assistant", content: "hi" }, { role: "badrole", content: "x" } as any] }))).toThrow(ParseError);
  });

  it("throws 400 for function_call missing name", () => {
    expect(() => parseResponsesRequest(base({ input: [{ type: "function_call", call_id: "c1" } as any] }))).toThrow(ParseError);
    expect(() => parseResponsesRequest(base({ input: [{ type: "function_call", call_id: "c1", name: "" } as any] }))).toThrow(ParseError);
  });

  it("throws 400 for function_call_output missing call_id", () => {
    expect(() => parseResponsesRequest(base({ input: [{ type: "function_call_output", output: "hi" } as any] }))).toThrow(ParseError);
    expect(() => parseResponsesRequest(base({ input: [{ type: "function_call_output", call_id: "", output: "hi" } as any] }))).toThrow(ParseError);
  });

  // complex integration: full conversation with all types
  it("handles complex conversation with instructions, mixed input shapes, tools, and output flushing", () => {
    const ir = parseResponsesRequest({
      model: "gpt-4o",
      instructions: "You are helpful",
      input: [
        { role: "user", content: "Fix bug" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking" }] },
        { type: "function_call", call_id: "call_1", name: "exec", arguments: '{"cmd":"ls"}' },
        { type: "function_call", call_id: "call_2", name: "read", arguments: { path: "/tmp/foo" } as any },
        { type: "function_call_output", call_id: "call_1", output: "file list" },
        { type: "function_call_output", call_id: "call_2", output: { content: "file content" } as any },
        { role: "developer", content: [{ type: "input_text", text: "be concise" }] },
        { role: "user", content: [{ type: "input_text", text: "now fix" }, { type: "input_image", detail: "low" } as any] },
      ],
      tools: [{ type: "function", name: "exec", description: "exec cmd", parameters: { type: "object" } }],
      max_output_tokens: 1000,
      stream: true,
      temperature: 0.5,
      previous_response_id: "resp_prev",
      reasoning: { effort: "high" } as any,
      extra_unknown: "ignore me" as any,
    });
    // messages: system inst, user, assistant with 2 tool_calls, tool1, tool2, system (developer), user
    expect(ir.messages[0]).toEqual({ role: "system", content: "You are helpful" });
    expect(ir.messages[1]).toEqual({ role: "user", content: "Fix bug" });
    expect(ir.messages[2]!.role).toBe("assistant");
    expect(ir.messages[2]!.content).toBe("Checking");
    expect(ir.messages[2]!.tool_calls!.length).toBe(2);
    expect(ir.messages[2]!.tool_calls![1]!.function.arguments).toBe(JSON.stringify({ path: "/tmp/foo" }));
    expect(ir.messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "file list" });
    expect(ir.messages[4]!.content).toBe(JSON.stringify({ content: "file content" }));
    expect(ir.messages[5]).toEqual({ role: "system", content: "be concise" });
    expect(ir.messages[6]).toEqual({ role: "user", content: "now fix" });
    expect(ir.max_tokens).toBe(1000);
    expect(ir.stream).toBe(true);
    expect(ir.temperature).toBe(0.5);
    expect(ir.tools).toBeDefined();
  });

  // stringifyOutput helper
  it("stringifyOutput stringifies object and keeps string", () => {
    expect(stringifyOutput("hello")).toBe("hello");
    expect(stringifyOutput({ a: 1 })).toBe(JSON.stringify({ a: 1 }));
    expect(stringifyOutput(null)).toBe("");
    expect(stringifyOutput(undefined)).toBe("");
    expect(stringifyOutput(123 as any)).toBe("123");
  });

  it("removes undefined keys before IR validation (no spurious errors)", () => {
    const ir = parseResponsesRequest(base({ input: "hi", temperature: undefined as any, top_p: undefined as any }));
    expect(ir.temperature).toBeUndefined();
    expect(ir.top_p).toBeUndefined();
  });

  it("handles input array with only function_calls (creates assistant with empty content)", () => {
    const ir = parseResponsesRequest(base({ input: [{ type: "function_call", call_id: "c1", name: "foo", arguments: "{}" }] }));
    expect(ir.messages[0]!.role).toBe("assistant");
    expect(ir.messages[0]!.content).toBe("");
    expect(ir.messages[0]!.tool_calls!.length).toBe(1);
  });

  it("developer role in input array with content array is converted to system", () => {
    const ir = parseResponsesRequest(
      base({
        input: [{ role: "developer", content: [{ type: "text", text: "dev text" }] }],
      }),
    );
    expect(ir.messages[0]!.role).toBe("system");
    expect(ir.messages[0]!.content).toBe("dev text");
  });
});

describe("stringifyOutput", () => {
  it("returns string as-is", () => {
    expect(stringifyOutput("test")).toBe("test");
    expect(stringifyOutput("")).toBe("");
  });
  it("JSON.stringify for objects and arrays", () => {
    expect(stringifyOutput({ key: "val" })).toBe('{"key":"val"}');
    expect(stringifyOutput([1, 2, 3])).toBe("[1,2,3]");
  });
  it("handles null/undefined as empty string", () => {
    expect(stringifyOutput(null as any)).toBe("");
    expect(stringifyOutput(undefined as any)).toBe("");
  });
});
