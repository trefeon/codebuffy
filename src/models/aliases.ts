/**
 * Model alias resolution — maps harness-native model names (Claude Code sends
 * `claude-sonnet-4-5`, Codex sends codex variants, legacy clients send
 * `gpt-4o`…) onto models that actually exist on the CodeBuddy backend.
 * Exact catalog ids pass through untouched; unknown names pass through so the
 * upstream error stays visible instead of a silent surprise substitution.
 */
import { loadCatalog } from "./catalog";

/** Ordered prefix rules — first match wins. */
export const ALIAS_RULES: ReadonlyArray<readonly [prefix: string, target: string]> = [
  ["claude-opus-", "glm-5.2"],
  ["claude-sonnet-", "glm-5.2"],
  ["claude-haiku-", "hy3"],
  ["claude-3-", "glm-5.2"],
  ["gpt-4o", "glm-5.2"],
  ["gpt-4.1", "glm-5.2"],
  ["o1-", "glm-5.2"],
  ["o3", "glm-5.2"],
  ["o4-mini", "kimi-k2.6"],
  ["deepseek-reasoner", "deepseek-v4-pro"],
  ["deepseek-chat", "deepseek-v4-flash"],
];

/** Ids that are valid as-is everywhere (pass-through, no resolution). */
const PASS_THROUGH = new Set(["auto", "default"]);

let catalogIds: Set<string> | null = null;
function catalogIdSet(): Set<string> {
  if (!catalogIds) {
    catalogIds = new Set(loadCatalog().map((m) => m.id));
  }
  return catalogIds;
}


/**
 * CodeBuddy upstream rejects requests whose first message is not a system
 * prompt (code 11128). Many OpenAI-style clients omit it — inject a minimal
 * one so harnesses work out of the box.
 */
export function ensureLeadingSystem<T extends { messages: Array<{ role: string; content: string }> }>(ir: T): T {
  const first = ir.messages[0];
  if (first && first.role === "system" && first.content.trim().length > 0) return ir;
  return {
    ...ir,
    messages: [{ role: "system", content: "You are a helpful assistant." }, ...ir.messages],
  };
}

export function resolveModelId(model: string): string {
  if (!model) return model;
  if (PASS_THROUGH.has(model)) return model;
  if (catalogIdSet().has(model)) return model;
  for (const [prefix, target] of ALIAS_RULES) {
    if (model.startsWith(prefix)) return target;
  }
  return model;
}
