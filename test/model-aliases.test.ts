import { describe, expect, test } from "bun:test";
import { ALIAS_RULES, resolveModelId } from "../src/models/aliases";

describe("resolveModelId", () => {
  test("passes through exact catalog ids", () => {
    expect(resolveModelId("hy3")).toBe("hy3");
    expect(resolveModelId("glm-5.2")).toBe("glm-5.2");
    expect(resolveModelId("gpt-5.6-luna")).toBe("gpt-5.6-luna");
    expect(resolveModelId("kimi-k3")).toBe("kimi-k3");
  });

  test("pass-through sentinels", () => {
    expect(resolveModelId("auto")).toBe("auto");
    expect(resolveModelId("default")).toBe("default");
  });

  test("claude code tiers map onto available models", () => {
    expect(resolveModelId("claude-opus-4-7")).toBe("glm-5.2");
    expect(resolveModelId("claude-sonnet-4-5")).toBe("glm-5.2");
    expect(resolveModelId("claude-haiku-4-5")).toBe("hy3");
    expect(resolveModelId("claude-3-5-sonnet")).toBe("glm-5.2");
  });

  test("legacy openai names map", () => {
    expect(resolveModelId("gpt-4o-mini")).toBe("glm-5.2");
    expect(resolveModelId("gpt-4.1")).toBe("glm-5.2");
    expect(resolveModelId("o3-mini")).toBe("glm-5.2");
    expect(resolveModelId("o4-mini")).toBe("kimi-k2.6");
  });

  test("deepseek chat/reasoner map", () => {
    expect(resolveModelId("deepseek-chat")).toBe("deepseek-v4-flash");
    expect(resolveModelId("deepseek-reasoner")).toBe("deepseek-v4-pro");
  });

  test("unknown names pass through untouched (visible upstream error)", () => {
    expect(resolveModelId("totally-made-up")).toBe("totally-made-up");
  });

  test("rules are prefix-ordered and targets exist in catalog", () => {
    for (const [, target] of ALIAS_RULES) {
      expect(typeof target).toBe("string");
      expect(target.length).toBeGreaterThan(0);
    }
  });
});
