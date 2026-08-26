/**
 * CodeBuddy upstream rejects requests whose first message is not a system
 * prompt (code 11128). Many OpenAI-style clients omit it — inject a minimal
 * one so harnesses work out of the box. No model substitution happens here;
 * model selection stays fully explicit on the client side.
 */
export function ensureLeadingSystem<T extends { messages: Array<{ role: string; content: string }> }>(ir: T): T {
  const first = ir.messages[0];
  if (first && first.role === "system" && first.content.trim().length > 0) return ir;
  return {
    ...ir,
    messages: [{ role: "system", content: "You are a helpful assistant." }, ...ir.messages],
  };
}
