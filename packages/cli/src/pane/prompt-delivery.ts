/**
 * How a prompt's text reaches the REPL (architecture §2.13, D13).
 *
 *   - a PLAIN single line (≤ 512 printable chars, no leading `! # ? @ & \ /`, no trailing
 *     `@x`/`/x` token) is typed as is;
 *   - a SLASH command is typed as its first line; when that line is too long or more
 *     follows, the whole text goes to the turn file and the typed line points at it;
 *   - EVERYTHING ELSE is written to `<turnDir>/turn-<n>.md` (0600) and the child is told,
 *     in one typed fixed-template line, to Read it. No paste path exists.
 *
 * Read's limits, measured on Claude Code 2.1.290 (phase2-captures.md §4.4): no per-line
 * truncation (a 90,005-char line came back whole), no line-count cap (2,601 lines in one
 * call), a 25,000-token cap per call. A line longer than a page can never be read, at any
 * offset, so lines longer than `READ_LINE_LIMIT − 16` are split at whitespace with a
 * marker the template explains; the split is reversible.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Witness } from "./transcript-follower.js";

/** Longest line written to a turn file, in characters (a page budget, not a Read limit). */
export const READ_LINE_LIMIT = 20_000;
/** Longest line ever typed into the REPL. */
export const MAX_TYPED_LINE = 512;

export const SPLIT_MARKER = "↩"; // U+21A9
export const ALT_SPLIT_MARKER = "⤶"; // U+2936, used when an original line already ends in ↩

export type Delivery =
  | { mode: "typed"; line: string; witness: Witness }
  | {
      mode: "command";
      line: string;
      witness: Witness;
      file?: string;
      fileContent?: string;
      lines?: number;
    }
  | {
      mode: "file";
      line: string;
      file: string;
      fileContent: string;
      lines: number;
      witness: Witness;
    }
  | { mode: "control"; line: "/exit" | "/quit" }
  | { mode: "refused"; reason: string };

const SLASH = /^\/([A-Za-z0-9][A-Za-z0-9:_-]*)(\s|$)/;

/** Remove C0 controls and DEL. */
function stripControl(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x20 && c !== 0x7f) out += ch;
  }
  return out;
}

