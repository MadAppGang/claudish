/**
 * Claude Code's own compaction request: the request in which Claude Code asks
 * the main model to summarise the conversation before it starts over from
 * that summary.
 *
 * Measured on Claude Code 2.1.326 against a mock upstream: the request keeps
 * the system prompt, tools, `max_tokens`, thinking and metadata of the
 * conversation, and adds one instruction at the end. Auto compaction at a
 * turn start sends it as the whole last user message (a string); `/compact`
 * after a tool round sends it as a text block after the tool_results. Both
 * start with `HARNESS_COMPACTION_PROMPT_START`. The `fallback-credit-2026-06-01`
 * beta is added to both, but not only to them, so it is never the signal.
 *
 * A swap recorded on this request is never sent again (no later request
 * repeats its prefix), so the history pass records none.
 *
 * Claude Code 2.1.329 sends this request in advance, beside the main loop
 * ("precomputed compact", at autocompact level `warn`), and keeps the summary
 * until it compacts. The main loop goes on with its full history, so the
 * request after the compaction request is not the compacted one. The
 * compacted request carries a text block that starts with
 * `HARNESS_COMPACTED_START`, in a user message before the first assistant
 * message, followed by a short tail of the conversation. After a precomputed
 * compaction it is block 2 of message 0, at offset 0 (9 compactions of one
 * live session, 50 or 38 messages dropped to 14). After a reactive one,
 * Claude Code first re-attaches the files it read as their own user message,
 * and the summary is block 8 of 9 of message 1 (one live compaction, 3
 * messages).
 */

import { lastConversationIndex } from "./conversation.js";

type Block = Record<string, unknown>;

/** The first line of Claude Code's compaction instruction. */
export const HARNESS_COMPACTION_PROMPT_START =
  "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.";

/** The beta Claude Code adds to its compaction request (and to other requests). */
export const HARNESS_COMPACTION_BETA = "fallback-credit-2026-06-01";

/** The last text of a user message: its string content, or its last text block. */
function lastUserText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const m = message as Block;
  if (m.role !== "user") return undefined;
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return undefined;
  for (let i = m.content.length - 1; i >= 0; i--) {
    const block = m.content[i] as Block | undefined;
    if (block?.type === "text" && typeof block.text === "string") return block.text;
  }
  return undefined;
}

/** True when `message` is a user message whose last text is Claude Code's compaction instruction. */
export function isHarnessCompactionMessage(message: unknown): boolean {
  return lastUserText(message)?.trimStart().startsWith(HARNESS_COMPACTION_PROMPT_START) === true;
}

/**
 * True when the request's last message, past any inline system message,
 * carries Claude Code's compaction instruction.
 */
export function isHarnessCompactionRequest(messages: readonly unknown[]): boolean {
  return isHarnessCompactionMessage(messages[lastConversationIndex(messages)]);
}

/** The opening of Claude Code's summary in the first message after it compacts. */
export const HARNESS_COMPACTED_START =
  "This session is being continued from a previous conversation";

/** True when `message` is a user message with a text block that starts with the summary. */
function opensWithSummary(message: Block): boolean {
  if (message.role !== "user") return false;
  const blocks =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
  if (!Array.isArray(blocks)) return false;
  return blocks.some((raw) => {
    const block = raw as Block | undefined;
    return (
      block?.type === "text" &&
      typeof block.text === "string" &&
      block.text.startsWith(HARNESS_COMPACTED_START)
    );
  });
}

/**
 * True when a user message before the first assistant message has a text
 * block that starts with Claude Code's summary: a history Claude Code
 * compacted.
 */
export function isHarnessCompactedRequest(messages: readonly unknown[]): boolean {
  for (const raw of messages) {
    const message = raw as Block | undefined;
    if (!message || typeof message !== "object" || message.role === "assistant") return false;
    if (opensWithSummary(message)) return true;
  }
  return false;
}

/**
 * The debug line for a request, or undefined: one line for Claude Code's
 * compaction request, and one for a request that carries the compaction beta
 * without the instruction (a changed instruction would show here first).
 */
export function harnessCompactionNote(
  messages: readonly unknown[],
  anthropicBeta: string | undefined
): string | undefined {
  if (isHarnessCompactionRequest(messages)) {
    return "history pass: Claude Code's compaction request, no new swap and no summary";
  }
  const betas = (anthropicBeta ?? "").split(",").map((b) => b.trim());
  if (betas.includes(HARNESS_COMPACTION_BETA)) {
    return `history pass: ${HARNESS_COMPACTION_BETA} without Claude Code's compaction instruction; treated as a normal request`;
  }
  return undefined;
}
