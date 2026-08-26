import type { UpstreamChunk } from "./types";

/**
 * Strip empty `tool_calls: []` arrays from stream deltas, mutating in place.
 *
 * CodeBuddy CN includes `"tool_calls": []` in EVERY streaming delta
 * (reference/decolua__9router open-sse/utils/stream.js:136-148). Clients on
 * @ai-sdk/openai-compatible treat a truthy `tool_calls` as tool activity,
 * which ends reasoning prematurely and truncates text output.
 */
export function stripEmptyToolCallDeltas(chunk: UpstreamChunk): void {
  if (!chunk || !Array.isArray(chunk.choices)) return;
  for (const choice of chunk.choices) {
    const delta = choice?.delta as Record<string, unknown> | undefined;
    if (
      delta &&
      Array.isArray(delta.tool_calls) &&
      delta.tool_calls.length === 0
    ) {
      delete delta.tool_calls;
    }
  }
}
