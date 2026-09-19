// G1 converter gaps: images end-to-end, thinking preserve/re-emit, tool_result.is_error.
import { describe, it, expect } from "bun:test";
import { parseAnthropicRequest } from "../src/adapters/anthropic/parser";
import { parseOpenAIChatRequest } from "../src/adapters/openai-chat/parser";
import { toUpstreamRequest } from "../src/ir/types";
import {
  buildAnthropicResponse,
  anthropicSSEFromUpstream,
} from "../src/adapters/anthropic/emitter";
import type { UpstreamChunk } from "../src/upstream/types";

function anthBody(messages: unknown[]): Record<string, unknown> {
  return { model: "claude-3-5-sonnet-20241022", max_tokens: 100, messages };
}

type JsonObj = Record<string, unknown>;

function asObj(v: unknown): JsonObj {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as JsonObj;
  throw new Error("expected object");
}
function upstreamMessages(ir: { messages: Array<{ role: string; content: unknown }> }): JsonObj[] {
  const raw: unknown = (ir as unknown as JsonObj).messages;
  if (!Array.isArray(raw)) throw new Error("upstream messages must be an array");
  return raw.map(asObj);
}

function sseText(events: Array<{ event: string; json: JsonObj }>): string {
  return events
    .filter((e) => asObj(e.json.delta ?? {}).type === "thinking_delta")
    .map((e) => String(asObj(e.json.delta).thinking ?? ""))
    .join("");
}

function parseSSEFrame(frame: string): { event: string; json: JsonObj } {
  const dataIdx = frame.indexOf("\ndata: ");
  const event = frame.slice("event: ".length, frame.indexOf("\n"));
  return { event, json: asObj(JSON.parse(frame.slice(dataIdx + "\ndata: ".length))) };
}

// ---------------------------------------------------------------------------
// (a) image blocks carried end-to-end
// ---------------------------------------------------------------------------

describe("G1(a) images end-to-end", () => {
  it("anthropic user image block is forwarded (not dropped)", () => {
    const ir = parseAnthropicRequest(
      anthBody([
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
          ],
        },
      ]),
    );
    expect(ir.messages[0]?.content).toBe("hi");
    expect(ir.messages[0]?.images).toEqual([
      { url: "data:image/png;base64,abc123", media_type: "image/png" },
    ]);
  });

  it("anthropic assistant image block is forwarded (not dropped)", () => {
    const ir = parseAnthropicRequest(
      anthBody([
        {
          role: "assistant",
          content: [
            { type: "text", text: "see" },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "zz" } },
          ],
        },
      ]),
    );
    expect(ir.messages[0]?.content).toBe("see");
    expect(ir.messages[0]?.images).toEqual([
      { url: "data:image/jpeg;base64,zz", media_type: "image/jpeg" },
    ]);
  });

  it("openai-chat image_url blocks are forwarded (not dropped)", () => {
    const ir = parseOpenAIChatRequest({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            {
              type: "image_url",
              image_url: { url: "https://example.com/img.png", detail: "high" },
            },
          ],
        },
      ],
    });
    expect(ir.messages[0]?.content).toBe("hi");
    expect(ir.messages[0]?.images).toEqual([
      { url: "https://example.com/img.png", detail: "high" },
    ]);
  });

  it("toUpstreamRequest serializes IR images as OpenAI image_url blocks", () => {
    const ir = parseAnthropicRequest(
      anthBody([
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
          ],
        },
      ]),
    );
    const out = toUpstreamRequest(ir);
    const userMsg = upstreamMessages(out).find((m) => m.role === "user");
    expect(userMsg?.content).toEqual([
      { type: "text", text: "hi" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
    ]);
  });

  it("image-only message serializes to image-only upstream content", () => {
    const ir = parseOpenAIChatRequest({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "sys" },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
        },
      ],
    });
    const out = toUpstreamRequest(ir);
    const userMsg = upstreamMessages(out).find((m) => m.role === "user");
    expect(userMsg?.content).toEqual([
      { type: "image_url", image_url: { url: "https://example.com/a.png" } },
    ]);
  });

  it("IR messages expose images for inspection", () => {
    const ir = parseOpenAIChatRequest({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
        },
      ],
    });
    expect(ir.messages[0]?.images).toEqual([{ url: "https://example.com/a.png" }]);
  });
});

// ---------------------------------------------------------------------------
// (b) thinking preserved in IR, re-emitted as Anthropic thinking blocks
// ---------------------------------------------------------------------------

