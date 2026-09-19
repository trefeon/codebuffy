import { parseIRRequest, ParseError, type IRRequest, type IRImage } from "../../ir/types";

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
 * Normalize an OpenAI `image_url` block value to the IR image unit.
 * Accepts the spec object form `{url, detail?}` and a bare URL string;
 * returns undefined for malformed values so the caller skips (never 400s).
 */
function openAIImageToIR(imageUrl: unknown): IRImage | undefined {
  if (typeof imageUrl === "string") {
    return imageUrl.length > 0 ? { url: imageUrl } : undefined;
  }
  if (imageUrl && typeof imageUrl === "object") {
    if ("url" in imageUrl) {
      const url = imageUrl.url;
      if (typeof url !== "string" || url.length === 0) return undefined;
      const img: IRImage = { url };
      if ("detail" in imageUrl && typeof imageUrl.detail === "string") img.detail = imageUrl.detail;
      return img;
    }
  }
  return undefined;
}

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
 *   and a string `content` (tool_calls allowed for assistant); array content
 *   is normalized by joining text blocks and forwarding `image_url` blocks
 *   into IR `images` (malformed image blocks are skipped, never 400)
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
    // IR keeps text in `content` and vision in `images`, so normalize arrays
    // by joining text blocks and forwarding image_url blocks. Malformed
    // image blocks are skipped, never 400 — vision must not fail the request.
    let normalizedContent: unknown = msg.content;
    let images: IRImage[] | undefined;
    if (Array.isArray(msg.content)) {
      const blocks = msg.content as unknown[];
      const texts: string[] = [];
      const found: IRImage[] = [];
      for (const b of blocks) {
        if (b && typeof b === "object" && "type" in (b as Record<string, unknown>)) {
          const block = b as Record<string, unknown>;
          if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
          else if (block.type === "image_url") {
            // Forwarded as upstream image_url; silent by design — the parser
            // layer is logger-free, and IR.images evidences it per message.
            const img = openAIImageToIR(block.image_url);
            if (img !== undefined) found.push(img);
          }
        } else if (typeof b === "string") {
          texts.push(b);
        }
      }
      normalizedContent = texts.join("");
      if (found.length > 0) images = found;
    }

    if (typeof normalizedContent !== "string") {
      throw new ParseError(`messages.${idx}.content: must be a string or array of content blocks`);
    }

    if (msg.tool_calls !== undefined && !Array.isArray(msg.tool_calls)) {
      throw new ParseError(`messages.${idx}.tool_calls: must be an array if present`);
    }

    // Legacy "function" role -> "tool" for IR
    if (role === "function") {
      const out: Record<string, unknown> = { ...msg, role: "tool", content: normalizedContent };
      if (images !== undefined) out.images = images;
      return out;
    }

    const out: Record<string, unknown> = { ...msg, content: normalizedContent };
    if (images !== undefined) out.images = images;
    return out;
  });


  const normalized: Record<string, unknown> = {
    ...body,
    messages: normalizedMessages,
  };

  return parseIRRequest(normalized);
}
