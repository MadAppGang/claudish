/**
 * Locate Claude Code's REPL input box from the frame's cursor row, with no width test
 * (architecture-v2 §7.4).
 *
 * `isBoxRule` (screen-model.ts) needs a rule at least `cols − 1` cells long, so it holds
 * only at the widths it was captured at (80 to 250 columns). This locator anchors on the
 * hidden cursor instead: in every captured REPL screen from 80 to 500 columns (350 × 80
 * and 500 × 100 captured on Claude Code 2.1.303) the cursor sits on the box's caret row,
 * also while a turn is working and during a UserPromptSubmit hook (session research
 * `box-dependence.md`, "Hidden cursor position"). This is why `resize_session` has no
 * width cap of its own (`pane-size.ts`). The box is then
 * the nearest rule row above the cursor and the nearest rule row below it.
 *
 * Every rule here is a CLOSED list. A screen that does not match reads as `unknown`, never
 * as a box, and nothing throws: during a resize redraw the cursor can be stale for a frame,
 * and the answer for that frame is "not located", never a wrong box.
 *
 * Imports types only (architecture-v2 §2), so screen-model.ts can depend on it.
 */

import type { SpanRun } from "./contract.js";
import type { ScreenState } from "./screen-model.js";

/** Row indexes of a located input box. `caretRow` is the cursor row, inside the box. */
export interface LocatedBox {
  top: number; // the top rule row
  bottom: number; // the bottom rule row
  caretRow: number;
}

/**
 * Why the cursor row is NOT an input box. `dialog` only says the cursor sits in a
 * selection list (a numbered option under `❯`, or AskUserQuestion's footer below the
 * rules); it does not name the dialog. `unknown` is everything else.
 */
export type BoxLocation =
  | { kind: "box"; box: LocatedBox }
  | { kind: "dialog"; why: "selected_option" | "select_footer" }
  | {
      kind: "unknown";
      why: "cursor_off_screen" | "no_rule_above" | "no_rule_below" | "no_prompt_row";
    };

/** How far from the cursor a bounding rule is looked for, in rows (§7.4 step 2). */
export const RULE_SEARCH_ROWS = 40;

/** The shortest rule row accepted, in cells. A floor only: no test reads `cols`. */
export const MIN_RULE_CELLS = 20;

/**
 * A rule row: `─` from column 0 to the row's end, at least 20 cells, optionally with one
 * ` label ─` tail (Claude Code writes the `--agent` name into the top rule's right end:
 * `──── Explore ─`, fixture `repl-boot-agent`). The dialog rules that are NOT box rules
 * fail it: the permission dialog's dashed `╌` rows, and plan approval's indented rule.
 * Deliberately no `cols − 1` or other width-proportional length test.
 */
export function isRuleRow(line: string | undefined): boolean {
  if (!line || line.length < MIN_RULE_CELLS) return false;
  return /^─+(?: [^─]+ ─+)?$/.test(line);
}

/**
 * The box's first row: `❯` + NO-BREAK SPACE, or `❯` alone (an empty box; the screen
 * model right-trims the U+00A0), or the bash-mode `!` (box-dependence.md, measured 2.1.301).
 * The echo of a submitted line is `❯` + ASCII space and never qualifies.
 */
const PROMPT_ROW = /^(❯( |$)|!)/;

/**
 * A selected numbered option: `❯` + ASCII space + `N.`, at any indent. The box prompt is
 * `❯` + NO-BREAK SPACE, so a prompt the user typed as `1. do this` never matches. Only the
 * row carrying `❯` is tested: an unselected `  2. Pear` looks like a typed list's
 * continuation row (architecture-v2 §7.4 step 4, narrowed; see the implementation log).
 */
const SELECTED_OPTION = /^ *❯ \d+\.\s+\S/;

/** AskUserQuestion's footer, drawn below the second of its two box-shaped rules. */
const SELECT_FOOTER = /Enter to select · ↑\/↓ to navigate/;

/** Cell attribute bit for faint text (placeholder, suggested-prompt ghost text). */
const ATTR_FAINT = 2;

