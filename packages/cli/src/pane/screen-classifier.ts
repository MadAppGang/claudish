/**
 * What Claude Code's screen says (architecture §2.6), with every marker taken from a
 * verbatim capture of Claude Code 2.1.290 in a headless magmux pane
 * (`ai-docs/reports/mcp-magmux-panes/phase2-captures.md`, fixtures in
 * `test-fixtures/screens/`).
 *
 * The screen is never the turn oracle — the transcript is (D3). The screen decides boot
 * readiness, names the dialogs that block boot, recognises the choice dialogs a turn can
 * block on, and supplies the degraded-mode answer and error rows. Every rule below is a
 * CLOSED list: an unrecognised layout reads as "not a dialog" (stay RUNNING, an honest
 * unknown), never as `blocked` (R3-H1).
 */

import type { SpanRun } from "./contract.js";
import { type ScreenState, boxTopRow, isBoxRule } from "./screen-model.js";

export type NamedDialog = "onboarding" | "trust" | "bypass" | "api_key";

export type BootReading =
  | { kind: "repl" } // input box: rule / line starting "❯" / rule, nothing typed
  | { kind: "dialog"; name: NamedDialog; text: string }
  | { kind: "choice"; text: string } // unnamed blocking screen, no input box
  | { kind: "booting" };

/**
 * The named first-run dialogs. They only NAME a dialog; whether boot is blocked is
 * decided by "no input box". 2.1.290 draws all of them on the primary screen.
 */
export const NAMED_DIALOGS: ReadonlyArray<{ name: NamedDialog; marker: string }> = [
  { name: "onboarding", marker: "Choose the text style" },
  { name: "trust", marker: "Is this a project you created or one you trust" },
  { name: "bypass", marker: "running in Bypass Permissions mode" },
  // Not recaptured on 2.1.290 (needs a foreign route with ANTHROPIC_API_KEY set);
  // verbatim 2.1.287 text from research-scratch/run-empty-config5-claudish-foreign.txt.
  { name: "api_key", marker: "Detected a custom API key in your environment" },
];

export type ChoiceDialogKind = "permission" | "plan" | "question";

/**
 * The choice dialogs a RUNNING turn can block on (R3-H1's closed list). Each header is
 * verbatim from a 2.1.290 capture. None of them has a `No, and tell Claude …(esc)` row
 * any more: permission ends `3. No` / `Esc to cancel · Tab to amend`, plan approval has
 * no No row at all, AskUserQuestion ends `Enter to select · ↑/↓ to navigate · Esc to cancel`.
 */
export const CHOICE_DIALOGS: ReadonlyArray<{ kind: ChoiceDialogKind; header: RegExp }> = [
  { kind: "permission", header: /\bDo you want to proceed\?/ },
  {
    kind: "permission",
    header: /\bDo you want to (create|make this edit to|overwrite|delete) .+\?/,
  },
  { kind: "plan", header: /\bWould you like to proceed\?/ },
  { kind: "question", header: /Enter to select · ↑\/↓ to navigate/ },
];

/** A numbered option row, optionally under the `❯` cursor: `❯ 1. Yes`, `  2. Pear`. */
const NUMBERED_OPTION = /^\s*(❯\s*)?\d+\.\s+\S/;
const FIRST_OPTION = /^\s*(❯\s*)?1\.\s+\S/;

/** Footers of 2.1.290's selection dialogs (boot dialogs have no numbers). */
const SELECT_FOOTER = /Enter to (confirm|select)\b.*Esc to cancel/;

