import { describe, it, expect } from "bun:test";
import {
  mapResponsesFinishReason,
  buildResponsesResponse,
  formatResponsesSSE,
  responsesSSEFromUpstream,
} from "../src/adapters/responses/emitter";
import type { UpstreamChunk } from "../src/upstream/types";

// helper to make async iterable
async function* makeChunks(arr: UpstreamChunk[]): AsyncIterable<UpstreamChunk> {
  for (const c of arr) yield c;
}
async function collectSSE(
  chunks: UpstreamChunk[],
  opts: { id: string; model: string; created: number },
): Promise<Array<{ raw: string; json: Record<string, unknown> }>> {
  const out: Array<{ raw: string; json: Record<string, unknown> }> = [];
  for await (const s of responsesSSEFromUpstream(makeChunks(chunks), opts)) {
    // each s is "data: {...}\n\n"
    const trimmed = s.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") {
      out.push({ raw: s, json: { __done: true } as unknown as Record<string, unknown> });
      continue;
    }
    const json = JSON.parse(payload) as Record<string, unknown>;
    out.push({ raw: s, json });
  }
  return out;
}

// ---------------------------------------------------------------------------
// mapResponsesFinishReason
// ---------------------------------------------------------------------------
describe("mapResponsesFinishReason", () => {
  it("tool_calls -> function_call", () => {
    expect(mapResponsesFinishReason("tool_calls")).toBe("function_call");
  });
  it("length -> max_output_tokens", () => {
    expect(mapResponsesFinishReason("length")).toBe("max_output_tokens");
  });
  it("stop -> completed", () => {
    expect(mapResponsesFinishReason("stop")).toBe("completed");
  });
  it("content_filter -> content_filter", () => {
    expect(mapResponsesFinishReason("content_filter")).toBe("content_filter");
  });
  it("null -> completed", () => {
    expect(mapResponsesFinishReason(null)).toBe("completed");
  });
  it("undefined -> completed", () => {
    expect(mapResponsesFinishReason(undefined)).toBe("completed");
  });
  it("unknown -> completed (fallback)", () => {
    expect(mapResponsesFinishReason("unknown_reason")).toBe("completed");
    expect(mapResponsesFinishReason("")).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// formatResponsesSSE
// ---------------------------------------------------------------------------
describe("formatResponsesSSE", () => {
  it("formats exactly as data: JSON + double newline", () => {
    const data = { type: "response.created", response: { id: "resp_123" } };
    expect(formatResponsesSSE(data)).toBe(`data: ${JSON.stringify(data)}\n\n`);
  });
  it("handles empty object", () => {
    expect(formatResponsesSSE({})).toBe(`data: ${JSON.stringify({})}\n\n`);
  });
  it("JSON omits undefined fields", () => {
    const data = { type: "x", a: undefined, b: 1 } as Record<string, unknown>;
    const out = formatResponsesSSE(data);
    expect(out).toBe(`data: ${JSON.stringify(data)}\n\n`);
    const parsed = JSON.parse(out.slice(6).trim());
    expect(parsed.a).toBeUndefined();
    expect(parsed.b).toBe(1);
  });
  it("preserves unicode without escaping", () => {
    const data = { delta: "Hello 🌍 你好" };
    const out = formatResponsesSSE(data);
    expect(out).toBe(`data: ${JSON.stringify(data)}\n\n`);
    expect(JSON.parse(out.slice(6).trim()).delta).toBe("Hello 🌍 你好");
  });
});

// ---------------------------------------------------------------------------
// buildResponsesResponse
// ---------------------------------------------------------------------------
describe("buildResponsesResponse", () => {
  const opts = { id: "resp_abc", model: "m-test", created: 1234567890 };

  it("builds response with text only", () => {
    const agg = { content: "Hello world", tool_calls: undefined, finish_reason: "stop" as const, usage: undefined };
    const res = buildResponsesResponse(agg, opts);
    expect(res.id).toBe(opts.id);
    expect(res.object).toBe("response");
    expect(res.created_at).toBe(opts.created);
    expect(res.model).toBe(opts.model);
    expect(res.status).toBe("completed");
    const output = res.output as Array<Record<string, unknown>>;
    expect(output.length).toBe(1);
    expect(output[0]!.type).toBe("message");
    const content = (output[0]!.content as Array<Record<string, unknown>>)[0]!;
    expect(content.type).toBe("output_text");
    expect(content.text).toBe("Hello world");
    expect(res.usage).toBeUndefined();
  });

  it("builds response with text + tools + usage", () => {
    const agg = {
      content: "call it",
      tool_calls: [
        { id: "call_1", type: "function" as const, function: { name: "exec_command", arguments: '{"cmd":"ls"}' } },
        { id: "call_2", type: "function" as const, function: { name: "write_stdin", arguments: '{"text":"hi"}' } },
      ],
      finish_reason: "tool_calls" as const,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const res = buildResponsesResponse(agg, opts);
    const output = res.output as Array<Record<string, unknown>>;
    expect(output.length).toBe(3);
    expect(output[0]!.type).toBe("message");
    expect((output[1]! as Record<string, unknown>).type).toBe("function_call");
    expect((output[1]! as Record<string, unknown>).call_id).toBe("call_1");
    expect((output[1]! as Record<string, unknown>).name).toBe("exec_command");
    expect((output[2]! as Record<string, unknown>).call_id).toBe("call_2");
    const usage = res.usage as Record<string, unknown>;
    expect(usage.input_tokens).toBe(10);
    expect(usage.output_tokens).toBe(5);
    expect(usage.total_tokens).toBe(15);
  });

  it("maps prompt_tokens->input_tokens and completion_tokens->output_tokens", () => {
    const agg = {
      content: "hi",
      finish_reason: "stop" as const,
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    };
    const res = buildResponsesResponse(agg, opts);
    const u = res.usage as Record<string, unknown>;
    expect(u.input_tokens).toBe(7);
    expect(u.output_tokens).toBe(3);
    expect(u.total_tokens).toBe(10);
  });

  it("also maps input_tokens/output_tokens passthrough", () => {
    const agg = {
      content: "hi",
      finish_reason: null,
      usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 },
    };
    const res = buildResponsesResponse(agg, opts);
    const u = res.usage as Record<string, unknown>;
    expect(u.input_tokens).toBe(4);
    expect(u.output_tokens).toBe(6);
  });

  it("handles empty content with no tools (still emits empty message)", () => {
    const agg = { content: "", finish_reason: null, usage: undefined };
    const res = buildResponsesResponse(agg, opts);
    const output = res.output as Array<Record<string, unknown>>;
    expect(output.length).toBe(1);
    expect(output[0]!.type).toBe("message");
    const txt = ((output[0]!.content as Array<Record<string, unknown>>)[0] as Record<string, unknown>).text;
    expect(txt).toBe("");
  });

  it("handles tool-only with empty content (no empty message)", () => {
    const agg = {
      content: "",
      tool_calls: [{ id: "call_x", type: "function" as const, function: { name: "get_goal", arguments: "{}" } }],
      finish_reason: "tool_calls" as const,
      usage: undefined,
    };
    const res = buildResponsesResponse(agg, opts);
    const output = res.output as Array<Record<string, unknown>>;
    // when tool-only, we still may have only tools; our implementation pushes no empty message
    expect(output.length).toBe(1);
    expect(output[0]!.type).toBe("function_call");
    expect((output[0] as Record<string, unknown>).call_id).toBe("call_x");
  });
});

// ---------------------------------------------------------------------------
// responsesSSEFromUpstream - SSE sequences
// ---------------------------------------------------------------------------
describe("responsesSSEFromUpstream", () => {
  const baseOpts = { id: "resp_123", model: "test-model", created: 1700000000 };

  it("single text sequence emits correct order", async () => {
    const chunks: UpstreamChunk[] = [
      { id: "chatcmpl-1", choices: [{ delta: { content: "Hello" }, finish_reason: null, index: 0 }] },
      { id: "chatcmpl-1", choices: [{ delta: { content: " world" }, finish_reason: null, index: 0 }] },
      { id: "chatcmpl-1", choices: [{ delta: {}, finish_reason: "stop", index: 0 }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    ];
    const events = await collectSSE(chunks, baseOpts);
    const types = events.map((e) => e.json.type as string);
    expect(types[0]).toBe("response.created");
    expect(types[1]).toBe("response.in_progress");
    expect(types).toContain("response.output_item.added");
    expect(types).toContain("response.content_part.added");
    expect(types.filter((t) => t === "response.output_text.delta").length).toBe(2);
    expect(types).toContain("response.output_text.done");
    expect(types).toContain("response.content_part.done");
    expect(types).toContain("response.output_item.done");
    expect(types[types.length - 1]).toBe("response.completed");

    // verify output_index for message is 0
    const added = events.find((e) => e.json.type === "response.output_item.added")!;
    expect(added.json.output_index).toBe(0);
    expect((added.json.item as Record<string, unknown>).type).toBe("message");

    const deltas = events.filter((e) => e.json.type === "response.output_text.delta");
    expect(deltas[0]!.json.delta).toBe("Hello");
    expect(deltas[1]!.json.delta).toBe(" world");
    expect(deltas[0]!.json.output_index).toBe(0);

    // verify completed payload has usage mapped
    const completed = events.find((e) => e.json.type === "response.completed")!;
    const resp = completed.json.response as Record<string, unknown>;
    const usage = resp.usage as Record<string, unknown> | undefined;
    expect(usage).toBeDefined();
    expect(usage!.input_tokens).toBe(5);
    expect(usage!.output_tokens).toBe(2);
  });

  it("tool before text has monotonic outputIndex no collision", async () => {
    const chunks: UpstreamChunk[] = [
      {
        id: "c1",
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "exec_command", arguments: '{"cmd":"ls"}' } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "c1",
        choices: [{ delta: { content: "hello" }, finish_reason: null }],
      },
      {
        id: "c1",
        choices: [{ delta: {}, finish_reason: "stop" }],
      },
    ];
    const events = await collectSSE(chunks, baseOpts);
    const addeds = events.filter((e) => e.json.type === "response.output_item.added");
    // should be 2 added: one for tool, one for message
    expect(addeds.length).toBe(2);
    const toolAdded = addeds.find((e) => (e.json.item as Record<string, unknown>).type === "function_call")!;
    const msgAdded = addeds.find((e) => (e.json.item as Record<string, unknown>).type === "message")!;
    // message must be 0, tool must not be 0 (collision fix)
    expect(msgAdded.json.output_index).toBe(0);
    expect(toolAdded.json.output_index).not.toBe(0);
    expect(toolAdded.json.output_index).toBe(1);
    // ensure indices are monotonic unique
    const indices = addeds.map((e) => e.json.output_index as number);
    expect(new Set(indices).size).toBe(indices.length);
    // deltas should map to correct indices
    const textDelta = events.find((e) => e.json.type === "response.output_text.delta")!;
    expect(textDelta.json.output_index).toBe(0);
    const toolDelta = events.find((e) => e.json.type === "response.function_call_arguments.delta")!;
    expect(toolDelta.json.output_index).toBe(1);
    expect(toolDelta.json.delta).toBe('{"cmd":"ls"}');
  });

  it("multiple tools get sequential monotonic indices", async () => {
    const chunks: UpstreamChunk[] = [
      {
        id: "c1",
        choices: [
          {
            delta: {
              content: "start",
              tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "exec_command", arguments: '{"a":1}' } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "c1",
        choices: [
          {
            delta: {
              tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "write_stdin", arguments: '{"b":2}' } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "c1",
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      },
    ];
    const events = await collectSSE(chunks, baseOpts);
    const toolAddeds = events
      .filter((e) => e.json.type === "response.output_item.added" && (e.json.item as Record<string, unknown>).type === "function_call")
      .sort((a, b) => (a.json.output_index as number) - (b.json.output_index as number));
    expect(toolAddeds.length).toBe(2);
    expect(toolAddeds[0]!.json.output_index).toBe(1);
    expect(toolAddeds[1]!.json.output_index).toBe(2);
    // message should still be 0
    const msgAdded = events.find((e) => e.json.type === "response.output_item.added" && (e.json.item as Record<string, unknown>).type === "message")!;
    expect(msgAdded.json.output_index).toBe(0);
    // verify tool deltas map correctly
    const toolDeltas = events.filter((e) => e.json.type === "response.function_call_arguments.delta").sort((a, b) => (a.json.output_index as number) - (b.json.output_index as number));
    expect(toolDeltas.length).toBe(2);
    expect(toolDeltas[0]!.json.output_index).toBe(1);
    expect(toolDeltas[1]!.json.output_index).toBe(2);
    expect(toolDeltas[0]!.json.delta).toBe('{"a":1}');
    expect(toolDeltas[1]!.json.delta).toBe('{"b":2}');
  });

  it("handles empty stream - still emits created/in_progress/completed with no items", async () => {
    const chunks: UpstreamChunk[] = [];
    const events = await collectSSE(chunks, baseOpts);
    const types = events.map((e) => e.json.type as string);
    expect(types).toContain("response.created");
    expect(types).toContain("response.in_progress");
    expect(types).toContain("response.completed");
    expect(types.filter((t) => t === "response.output_item.added").length).toBe(0);
    const completed = events.find((e) => e.json.type === "response.completed")!;
    expect((completed.json.response as Record<string, unknown>).id).toBe(baseOpts.id);
  });

  it("forwards usage to completed event", async () => {
    const chunks: UpstreamChunk[] = [
      { id: "c1", choices: [{ delta: { content: "hi" }, finish_reason: null }] },
      { id: "c1", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } },
    ];
    const events = await collectSSE(chunks, baseOpts);
    const completed = events.find((e) => e.json.type === "response.completed")!;
    const usage = (completed.json.response as Record<string, unknown>).usage as Record<string, unknown>;
    expect(usage.input_tokens).toBe(12);
    expect(usage.output_tokens).toBe(8);
    expect(usage.total_tokens).toBe(20);
  });

  it("maps usage with input_tokens/output_tokens passthrough variant", async () => {
    const chunks: UpstreamChunk[] = [
      { id: "c1", choices: [{ delta: { content: "hi" }, finish_reason: null }] },
      { id: "c1", choices: [{ delta: {}, finish_reason: "stop" }], usage: { input_tokens: 3, output_tokens: 9, total_tokens: 12 } as unknown },
    ];
    const events = await collectSSE(chunks, baseOpts);
    const completed = events.find((e) => e.json.type === "response.completed")!;
    const usage = (completed.json.response as Record<string, unknown>).usage as Record<string, unknown>;
    expect(usage.input_tokens).toBe(3);
    expect(usage.output_tokens).toBe(9);
  });

  it("emits created/in_progress immediately before first delta even with tool first", async () => {
    const chunks: UpstreamChunk[] = [
      {
        id: "c1",
        choices: [{ delta: { tool_calls: [{ index: 0, id: "call_z", type: "function", function: { name: "get_goal", arguments: "" } }] }, finish_reason: null }],
      },
    ];
    const events = await collectSSE(chunks, baseOpts);
    expect(events[0]!.json.type).toBe("response.created");
    expect(events[1]!.json.type).toBe("response.in_progress");
    expect(events[2]!.json.type).toBe("response.output_item.added");
    expect((events[2]!.json.item as Record<string, unknown>).type).toBe("function_call");
  });

  it("interleaved multiple deltas for same tool aggregates correctly", async () => {
    const chunks: UpstreamChunk[] = [
      { id: "c1", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "exec_command", arguments: '{"cmd":' } }] }, finish_reason: null }] },
      { id: "c1", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, finish_reason: null }] },
      { id: "c1", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    const events = await collectSSE(chunks, baseOpts);
    const deltas = events.filter((e) => e.json.type === "response.function_call_arguments.delta");
    expect(deltas.length).toBe(2);
    expect(deltas[0]!.json.delta).toBe('{"cmd":');
    expect(deltas[1]!.json.delta).toBe('"ls"}');
    const done = events.find((e) => e.json.type === "response.function_call_arguments.done" && (e.json.output_index as number) === 1)!;
    expect(done.json.arguments).toBe('{"cmd":"ls"}');
  });

  it("tool args delta uses monotonic index even with missing index field (synthetic)", async () => {
    const chunks: UpstreamChunk[] = [
      { id: "c1", choices: [{ delta: { tool_calls: [{ id: "call_synth", type: "function", function: { name: "view_image", arguments: "{}" } }] }, finish_reason: null }] },
      { id: "c1", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    const events = await collectSSE(chunks, baseOpts);
    const added = events.find((e) => e.json.type === "response.output_item.added" && (e.json.item as Record<string, unknown>).type === "function_call")!;
    expect(added.json.output_index).toBe(1);
  });
});
