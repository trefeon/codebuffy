import type { UpstreamChunk } from "../../upstream/types";
import type { UpstreamError } from "../../upstream/errors";

export const DONE_SSE = "data: [DONE]\n\n";

/**
 * Format a single upstream chunk as an SSE data frame.
 *
 * Must be exactly `data: ${JSON.stringify(chunk)}\n\n` even when `id`
 * is undefined — JSON.stringify naturally omits undefined values so the
 * chunk is emitted gracefully without an `id` field.
 */
export function formatSSEChunk(chunk: UpstreamChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Format an upstream error as an SSE data frame.
 *
 * Shape mirrors a minimal OpenAI error envelope:
 *   {error:{message, code, type}}
 * where `type` falls back to the error's name. The gateway maps this
 * to an SSE error event; the client receives a single data line.
 */
export function formatSSEError(error: UpstreamError): string {
  const payload = {
    error: {
      message: error.message,
      code: error.code,
      type: error.name,
    },
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}
