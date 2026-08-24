import { describe, it, expect } from "bun:test";
import {
  AGENTIC_TOOL_NAMES,
  BASE_SYSTEM_PROMPT,
  HARNESS_SYSTEM_MARKERS,
  HARNESS_USER_MARKERS,
  HISTORY_PREFIX,
  MAX_ASSISTANT_CHARS,
  MAX_SYSTEM_GUIDANCE_CHARS,
  MAX_TAIL_CHARS,
  MAX_TAIL_MESSAGES,
  MAX_TOOL_ARGS_CHARS,
  MAX_TOOL_OUTPUT_CHARS,
  MAX_USER_CHARS,
  SCHEMA_KEEP_KEYS,
  looksLikeAgentic,
  projectIRRequest,
} from "../src/adapters/responses/projection";
import type { IRMessage, IRRequest } from "../src/ir/types";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function msg(
  role: IRMessage["role"],
  content: string,
  extra: Partial<IRMessage> = {},
): IRMessage {
  return { role, content, ...extra };
}

function ir(
  messages: IRMessage[],
  tools?: unknown,
  extra: Partial<IRRequest> = {},
): IRRequest {
  return { model: "gpt-4o", messages, tools: tools as IRRequest["tools"], ...extra };
}

function repeat(char: string, len: number): string {
  return char.repeat(len);
}

// ---------------------------------------------------------------------------
// constants / contract
// ---------------------------------------------------------------------------

describe("projection constants", () => {
  it("budgets match research/03 contract", () => {
    expect(MAX_SYSTEM_GUIDANCE_CHARS).toBe(1200);
    expect(MAX_USER_CHARS).toBe(3200);
    expect(MAX_ASSISTANT_CHARS).toBe(1800);
    expect(MAX_TOOL_OUTPUT_CHARS).toBe(1600);
    expect(MAX_TOOL_ARGS_CHARS).toBe(900);
    expect(MAX_TAIL_CHARS).toBe(7000);
    expect(MAX_TAIL_MESSAGES).toBe(8);
  });

  it("AGENTIC_TOOL_NAMES contains expected harness tools", () => {
    expect(AGENTIC_TOOL_NAMES.has("exec_command")).toBe(true);
    expect(AGENTIC_TOOL_NAMES.has("write_stdin")).toBe(true);
    expect(AGENTIC_TOOL_NAMES.has("apply_patch")).toBe(true);
    expect(AGENTIC_TOOL_NAMES.has("request_user_input")).toBe(true);
    expect(AGENTIC_TOOL_NAMES.has("unknown_tool")).toBe(false);
  });

  it("BASE_SYSTEM_PROMPT is base replacement", () => {
    expect(BASE_SYSTEM_PROMPT).toBe("You are a helpful assistant.");
  });

  it("SCHEMA_KEEP_KEYS whitelist is exhaustive", () => {
    expect(SCHEMA_KEEP_KEYS.has("type")).toBe(true);
    expect(SCHEMA_KEEP_KEYS.has("properties")).toBe(true);
    expect(SCHEMA_KEEP_KEYS.has("required")).toBe(true);
    expect(SCHEMA_KEEP_KEYS.has("additionalProperties")).toBe(true);
    expect(SCHEMA_KEEP_KEYS.has("description")).toBe(false);
    expect(SCHEMA_KEEP_KEYS.has("title")).toBe(false);
  });

  it("HARNESS markers non-empty", () => {
    expect(HARNESS_USER_MARKERS.length).toBeGreaterThan(0);
    expect(HARNESS_SYSTEM_MARKERS.length).toBeGreaterThan(0);
    expect(HARNESS_USER_MARKERS).toContain("# AGENTS.md instructions");
    expect(HARNESS_SYSTEM_MARKERS).toContain("You are a coding agent running in the Codex CLI");
  });
});

// ---------------------------------------------------------------------------
// looksLikeAgentic
// ---------------------------------------------------------------------------

