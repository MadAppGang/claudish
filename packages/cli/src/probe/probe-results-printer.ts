/**
 * probe-results-printer — bordered-card ANSI printer for the final probe results.
 *
 * This module exists to sidestep OpenTUI's in-place reconciliation bug that
 * garbles the final results panel when the component tree changes shape
 * between the "running" (progress bars) phase and the "complete" (results
 * table) phase. The live phase still runs through OpenTUI React; once the
 * renderer is shut down, the static results are printed to stderr as plain
 * ANSI text that persists in the scrollback without any diff-based redraws.
 *
 * The output is rendered as one bordered card per model. Each card contains
 * a chain table with provider/spec/status columns, optional error detail
 * sub-rows, and a compact key/wire footer.
 */

import type { KeyProvenance } from "../providers/api-key-provenance.js";
import {
  type ProbeResult,
  type ProbeTiming,
  STREAM_MS_FLOOR,
  isFailureState,
  isReadyState,
} from "../providers/probe-live.js";
import { bgHex, cliAnsi } from "../theme/ansi.js";
import { getThemeMode } from "../theme/theme-mode.js";
import {
  ANSI_RESET,
  LATENCY_FG_ANSI,
  STAGE_BG_ANSI,
  STAGE_FG,
  formatLatency,
  hexToAnsiFg,
  latencyBgAnsi,
  splitStageCells,
  throughputFg,
  timelineBarCells,
  tokBarCells,
} from "../tui/theme.js";

interface PrinterColors {
  reset: string;
  bold: string;
  dim: string;
  green: string;
  red: string;
  yellow: string;
  cyan: string;
  brightGreen: string;
  gray: string;
  bgFastest: string;
  bgSlowest: string;
}

/**
 * Build the printer palette from the theme-aware cliAnsi() escapes. Called at
 * the top of each exported entry point (refreshPc) — NEVER at module load,
 * because theme detection runs at CLI startup, after this module is imported.
 */
function buildPrinterColors(): PrinterColors {
  const a = cliAnsi();
  const light = getThemeMode() === "light";
  const noColor = !!process.env.NO_COLOR;
  return {
    reset: a.RESET,
    bold: a.BOLD,
    dim: a.DIM,
    green: a.GREEN,
    red: a.RED,
    yellow: a.YELLOW,
    cyan: a.CYAN,
    brightGreen: a.BRIGHT_GREEN,
    gray: a.GRAY,
    // Row-highlight fills carry the terminal's DEFAULT text color on top, so
    // they must be picked per theme: on dark/unknown the classic dark fills
    // (dark green / muted rust) sit under light default text; on a light page
    // the default text is dark, so use light washes instead.
    bgFastest: noColor ? "" : light ? bgHex("#bbf7d0") : "\x1b[48;5;22m",
    bgSlowest: noColor ? "" : light ? bgHex("#fecaca") : "\x1b[48;5;95m",
  };
}

// Refreshed by refreshPc() at each exported entry; every render helper below
// reads the CURRENT palette through this binding.
let pc: PrinterColors;

function refreshPc(): void {
  pc = buildPrinterColors();
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences require control chars
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Visual (display) length of a string, ignoring ANSI escape sequences. */
function visibleLength(s: string): number {
  return stripAnsi(s).length;
}

/** Pad a string (which may contain ANSI codes) to a target visible width. */
function padVisible(s: string, width: number, align: "left" | "right" = "left"): string {
  const vis = visibleLength(s);
  if (vis >= width) return s;
  const pad = " ".repeat(width - vis);
  return align === "left" ? s + pad : pad + s;
}

/** Truncate a plain string to max display width, appending an ellipsis. */
function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max <= 1) return "…";
  return `${s.slice(0, max - 1)}…`;
}

/** Word-wrap a plain string into lines no wider than maxWidth. Splits on whitespace. */
function wordWrap(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [];
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    // Handle a single word that is longer than maxWidth by hard-breaking it.
    if (word.length > maxWidth) {
      if (current) {
        lines.push(current);
        current = "";
      }
      let remaining = word;
      while (remaining.length > maxWidth) {
        lines.push(remaining.slice(0, maxWidth));
        remaining = remaining.slice(maxWidth);
      }
      current = remaining;
      continue;
    }
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= maxWidth) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ── Timeline + tok/s bars (static printer) ─────────────────────────
//
// Sub-row rendered beneath each LIVE provider row: a stacked 3-segment
// timeline bar (shared global scale across ALL cards) + a tok/s bar (shared
// scale, heat-colored) + the "NNN t/s" value + an optional ● for the
// per-chain fastest. The TOTAL latency is already carried by the status-cell
// pill, so the bars sub-row omits it. Colors come exclusively from theme.ts.

const PRINTER_BAR_WIDTH = 24; // B — timeline bar cells
const PRINTER_TOK_WIDTH = 14; // T — tok/s bar cells
const PRINTER_TRACK = "·"; // dim idle track
const PRINTER_BAR_FILL = "█"; // tok/s fill mark
// Each net/srv/str breakdown number is right-aligned to STAGE_NUM_W so the inner
// columns line up across rows (matches the live TUI: W=6 fits "21.05s").
const STAGE_NUM_W = 6;
const PRINTER_TOK_VALUE_W = 9; // right-aligned "99999 t/s"
// Minimum card-inner usable width needed to fit the bars sub-row at each tier
// (the row degrades down this ladder so it never overflows + gets ANSI-stripped).
// These MUST equal each tier's actual RENDERED visible width — note the tok/s
// COLUMN is always present: "  " + bar(14) + " " = 17 when shown, "  " = 2 when
// dropped. Under-counting the 2-space placeholder is what would let a NOTOK-tier
// row (78 wide) slip past a 76 gate and get ANSI-stripped by renderTextLine.
//   layout:  timeline(24) + gap(2) + total(7) + [breakdown(34)] + tokCol + tokValue(9)
//   full:    24 + 2 + 7 + 34 + 17 + 9 = 93   (breakdown + tok/s bar)
//   no-tok:  24 + 2 + 7 + 34 +  2 + 9 = 78   (breakdown, tok/s bar dropped)
//   minimal: 24 + 2 + 7 +  0 +  2 + 9 = 44   (timeline + total + tok value)
const PRINTER_BARS_FULL_WIDTH = 24 + 2 + 7 + 34 + 17 + 9; // 93
const PRINTER_BARS_NOTOK_WIDTH = 24 + 2 + 7 + 34 + 2 + 9; // 78 (drop tok/s bar)
const PRINTER_BARS_MIN_WIDTH = 24 + 2 + 7 + 2 + 9; // 44 (timeline + total + tok value)

/** Run-level shared scales for the static printer (mirror of the TUI's). */
interface BarScales {
  maxTotalMs: number;
  maxTokPerSec: number;
}

