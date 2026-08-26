import { describe, expect, test } from "bun:test";
import { normalizeReasoningParams, sanitizeSystemText, sanitizeUpstreamBody } from "../src/upstream/sanitize";

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

describe("normalizeReasoningParams", () => {
  test("deletes reasoning_effort 'none' (case-insensitive)", () => {
    expect(normalizeReasoningParams({ reasoning_effort: "none" }) as Record<string, unknown>).toEqual({});
    expect(normalizeReasoningParams({ reasoning_effort: "None" })).not.toHaveProperty("reasoning_effort");
    const body = { model: "hy3", stream: true, reasoning_effort: "NONE", messages: [] };
    const out = normalizeReasoningParams(body) as Record<string, unknown>;
    expect(out).not.toHaveProperty("reasoning_effort");
    expect(out.model).toBe("hy3");
  });

  test("deletes reasoning_effort 'off' (case-insensitive)", () => {
    expect(normalizeReasoningParams({ reasoning_effort: "off" }) as Record<string, unknown>).toEqual({});
    expect(normalizeReasoningParams({ reasoning_effort: "OFF" })).not.toHaveProperty("reasoning_effort");
    // input body is never mutated
    const body = { reasoning_effort: "Off" };
    normalizeReasoningParams(body);
    expect(body).toHaveProperty("reasoning_effort", "Off");
  });

  test("effort without summary gains reasoning_summary 'auto'", () => {
    expect(normalizeReasoningParams({ reasoning_effort: "high" }) as Record<string, unknown>).toEqual({
      reasoning_effort: "high",
      reasoning_summary: "auto",
    });
    const out = normalizeReasoningParams({ reasoning_effort: "medium", temperature: 0 });
    expect((out as { reasoning_summary?: string }).reasoning_summary).toBe("auto");
  });

  test("effort with existing summary is untouched", () => {
    const body = { reasoning_effort: "high", reasoning_summary: "detailed" };
    expect(normalizeReasoningParams(body)).toBe(body);
  });

  test("no effort leaves request untouched", () => {
    const body = { model: "hy3", messages: [] };
    const out = normalizeReasoningParams(body);
    expect(out).toBe(body);
    expect(out).not.toHaveProperty("reasoning_summary");
  });

  test("non-string effort values pass through unchanged", () => {
    for (const effort of [5, true, null, { level: "high" }]) {
      const body = { reasoning_effort: effort };
      expect(normalizeReasoningParams(body)).toBe(body);
    }
  });
});

describe("sanitizeUpstreamBody reasoning normalization", () => {
  test("drops none/off effort alongside system desensitization", () => {
    const body = {
      model: "hy3",
      reasoning_effort: "none",
      messages: [{ role: "system", content: "You are Claude Code." }],
    };
    const out = sanitizeUpstreamBody(body);
    expect(out).not.toHaveProperty("reasoning_effort");
    expect(out.messages![0]!.content as string).not.toMatch(/claude/i);
  });

  test("mirrors CLI reasoning_summary:auto when effort present without summary", () => {
    const out = sanitizeUpstreamBody({ reasoning_effort: "High", messages: [] });
    expect(out.reasoning_effort).toBe("High");
    expect((out as { reasoning_summary?: string }).reasoning_summary).toBe("auto");
  });
});
