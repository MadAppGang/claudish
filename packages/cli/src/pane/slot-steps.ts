/**
 * `SlotRow.recent`: one step per main-chain assistant block of a turn (contract.ts
 * `SlotStep`). Pure. The transcript follower calls `stepOf` for each block and keeps the
 * last RECENT_STEP_LIMIT.
 *
 * A summary is ONE line taken from ONE named field. A tool step never carries the
 * whole input and never anything from a tool result: a Bash command or a WebFetch url
 * can hold a token, so even the named field goes through `redactSecrets`. Paths keep
 * the home directory: the rows stay on this machine, and the path is the point.
 */

import { redactSecrets } from "../redact.js";
import type { SlotStep } from "./contract.js";

export const RECENT_STEP_LIMIT = 20;
export const STEP_SUMMARY_MAX = 100;

/** The one input field that names a tool's target. Any other tool has none. */
const TARGET_FIELD: Readonly<Record<string, string>> = {
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  Bash: "command",
  Grep: "pattern",
  Glob: "pattern",
  WebSearch: "query",
  WebFetch: "url",
  Task: "description",
  Agent: "description",
};

/** First non-empty line, credentials masked, cut to STEP_SUMMARY_MAX characters. */
export function oneLine(text: unknown): string {
  if (typeof text !== "string") return "";
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const masked = redactSecrets(line);
  return masked.length > STEP_SUMMARY_MAX ? `${masked.slice(0, STEP_SUMMARY_MAX - 1)}…` : masked;
}

function firstQuestion(input: unknown): string {
  const qs = (input as { questions?: Array<{ question?: unknown }> } | undefined)?.questions;
  if (!Array.isArray(qs)) return "";
  // The first question with readable text: a whitespace-only one would summarise to "".
  for (const q of qs) {
    const line = oneLine(q?.question);
    if (line) return line;
  }
  return "";
}

/**
 * The step for one assistant content block, or null for a block that is not a step
 * (empty text, redacted thinking, an image, a tool_use without a name).
 */
// biome-ignore lint/suspicious/noExplicitAny: a raw transcript content block, narrowed here
export function stepOf(block: any, at: string): SlotStep | null {
  if (!block || typeof block !== "object") return null;
  if (block.type === "text") {
    const summary = oneLine(block.text);
    return summary ? { at, kind: "text", tool: null, summary } : null;
  }
  if (block.type === "thinking") {
    const summary = oneLine(block.thinking);
    return summary ? { at, kind: "thinking", tool: null, summary } : null;
  }
  if (block.type !== "tool_use" || typeof block.name !== "string" || !block.name) return null;
  if (block.name === "AskUserQuestion")
    return { at, kind: "ask", tool: block.name, summary: firstQuestion(block.input) };
  const field = TARGET_FIELD[block.name];
  const summary = field ? oneLine(block.input?.[field]) : "";
  return { at, kind: "tool", tool: block.name, summary };
}
