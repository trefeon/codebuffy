import type { IRRequest, IRMessage } from "../../ir/types";

/**
 * Projection layer for Responses → Chat conversion.
 * See research/03 §3.3 — conservative vs aggressive modes.
 */

export const AGENTIC_TOOL_NAMES: ReadonlySet<string> = new Set([
  "exec_command",
  "write_stdin",
  "update_plan",
  "request_user_input",
  "view_image",
  "get_goal",
  "create_goal",
  "update_goal",
  "apply_patch",
  "tool_search_tool",
]);

export const BASE_SYSTEM_PROMPT = "You are a helpful assistant.";

export const SCHEMA_KEEP_KEYS: ReadonlySet<string> = new Set([
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "oneOf",
  "anyOf",
  "allOf",
  "additionalProperties",
  "format",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "nullable",
]);

export const HARNESS_USER_MARKERS: readonly string[] = [
  "# AGENTS.md instructions",
  "<environment_context>",
  "<permissions instructions>",
  "<collaboration_mode>",
  "<skills_instructions>",
  "<system-reminder>",
  "# claudeMd",
];

export const HARNESS_SYSTEM_MARKERS: readonly string[] = [
  "You are a coding agent running in the Codex CLI",
  "Within this context, Codex refers to",
  "# AGENTS.md spec",
  "<permissions instructions>",
  "<collaboration_mode>",
  "<skills_instructions>",
  "The following deferred tools are now available via ToolSearch.",
  "### Available skills",
  "## request_user_input availability",
  "You are Claude Code",
];

export const MAX_SYSTEM_GUIDANCE_CHARS = 1200;
export const MAX_USER_CHARS = 3200;
export const MAX_ASSISTANT_CHARS = 1800;
export const MAX_TOOL_OUTPUT_CHARS = 1600;
export const MAX_TOOL_ARGS_CHARS = 900;
export const MAX_HISTORY_SUMMARY_CHARS = 2200;
export const MAX_HISTORY_ITEMS = 10;
export const MAX_TAIL_MESSAGES = 8;
export const MAX_TAIL_CHARS = 7000;
export const HISTORY_PREFIX = "Earlier conversation summary (condensed):";

export type ProjectionMode = "conservative" | "aggressive" | "off";

export interface ProjectionOpts {
  mode: ProjectionMode;
  budgets?: {
    system?: number;
    user?: number;
    assistant?: number;
    toolOutput?: number;
    toolArgs?: number;
    totalTail?: number;
    maxMessages?: number;
  };
  dryRun?: boolean;
}

interface Budgets {
  system: number;
  user: number;
  assistant: number;
  toolOutput: number;
  toolArgs: number;
  totalTail: number;
  maxMessages: number;
}

const DEFAULT_BUDGETS: Budgets = {
  system: MAX_SYSTEM_GUIDANCE_CHARS,
  user: MAX_USER_CHARS,
  assistant: MAX_ASSISTANT_CHARS,
  toolOutput: MAX_TOOL_OUTPUT_CHARS,
  toolArgs: MAX_TOOL_ARGS_CHARS,
  totalTail: MAX_TAIL_CHARS,
  maxMessages: MAX_TAIL_MESSAGES,
};

function resolveBudgets(override?: ProjectionOpts["budgets"]): Budgets {
  if (!override) return { ...DEFAULT_BUDGETS };
  return {
    system: override.system ?? DEFAULT_BUDGETS.system,
    user: override.user ?? DEFAULT_BUDGETS.user,
    assistant: override.assistant ?? DEFAULT_BUDGETS.assistant,
    toolOutput: override.toolOutput ?? DEFAULT_BUDGETS.toolOutput,
    toolArgs: override.toolArgs ?? DEFAULT_BUDGETS.toolArgs,
    totalTail: override.totalTail ?? DEFAULT_BUDGETS.totalTail,
    maxMessages: override.maxMessages ?? DEFAULT_BUDGETS.maxMessages,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function deepClone<T>(obj: T): T {
  // structuredClone is available in Bun/Node 17+; fallback to JSON
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sc = (globalThis as any).structuredClone as undefined | ((v: T) => T);
    if (typeof sc === "function") return sc(obj);
  } catch {
    // ignore
  }
  return JSON.parse(JSON.stringify(obj)) as T;
}

function contentToText(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") parts.push(block);
      else if (block && typeof block === "object") {
        const rec = block as Record<string, unknown>;
        if (typeof rec.text === "string") parts.push(rec.text);
        else if (typeof rec.output === "string") parts.push(rec.output);
      }
    }
    return parts.join("");
  }
  return String(content);
}