/** The nearest rule row from `from` stepping by `step`, at most RULE_SEARCH_ROWS away; -1 if none. */
function nearestRule(lines: readonly string[], from: number, step: 1 | -1): number {
  for (let i = 1; i <= RULE_SEARCH_ROWS; i++) {
    const r = from + i * step;
    if (r < 0 || r >= lines.length) return -1;
    if (isRuleRow(lines[r])) return r;
  }
  return -1;
}

/** Where the input box is, or why the cursor row is not in one. Never throws. */
export function inspectBox(s: ScreenState): BoxLocation {
  const lines = s.lines;
  const y = s.cursor.y;
  if (!Number.isInteger(y) || y < 0 || y >= s.rows || y >= lines.length) {
    return { kind: "unknown", why: "cursor_off_screen" };
  }
  if (SELECTED_OPTION.test(lines[y] ?? "")) return { kind: "dialog", why: "selected_option" };
  const top = nearestRule(lines, y, -1);
  if (top < 0) return { kind: "unknown", why: "no_rule_above" };
  const bottom = nearestRule(lines, y, 1);
  if (bottom < 0) return { kind: "unknown", why: "no_rule_below" };
  const first = lines[top + 1] ?? "";
  if (SELECTED_OPTION.test(first)) return { kind: "dialog", why: "selected_option" };
  if (lines.slice(bottom + 1).some((l) => SELECT_FOOTER.test(l))) {
    return { kind: "dialog", why: "select_footer" };
  }
  if (!PROMPT_ROW.test(first)) return { kind: "unknown", why: "no_prompt_row" };
  return { kind: "box", box: { top, bottom, caretRow: y } };
}

/** The input box located from the cursor row, or null (a dialog, or not located). */
export function locateBox(s: ScreenState): LocatedBox | null {
  const at = inspectBox(s);
  return at.kind === "box" ? at.box : null;
}

/** The rows strictly between the two rules, as drawn. */
export function boxRows(s: ScreenState, box: LocatedBox): string[] {
  return s.lines.slice(box.top + 1, box.bottom);
}

/** The rows above the top rule: the conversation, working row and any open menu. */
export function rowsAboveBox(s: ScreenState, box: LocatedBox): string[] {
  return s.lines.slice(0, box.top);
}

/**
 * Blank cells drawn after the text on the box's last row that holds text, as the cursor
 * proves them: the cursor's column less the width of that row's text, when the cursor sits on
 * that row at or after it. `locatedBoxText` drops a row's trailing whitespace, so this is the
 * only screen evidence that typed trailing spaces were drawn. null when the cursor is on any
 * other row (or before the text): nothing is proved.
 */
export function cursorGapAfterText(s: ScreenState, box: LocatedBox): number | null {
  for (let i = box.bottom - 1; i > box.top; i--) {
    const raw = visibleText(s.lines[i] ?? "", s.spans[i]);
    const body = i === box.top + 1 ? raw.replace(/^[❯!]\s?/, "") : raw.replace(/^ {2}/, "");
    if (body.trim() === "") continue;
    if (s.cursor.y !== i) return null;
    const end = Bun.stringWidth(raw.replace(/\s+$/, ""));
    return s.cursor.x >= end ? s.cursor.x - end : null;
  }
  return null;
}

/** Characters of `line` whose cell is NOT faint. Columns are code-point indexes. */
function visibleText(line: string, spans: readonly SpanRun[] | undefined): string {
  if (!spans?.length) return line;
  const chars = Array.from(line);
  for (const [col, len, , , attr] of spans) {
    if ((attr & ATTR_FAINT) === 0) continue;
    for (let c = col; c < col + len && c < chars.length; c++) chars[c] = " ";
  }
  return chars.join("");
}

/**
 * What is typed in the box: faint cells (the boot placeholder, suggested-prompt ghost
 * text) removed, the prompt glyph and the two-space continuation indent stripped, rows
 * joined with `\n`, trimmed. An empty box, or one showing only a placeholder, reads "".
 */
