import type { UpstreamChunk } from "../../upstream/types";

/**
 * Map OpenAI finish_reason to Responses status/reason.
 * - tool_calls -> function_call
 * - length -> max_output_tokens
 * - stop -> completed
 * - content_filter -> content_filter
 * - null/undefined/unknown -> completed
 */
export function mapResponsesFinishReason(openai: string | null | undefined): string {
  if (openai === "tool_calls") return "function_call";
  if (openai === "length") return "max_output_tokens";
  if (openai === "stop") return "completed";
  if (openai === "content_filter") return "content_filter";
  return "completed";
}

/**
 * Build Responses non-stream JSON shape from aggregated upstream result.
 * aggregated shape is as produced by src/adapters/openai-chat/aggregator.ts:
 * {content, tool_calls?, finish_reason, usage?}
 */
export function buildResponsesResponse(
  aggregated: {
    content: string;
    tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    finish_reason: string | null;
    usage?: unknown;
  },
  opts: { id: string; model: string; created: number },
): Record<string, unknown> {
  const output: Array<Record<string, unknown>> = [];

  // Always include message if there is content or if there are no tool calls
  // For tool-only with content "", still include message? Spec says output is message + function_call per tool.
  // We'll include message when content length > 0 or when no tools present (to guarantee at least one output item).
  // When content is present (even empty string with tools), we follow spec: include message if content length > 0 OR if no tools.
  // But to match spec "output is array of {type:message ...} plus for each tool_call", we include message when content !== "" or when no tools.
  // For deterministic behavior: if content and content.length > 0 -> push message, else if no tool_calls -> push empty message.
  // If content is "" and tools exist -> do NOT push empty message (only tools). This avoids duplicate empty message when tool-only.
  if (aggregated.content && aggregated.content.length > 0) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: aggregated.content }],
    });
  } else if (!aggregated.tool_calls || aggregated.tool_calls.length === 0) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: aggregated.content ?? "" }],
    });
  }

  if (aggregated.tool_calls) {
    for (const tc of aggregated.tool_calls) {
      output.push({
        type: "function_call",
        id: tc.id,
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      });
    }
  }

  const usage = mapUsage(aggregated.usage);

  const response: Record<string, unknown> = {
    id: opts.id,
    object: "response",
    created_at: opts.created,
    model: opts.model,
    status: "completed",
    output,
  };
  if (usage) response.usage = usage;
  return response;
}