function truncateText(text: string, limit: number): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  if (t.length <= limit) return t;
  const keep = Math.max(0, limit - 24);
  const omitted = t.length - keep;
  return t.slice(0, keep).trimEnd() + ` ... [truncated ${omitted} chars]`;
}

function summarizeFreeText(text: string, limit: number): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  if (t.length <= limit) return t;
  const headLen = Math.floor(limit / 2);
  const tailLen = Math.floor(limit / 3);
  const head = t.slice(0, headLen).trimEnd();
  const tail = t.slice(t.length - tailLen).trimStart();
  const omitted = t.length - head.length - tail.length;
  return `${head}\n... [${omitted} chars omitted] ...\n${tail}`;
}

function summarizeToolOutput(text: string, limit: number): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  if (t.length <= limit && t.split("\n").length <= 24) return t;

  const lines = t.split("\n");
  const exitLine = lines.find((l) => l.includes("Process exited with code")) ?? "";
  const useful: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (
      trimmed.startsWith("Chunk ID:") ||
      trimmed.startsWith("Wall time:") ||
      trimmed.startsWith("Original token count:") ||
      trimmed.includes("Process exited with code")
    ) {
      continue;
    }
    // skip bare "Output:" marker similar to reference
    if (trimmed === "Output:") continue;
    useful.push(trimmed);
  }

  const head = useful.slice(0, 10);
  const tail = useful.length > 16 ? useful.slice(-6) : [];
  const omitted = Math.max(0, useful.length - head.length - tail.length);

  const parts: string[] = [];
  if (exitLine) parts.push(exitLine.trim());
  if (head.length) {
    parts.push("Key output:");
    parts.push(...head);
  }
  if (omitted) parts.push(`... [omitted ${omitted} lines] ...`);
  if (tail.length) {
    parts.push("Recent tail:");
    parts.push(...tail);
  }
  const summary = parts.join("\n").trim() || t;
  return truncateText(summary, limit);
}

function isHarnessUser(text: string): boolean {
  return HARNESS_USER_MARKERS.some((m) => text.includes(m));
}

function isHarnessSystem(text: string): boolean {
  return HARNESS_SYSTEM_MARKERS.some((m) => text.includes(m));
}

function messageCost(msg: IRMessage): number {
  let cost = contentToText(msg.content).length;
  const toolCalls = msg.tool_calls ?? [];
  for (const tc of toolCalls) {
    cost += tc.function.name.length;
    cost += tc.function.arguments.length;
  }
  return cost;
}

function messagesSize(messages: IRMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += messageCost(m);
    total += m.role.length;
  }
  return total;
}

function toolsSize(tools: unknown): number {
  try {
    return JSON.stringify(tools ?? []).length;
  } catch {
    return 0;
  }
}

function computeChars(ir: IRRequest): number {
  return messagesSize(ir.messages) + toolsSize(ir.tools);
}

function toolNameFromUnknown(tool: unknown): string {
  if (!tool || typeof tool !== "object") return "";
  const t = tool as Record<string, unknown>;
  const fn = (t.function as Record<string, unknown> | undefined) ?? t;
  const name = fn.name;
  return typeof name === "string" ? name : "";
}

export function looksLikeAgentic(ir: IRRequest): boolean {
  // check tools
  if (Array.isArray(ir.tools)) {
    for (const tool of ir.tools as unknown[]) {
      const name = toolNameFromUnknown(tool);
      if (name && AGENTIC_TOOL_NAMES.has(name)) return true;
    }
  }
  // check messages for harness markers
  for (const msg of ir.messages) {
    const text = contentToText(msg.content);
    if (isHarnessUser(text) || isHarnessSystem(text)) return true;
  }
  return false;
}