/**
 * Compute the global shared scales across every probe in every result:
 *   maxTotalMs   = slowest live probe's totalMs, CAPPED so one genuine outlier
 *                  (a 40s slow model, or a near-timeout link) doesn't crush the
 *                  shared bar scale down to 1-cell stubs for everyone else.
 *   maxTokPerSec = fastest live generator (streaming time floored to ≥50ms on
 *                  the SCALE denominator so one artifact can't crush it).
 *
 * Only live probes that carry `timing` participate — truncated timeouts now have
 * no `timing` (probe-live.ts stopped building it on a deadline-cut read), so they
 * naturally fall out of both scales here.
 *
 * Outlier cap: maxTotalMs = clamp(min(rawMax, 3 * median(liveTotals))) but never
 * below the actual SECOND-slowest live total (the floor keeps the second-slowest
 * link visibly long even if the single slowest is a 40s outlier). With fewer than
 * 3 live+timed links there's no meaningful median, so we just use rawMax.
 * Defaults to 1 to avoid /0.
 */
function computeBarScales(results: ModelResult[]): BarScales {
  let maxTokPerSec = 1;
  const liveTotals: number[] = [];
  const consider = (probe?: ProbeResult): void => {
    if (!probe || probe.state !== "live" || !probe.timing) return;
    const t = probe.timing;
    liveTotals.push(t.totalMs);
    const streamMs = Math.max(STREAM_MS_FLOOR, t.totalMs - t.ttftMs);
    const scaledTps = t.tokens > 0 ? (t.tokens / streamMs) * 1000 : 0;
    if (scaledTps > maxTokPerSec) maxTokPerSec = scaledTps;
  };
  for (const r of results) {
    consider(r.directProbe);
    for (const c of r.chain ?? []) consider(c.probe);
  }

  let maxTotalMs = 1;
  if (liveTotals.length > 0) {
    const sorted = [...liveTotals].sort((a, b) => a - b);
    const rawMax = sorted[sorted.length - 1];
    maxTotalMs = Math.max(1, rawMax);
    if (sorted.length >= 3) {
      // Median of the live totals (lower of the two middles on even counts is
      // fine — we only need a robust center, not a textbook median).
      const median = sorted[Math.floor((sorted.length - 1) / 2)];
      const secondSlowest = sorted[sorted.length - 2];
      // Cap at 3× median, but never tighter than the real second-slowest so the
      // runner-up still reads as a near-full bar.
      const cap = Math.max(secondSlowest, 3 * median);
      maxTotalMs = Math.max(1, Math.min(rawMax, cap));
    }
  }

  return { maxTotalMs, maxTokPerSec };
}

/** Right-align a plain string into `n` columns (truncate the LEFT if longer). */
function padStartSafe(s: string, n: number): string {
  if (s.length >= n) return s.slice(s.length - n);
  return " ".repeat(n - s.length) + s;
}

/** Left-align an (ANSI-bearing) string into `n` VISIBLE columns. No truncation. */
function padEnd(s: string, n: number): string {
  const vis = visibleLength(s);
  if (vis >= n) return s;
  return s + " ".repeat(n - vis);
}

/**
 * Breakdown number for one stage: bare integer ms, or formatLatency form
 * (e.g. "3.10s") once it crosses 1000ms. Mirrors the live TUI's breakdownNum.
 */
function breakdownNum(ms: number): string {
  if (ms >= 1000) return formatLatency(ms);
  return `${Math.round(Math.max(0, ms))}`;
}

/**
 * Build the bars sub-row body (raw ANSI) for one live probe. The caller renders
 * it via `renderTextLine`, which strips the ANSI for width math and re-applies
 * any zebra bg. Layout mirrors the live TUI's aligned columns:
 *
 *   [B timeline][2 gap][7 TOTAL]["  net "W][" srv "W][" str "W]["  " T tok/s bar][1][tok value]
 *
 * `usable` is the card-inner usable width; the sub-row degrades gracefully as it
 * shrinks (drop tok/s bar → drop breakdown → timeline + value only) so it never
 * overflows and gets ANSI-stripped by renderTextLine's truncate fallback.
 */
function buildBarsLine(
  timing: ProbeTiming,
  scales: BarScales,
  isFastest: boolean,
  usable: number
): string {
  const t = timing;

  // Degradation tiers (see PRINTER_BARS_* constants) — keyed on usable width.
  const showTokBar = usable >= PRINTER_BARS_FULL_WIDTH;
  const showBreakdown = usable >= PRINTER_BARS_FULL_WIDTH || usable >= PRINTER_BARS_NOTOK_WIDTH;

  const barCells = timelineBarCells(t.totalMs, scales.maxTotalMs, PRINTER_BAR_WIDTH);
  const stages = splitStageCells(t.ttfbMs, t.ttftMs, t.totalMs, barCells);
  const trackCells = Math.max(0, PRINTER_BAR_WIDTH - barCells);

  // Timeline: bg-on-spaces segments (the bg change IS the boundary) + dim track.
  let timeline = "";
  if (stages.network > 0) {
    timeline += `${STAGE_BG_ANSI.network}${" ".repeat(stages.network)}${ANSI_RESET}`;
  }
  if (stages.server > 0) {
    timeline += `${STAGE_BG_ANSI.server}${" ".repeat(stages.server)}${ANSI_RESET}`;
  }
  if (stages.streaming > 0) {
    timeline += `${STAGE_BG_ANSI.streaming}${" ".repeat(stages.streaming)}${ANSI_RESET}`;
  }
  if (trackCells > 0) {
    timeline += `${pc.dim}${PRINTER_TRACK.repeat(trackCells)}${pc.reset}`;
  }

  // TOTAL — right-aligned, white (mirrors the TUI's TOTAL column).
  const total = `${LATENCY_FG_ANSI}${padStartSafe(formatLatency(t.totalMs), 7)}${pc.reset}`;

  // BREAKDOWN — net/srv/str, each number right-aligned to STAGE_NUM_W and
  // STAGE_FG-colored, so values line up down the column across rows.
  let breakdown = "";
  if (showBreakdown) {
    const netMs = Math.max(0, t.ttfbMs);
    const srvMs = Math.max(0, t.ttftMs - t.ttfbMs);
    const strMs = Math.max(0, t.totalMs - t.ttftMs);
    const netFg = hexToAnsiFg(STAGE_FG.network);
    const srvFg = hexToAnsiFg(STAGE_FG.server);
    const strFg = hexToAnsiFg(STAGE_FG.streaming);
    breakdown =
      `${pc.dim}  net ${pc.reset}${netFg}${padStartSafe(breakdownNum(netMs), STAGE_NUM_W)}${pc.reset}` +
      `${pc.dim} srv ${pc.reset}${srvFg}${padStartSafe(breakdownNum(srvMs), STAGE_NUM_W)}${pc.reset}` +
      `${pc.dim} str ${pc.reset}${strFg}${padStartSafe(breakdownNum(strMs), STAGE_NUM_W)}${pc.reset}`;
  }

  // Tok/s bar: fg █ on dim · track, heat-colored; the value uses the same color.
  // Bar LENGTH is relative-to-max (comparison); bar/value COLOR is absolute
  // throughput health (so a fast model reads warm even next to a faster one).
  const tokFg = hexToAnsiFg(throughputFg(t.tokensPerSec));
  let tokBar = "";
  if (showTokBar) {
    const tokCells = tokBarCells(t.tokensPerSec, scales.maxTokPerSec, PRINTER_TOK_WIDTH);
    const tokTrack = Math.max(0, PRINTER_TOK_WIDTH - tokCells);
    if (tokCells > 0) {
      tokBar += `${tokFg}${PRINTER_BAR_FILL.repeat(tokCells)}${pc.reset}`;
    }
    if (tokTrack > 0) {
      tokBar += `${pc.dim}${PRINTER_TRACK.repeat(tokTrack)}${pc.reset}`;
    }
    tokBar = `  ${tokBar} `;
  } else {
    tokBar = "  ";
  }

  // Tok/s value — right-aligned to a fixed width so values line up down the column.
  const tokValue = `${tokFg}${padStartSafe(`${Math.round(t.tokensPerSec)} t/s`, PRINTER_TOK_VALUE_W)}${pc.reset}`;
  const crown = isFastest ? ` ${pc.brightGreen}●${pc.reset}` : "";

  return `${timeline}  ${total}${breakdown}${tokBar}${tokValue}${crown}`;
}