describe("looksLikeAgentic", () => {
  it("false when no agentic tool and no harness markers", () => {
    const r = ir([msg("user", "hello"), msg("assistant", "hi")]);
    expect(looksLikeAgentic(r)).toBe(false);
  });

  it("true when tool name is agentic", () => {
    const r = ir([msg("user", "hi")], [{ type: "function", function: { name: "exec_command" } }]);
    expect(looksLikeAgentic(r)).toBe(true);
  });

  it("true when harness system marker present", () => {
    const r = ir([msg("system", "You are a coding agent running in the Codex CLI")]);
    expect(looksLikeAgentic(r)).toBe(true);
  });

  it("true when harness user marker present", () => {
    const r = ir([msg("user", "prefix # AGENTS.md instructions suffix")]);
    expect(looksLikeAgentic(r)).toBe(true);
  });

  it("false for non-agentic tool", () => {
    const r = ir([msg("user", "hi")], [{ type: "function", function: { name: "search" } }]);
    expect(looksLikeAgentic(r)).toBe(false);
  });

  it("true when any marker among multiple messages", () => {
    const r = ir([
      msg("user", "hello"),
      msg("system", "Within this context, Codex refers to something"),
    ]);
    expect(looksLikeAgentic(r)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// conservative truncation per role
// ---------------------------------------------------------------------------

describe("conservative truncation", () => {
  it("truncates system over 1200", () => {
    const longSys = repeat("s", 2000);
    const r = ir([msg("system", longSys), msg("user", "hi")]);
    const out = projectIRRequest(r, { mode: "conservative" });
    expect(out.ir.messages[0]!.content.length).toBeLessThanOrEqual(1200 + 30); // allow "[truncated ...]" suffix
    expect(out.ir.messages[0]!.content).toContain("[truncated");
  });

  it("truncates user over 3200", () => {
    const longUser = repeat("u", 4000);
    const r = ir([msg("user", longUser)]);
    const out = projectIRRequest(r, { mode: "conservative" });
    expect(out.ir.messages[0]!.content.length).toBeLessThan(longUser.length);
    expect(out.ir.messages[0]!.content).toContain("[truncated");
  });

  it("summarizes assistant over 1800", () => {
    const longAsst = repeat("a", 3000);
    const r = ir([msg("assistant", longAsst)]);
    const out = projectIRRequest(r, { mode: "conservative" });
    expect(out.ir.messages[0]!.content.length).toBeLessThan(longAsst.length);
    expect(out.ir.messages[0]!.content).toContain("omitted");
  });

  it("summarizes tool output over 1600 via Key output / omitted", () => {
    const bigOutput = `${repeat("line\n", 50)}Process exited with code 0\n${repeat("tail\n", 50)}`;
    const r = ir([msg("tool", bigOutput, { tool_call_id: "call_1" })]);
    const out = projectIRRequest(r, { mode: "conservative" });
    expect(out.ir.messages[0]!.content.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS + 30);
    // summarizeToolOutput emits Key output or truncated marker
    expect(out.ir.messages[0]!.content.length).toBeLessThan(bigOutput.length);
  });

  it("shrinks tool args over 900 via JSON shrink", () => {
    const bigArgs = JSON.stringify({ cmd: repeat("x", 2000), extra: repeat("y", 2000) });
    const r = ir([
      msg("assistant", "ans", {
        tool_calls: [{ id: "call_1", type: "function", function: { name: "exec_command", arguments: bigArgs } }],
      }),
    ]);
    const out = projectIRRequest(r, { mode: "conservative" });
    const outArgs = out.ir.messages[0]!.tool_calls![0]!.function.arguments;
    expect(outArgs.length).toBeLessThan(bigArgs.length);
    expect(outArgs.length).toBeLessThanOrEqual(1000); // shrunk under budget (plus JSON wrapper)
  });

  it("replaces large apply_patch args with summary", () => {
    const patchArgs = JSON.stringify({ patch: repeat("p", 5000), cmd: "apply" });
    const r = ir([
      msg("assistant", "ans", {
        tool_calls: [{ id: "call_1", type: "function", function: { name: "apply_patch", arguments: patchArgs } }],
      }),
    ]);
    const out = projectIRRequest(r, { mode: "conservative" });
    const outArgs = out.ir.messages[0]!.tool_calls![0]!.function.arguments;
    expect(outArgs).toContain("Large apply_patch payload omitted");
    expect(JSON.parse(outArgs).summary).toBeDefined();
  });

  it("keeps conservative harness markers (does not drop)", () => {
    const r = ir([
      msg("system", "You are a coding agent running in the Codex CLI"),
      msg("user", "# AGENTS.md instructions hello"),
    ]);
    const out = projectIRRequest(r, { mode: "conservative" });
    // conservative should keep both messages (maybe truncated but not dropped)
    expect(out.ir.messages.length).toBe(2);
    expect(out.ir.messages.some((m) => m.content.includes("Codex CLI"))).toBe(true);
  });

  it("does not mutate original IR", () => {
    const longSys = repeat("z", 5000);
    const original = ir([msg("system", longSys)]);
    const copyLen = original.messages[0]!.content.length;
    projectIRRequest(original, { mode: "conservative" });
    expect(original.messages[0]!.content.length).toBe(copyLen);
  });
});

// ---------------------------------------------------------------------------
// aggressive detection / harness drop / system replacement
// ---------------------------------------------------------------------------

describe("aggressive projection", () => {
  it("drops harness user marker", () => {
    const r = ir([
      msg("user", "prefix # AGENTS.md instructions with env"),
      msg("user", "real question"),
    ]);
    const out = projectIRRequest(r, { mode: "aggressive" });
    expect(out.ir.messages.some((m) => m.content.includes("# AGENTS.md instructions"))).toBe(false);
    expect(out.ir.messages.some((m) => m.content === "real question")).toBe(true);
  });

  it("drops harness system marker", () => {
    const r = ir([
      msg("system", "You are a coding agent running in the Codex CLI and more"),
      msg("user", "hello"),
    ]);
    const out = projectIRRequest(r, { mode: "aggressive" });
    expect(out.ir.messages.some((m) => m.content.includes("You are a coding agent running in the Codex CLI"))).toBe(false);
  });

  it("replaces system with BASE_SYSTEM_PROMPT", () => {
    const r = ir([msg("system", "custom system"), msg("user", "hi")]);
    const out = projectIRRequest(r, { mode: "aggressive" });
    expect(out.ir.messages[0]!.role).toBe("system");
    expect(out.ir.messages[0]!.content).toBe(BASE_SYSTEM_PROMPT);
  });

  it("preserves non-harness guidance as second system with Additional instructions", () => {
    const r = ir([
      msg("system", "custom guidance here"),
      msg("system", "second guidance"),
      msg("user", "hello"),
    ]);
    const out = projectIRRequest(r, { mode: "aggressive" });
    expect(out.ir.messages[0]!.content).toBe(BASE_SYSTEM_PROMPT);
    expect(out.ir.messages[1]!.content).toContain("Additional instructions:");
    expect(out.ir.messages[1]!.content).toContain("custom guidance here");
  });

  it("preserves only guidance up to 1200 chars", () => {
    const longGuidance = repeat("g", 2000);
    const r = ir([msg("system", longGuidance), msg("user", "hi")]);
    const out = projectIRRequest(r, { mode: "aggressive" });
    // second system should be truncated to 1200
    expect(out.ir.messages[1]!.content.length).toBeLessThanOrEqual(1250);
  });

  it("anchor keeps latest user before tail when tail omits users", () => {
    const msgs: IRMessage[] = [];
    for (let i = 0; i < 5; i++) msgs.push(msg("user", `anchor-user-${i} ` + repeat("x", 100)));
    for (let i = 0; i < 5; i++) msgs.push(msg("assistant", `assistant-${i} ` + repeat("y", 100)));
    const r = ir(msgs);
    const out = projectIRRequest(r, {
      mode: "aggressive",
      budgets: { maxMessages: 3, totalTail: 7000 },
    });
    // anchor-user-4 should be preserved even though tailStart is beyond it
    expect(out.ir.messages.some((m) => m.content.includes("anchor-user-4"))).toBe(true);
    // should also have history summary
    expect(out.ir.messages.some((m) => m.content.startsWith(HISTORY_PREFIX))).toBe(true);
  });

  it("tail expansion includes linked assistant when tool output in tail", () => {
    const msgs: IRMessage[] = [];
    for (let i = 0; i < 6; i++) msgs.push(msg("user", `u${i}`));
    msgs.push(
      msg("assistant", "call tool", {
        tool_calls: [{ id: "call_xyz", type: "function", function: { name: "exec_command", arguments: "{}" } }],
      }),
    );
    msgs.push(msg("tool", "tool result " + repeat("z", 100), { tool_call_id: "call_xyz" }));
    msgs.push(msg("user", "final user"));
    const r = ir(msgs);
    const out = projectIRRequest(r, {
      mode: "aggressive",
      budgets: { maxMessages: 2, totalTail: 5000 },
    });
    // tail 2 would be [tool, final user] but expansion should bring assistant
    const hasAssistantCall = out.ir.messages.some(
      (m) => m.role === "assistant" && m.tool_calls?.some((tc) => tc.id === "call_xyz"),
    );
    expect(hasAssistantCall).toBe(true);
    const hasTool = out.ir.messages.some((m) => m.role === "tool" && m.tool_call_id === "call_xyz");
    expect(hasTool).toBe(true);
  });

  it("totalTail budget enforced", () => {
    const longMsgs: IRMessage[] = [];
    for (let i = 0; i < 10; i++) longMsgs.push(msg("user", repeat("x", 2000)));
    const r = ir(longMsgs);
    const out = projectIRRequest(r, {
      mode: "aggressive",
      budgets: { maxMessages: 20, totalTail: 3000 },
    });
    // with totalTail 3000, only last messages fitting within 3000 should be kept plus summary
    // expect overall tail messages (excluding system+history) to be small
    const tailAfterHistory = out.ir.messages.filter((m) => m.role === "user" && m.content.startsWith("x"));
    expect(tailAfterHistory.length).toBeLessThan(5);
    expect(tailAfterHistory.length).toBeGreaterThan(0);
  });

  it("maxMessages enforced via tail", () => {
    const msgs: IRMessage[] = [];
    for (let i = 0; i < 15; i++) msgs.push(msg("user", `msg-${i}`));
    const r = ir(msgs);
    const out = projectIRRequest(r, { mode: "aggressive" });
    // default max 8, plus 2 system + history (+ anchor if needed) => user/assistant tail limited
    const nonSystem = out.ir.messages.filter((m) => m.role !== "system");
    expect(nonSystem.length).toBeLessThanOrEqual(MAX_TAIL_MESSAGES + 1); // +1 for anchor
  });

  it("history summary uses HISTORY_PREFIX and includes summarized lines", () => {
    const msgs: IRMessage[] = [];
    for (let i = 0; i < 20; i++) msgs.push(msg("user", `history-msg-${i} hello`));
    const r = ir(msgs);
    const out = projectIRRequest(r, { mode: "aggressive" });
    const hist = out.ir.messages.find((m) => m.content.startsWith(HISTORY_PREFIX));
    expect(hist).toBeDefined();
    expect(hist!.content).toContain("User asked:");
  });

  it("aggressive fallback when all harness produces base prompt only", () => {
    const r = ir([
      msg("system", "You are a coding agent running in the Codex CLI"),
      msg("user", "# AGENTS.md instructions"),
    ]);
    const out = projectIRRequest(r, { mode: "aggressive" });
    expect(out.ir.messages.length).toBeGreaterThanOrEqual(1);
    expect(out.ir.messages[0]!.content).toBe(BASE_SYSTEM_PROMPT);
  });
});

// ---------------------------------------------------------------------------
// schema whitelist & tool projection
// ---------------------------------------------------------------------------

describe("schema whitelisting", () => {
  it("drops unknown keys like description/title from schema, keeps allowed", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "my_tool",
          parameters: {
            type: "object",
            properties: {
              foo: { type: "string", description: "should be dropped", title: "drop me" },
            },
            description: "outer drop",
            title: "outer title",
            additionalProperties: false,
          },
        },
      },
    ];
    const r = ir([msg("user", "hi")], tools);
    const out = projectIRRequest(r, { mode: "conservative" });
    const params = (out.ir.tools as unknown as Array<{ type: string; function: { parameters: unknown } }>)[0]!
      .function.parameters as Record<string, unknown>;
    expect(params.description).toBeUndefined();
    expect(params.title).toBeUndefined();
    expect((params.properties as Record<string, unknown>).foo).toBeDefined();
    const foo = (params.properties as Record<string, Record<string, unknown>>).foo!;
    expect(foo!.description).toBeUndefined();
    expect(foo!.title).toBeUndefined();
    expect(foo!.type).toBe("string");
    expect(params.additionalProperties).toBe(false);
  });

  it("keeps allowed schema keys and recurses into properties/items/oneOf", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "tool2",
          parameters: {
            type: "object",
            properties: {
              bar: { type: "array", items: { type: "string", description: "drop" } },
            },
            oneOf: [{ type: "string" }, { type: "number", description: "drop" }],
          },
        },
      },
    ];
    const r = ir([msg("user", "hi")], tools);
    const out = projectIRRequest(r, { mode: "conservative" });
    const params = (out.ir.tools as unknown as Array<{ type: string; function: { parameters: unknown } }>)[0]!
      .function.parameters as Record<string, unknown>;
    expect(params.type).toBe("object");
    expect((params.properties as Record<string, unknown>).bar).toBeDefined();
    const bar = (params.properties as Record<string, Record<string, unknown>>).bar!;
    expect((bar!.items as Record<string, unknown>).type).toBe("string");
    expect((bar!.items as Record<string, unknown>).description).toBeUndefined();
    expect(Array.isArray(params.oneOf)).toBe(true);
  });

  it("marks truncated when schema changed", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "my_tool",
          parameters: { type: "object", description: "drop", properties: { a: { type: "string" } } },
        },
      },
    ];
    const r = ir([msg("user", "hi")], tools);
    const out = projectIRRequest(r, { mode: "conservative", dryRun: true });
    expect(out.dryRunDiff!.truncated).toContain("tool:0:schema");
  });

  it("ignores non-function tools", () => {
    const tools = [{ type: "other", function: { name: "bad" } }, null, 123] as unknown as IRRequest["tools"];
    const r = ir([msg("user", "hi")], tools);
    const out = projectIRRequest(r, { mode: "conservative" });
    expect((out.ir.tools as unknown[]).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// dryRun diff
// ---------------------------------------------------------------------------

describe("dryRun diff", () => {
  it("conservative dryRun reports beforeChars/afterChars/dropped/truncated", () => {
    const longSys = repeat("s", 2000);
    const r = ir([msg("system", longSys), msg("user", "hi")]);
    const out = projectIRRequest(r, { mode: "conservative", dryRun: true });
    expect(out.dryRunDiff).toBeDefined();
    expect(out.dryRunDiff!.beforeChars).toBeGreaterThan(out.dryRunDiff!.afterChars);
    expect(out.dryRunDiff!.truncated).toContain("system:0");
  });

  it("aggressive dryRun includes harness and history markers", () => {
    const r = ir([
      msg("system", "You are a coding agent running in the Codex CLI extra"),
      msg("user", "# AGENTS.md instructions hello"),
      msg("user", "real question 1"),
      msg("user", "real question 2"),
      msg("user", "real question 3"),
      msg("user", "real question 4"),
      msg("user", "real question 5"),
      msg("user", "real question 6"),
      msg("user", "real question 7"),
      msg("user", "real question 8"),
      msg("user", "real question 9"),
    ]);
    const out = projectIRRequest(r, { mode: "aggressive", dryRun: true });
    expect(out.dryRunDiff).toBeDefined();
    expect(out.dryRunDiff!.truncated.some((t) => t.startsWith("dropped:harness"))).toBe(true);
    expect(out.dryRunDiff!.dropped).toBeGreaterThan(0);
    expect(out.dryRunDiff!.beforeChars).toBeGreaterThan(0);
    expect(out.dryRunDiff!.afterChars).toBeGreaterThan(0);
  });

  it("dryRun without truncation has empty truncated when within budgets", () => {
    const r = ir([msg("user", "short")]);
    const out = projectIRRequest(r, { mode: "conservative", dryRun: true });
    expect(out.dryRunDiff!.truncated.length).toBe(0);
    expect(out.dryRunDiff!.dropped).toBe(0);
  });

  it("dryRun off mode reports zero dropped when no change", () => {
    const r = ir([msg("user", "hello")]);
    const out = projectIRRequest(r, { mode: "off", dryRun: true });
    expect(out.dryRunDiff!.dropped).toBe(0);
    expect(out.dryRunDiff!.beforeChars).toBe(out.dryRunDiff!.afterChars);
  });

  it("dryRun aggressive with history reports history marker", () => {
    const msgs: IRMessage[] = [];
    for (let i = 0; i < 15; i++) msgs.push(msg("user", `msg-${i} ` + repeat("x", 500)));
    const r = ir(msgs);
    const out = projectIRRequest(r, { mode: "aggressive", dryRun: true });
    expect(out.dryRunDiff!.truncated.some((t) => t.startsWith("history:"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// off mode
// ---------------------------------------------------------------------------

describe("off mode", () => {
  it("returns identical IR (deep equal) and does not truncate", () => {
    const longUser = repeat("u", 5000);
    const r = ir([msg("user", longUser), msg("system", "You are a coding agent running in the Codex CLI")]);
    const out = projectIRRequest(r, { mode: "off" });
    expect(out.ir.messages.length).toBe(r.messages.length);
    expect(out.ir.messages[0]!.content).toBe(longUser);
    expect(out.ir.messages[1]!.content).toBe("You are a coding agent running in the Codex CLI");
    expect(out.dryRunDiff).toBeUndefined();
  });

  it("off mode retains schema as-is without whitelist", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "my_tool",
          parameters: { type: "object", description: "keep me in off", title: "keep" },
        },
      },
    ];
    const r = ir([msg("user", "hi")], tools);
    const out = projectIRRequest(r, { mode: "off" });
    const params = (out.ir.tools as unknown as Array<{ type: string; function: { parameters: Record<string, unknown> } }>)[0]!
      .function.parameters;
    expect(params.description).toBe("keep me in off");
    expect(params.title).toBe("keep");
  });

  it("off mode deep clones input", () => {
    const r = ir([msg("user", "hello")]);
    const out = projectIRRequest(r, { mode: "off" });
    out.ir.messages[0]!.content = "mutated";
    expect(r.messages[0]!.content).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// budgets override
// ---------------------------------------------------------------------------

describe("budgets override", () => {
  it("respects custom budgets for conservative", () => {
    const r = ir([msg("user", repeat("u", 100))]);
    const out = projectIRRequest(r, { mode: "conservative", budgets: { user: 10 } });
    expect(out.ir.messages[0]!.content.length).toBeLessThanOrEqual(35); // 10 + truncated suffix
  });

  it("respects custom totalTail and maxMessages for aggressive", () => {
    const msgs: IRMessage[] = [];
    for (let i = 0; i < 10; i++) msgs.push(msg("user", `u${i}`));
    const r = ir(msgs);
    const out = projectIRRequest(r, { mode: "aggressive", budgets: { totalTail: 10, maxMessages: 2 } });
    const tailUsers = out.ir.messages.filter((m) => m.role === "user").length;
    // only 2 tail users plus maybe anchor, but total limited
    expect(tailUsers).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// edge cases & error handling
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("throws on unknown projection mode", () => {
    const r = ir([msg("user", "hi")]);
    expect(() => projectIRRequest(r, { mode: "unknown" as unknown as "off" })).toThrow();
  });

  it("handles empty messages in conservative", () => {
    const r = ir([]);
    const out = projectIRRequest(r, { mode: "conservative" });
    expect(out.ir.messages.length).toBe(0);
  });

  it("handles system content that is whitespace only", () => {
    const r = ir([msg("system", "   "), msg("user", "hi")]);
    const out = projectIRRequest(r, { mode: "aggressive" });
    // whitespace system trimmed to empty, guidance should be empty so only base prompt + user
    expect(out.ir.messages[0]!.content).toBe(BASE_SYSTEM_PROMPT);
  });

  it("trims tool output lines correctly and keeps Process exited line", () => {
    const output = ["line1", "line2", "Process exited with code 1", "tail1", "tail2"].join("\n");
    const big = repeat(`${output}\n`, 30);
    const r = ir([msg("tool", big, { tool_call_id: "call_1" })]);
    const out = projectIRRequest(r, { mode: "conservative" });
    // summarized output should keep exit line if present
    expect(out.ir.messages[0]!.content).toContain("Process exited with code");
  });
});
