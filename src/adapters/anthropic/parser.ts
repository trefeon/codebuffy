import { parseIRRequest, ParseError, type IRRequest, type IRMessage, type IRImage } from "../../ir/types";

// Anthropic content blocks (subset we support; thinking handled gracefully)
type AnthropicTextBlock = { type: "text"; text: string };
type AnthropicImageBlock = { type: "image"; source: { type: "base64"; media_type: string; data: string } };
type AnthropicToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
type AnthropicToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string | Array<{ type: "text"; text: string }>; is_error?: boolean };
type AnthropicThinkingBlock = { type: "thinking"; thinking: string } | { type: "redacted_thinking"; data: string };
type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicToolUseBlock | AnthropicToolResultBlock | AnthropicThinkingBlock;

type AnthropicSystem = string | Array<{ type: "text"; text: string }>;

function joinTextBlocks(blocks: unknown[]): string {
  const texts: string[] = [];
  for (const b of blocks) {
    if (b && typeof b === "object" && "type" in (b as Record<string, unknown>)) {
      const block = b as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
      else if (block.type === "thinking" && typeof (block as { thinking?: string }).thinking === "string") {
        texts.push((block as { thinking: string }).thinking);
      }
      // image and redacted_thinking intentionally not joined as text; image ignored, redacted skipped
    } else if (typeof b === "string") {
      texts.push(b);
    }
  }
  return texts.join("");
}