export function locatedBoxText(s: ScreenState, box: LocatedBox): string {
  const parts: string[] = [];
  for (let i = box.top + 1; i < box.bottom; i++) {
    const raw = visibleText(s.lines[i] ?? "", s.spans[i]);
    const body = i === box.top + 1 ? raw.replace(/^[❯!]\s?/, "") : raw.replace(/^ {2}/, "");
    parts.push(body.replace(/\s+$/, ""));
  }
  return parts.join("\n").trim();
}

/** How the box text reads against the line being delivered. */
export type BoxMatch = "line" | "prefix" | "other";

/**
 * The box text (`locatedBoxText`) against `line`: exactly the line; text that ENDS with the
 * start of the line (alone, or after other text), whose rest may not be read yet; or other
 * text. `locatedBoxText` joins the box's rows with `\n`, strips the prompt glyph and one
 * following space from the first row, the two-space indent from every other row, each row's
 * trailing whitespace, and the whole result's ends. So every row must be an exact part of
 * the line, character for character; the only difference allowed is at a row boundary, where
 * the spaces the wrap moved to the end of the row above (and the strip removed) are skipped:
 * the spaces the line has there, less those the next row still shows (a blank row between
 * them, a space run wrapped over several rows, is skipped with that run). Text followed by the
 * WHOLE line is other text, even when an earlier tail is also a proper prefix: the copy was
 * read to its end, so a clear queues behind nothing.
 * That rule assumes the line is not periodic: for "abab" or "aaaa", the line followed by its
 * own start ("ababab") also holds a tail that is the whole line, so it reads as other text
 * and is cleared although its tail may be unread. Prompts are not built that way.
 */
export function matchBoxText(shown: string, line: string): BoxMatch {
  const whole = matchFrom(shown, line);
  if (whole === "line") return "line";
  // Every tail, the whole text first. A tail that is the whole line decides before any
  // prefix: a line whose end is also its start ("abcab") leaves a tail that is a proper
  // prefix ("ab") in "draft abcab" and "abcababcab", yet the copy there was read to its end.
  let prefix = whole === "prefix";
  for (let k = 1; k < shown.length; k++) {
    if (shown[k] === "\n") continue;
    const tail = matchFrom(shown.slice(k), line);
    if (tail === "line") return "other";
    if (tail === "prefix") prefix = true;
  }
  return prefix ? "prefix" : "other";
}

/**
 * Where wrapped row `row` starts in `want`, the rows above having matched up to `at`: past the
 * spaces the wrap moved to the end of the row above (the line's spaces there, less those `row`
 * still shows). A blank row is part of a space run wrapped over several rows and shows no count
 * of its own: it stays at `at`, and the next row with text skips the whole run. A "space" is
 * any character the row strip removes (`isRowSpace`). -1: no start.
 */
function wrappedRowStart(want: string, at: number, row: string): number {
  if (row === "") return isRowSpace(want[at]) ? at : -1;
  let spaces = 0;
  while (isRowSpace(want[at + spaces])) spaces++;
  let lead = 0;
  while (isRowSpace(row[lead])) lead++;
  return spaces < lead ? -1 : at + spaces - lead;
}

/**
 * A character `locatedBoxText` strips from a row's end (`\s`, so a no-break space too), other
 * than the row break: the wrap skip must agree with that strip, or a row ending in a no-break
 * space reads as other text.
 */
function isRowSpace(c: string | undefined): boolean {
  return c !== undefined && c !== "\n" && /\s/.test(c);
}

/** `matchBoxText` for text that must start where the line starts. */
function matchFrom(shown: string, line: string): BoxMatch {
  // untrimmed: spaces at the line's end that the box does not show are not read yet
  const want = line;
  let at = 0;
  for (const [i, row] of shown.split("\n").entries()) {
    if (i > 0) at = wrappedRowStart(want, at, row);
    if (at < 0 || !want.startsWith(row, at)) return "other";
    at += row.length;
  }
  return at === want.length ? "line" : "prefix";
}

/** The located box shows exactly `line` (`matchBoxText`). */
export function boxShowsLine(shown: string, line: string): boolean {
  return matchBoxText(shown, line) === "line";
}