export interface ChainEntry {
  provider: string;
  displayName: string;
  modelSpec: string;
  hasCredentials: boolean;
  credentialHint?: string;
  provenance?: KeyProvenance;
  probe?: ProbeResult;
}

export interface WiringInfo {
  formatAdapter: string;
  declaredStreamFormat: string;
  modelTranslator: string;
  contextWindow: number;
  supportsVision: boolean;
  transportOverride: string | null;
  effectiveStreamFormat: string;
}

export interface ModelResult {
  model: string;
  nativeProvider: string;
  isExplicit: boolean;
  routingSource: "direct" | "custom-rules" | "auto-chain";
  matchedPattern?: string;
  chain: ChainEntry[];
  directProbe?: ProbeResult;
  wiring?: WiringInfo;
}

type Writer = (s: string) => boolean;

const MIN_CARD_WIDTH = 60;
const CARD_PADDING_LEFT = 2; // spaces between '│' and first cell
const CARD_PADDING_RIGHT = 2;

function summaryColor(live: number, total: number): string {
  if (total === 0 || live === 0) return pc.red;
  if (live === total) return pc.green;
  return pc.yellow;
}

function shortStatusLabel(
  probe: ProbeResult | undefined,
  hasCreds: boolean,
  _hint?: string
): string {
  if (!probe) {
    if (hasCreds) return `${pc.green}● ready${pc.reset}`;
    return `${pc.dim}${pc.red}○ missing${pc.reset}`;
  }
  switch (probe.state) {
    case "live":
      // "✓ " stays green; the latency gets a bucketed background pill
      // (green/yellow/orange/red by threshold) so fast vs slow reads at a glance.
      // Value is human-formatted (399ms / 14.34s). The trailing reset hands
      // styling back to any row-level tint (see tintRow).
      return `${pc.green}✓ ${LATENCY_FG_ANSI}${latencyBgAnsi(probe.latencyMs)} ${formatLatency(probe.latencyMs)} ${pc.reset}`;
    case "key-missing":
      return `${pc.dim}${pc.red}○ missing${pc.reset}`;
    case "auth-failed":
      // biome-ignore lint/suspicious/noControlCharactersInRegex: trims whitespace before an ANSI escape
      return `${pc.red}⊗ auth ${probe.httpStatus ?? ""}${pc.reset}`.replace(/\s+\u001b/, "\u001b");
    case "model-not-found":
      return `${pc.red}⊗ not found${pc.reset}`;
    case "rate-limited":
      return `${pc.red}⊗ rate-limited${pc.reset}`;
    case "out-of-credit":
      return `${pc.red}⊗ no credit${pc.reset}`;
    case "plan-limit":
      return `${pc.red}⊗ plan limit${pc.reset}`;
    case "server-error":
      return `${pc.red}⊗ server ${probe.httpStatus ?? ""}${pc.reset}`;
    case "timeout":
      return `${pc.red}⊗ timeout ${Math.round(probe.latencyMs / 1000)}s${pc.reset}`;
    case "network-error":
      return `${pc.red}⊗ network${pc.reset}`;
    case "error":
      return `${pc.red}⊗ error${probe.httpStatus ? ` ${probe.httpStatus}` : ""}${pc.reset}`;
    default:
      // Exhaustive over ProbeState; guards stale/foreign data at runtime.
      return `${pc.red}⊗ unknown${pc.reset}`;
  }
}

function renderBorderTop(title: string, summary: string, width: number): string {
  // ┌─ {title} ─...─ {summary} ─┐
  // The total width includes the corners.
  const titleSeg = ` ${title} `;
  const summarySeg = ` ${summary} `;
  const titleVis = visibleLength(titleSeg);
  const summaryVis = visibleLength(summarySeg);
  // Layout: ┌─{title}─...─{summary}─┐
  // chars used: 2 corners + 1 left dash + 1 right dash + titleVis + summaryVis = width
  // middle dashes = width - 2 - 2 - titleVis - summaryVis
  const middleDashes = width - 4 - titleVis - summaryVis;
  const middle = "─".repeat(Math.max(1, middleDashes));
  return `${pc.dim}┌─${pc.reset}${titleSeg}${pc.dim}${middle}${pc.reset}${summarySeg}${pc.dim}─┐${pc.reset}`;
}

function renderBorderBottom(width: number): string {
  return `${pc.dim}└${"─".repeat(width - 2)}┘${pc.reset}`;
}

function renderBlankLine(width: number): string {
  // │ ... spaces ... │
  return `${pc.dim}│${pc.reset}${" ".repeat(width - 2)}${pc.dim}│${pc.reset}`;
}

/**
 * Render a generic "raw text" line inside the card with left padding.
 * The provided body must already account for any ANSI codes — we'll measure
 * with visibleLength. If `bg` is provided, the entire inner content is wrapped
 * with that background color (for zebra-striping continuity with adjacent rows).
 */
