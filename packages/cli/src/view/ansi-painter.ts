/**
 * Paints a magmux pane's decoded rows into this terminal with ANSI escapes. Ported from the
 * magmux repository's `demo/rc/cli.ts` (`ANSIPainter`, `sgr`, `clipSpan`, commit 9c45e07): the
 * alternate screen, one full SGR per span, clipping in CELL columns and never wrapping, wide
 * glyphs placed from the line's own `wd`, and one status row at the bottom.
 *
 * What differs from the source: the status row carries the viewer's own text, the terminal size
 * and the output are injected (so the bytes can be compared in a test), nothing is written to
 * stderr, and a band can stand in for the picture. The pane's own colours are painted as they
 * came; claudish's colours (the status row and the band) are read from `cliAnsi()` at every
 * paint, never at module load, so a theme detected after import still applies.
 */

import { cliAnsi } from "../theme/ansi.js";
import {
  ATTR_BLINK,
  ATTR_BOLD,
  ATTR_DIM,
  ATTR_INVIS,
  ATTR_ITALIC,
  ATTR_OVERLINE,
  ATTR_REVERSE,
  ATTR_STRIKE,
  ATTR_UNDERLINE,
  type CellCols,
  type Cursor,
  type Line,
  type Screen,
  type Span,
  cellCols,
  classifyColour,
  rowSpans,
} from "./magmux-frame.js";

const ESC = "\x1b[";
export const ALT_ON = `${ESC}?1049h`;
export const ALT_OFF = `${ESC}?1049l`;
const CURSOR_HIDE = `${ESC}?25l`;
const CURSOR_SHOW = `${ESC}?25h`;
const SGR_RESET = `${ESC}0m`;
const REVERSE = `${ESC}7m`;
const CLEAR = `${ESC}2J`;
const ERASE_LINE = `${ESC}K`;

export const STATUS_ROWS = 1;

/** Move to a 0-based row and column. */
function at(y: number, x: number): string {
  return `${ESC}${y + 1};${x + 1}H`;
}

/** Attribute bits in SGR order, each with its parameter. */
const ATTR_SGR: ReadonlyArray<readonly [number, number]> = [
  [ATTR_BOLD, 1],
  [ATTR_DIM, 2],
  [ATTR_ITALIC, 3],
  [ATTR_UNDERLINE, 4],
  [ATTR_BLINK, 5],
  [ATTR_REVERSE, 7],
  [ATTR_INVIS, 8],
  [ATTR_STRIKE, 9],
  [ATTR_OVERLINE, 53],
];

/**
 * One wire colour's SGR parameters. `base` is 30 for a foreground and 40 for a background: the
 * first eight indexes use `base`, the next eight the bright row `base + 60`, the rest 256-colour.
 */
function colourParams(c: number, base: 30 | 40): number[] {
  const k = classifyColour(c);
  if (k.kind === "rgb") return [base + 8, 2, k.r, k.g, k.b];
  if (k.kind !== "indexed") return [];
  if (k.index < 8) return [base + k.index];
  if (k.index < 16) return [base + 60 + (k.index - 8)];
  return [base + 8, 5, k.index];
}

/** One span's style as a full SGR sequence: a reset, then its own attributes and colours. */
export function sgr(span: Span): string {
  const parts: number[] = [0];
  for (const [bit, param] of ATTR_SGR) if (span.attr & bit) parts.push(param);
  parts.push(...colourParams(span.fg, 30), ...colourParams(span.bg, 40));
  return `${ESC}${parts.join(";")}m`;
}

/**
 * At most `avail` CELL columns of a span, never a code point more. A wide glyph that would be cut
 * in half at the right edge is dropped whole: half of it would either wrap, shifting every row
 * below, or push the rest of the row left. Widths come from the line's `wd` through `cells`.
 */
export function clipSpan(span: Span, avail: number, cells: CellCols): string {
  if (avail <= 0) return "";
  if (span.width <= avail) return span.text;
  let out = "";
  let used = 0;
  let cp = span.col < cells.cpAt.length ? cells.cpAt[span.col] : -1;
  for (const ch of span.text) {
    const wide = cp >= 0 && cp < cells.cps.length && cells.colOf[cp + 1] - cells.colOf[cp] === 2;
    const w = wide ? 2 : 1;
    if (used + w > avail) break;
    out += ch;
    used += w;
    if (cp >= 0 && ++cp >= cells.cps.length) cp = -1;
  }
  return out;
}

export interface TermSize {
  cols: number;
  rows: number;
}

/** How the status row reads: the session is on screen, quiet for a while, or not shown. */
export type StatusTone = "live" | "stale" | "waiting" | "ended";

export interface AnsiPainterOptions {
  write: (s: string) => void;
  /** read at every paint: the terminal can be resized under the painter */
  term: () => TermSize;
}

export class AnsiPainter {
  private readonly out: string[] = [];
  private flushing = false;
  private altOn = false;
  private rows = 0;
  private cols = 0;
  private lastCursor: Cursor = { y: 0, x: 0, vis: false };
  private lastStatus: { text: string; tone: StatusTone } | null = null;

