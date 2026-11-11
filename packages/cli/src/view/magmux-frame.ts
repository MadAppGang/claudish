// Copied verbatim from the magmux repository, demo/rc/frame.ts, at commit 9c45e07 (magmux
// 0.19.0, as `magmux --version` reports it). Nothing after this header is edited here: a change
// belongs upstream and is copied again. biome.json excludes this file so the formatter keeps it
// byte-identical; magmux-frame.test.ts checks the decoder against frames captured from a real
// magmux 0.19.0 pane.
//
// MIT License
//
// Copyright (c) 2026 MadAppGang
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * The ONE frame decoder for both demo clients.
 *
 * Pure: no I/O, no DOM, no ANSI, no `node:` import. It is imported unchanged by
 * `cli.ts` (bun) and by `web/app.ts` (bundled for a browser by `serve.ts`), so
 * the two surfaces cannot drift in their reading of the wire. What it does NOT
 * do is decide how a colour or an attribute is PAINTED — `cli.ts` turns the
 * classification below into SGR and `app.ts` turns it into CSS, because that is
 * surface, not protocol.
 *
 * The wire shape is `protocol/frame.go`, and three of its rules are the whole
 * of this file:
 *
 *   1. A frame is WHOLE ROWS. `key:true` means `lines` covers every row and the
 *      client clears first; `key:false` means each line REPLACES the row it
 *      names. So deltas merge by row index and a gap in `seq` is harmless.
 *   2. Run columns are CELL columns, not indexes into `t`. A double-width
 *      glyph is one code point in two cells, and `wd` lists the code-point
 *      indexes that are wide. A client that painted by code point would drift
 *      one column right of every CJK glyph on the line.
 *   3. `t` is right-trimmed and the runs are NOT. A run may extend past the end
 *      of the text — that is how a styled blank (a selection, a filled status
 *      bar) survives the trim.
 *
 * A frame with no `lines` at all is legitimate and must not be discarded: a
 * moved or hidden cursor, a scrollback change and an alt-screen switch all
 * change what a client draws without changing a cell.
 */

// ── wire types (protocol/frame.go) ──────────────────────────────────────────

/** One stretch of identically-styled cells: [col, len, fg, bg, attr]. */
export type Run = [number, number, number, number, number];

export interface Line {
  y: number;
  /** The row's text, one code point per non-continuation cell, right-trimmed. */
  t: string;
  /** Code-point indexes in `t` that occupy TWO cells. */
  wd?: number[];
  r?: Run[];
}

export interface Cursor {
  y: number;
  x: number;
  vis: boolean;
}

export interface FrameMessage {
  type: string;
  pane: number;
  seq: number;
  rows: number;
  cols: number;
  alt: boolean;
  sb: number;
  scrolled: boolean;
  cur: Cursor;
  key: boolean;
  lines?: Line[];
}

// ── colour classification ───────────────────────────────────────────────────

/** No colour: use the surface's own foreground/background. */
export const COLOR_DEFAULT = -1;
/** Anything at or above this is truecolor; the low 24 bits are the RGB. */
export const COLOR_TRUE = 1 << 24;
export const COLOR_RGB_MASK = 0xffffff;

export type Colour =
  | { kind: "default" }
  | { kind: "indexed"; index: number }
  | { kind: "rgb"; r: number; g: number; b: number };

const DEFAULT_COLOUR: Colour = { kind: "default" };

/**
 * Classify one wire colour. CLASSIFICATION ONLY — what a client does with the
 * answer is its own business, and the two painters disagree about it on
 * purpose.
 */
export function classifyColour(c: number): Colour {
  if (c >= COLOR_TRUE) {
    const rgb = c & COLOR_RGB_MASK;
    return { kind: "rgb", r: (rgb >> 16) & 0xff, g: (rgb >> 8) & 0xff, b: rgb & 0xff };
  }
  if (c >= 0 && c <= 255) return { kind: "indexed", index: c };
  return DEFAULT_COLOUR;
}

// ── attributes ──────────────────────────────────────────────────────────────

/**
 * The nine attribute bits, restated.
 *
 * SOURCE OF TRUTH: `mux/cell.go:10-18` (`Attr`, `AttrBold` … `AttrOverline`).
 * `Run[4]` is public wire data whose bits are defined in a package no external
 * client may import, so every client outside magmux restates them — and this
 * copy is the one that goes stale silently. `selftest.ts` check 1 pins the
 * values; if magmux ever renumbers them, that check is what fails.
 */
export const ATTR_BOLD = 1 << 0; // 1
export const ATTR_DIM = 1 << 1; // 2
export const ATTR_ITALIC = 1 << 2; // 4
export const ATTR_BLINK = 1 << 3; // 8
export const ATTR_REVERSE = 1 << 4; // 16
export const ATTR_INVIS = 1 << 5; // 32
export const ATTR_UNDERLINE = 1 << 6; // 64
export const ATTR_STRIKE = 1 << 7; // 128
export const ATTR_OVERLINE = 1 << 8; // 256