function shrinkJsonValue(value: unknown, depth = 0, key = ""): unknown {
  if (depth >= 4) return "<omitted>";
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (let idx = 0; idx < entries.length; idx++) {
      if (idx >= 12) {
        out["_omitted_keys"] = entries.length - idx;
        break;
      }
      const entry = entries[idx]!;
      const k = entry[0];
      const v = entry[1];
      out[k] = shrinkJsonValue(v, depth + 1, k);
    }
    return out;
  }
  if (Array.isArray(value)) {
    const arr = value as unknown[];
    const trimmed = arr.slice(0, 6).map((item) => shrinkJsonValue(item, depth + 1, key));
    if (arr.length > 6) trimmed.push(`<omitted ${arr.length - 6} items>`);
    return trimmed;
  }
  if (typeof value === "string") {
    const limit =
      key === "cmd" ||
      key === "chars" ||
      key === "patch" ||
      key === "content" ||
      key === "text" ||
      key === "question"
        ? 240
        : 120;
    return truncateText(value, limit);
  }
  return value;
}

function summarizeToolArgs(
  name: string,
  args: string,
  limit: number,
  truncated: string[],
  label: string,
): string {
  if (typeof args !== "string") {
    try {
      return JSON.stringify(args);
    } catch {
      return String(args);
    }
  }
  if (args.length <= limit) return args;
  if (name === "apply_patch") {
    truncated.push(label);
    return JSON.stringify({
      summary: "Large apply_patch payload omitted; a patch was prepared or applied in a previous step.",
    });
  }
  try {
    const parsed = JSON.parse(args) as unknown;
    const shrunk = shrinkJsonValue(parsed, 0, "");
    const str = JSON.stringify(shrunk);
    truncated.push(label);
    if (str.length > limit) return truncateText(str, limit);
    return str;
  } catch {
    truncated.push(label);
    const summary = truncateText(args, 320);
    return JSON.stringify({ summary });
  }
}

function projectSchema(schema: unknown, depth = 0): unknown {
  if (depth >= 6) return { type: "object" };
  if (schema !== null && typeof schema === "object" && !Array.isArray(schema)) {
    const rec = schema as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rec)) {
      if (!SCHEMA_KEEP_KEYS.has(key)) continue;
      if (key === "properties" && value !== null && typeof value === "object" && !Array.isArray(value)) {
        const props: Record<string, unknown> = {};
        for (const [prop, propSchema] of Object.entries(value as Record<string, unknown>)) {
          props[prop] = projectSchema(propSchema, depth + 1);
        }
        out.properties = props;
      } else if (key === "items") {
        out.items = projectSchema(value, depth + 1);
      } else if ((key === "oneOf" || key === "anyOf" || key === "allOf") && Array.isArray(value)) {
        out[key] = (value as unknown[]).slice(0, 6).map((item) => projectSchema(item, depth + 1));
      } else if (key === "additionalProperties" && value !== null && typeof value === "object" && !Array.isArray(value)) {
        out.additionalProperties = projectSchema(value, depth + 1);
      } else {
        out[key] = value;
      }
    }
    return Object.keys(out).length === 0 ? { type: "object" } : out;
  }
  if (Array.isArray(schema)) {
    return (schema as unknown[]).slice(0, 6).map((item) => projectSchema(item, depth + 1));
  }
  return schema;
}

function projectTools(tools: unknown, truncated: string[]): unknown {
  if (!Array.isArray(tools)) return tools;
  const arr = tools as unknown[];
  const projected: unknown[] = [];
  for (let idx = 0; idx < arr.length; idx++) {
    const tool = arr[idx];
    if (!tool || typeof tool !== "object") continue;
    const rec = tool as Record<string, unknown>;
    if (rec.type !== "function") continue;
    const fnRaw = (rec.function as Record<string, unknown> | undefined) ?? rec;
    const name = fnRaw.name;
    if (typeof name !== "string" || !name) continue;
    const outFn: Record<string, unknown> = { name };
    if ("parameters" in fnRaw) {
      const originalParams = fnRaw.parameters;
      const projectedParams = projectSchema(originalParams, 0);
      // detect truncation by comparing JSON length or keys
      try {
        const before = JSON.stringify(originalParams);
        const after = JSON.stringify(projectedParams);
        if (before !== after) truncated.push(`tool:${idx}:schema`);
      } catch {
        truncated.push(`tool:${idx}:schema`);
      }
      outFn.parameters = projectedParams;
    }
    if ("strict" in fnRaw) outFn.strict = fnRaw.strict;
    projected.push({ type: "function", function: outFn });
  }
  return projected;
}