function renderTextLine(body: string, width: number, bg?: string): string {
  // │  {body}{spaces}  │
  // inner width = width - 2 (borders)
  const inner = width - 2;
  const leftPad = " ".repeat(CARD_PADDING_LEFT);
  const rightPad = " ".repeat(CARD_PADDING_RIGHT);
  const usable = inner - CARD_PADDING_LEFT - CARD_PADDING_RIGHT;
  let content = body;
  if (visibleLength(content) > usable) {
    // Truncate plain (we don't try to be ANSI-clever for footers)
    content = truncate(stripAnsi(content), usable);
  }
  const padded = padVisible(content, usable, "left");
  if (bg) {
    // Re-apply bg after every reset within the body so the stripe stays continuous
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matches the ANSI reset sequence
    const tinted = padded.replace(/\x1b\[0m/g, `\x1b[0m${bg}`);
    return `${pc.dim}│${pc.reset}${bg}${leftPad}${tinted}${rightPad}${pc.reset}${pc.dim}│${pc.reset}`;
  }
  return `${pc.dim}│${pc.reset}${leftPad}${padded}${rightPad}${pc.dim}│${pc.reset}`;
}

/**
 * Render a chain-table row with column separators.
 * cells/widths arrays must have matching length. Each cell may contain ANSI.
 * If `bg` is provided, the entire inner row content is wrapped with that
 * background color (for zebra-striping). The border `│` chars stay un-tinted.
 */
function renderRow(cells: string[], widths: number[], width: number, bg?: string): string {
  // Layout:
  // │  c0 │ c1 │ c2 │ c3  │
  // inner = width - 2
  const inner = width - 2;
  const leftPad = " ".repeat(CARD_PADDING_LEFT);
  const rightPad = " ".repeat(CARD_PADDING_RIGHT);

  const padded: string[] = cells.map((c, i) => padVisible(c, widths[i], "left"));
  // Column separator: when zebra background is active, the bg must extend
  // through the separator too — so we use the bg color on the spaces but keep
  // the `│` dim. We re-apply the bg right after each reset so the stripe
  // doesn't break.
  const sep = bg ? ` ${pc.dim}│${pc.reset}${bg} ` : ` ${pc.dim}│${pc.reset} `;
  const sepVis = 3; // " │ "
  const fixedUsed =
    CARD_PADDING_LEFT +
    widths.reduce((a, b) => a + b, 0) +
    (cells.length - 1) * sepVis +
    CARD_PADDING_RIGHT;
  // If fixedUsed < inner, pad the last cell further to fill.
  if (fixedUsed < inner) {
    const extra = inner - fixedUsed;
    padded[padded.length - 1] = padded[padded.length - 1] + " ".repeat(extra);
  }

  // When applying a background, we must re-apply `bg` after each cell's
  // internal `pc.reset` so the stripe stays continuous across colored text.
  let body: string;
  if (bg) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matches the ANSI reset sequence
    const reTinted = padded.map((cell) => cell.replace(/\x1b\[0m/g, `\x1b[0m${bg}`));
    body = reTinted.join(sep);
  } else {
    body = padded.join(sep);
  }

  if (bg) {
    return `${pc.dim}│${pc.reset}${bg}${leftPad}${body}${rightPad}${pc.reset}${pc.dim}│${pc.reset}`;
  }
  return `${pc.dim}│${pc.reset}${leftPad}${body}${rightPad}${pc.dim}│${pc.reset}`;
}

/**
 * Render the separator row: ├───┼──────┼──────────┼──────────┤
 * Spans the entire card width from the left border to the right border,
 * using `├` and `┤` corners so it merges cleanly with the vertical borders.
 */
function renderSepRow(widths: number[], width: number): string {
  // inner = width - 2 (the two corner cells)
  const inner = width - 2;
  // We want to place `┼` tees at the same columns where ` │ ` column
  // separators appear in a data row. In a data row the layout inside the
  // borders is:
  //   leftPad + c0 + " │ " + c1 + " │ " + c2 + " │ " + c3 + trailing + rightPad
  // so the tee for the i-th separator sits at visual column:
  //   leftPad + widths[0] + 1 (space) + ... + widths[i] + 1
  // We rebuild that exact layout but fill every non-tee position with `─`.
  const n = widths.length;
  const teeCols: number[] = [];
  let col = CARD_PADDING_LEFT;
  for (let i = 0; i < n - 1; i++) {
    col += widths[i];
    col += 1; // leading space of " │ "
    teeCols.push(col);
    col += 2; // "│ " chars that follow the leading space
  }
  // Build a buffer of length `inner` filled with dashes, then place tees.
  const buf: string[] = new Array(inner).fill("─");
  for (const c of teeCols) {
    if (c >= 0 && c < inner) buf[c] = "┼";
  }
  const body = buf.join("");
  return `${pc.dim}├${body}┤${pc.reset}`;
}

interface RowData {
  num: string;
  provider: string;
  spec: string;
  status: string;
  errorDetail?: string;
  /** True if this is the fastest live provider in the chain (green bg) */
  fastest?: boolean;
  /** True if this is the slowest live provider in the chain (red bg) */
  slowest?: boolean;
  /**
   * Timing for the bars sub-row (timeline + breakdown + tok/s); only present on
   * live rows. The line itself is built lazily in `renderCard` once the final
   * card width is known so it can degrade gracefully instead of overflowing.
   */
  barsTiming?: ProbeTiming;
}

function buildRowData(result: ModelResult, isLiveProbe: boolean): RowData[] {
  // Find fastest and slowest live providers by latency.
  // Only highlight if there are 2+ live providers (no point marking 1 as both).
  let fastestIdx = -1;
  let slowestIdx = -1;
  if (isLiveProbe) {
    let fastestLatency = Number.POSITIVE_INFINITY;
    let slowestLatency = Number.NEGATIVE_INFINITY;
    let liveCount = 0;
    result.chain.forEach((entry, i) => {
      if (entry.probe?.state === "live") {
        liveCount++;
        if (entry.probe.latencyMs < fastestLatency) {
          fastestLatency = entry.probe.latencyMs;
          fastestIdx = i;
        }
        if (entry.probe.latencyMs > slowestLatency) {
          slowestLatency = entry.probe.latencyMs;
          slowestIdx = i;
        }
      }
    });
    // Don't mark slowest if only 1 live provider (it's also the fastest)
    if (liveCount < 2) slowestIdx = -1;
  }

  return result.chain.map((entry, i) => {
    const isFastest = i === fastestIdx;
    const isSlowest = i === slowestIdx;

    let status = shortStatusLabel(entry.probe, entry.hasCredentials, entry.credentialHint);
    if (isFastest) {
      status = `${status} ${pc.brightGreen}●${pc.reset}`;
    }

    let errorDetail: string | undefined;
    if (entry.probe && isFailureState(entry.probe.state) && entry.probe.errorMessage) {
      errorDetail = stripAnsi(entry.probe.errorMessage).replace(/\s+/g, " ").trim();
    }

    // Bars sub-row timing for a live probe; the line is built later (renderCard)
    // once the card width is known.
    const barsTiming =
      entry.probe?.state === "live" && entry.probe.timing ? entry.probe.timing : undefined;

    return {
      num: `${i + 1}`,
      provider: entry.displayName,
      spec: entry.modelSpec,
      status,
      errorDetail,
      fastest: isFastest,
      slowest: isSlowest,
      barsTiming,
    };
  });
}

function buildDirectRowData(result: ModelResult): RowData[] {
  const probe = result.directProbe;
  let status: string;
  if (!probe) {
    status = `${pc.dim}— no probe —${pc.reset}`;
  } else {
    status = shortStatusLabel(probe, true);
    if (probe.state === "live") {
      status = `${status} ${pc.brightGreen}●${pc.reset}`;
    }
  }
  let errorDetail: string | undefined;
  if (probe && isFailureState(probe.state) && probe.errorMessage) {
    errorDetail = stripAnsi(probe.errorMessage).replace(/\s+/g, " ").trim();
  }
  const barsTiming = probe?.state === "live" && probe.timing ? probe.timing : undefined;
  return [
    {
      num: "1",
      provider: result.nativeProvider,
      spec: `${result.nativeProvider}@${result.model}`,
      status,
      errorDetail,
      barsTiming,
    },
  ];
}

function computeColumnWidths(rows: RowData[]): number[] {
  const headers = ["#", "Provider", "Model Spec", "Status"];
  const wNum = Math.max(headers[0].length, ...rows.map((r) => r.num.length));
  const wProv = Math.max(headers[1].length, ...rows.map((r) => visibleLength(r.provider)));
  const wSpec = Math.max(headers[2].length, ...rows.map((r) => visibleLength(r.spec)));
  const wStatus = Math.max(headers[3].length, ...rows.map((r) => visibleLength(r.status)));
  return [wNum, wProv, wSpec, wStatus];
}

/**
 * Compute the card width required to fit a single model result, accounting
 * for table columns, top border title/summary, and footer key/wire lines.
 * Also clamps to the current terminal width so callers get a width they
 * can safely render.
 */
function computeCardWidth(
  _rows: RowData[],
  widths: number[],
  topTitleVis: number,
  topSummaryVis: number,
  footerVis: number
): number {
  // table row width:
  // 2 borders + leftPad + sum(widths) + (n-1)*" │ " + rightPad
  const tableRowWidth =
    2 +
    CARD_PADDING_LEFT +
    widths.reduce((a, b) => a + b, 0) +
    (widths.length - 1) * 3 +
    CARD_PADDING_RIGHT;
  // top border width: 2 corners + 1 left dash + 1 right dash + titleSeg(2 spaces+title) + summarySeg(2 spaces+summary) + at least 1 mid dash
  // ┌─ title ─...─ summary ─┐
  // = 2 (corners) + 2 (─) + (title with surround) + (summary with surround) + 1 (mid dash)
  const topMin = 2 + 2 + (topTitleVis + 2) + (topSummaryVis + 2) + 1;
  // footer width: 2 borders + leftPad + footerVis + rightPad
  const footerMin = 2 + CARD_PADDING_LEFT + footerVis + CARD_PADDING_RIGHT;

  const termCols = process.stderr.columns ?? process.stdout.columns ?? 100;
  const maxAllowed = Math.max(MIN_CARD_WIDTH, termCols - 4);

  let width = Math.max(MIN_CARD_WIDTH, tableRowWidth, topMin, footerMin);
  if (width > maxAllowed) width = maxAllowed;
  return width;
}

function formatContextWindow(ctx: number): string {
  if (ctx <= 0) return "0K";
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(1)}M`;
  return `${Math.round(ctx / 1000)}K`;
}

function buildKeyLine(activeEntry?: ChainEntry, directKeyVar?: string): string {
  if (activeEntry?.provenance) {
    const p = activeEntry.provenance;
    if (p.hasValue) {
      return `${pc.bold}Key${pc.reset}  $${p.envVar}  ${pc.dim}(${p.effectiveSource})${pc.reset}`;
    }
    return `${pc.bold}Key${pc.reset}  $${p.envVar}  ${pc.dim}(not set)${pc.reset}`;
  }
  if (directKeyVar) {
    const has = !!process.env[directKeyVar];
    return `${pc.bold}Key${pc.reset}  $${directKeyVar}  ${pc.dim}(${has ? "shell env" : "not set"})${pc.reset}`;
  }
  return `${pc.bold}Key${pc.reset}  ${pc.dim}—${pc.reset}`;
}

function buildWireLine(wiring: WiringInfo, activeProvider?: string): string {
  const ctx = formatContextWindow(wiring.contextWindow);
  const head = activeProvider ? `${activeProvider} → ` : "";
  return `${pc.bold}Wire${pc.reset} ${head}${wiring.effectiveStreamFormat} · ${wiring.modelTranslator} · ${ctx}`;
}

/**
 * Internal: gather all the pre-computed bits needed both to size a card
 * and to render it. Extracted so sizing (pass 1) and rendering (pass 2)
 * don't drift apart.
 */
interface CardLayout {
  rows: RowData[];
  widths: number[];
  titleStyled: string;
  summaryStyled: string;
  keyLine: string;
  wireLine: string;
  footerVis: number;
  activeEntry: ChainEntry | undefined;
}

function buildCardLayout(
  result: ModelResult,
  isLiveProbe: boolean,
  directKeyVar?: string
): CardLayout {
  const rows =
    result.routingSource === "direct"
      ? buildDirectRowData(result)
      : buildRowData(result, isLiveProbe);

  const totalLinks = rows.length;
  const liveCount = result.chain
    ? result.chain.filter((c) => c.probe?.state === "live").length
    : result.directProbe?.state === "live"
      ? 1
      : 0;
  const effLive = result.routingSource === "direct" ? liveCount : liveCount;
  const effTotal = result.routingSource === "direct" ? totalLinks : result.chain.length;

  const titleText = result.model;
  const sumColor = summaryColor(effLive, effTotal);
  const summaryPlain = `${result.nativeProvider} · ${effLive}/${effTotal} live`;
  const titleStyled = `${pc.bold}${pc.cyan}${titleText}${pc.reset}`;
  const summaryStyled = `${sumColor}${summaryPlain}${pc.reset}`;

  const activeEntry =
    result.chain?.find((c) => c.probe?.state === "live") ??
    result.chain?.find((c) => c.hasCredentials);

  const keyLine = buildKeyLine(activeEntry, directKeyVar);
  const wireLine = result.wiring
    ? buildWireLine(result.wiring, activeEntry?.displayName ?? result.nativeProvider)
    : "";
  const footerVis = Math.max(visibleLength(keyLine), visibleLength(wireLine));

  const widths = computeColumnWidths(rows);

  return {
    rows,
    widths,
    titleStyled,
    summaryStyled,
    keyLine,
    wireLine,
    footerVis,
    activeEntry,
  };
}

/**
 * Return the width (in columns) that a single card would require to fit its
 * content. Used by `printProbeResults` to compute a shared global width
 * across all rendered cards so they line up vertically.
 */
export function computeRequiredWidth(
  result: ModelResult,
  isLiveProbe: boolean,
  directKeyVar?: string
): number {
  refreshPc();
  const layout = buildCardLayout(result, isLiveProbe, directKeyVar);
  return computeCardWidth(
    layout.rows,
    layout.widths,
    visibleLength(layout.titleStyled),
    visibleLength(layout.summaryStyled),
    layout.footerVis
  );
}

function renderCard(
  result: ModelResult,
  isLiveProbe: boolean,
  w: Writer,
  width: number,
  scales: BarScales,
  directKeyVar?: string
): void {
  const layout = buildCardLayout(result, isLiveProbe, directKeyVar);
  const { rows, widths, titleStyled, summaryStyled, keyLine, wireLine } = layout;

  // === Render ===
  w(`${renderBorderTop(titleStyled, summaryStyled, width)}\n`);
  w(`${renderBlankLine(width)}\n`);

  // Header row (dim styled headers)
  const headerCells = [
    `${pc.dim}#${pc.reset}`,
    `${pc.dim}Provider${pc.reset}`,
    `${pc.dim}Model Spec${pc.reset}`,
    `${pc.dim}Status${pc.reset}`,
  ];
  w(`${renderRow(headerCells, widths, width)}\n`);
  w(`${renderSepRow(widths, width)}\n`);

  // Data rows — only highlight fastest (green bg) and slowest (red bg) live
  // providers. Other rows have no background. Each "logical row" (data row +
  // its optional error sub-rows) shares one bg so error details stay grouped.
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const r = rows[rowIdx];
    const bg = r.fastest ? pc.bgFastest : r.slowest ? pc.bgSlowest : undefined;

    const cells = [r.num, r.provider, `${pc.dim}${r.spec}${pc.reset}`, r.status];
    w(`${renderRow(cells, widths, width, bg)}\n`);

    // Bars sub-row beneath a live provider row (timeline + breakdown + tok/s).
    // Indented to read as a child of the row. Built here (not at row-build time)
    // so it can size itself against the final card width and degrade gracefully:
    // if the card is too narrow the bars are dropped entirely and the status-cell
    // latency pill remains the fallback.
    if (r.barsTiming) {
      const innerUsable = width - 2 - CARD_PADDING_LEFT - CARD_PADDING_RIGHT;
      const barsIndent = 4; // align with the error sub-row indent
      const barsUsable = innerUsable - barsIndent;
      if (barsUsable >= PRINTER_BARS_MIN_WIDTH) {
        const barsLine = buildBarsLine(r.barsTiming, scales, false, barsUsable);
        const body = `${" ".repeat(barsIndent)}${barsLine}`;
        w(`${renderTextLine(body, width, bg)}\n`);
      }
    }

    if (r.errorDetail) {
      // Render the error as a full-width sub-row (or rows) beneath the
      // failed row, word-wrapped to fit the card's inner usable width.
      // Layout inside the card for an error line:
      //   │{leftPad}{errorIndent}└ {text}{pad}{rightPad}│
      // where errorIndent visually insets the error one column past the
      // "#" column so it reads as a child of the failed row.
      const innerUsable = width - 2 - CARD_PADDING_LEFT - CARD_PADDING_RIGHT;
      const errorIndent = 4; // 4 spaces of indent inside the usable area
      const prefixVis = 2; // "└ " or "  "
      const textWidth = innerUsable - errorIndent - prefixVis;
      const MAX_ERROR_LINES = 4;

      if (textWidth > 0) {
        let wrapped = wordWrap(r.errorDetail, textWidth);
        let truncated = false;
        if (wrapped.length > MAX_ERROR_LINES) {
          wrapped = wrapped.slice(0, MAX_ERROR_LINES);
          truncated = true;
        }
        if (truncated) {
          const last = wrapped[wrapped.length - 1];
          // Append an ellipsis to the last kept line (replace last char if needed).
          if (last.length >= textWidth) {
            wrapped[wrapped.length - 1] = `${last.slice(0, textWidth - 1)}…`;
          } else {
            wrapped[wrapped.length - 1] = `${last}…`;
          }
        }
        const indentStr = " ".repeat(errorIndent);
        for (let i = 0; i < wrapped.length; i++) {
          const prefix = i === 0 ? "└ " : "  ";
          const body = `${indentStr}${pc.dim}${pc.red}${prefix}${wrapped[i]}${pc.reset}`;
          w(`${renderTextLine(body, width, bg)}\n`);
        }
      }
    }
  }

  w(`${renderBlankLine(width)}\n`);

  // Footer: Key + Wire
  if (visibleLength(keyLine) > 0) {
    w(`${renderTextLine(keyLine, width)}\n`);
  }
  if (visibleLength(wireLine) > 0) {
    w(`${renderTextLine(wireLine, width)}\n`);
  }

  // Routing-source note (custom rules)
  if (result.routingSource === "custom-rules" && result.matchedPattern) {
    const note = `${pc.dim}Custom rule: ${pc.reset}${pc.cyan}${result.matchedPattern}${pc.reset}`;
    w(`${renderTextLine(note, width)}\n`);
  }

  w(`${renderBorderBottom(width)}\n`);
}