/** Every bit, in wire order, for anything that wants to enumerate them. */
export const ATTR_BITS: { name: string; bit: number }[] = [
  { name: "bold", bit: ATTR_BOLD },
  { name: "dim", bit: ATTR_DIM },
  { name: "italic", bit: ATTR_ITALIC },
  { name: "blink", bit: ATTR_BLINK },
  { name: "reverse", bit: ATTR_REVERSE },
  { name: "invisible", bit: ATTR_INVIS },
  { name: "underline", bit: ATTR_UNDERLINE },
  { name: "strike", bit: ATTR_STRIKE },
  { name: "overline", bit: ATTR_OVERLINE },
];

export function hasAttr(attr: number, bit: number): boolean {
  return (attr & bit) !== 0;
}

// ── the cp <-> cell mapping ─────────────────────────────────────────────────

export interface CellCols {
  /** The row's code points, split once so no caller splits it again. */
  cps: string[];
  /**
   * Cell column each code point starts at. Length is `cps.length + 1`; the
   * last entry is the total cell width of the text, which is where the
   * right-trimmed blanks begin.
   */
  colOf: Int32Array;
  /**
   * Code-point index occupying each cell column, or -1 for the CONTINUATION
   * half of a wide glyph and for every column past the text. Length is
   * `colOf[cps.length]`, so a caller must bound its own walk by the pane's
   * column count and treat anything beyond as blank.
   */
  cpAt: Int32Array;
}

/**
 * Build the cp <-> cell mapping for one line, both directions, from `wd`.
 *
 * `wd` is the only width information on the wire, and taking it rather than
 * measuring the glyph is deliberate: magmux already decided how wide each cell
 * is when it drew the screen, and a client re-deriving it from its own width
 * table would disagree with the pane it is mirroring.
 */
export function cellCols(line: Line): CellCols {
  const cps = Array.from(line.t ?? "");
  const wide = new Set(line.wd ?? []);
  const colOf = new Int32Array(cps.length + 1);
  let col = 0;
  for (let i = 0; i < cps.length; i++) {
    colOf[i] = col;
    col += wide.has(i) ? 2 : 1;
  }
  colOf[cps.length] = col;

  const cpAt = new Int32Array(col).fill(-1);
  for (let i = 0; i < cps.length; i++) cpAt[colOf[i]] = i;
  return { cps, colOf, cpAt };
}

// ── the screen model ────────────────────────────────────────────────────────

export interface Screen {
  rows: number;
  cols: number;
  /** One entry per row, index === y. Never sparse. */
  lines: Line[];
  cur: Cursor;
  seq: number;
  alt: boolean;
  sb: number;
  scrolled: boolean;
  pane: number;
  /** True when the last frame applied was a keyframe: the painter must clear. */
  cleared: boolean;
  /** Frames applied since the screen was created. */
  frames: number;
}

function blankLine(y: number): Line {
  return { y, t: "" };
}

export function newScreen(rows: number, cols: number, pane = 0): Screen {
  return {
    rows,
    cols,
    lines: Array.from({ length: Math.max(0, rows) }, (_, y) => blankLine(y)),
    cur: { y: 0, x: 0, vis: true },
    seq: 0,
    alt: false,
    sb: 0,
    scrolled: false,
    pane,
    cleared: false,
    frames: 0,
  };
}

/**
 * Apply one frame and report which rows changed.
 *
 * A keyframe returns EVERY row index and sets `screen.cleared`, because the
 * client must clear before repainting — `key:true` means the client has no
 * memory of what came before, which is the property that makes a resize, an
 * alt-screen switch and a second watcher joining all safe.
 *
 * A delta returns only the rows it carried. It is not an optimisation to return
 * fewer: a row the frame did not name is a row magmux is asserting did not
 * change, and repainting it would be work, not correctness.
 *
 * GEOMETRY COMES FROM EVERY FRAME, not only from the watch reply. A pane
 * reflows whenever the human drags the window — which in a demo is the most
 * likely thing anyone does — and `FrameHeader` carries `rows` and `cols` on
 * every frame for exactly that reason. A resize and an alt-screen switch are
 * therefore treated as keyframes here even if `key` is false: magmux forces one
 * in both cases, and a client that trusted `key` alone would paint row deltas
 * onto a screen of the wrong shape the one time it did not.
 */
