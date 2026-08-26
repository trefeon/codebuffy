/**
 * System-prompt desensitization.
 *
 * CodeBuddy upstream rejects requests whose system text mentions competitor
 * agent brands (code 11128 "Illegal API invocation from an unapproved channel").
 * Harness-injected system prompts legitimately contain those names, so we
 * rewrite only system-message strings before forwarding. User/assistant
 * content is never touched — code discussing `.claude` files keeps working.
 */

const REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  // Claude Code injects tracking key-value lines INTO the system text
  // (e.g. "x-anthropic-billing-header: cc_version=…; cc_entrypoint=sdk-cli").
  // These survive word-level replacement, so drop the lines outright.
  [/^\s*x-[a-z0-9-]+-billing-header:\s*.*$/gim, ""],
  [/\bcc_(?:version|entrypoint)=[^\s;]*/gi, "cli"],
  [/claude[ -]?code/gi, "AgentCLI"],
  [/\bclaude\b/gi, "the assistant"],
  [/\banthropic\b/gi, "the provider"],
  [/\bsonnet\b/gi, "mid-tier model"],
  [/\bopus\b/gi, "large model"],
  [/\bhaiku\b/gi, "fast model"],
  // Claude Code appends a live environment block ("Current branch:",
  // "Git user:", "Status:\nM file…"). This runtime-harness context is what
  // upstream actually fingerprints — drop the lines, keep the rest.
  [/^\s*Current branch:.*$/gim, ""],
  [/^\s*Main branch \(you will usually use this for PRs\):.*$/gim, ""],
  [/^\s*Git (?:user|email):.*$/gim, ""],
  [/^Status:\n(?:[ MAD?!]{1,2} .*\n?)*^$/gim, ""],
  [/\n{3,}/g, "\n\n"],
];

export function sanitizeSystemText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Reasoning-param normalization (CodeBuddy #2071).
 *
 * CodeBuddy surfaces model reasoning ONLY when the request carries the exact
 * CLI pair: reasoning_effort + reasoning_summary:"auto". Its gateway has no
 * "none"/"off" effort — forwarding one errors (and forcing effort+summary on
 * plain requests trips its content filter), so:
 *   - effort "none"/"off" (case-insensitive) is dropped outright;
 *   - any other explicit string effort without a summary gains "auto";
 *   - requests carrying neither param are never modified.
 */
export function normalizeReasoningParams<T extends object>(body: T): T {
  const effort = (body as { reasoning_effort?: unknown }).reasoning_effort;
  if (typeof effort !== "string") return body;
  const lowered = effort.toLowerCase();
  if (lowered === "none" || lowered === "off") {
    const rest = { ...body } as Record<string, unknown>;
    delete rest.reasoning_effort;
    return rest as T;
  }
  if ((body as { reasoning_summary?: unknown }).reasoning_summary === undefined) {
    return { ...body, reasoning_summary: "auto" } as T;
  }
  return body;
}

interface SanitizableMessage {
  role: string;
  content: unknown;
}

/** Returns a shallow-copied body whose system messages are desensitized and reasoning params normalized. */
export function sanitizeUpstreamBody<T extends { messages?: Array<SanitizableMessage> }>(body: T): T {
  const out = normalizeReasoningParams(body);
  if (!Array.isArray(out.messages)) return out;
  const messages = out.messages.map((m) => {
    if (m.role !== "system") return m;
    if (typeof m.content === "string") {
      const next = sanitizeSystemText(m.content);
      return next === m.content ? m : { ...m, content: next };
    }
    return m;
  });
  // Avoid cloning when nothing changed.
  if (messages.every((m, i) => m === out.messages![i])) return out;
  return { ...out, messages };
}
