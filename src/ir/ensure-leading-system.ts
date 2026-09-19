import type { Site } from "../models/catalog";
import type { IRMessage, IRRequest } from "./types";

/**
 * Ensure the IR carries a leading system message.
 *
 * CodeBuddy rejects requests without a leading system message (business
 * code 11101 "invalid request" on /v2/chat/completions); both sites shape
 * defensively here so parse errors never reach the wire.
 *
 * CN keeps the historical behavior: prepend the fallback assistant prompt
 * only when the first message is not already a system message.
 *
 * INTL follows the 9router intl executor contract
 * (reference/decolua__9router/open-sse/executors/codebuddy-intl.js): drop
 * every source system/developer message, prepend the fixed "You are
 * CodeBuddy Code." system prompt, and wrap bare-string user content as
 * typed text blocks.
 */
export function ensureLeadingSystem(ir: IRRequest, site: Site = "cn"): IRRequest {
  if (site === "intl") return shapeIntlRequest(ir);
  if (ir.messages.length > 0 && ir.messages[0]!.role === "system") return ir;
  return { ...ir, messages: [{ role: "system", content: "You are a helpful assistant." }, ...ir.messages] };
}

/** INTL wire shape: fixed leading system, typed user blocks, no source system/developer. */
function shapeIntlRequest(ir: IRRequest): IRRequest {
  const messages: IRMessage[] = [{ role: "system", content: "You are CodeBuddy Code." }];
  for (const message of ir.messages) {
    if (message.role === "system" || (message.role as string) === "developer") continue;
    if (message.role === "user" && typeof message.content === "string") {
      // /v2/chat/completions (intl) rejects bare-string user content: wrap as a typed block.
      // toUpstreamRequest forwards message content opaquely, so the shaped block survives
      // shaping untouched; sanitizeUpstreamBody skips non-string content by design.
      messages.push({ ...message, content: [{ type: "text", text: message.content }] as unknown as string });
    } else {
      messages.push({ ...message });
    }
  }
  return { ...ir, messages };
}
