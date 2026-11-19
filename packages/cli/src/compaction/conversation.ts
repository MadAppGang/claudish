/**
 * Positions in a request's `messages` that skip inline system messages.
 *
 * Claude Code 2.1.328 puts `role: "system"` messages inside `messages`: its
 * session context after the first user message, and, when an output style is
 * set, one fixed reminder after every tool_result. So the array often ends
 * with a system message, and one can sit between a tool_result and the next
 * assistant message. The conversation (user and assistant turns) is the array
 * without them; every rule that reads "the last message" or "the message
 * before" reads the conversation.
 */

/** True when `message` is an inline system message. */
export function isInlineSystem(message: unknown): boolean {
  return (
    !!message && typeof message === "object" && (message as { role?: unknown }).role === "system"
  );
}

/** Index of the nearest message before `i` that is not an inline system message, or -1. */
export function previousConversationIndex(messages: readonly unknown[], i: number): number {
  for (let j = Math.min(i, messages.length) - 1; j >= 0; j--) {
    if (!isInlineSystem(messages[j])) return j;
  }
  return -1;
}

/** Index of the last message that is not an inline system message, or -1. */
export function lastConversationIndex(messages: readonly unknown[]): number {
  return previousConversationIndex(messages, messages.length);
}
