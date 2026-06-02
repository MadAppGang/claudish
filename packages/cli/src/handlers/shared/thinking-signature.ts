/**
 * Thinking-block signature hygiene for the native Anthropic path.
 *
 * Non-Anthropic providers (GLM, Kimi, DeepSeek, …) emit reasoning that the
 * openai-sse / gemini-sse parsers surface to the client as Anthropic
 * `{ type: "thinking" }` content blocks — but with NO signature (the client
 * stores them as `signature: ""`). These blocks are harmless while the session
 * stays on a non-native provider (ComposedHandler strips all thinking blocks
 * before forwarding). They become toxic in a MIXED session: once a turn routes
 * to a real Anthropic model, NativeHandler forwards the history verbatim and
 * the Anthropic API rejects the unsigned block with
 * `messages.N.content.M: Invalid signature in thinking block` (400).
 *
 * This helper removes ONLY thinking blocks whose signature is missing or empty.
 * Genuine Anthropic thinking blocks carry a real signature and are preserved —
 * they are required for interleaved-thinking / tool-use continuity. Other block
 * types (text, tool_use, tool_result, redacted_thinking, …) are untouched.
 */

/** A thinking block is "unsigned" when its signature is absent or empty. */
function isUnsignedThinkingBlock(block: any): boolean {
  return (
    !!block &&
    block.type === "thinking" &&
    (typeof block.signature !== "string" || block.signature.length === 0)
  );
}

/**
 * Strip unsigned thinking blocks from assistant messages in place.
 *
 * @param messages The Anthropic-format `messages` array (mutated in place).
 * @returns The number of thinking blocks removed.
 */
export function stripUnsignedThinkingBlocks(messages: any): number {
  if (!Array.isArray(messages)) return 0;

  let stripped = 0;
  for (const msg of messages) {
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const before = msg.content.length;
    msg.content = msg.content.filter((block: any) => !isUnsignedThinkingBlock(block));
    stripped += before - msg.content.length;
  }
  return stripped;
}
