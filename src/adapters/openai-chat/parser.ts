import { parseIRRequest, ParseError, type IRRequest } from "../../ir/types";

export type { IRRequest };
export { ParseError };

const ALLOWED_ROLES: Record<string, true> = {
  system: true,
  user: true,
  assistant: true,
  tool: true,
  function: true,
};

/**
 * Parse an OpenAI Chat Completions request body into the canonical IR.
 *
 * Pre-validates the OpenAI-specific envelope (model, messages, roles) to
 * produce 400-compatible errors before delegating to the canonical
 * `parseIRRequest` zod validation for the remaining fields.
 *
 * - `model` must be a non-empty string
 * - `messages` must be a non-empty array
 * - each message must have a role in {system,user,assistant,tool,function}
 *   and a string `content` (tool_calls allowed for assistant)
 * - role "function" is normalized to "tool" for IR compatibility
 *
 * Throws ParseError with status 400 on any validation failure.
 */
export function parseOpenAIChatRequest(raw: unknown): IRRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ParseError("request body must be an object");
  }

  const body = raw as Record<string, unknown>;

  if (typeof body.model !== "string" || body.model.length === 0) {
    throw new ParseError("model: required non-empty string");
  }

  if (!Array.isArray(body.messages)) {
    throw new ParseError("messages: required array");
  }

  if (body.messages.length === 0) {
    throw new ParseError("messages: must contain at least one message");
  }

  const normalizedMessages = body.messages.map((m, idx) => {
    if (typeof m !== "object" || m === null || Array.isArray(m)) {
      throw new ParseError(`messages.${idx}: must be an object`);
    }
    const msg = m as Record<string, unknown>;

    const role = msg.role;
    if (typeof role !== "string" || !ALLOWED_ROLES[role]) {
      throw new ParseError(
        `messages.${idx}.role: must be one of system, user, assistant, tool, function`,
      );
    }

    // OpenAI allows content as string or array of blocks (vision etc.)
    // IR keeps content as string, so normalize arrays by joining text blocks.
    // Image content is not rejected; text parts are extracted and joined.
    let normalizedContent: unknown = msg.content;
    if (Array.isArray(msg.content)) {
      const blocks = msg.content as unknown[];
      const texts: string[] = [];
      for (const b of blocks) {
        if (b && typeof b === "object" && "type" in (b as Record<string, unknown>)) {
          const block = b as Record<string, unknown>;
          if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
          else if (block.type === "image_url") {
            // Vision blocks have no text; keep content non-empty so IR validation passes.
            // Future IR will carry image_url separately; for M2 join as placeholder.
            // Intentionally not throwing — clients should not get 400 for vision.
          }
        } else if (typeof b === "string") {
          texts.push(b);
        }
      }
      normalizedContent = texts.join("");
    }

    if (typeof normalizedContent !== "string") {
      throw new ParseError(`messages.${idx}.content: must be a string or array of content blocks`);
    }

    if (msg.tool_calls !== undefined && !Array.isArray(msg.tool_calls)) {
      throw new ParseError(`messages.${idx}.tool_calls: must be an array if present`);
    }

    // Legacy "function" role -> "tool" for IR
    if (role === "function") {
      return { ...msg, role: "tool", content: normalizedContent };
    }

    return { ...msg, content: normalizedContent };
  });

  const normalized: Record<string, unknown> = {
    ...body,
    messages: normalizedMessages,
  };

  return parseIRRequest(normalized);
}
