import { describe, expect, test } from "bun:test";
import { sanitizeSystemText, sanitizeUpstreamBody } from "../src/upstream/sanitize";

describe("sanitizeSystemText", () => {
  test("rewrites competitor brand strings", () => {
    expect(sanitizeSystemText("You are Claude Code, Anthropic's CLI")).not.toMatch(/claude|anthropic/i);
    expect(sanitizeSystemText("Use Sonnet or Opus, never Haiku")).not.toMatch(/sonnet|opus|haiku/i);
  });

  test("keeps plain text untouched", () => {
    const t = "You are a helpful assistant.";
    expect(sanitizeSystemText(t)).toBe(t);
  });

  test("case-insensitive", () => {
    expect(sanitizeSystemText("CLAUDE and ANTHROPIC")).not.toMatch(/CLAUDE|ANTHROPIC/);
  });
});

describe("sanitizeUpstreamBody", () => {
  test("only touches system messages", () => {
    const body = {
      model: "hy3",
      stream: true,
      messages: [
        { role: "system", content: "You are Claude Code." },
        { role: "user", content: "help me edit .claude/settings.json for claude" },
      ],
    };
    const out = sanitizeUpstreamBody(body);
    expect(out.messages![0]!.content as string).not.toMatch(/claude/i);
    // user content preserved verbatim — code discussing .claude files works
    expect(out.messages![1]!.content).toContain(".claude");
    expect(out.model).toBe("hy3");
  });
  test("strips claude-code environment context lines", () => {
    const sys = "Intro.\n\nCurrent branch: main\n\nMain branch (you will usually use this for PRs): main\n\nGit user: trefeon\n\nStatus:\nM src/a.ts\n?? out/x\n\nRest of prompt.";
    const out = sanitizeSystemText(sys);
    expect(out).not.toMatch(/Current branch|Git user|trefeon/);
    expect(out).toContain("Rest of prompt.");
  });

  test("returns same reference when nothing to change", () => {
    const body = { messages: [{ role: "system", content: "clean" }, { role: "user", content: "hi" }] };
    expect(sanitizeUpstreamBody(body)).toBe(body);
  });
});
