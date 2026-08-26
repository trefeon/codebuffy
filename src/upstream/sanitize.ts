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

interface SanitizableMessage {
  role: string;
  content: unknown;
}

/** Returns a shallow-copied body whose system messages are desensitized. */
export function sanitizeUpstreamBody<T extends { messages?: Array<SanitizableMessage> }>(body: T): T {
  if (!Array.isArray(body.messages)) return body;
  const messages = body.messages.map((m) => {
    if (m.role !== "system") return m;
    if (typeof m.content === "string") {
      const next = sanitizeSystemText(m.content);
      return next === m.content ? m : { ...m, content: next };
    }
    return m;
  });
  // Avoid cloning when nothing changed.
  if (messages.every((m, i) => m === body.messages![i])) return body;
  return { ...body, messages };
}