/**
 * Stage + tok/s legend, printed once above the cards (only when bars are shown,
 * i.e. a live probe with at least one timed result). Mirrors the TUI legend.
 */
function renderLegend(w: Writer): void {
  const net = STAGE_BG_ANSI.network;
  const srv = STAGE_BG_ANSI.server;
  const str = STAGE_BG_ANSI.streaming;
  const netFg = hexToAnsiFg(STAGE_FG.network);
  const srvFg = hexToAnsiFg(STAGE_FG.server);
  const strFg = hexToAnsiFg(STAGE_FG.streaming);
  w(
    `  ${pc.dim}Stages:${pc.reset}  ` +
      `${net}  ${ANSI_RESET}${netFg} network${pc.reset}   ` +
      `${srv}  ${ANSI_RESET}${srvFg} server${pc.reset}   ` +
      `${str}  ${ANSI_RESET}${strFg} streaming${pc.reset}   ` +
      `${pc.dim}·· idle${pc.reset}\n`
  );
  w(
    `  ${pc.dim}bar length = total time, shared scale (slowest = full bar)  ·  ` +
      `tok/s scaled to fastest${pc.reset}\n`
  );
  w("\n");
}

// ── Leaderboard ────────────────────────────────────────────────────
//
// One row per MODEL, comparing the route claudish would actually take (the
// representative entry — first chain link that came back live+timed, or the
// direct probe). Sorted fastest→slowest by totalMs on a SHARED-SCALE timeline
// bar so models read one-to-one at a glance. Rendered as a borderless section
// above the detailed cards. No per-row bg slab — rank + bar length carry order.

