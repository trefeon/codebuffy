import type { UpstreamChunk } from "../../upstream/types";

export function mapFinishReason(openai: string | null | undefined): string {
  if (openai === "tool_calls") return "tool_use";
  if (openai === "length") return "max_tokens";
  if (openai === "stop" || openai === null || openai === undefined) return "end_turn";
  if (openai === "content_filter") return "end_turn";
  return "end_turn";
}

/**
 * Build Anthropic non-streaming message from aggregated OpenAI-shaped result.
 * Aggregated shape is as produced by src/adapters/openai-chat/aggregator.ts:
 * {content, tool_calls?, finish_reason, usage?}
 */
export function buildAnthropicResponse(
  aggregated: { content: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>; finish_reason: string | null; usage?: unknown },
  opts: { id: string; model: string },
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];

  if (aggregated.content) {
    content.push({ type: "text", text: aggregated.content });
  }

  if (aggregated.tool_calls) {
    for (const tc of aggregated.tool_calls) {
      let input: unknown;
      try {
        input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        // Fallback when arguments is not valid JSON (partial or malformed)
        input = { raw: tc.function.arguments };
      }
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }
  }

  // Anthropic requires at least one content block
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  const stopReason = mapFinishReason(aggregated.finish_reason);

  // Usage mapping: OpenAI {prompt_tokens, completion_tokens} -> Anthropic {input_tokens, output_tokens}
  let usage: { input_tokens: number; output_tokens: number } = { input_tokens: 0, output_tokens: 0 };
  if (aggregated.usage && typeof aggregated.usage === "object") {
    const u = aggregated.usage as Record<string, unknown>;
    const prompt = typeof u.prompt_tokens === "number" ? u.prompt_tokens : typeof u.input_tokens === "number" ? u.input_tokens : 0;
    const completion = typeof u.completion_tokens === "number" ? u.completion_tokens : typeof u.output_tokens === "number" ? u.output_tokens : 0;
    usage = { input_tokens: prompt, output_tokens: completion };
  }

  return {
    id: opts.id,
    type: "message",
    role: "assistant",
    content,
    model: opts.model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

export function formatAnthropicSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function* anthropicSSEFromUpstream(
  chunks: AsyncIterable<UpstreamChunk>,
  opts: { id: string; model: string },
): AsyncIterable<string> {
  let messageStarted = false;
  let textBlockStarted = false;
  const toolIndexMap = new Map<number, number>();
  const toolBlocksStarted = new Set<number>();
  const toolState = new Map<number, { id: string; name: string }>();
  const openBlocks: number[] = [];
  let nextToolAnthropicIndex = 1;
  let syntheticCounter = 100000;
  let finishReason: string | null | undefined = undefined;
  let finalUsage: unknown = undefined;
  let closed = false;

  function extractOutputTokens(u: unknown): number {
    if (!u || typeof u !== "object") return 0;
    const rec = u as Record<string, unknown>;
    if (typeof rec.output_tokens === "number") return rec.output_tokens;
    if (typeof rec.completion_tokens === "number") return rec.completion_tokens;
    return 0;
  }

  function ensureMessageStart(): string | null {
    if (!messageStarted) {
      messageStarted = true;
      return formatAnthropicSSE("message_start", {
        type: "message_start",
        message: {
          id: opts.id,
          type: "message",
          role: "assistant",
          content: [],
          model: opts.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }
    return null;
  }

  function* emitClose(): Generator<string> {
    if (closed) return;
    closed = true;
    const start = ensureMessageStart();
    if (start) yield start;
    // Emit stops in ascending index order for monotonic consistency
    const sorted = [...openBlocks].sort((a, b) => a - b);
    for (const idx of sorted) {
      yield formatAnthropicSSE("content_block_stop", {
        type: "content_block_stop",
        index: idx,
      });
    }
    openBlocks.length = 0;

    const stopReason = mapFinishReason(finishReason ?? null);
    const outputTokens = extractOutputTokens(finalUsage);
    yield formatAnthropicSSE("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    });
    yield formatAnthropicSSE("message_stop", {
      type: "message_stop",
    });
  }

  try {
    for await (const chunk of chunks) {
      if (!chunk || typeof chunk !== "object") {
        continue;
      }

      if ("usage" in chunk && (chunk as Record<string, unknown>).usage !== undefined) {
        finalUsage = (chunk as Record<string, unknown>).usage;
      }

      const rawChoices = (chunk as Record<string, unknown>).choices;
      const choices = Array.isArray(rawChoices) ? rawChoices : undefined;
      const choiceRaw = choices && choices.length > 0 ? choices[0] : undefined;
      const choice = choiceRaw && typeof choiceRaw === "object" ? (choiceRaw as Record<string, unknown>) : undefined;

      if (choice && choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (typeof choice.finish_reason === "string") {
          finishReason = choice.finish_reason;
        } else {
          finishReason = String(choice.finish_reason);
        }
      }

      const deltaRaw = choice ? (choice as Record<string, unknown>).delta : undefined;
      const delta = deltaRaw && typeof deltaRaw === "object" ? (deltaRaw as Record<string, unknown>) : undefined;

      if (delta) {
        const contentVal = delta.content;
        if (typeof contentVal === "string" && contentVal.length > 0) {
          const start = ensureMessageStart();
          if (start) yield start;
          if (!textBlockStarted) {
            textBlockStarted = true;
            openBlocks.push(0);
            yield formatAnthropicSSE("content_block_start", {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            });
          }
          yield formatAnthropicSSE("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: contentVal },
          });
        }

        const toolCallsRaw = (delta as Record<string, unknown>).tool_calls;
        if (Array.isArray(toolCallsRaw)) {
          for (const rawTc of toolCallsRaw) {
            if (!rawTc || typeof rawTc !== "object") continue;
            const tc = rawTc as Record<string, unknown>;

            let upstreamIdx: number;
            if (typeof tc.index === "number" && Number.isInteger(tc.index) && tc.index >= 0) {
              upstreamIdx = tc.index;
            } else {
              upstreamIdx = syntheticCounter++;
            }

            let anthropicIdx = toolIndexMap.get(upstreamIdx);
            if (anthropicIdx === undefined) {
              anthropicIdx = nextToolAnthropicIndex++;
              toolIndexMap.set(upstreamIdx, anthropicIdx);
            }

            let state = toolState.get(anthropicIdx);
            if (!state) {
              state = { id: "", name: "" };
              toolState.set(anthropicIdx, state);
            }
            if (typeof tc.id === "string" && tc.id) {
              state.id = tc.id;
            }
            const fnRaw = tc.function;
            if (fnRaw && typeof fnRaw === "object") {
              const fn = fnRaw as Record<string, unknown>;
              if (typeof fn.name === "string" && fn.name) {
                state.name = fn.name;
              }
            }

            if (!toolBlocksStarted.has(anthropicIdx)) {
              const start = ensureMessageStart();
              if (start) yield start;
              const toolId = state.id || `toolu_${upstreamIdx}`;
              const toolName = state.name || "";
              toolBlocksStarted.add(anthropicIdx);
              openBlocks.push(anthropicIdx);
              yield formatAnthropicSSE("content_block_start", {
                type: "content_block_start",
                index: anthropicIdx,
                content_block: { type: "tool_use", id: toolId, name: toolName, input: {} },
              });
            }

            const fn2 = tc.function as Record<string, unknown> | undefined;
            if (fn2 && typeof fn2.arguments === "string" && fn2.arguments.length > 0) {
              const s2 = ensureMessageStart();
              if (s2) {
                yield s2;
              }
              yield formatAnthropicSSE("content_block_delta", {
                type: "content_block_delta",
                index: anthropicIdx,
                delta: { type: "input_json_delta", partial_json: fn2.arguments },
              });
            }
          }
        }
      }

      const hasFinish = choice ? choice.finish_reason !== undefined && choice.finish_reason !== null : false;
      const hasUsage = "usage" in chunk && (chunk as Record<string, unknown>).usage !== undefined;
      if ((hasFinish || hasUsage) && !closed) {
        for (const f of emitClose()) {
          yield f;
        }
      }
    }
  } catch (e) {
    throw e;
  }

  if (!closed) {
    for (const f of emitClose()) {
      yield f;
    }
  }
}
