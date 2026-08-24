import type { UpstreamChunk } from "../../upstream/types";

/**
 * Aggregate a streaming sequence of upstream chunks into a single
 * OpenAI non-streaming chat completion object.
 *
 * - concatenates choices[0].delta.content across chunks
 * - captures finish_reason from the last chunk that carries a non-null value
 * - carries forward usage if any chunk contained it (last wins, typically final chunk)
 * - returns id/object/choices/message shape per OpenAI spec
 * - empty stream yields content "" and finish_reason null
 */
export async function aggregateStream(
  chunks: AsyncIterable<UpstreamChunk>,
  opts: { id: string; model: string; created: number },
): Promise<Record<string, unknown>> {
  let content = "";
  let finishReason: string | null = null;
  let usage: unknown = undefined;
  const toolCallsByIndex = new Map<
    number,
    { id: string; type: "function"; function: { name: string; arguments: string } }
  >();

  for await (const chunk of chunks) {
    if (chunk.usage !== undefined) {
      usage = chunk.usage;
    }

    const choice = chunk.choices?.[0];
    if (!choice) continue;

    const delta: Record<string, unknown> = choice.delta as Record<string, unknown>;
    const deltaContent = delta?.content;
    if (typeof deltaContent === "string") {
      content += deltaContent;
    }

    const deltaToolCalls = (delta as { tool_calls?: unknown })?.tool_calls;
    if (Array.isArray(deltaToolCalls)) {
      for (const tc of deltaToolCalls as Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>) {
        const idx = typeof tc.index === "number" ? tc.index : toolCallsByIndex.size;
        const existing = toolCallsByIndex.get(idx) ?? {
          id: "",
          type: "function" as const,
          function: { name: "", arguments: "" },
        };
        if (tc.id) existing.id = tc.id;
        if (tc.type) existing.type = "function";
        if (tc.function?.name) existing.function.name = tc.function.name;
        if (typeof tc.function?.arguments === "string") existing.function.arguments += tc.function.arguments;
        toolCallsByIndex.set(idx, existing);
      }
    }

    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      finishReason = choice.finish_reason as string;
    }
  }

  // Infer tool_calls finish reason when calls present but upstream left it null
  if (toolCallsByIndex.size > 0 && (finishReason === null || finishReason === undefined)) {
    finishReason = "tool_calls";
  }

  const sortedToolCalls =
    toolCallsByIndex.size > 0
      ? [...toolCallsByIndex.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, v]) => v)
      : undefined;

  const message: Record<string, unknown> = {
    role: "assistant",
    content,
  };
  if (sortedToolCalls) message.tool_calls = sortedToolCalls;

  const result: Record<string, unknown> = {
    id: opts.id,
    object: "chat.completion",
    created: opts.created,
    model: opts.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
  };

  if (usage !== undefined) {
    result.usage = usage;
  }

  return result;
}