describe("G1(b) thinking preserve + re-emit", () => {
  it("anthropic user thinking is preserved separately, not flattened into text", () => {
    const ir = parseAnthropicRequest(
      anthBody([
        {
          role: "user",
          content: [
            { type: "text", text: "a" },
            { type: "thinking", thinking: " think" },
          ],
        },
      ]),
    );
    expect(ir.messages[0]?.content).toBe("a");
    expect(ir.messages[0]?.thinking).toBe(" think");
  });

  it("anthropic assistant thinking is preserved separately, not flattened into text", () => {
    const ir = parseAnthropicRequest(
      anthBody([
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me think " },
            { type: "text", text: "answer" },
          ],
        },
      ]),
    );
    expect(ir.messages[0]?.content).toBe("answer");
    expect(ir.messages[0]?.thinking).toBe("let me think ");
  });

  it("redacted_thinking stays dropped (opaque provider block, cannot forward)", () => {
    const ir = parseAnthropicRequest(
      anthBody([
        {
          role: "assistant",
          content: [
            { type: "redacted_thinking", data: "xxx" },
            { type: "text", text: "hi" },
          ],
        },
      ]),
    );
    expect(ir.messages[0]?.content).toBe("hi");
    expect(ir.messages[0]?.thinking).toBeUndefined();
  });

  it("buildAnthropicResponse re-emits thinking as a leading thinking block", () => {
    const body = asObj(
      buildAnthropicResponse(
        { content: "answer", thinking: "let me think", finish_reason: "stop", usage: undefined },
        { id: "msg_x", model: "m" },
      ),
    );
    const content: unknown = body.content;
    if (!Array.isArray(content)) throw new Error("response content must be an array");
    expect(content[0]).toEqual({ type: "thinking", thinking: "let me think" });
    expect(content[1]).toEqual({ type: "text", text: "answer" });
  });

  it("SSE re-emits upstream reasoning deltas as thinking blocks (text shifts to index 1)", async () => {
    // UpstreamChunk.delta has no reasoning channel (upstream/types.ts is owned
    // by another lane), so the DeepSeek-style field is applied through a cast.
    type Delta = UpstreamChunk["choices"][number]["delta"];
    const reasoningDelta = (reasoning_content: string): Delta => ({ reasoning_content }) as Delta;
    const chunks: UpstreamChunk[] = [
      { id: "c1", choices: [{ delta: reasoningDelta("let me"), finish_reason: null }] },
      { id: "c1", choices: [{ delta: reasoningDelta(" think"), finish_reason: null }] },
      { id: "c1", choices: [{ delta: { content: "answer" }, finish_reason: null }] },
      { id: "c1", choices: [{ delta: {}, finish_reason: "stop" }] },
    ];
    async function* src(): AsyncIterable<UpstreamChunk> {
      for (const c of chunks) yield c;
    }
    const frames: string[] = [];
    for await (const f of anthropicSSEFromUpstream(src(), { id: "msg_x", model: "m" })) {
      frames.push(f);
    }
    const events = frames.map(parseSSEFrame);
    const starts = events.filter((e) => e.json.type === "content_block_start");
    expect(asObj(starts[0]?.json.content_block).type).toBe("thinking");
    expect(starts[0]?.json.index).toBe(0);
    expect(asObj(starts[1]?.json.content_block).type).toBe("text");
    expect(starts[1]?.json.index).toBe(1);
    expect(sseText(events)).toBe("let me think");
  });
});

// ---------------------------------------------------------------------------
// (c) tool_result.is_error flag
// ---------------------------------------------------------------------------

describe("G1(c) tool_result.is_error", () => {
  it("is_error:true is preserved on the IR tool message; false/absent stays absent", () => {
    const ir = parseAnthropicRequest(
      anthBody([
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "oops", is_error: true },
            { type: "tool_result", tool_use_id: "toolu_2", content: "ok", is_error: false },
            { type: "tool_result", tool_use_id: "toolu_3", content: "fine" },
          ],
        },
      ]),
    );
    const tools = ir.messages.filter((m) => m.role === "tool");
    expect(tools[0]).toEqual({
      role: "tool",
      content: "oops",
      tool_call_id: "toolu_1",
      is_error: true,
    });
    expect(tools[1]).toEqual({ role: "tool", content: "ok", tool_call_id: "toolu_2" });
    expect(tools[2]).toEqual({ role: "tool", content: "fine", tool_call_id: "toolu_3" });
  });

  it("toUpstreamRequest propagates is_error onto the upstream tool message", () => {
    const ir = parseAnthropicRequest(
      anthBody([
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "oops", is_error: true },
          ],
        },
      ]),
    );
    const out = toUpstreamRequest(ir);
    const toolMsg = upstreamMessages(out).find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe("oops");
    expect(toolMsg?.tool_call_id).toBe("toolu_1");
    expect(toolMsg?.is_error).toBe(true);
  });
});
