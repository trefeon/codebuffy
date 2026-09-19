import { z } from "zod";
import { PASSTHROUGH_KEYS } from "../upstream/types";
import type { UpstreamChatRequest } from "../upstream/types";

export type IRRole = "system" | "user" | "assistant" | "tool";

export interface IRImage {
  /** Upstream-ready URL: http(s) URL, or data:<media_type>;base64,<data>. */
  url: string;
  /** OpenAI detail hint ("auto" | "low" | "high"); preserved when supplied. */
  detail?: string;
  /** Original media type of base64 sources (e.g. "image/png"). */
  media_type?: string;
}

export interface IRMessage {
  role: IRRole;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  /**
   * Forwarded vision content, in request order. Set by the Anthropic and
   * OpenAI-chat parsers; absent when the request carries no images.
   * Serialized back to OpenAI `image_url` blocks by toUpstreamRequest.
   */
  images?: IRImage[];
  /**
   * Preserved Anthropic thinking text, in block order. Stored separately so
   * reasoning is never conflated with user-visible text. The OpenAI-shaped
   * upstream has no thinking channel, so this is not forwarded upstream —
   * it is re-emitted to Anthropic clients by the Anthropic emitter.
   */
  thinking?: string;
  /**
   * Anthropic `tool_result.is_error`. Set only when true; absent otherwise
   * so the default wire shape is unchanged.
   */
  is_error?: boolean;
}

export interface IRRequest {
  model: string;
  messages: IRMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  top_p?: number;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  n?: number;
  response_format?: unknown;
  seed?: number;
  user?: string;
  tools?: unknown;
  tool_choice?: unknown;
  reasoning_effort?: unknown;
  verbosity?: unknown;
  reasoning_summary?: unknown;
}

export class ParseError extends Error {
  public readonly status = 400;
  public readonly code = "invalid_request_error";

  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = "ParseError";
  }
}

const IRRoleSchema = z.enum(["system", "user", "assistant", "tool"]);

const IRToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

function normalizeContent(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw === null || raw === undefined) return "";
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const part of raw) {
      if (typeof part === "string") {
        parts.push(part);
      } else if (part && typeof part === "object") {
        const rec = part as Record<string, unknown>;
        if (typeof rec.text === "string") {
          parts.push(rec.text);
        } else if (rec.type === "image_url") {
          // preserve image blocks as placeholder skipped - text join
          continue;
        }
      }
    }
    return parts.join("");
  }
  return "";
}

const IRContentSchema: z.ZodType<string> = z
  .union([z.string(), z.array(z.unknown()), z.null()])
  .transform((v) => normalizeContent(v));

const IRImageSchema = z.object({
  url: z.string().min(1),
  detail: z.string().optional(),
  media_type: z.string().optional(),
});

const IRMessageSchema = z.object({
  role: IRRoleSchema,
  content: IRContentSchema,
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(IRToolCallSchema).optional(),
  images: z.array(IRImageSchema).optional(),
  thinking: z.string().optional(),
  is_error: z.boolean().optional(),
});

const IRRequestSchema = z.object({
  model: z.string().min(1, "model must be non-empty"),
  messages: z.array(IRMessageSchema).min(1, "messages must contain at least one message"),
  stream: z.boolean().optional(),
  stream_options: z
    .object({
      include_usage: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().min(1).optional(),
  max_completion_tokens: z.number().int().min(1).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  n: z.number().int().min(1).optional(),
  response_format: z.unknown().optional(),
  seed: z.number().int().optional(),
  user: z.string().optional(),
  tools: z.unknown().optional(),
  tool_choice: z.unknown().optional(),
  reasoning_effort: z.unknown().optional(),
  verbosity: z.unknown().optional(),
  reasoning_summary: z.unknown().optional(),
});

export function parseIRRequest(raw: unknown): IRRequest {
  const result = IRRequestSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => {
        const path = i.path.length ? i.path.join(".") : "(root)";
        return `${path}: ${i.message}`;
      })
      .join("; ");
    const message = issues || result.error.message;
    throw new ParseError(message, { cause: result.error });
  }
  return result.data as IRRequest;
}

/**
 * Serialize one IR message to the OpenAI-shaped upstream wire format.
 *
 * - Messages without images keep `content` as a plain string (unchanged wire shape).
 * - Messages with images become array content: one text part (omitted when
 *   empty so image-only turns stay valid) followed by one `image_url` part
 *   per IR image.
 * - `is_error` is propagated only when true; OpenAI defines no standard
 *   field for it, but the extra key keeps the error signal for backends
 *   that honor it and is ignored by those that do not.
 * - `thinking` is intentionally not forwarded: the OpenAI-shaped upstream
 *   has no thinking channel. It is preserved in IR for Anthropic-faithful
 *   re-emission by the Anthropic emitter.
 */
function toUpstreamMessage(m: IRMessage): Record<string, unknown> {
  const msg: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.name !== undefined) msg.name = m.name;
  if (m.tool_call_id !== undefined) msg.tool_call_id = m.tool_call_id;
  if (m.tool_calls !== undefined) msg.tool_calls = m.tool_calls;
  if (m.is_error === true) msg.is_error = true;
  if (m.images !== undefined && m.images.length > 0) {
    const parts: Array<Record<string, unknown>> = [];
    if (m.content) parts.push({ type: "text", text: m.content });
    for (const img of m.images) {
      const imageUrl: Record<string, unknown> = { url: img.url };
      if (img.detail !== undefined) imageUrl.detail = img.detail;
      parts.push({ type: "image_url", image_url: imageUrl });
    }
    msg.content = parts;
  }
  return msg;
}

export function toUpstreamRequest(ir: IRRequest): UpstreamChatRequest {
  const out: UpstreamChatRequest = {
    model: ir.model,
    messages: ir.messages.map(toUpstreamMessage) as unknown as UpstreamChatRequest["messages"],
    stream: true,
  };

  for (const key of PASSTHROUGH_KEYS) {
    if (key === "model" || key === "messages" || key === "stream") continue;
    const val = (ir as unknown as Record<string, unknown>)[key];
    if (val !== undefined) {
      (out as unknown as Record<string, unknown>)[key] = val;
    }
  }

  out.stream = true;
  return out;
}
