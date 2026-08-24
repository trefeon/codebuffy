import { parseIRRequest, ParseError, type IRRequest, type IRMessage } from "../../ir/types";

export { ParseError };
export type { IRRequest };

/**
 * Helper: stringify tool output. Object → JSON, string → as-is.
 */
export function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === null || output === undefined) return "";
  if (typeof output === "object") return JSON.stringify(output);
  return String(output);
}

function extractInputContent(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const p of raw) {
      if (p === null || p === undefined) continue;
      if (typeof p === "string") {
        parts.push(p);
        continue;
      }
      if (typeof p === "object" && !Array.isArray(p)) {
        const block = p as Record<string, unknown>;
        const t = block.type as string | undefined;
        if (t === "input_text" || t === "text" || t === "output_text") {
          if (typeof block.text === "string") parts.push(block.text);
        } else if (t === "input_image") {
          // Drop images for now (future IR will carry). No placeholder to avoid polluting content.
          continue;
        } else {
          // Unknown block type: if it has text field, ignore? Spec says drop unknown except where noted.
          // We ignore unknown types completely to avoid accidental inclusion.
          continue;
        }
      }
    }
    return parts.join("");
  }
  if (raw === null || raw === undefined) return "";
  return String(raw);
}

function extractOutputText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const p of raw) {
      if (p && typeof p === "object" && !Array.isArray(p)) {
        const block = p as Record<string, unknown>;
        if (block.type === "output_text" && typeof block.text === "string") {
          parts.push(block.text);
        } else if (block.type === "text" && typeof block.text === "string") {
          // fallback for simple text parts
          parts.push(block.text);
        } else if (typeof block.text === "string" && (block.type === undefined || block.type === null)) {
          parts.push(block.text);
        }
      } else if (typeof p === "string") {
        parts.push(p);
      }
    }
    return parts.join("");
  }
  if (raw === null || raw === undefined) return "";
  return String(raw);
}

function generateCallId(): string {
  // Matches contract: call_id || id || "call_"+rand
  const rand = Math.random().toString(36).slice(2, 10);
  const suffix = Date.now().toString(36).slice(-4);
  return `call_${rand}${suffix}`;
}

/**
 * Parse OpenAI Responses request into canonical IR.
 *
 * Validates model, input, instructions, max_output_tokens, stream, temperature, top_p,
 * tools, previous_response_id, etc. Unknown fields ignored except where spec says drop.
 * Throws ParseError 400 on validation failure.
 */