interface LeaderRow {
  model: string;
  /** Representative provider's display name (the route that would be used). */
  provider: string;
  /** Live+timed timing for the representative entry; undefined = unavailable. */
  timing?: ProbeTiming;
}

/**
 * Pick the representative entry for a model: the first chain link that probed
 * live AND carried timing (the route claudish would actually use), else the
 * direct probe if it's live+timed. Returns undefined timing for models with no
 * usable route so they can be listed dim as "unavailable".
 */
function pickRepresentative(result: ModelResult): LeaderRow {
  for (const entry of result.chain ?? []) {
    if (entry.probe?.state === "live" && entry.probe.timing) {
      return { model: result.model, provider: entry.displayName, timing: entry.probe.timing };
    }
  }
  const direct = result.directProbe;
  if (direct?.state === "live" && direct.timing) {
    return { model: result.model, provider: result.nativeProvider, timing: direct.timing };
  }
  return { model: result.model, provider: result.nativeProvider };
}

/**
 * Render the leaderboard section: title, column header, one aligned row per
 * model (live rows sorted fastest→slowest, then unavailable rows dim), bottom
 * rule. `maxWidth` is the terminal-clamped width cap; the leaderboard sizes
 * itself to its own full-column content within that cap and degrades gracefully
 * as it narrows (drop tok/s bar → drop breakdown) just like the card sub-rows.
 *
 * Note: this is sized to the TERMINAL (not the per-card content width) so the
 * net/srv/str breakdown + tok/s bar render whenever the terminal can fit them —
 * the cards size to their own (often short) content and would needlessly cramp
 * the headline comparison.
 */
