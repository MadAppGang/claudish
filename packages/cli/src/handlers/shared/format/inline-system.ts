/**
 * Inline system messages, kept at their position for a foreign model.
 *
 * Claude Code sends `role: "system"` messages INSIDE `messages`: the skill
 * list, the agent list and MCP server instructions near the start, and a
 * background-task notification wherever the task ended, often between two tool
 * results. The Gemini, Chat Completions and Responses converters convert only
 * `user` and `assistant` messages, so that text never reached the model.
 *
 * The text is moved into the USER MESSAGE BEFORE IT as a text block, not
 * into the system prompt, for two reasons:
 *
 * - Position. A notification says something happened NOW. In the system prompt
 *   it reads as if it had always been true.
 * - The cached prefix. The system prompt is the first part of every request. A
 *   notification appended there changes the text in front of the whole
 *   conversation, so the provider's prefix cache misses on every one. A block
 *   at the notification's own position changes only the tail.
 *
 * "Beside it" has two limits: never INSIDE an open tool round, and never by a
 * rule that reads the messages AFTER it. A notification is often the last
 * message of one request and has a user message after it on the next; a rule
 * that looks ahead would move its text between the two requests.
 *
 * Only text moves. A `tool_addition` block carries a tool definition and no
 * text; a system message with no text is dropped, as the converters did.
 */

const REMINDER_OPEN = "<system-reminder>";

function systemTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: any) =>
      block?.type === "text" && typeof block.text === "string" ? block.text : ""
    )
    .filter((text: string) => text.trim() !== "")
    .join("\n\n");
}

/** Claude Code wraps this text itself; text that is not wrapped gets the same tag. */
function asReminder(text: string): string {
  return text.trimStart().startsWith(REMINDER_OPEN)
    ? text
    : `${REMINDER_OPEN}\n${text}\n</system-reminder>`;
}

function blocksOf(content: unknown): any[] {
  if (Array.isArray(content)) return content;
  if (typeof content === "string" && content !== "") return [{ type: "text", text: content }];
  return [];
}

const textBlock = (text: string) => ({ type: "text", text });

function idsOf(content: unknown, type: string, key: string): string[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b: any) => b?.type === type).map((b: any) => b[key]);
}

/**
 * A copy of `messages` with no `role: "system"` entry. Each one's text becomes a
 * text block. Where it goes depends ONLY on the messages before it, so the same
 * message lands in the same place on every later request of the conversation
 * and the wire form of earlier messages never changes:
 *
 * - while a TOOL ROUND IS OPEN (an assistant message called tools and not every
 *   call has its `tool_result` yet), the text waits. It is appended to the user
 *   message that carries the round's last result. Text between two results, or
 *   between the calls and the first result, ends the round on the wire, and a
 *   converter then reports the remaining calls as "no tool result provided";
 * - otherwise, after a user message, it is appended to that message;
 * - otherwise (after an assistant message, or first in the conversation) it
 *   becomes a user message of its own, which the user's next turn then joins.
 *
 * Returns the array given when it holds no system message.
 */
export function inlineSystemAsUserText(messages: any[]): any[] {
  if (!Array.isArray(messages) || !messages.some((m) => m?.role === "system")) return messages;
  const out: any[] = [];
  /** Tool calls of the open round that have no result yet. */
  const unanswered = new Set<string>();
  /** Text waiting for the open round to close. */
  let held: string[] = [];
  /** User messages this function created, which the user's next turn joins. */
  const created = new WeakSet<object>();

  const place = (texts: string[]) => {
    if (texts.length === 0) return;
    const last = out[out.length - 1];
    if (last?.role === "user") {
      const grown = {
        ...last,
        content: [...blocksOf(last.content), ...texts.map(textBlock)],
      };
      if (created.has(last)) created.add(grown);
      out[out.length - 1] = grown;
    } else {
      const own = { role: "user", content: texts.map(textBlock) };
      created.add(own);
      out.push(own);
    }
  };
  const closeRound = () => {
    unanswered.clear();
    place(held);
    held = [];
  };

  for (const msg of messages) {
    if (msg?.role === "system") {
      const text = systemTextOf(msg.content);
      if (!text) continue;
      if (unanswered.size > 0) held.push(asReminder(text));
      else place([asReminder(text)]);
      continue;
    }
    const results = msg?.role === "user" ? idsOf(msg.content, "tool_result", "tool_use_id") : [];
    if (unanswered.size > 0 && results.length === 0) {
      // The round was left open (interrupted calls). Place the text before
      // whatever comes next rather than hold it for results that never arrive.
      closeRound();
    }
    const last = out[out.length - 1];
    if (msg?.role === "user" && last && created.has(last)) {
      // One user turn, not two in a row: some wire formats require user and
      // assistant turns to alternate. The created message only GROWS at its
      // end, so what an earlier request sent stays a prefix of this one.
      out[out.length - 1] = { ...msg, content: [...last.content, ...blocksOf(msg.content)] };
    } else {
      out.push(msg);
    }
    if (msg?.role === "assistant") {
      for (const id of idsOf(msg.content, "tool_use", "id")) unanswered.add(id);
    } else if (results.length > 0 && unanswered.size > 0) {
      for (const id of results) unanswered.delete(id);
      if (unanswered.size === 0) closeRound();
    }
  }
  closeRound();
  return out;
}