function stringifyToolResultContent(content: AnthropicToolResultBlock["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return joinTextBlocks(content);
  return String(content ?? "");
}

/**
 * Convert an Anthropic image block source to the IR image unit (upstream-ready
 * data: URL). Returns undefined for malformed sources so the caller skips the
 * block — matching the openai-chat parser (malformed image blocks are skipped,
 * never 400; the rest of the request still parses).
 */
function anthropicImageToIR(source: unknown): IRImage | undefined {
  if (!source || typeof source !== "object") return undefined;
  const rec = source as Record<string, unknown>;
  if (
    rec.type !== "base64" ||
    typeof rec.media_type !== "string" ||
    typeof rec.data !== "string" ||
    rec.data.length === 0
  ) {
    return undefined;
  }
  return { url: `data:${rec.media_type};base64,${rec.data}`, media_type: rec.media_type };
}


/**
 * Parse Anthropic Messages request into canonical IR.
 * Spec-exact per research/03 §3.2: tool_result in user, thinking preserved, stop_sequences, tool_choice any→required, system pre-pended.
 */
export function parseAnthropicRequest(raw: unknown): IRRequest {
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
  if (typeof body.max_tokens !== "number" || !Number.isInteger(body.max_tokens) || body.max_tokens <= 0) {
    throw new ParseError("max_tokens: required positive integer");
  }

  // System handling: string or array of text blocks -> IR system message.
  // Claude Code also injects `role:"system"` entries INSIDE messages[] —
  // fold their text into the leading system instead of rejecting (the real
  // Anthropic API tolerates them; CodeBuddy upstream only accepts a leading one).
  const irMessages: IRMessage[] = [];
  const inlineSystemParts: string[] = [];
  if (body.system !== undefined) {
    const sys = body.system as AnthropicSystem;
    let systemText = "";
    if (typeof sys === "string") systemText = sys;
    else if (Array.isArray(sys)) systemText = joinTextBlocks(sys);
    else throw new ParseError("system: must be string or array of text blocks");
    if (systemText) irMessages.push({ role: "system", content: systemText });
  }

  for (let idx = 0; idx < (body.messages as unknown[]).length; idx++) {
    const m = (body.messages as unknown[])[idx] as Record<string, unknown>;
    if (typeof m !== "object" || m === null || Array.isArray(m)) {
      throw new ParseError(`messages.${idx}: must be an object`);
    }
    const role = m.role as string;
    if (role === "system") {
      // Fold inline system turn into the leading system message later.
      const c = m.content as unknown;
      if (typeof c === "string") inlineSystemParts.push(c);
      else if (Array.isArray(c)) {
        const blocks = c as Array<{ type: string; text?: string }>;
        inlineSystemParts.push(joinTextBlocks(blocks.filter((b) => b.type === "text") as Array<{ type: "text"; text: string }>));
      }
      continue;
    }
    if (role !== "user" && role !== "assistant") {
      const roles = (body.messages as unknown[]).map((x) => (x as Record<string, unknown>)?.role).join(",");
      throw new ParseError(`messages.${idx}.role: must be user or assistant (got "${String(role)}"; all roles: [${roles}])`);
    }

    const rawContent = m.content as unknown;
    if (role === "user") {
      // User content may be string or array with text/image/tool_result/thinking
      if (typeof rawContent === "string") {
        irMessages.push({ role: "user", content: rawContent });
      } else if (Array.isArray(rawContent)) {
        const textParts: string[] = [];
        const thinkingParts: string[] = [];
        const images: IRImage[] = [];
        const toolResults: AnthropicToolResultBlock[] = [];
        for (const b of rawContent as AnthropicContentBlock[]) {
          if (!b || typeof b !== "object" || !("type" in (b as Record<string, unknown>))) {
            throw new ParseError(`messages.${idx}.content: invalid block`);
          }
          const block = b as Record<string, unknown>;
          if (block.type === "text" && typeof block.text === "string") textParts.push(block.text);
          else if (block.type === "tool_result") {
            toolResults.push(b as AnthropicToolResultBlock);
          } else if (block.type === "image") {
            // Forwarded as upstream image_url; silent by design — the parser
            // layer is logger-free, and IR.images evidences it per message.
            // Malformed sources are skipped (openai-chat parity), never 400.
            const img = anthropicImageToIR((b as AnthropicImageBlock).source);
            if (img) images.push(img);
          } else if (block.type === "thinking") {
            // Thinking is reasoning, not user text: preserve it in IR.thinking
            // instead of flattening it into content.
            const t = (block as AnthropicThinkingBlock & { thinking?: string }).thinking;
            if (typeof t === "string") thinkingParts.push(t);
            continue;
          } else if (block.type === "redacted_thinking") {
            // Dropped, not forwarded: the payload is provider-encrypted and
            // opaque to the gateway, so no upstream can consume it.
            continue;
          } else if (block.type === "tool_use") {
            throw new ParseError(`messages.${idx}.content: tool_use not allowed in user role`);
          } else {
            throw new ParseError(`messages.${idx}.content: unknown block type ${(block as { type: string }).type}`);
          }
        }
        const userText = textParts.join("");
        const thinking = thinkingParts.length > 0 ? thinkingParts.join("") : undefined;
        // Preserve order: text user message first (if any), then tool messages.
        // If the array carried only images/thinking (or was empty), still emit
        // the user turn so the images/thinking have a carrier message.
        if (userText || images.length > 0 || thinking !== undefined || toolResults.length === 0) {
          const userMsg: IRMessage = { role: "user", content: userText };
          if (images.length > 0) userMsg.images = images;
          if (thinking !== undefined) userMsg.thinking = thinking;
          irMessages.push(userMsg);
        }
        for (const tr of toolResults) {
          const content = stringifyToolResultContent(tr.content);
          const toolMsg: IRMessage = { role: "tool", content, tool_call_id: tr.tool_use_id };
          if (tr.is_error === true) toolMsg.is_error = true;
          irMessages.push(toolMsg);
        }
      } else {
        throw new ParseError(`messages.${idx}.content: must be string or array`);
      }
    } else {
      // assistant
      if (typeof rawContent === "string") {
        irMessages.push({ role: "assistant", content: rawContent });
      } else if (Array.isArray(rawContent)) {
        const textParts: string[] = [];
        const thinkingParts: string[] = [];
        const images: IRImage[] = [];
        const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
        for (const b of rawContent as AnthropicContentBlock[]) {
          if (!b || typeof b !== "object" || !("type" in (b as Record<string, unknown>))) {
            throw new ParseError(`messages.${idx}.content: invalid block`);
          }
          const block = b as Record<string, unknown>;
          if (block.type === "text" && typeof block.text === "string") textParts.push(block.text);
          else if (block.type === "tool_use") {
            const tu = b as AnthropicToolUseBlock;
            if (typeof tu.id !== "string" || typeof tu.name !== "string") {
              throw new ParseError(`messages.${idx}.content: tool_use requires id and name`);
            }
            toolCalls.push({ id: tu.id, type: "function", function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) } });
          } else if (block.type === "thinking") {
            // Preserved in IR.thinking, not flattened into the reply text.
            const t = (block as AnthropicThinkingBlock & { thinking?: string }).thinking;
            if (typeof t === "string") thinkingParts.push(t);
          } else if (block.type === "redacted_thinking") {
            // Dropped, not forwarded: the payload is provider-encrypted and
            // opaque to the gateway, so no upstream can consume it.
            continue;
          } else if (block.type === "tool_result") {
            throw new ParseError(`messages.${idx}.content: tool_result not allowed in assistant role`);
          } else if (block.type === "image") {
            // Forwarded as upstream image_url; silent by design (see above).
            // Malformed sources are skipped (openai-chat parity), never 400.
            const img = anthropicImageToIR((b as AnthropicImageBlock).source);
            if (img) images.push(img);
          } else {
            throw new ParseError(`messages.${idx}.content: unknown block type ${(block as { type: string }).type}`);
          }
        }
        const msg: IRMessage = { role: "assistant", content: textParts.join("") };
        if (toolCalls.length > 0) msg.tool_calls = toolCalls;
        if (images.length > 0) msg.images = images;
        if (thinkingParts.length > 0) msg.thinking = thinkingParts.join("");
        irMessages.push(msg);
      } else {
        throw new ParseError(`messages.${idx}.content: must be string or array`);
      }
    }
  }

  // Fold any inline `role:"system"` turns into the leading system message
  // (create one if the request had no top-level system).
  if (inlineSystemParts.length > 0) {
    const folded = inlineSystemParts.join("\n\n").trim();
    if (folded) {
      const head = irMessages[0];
      if (head && head.role === "system") {
        head.content = `${head.content}\n\n${folded}`.trim();
      } else {
        irMessages.unshift({ role: "system", content: folded });
      }
    }
  }

  // Tools mapping
  let irTools: unknown = undefined;
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw new ParseError("tools: must be an array");
    irTools = (body.tools as Array<Record<string, unknown>>).map((t, i) => {
      if (typeof t.name !== "string" || t.name.length === 0) throw new ParseError(`tools.${i}.name: required`);
      return {
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      };
    });
  }

  // tool_choice mapping
  let irToolChoice: unknown = undefined;
  if (body.tool_choice !== undefined) {
    const tc = body.tool_choice as Record<string, unknown>;
    if (typeof tc.type !== "string") throw new ParseError("tool_choice.type: required");
    if (tc.type === "auto") irToolChoice = "auto";
    else if (tc.type === "any") irToolChoice = "required";
    else if (tc.type === "tool") {
      if (typeof tc.name !== "string") throw new ParseError("tool_choice.name: required when type is tool");
      irToolChoice = { type: "function", function: { name: tc.name } };
    } else {
      throw new ParseError(`tool_choice.type: must be auto, any, or tool (got ${tc.type})`);
    }
  }

  const rawIr: Record<string, unknown> = {
    model: body.model,
    messages: irMessages,
    stream: body.stream,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_tokens,
    stop: body.stop_sequences,
    tools: irTools,
    tool_choice: irToolChoice,
  };

  // Remove undefined keys so IR validation doesn't see them as present
  for (const k of Object.keys(rawIr)) if (rawIr[k] === undefined) delete rawIr[k];

  return parseIRRequest(rawIr);
}