function projectSingleMessage(
  msg: IRMessage,
  budgets: Budgets,
  truncated: string[],
  index: number,
): IRMessage | null {
  if (msg.role === "system") {
    const truncatedContent = truncateText(contentToText(msg.content), budgets.system);
    if (truncatedContent !== msg.content) truncated.push(`system:${index}`);
    return { ...msg, content: truncatedContent };
  }
  if (msg.role === "user") {
    const truncatedContent = truncateText(contentToText(msg.content), budgets.user);
    if (truncatedContent !== msg.content) truncated.push(`user:${index}`);
    return { ...msg, content: truncatedContent };
  }
  if (msg.role === "assistant") {
    const original = contentToText(msg.content);
    const newContent = summarizeFreeText(original, budgets.assistant);
    if (newContent !== original) truncated.push(`assistant:${index}`);
    let newToolCalls: IRMessage["tool_calls"] | undefined;
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      newToolCalls = msg.tool_calls.map((tc, tIdx) => {
        const newArgs = summarizeToolArgs(
          tc.function.name,
          tc.function.arguments,
          budgets.toolArgs,
          truncated,
          `assistant:${index}:tool:${tIdx}`,
        );
        return { ...tc, function: { ...tc.function, arguments: newArgs } };
      });
    }
    const out: IRMessage = { ...msg, content: newContent };
    if (newToolCalls) out.tool_calls = newToolCalls;
    else {
      // remove empty tool_calls to keep shape clean
      delete (out as { tool_calls?: unknown }).tool_calls;
    }
    return out;
  }
  if (msg.role === "tool") {
    const newContent = summarizeToolOutput(contentToText(msg.content), budgets.toolOutput);
    if (newContent !== contentToText(msg.content)) truncated.push(`tool:${index}`);
    return { ...msg, content: newContent };
  }
  // fallback for unknown roles (should not happen via IR validation, but handle)
  const truncatedContent = truncateText(contentToText(msg.content), budgets.assistant);
  if (truncatedContent !== contentToText(msg.content)) truncated.push(`${msg.role}:${index}`);
  return { ...msg, content: truncatedContent };
}

function chooseTailStart(messages: IRMessage[], maxMessages: number, totalTail: number): number {
  if (messages.length === 0) return 0;
  let start = messages.length - 1;
  let total = 0;
  let kept = 0;
  for (let idx = messages.length - 1; idx >= 0; idx--) {
    const m = messages[idx]!;
    const cost = messageCost(m);
    if (kept > 0 && (kept >= maxMessages || total + cost > totalTail)) break;
    start = idx;
    total += cost;
    kept += 1;
  }
  return start;
}

function expandTailForToolContext(messages: IRMessage[], start: number): number {
  if (start <= 0 || messages.length === 0) return start;
  const needed = new Set<string>();
  for (let i = start; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "tool" && m.tool_call_id) needed.add(m.tool_call_id);
  }
  if (needed.size === 0) return start;
  let expanded = start;
  for (let idx = start - 1; idx >= 0; idx--) {
    const m = messages[idx]!;
    if (m.role !== "assistant" || !m.tool_calls) continue;
    const ids = new Set(m.tool_calls.map((tc) => tc.id).filter(Boolean) as string[]);
    let intersect = false;
    for (const id of ids) {
      if (needed.has(id)) {
        intersect = true;
        break;
      }
    }
    if (intersect) {
      expanded = idx;
      for (const id of ids) needed.delete(id);
      if (needed.size === 0) break;
    }
  }
  return expanded;
}

function findLatestUser(messages: IRMessage[]): number | null {
  for (let idx = messages.length - 1; idx >= 0; idx--) {
    if (messages[idx]!.role === "user") return idx;
  }
  return null;
}

function buildToolCallNameMap(messages: IRMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      if (tc.id && tc.function.name) map.set(tc.id, tc.function.name);
    }
  }
  return map;
}

function toolOutputInlineSummary(text: string): string {
  const summarized = summarizeToolOutput(text, MAX_TOOL_OUTPUT_CHARS);
  return truncateText(summarized.replace(/\n/g, " | "), 220);
}