function renderLeaderboard(
  results: ModelResult[],
  scales: BarScales,
  maxWidth: number,
  w: Writer
): void {
  const reps = results.map(pickRepresentative);
  const live = reps.filter((r) => r.timing).sort((a, b) => a.timing!.totalMs - b.timing!.totalMs);
  const unavailable = reps.filter((r) => !r.timing);
  if (live.length === 0) return; // nothing to rank

  // Name column: widest model name (clamped so a single long name can't blow
  // out the row). All rows share it so the bars start at the same x.
  const allNames = reps.map((r) => r.model);
  const rawNameW = Math.max(5, ...allNames.map((n) => n.length));
  const nameW = Math.min(rawNameW, 28);

  // Provider column: the route claudish would actually take for each model
  // (the representative entry's display name). Dim, sits between the name and
  // the timeline bar so you can read "which model, via which provider" at a
  // glance. Clamped like the name column. The literal "PROVIDER" header sets a
  // 8-char floor so the column never narrower than its own label.
  const allProviders = reps.map((r) => r.provider);
  const rawProvW = Math.max(8, ...allProviders.map((p) => p.length));
  const provW = Math.min(rawProvW, 18);

  // Rank column fits the largest index.
  const rankW = Math.max(1, String(live.length).length);

  // Margin + fixed lead columns (mirrors the card sub-row layout to the right
  // of the name): [2 margin][rank][1][● 1][1][name][1][provider][1][B timeline][2][TOTAL 7]
  //   …then breakdown / tok bar / tok value as width allows.
  const MARGIN = 2;
  const leadW = MARGIN + rankW + 1 + 1 + 1 + nameW + 1 + provW + 1; // up to start of timeline

  // Leaderboard column widths from the timeline bar onward. Unlike the cards'
  // bars sub-row, the leaderboard's net/srv/str numbers are UNLABELED in the
  // data rows (the labels live in the column header), so its breakdown column is
  // narrower (22) than the cards' labeled one (34). Each constant is the tier's
  // true rendered visible width so the section sizes itself exactly + the bottom
  // rule matches the table.
  const LB_TIMELINE = PRINTER_BAR_WIDTH + 2 + 7; // bar + gap + TOTAL
  const LB_BREAKDOWN = 2 + STAGE_NUM_W + 1 + STAGE_NUM_W + 1 + STAGE_NUM_W; // 22
  const LB_TOKBAR = 2 + PRINTER_TOK_WIDTH + 1; // 17 ("  " + bar + " ")
  const LB_TOK_VALUE = PRINTER_TOK_VALUE_W; // 9
  const LB_FULL = LB_TIMELINE + LB_BREAKDOWN + LB_TOKBAR + LB_TOK_VALUE; // 81
  const LB_NOTOK = LB_TIMELINE + LB_BREAKDOWN + 2 + LB_TOK_VALUE; // 66

  // Size to full columns when the terminal allows, else clamp to terminal.
  const width = Math.min(maxWidth, leadW + LB_FULL);
  // Width available from the timeline bar onward.
  const barsBudget = Math.max(0, width - leadW);

  const showTokBar = barsBudget >= LB_FULL;
  const showBreakdown = barsBudget >= LB_NOTOK;

  const margin = " ".repeat(MARGIN);
  const netFg = hexToAnsiFg(STAGE_FG.network);
  const srvFg = hexToAnsiFg(STAGE_FG.server);
  const strFg = hexToAnsiFg(STAGE_FG.streaming);

  // ── Title ──
  w(
    `${margin}${pc.bold}${pc.cyan}Leaderboard${pc.reset}${pc.dim} — fastest model first${pc.reset}\n`
  );

  // ── Column header (dim), aligned to the data rows. The data-row lead-in is
  //    `${rankStr} ${dot} ` = rankW + 3 visible cols before the name. ──
  const rankHdr = `${" ".repeat(rankW)}   `; // rank + 3 (gap + dot slot + gap)
  const nameHdr = padEnd(`${pc.dim}MODEL${pc.reset}`, nameW);
  const provHdr = padEnd(`${pc.dim}PROVIDER${pc.reset}`, provW);
  let header = `${margin}${rankHdr}${nameHdr} ${provHdr} ${pc.dim}${padEnd("TIMELINE", PRINTER_BAR_WIDTH)}${pc.reset}  ${pc.dim}${padStartSafe("TOTAL", 7)}${pc.reset}`;
  if (showBreakdown) {
    header += `${pc.dim}  ${padEnd("net", STAGE_NUM_W)} ${padEnd("srv", STAGE_NUM_W)} ${padEnd("str", STAGE_NUM_W)}${pc.reset}`;
  }
  if (showTokBar) {
    header += `${pc.dim}  ${padEnd("tok/s", PRINTER_TOK_WIDTH)} ${padStartSafe("", PRINTER_TOK_VALUE_W)}${pc.reset}`;
  } else {
    header += `${pc.dim}  ${padStartSafe("tok/s", PRINTER_TOK_VALUE_W)}${pc.reset}`;
  }
  w(`${header}\n`);

  // ── Data rows (fastest first) ──
  live.forEach((row, idx) => {
    const t = row.timing!;
    const isFastest = idx === 0;
    const rankStr = padStartSafe(String(idx + 1), rankW);
    const dot = isFastest ? `${pc.brightGreen}●${pc.reset}` : " ";
    const name = padEnd(`${pc.bold}${truncate(row.model, nameW)}${pc.reset}`, nameW);
    const prov = padEnd(`${pc.dim}${truncate(row.provider, provW)}${pc.reset}`, provW);

    // Timeline bar — shared scale, bg-on-spaces segments + dim track.
    const barCells = timelineBarCells(t.totalMs, scales.maxTotalMs, PRINTER_BAR_WIDTH);
    const stages = splitStageCells(t.ttfbMs, t.ttftMs, t.totalMs, barCells);
    const trackCells = Math.max(0, PRINTER_BAR_WIDTH - barCells);
    let timeline = "";
    if (stages.network > 0)
      timeline += `${STAGE_BG_ANSI.network}${" ".repeat(stages.network)}${ANSI_RESET}`;
    if (stages.server > 0)
      timeline += `${STAGE_BG_ANSI.server}${" ".repeat(stages.server)}${ANSI_RESET}`;
    if (stages.streaming > 0)
      timeline += `${STAGE_BG_ANSI.streaming}${" ".repeat(stages.streaming)}${ANSI_RESET}`;
    if (trackCells > 0) timeline += `${pc.dim}${PRINTER_TRACK.repeat(trackCells)}${pc.reset}`;

    const total = `${LATENCY_FG_ANSI}${padStartSafe(formatLatency(t.totalMs), 7)}${pc.reset}`;

    let breakdown = "";
    if (showBreakdown) {
      const netMs = Math.max(0, t.ttfbMs);
      const srvMs = Math.max(0, t.ttftMs - t.ttfbMs);
      const strMs = Math.max(0, t.totalMs - t.ttftMs);
      breakdown =
        `  ${netFg}${padStartSafe(breakdownNum(netMs), STAGE_NUM_W)}${pc.reset}` +
        ` ${srvFg}${padStartSafe(breakdownNum(srvMs), STAGE_NUM_W)}${pc.reset}` +
        ` ${strFg}${padStartSafe(breakdownNum(strMs), STAGE_NUM_W)}${pc.reset}`;
    }

    const tokFg = hexToAnsiFg(throughputFg(t.tokensPerSec));
    let tokBar = "  ";
    if (showTokBar) {
      const tokCells = tokBarCells(t.tokensPerSec, scales.maxTokPerSec, PRINTER_TOK_WIDTH);
      const tokTrack = Math.max(0, PRINTER_TOK_WIDTH - tokCells);
      let bar = "";
      if (tokCells > 0) bar += `${tokFg}${PRINTER_BAR_FILL.repeat(tokCells)}${pc.reset}`;
      if (tokTrack > 0) bar += `${pc.dim}${PRINTER_TRACK.repeat(tokTrack)}${pc.reset}`;
      tokBar = `  ${bar} `;
    }
    const tokValue = `${tokFg}${padStartSafe(`${Math.round(t.tokensPerSec)} t/s`, PRINTER_TOK_VALUE_W)}${pc.reset}`;

    w(
      `${margin}${rankStr} ${dot} ${name} ${prov} ${timeline}  ${total}${breakdown}${tokBar}${tokValue}\n`
    );
  });

  // ── Unavailable models — dim, no bar. Keep the provider column aligned with
  //    the live rows so the table reads as one block. ──
  for (const row of unavailable) {
    const rankStr = " ".repeat(rankW);
    const name = padEnd(`${pc.dim}${truncate(row.model, nameW)}${pc.reset}`, nameW);
    const prov = padEnd(`${pc.dim}${truncate(row.provider, provW)}${pc.reset}`, provW);
    w(`${margin}${rankStr}   ${name} ${prov} ${pc.dim}— no live route${pc.reset}\n`);
  }

  // ── Bottom rule — matches the ACTUAL rendered data-row width (not the
  //    card-calibrated `width` budget), so it underlines the table exactly. ──
  const rowVis =
    leadW -
    MARGIN + // rank + dot + name + the space before the timeline
    LB_TIMELINE +
    (showBreakdown ? LB_BREAKDOWN : 0) +
    (showTokBar ? LB_TOKBAR : 2) +
    LB_TOK_VALUE;
  const ruleW = Math.max(10, rowVis);
  w(`${margin}${pc.dim}${"─".repeat(ruleW)}${pc.reset}\n`);
  w("\n");
}