export function applyFrame(screen: Screen, frame: FrameMessage): number[] {
  const rows = frame.rows > 0 ? frame.rows : screen.rows;
  const cols = frame.cols > 0 ? frame.cols : screen.cols;
  const resized = rows !== screen.rows || cols !== screen.cols;
  const switched = screen.frames > 0 && (frame.alt === true) !== screen.alt;
  const key = frame.key === true || resized || switched;

  if (resized) {
    const next: Line[] = Array.from({ length: rows }, (_, y) => screen.lines[y] ?? blankLine(y));
    screen.lines = next;
    screen.rows = rows;
    screen.cols = cols;
  }
  if (key) {
    for (let y = 0; y < screen.rows; y++) screen.lines[y] = blankLine(y);
  }

  const changed: number[] = [];
  for (const line of frame.lines ?? []) {
    const y = line.y;
    if (!Number.isInteger(y) || y < 0 || y >= screen.rows) continue; // a row off this screen is not ours to paint
    screen.lines[y] = line;
    if (!key) changed.push(y);
  }
  if (key) for (let y = 0; y < screen.rows; y++) changed.push(y);

  screen.cur = frame.cur ?? screen.cur;
  screen.seq = frame.seq ?? screen.seq;
  screen.alt = frame.alt === true;
  screen.sb = frame.sb ?? 0;
  screen.scrolled = frame.scrolled === true;
  screen.pane = frame.pane ?? screen.pane;
  screen.cleared = key;
  screen.frames++;
  return changed;
}

// ── row decoding, shared by both painters ───────────────────────────────────

/** One stretch of a row with a single style, ready for a painter. */
export interface Span {
  /** Cell column this span starts at. */
  col: number;
  /** Cell columns it covers — NOT `text.length`, which differs on wide glyphs. */
  width: number;
  text: string;
  fg: number;
  bg: number;
  attr: number;
}

/**
 * Expand a row's runs into a per-cell-column style lookup.
 *
 * Runs arrive merged and in order, but they are allowed to run past the text
 * and are clamped to `cols` here rather than at every read site.
 */
function styleColumns(line: Line, cols: number) {
  const fg = new Int32Array(cols).fill(COLOR_DEFAULT);
  const bg = new Int32Array(cols).fill(COLOR_DEFAULT);
  const attr = new Int32Array(cols);
  for (const r of line.r ?? []) {
    const start = Math.max(0, r[0]);
    const end = Math.min(cols, r[0] + r[1]);
    for (let c = start; c < end; c++) {
      fg[c] = r[2];
      bg[c] = r[3];
      attr[c] = r[4];
    }
  }
  return { fg, bg, attr };
}

/**
 * Decode one row into styled spans over `cols` cell columns.
 *
 * This is the shared half of painting, and it is here rather than in the two
 * painters because getting it wrong is invisible: a continuation cell that
 * contributes a character, or a run boundary read in code points, shifts
 * everything to its right by one column and looks like a rendering glitch
 * rather than a decode bug.
 *
 * Every column 0..cols-1 is covered, blanks included, because a frame's rows
 * are right-trimmed and a painter that stopped at the end of the text would
 * leave the previous frame's pixels standing to its right.
 */
export function rowSpans(line: Line, cells: CellCols, cols: number): Span[] {
  const style = styleColumns(line, cols);
  const spans: Span[] = [];
  let cur: Span | null = null;

  for (let c = 0; c < cols; c++) {
    const cp = c < cells.cpAt.length ? cells.cpAt[c] : -1;
    const isCont = c < cells.cpAt.length && cp < 0; // inside the text, so a continuation half
    if (isCont && cur) {
      // The wide glyph before it already claims this column; widen the span
      // rather than emitting anything, or the row gains a character.
      cur.width++;
      continue;
    }
    const fg = style.fg[c];
    const bg = style.bg[c];
    const attr = style.attr[c];
    const ch = cp >= 0 ? cells.cps[cp] : " ";
    const w = cp >= 0 && cells.colOf[cp + 1] - cells.colOf[cp] === 2 ? 2 : 1;
    if (cur && cur.fg === fg && cur.bg === bg && cur.attr === attr) {
      cur.text += ch;
      cur.width += w;
    } else {
      cur = { col: c, width: w, text: ch, fg, bg, attr };
      spans.push(cur);
    }
    if (w === 2) c++; // the continuation half is already accounted for
  }
  return spans;
}

/** The plain text of a row over `cols` columns — what a viewer would read. */
export function rowText(line: Line, cols: number): string {
  const cells = cellCols(line);
  let out = "";
  let c = 0;
  while (c < cols) {
    const cp = c < cells.cpAt.length ? cells.cpAt[c] : -1;
    if (cp >= 0) {
      out += cells.cps[cp];
      c += cells.colOf[cp + 1] - cells.colOf[cp];
      continue;
    }
    if (c < cells.cpAt.length) {
      c++; // a continuation half, already emitted with its glyph
      continue;
    }
    out += " ";
    c++;
  }
  return out;
}

/** Every row of a screen as text, right-trimmed — for tests and diagnostics. */
export function screenText(screen: Screen): string {
  return screen.lines.map((l) => rowText(l, screen.cols).replace(/ +$/, "")).join("\n");
}
