/**
 * magmux `watch` frames → an in-memory screen with claudish's OWN monotonic `seq`
 * (architecture §2.5, D6).
 *
 * magmux's frame `seq` restarts at 1 whenever its framer is recreated (every reconnect),
 * so it cannot back `capture(since_seq)`. Ours is 0 until the first frame is applied and
 * then grows by one on every VISIBLE change — row text, spans, cursor, alt screen, rows
 * or cols — for the pane's whole life.
 *
 * `aboveBoxChangedAt` moves only when a row ABOVE the input box's top rule changes, so a
 * status line ticking under the box never holds a settle quiet window open (M3). In
 * Claude Code 2.1.290 the working row (`· Processing… (running Stop hook · 2s …)`) sits
 * above the box and is rewritten every second while anything runs, which is what keeps
 * that window closed during a Stop hook (phase-2 capture s04).
 */

import type { SpanRun } from "./contract.js";

export interface ScreenState {
  seq: number;
  cols: number;
  rows: number;
  cursor: { x: number; y: number };
  lines: string[];
  spans: SpanRun[][];
  alt: boolean;
  changedAt: number;
  aboveBoxChangedAt: number;
}

/** One magmux `frame` event (protocol/frame.go), as it arrives on the socket. */
export interface MagmuxFrame {
  type?: "frame";
  pane?: number;
  seq?: number;
  rows: number;
  cols: number;
  alt?: boolean;
  sb?: number;
  scrolled?: boolean;
  cur?: { y: number; x: number; vis?: boolean };
  key?: boolean;
  lines?: Array<{ y: number; t?: string; r?: SpanRun[]; wd?: number[] }>;
}

/** A magmux `capture` reply's `result`. */
export interface MagmuxCapture {
  rows: number;
  cols: number;
  alt?: boolean;
  cursor?: { y: number; x: number };
  text: string;
}

export function emptyScreen(cols: number, rows: number): ScreenState {
  return {
    seq: 0,
    cols,
    rows,
    cursor: { x: 0, y: 0 },
    lines: Array.from({ length: rows }, () => ""),
    spans: Array.from({ length: rows }, () => []),
    alt: false,
    changedAt: 0,
    aboveBoxChangedAt: 0,
  };
}

/** A full-width box rule: only `─`, at least 20 of them and at least cols−1 wide. */
export function isBoxRule(line: string | undefined, cols: number): boolean {
  if (!line || !/^─+$/.test(line)) return false;
  return line.length >= Math.max(20, Math.min(cols, 160) - 1);
}

/**
 * Row index of the input box's top rule: the LAST full-width rule whose next row starts
 * with `❯`. -1 when no input box is drawn (a dialog replaced it, or boot).
 */
export function boxTopRow(lines: readonly string[], cols: number): number {
  for (let i = lines.length - 2; i >= 0; i--) {
    if (isBoxRule(lines[i], cols) && /^❯/.test(lines[i + 1] ?? "")) return i;
  }
  return -1;
}

function rightTrim(s: string): string {
  return s.replace(/\s+$/, "");
}

function sameSpans(a: SpanRun[] | undefined, b: SpanRun[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function withSize(s: ScreenState, rows: number): { lines: string[]; spans: SpanRun[][] } {
  const lines = s.lines.slice(0, rows);
  const spans = s.spans.slice(0, rows);
  while (lines.length < rows) lines.push("");
  while (spans.length < rows) spans.push([]);
  return { lines, spans };
}

function aboveBoxText(lines: readonly string[], cols: number): string {
  const top = boxTopRow(lines, cols);
  return (top >= 0 ? lines.slice(0, top) : lines).join("\n");
}

function finish(
  prev: ScreenState,
  next: Omit<ScreenState, "seq" | "changedAt" | "aboveBoxChangedAt">,
  now: number
): ScreenState {
  const visible =
    prev.seq === 0 ||
    prev.cols !== next.cols ||
    prev.rows !== next.rows ||
    prev.alt !== next.alt ||
    prev.cursor.x !== next.cursor.x ||
    prev.cursor.y !== next.cursor.y ||
    next.lines.some((l, i) => l !== prev.lines[i]) ||
    next.spans.some((r, i) => !sameSpans(r, prev.spans[i]));
  if (!visible) return prev;
  const aboveChanged =
    prev.seq === 0 || aboveBoxText(prev.lines, prev.cols) !== aboveBoxText(next.lines, next.cols);
  return {
    ...next,
    seq: prev.seq + 1,
    changedAt: now,
    aboveBoxChangedAt: aboveChanged ? now : prev.aboveBoxChangedAt,
  };
}

/** Apply one watch frame. A keyframe replaces every row; a delta replaces the rows it names. */
export function applyFrame(
  s: ScreenState,
  frame: MagmuxFrame,
  now: number = Date.now()
): ScreenState {
  const rows = frame.rows;
  const cols = frame.cols;
  let { lines, spans } = withSize(s, rows);
  if (frame.key) {
    lines = Array.from({ length: rows }, () => "");
    spans = Array.from({ length: rows }, () => []);
  }
  for (const row of frame.lines ?? []) {
    if (row.y < 0 || row.y >= rows) continue;
    lines[row.y] = rightTrim(row.t ?? "");
    spans[row.y] = row.r ?? [];
  }
  return finish(
    s,
    {
      cols,
      rows,
      cursor: { x: frame.cur?.x ?? s.cursor.x, y: frame.cur?.y ?? s.cursor.y },
      lines,
      spans,
      alt: frame.alt ?? s.alt,
    },
    now
  );
}

/**
 * Apply a `capture` reply (the finalisation path, e.g. the dead pane's last screen).
 * magmux strips trailing blank rows from `text`; this pads back to `rows`. A capture has
 * no colours, so spans are cleared.
 */
export function applyCapture(
  s: ScreenState,
  cap: MagmuxCapture,
  now: number = Date.now()
): ScreenState {
  const rows = cap.rows;
  const lines = cap.text.split("\n").slice(0, rows).map(rightTrim);
  while (lines.length < rows) lines.push("");
  return finish(
    s,
    {
      cols: cap.cols,
      rows,
      cursor: { x: cap.cursor?.x ?? s.cursor.x, y: cap.cursor?.y ?? s.cursor.y },
      lines,
      spans: Array.from({ length: rows }, () => []),
      alt: cap.alt ?? s.alt,
    },
    now
  );
}