  constructor(private readonly o: AnsiPainterOptions) {}

  /** Rows of this terminal the picture may use: the status row is never painted over. */
  private viewRows(t: TermSize): number {
    return Math.min(this.rows, Math.max(0, t.rows - STATUS_ROWS));
  }

  /** Whether the pane is larger than this terminal, so the picture is clipped. */
  clipped(): boolean {
    const t = this.o.term();
    return t.cols < this.cols || t.rows < this.rows + STATUS_ROWS;
  }

  /** One write per paint: the rows of one frame are queued synchronously and flushed together. */
  private push(s: string): void {
    this.out.push(s);
    if (this.flushing) return;
    this.flushing = true;
    queueMicrotask(() => this.flush());
  }

  /** Write everything queued now. Tests call it instead of awaiting a microtask. */
  flush(): void {
    this.flushing = false;
    const s = this.out.join("");
    this.out.length = 0;
    if (s) this.o.write(s);
  }

  private enter(): void {
    if (this.altOn) return;
    this.altOn = true;
    this.push(ALT_ON + CURSOR_HIDE + CLEAR);
  }

  /** The pane's geometry. Idempotent: every keyframe repeats it. */
  size(rows: number, cols: number): void {
    this.rows = rows;
    this.cols = cols;
    this.enter();
  }

  clear(): void {
    this.enter();
    this.push(CLEAR + at(0, 0));
  }

  row(y: number, line: Line, cells: CellCols): void {
    const t = this.o.term();
    if (y >= this.viewRows(t)) return;
    const viewCols = Math.min(this.cols, t.cols);
    let buf = at(y, 0);
    let col = 0;
    for (const span of rowSpans(line, cells, this.cols)) {
      if (col >= viewCols) break;
      const text = clipSpan(span, viewCols - col, cells);
      if (!text) break;
      buf += sgr(span) + text;
      col += span.width;
    }
    // reset first: an erase with a background colour set paints the rest of the line in it
    buf += SGR_RESET + ERASE_LINE;
    this.push(buf);
  }

  cursor(c: Cursor): void {
    this.lastCursor = c;
    this.paintCursor();
  }

  private paintCursor(): void {
    const t = this.o.term();
    const c = this.lastCursor;
    if (!c.vis || c.y >= this.viewRows(t) || c.x >= Math.min(this.cols, t.cols)) {
      this.push(CURSOR_HIDE);
      return;
    }
    this.push(at(c.y, c.x) + CURSOR_SHOW);
  }

  /** Paint a whole screen from the model: after this terminal was resized, or a band went away. */
  repaint(screen: Screen): void {
    this.size(screen.rows, screen.cols);
    this.clear();
    for (let y = 0; y < screen.rows; y++) {
      const line = screen.lines[y];
      if (line) this.row(y, line, cellCols(line));
    }
    this.cursor(screen.cur);
    if (this.lastStatus) this.status(this.lastStatus.text, this.lastStatus.tone);
  }

  /** The picture is withheld: one line says why, and the rest of the screen is empty. */
  band(text: string): void {
    this.enter();
    const t = this.o.term();
    const a = cliAnsi();
    this.lastCursor = { y: 0, x: 0, vis: false };
    this.push(
      `${CLEAR}${at(0, 0)}${SGR_RESET}${a.YELLOW}${a.BOLD}${fit(` ${text}`, t.cols)}${SGR_RESET}${CURSOR_HIDE}`
    );
    if (this.lastStatus) this.status(this.lastStatus.text, this.lastStatus.tone);
  }

  /** The bottom row: reverse video in the page's own colours, the state marker in its tone. */
  status(text: string, tone: StatusTone): void {
    this.lastStatus = { text, tone };
    this.enter();
    const t = this.o.term();
    if (t.rows < 1) return;
    const a = cliAnsi();
    const marker = tone === "live" ? a.GREEN : tone === "ended" ? a.RED : a.YELLOW;
    const dot = tone === "live" ? "●" : tone === "ended" ? "■" : "◐";
    const body = fit(` ${dot} ${text}`, t.cols);
    // the marker colours the first cell only; the rest stays in the terminal's own colours
    this.push(
      `${at(t.rows - 1, 0)}${SGR_RESET}${REVERSE}${marker}${body.slice(0, 2)}${SGR_RESET}${REVERSE}${body.slice(2)}${SGR_RESET}`
    );
    this.paintCursor();
  }

  /** Leave the alternate screen and give the cursor back; anything printed after this stays. */
  end(): void {
    const tail = this.altOn ? SGR_RESET + CURSOR_SHOW + ALT_OFF : SGR_RESET + CURSOR_SHOW;
    this.altOn = false;
    this.out.push(tail);
    this.flush();
  }
}

/** Exactly `cols` cells of plain text: cut, or padded with blanks. Status text is narrow. */
function fit(text: string, cols: number): string {
  const cps = Array.from(text);
  return cps.length >= cols ? cps.slice(0, Math.max(0, cols)).join("") : text.padEnd(cols);
}
