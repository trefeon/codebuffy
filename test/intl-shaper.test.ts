import { describe, expect, it } from "bun:test";
import { ensureLeadingSystem } from "../src/ir/ensure-leading-system";
import { toUpstreamRequest, type IRRequest } from "../src/ir/types";

function makeIR(messages: IRRequest["messages"]): IRRequest {
  return { model: "glm-5.2", messages, stream: false };
}

describe("ensureLeadingSystem intl shaper", () => {
  it("prepends the fixed CodeBuddy Code system prompt", () => {
    const out = ensureLeadingSystem(makeIR([{ role: "user", content: "hi" }]), "intl");
    expect(out.messages[0]).toEqual({ role: "system", content: "You are CodeBuddy Code." });
  });

  it("wraps bare-string user content as typed text blocks", () => {
    const out = ensureLeadingSystem(makeIR([{ role: "user", content: "hello" }]), "intl");
    expect(out.messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "hello" }] as unknown as string,
    });
  });

  it("drops source system and developer messages", () => {
    const out = ensureLeadingSystem(
      makeIR([
        { role: "system", content: "source system" },
        { role: "developer" as never, content: "source developer" },
        { role: "user", content: "q" },
      ]),
      "intl",
    );
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]).toEqual({ role: "system", content: "You are CodeBuddy Code." });
  });

  it("passes assistant messages through untouched", () => {
    const out = ensureLeadingSystem(
      makeIR([{ role: "user", content: "q" }, { role: "assistant", content: "a" }]),
      "intl",
    );
    expect(out.messages[2]).toEqual({ role: "assistant", content: "a" });
  });

  it("flattens typed blocks and appends image parts for user messages with images", () => {
    const shaped = ensureLeadingSystem(
      makeIR([{ role: "user", content: "see this", images: [{ url: "data:image/png;base64,AAA" }] }]),
      "intl",
    );
    const req = toUpstreamRequest(shaped);
    const content = (req.messages[1] as unknown as { content: unknown }).content as Array<{
      type: string;
      text?: unknown;
      image_url?: unknown;
    }>;
    expect(content[0]).toEqual({ type: "text", text: "see this" });
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } });
    for (const part of content) {
      expect(typeof part.text === "string" || part.text === undefined).toBe(true);
    }
  });
});

describe("ensureLeadingSystem CN behavior unchanged", () => {
  it("prepends the helpful-assistant fallback only when no leading system", () => {
    const missing = ensureLeadingSystem(makeIR([{ role: "user", content: "hi" }]));
    expect(missing.messages[0]).toEqual({ role: "system", content: "You are a helpful assistant." });

    const present = makeIR([{ role: "system", content: "keep me" }, { role: "user", content: "hi" }]);
    expect(ensureLeadingSystem(present)).toBe(present);
  });
});