export function parseResponsesRequest(raw: unknown): IRRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ParseError("request body must be an object");
  }
  const body = raw as Record<string, unknown>;

  // ---- model ----
  if (typeof body.model !== "string" || body.model.length === 0) {
    throw new ParseError("model: required non-empty string");
  }

  // ---- previous_response_id ---- validate if present, then ignore for upstream (statefulness deferred)
  if (body.previous_response_id !== undefined) {
    if (typeof body.previous_response_id !== "string") {
      throw new ParseError("previous_response_id: must be a string");
    }
    // Intentionally not forwarded upstream; validated only.
  }

  // ---- instructions ----
  if (body.instructions !== undefined && typeof body.instructions !== "string") {
    throw new ParseError("instructions: must be a string");
  }

  // ---- max_output_tokens / max_tokens ----
  let maxTokens: number | undefined;
  if (body.max_output_tokens !== undefined) {
    if (
      typeof body.max_output_tokens !== "number" ||
      !Number.isInteger(body.max_output_tokens) ||
      body.max_output_tokens <= 0
    ) {
      throw new ParseError("max_output_tokens: must be positive integer");
    }
    maxTokens = body.max_output_tokens as number;
  } else if (body.max_tokens !== undefined) {
    if (
      typeof body.max_tokens !== "number" ||
      !Number.isInteger(body.max_tokens) ||
      body.max_tokens <= 0
    ) {
      throw new ParseError("max_tokens: must be positive integer");
    }
    maxTokens = body.max_tokens as number;
  }

  // ---- stream ----
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw new ParseError("stream: must be boolean");
  }

  // ---- temperature / top_p ----
  if (body.temperature !== undefined && typeof body.temperature !== "number") {
    throw new ParseError("temperature: must be a number");
  }
  if (body.top_p !== undefined && typeof body.top_p !== "number") {
    throw new ParseError("top_p: must be a number");
  }

  // ---- tools ----
  let irTools: unknown = undefined;
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) {
      throw new ParseError("tools: must be an array");
    }
    const toolsArr = body.tools as unknown[];
    irTools = toolsArr.map((t, i) => {
      if (typeof t !== "object" || t === null || Array.isArray(t)) {
        throw new ParseError(`tools.${i}: must be an object`);
      }
      const tool = t as Record<string, unknown>;
      const ttype = tool.type as string | undefined;
      if (ttype !== undefined && ttype !== "function") {
        throw new ParseError(
          `tools.${i}.type: unsupported tool type "${String(ttype)}" - only "function" is supported`,
        );
      }
      if (ttype !== "function") {
        // If type missing or not function but we already handled non-function case above,
        // we still need to enforce function type present. For missing type, also throw explicit.
        // However spec says tools[] flat {type:"function", ...} so type required.
        // We treat missing type as unsupported.
        throw new ParseError(
          `tools.${i}.type: unsupported tool type "${String(ttype)}" - only "function" is supported`,
        );
      }
      // Support both flat Responses format and already-nested Chat format (has function key)
      if ("function" in tool) {
        const fn = tool.function as Record<string, unknown> | undefined;
        if (!fn || typeof fn.name !== "string" || fn.name.length === 0) {
          throw new ParseError(`tools.${i}.function.name: required non-empty string`);
        }
        // Return as-is; preserve original shape
        return tool;
      }
      // Flat format
      if (typeof tool.name !== "string" || (tool.name as string).length === 0) {
        throw new ParseError(`tools.${i}.name: required non-empty string`);
      }
      const fn: Record<string, unknown> = { name: tool.name };
      if (tool.description !== undefined) fn.description = tool.description;
      if (tool.parameters !== undefined) fn.parameters = tool.parameters;
      if (tool.strict !== undefined) fn.strict = tool.strict;
      return { type: "function", function: fn };
    });
  }

  // ---- input ----
  if (body.input === undefined) {
    throw new ParseError("input: required string or array");
  }
  const inputRaw = body.input;

  const irMessages: IRMessage[] = [];

  // instructions first
  if (typeof body.instructions === "string" && body.instructions.length > 0) {
    irMessages.push({ role: "system", content: body.instructions });
  }

  // Handle string input
  if (typeof inputRaw === "string") {
    if (inputRaw.length === 0) {
      throw new ParseError("input: must be non-empty string");
    }
    irMessages.push({ role: "user", content: inputRaw });
  } else if (Array.isArray(inputRaw)) {
    if (inputRaw.length === 0) {
      throw new ParseError("input: must contain at least one item");
    }

    let pendingAssistantContent: string | null = null;
    let pendingToolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];

    const flushAssistant = (): void => {
      if (pendingAssistantContent !== null || pendingToolCalls.length > 0) {
        const msg: IRMessage = {
          role: "assistant",
          content: pendingAssistantContent ?? "",
        };
        if (pendingToolCalls.length > 0) {
          msg.tool_calls = pendingToolCalls.slice();
        }
        irMessages.push(msg);
        pendingAssistantContent = null;
        pendingToolCalls = [];
      }
    };

    for (let idx = 0; idx < inputRaw.length; idx++) {
      const item = inputRaw[idx] as unknown;
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new ParseError(`input.${idx}: must be an object`);
      }
      const rec = item as Record<string, unknown>;
      const itemType = rec.type as string | undefined;
      const role = rec.role as string | undefined;

      // function_call -> buffered
      if (itemType === "function_call") {
        if (typeof rec.name !== "string" || (rec.name as string).length === 0) {
          throw new ParseError(`input.${idx}.name: required for function_call`);
        }
        let argsStr: string;
        const rawArgs = rec.arguments;
        if (rawArgs === undefined || rawArgs === null) {
          argsStr = "{}";
        } else if (typeof rawArgs === "string") {
          argsStr = rawArgs;
        } else {
          // object -> JSON.stringify, else raw
          argsStr = JSON.stringify(rawArgs);
        }
        if (pendingAssistantContent === null) pendingAssistantContent = "";
        const callId =
          (rec.call_id as string | undefined) ??
          (rec.id as string | undefined) ??
          generateCallId();
        pendingToolCalls.push({
          id: callId,
          type: "function",
          function: { name: rec.name as string, arguments: argsStr },
        });
        continue;
      }

      // function_call_output -> tool message, flush first
      if (itemType === "function_call_output") {
        const callId =
          (rec.call_id as string | undefined) ?? (rec.callId as string | undefined);
        if (typeof callId !== "string" || callId.length === 0) {
          throw new ParseError(`input.${idx}.call_id: required for function_call_output`);
        }
        const out = rec.output;
        const contentStr = stringifyOutput(out);
        flushAssistant();
        irMessages.push({ role: "tool", tool_call_id: callId, content: contentStr });
        continue;
      }

      // typed message: assistant
      if (itemType === "message" && role === "assistant") {
        flushAssistant();
        const rawContent = rec.content;
        const text = extractOutputText(rawContent);
        pendingAssistantContent = text;
        // Note: if there are multiple consecutive assistant messages, each will flush previous.
        // If spec meant concatenate within same turn, the pending already handled; but sequential flush is correct per reference.
        continue;
      }

      // typed message: user/system/developer
      if (itemType === "message" && (role === "user" || role === "system" || role === "developer")) {
        flushAssistant();
        const mappedRole = role === "developer" ? "system" : role;
        const rawContent = rec.content;
        const extracted = extractInputContent(rawContent);
        irMessages.push({ role: mappedRole as IRMessage["role"], content: extracted });
        continue;
      }

      // bare role messages (type undefined)
      if ((itemType === undefined || itemType === null) && (role === "user" || role === "system" || role === "developer")) {
        flushAssistant();
        const mappedRole = role === "developer" ? "system" : role;
        const rawContent = rec.content;
        const extracted = extractInputContent(rawContent);
        irMessages.push({ role: mappedRole as IRMessage["role"], content: extracted });
        continue;
      }

      if ((itemType === undefined || itemType === null) && role === "assistant") {
        flushAssistant();
        const rawContent = rec.content;
        const extracted = extractInputContent(rawContent);
        pendingAssistantContent = extracted;
        continue;
      }

      // Unknown type but has role: handle as direct message with validation
      if (role !== undefined) {
        if (role !== "user" && role !== "system" && role !== "developer" && role !== "assistant") {
          throw new ParseError(`input.${idx}.role: must be one of user, system, developer, assistant`);
        }
        flushAssistant();
        const mappedRole = role === "developer" ? "system" : role;
        const rawContent = rec.content;
        if (mappedRole === "assistant") {
          pendingAssistantContent = extractInputContent(rawContent);
        } else {
          irMessages.push({
            role: mappedRole as IRMessage["role"],
            content: extractInputContent(rawContent),
          });
        }
        continue;
      }

      // If we reach here: item has unknown type without role -> ignore? But spec says unknown fields ignored.
      // For input array, unknown item types with no role should be ignored (drop) not throw.
      // However if itemType is present but not recognized (e.g., "reasoning", "input_image" etc) we drop.
      // The contract notes reasoning object is dropped, input_image dropped.
      // So we silently skip unknown typed items without role.
      continue;
    }

    // Flush any remaining pending assistant
    flushAssistant();
  } else {
    throw new ParseError("input: must be string or array");
  }

  // ---- reasoning ---- explicitly dropped (validated shape but not forwarded)
  // Do not throw on unknown reasoning shape; just ignore.
  // If reasoning present but not object, we also ignore (spec says validate shape but drop).
  // No action needed.

  // ---- build raw IR ----
  const rawIr: Record<string, unknown> = {
    model: body.model,
    messages: irMessages,
  };

  if (body.stream !== undefined) rawIr.stream = body.stream;
  if (body.temperature !== undefined) rawIr.temperature = body.temperature;
  if (body.top_p !== undefined) rawIr.top_p = body.top_p;
  if (maxTokens !== undefined) rawIr.max_tokens = maxTokens;
  if (irTools !== undefined) rawIr.tools = irTools;
  if (body.tool_choice !== undefined) rawIr.tool_choice = body.tool_choice;
  if (body.user !== undefined) rawIr.user = body.user;

  // Also pass through some additional passthrough keys if present (to keep parity with other adapters)
  // This keeps gateway forward-compatible and satisfies IR validation for those keys.
  // We only include if they are defined and not already handled.
  const extraPassthrough: Array<string> = [
    "presence_penalty",
    "frequency_penalty",
    "n",
    "seed",
    "stop",
    "response_format",
    "reasoning_effort",
    "verbosity",
    "reasoning_summary",
  ];
  for (const k of extraPassthrough) {
    if (body[k] !== undefined && rawIr[k] === undefined) {
      rawIr[k] = body[k];
    }
  }

  // Remove undefined keys before parseIRRequest (consistent with other parsers)
  for (const k of Object.keys(rawIr)) if (rawIr[k] === undefined) delete rawIr[k];

  return parseIRRequest(rawIr);
}