function historyLine(msg: IRMessage, toolNameByCallId: Map<string, string>): string {
  const role = msg.role;
  const text = contentToText(msg.content);
  if (role === "user") {
    return `User asked: ${truncateText(text, 220)}`;
  }
  if (role === "assistant") {
    const toolNames =
      msg.tool_calls?.map((tc) => tc.function.name).filter((n): n is string => Boolean(n)) ?? [];
    if (text && toolNames.length > 0) {
      return `Assistant replied: ${truncateText(text, 160)} Then called tools: ${toolNames.slice(0, 4).join(", ")}.`;
    }
    if (toolNames.length > 0) return `Assistant called tools: ${toolNames.slice(0, 4).join(", ")}.`;
    if (text) return `Assistant replied: ${truncateText(text, 180)}`;
    return "";
  }
  if (role === "tool") {
    const toolName = toolNameByCallId.get(msg.tool_call_id ?? "") ?? "tool";
    const summary = toolOutputInlineSummary(text);
    return `Tool ${toolName} returned: ${summary}`;
  }
  if (role === "system") {
    return `System guidance: ${truncateText(text, 180)}`;
  }
  return "";
}

function buildHistorySummary(
  messages: IRMessage[],
  toolNameByCallId: Map<string, string>,
): string {
  if (messages.length === 0) return "";
  const lines: string[] = [];
  let total = 0;
  let summarized = 0;
  for (const msg of messages) {
    const line = historyLine(msg, toolNameByCallId);
    if (!line) continue;
    if (summarized >= MAX_HISTORY_ITEMS || total + line.length > MAX_HISTORY_SUMMARY_CHARS) break;
    lines.push(`- ${line}`);
    total += line.length;
    summarized += 1;
  }
  const remaining = messages.length - summarized;
  if (remaining > 0) {
    lines.push(`- ${remaining} earlier messages or tool results were further condensed.`);
  }
  if (lines.length === 0) return "";
  // Simple fallback if too heavy: keep at least indicator
  return `${HISTORY_PREFIX}\n${lines.join("\n")}`;
}

function mergeGuidance(messages: string[], limit: number): string {
  if (messages.length === 0) return "";
  const capped = messages.slice(0, 2);
  const merged: string[] = [];
  let total = 0;
  for (const msg of capped) {
    const text = msg.trim();
    if (!text) continue;
    if (total + text.length > limit) {
      const remain = limit - total;
      if (remain > 0) merged.push(truncateText(text, remain));
      break;
    }
    merged.push(text);
    total += text.length;
    if (total >= limit) break;
  }
  if (merged.length === 0) return "";
  if (merged.length === 1) return merged[0]!;
  return `Additional instructions:\n${merged.join("\n\n")}`;
}

function applyConservative(
  ir: IRRequest,
  budgets: Budgets,
  truncated: string[],
): IRRequest {
  const outMessages: IRMessage[] = [];
  for (let idx = 0; idx < ir.messages.length; idx++) {
    const msg = ir.messages[idx]!;
    const projected = projectSingleMessage(msg, budgets, truncated, idx);
    if (projected) outMessages.push(projected);
  }
  const projectedTools = projectTools(ir.tools, truncated);
  return { ...ir, messages: outMessages, tools: projectedTools as unknown as IRRequest["tools"] };
}

