import { z } from "zod";
import { PASSTHROUGH_KEYS } from "../upstream/types";
import type { UpstreamChatRequest } from "../upstream/types";

export type IRRole = "system" | "user" | "assistant" | "tool";

export interface IRMessage {
  role: IRRole;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
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

const IRMessageSchema = z.object({
  role: IRRoleSchema,
  content: IRContentSchema,
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(IRToolCallSchema).optional(),
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

export function toUpstreamRequest(ir: IRRequest): UpstreamChatRequest {
  const out: UpstreamChatRequest = {
    model: ir.model,
    messages: ir.messages as unknown as UpstreamChatRequest["messages"],
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