export function printProbeResults(results: ModelResult[], isLiveProbe: boolean): void {
  refreshPc();
  const w: Writer = process.stderr.write.bind(process.stderr);

  w("\n");

  // Run-level shared scales for the bars, computed once across ALL cards so
  // the slowest probe in the whole run gets the longest timeline bar and the
  // fastest generator gets the longest tok/s bar.
  const scales = computeBarScales(results);

  // Has any live probe carried timing? Only then is the legend meaningful.
  const anyTimedLive =
    results.some((r) => r.directProbe?.state === "live" && r.directProbe.timing !== undefined) ||
    results.some((r) =>
      (r.chain ?? []).some((c) => c.probe?.state === "live" && c.probe.timing !== undefined)
    );

  if (isLiveProbe && anyTimedLive) {
    renderLegend(w);
  }

  // Pass 1: compute required width for each card. Done before the leaderboard so
  // it can share the exact same width (and shared scale) as the cards below it.
  const requiredWidths = results.map((r) => computeRequiredWidth(r, isLiveProbe));

  // Pick the global width: the max required width, clamped to the terminal.
  const termCols = process.stderr.columns ?? process.stdout.columns ?? 100;
  const maxAllowed = Math.max(MIN_CARD_WIDTH, termCols - 4);
  let globalWidth = requiredWidths.reduce((a, b) => Math.max(a, b), MIN_CARD_WIDTH);
  if (globalWidth > maxAllowed) globalWidth = maxAllowed;

  // Leaderboard — headline one-row-per-model comparison, fastest first, on the
  // shared scale. Same gate as the legend (only meaningful when something is
  // live+timed). Rendered above the detailed cards. Sized to the TERMINAL
  // (maxAllowed), not the per-card content width, so the breakdown + tok/s bar
  // show whenever the terminal can fit them.
  const showedLeaderboard = isLiveProbe && anyTimedLive;
  if (showedLeaderboard) {
    renderLeaderboard(results, scales, maxAllowed, w);
  }

  // Section heading between the headline leaderboard and the per-model detail
  // cards, so the eye registers the shift from "summary" to "details" instead
  // of the cards starting abruptly under the leaderboard rule. Only shown when
  // the leaderboard was rendered (otherwise the cards ARE the top-level view).
  if (showedLeaderboard) {
    w(
      `  ${pc.bold}${pc.cyan}Details${pc.reset}${pc.dim} — per-model routing chains${pc.reset}\n\n`
    );
  }

  // Pass 2: render each card with the shared width so borders align.
  for (const result of results) {
    renderCard(result, isLiveProbe, w, globalWidth, scales);
    w("\n");
  }

  // Compact tip footer (no legend — cards are self-describing).
  w(
    `  ${pc.dim}Tip: chain order is LiteLLM → Zen Go → Subscription → Native API → OpenRouter${pc.reset}\n`
  );
  w("\n");

  // Suppress unused-import warnings: keep isReadyState referenced in case
  // future render paths need it. (No-op at runtime.)
  void isReadyState;
}