function printable(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

/** A plain line: typed exactly as given. */
export function isPlainLine(text: string): boolean {
  if (!text.trim()) return false;
  if (text.length > MAX_TYPED_LINE) return false;
  if (!printable(text)) return false;
  const first = text.trimStart()[0] ?? "";
  if ("!#?@&\\/".includes(first)) return false;
  const tokens = text.trim().split(/\s+/);
  const last = tokens[tokens.length - 1] ?? "";
  if (last.startsWith("@") || last.startsWith("/")) return false;
  return true;
}

export interface TurnFile {
  content: string;
  /** line count exactly as Read numbers it (the empty line after a final newline counts) */
  lines: number;
  /** the marker used, or null when no line was split */
  marker: string | null;
}

/** Split one over-long line at the last whitespace before `bound` (hard split if none). */
function splitLine(line: string, bound: number, marker: string): string[] {
  const out: string[] = [];
  let rest = line;
  while (rest.length > bound) {
    let cut = rest.lastIndexOf(" ", bound);
    const tab = rest.lastIndexOf("\t", bound);
    if (tab > cut) cut = tab;
    if (cut <= 0) cut = bound;
    else cut += 1; // keep the whitespace on the left segment, so joining is exact
    out.push(rest.slice(0, cut) + marker);
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
}

/** The turn file for `text`: the caller's bytes unchanged except marked splits of over-long lines. */
export function renderTurnFile(text: string, limit: number = READ_LINE_LIMIT): TurnFile {
  const bound = limit - 16;
  const original = text.split("\n");
  const needsSplit = original.some((l) => l.length > bound);
  if (!needsSplit) return { content: text, lines: original.length, marker: null };
  const marker = original.some((l) => l.replace(/\r$/, "").endsWith(SPLIT_MARKER))
    ? ALT_SPLIT_MARKER
    : SPLIT_MARKER;
  const out: string[] = [];
  for (const l of original) out.push(...(l.length > bound ? splitLine(l, bound, marker) : [l]));
  return { content: out.join("\n"), lines: out.length, marker };
}

/** Reverse `renderTurnFile`: join every line ending in `marker` with the next, dropping it. */
export function joinSplitLines(content: string, marker: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let acc = "";
  for (const l of lines) {
    if (l.endsWith(marker)) acc += l.slice(0, -marker.length);
    else {
      out.push(acc + l);
      acc = "";
    }
  }
  if (acc) out.push(acc);
  return out.join("\n");
}

export function turnFilePath(turnDir: string, turnIndex: number): string {
  return join(turnDir, `turn-${turnIndex}.md`);
}

/** The fixed instruction typed for a file-delivered turn. */
export function fileTemplate(file: string, marker: string | null): string {
  const base = `Your task is in the file \`${file}\`. Read all of it with the Read tool (in parts if it is long), then do exactly what it says, treating its content as the user's message.`;
  return marker
    ? `${base} Lines ending in ${marker} were split for reading: join each with the next line, dropping the ${marker}.`
    : base;
}

function commandPointer(name: string, file: string): string {
  return `/${name} — the full arguments are in the file \`${file}\`; read all of it first.`;
}

/**
 * Decide how `text` is delivered for turn `turnIndex`. Pure: the caller writes the file
 * (`writeTurnFile`) before typing the line.
 */
export function planDelivery(
  text: string,
  turnDir: string,
  turnIndex: number,
  readAvailable: boolean
): Delivery {
  const trimmed = text.trim();
  if (trimmed === "/exit" || trimmed === "/quit") return { mode: "control", line: trimmed };
  if (!trimmed) return { mode: "refused", reason: "the prompt is empty" };

  const firstLine = text.split("\n")[0] ?? "";
  const slash = firstLine.trimStart().match(SLASH);
  if (slash) {
    const name = slash[1] ?? "";
    const normalised = stripControl(firstLine.trimStart().replace(/\t/g, " ")).trimEnd();
    const more = text.slice(firstLine.length).trim().length > 0;
    if (!more && normalised.length <= MAX_TYPED_LINE) {
      return { mode: "command", line: normalised, witness: { kind: "command", name } };
    }
    if (!readAvailable)
      return {
        mode: "refused",
        reason: `/${name} carries more than one ${MAX_TYPED_LINE}-character line and the Read tool is unavailable`,
      };
    const file = turnFilePath(turnDir, turnIndex);
    const tf = renderTurnFile(text);
    return {
      mode: "command",
      line: commandPointer(name, file),
      witness: { kind: "command", name },
      file,
      fileContent: tf.content,
      lines: tf.lines,
    };
  }

  if (isPlainLine(text)) return { mode: "typed", line: text, witness: { kind: "text", text } };

  if (!readAvailable)
    return {
      mode: "refused",
      reason:
        "the prompt is not a plain single line and the Read tool is unavailable, so it cannot be delivered as a file",
    };
  const file = turnFilePath(turnDir, turnIndex);
  const tf = renderTurnFile(text);
  const line = fileTemplate(file, tf.marker);
  return {
    mode: "file",
    line,
    file,
    fileContent: tf.content,
    lines: tf.lines,
    witness: { kind: "text", text: line },
  };
}

/**
 * Why `text` cannot be delivered at all (§2.3 rule 4: the flags remove Read and the text
 * is neither a plain line nor a one-line command), or null when it can. Pure; owners call
 * it before anything is spawned, so the refusal is `invalid_args`, not a failed slot.
 */
export function deliveryRefusal(text: string, readAvailable: boolean): string | null {
  const plan = planDelivery(text, "/nonexistent", 1, readAvailable);
  return plan.mode === "refused" ? plan.reason : null;
}

/** Write a delivery's turn file: exclusive create, mode 0600. No-op for typed/control deliveries. */
export function writeTurnFile(d: Delivery): void {
  if ((d.mode === "file" || d.mode === "command") && d.file && d.fileContent !== undefined) {
    writeFileSync(d.file, d.fileContent, { mode: 0o600, flag: "wx" });
  }
}
