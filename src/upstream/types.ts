/**
 * Upstream wire types (CodeBuddy cloud backend).
 *
 * Request side is intentionally broad-passthrough: the gateway validates only
 * that the body is an object and forwards the allowlisted keys verbatim. This
 * keeps the gateway forward-compatible with new backend fields without a
 * redeploy. See research/03 §2 for the allowlist provenance.
 */

export const PASSTHROUGH_KEYS = [
  "model",
  "messages",
  "temperature",
  "max_tokens",
  "top_p",
  "stream",
  "stream_options",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "n",
  "response_format",
  "seed",
  "user",
  "reasoning_effort",
  "verbosity",
  "reasoning_summary",
  "tools",
  "tool_choice",
  "max_completion_tokens",
] as const;

export type PassthroughKey = (typeof PASSTHROUGH_KEYS)[number];

/**
 * Chat completions request forwarded upstream.
 *
 * The backend is stream-only; callers may omit `stream` and the client forces
 * `stream:true`. Only PASSTHROUGH_KEYS are forwarded; anything else is
 * dropped. Validation is object-only — an allowlist filter + downstream-spec
 * validation lives in the adapter layer (M2+).
 */
export interface UpstreamChatRequest {
  model: string;
  messages: Array<{ role: "user" | "assistant" | "system" | string; content: string }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream_options?: unknown;
  stop?: unknown;
  presence_penalty?: number;
  frequency_penalty?: number;
  n?: number;
  response_format?: unknown;
  seed?: number;
  user?: string;
  reasoning_effort?: unknown;
  verbosity?: unknown;
  reasoning_summary?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  max_completion_tokens?: number;
  [key: string]: unknown;
}

/**
 * Single SSE chunk yielded from `POST /v2/chat/completions` (stream:true).
 * Shape mirrors OpenAI Chat Completions chunk; `usage` appears only on the
 * final chunk when `stream_options.include_usage:true`.
 */
export interface UpstreamChunk {
  id?: string;
  choices: Array<{
    delta: { content?: string; role?: string; tool_calls?: unknown };
    finish_reason?: string | null;
    index?: number;
  }>;
  usage?: unknown;
  [key: string]: unknown;
}