/** The working row: glyph, a capitalised word ending in `…`, an optional `(…)`. */
const WORKING_ROW = /^\s*[·✢✳✶✻✽*●∗]\s+[A-Z][\w'-]*…(\s+\(.*\))?\s*$/;

/** Bullet of an assistant message block. */
const BULLET = /^⏺(\s|$)/;

/** Error rows. 2.1.290 renders an API error as a `⏺` row. */
const ERROR_ROW =
  /^⏺\s.*(API Error\b|Please run \/login|Not logged in|You've hit your|session limit)|^\s*⎿\s+API Error\b/;

/** Attribute bit magmux passes through for faint (placeholder / ghost text). */
export const ATTR_FAINT = 2;

export function screenText(s: ScreenState): string {
  const lines = [...s.lines];
  while (lines.length && !lines[lines.length - 1]?.trim()) lines.pop();
  return lines.join("\n");
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

export interface InputBox {
  top: number; // row of the top rule
  bottom: number; // row of the bottom rule
  text: string; // typed text, placeholder (faint) cells excluded, trimmed
  menuOpen: boolean;
  menuItem: string | null;
}

const MENU_ROW = /^\s{2}❯ \/\S|^\s{4}\/\S|^\s{4}[*+] \S/;

/**
 * The REPL input box, or null when none is drawn. `text` is built from the box rows'
 * cells minus faint styling, so the fresh-boot placeholder (`❯ Try "how does <filepath>
 * work?"`, attr 2) reads as empty while typed text (no span) does not (X-M14).
 */
export function inputBox(s: ScreenState): InputBox | null {
  const top = boxTopRow(s.lines, s.cols);
  if (top < 0) return null;
  const bottom = boxBottomRow(s, top);
  if (bottom < 0) return null;
  return { top, bottom, text: boxText(s, top, bottom), ...menuAbove(s.lines, top) };
}

function boxBottomRow(s: ScreenState, top: number): number {
  for (let i = top + 1; i < s.lines.length && i <= top + 40; i++)
    if (isBoxRule(s.lines[i], s.cols)) return i;
  return -1;
}

/** The box prompt is `❯` + NO-BREAK SPACE; continuation rows are indented two spaces. */
function boxText(s: ScreenState, top: number, bottom: number): string {
  const parts: string[] = [];
  for (let i = top + 1; i < bottom; i++) {
    const raw = visibleText(s.lines[i] ?? "", s.spans[i]);
    const body = i === top + 1 ? raw.replace(/^❯\s?/, "") : raw.replace(/^ {2}/, "");
    parts.push(body.replace(/\s+$/, ""));
  }
  return parts.join("\n").trim();
}

/** Menus (`/` commands, `@` files and agents) are drawn directly above the top rule. */
function menuAbove(
  lines: readonly string[],
  top: number
): { menuOpen: boolean; menuItem: string | null } {
  let menuOpen = false;
  let menuItem: string | null = null;
  for (let i = top - 1; i >= 0 && i >= top - 12; i--) {
    const l = lines[i] ?? "";
    if (!l.trim()) break;
    if (!MENU_ROW.test(l)) continue;
    menuOpen = true;
    menuItem = l.match(/^\s{2}❯ (\S+)/)?.[1] ?? menuItem;
  }
  return { menuOpen, menuItem };
}

/** Index of the last `⏺` block row, or -1. */
function lastBulletRow(lines: readonly string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (BULLET.test(lines[i] ?? "")) return i;
  return -1;
}

export interface ChoiceDialog {
  kind: ChoiceDialogKind;
  text: string;
}

/**
 * A choice dialog a turn is blocked on — the closed list of R3-H1. True only when ALL
 * hold: (a) a named header from CHOICE_DIALOGS is on screen, (b) no input box is drawn,
 * (c) a numbered `1.` option row sits below the last `⏺` block. Numbered prose with a
 * `No…` row above a running Bash fails (a) and (b); the working row fails all three.
 */
export function choiceDialog(s: ScreenState): ChoiceDialog | null {
  if (inputBox(s)) return null;
  const lines = s.lines;
  const start = lastBulletRow(lines) + 1;
  const below = lines.slice(start);
  const kind = CHOICE_DIALOGS.find((d) => below.some((l) => d.header.test(l)))?.kind;
  if (!kind) return null;
  if (!below.some((l) => FIRST_OPTION.test(l))) return null;
  return { kind, text: below.filter((l) => l.trim()).join("\n") };
}

export function hasChoiceDialog(s: ScreenState): boolean {
  return choiceDialog(s) !== null;
}

/**
 * "Claude Code is working" — defence in depth only (never required by any rule, M20).
 * 2.1.290 shows no `esc to interrupt`; the working row is `✶ Simmering… (3s · ↓ 154 tokens)`,
 * and the finished row (`✻ Baked for 15s · done 12:08 PM`) has no `…`.
 */
export function isWorking(s: ScreenState): boolean {
  const top = boxTopRow(s.lines, s.cols);
  const region = top >= 0 ? s.lines.slice(0, top) : s.lines;
  return region.some((l) => WORKING_ROW.test(l));
}

/** A Stop hook is running: `· Processing… (running Stop hook · 2s …)`. */
export function stopHookRunning(s: ScreenState): boolean {
  return s.lines.some((l) => /\(running Stop hook\b/.test(l));
}

export function transcriptSavingOff(s: ScreenState): boolean {
  return s.lines.some((l) => l.includes("Transcript saving is off"));
}

export function screenErrorRows(s: ScreenState): string[] {
  return s.lines.filter((l) => ERROR_ROW.test(l)).map((l) => l.trim());
}

function isToolHeader(lines: readonly string[], i: number): boolean {
  const l = lines[i] ?? "";
  if (/^⏺ [A-Z][A-Za-z0-9_:-]*\(/.test(l)) return true; // ⏺ Write(hello.txt), ⏺ Agent(fruit)
  if (/^⏺ Agent "[^"]*" (finished|failed)/.test(l)) return true;
  if (/^⏺ Background command /.test(l)) return true;
  if (/^⏺ User declined to answer questions/.test(l)) return true;
  // A Bash description row: the next non-empty row is its `⎿  $ command` row.
  for (let j = i + 1; j < lines.length && j <= i + 2; j++) {
    const n = lines[j] ?? "";
    if (!n.trim()) continue;
    return /^\s+⎿\s+\$ /.test(n);
  }
  return false;
}

const NON_ANSWER_ROW =
  /^\s+⎿|^\s{2}(Ran|Read|Searched|Wrote|Edited|Listed|Updated) \d+ |^\s*[·✢✳✶✻✽*●∗]\s|^\s*\(ctrl\+/;

/**
 * Degraded-mode answer (C4): the `⏺` prose rows after the LAST echo of `echo` and
 * their indented continuations, minus tool rows, sub-result rows (`  ⎿ …`), collapsed
 * tool summaries (`  Ran 1 shell command`), working/finished rows and error rows (L14).
 */
export function screenAnswer(s: ScreenState, echo: string): string {
  const lines = s.lines;
  const top = boxTopRow(lines, s.cols);
  const end = top >= 0 ? top : lines.length;
  const start = echoRow(lines, end, `❯ ${echo.slice(0, 40)}`) + 1;
  if (start <= 0) return "";
  const out: string[] = [];
  let inProse = false;
  for (let i = start; i < end; i++) {
    const row = answerRow(lines, i, inProse);
    inProse = row.inProse;
    if (row.text !== null) out.push(row.text);
  }
  return out.join("\n").trim();
}

/** The LAST row above `end` starting with `head`, or -1. */
function echoRow(lines: readonly string[], end: number, head: string): number {
  for (let i = end - 1; i >= 0; i--) if ((lines[i] ?? "").startsWith(head)) return i;
  return -1;
}

/** One row of the degraded answer: its text (or null) and whether a prose block continues. */
function answerRow(
  lines: readonly string[],
  i: number,
  inProse: boolean
): { text: string | null; inProse: boolean } {
  const l = lines[i] ?? "";
  if (BULLET.test(l)) {
    const prose = !isToolHeader(lines, i) && !ERROR_ROW.test(l);
    return { text: prose ? l.replace(/^⏺\s?/, "") : null, inProse: prose };
  }
  if (!l.trim()) return { text: inProse ? "" : null, inProse };
  if (NON_ANSWER_ROW.test(l) || isToolHeader(lines, i)) return { text: null, inProse: false };
  if (inProse && /^ {2}/.test(l)) return { text: l.slice(2), inProse: true };
  return { text: null, inProse: false };
}

/**
 * The child's own `--agent` refusal. magmux's `exit.lastLine` truncates long lines
 * (`--agent 'zzz-not-real' not found. Avail…`, captured), so the agent list is optional
 * here; read the full line from the final screen when it is needed.
 */
export function agentRejectedLine(text: string): string | null {
  const m = text.match(/--agent '([^']+)' not found\.(?: Available agents:[^\n]*)?/);
  return m ? m[0] : null;
}

function namedDialog(text: string): NamedDialog | null {
  for (const d of NAMED_DIALOGS) if (text.includes(d.marker)) return d.name;
  return null;
}

/** An unnamed static non-REPL screen with choice markers (M2). */
function isUnnamedChoice(lines: readonly string[]): boolean {
  const numbered = lines.some((l) => NUMBERED_OPTION.test(l));
  const yesNo = lines.some((l) => /^\s*(❯\s*)?(\d+\.\s+)?(Yes|No)\b|\(esc\)/.test(l));
  if (numbered && yesNo) return true;
  return lines.some((l) => /Press Enter to continue/.test(l) || SELECT_FOOTER.test(l));
}

/** Boot reading: alt and primary screens both read (2.1.290's dialogs are on the primary one). */
export function readBoot(s: ScreenState): BootReading {
  const text = screenText(s);
  const box = inputBox(s);
  const named = namedDialog(text);
  if (box && !named) return box.text === "" ? { kind: "repl" } : { kind: "booting" };
  if (named) return { kind: "dialog", name: named, text };
  if (isUnnamedChoice(s.lines)) return { kind: "choice", text };
  return { kind: "booting" };
}