export function formatResponsesSSE(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function mapUsage(u: unknown): Record<string, unknown> | undefined {
  if (!u || typeof u !== "object") return undefined;
  const rec = u as Record<string, unknown>;
  const input =
    typeof rec.prompt_tokens === "number"
      ? rec.prompt_tokens
      : typeof rec.input_tokens === "number"
        ? rec.input_tokens
        : undefined;
  const output =
    typeof rec.completion_tokens === "number"
      ? rec.completion_tokens
      : typeof rec.output_tokens === "number"
        ? rec.output_tokens
        : undefined;
  const total = typeof rec.total_tokens === "number" ? rec.total_tokens : undefined;
  if (input === undefined && output === undefined && total === undefined) return undefined;
  return {
    input_tokens: input ?? 0,
    output_tokens: output ?? 0,
    total_tokens: total ?? ((input ?? 0) + (output ?? 0)),
  };
}

export async function* responsesSSEFromUpstream(
  chunks: AsyncIterable<UpstreamChunk>,
  opts: { id: string; model: string; created: number },
): AsyncIterable<string> {
  let accumulatedContent = "";
  let finalUsage: unknown = undefined;
  let finishReason: string | null | undefined = undefined;

  const toolIndexMap = new Map<number, number>(); // upstream index -> output_index
  const toolState = new Map<number, { id: string; name: string; arguments: string }>();
  const emittedToolIndices = new Set<number>();
  let nextOutputIndex = 1; // 0 reserved for message
  let messageItemSent = false;
  let emittedCreated = false;
  let syntheticCounter = 100000;
  let closed = false;

  const ensureCreated = function* (): Generator<string> {
    if (!emittedCreated) {
      emittedCreated = true;
      yield formatResponsesSSE({
        type: "response.created",
        response: {
          id: opts.id,
          object: "response",
          created_at: opts.created,
          model: opts.model,
          status: "in_progress",
        },
      });
      yield formatResponsesSSE({
        type: "response.in_progress",
        response: {
          id: opts.id,
          status: "in_progress",
        },
      });
    }
  };

  try {
    for await (const chunk of chunks) {
      if (!chunk || typeof chunk !== "object") continue;

      if ("usage" in chunk && (chunk as Record<string, unknown>).usage !== undefined) {
        finalUsage = (chunk as Record<string, unknown>).usage;
      }

      const rawChoices = (chunk as Record<string, unknown>).choices;
      const choices = Array.isArray(rawChoices) ? rawChoices : undefined;
      const choiceRaw = choices && choices.length > 0 ? choices[0] : undefined;
      const choice =
        choiceRaw && typeof choiceRaw === "object"
          ? (choiceRaw as Record<string, unknown>)
          : undefined;

      if (choice && choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (typeof choice.finish_reason === "string") {
          finishReason = choice.finish_reason as string;
        } else {
          finishReason = String(choice.finish_reason);
        }
        void finishReason; // mapped but status stays completed; keep for potential future
      }

      const deltaRaw = choice ? (choice as Record<string, unknown>).delta : undefined;
      const delta =
        deltaRaw && typeof deltaRaw === "object"
          ? (deltaRaw as Record<string, unknown>)
          : undefined;

      if (!delta) continue;

      const contentVal = delta.content;
      if (typeof contentVal === "string" && contentVal.length > 0) {
        for (const s of ensureCreated()) yield s;
        if (!messageItemSent) {
          messageItemSent = true;
          yield formatResponsesSSE({
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "message", role: "assistant", content: [] },
          });
          yield formatResponsesSSE({
            type: "response.content_part.added",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "" },
          });
        }
        accumulatedContent += contentVal;
        yield formatResponsesSSE({
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: contentVal,
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

          let assigned = toolIndexMap.get(upstreamIdx);
          const isNewMapping = assigned === undefined;
          if (isNewMapping) {
            assigned = nextOutputIndex++;
            toolIndexMap.set(upstreamIdx, assigned);
          }
          const outputIdx = assigned as number;

          let state = toolState.get(outputIdx);
          if (!state) {
            state = { id: "", name: "", arguments: "" };
            toolState.set(outputIdx, state);
          }

          if (typeof tc.id === "string" && tc.id) {
            state.id = tc.id;
          }
          const fnRaw = tc.function as Record<string, unknown> | undefined;
          let deltaArgs: string | undefined;
          if (fnRaw && typeof fnRaw === "object") {
            if (typeof fnRaw.name === "string" && fnRaw.name) {
              state.name = fnRaw.name;
            }
            if (typeof fnRaw.arguments === "string" && fnRaw.arguments.length > 0) {
              deltaArgs = fnRaw.arguments;
              state.arguments += fnRaw.arguments;
            }
          }

          const isFirstEmit = !emittedToolIndices.has(outputIdx);
          if (isFirstEmit) {
            for (const s of ensureCreated()) yield s;
            // generate deterministic toolId with fc_ prefix if needed
            const rawId = state.id || `call_${upstreamIdx}`;
            const toolId = rawId.startsWith("fc_") ? rawId : `fc_${rawId}`;
            yield formatResponsesSSE({
              type: "response.output_item.added",
              output_index: outputIdx,
              item: {
                type: "function_call",
                id: toolId,
                call_id: toolId,
                name: state.name,
                arguments: "",
              },
            });
            emittedToolIndices.add(outputIdx);
          }

          if (deltaArgs !== undefined) {
            // Ensure created already handled, but double-check
            if (!emittedCreated) {
              for (const s of ensureCreated()) yield s;
            }
            yield formatResponsesSSE({
              type: "response.function_call_arguments.delta",
              output_index: outputIdx,
              delta: deltaArgs,
            });
          }
        }
      }
    }
  } catch (e) {
    throw e;
  }

  if (!closed) {
    closed = true;
    for (const s of ensureCreated()) yield s;

    if (messageItemSent) {
      yield formatResponsesSSE({
        type: "response.output_text.done",
        output_index: 0,
        content_index: 0,
        text: accumulatedContent,
      });
      yield formatResponsesSSE({
        type: "response.content_part.done",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: accumulatedContent, annotations: [] },
      });
      yield formatResponsesSSE({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: accumulatedContent, annotations: [] }],
          status: "completed",
        },
      });
    }

    const sortedAssigned = [...toolIndexMap.values()].sort((a, b) => a - b);
    for (const assigned of sortedAssigned) {
      if (!emittedToolIndices.has(assigned)) continue;
      const state = toolState.get(assigned);
      const args = state?.arguments ?? "";
      yield formatResponsesSSE({
        type: "response.function_call_arguments.done",
        output_index: assigned,
        arguments: args,
      });
      const rawId = state?.id || `call_${assigned}`;
      const toolId = rawId.startsWith("fc_") ? rawId : `fc_${rawId}`;
      yield formatResponsesSSE({
        type: "response.output_item.done",
        output_index: assigned,
        item: {
          type: "function_call",
          id: toolId,
          call_id: toolId,
          name: state?.name ?? "",
          arguments: args,
          status: "completed",
        },
      });
    }

    const usageMapped = mapUsage(finalUsage);
    const completedPayload: Record<string, unknown> = {
      type: "response.completed",
      response: {
        id: opts.id,
        object: "response",
        created_at: opts.created,
        model: opts.model,
        status: "completed",
        ...(usageMapped ? { usage: usageMapped } : {}),
      },
    };
    yield formatResponsesSSE(completedPayload);
  }
}