function applyAggressive(
  ir: IRRequest,
  budgets: Budgets,
  truncated: string[],
): IRRequest {
  const originalMessages = ir.messages;
  const toolNameByCallId = buildToolCallNameMap(originalMessages as IRMessage[]);
  const preservedGuidance: string[] = [];
  const conversation: IRMessage[] = [];
  let droppedHarness = 0;

  for (let idx = 0; idx < originalMessages.length; idx++) {
    const msg = originalMessages[idx]! as IRMessage;
    const text = contentToText(msg.content);
    if (msg.role === "system") {
      if (isHarnessSystem(text)) {
        droppedHarness += 1;
        truncated.push(`dropped:harness:system:${idx}`);
        continue;
      }
      const truncatedText = truncateText(text, budgets.system);
      if (truncatedText !== text) truncated.push(`system:guidance:${idx}`);
      if (truncatedText) preservedGuidance.push(truncatedText);
      continue;
    }
    if (msg.role === "user" && isHarnessUser(text)) {
      droppedHarness += 1;
      truncated.push(`dropped:harness:user:${idx}`);
      continue;
    }
    const projected = projectSingleMessage(msg, budgets, truncated, idx);
    if (projected) conversation.push(projected);
  }

  // If conversation is empty (all harness), fallback to conservative projection of original without harness check
  if (conversation.length === 0 && originalMessages.length > 0) {
    // fallback: do conservative on original (but still drop harness)
    // If still empty, keep at most truncated messages that were not harness system?
    // Just return base prompt only — IR validation requires at least one message, but aggressive with all harness
    // will still have BASE_SYSTEM_PROMPT, so it's okay to have empty conversation.
  }

  let tailStart = chooseTailStart(conversation, budgets.maxMessages, budgets.totalTail);
  tailStart = expandTailForToolContext(conversation, tailStart);
  const latestUserIdx = findLatestUser(conversation);
  let anchorUser: IRMessage | null = null;
  if (latestUserIdx !== null && latestUserIdx < tailStart) {
    anchorUser = conversation[latestUserIdx]!;
  }

  const omitted: IRMessage[] = [];
  for (let idx = 0; idx < tailStart; idx++) {
    if (latestUserIdx !== null && idx === latestUserIdx && anchorUser) continue;
    omitted.push(conversation[idx]!);
  }

  const finalMessages: IRMessage[] = [{ role: "system", content: BASE_SYSTEM_PROMPT }];
  const guidanceMsg = mergeGuidance(preservedGuidance, budgets.system);
  if (guidanceMsg) finalMessages.push({ role: "system", content: guidanceMsg });
  const historySummary = buildHistorySummary(omitted, toolNameByCallId);
  if (historySummary) {
    finalMessages.push({ role: "system", content: historySummary });
    truncated.push(`history:${omitted.length}`);
  }
  if (anchorUser) finalMessages.push(anchorUser);
  finalMessages.push(...conversation.slice(tailStart));

  // If for some reason final is just base prompt, ensure at least that remains
  if (finalMessages.length === 0) {
    finalMessages.push({ role: "system", content: BASE_SYSTEM_PROMPT });
  }

  const projectedTools = projectTools(ir.tools, truncated);

  // Track dropped count via truncated marker
  if (droppedHarness > 0 || omitted.length > 0) {
    // already pushed markers
  }

  return {
    ...ir,
    messages: finalMessages,
    tools: projectedTools as unknown as IRRequest["tools"],
  };
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export function projectIRRequest(
  ir: IRRequest,
  opts: ProjectionOpts,
): { ir: IRRequest; dryRunDiff?: { beforeChars: number; afterChars: number; dropped: number; truncated: string[] } } {
  const budgets = resolveBudgets(opts.budgets);
  const beforeChars = computeChars(ir);
  const beforeCount = ir.messages.length;

  // Deep clone to avoid mutating original
  const working = deepClone(ir);

  let result: IRRequest;
  const truncated: string[] = [];

  if (opts.mode === "off") {
    result = working;
  } else if (opts.mode === "conservative") {
    result = applyConservative(working, budgets, truncated);
  } else if (opts.mode === "aggressive") {
    result = applyAggressive(working, budgets, truncated);
  } else {
    // exhaustive check
    const _exhaustive: never = opts.mode;
    throw new Error(`unknown projection mode: ${_exhaustive as string}`);
  }

  const afterChars = computeChars(result);
  const afterCount = result.messages.length;
  // dropped: net messages removed (positive means net removal). For aggressive, also account for harness/omitted.
  // Use simple net difference, but ensure at least 0.
  const dropped = Math.max(0, beforeCount - afterCount);

  // For aggressive, if we added summary but dropped many, net may undercount; we want dropped to reflect omitted+harness.
  // If mode aggressive and truncated contains harness/history markers, ensure dropped reflects omitted count.
  // We compute alternative dropped as count of original not retained in tail/anchor, if larger than net.
  let effectiveDropped = dropped;
  if (opts.mode === "aggressive") {
    // Count harness markers as dropped
    const harnessDropped = truncated.filter((t) => t.startsWith("dropped:harness")).length;
    const historyOmitted = truncated.find((t) => t.startsWith("history:")) ? parseInt(truncated.find((t) => t.startsWith("history:"))!.split(":")[1] ?? "0", 10) : 0;
    const alt = harnessDropped + historyOmitted;
    // Also if tailStart logic dropped messages, alt may be more accurate
    if (alt > effectiveDropped) effectiveDropped = alt;
  }

  if (opts.dryRun) {
    return {
      ir: result,
      dryRunDiff: {
        beforeChars,
        afterChars,
        dropped: effectiveDropped,
        truncated: [...truncated],
      },
    };
  }

  return { ir: result };
}
