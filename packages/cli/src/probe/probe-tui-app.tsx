/** @jsxImportSource @opentui/react */
/**
 * Probe TUI — React component tree rendered with @opentui/react.
 *
 * Renders the LIVE phase only: banner, pipeline steps, and animated progress
 * bars. Once all probes settle, cli.ts shuts down this OpenTUI renderer and
 * prints the static results table via `probe-results-printer.ts`. Doing the
 * final render as plain ANSI avoids an OpenTUI in-place reconciliation bug
 * that garbled the results panel when the component tree changed shape
 * between phases.
 */

import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { NATIVE_NOT_PROBED } from "../providers/native-route.js";
import {
  type ProbeResult,
  type ProbeTiming,
  STREAM_MS_FLOOR,
  describeProbeState,
} from "../providers/probe-live.js";
import { type DroppedOutcome, describeDropped } from "../providers/probe-runner.js";
import type { RouteExplanation, RouteWarning, RuleScope } from "../providers/routing-rules.js";
import { getThemeMode } from "../theme/theme-mode.js";
import { useAnimationFrame } from "../tui/hooks/useAnimationFrame.js";
import {
  A,
  C,
  STAGE_BG,
  STAGE_FG,
  formatLatency,
  latencyBg,
  latencyFg,
  splitStageCells,
  throughputFg,
  timelineBarCells,
  tokBarCells,
} from "../tui/theme.js";
import { VERSION } from "../version.js";

// ── Types ──────────────────────────────────────────────────────────

export interface ProbeStepState {
  name: string;
  status: "pending" | "running" | "done" | "error";
}

export interface ProbeLinkState {
  id: string;
  /** Grouping key — the user-facing model input, e.g. "gpt-4o" */
  model: string;
  /** Provider display name, e.g. "LiteLLM" */
  displayName: string;
  /** Pinned model spec, e.g. "litellm@gpt-4o" */
  modelSpec: string;
  /**
   * `not-probed`: a row nothing is sent down — a native link, a dropped
   * candidate, or a kept hop under `--no-probe`. It shows `note`, never a bar.
   */
  status: "waiting" | "probing" | "live" | "failed" | "not-probed";
  startTime?: number;
  endTime?: number;
  error?: string;
  /** Granular timing breakdown — present on "live" links (threaded from cli.ts). */
  timing?: ProbeTiming;
  /** A `not-probed` row's text. */
  note?: string;
  /** A `not-probed` row's kind, which picks its colour at render time. */
  tone?: "native" | "dropped" | "ready";
}

/**
 * One row in a model's Details view: a kept hop of the routing chain, a native
 * target's one link, or a candidate the chain dropped (after the kept hops).
 */
export interface ProbeResultLink {
  provider: string;
  /** Provider display name, e.g. "OpenAI", "OpenRouter". */
  displayName: string;
  /** Resolved model id sent to the API, with NO redundant provider@ prefix. */
  modelId: string;
  /** The hop's tier label, `fallback` for the fallback position. */
  label?: string;
  hasCredentials: boolean;
  credentialHint?: string;
  probe?: ProbeResult;
  /** A native link: served on Claude Code's own auth, so it is never probed. */
  notProbed?: "native-auth";
  /** Set on a candidate the routing chain dropped: why. Never probed. */
  dropped?: DroppedOutcome;
  /**
   * The Key line of a credential that is not an env var (`keyLineText`):
   * `Muse Code borrowed copy · Muse Code Power Usage  (signed this probe request)`.
   */
  keyLine?: string;
}

/**
 * Per-model results payload the Details tab consumes (built in cli.ts from
 * `explainRoute`). The parser's provider is deliberately absent: it is not a
 * routing decision, and it stays in `--probe --json` only.
 */
export interface ProbeModelResult {
  /** User input, e.g. "gpt-5.5" or "or@deepseek-v4-pro". */
  model: string;
  /** An explicit target: `provider@model`, `poe:<id>` or `anthropic/<id>`. */
  isExplicit: boolean;
  routingSource: RouteExplanation["source"];
  /** User rule only: the rule key that matched. */
  matchedPattern?: string;
  ruleScope?: RuleScope;
  /** `describeRouteExplanation`: the one line `--probe` and the config TUI share. */
  routingExplanation: string;
  /**
   * The kept hops in chain order (a native target: its one not-probed link),
   * then one row per dropped candidate. The live count reads the kept rows only.
   */
  links: ProbeResultLink[];
  /** Set when there is no route: `route()`'s reason and hint, verbatim. */
  noRoute?: { reason: string; hint?: string };
  warnings?: RouteWarning[];
  wiring?: {
    formatAdapter: string;
    declaredStreamFormat: string;
    modelTranslator: string;
    contextWindow: number;
    supportsVision: boolean;
    transportOverride: string | null;
    effectiveStreamFormat: string;
    wireSummary?: string;
  };
}

export type ProbePhase = "live" | "done";
export type ProbeTab = "summary" | "leaderboard" | "details";

export interface ProbeAppState {
  steps: ProbeStepState[];
  links: ProbeLinkState[];
  /** "live" while probing; "done" after results land (interactive tabs). */
  phase: ProbePhase;
  /** Per-model results — populated when probing completes. */
  results: ProbeModelResult[];
  /** Active tab in the "done" phase. */
  activeTab: ProbeTab;
}

// ── External store ──────────────────────────────────────────────────

/**
 * A tiny observable state holder. Lives outside React so imperative async
 * code in cli.ts can mutate state via setState() and trigger re-renders.
 */
export class ProbeStore {
  private state: ProbeAppState;
  private listeners: Set<() => void> = new Set();

  constructor(initial: ProbeAppState) {
    this.state = initial;
  }

  getState(): ProbeAppState {
    return this.state;
  }

  setState(updater: (prev: ProbeAppState) => ProbeAppState): void {
    this.state = updater(this.state);
    for (const fn of this.listeners) fn();
  }

  /** Land the results payload and flip to the interactive "done" phase. */
  setResults(results: ProbeModelResult[]): void {
    this.setState((prev) => ({ ...prev, results, phase: "done" }));
  }

  setActiveTab(tab: ProbeTab): void {
    this.setState((prev) => ({ ...prev, activeTab: tab }));
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

export function useProbeStore(store: ProbeStore): ProbeAppState {
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  return store.getState();
}

/**
 * MOVED to `tui/hooks/useAnimationFrame.ts`, and re-exported here for one
 * release so no `probe/` importer has to change. It is the only exported tick
 * source in the repo and a second OpenTUI app needed it without dragging this
 * whole component module along; `probe/ → tui/` is an edge that already exists
 * (see the `../tui/theme.js` import above), the reverse is not.
 *
 * Removal trigger: delete this line when the picker has shipped and no importer
 * outside `probe/` reads it from here.
 */
export { useAnimationFrame };

// ── Helpers ────────────────────────────────────────────────────────

const ANIM_FRAMES = ["\u2593", "\u2592", "\u2591", "\u2592"]; // ▓ ▒ ░ ▒
// Aligned-columns layout (>=100 cols). The narrow-degradation ladder shrinks /
// drops these per terminal width (see deriveLayout below).
const TIMELINE_BAR_FULL = 24; // B
const TIMELINE_BAR_NARROW = 12; // B when <80 cols
const TOK_BAR_FULL = 14; // T
const TOTAL_COL = 7; // right-aligned "14.34s"
/** The live row's leading `"    MM:SS  "` — 4 indent + 5 clock + 2 gap. */
const ELAPSED_COL = 11;
// Each stage number is right-aligned to STAGE_NUM_W so the inner net/srv/str
// columns line up across rows. W=6 fits the realistic worst case "21.05s".
const STAGE_NUM_W = 6;
// Breakdown column = "  net " (6) + W + " srv " (5) + W + " str " (5) + W.
const BREAKDOWN_COL = 16 + 3 * STAGE_NUM_W;
const TOK_VALUE_COL = 7; // right-aligned "999 t/s"
const TRACK_CHAR = "·"; // · dim idle track
const BAR_FILL = "█"; // █ tok/s fill mark

/** Per-width layout tier for the aligned-columns probe rows. */
interface ProbeLayout {
  /** Timeline bar width B (0 = drop the timeline bar entirely). */
  barWidth: number;
  /** Tok/s bar width T (0 = drop the tok/s bar, keep the number). */
  tokWidth: number;
  /** Whether to render the colored net/srv/str breakdown column. */
  showBreakdown: boolean;
  /** Whether to fall back to today's single latency pill (<60 cols). */
  pillFallback: boolean;
  /**
   * The terminal width this layout was derived from.
   *
   * Carried because the pill fallback renders a failure reason with NO column to
   * clip against — it has no timeline slot, which is where every other layout
   * puts the reason and where the clipping happens. Without a width, a long
   * provider message wrapped across as many rows as it needed, over the rows
   * already drawn.
   */
  width: number;
}

/**
 * Narrow-degradation ladder, keyed on terminal width:
 *   >=100 -> B=24, T=14, full breakdown
 *   <100  -> drop tok/s BAR (keep the number)
 *   <80   -> shrink B 24->12, drop BREAKDOWN
 *   <60   -> drop timeline bar too; single latency pill
 * PROV + TOTAL + status never drop.
 */
function deriveLayout(width: number): ProbeLayout {
  if (width < 60) {
    return { barWidth: 0, tokWidth: 0, showBreakdown: false, pillFallback: true, width };
  }
  if (width < 80) {
    return {
      barWidth: TIMELINE_BAR_NARROW,
      tokWidth: 0,
      showBreakdown: false,
      pillFallback: false,
      width,
    };
  }
  if (width < 100) {
    return {
      barWidth: TIMELINE_BAR_FULL,
      tokWidth: 0,
      showBreakdown: true,
      pillFallback: false,
      width,
    };
  }
  return {
    barWidth: TIMELINE_BAR_FULL,
    tokWidth: TOK_BAR_FULL,
    showBreakdown: true,
    pillFallback: false,
    width,
  };
}

/** Compute the full row width for a given layout + name column width, so the
 *  model header bar spans exactly the row. */
function computeRowWidth(layout: ProbeLayout, maxNameLen: number): number {
  // [4 indent][5 MM:SS][2 gap][N name][2 gap]
  let w = 4 + 5 + 2 + maxNameLen + 2;
  if (layout.pillFallback) {
    // name + total pill only (status carried by the pill / status text).
    w += TOTAL_COL + 2 + 25; // total + gap + generous status span
    return w;
  }
  // [B timeline][2 gap][7 TOTAL]
  w += layout.barWidth + 2 + TOTAL_COL;
  if (layout.showBreakdown) {
    // BREAKDOWN_COL already includes its own leading "  " gap (the "  net …").
    w += BREAKDOWN_COL;
  } else {
    // No breakdown → the 2-space gap before the tok column lives here instead.
    w += 2;
  }
  if (layout.tokWidth > 0) {
    // [T TOK bar][1 gap]
    w += layout.tokWidth + 1;
  }
  // [7 t/s value]
  w += TOK_VALUE_COL;
  return w;
}

/** Right-align a plain string into `n` columns (truncate if longer). */
function padStartSafe(s: string, n: number): string {
  if (s.length >= n) return s.slice(s.length - n);
  return " ".repeat(n - s.length) + s;
}

/** Breakdown number for one stage: bare integer ms, or formatLatency form
 *  (e.g. "3.10s") once it crosses 1000ms. */
function breakdownNum(ms: number): string {
  if (ms >= 1000) return formatLatency(ms);
  return `${Math.round(Math.max(0, ms))}`;
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

function padEndSafe(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + " ".repeat(n - s.length);
}

/**
 * Clip a failure reason to what is left of the terminal, ending in an ellipsis
 * so a cut reads as a cut. Never pads: the reason is the last thing on its row.
 */
function clipReason(s: string, width: number): string {
  const room = Math.max(8, width - 2);
  return s.length <= room ? s : `${s.slice(0, room - 1)}…`;
}

/**
 * Make provider text safe to paint on ONE row: no escape sequences, no control
 * characters, no line breaks.
 *
 * The newline half is not cosmetic. Every caller is rendering an error message
 * into a fixed-width slot, and `padEndSafe` clips by CHARACTER COUNT — so a `\n`
 * that lands inside the clip survives it, ends the row where the terminal says
 * it ends rather than where the layout says, and pushes the remaining columns
 * onto the line below, over whatever is already there. `probe-live.ts` now
 * flattens its messages at the source; this is the second wall, because the
 * string also reaches here from provider text that never passed through there.
 */
function stripAnsi(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences require control chars
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
      // Whitespace RUNS, not just newlines: a collapsed frame otherwise leaves a
      // gap the width of its indentation in the middle of the sentence.
      .replace(/\s+/g, " ")
      .trim()
  );
}

// ── Banner ─────────────────────────────────────────────────────────

/**
 * "ish" wordmark green — a FUNCTION resolved at render time, not a const:
 * this module loads before theme detection completes, so a const would latch
 * the dark value forever. Bright spring green pops against a dark terminal
 * bg; on a light page it washes out, so light gets a deep emerald instead.
 */
function ishGreen(): string {
  return getThemeMode() === "light" ? "#047857" : "#00ff7f";
}

function Banner() {
  // Big "CLAUD" in orange block letters (6 rows, ~42 cols wide), with a smaller
  // "ish" in green half-block letters — matching the official claudish wordmark
  // where "ish" sits as a small lowercase suffix at the baseline of CLAUD.
  //
  // The "ish" letters use half-block Unicode chars (▀▄█) to pack 6 pixel rows
  // into 3 terminal rows — giving the same vertical pixel density as CLAUD
  // while being visually half the height. "ish" is placed on rows 4-6 of the
  // 6-row CLAUD block (baseline-aligned to CLAUD's bottom).
  const claudLines = [
    "   \u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2557      \u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2557   \u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2557 ",
    "  \u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255D\u2588\u2588\u2551     \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557",
    "  \u2588\u2588\u2551     \u2588\u2588\u2551     \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2551  \u2588\u2588\u2551",
    "  \u2588\u2588\u2551     \u2588\u2588\u2551     \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2551\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2551  \u2588\u2588\u2551",
    "  \u255A\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2551  \u2588\u2588\u2551\u255A\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D",
    "   \u255A\u2550\u2550\u2550\u2550\u2550\u255D\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u255D\u255A\u2550\u255D  \u255A\u2550\u255D \u255A\u2550\u2550\u2550\u2550\u2550\u255D \u255A\u2550\u2550\u2550\u2550\u2550\u255D ",
  ];

  // "ish" rendered as 4 rows of clean serifed ASCII text. Positioned on rows
  // 3-6 of the 6-row CLAUD block (one row lower than before, baseline-aligned
  // to CLAUD's bottom). Each row is wrapped in a brown-background box.
  //
  //   _    _
  //  (_)__| |_
  //  | (_-< ' \
  //  |_/__/_||_|
  const ishLines = ["  _    _    ", " (_)__| |_  ", " | (_-< ' \\ ", " |_/__/_||_|"];

  const ishPad = "  "; // 2 spaces between CLAUD and "ish"

  // Render one banner row as: orange CLAUD text + gap + bold bright-green ish text.
  const renderBannerRow = (claudLine: string, ishLine: string | null, key: number) => (
    <box key={key} flexDirection="row">
      <text>
        <span fg={C.orange}>{claudLine}</span>
      </text>
      {ishLine !== null && (
        <>
          <text>{ishPad}</text>
          <text>
            <span fg={ishGreen()} attributes={A.bold}>
              {ishLine}
            </span>
          </text>
        </>
      )}
    </box>
  );

  return (
    <box flexDirection="column">
      {renderBannerRow(claudLines[0], null, 0)}
      {renderBannerRow(claudLines[1], null, 1)}
      {renderBannerRow(claudLines[2], ishLines[0], 2)}
      {renderBannerRow(claudLines[3], ishLines[1], 3)}
      {renderBannerRow(claudLines[4], ishLines[2], 4)}
      {renderBannerRow(claudLines[5], ishLines[3], 5)}
      <text>
        <span fg={C.dim}>{"  Provider Routing Probe"}</span>
        <span fg={C.dim}>{" ".repeat(38)}</span>
        <span fg={C.dim}>{`v${VERSION}`}</span>
      </text>
    </box>
  );
}

// ── Step indicator ─────────────────────────────────────────────────

// ── Progress bar row ───────────────────────────────────────────────

/**
 * One aligned-columns row per link. Layout (>=100 cols):
 *
 *   [4 indent][5 MM:SS][2][N name][2][B TIMELINE bar][2][7 TOTAL][2]
 *   [22 BREAKDOWN][2][T TOK/S bar][1][7 "NNN t/s"]
 *
 * - TIMELINE bar: stacked 3-segment bg-on-spaces bar on a shared global scale
 *   (slowest link in the run = full B). Trailing cells = dim track.
 * - TOK/S bar: fg block on a dim track, shared scale (fastest generator = full
 *   T). A brightGreen dot follows the t/s value of the run-fastest live link.
 * - Non-live rows keep the columns but blank both bars to a dim track.
 */
function ProgressBar({
  link,
  animFrame,
  maxNameLen,
  layout,
  maxTotalMs,
  maxTokPerSec,
  isRunFastest,
}: {
  link: ProbeLinkState;
  animFrame: number;
  maxNameLen: number;
  layout: ProbeLayout;
  maxTotalMs: number;
  maxTokPerSec: number;
  isRunFastest: boolean;
}) {
  const elapsedMs =
    link.status === "waiting"
      ? 0
      : link.startTime
        ? (link.endTime ?? Date.now()) - link.startTime
        : 0;
  // A row nothing was sent down has no clock: a blank keeps the column aligned.
  const elapsed = link.status === "not-probed" ? "  –  " : formatElapsed(elapsedMs);
  const displayName = padEndSafe(link.displayName, maxNameLen);

  const prefix = (
    <>
      <span fg={C.dim}>{`    ${elapsed}  `}</span>
      <span fg={C.fg}>{displayName}</span>
      <span fg={C.dim}>{"  "}</span>
    </>
  );

  // —— NOT PROBED: a native link, a dropped candidate, or a hop under --no-probe.
  // No bar, no status marker: the note is the whole story and runs to the edge.
  // Colour per kind, read from C at render time.
  if (link.status === "not-probed") {
    const used = ELAPSED_COL + maxNameLen + 2;
    const fg = link.tone === "native" ? C.cyan : link.tone === "ready" ? C.green : C.dim;
    return (
      <text>
        {prefix}
        <span fg={fg}>{clipReason(stripAnsi(link.note ?? "not probed"), layout.width - used)}</span>
      </text>
    );
  }

  // \u2014\u2014 <60 col fallback: name + single latency pill (today's behavior) \u2014\u2014
  if (layout.pillFallback) {
    if (link.status === "live") {
      const latency = link.timing?.totalMs ?? elapsedMs;
      return (
        <text>
          {prefix}
          <span fg={C.green}>{"\u2713 live \u00B7 "}</span>
          <span fg={latencyFg} bg={latencyBg(latency)}>
            {` ${formatLatency(latency)} `}
          </span>
        </text>
      );
    }
    return (
      <text>
        {prefix}
        {renderNonLiveStatus(link, /* hasSlot */ false, layout.width)}
      </text>
    );
  }

  // \u2014\u2014 FAILED row: the reason gets the WHOLE rest of the line \u2014\u2014
  //
  // A failed row draws no timeline bar, no breakdown and no tok/s bar, so every
  // column after the provider name is dead space. It used to be spent on
  // alignment anyway: the reason was padded into the `barWidth` slot (24 cols)
  // so a trailing \u2717 could line up with the live rows above. At 24 columns
  // "\u2717 error \u00b7 403 \u00b7 1151ms \u2014 Model access denied." clips to
  // "\u2717 error \u00b7 403 \u00b7 1151ms \u2014", which ends on a dash promising a sentence that
  // was thrown away \u2014 the one line on the row the reader needed.
  //
  // So the marker goes (the reason already starts with \u2717; a second one said
  // nothing) and the reason runs to the edge of the terminal.
  if (link.status === "failed") {
    const used = ELAPSED_COL + maxNameLen + 2;
    return (
      <text>
        {prefix}
        <span fg={C.red}>
          {clipReason(`\u2717 ${stripAnsi(link.error || "failed")}`, layout.width - used)}
        </span>
      </text>
    );
  }

  // \u2014\u2014 Other non-live rows (probing / waiting): blank both bars to a track \u2014\u2014
  // These DO keep the aligned slot: the animated bar is positional feedback, and
  // it only reads as progress when it sits where the finished bars will sit.
  if (link.status !== "live" || !link.timing) {
    return (
      <text>
        {prefix}
        {renderTimelineSlot(link, animFrame, layout.barWidth)}
        <span fg={C.dim}>{"  "}</span>
        {renderNonLiveStatus(link, /* hasSlot */ true, layout.width)}
      </text>
    );
  }

  // \u2014\u2014 Live row: full aligned columns \u2014\u2014
  const t = link.timing;
  const barCells = timelineBarCells(t.totalMs, maxTotalMs, layout.barWidth);
  const stages = splitStageCells(t.ttfbMs, t.ttftMs, t.totalMs, barCells);
  const trackCells = Math.max(0, layout.barWidth - barCells);

  const netMs = Math.max(0, t.ttfbMs);
  const srvMs = Math.max(0, t.ttftMs - t.ttfbMs);
  const strMs = Math.max(0, t.totalMs - t.ttftMs);

  // Bar length relative-to-max (comparison); color absolute (throughput health).
  const tokColor = throughputFg(t.tokensPerSec);
  const tokCells =
    layout.tokWidth > 0 ? tokBarCells(t.tokensPerSec, maxTokPerSec, layout.tokWidth) : 0;
  const tokTrack = Math.max(0, layout.tokWidth - tokCells);
  const tokValue = padStartSafe(`${Math.round(t.tokensPerSec)} t/s`, TOK_VALUE_COL);

  // BREAKDOWN: build the three colored numbers, then pad the whole column to a
  // FIXED BREAKDOWN_COL width with a trailing dim spacer so every column to the
  // right stays aligned (and the row never exceeds rowWidth, which would break
  // the header bar span). A stage \u22651000ms can widen a number, so the spacer is
  // clamped to \u22650.
  // Each number is right-aligned to a FIXED sub-width so the net/srv/str inner
  // columns line up across every row (e.g. "srv 1" / "srv 310" / "srv 939" all
  // end at the same x). Without per-field padding the labels after them drift
  // row-to-row — that was the visible misalignment. STAGE_NUM_W fits "21.05s".
  const netStr = padStartSafe(breakdownNum(netMs), STAGE_NUM_W);
  const srvStr = padStartSafe(breakdownNum(srvMs), STAGE_NUM_W);
  const strStr = padStartSafe(breakdownNum(strMs), STAGE_NUM_W);

  return (
    <text>
      {prefix}
      {/* TIMELINE bar \u2014 bg-on-spaces segments + dim track */}
      {stages.network > 0 && <span bg={STAGE_BG.network}>{" ".repeat(stages.network)}</span>}
      {stages.server > 0 && <span bg={STAGE_BG.server}>{" ".repeat(stages.server)}</span>}
      {stages.streaming > 0 && <span bg={STAGE_BG.streaming}>{" ".repeat(stages.streaming)}</span>}
      {trackCells > 0 && <span fg={C.dim}>{TRACK_CHAR.repeat(trackCells)}</span>}
      <span fg={C.dim}>{"  "}</span>
      {/* TOTAL \u2014 right-aligned, white */}
      <span fg={C.strong}>{padStartSafe(formatLatency(t.totalMs), TOTAL_COL)}</span>
      {/* BREAKDOWN \u2014 net/srv/str, each number STAGE_FG-colored, padded to a
          fixed BREAKDOWN_COL width via a trailing dim spacer. */}
      {layout.showBreakdown && (
        <>
          <span fg={C.dim}>{"  net "}</span>
          <span fg={STAGE_FG.network}>{netStr}</span>
          <span fg={C.dim}>{" srv "}</span>
          <span fg={STAGE_FG.server}>{srvStr}</span>
          <span fg={C.dim}>{" str "}</span>
          <span fg={STAGE_FG.streaming}>{strStr}</span>
        </>
      )}
      {/* TOK/S bar \u2014 fg block on dim track, heat-colored */}
      {layout.tokWidth > 0 && (
        <>
          <span fg={C.dim}>{"  "}</span>
          {tokCells > 0 && <span fg={tokColor}>{BAR_FILL.repeat(tokCells)}</span>}
          {tokTrack > 0 && <span fg={C.dim}>{TRACK_CHAR.repeat(tokTrack)}</span>}
          <span fg={C.dim}> </span>
        </>
      )}
      {layout.tokWidth === 0 && <span fg={C.dim}>{"  "}</span>}
      {/* TOK/S value \u2014 same heat color; brightGreen dot if run-fastest */}
      <span fg={tokColor}>{tokValue}</span>
      {isRunFastest && <span fg={C.brightGreen}>{" \u25CF"}</span>}
    </text>
  );
}

/** TIMELINE slot for a non-live link \u2014 keeps the bar column aligned. */
function renderTimelineSlot(link: ProbeLinkState, animFrame: number, barWidth: number) {
  if (barWidth <= 0) return null;
  switch (link.status) {
    case "probing": {
      let animated = "";
      for (let i = 0; i < barWidth; i++) {
        animated += ANIM_FRAMES[(animFrame + i) % ANIM_FRAMES.length];
      }
      return <span fg={C.cyan}>{animated}</span>;
    }
    case "failed":
      return (
        <span fg={C.red}>
          {padEndSafe(`\u2717 ${stripAnsi(link.error || "failed")}`, barWidth)}
        </span>
      );
    default:
      return <span fg={C.dim}>{"\u2591".repeat(barWidth)}</span>;
  }
}

/**
 * Status text for a non-live link (probing / waiting / failed).
 *
 * `hasSlot` = true when a TIMELINE slot is also rendered for this row (the
 * normal layout): in that case the failed REASON already lives in the slot, so
 * the status is a bare red `\u2717` marker \u2014 no duplicate error text. When `hasSlot`
 * is false (the <60-col pill fallback, no slot), the status carries the reason
 * itself \u2014 CLIPPED to the terminal, because there is no column to clip it to.
 * Unclipped, a 400-character provider message wrapped across every row below it.
 */
function renderNonLiveStatus(link: ProbeLinkState, hasSlot: boolean, width: number) {
  switch (link.status) {
    case "probing": {
      const elapsedMs = link.startTime ? Date.now() - link.startTime : 0;
      return <span fg={C.cyan}>{`\u23F3 probing ${formatElapsed(elapsedMs)}`}</span>;
    }
    case "failed":
      return hasSlot ? (
        <span fg={C.red}>{"\u2717"}</span>
      ) : (
        <span fg={C.red}>{clipReason(`\u2717 ${stripAnsi(link.error || "failed")}`, width)}</span>
      );
    default:
      return <span fg={C.dim}>{"\u23F3 waiting\u2026"}</span>;
  }
}

// ── Model progress group ───────────────────────────────────────────

function ModelGroup({
  model,
  links,
  animFrame,
  maxNameLen,
  rowWidth,
  isLast,
  layout,
  maxTotalMs,
  maxTokPerSec,
  fastestLinkId,
}: {
  model: string;
  links: ProbeLinkState[];
  animFrame: number;
  maxNameLen: number;
  rowWidth: number;
  isLast: boolean;
  layout: ProbeLayout;
  maxTotalMs: number;
  maxTokPerSec: number;
  fastestLinkId: string | null;
}) {
  // Center the model name in a colored header bar that spans the full row width.
  // Use a 2-char left margin so the header aligns with the bar rows below.
  const headerWidth = rowWidth - 2;
  const totalPad = Math.max(0, headerWidth - model.length);
  const leftPad = Math.floor(totalPad / 2);
  const rightPad = totalPad - leftPad;
  const headerText = " ".repeat(leftPad) + model + " ".repeat(rightPad);

  return (
    <box flexDirection="column" marginBottom={isLast ? 0 : 1}>
      {/* Section header — colored bar with centered model name, left-aligned with bars below */}
      <box flexDirection="row">
        <text>{"  "}</text>
        <box backgroundColor={C.bgHighlight}>
          <text>
            <span fg={C.strong} attributes={A.bold}>
              {headerText}
            </span>
          </text>
        </box>
      </box>
      {links.map((link) => (
        <ProgressBar
          key={link.id}
          link={link}
          animFrame={animFrame}
          maxNameLen={maxNameLen}
          layout={layout}
          maxTotalMs={maxTotalMs}
          maxTokPerSec={maxTokPerSec}
          isRunFastest={fastestLinkId === link.id}
        />
      ))}
    </box>
  );
}

// ── Main app ───────────────────────────────────────────────────────

// Banner is 6 CLAUD rows + 1 subtitle row = 7. Steps block has paddingY={1}
// (top+bottom = 2) plus one row per step. We reserve that fixed chrome so the
// scrollable model list gets the remaining terminal rows as its viewport.
const BANNER_ROWS = 7;
const SCROLL_HINT_ROWS = 1;
const LEGEND_ROWS = 2; // 1 compact swatch+caption line + 1 dim rule
const MIN_LIST_H = 4;
// DONE-phase tab bar: 1 tab row + 1 blank spacer row.
const TAB_BAR_ROWS = 2;

/**
 * Interactive tab bar shown in the "done" phase. Active tab reads cyan+bold;
 * inactive reads dim. A right-aligned key hint sits on the same row.
 */
function TabBar({ activeTab }: { activeTab: ProbeTab }) {
  // Background-filled pills (using the dedicated tab theme) so the active tab is
  // unmistakable at a glance — the previous dim/cyan TEXT-only treatment read as
  // weak. Active = solid blue fill + white bold; inactive = dark fill + blue.
  // Key shortcuts are intentionally NOT shown here — they live in the bottom
  // hint line, so the tab bar stays a clean two-pill selector.
  const tab = (label: string, active: boolean) => (
    <span
      bg={active ? C.tabActiveBg : C.tabInactiveBg}
      fg={active ? C.tabActiveFg : C.tabInactiveFg}
      attributes={active ? A.bold : undefined}
    >
      {`  ${label}  `}
    </span>
  );
  return (
    <box flexDirection="column" paddingTop={1} paddingBottom={1}>
      <text>
        <span fg={C.dim}>{"  "}</span>
        {tab("1 Summary", activeTab === "summary")}
        <span> </span>
        {tab("2 Leaderboard", activeTab === "leaderboard")}
        <span> </span>
        {tab("3 Details", activeTab === "details")}
      </text>
    </box>
  );
}

/**
 * Top legend — ONE compact line (stage swatches + a terse caption) + a dim rule.
 * The colored swatches carry the meaning; the caption is kept short so the whole
 * legend is two rows instead of four.
 */
function Legend({ rowWidth }: { rowWidth: number }) {
  const ruleWidth = Math.max(1, Math.min(rowWidth, 120));
  return (
    <box flexDirection="column">
      <text>
        <span bg={STAGE_BG.network}>{"  "}</span>
        <span fg={STAGE_FG.network}>{" net "}</span>
        <span bg={STAGE_BG.server}>{"  "}</span>
        <span fg={STAGE_FG.server}>{" srv "}</span>
        <span bg={STAGE_BG.streaming}>{"  "}</span>
        <span fg={STAGE_FG.streaming}>{" str "}</span>
        <span fg={C.dim}>
          {"·· idle  ·  bar = total time (shared scale) · tok/s color = absolute"}
        </span>
      </text>
      <text>
        <span fg={C.dim}>{`  ${"─".repeat(ruleWidth)}`}</span>
      </text>
    </box>
  );
}

// ── Details view ───────────────────────────────────────────────────
//
// Per model: one header line (bold name + dim routing explanation), one row per
// provider-comparison link (winner ● + displayName + ✓/✗ + the SAME aligned
// timeline/breakdown/tok columns as the leaderboard), and one dim wire line.
// NO full-row background slab — emphasis comes from ●, bar length, and the
// ABSOLUTE throughput color only. Failed links keep the provider column aligned
// and carry a dim-red short reason instead of a bar.

function formatContextWindow(ctx: number): string {
  if (ctx <= 0) return "0";
  if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(1)}M`;
  return `${Math.round(ctx / 1000)}K`;
}

/**
 * Bare model name to key a suggested routing rule on. Strips any `provider@`
 * prefix (e.g. `or@grok-4.3` → `grok-4.3`) so the suggested rule keys on the
 * model the way the user would type it. The vendor path (`x-ai/grok-4.3`) is
 * kept as-is — that's a valid routing-rule key too.
 */
function ruleKeyForModel(model: string): string {
  const at = model.indexOf("@");
  return at >= 0 ? model.slice(at + 1) : model;
}

/**
 * Visible width of a Details live row, mirroring the columns rendered in
 * DetailLinkRow. The header's routing explanation right-aligns to this so it
 * hugs the right edge of the row content (not the oversized live-view rowWidth).
 *   [2 indent][1 ●][1 sp][provW][2 sp][✓/✗ 1][2 sp][B timeline][2][7 TOTAL]
 *   [BREAKDOWN][2 or tok][T tok bar][1][7 tok value]
 */
function detailRowWidth(provW: number, layout: ProbeLayout): number {
  let w = 2 + 1 + 1 + provW + 2 + 1 + 2; // up to start of timeline
  w += layout.barWidth + 2 + TOTAL_COL;
  if (layout.showBreakdown) w += BREAKDOWN_COL;
  else w += 2;
  if (layout.tokWidth > 0) w += layout.tokWidth + 1;
  w += TOK_VALUE_COL;
  return w;
}

/** Short, dim-red failure reason for a non-live link (mirrors describeProbeState). */
function shortFailureReason(probe: ProbeResult | undefined, hasCreds: boolean): string {
  if (!probe) return hasCreds ? "not probed" : "key missing";
  if (probe.state === "key-missing") return "key missing";
  return stripAnsi(describeProbeState(probe));
}

/**
 * The marker and text of a Details row nothing was sent down, or null for a row
 * that was probed. A native link is a third outcome (neither ✓ nor ✗); a dropped
 * candidate says why the chain dropped it and, when known, the remedy; a kept hop
 * under `--no-probe` says only that it was not probed. Colours come from C at
 * render time.
 */
function notProbedRow(link: ProbeResultLink): { mark: string; text: string; fg: string } | null {
  if (link.notProbed) return { mark: "◐  ", text: `native — ${NATIVE_NOT_PROBED}`, fg: C.cyan };
  if (link.dropped) {
    return { mark: "–  ", text: describeDropped(link.dropped, link.credentialHint), fg: C.dim };
  }
  if (!link.probe && link.hasCredentials) return { mark: "○  ", text: "not probed", fg: C.dim };
  return null;
}

/**
 * One Details row per provider link. Live links render the aligned
 * timeline/breakdown/tok columns; failed links render a dim-red reason. The
 * winner (first live+timed link) gets a brightGreen ●; everyone else a space,
 * so the provider column lines up across both row types.
 */
function DetailLinkRow({
  link,
  isWinner,
  provW,
  layout,
  maxTotalMs,
  maxTokPerSec,
}: {
  link: ProbeResultLink;
  isWinner: boolean;
  provW: number;
  layout: ProbeLayout;
  maxTotalMs: number;
  maxTokPerSec: number;
}) {
  const probe = link.probe;
  const isLive = probe?.state === "live" && !!probe.timing;
  const winnerMark = isWinner ? <span fg={C.brightGreen}>{"●"}</span> : <span> </span>;
  const provider = <span fg={C.fg}>{padEndSafe(link.displayName, provW)}</span>;
  const lead = (
    <>
      <span fg={C.dim}>{"  "}</span>
      {winnerMark}
      <span> </span>
      {provider}
      <span>{"  "}</span>
    </>
  );

  const used = 2 + 1 + 1 + provW + 2 + 3;
  const idle = notProbedRow(link);
  if (idle) {
    return (
      <text>
        {lead}
        <span fg={idle.fg}>{idle.mark}</span>
        <span fg={idle.fg}>{clipReason(idle.text, layout.width - used)}</span>
      </text>
    );
  }

  if (!isLive || !probe?.timing) {
    // Failed / missing — keep the provider column aligned, then ✗ + dim reason,
    // CLIPPED to what is left of the terminal. `describeProbeState` returns the
    // provider's own sentence and a provider is free to make it 400 characters
    // long; unclipped it wrapped over the rows below instead of ending.
    return (
      <text>
        {lead}
        <span fg={C.red}>{"✗  "}</span>
        <span fg={C.red}>
          {clipReason(shortFailureReason(probe, link.hasCredentials), layout.width - used)}
        </span>
      </text>
    );
  }

  // Live row — full aligned columns, identical math to the leaderboard rows.
  const t = probe.timing;
  const barCells = timelineBarCells(t.totalMs, maxTotalMs, layout.barWidth);
  const stages = splitStageCells(t.ttfbMs, t.ttftMs, t.totalMs, barCells);
  const trackCells = Math.max(0, layout.barWidth - barCells);

  const netMs = Math.max(0, t.ttfbMs);
  const srvMs = Math.max(0, t.ttftMs - t.ttfbMs);
  const strMs = Math.max(0, t.totalMs - t.ttftMs);
  const netStr = padStartSafe(breakdownNum(netMs), STAGE_NUM_W);
  const srvStr = padStartSafe(breakdownNum(srvMs), STAGE_NUM_W);
  const strStr = padStartSafe(breakdownNum(strMs), STAGE_NUM_W);

  // Bar LENGTH relative-to-max (comparison); bar/value COLOR absolute (health).
  const tokColor = throughputFg(t.tokensPerSec);
  const tokCells =
    layout.tokWidth > 0 ? tokBarCells(t.tokensPerSec, maxTokPerSec, layout.tokWidth) : 0;
  const tokTrack = Math.max(0, layout.tokWidth - tokCells);
  const tokValue = padStartSafe(`${Math.round(t.tokensPerSec)} t/s`, TOK_VALUE_COL);

  return (
    <text>
      {lead}
      <span fg={C.green}>{"✓  "}</span>
      {/* TIMELINE bar — bg-on-spaces segments + dim track */}
      {stages.network > 0 && <span bg={STAGE_BG.network}>{" ".repeat(stages.network)}</span>}
      {stages.server > 0 && <span bg={STAGE_BG.server}>{" ".repeat(stages.server)}</span>}
      {stages.streaming > 0 && <span bg={STAGE_BG.streaming}>{" ".repeat(stages.streaming)}</span>}
      {trackCells > 0 && <span fg={C.dim}>{TRACK_CHAR.repeat(trackCells)}</span>}
      <span fg={C.dim}>{"  "}</span>
      {/* TOTAL — right-aligned, white */}
      <span fg={C.strong}>{padStartSafe(formatLatency(t.totalMs), TOTAL_COL)}</span>
      {/* BREAKDOWN — net/srv/str, STAGE_FG-colored */}
      {layout.showBreakdown && (
        <>
          <span fg={C.dim}>{"  net "}</span>
          <span fg={STAGE_FG.network}>{netStr}</span>
          <span fg={C.dim}>{" srv "}</span>
          <span fg={STAGE_FG.server}>{srvStr}</span>
          <span fg={C.dim}>{" str "}</span>
          <span fg={STAGE_FG.streaming}>{strStr}</span>
        </>
      )}
      {/* TOK/S bar — fg block on dim track, heat-colored */}
      {layout.tokWidth > 0 && (
        <>
          <span fg={C.dim}>{"  "}</span>
          {tokCells > 0 && <span fg={tokColor}>{BAR_FILL.repeat(tokCells)}</span>}
          {tokTrack > 0 && <span fg={C.dim}>{TRACK_CHAR.repeat(tokTrack)}</span>}
          <span fg={C.dim}> </span>
        </>
      )}
      {layout.tokWidth === 0 && <span fg={C.dim}>{"  "}</span>}
      <span fg={tokColor}>{tokValue}</span>
    </text>
  );
}

/** One model block in the Details tab: header + link rows + wire line. */
function DetailModel({
  result,
  provW,
  headerW,
  layout,
  maxTotalMs,
  maxTokPerSec,
  isLast,
}: {
  result: ProbeModelResult;
  provW: number;
  headerW: number;
  layout: ProbeLayout;
  maxTotalMs: number;
  maxTokPerSec: number;
  isLast: boolean;
}) {
  // Winner = first link that probed live+timed (the route claudish uses).
  const winnerIdx = result.links.findIndex((l) => l.probe?.state === "live" && !!l.probe.timing);
  const winner = winnerIdx >= 0 ? result.links[winnerIdx] : undefined;

  // Header: bold model name (left) + dim routing explanation (right-aligned so
  // the explanation hugs the right edge of the row content). headerW is the
  // shared row-content width (capped to the terminal) computed by DetailsView.
  const gap = Math.max(2, headerW - result.model.length - result.routingExplanation.length - 2);

  // Wire line — only when a live winner exists; reuse its wiring.
  const wiring = result.wiring;
  const wireLine =
    winner && wiring
      ? `wire (${winner.displayName}): ${wiring.wireSummary ?? `${wiring.effectiveStreamFormat} · ${wiring.modelTranslator}`} · ${formatContextWindow(wiring.contextWindow)} ctx`
      : "wire: —";

  // Key line — the credential of the link that answered, else of the first link
  // that carries one (a kept hop that failed, or a dropped no-login candidate).
  // Only a credential that is not an env var has one (Muse Code's login source
  // and tier, Vertex's project), the same text the static printer prints.
  const keyLine = (winner?.keyLine ? winner : result.links.find((l) => l.keyLine))?.keyLine;

  // ── Routing advisor ────────────────────────────────────────────────
  // Full route: the ordered chain of providers claudish would try — the kept
  // hops only, each with its tier label. Dropped rows are listed above, not here.
  const routeChain = result.links
    .filter((l) => !l.dropped)
    .map((l) => (l.label ? `${l.displayName} (${l.label})` : l.displayName))
    .join(" → ");
  const liveLinks = result.links.filter((l) => l.probe?.state === "live" && !!l.probe.timing);
  // Best live link on EACH axis: lowest total latency, and highest throughput.
  // We suggest a rule if the picked provider (winner) loses on EITHER axis —
  // "slow to finish" (latency) and "slow to stream" (tok/s) are both worth
  // flagging, and the user asked to catch either. We pick whichever non-winner
  // wins by the LARGER relative margin and label which axis it won on.
  let fastestByLatency: ProbeResultLink | undefined;
  let fastestByTput: ProbeResultLink | undefined;
  for (const l of liveLinks) {
    const t = l.probe!.timing!;
    if (!fastestByLatency || t.totalMs < fastestByLatency.probe!.timing!.totalMs) {
      fastestByLatency = l;
    }
    if (!fastestByTput || t.tokensPerSec > fastestByTput.probe!.timing!.tokensPerSec) {
      fastestByTput = l;
    }
  }
  const winnerT = winner?.probe?.timing;
  // Candidate suggestions on each axis (only when a NON-winner wins that axis).
  type Suggestion = { link: ProbeResultLink; factor: number; axis: "latency" | "throughput" };
  const candidates: Suggestion[] = [];
  if (winner && winnerT) {
    if (
      fastestByLatency &&
      fastestByLatency !== winner &&
      fastestByLatency.probe!.timing!.totalMs < winnerT.totalMs
    ) {
      candidates.push({
        link: fastestByLatency,
        factor: winnerT.totalMs / Math.max(1, fastestByLatency.probe!.timing!.totalMs),
        axis: "latency",
      });
    }
    if (
      fastestByTput &&
      fastestByTput !== winner &&
      fastestByTput.probe!.timing!.tokensPerSec > winnerT.tokensPerSec &&
      winnerT.tokensPerSec > 0
    ) {
      candidates.push({
        link: fastestByTput,
        factor: fastestByTput.probe!.timing!.tokensPerSec / winnerT.tokensPerSec,
        axis: "throughput",
      });
    }
  }
  // Show the strongest suggestion (largest relative margin).
  const suggestion = candidates.sort((a, b) => b.factor - a.factor)[0];
  const showSuggestion = !!suggestion;
  const ruleKey = ruleKeyForModel(result.model);

  return (
    <box flexDirection="column" marginBottom={isLast ? 0 : 1}>
      {/* Header line */}
      <text>
        <span fg={C.dim}>{"  "}</span>
        <span fg={C.cyan} attributes={A.bold}>
          {result.model}
        </span>
        <span fg={C.dim}>{" ".repeat(gap)}</span>
        <span fg={C.dim}>{result.routingExplanation}</span>
      </text>
      {/* No route: route()'s own reason, verbatim */}
      {result.noRoute && (
        <text>
          <span fg={C.red}>{"  no route  "}</span>
          <span fg={C.fg}>{clipReason(result.noRoute.reason, layout.width - 12)}</span>
        </text>
      )}
      {/* What route() would print to stderr for this decision (billing notices) */}
      {(result.warnings ?? [])
        .filter((w) => w.type !== "rule-problem")
        .map((w) => (
          <text key={`${result.model}:warn:${w.message}`}>
            <span fg={C.yellow}>{`  ⚠ ${clipReason(w.message, layout.width - 4)}`}</span>
          </text>
        ))}
      {/* One row per provider link */}
      {result.links.map((link, i) => (
        <DetailLinkRow
          key={`${result.model}:${link.provider}:${i}`}
          link={link}
          isWinner={i === winnerIdx}
          provW={provW}
          layout={layout}
          maxTotalMs={maxTotalMs}
          maxTokPerSec={maxTokPerSec}
        />
      ))}
      {/* Wire line (dim) */}
      <text>
        <span fg={C.dim}>{`  ${wireLine}`}</span>
      </text>
      {keyLine && (
        <text>
          <span fg={C.dim}>{"  Key  "}</span>
          <span fg={C.fgMuted}>{keyLine}</span>
        </text>
      )}
      {/* Routing advisor — full route + (when picked ≠ fastest) the rule to add */}
      <text>
        <span fg={C.dim}>{"  route: "}</span>
        <span fg={C.fgMuted}>{routeChain || "—"}</span>
        {winner && (
          <>
            <span fg={C.dim}>{"  ·  uses "}</span>
            <span fg={C.green}>{winner.displayName}</span>
            <span fg={C.dim}>{" (first credentialed live link)"}</span>
          </>
        )}
      </text>
      {showSuggestion && (
        <text>
          <span fg={C.yellow} attributes={A.bold}>
            {"  ⚡ "}
          </span>
          <span fg={C.fg}>{suggestion.link.displayName}</span>
          <span
            fg={C.green}
          >{` is ${suggestion.factor.toFixed(1)}× faster ${suggestion.axis === "latency" ? "end-to-end" : "throughput"}`}</span>
          <span fg={C.dim}>
            {suggestion.axis === "latency"
              ? ` (${formatLatency(suggestion.link.probe!.timing!.totalMs)} vs ${formatLatency(winnerT!.totalMs)})`
              : ` (${Math.round(suggestion.link.probe!.timing!.tokensPerSec)} vs ${Math.round(winnerT!.tokensPerSec)} t/s)`}
          </span>
          <span fg={C.dim}>{" — add routing: "}</span>
          {/* link.provider IS the routing-rule provider token (xai, openrouter…). */}
          <span fg={C.cyan}>{`"${ruleKey}": ["${suggestion.link.provider}"]`}</span>
        </text>
      )}
    </box>
  );
}

function DetailsView({
  results,
  layout,
  termWidth,
  maxTotalMs,
  maxTokPerSec,
}: {
  results: ProbeModelResult[];
  layout: ProbeLayout;
  termWidth: number;
  maxTotalMs: number;
  maxTokPerSec: number;
}) {
  // Shared provider-name column width so every link row across every model lines
  // up (clamped like the live view's name column).
  const provW = Math.min(
    22,
    Math.max(8, ...results.flatMap((r) => r.links.map((l) => l.displayName.length)))
  );
  // Shared header width = the live-row content width, capped to the terminal
  // (minus a 1-col scrollbar gutter) so the routing explanation hugs the right
  // edge of the rows instead of running off-screen.
  const headerW = Math.max(24, Math.min(detailRowWidth(provW, layout), (termWidth || 100) - 3));
  // Rule problems are about the config, not one model: shown once, above the models.
  const ruleProblems = [
    ...new Set(
      results.flatMap((r) =>
        (r.warnings ?? []).filter((w) => w.type === "rule-problem").map((w) => w.message)
      )
    ),
  ];
  return (
    <box flexDirection="column">
      {ruleProblems.map((message) => (
        <text key={`rule-problem:${message}`}>
          <span fg={C.yellow}>
            {`  ⚠ routing rule: ${clipReason(message, (termWidth || 100) - 20)}`}
          </span>
        </text>
      ))}
      {results.map((r, idx) => (
        <DetailModel
          key={r.model}
          result={r}
          provW={provW}
          headerW={headerW}
          layout={layout}
          maxTotalMs={maxTotalMs}
          maxTokPerSec={maxTokPerSec}
          isLast={idx === results.length - 1}
        />
      ))}
    </box>
  );
}

// ── Leaderboard view ───────────────────────────────────────────────
//
// One row per MODEL, sorted fastest→slowest by the representative route's total
// time. The representative = the first link that probed live+timed (the route
// claudish actually uses) — mirrors `pickRepresentative` in the static printer.
// Models with no live route are listed dim afterwards as "— no live route".
// The bar-onward columns (timeline / TOTAL / net-srv-str / tok/s) reuse the
// SAME layout + module constants as the Details tab so the two tabs line up.
// NO full-row bg slab — rank order + bar length carry the ranking.

interface LeaderRowData {
  model: string;
  /** Representative provider's display name (the route that would be used). */
  provider: string;
  /** Live+timed timing for the representative; undefined = no live route. */
  timing?: ProbeTiming;
  /** Why an unavailable row has no timing: `no live route`, `not probed (native)`, `no route`. */
  missing?: string;
}

/**
 * Representative entry for a model: the first link that probed live AND carried
 * timing (the route claudish would actually use). An explicit target is a
 * one-item chain, so iterating the links is the whole story. A model with none
 * is listed under its first kept hop — or, with no hop at all, under the
 * explanation line. Never under the parser's provider (`auto-route`).
 */
function pickRepresentativeLink(result: ProbeModelResult): LeaderRowData {
  for (const link of result.links) {
    if (link.probe?.state === "live" && link.probe.timing) {
      return { model: result.model, provider: link.displayName, timing: link.probe.timing };
    }
  }
  const first = result.links.find((link) => !link.dropped);
  return {
    model: result.model,
    provider: first?.displayName ?? result.routingExplanation,
    missing: first?.notProbed ? "not probed (native)" : first ? "no live route" : "no route",
  };
}

/** One leaderboard data row (a live, timed representative). */
function LeaderLiveRow({
  row,
  rank,
  isFastest,
  rankW,
  nameW,
  provW,
  layout,
  maxTotalMs,
  maxTokPerSec,
}: {
  row: LeaderRowData;
  rank: number;
  isFastest: boolean;
  rankW: number;
  nameW: number;
  provW: number;
  layout: ProbeLayout;
  maxTotalMs: number;
  maxTokPerSec: number;
}) {
  const t = row.timing!;
  // Bar-onward columns — IDENTICAL math to DetailLinkRow's live row.
  const barCells = timelineBarCells(t.totalMs, maxTotalMs, layout.barWidth);
  const stages = splitStageCells(t.ttfbMs, t.ttftMs, t.totalMs, barCells);
  const trackCells = Math.max(0, layout.barWidth - barCells);

  const netMs = Math.max(0, t.ttfbMs);
  const srvMs = Math.max(0, t.ttftMs - t.ttfbMs);
  const strMs = Math.max(0, t.totalMs - t.ttftMs);
  const netStr = padStartSafe(breakdownNum(netMs), STAGE_NUM_W);
  const srvStr = padStartSafe(breakdownNum(srvMs), STAGE_NUM_W);
  const strStr = padStartSafe(breakdownNum(strMs), STAGE_NUM_W);

  const tokColor = throughputFg(t.tokensPerSec);
  const tokCells =
    layout.tokWidth > 0 ? tokBarCells(t.tokensPerSec, maxTokPerSec, layout.tokWidth) : 0;
  const tokTrack = Math.max(0, layout.tokWidth - tokCells);
  const tokValue = padStartSafe(`${Math.round(t.tokensPerSec)} t/s`, TOK_VALUE_COL);

  // Lead-in: [2 indent][rankW rank][1][● 1][1][nameW name][1][provW provider][1]
  const lead = (
    <>
      <span fg={C.dim}>{"  "}</span>
      <span fg={C.dim}>{padStartSafe(String(rank), rankW)}</span>
      <span> </span>
      {isFastest ? <span fg={C.brightGreen}>{"●"}</span> : <span> </span>}
      <span> </span>
      <span fg={C.fg} attributes={A.bold}>
        {padEndSafe(row.model, nameW)}
      </span>
      <span> </span>
      <span fg={C.dim}>{padEndSafe(row.provider, provW)}</span>
      <span> </span>
    </>
  );

  if (layout.barWidth <= 0) {
    // <60-col fallback: name/provider + a single white TOTAL (no bars).
    return (
      <text>
        {lead}
        <span fg={C.strong}>{padStartSafe(formatLatency(t.totalMs), TOTAL_COL)}</span>
      </text>
    );
  }

  return (
    <text>
      {lead}
      {/* TIMELINE bar — bg-on-spaces segments + dim track */}
      {stages.network > 0 && <span bg={STAGE_BG.network}>{" ".repeat(stages.network)}</span>}
      {stages.server > 0 && <span bg={STAGE_BG.server}>{" ".repeat(stages.server)}</span>}
      {stages.streaming > 0 && <span bg={STAGE_BG.streaming}>{" ".repeat(stages.streaming)}</span>}
      {trackCells > 0 && <span fg={C.dim}>{TRACK_CHAR.repeat(trackCells)}</span>}
      <span fg={C.dim}>{"  "}</span>
      {/* TOTAL — right-aligned, white */}
      <span fg={C.strong}>{padStartSafe(formatLatency(t.totalMs), TOTAL_COL)}</span>
      {/* BREAKDOWN — net/srv/str values only (UNLABELED), STAGE_FG-colored. The
          leaderboard's labels live in the column header (mirrors the static
          renderLeaderboard, whose data rows are bare values too), so this is the
          narrow 22-wide variant — not the cards'/Details' labeled 34-wide one. */}
      {layout.showBreakdown && (
        <>
          <span fg={C.dim}>{"  "}</span>
          <span fg={STAGE_FG.network}>{netStr}</span>
          <span fg={C.dim}> </span>
          <span fg={STAGE_FG.server}>{srvStr}</span>
          <span fg={C.dim}> </span>
          <span fg={STAGE_FG.streaming}>{strStr}</span>
        </>
      )}
      {/* TOK/S bar — fg block on dim track, heat-colored */}
      {layout.tokWidth > 0 && (
        <>
          <span fg={C.dim}>{"  "}</span>
          {tokCells > 0 && <span fg={tokColor}>{BAR_FILL.repeat(tokCells)}</span>}
          {tokTrack > 0 && <span fg={C.dim}>{TRACK_CHAR.repeat(tokTrack)}</span>}
          <span fg={C.dim}> </span>
        </>
      )}
      {layout.tokWidth === 0 && <span fg={C.dim}>{"  "}</span>}
      <span fg={tokColor}>{tokValue}</span>
    </text>
  );
}

function LeaderboardView({
  results,
  layout,
  maxTotalMs,
  maxTokPerSec,
}: {
  results: ProbeModelResult[];
  layout: ProbeLayout;
  maxTotalMs: number;
  maxTokPerSec: number;
}) {
  const reps = results.map(pickRepresentativeLink);
  const live = reps.filter((r) => r.timing).sort((a, b) => a.timing!.totalMs - b.timing!.totalMs);
  const unavailable = reps.filter((r) => !r.timing);

  // Name + provider columns: widest entry, clamped (mirrors renderLeaderboard's
  // min(28) / min(max(8,…),18)). Shared across all rows so bars start at one x.
  const nameW = Math.min(28, Math.max(5, ...reps.map((r) => r.model.length)));
  const provW = Math.min(18, Math.max(8, ...reps.map((r) => r.provider.length)));
  const rankW = Math.max(1, String(Math.max(1, live.length)).length);

  // Column header — aligned to the data rows. The data-row lead-in before the
  // name spans rankW + 3 (gap + ● slot + gap), matching LeaderLiveRow's lead.
  const rankHdr = `${" ".repeat(rankW)}   `;

  return (
    <box flexDirection="column">
      {/* Title */}
      <text>
        <span fg={C.dim}>{"  "}</span>
        <span fg={C.cyan} attributes={A.bold}>
          {"Leaderboard"}
        </span>
        <span fg={C.dim}>{" — fastest first"}</span>
      </text>
      {/* Column header (dim) */}
      <text>
        <span fg={C.dim}>{`  ${rankHdr}`}</span>
        <span fg={C.dim}>{padEndSafe("MODEL", nameW)}</span>
        <span fg={C.dim}> </span>
        <span fg={C.dim}>{padEndSafe("PROVIDER", provW)}</span>
        <span fg={C.dim}> </span>
        {layout.barWidth > 0 && <span fg={C.dim}>{padEndSafe("TIMELINE", layout.barWidth)}</span>}
        <span fg={C.dim}>{"  "}</span>
        <span fg={C.dim}>{padStartSafe("TOTAL", TOTAL_COL)}</span>
        {layout.showBreakdown && (
          // Mirror the static renderLeaderboard header (probe-results-printer.ts):
          // the data column is "  " + val6 + " " + val6 + " " + val6, so the header
          // is "  " + padEnd("net",6) + " " + padEnd("srv",6) + " " + padEnd("str",6)
          // — left-aligned labels over the right-aligned value columns. Same
          // convention as the piped output and the spec example.
          <span fg={C.dim}>
            {`  ${padEndSafe("net", STAGE_NUM_W)} ${padEndSafe("srv", STAGE_NUM_W)} ${padEndSafe("str", STAGE_NUM_W)}`}
          </span>
        )}
        {layout.tokWidth > 0 ? (
          // Data: "  " + tokBar(tokWidth) + " " + tokValue(TOK_VALUE_COL). The
          // caption sits over the value column (right-aligned like the value).
          <span
            fg={C.dim}
          >{`  ${" ".repeat(layout.tokWidth + 1)}${padStartSafe("tok/s", TOK_VALUE_COL)}`}</span>
        ) : (
          <span fg={C.dim}>{`  ${padStartSafe("tok/s", TOK_VALUE_COL)}`}</span>
        )}
      </text>
      {/* Live rows — fastest first */}
      {live.map((row, idx) => (
        <LeaderLiveRow
          key={`lb:${row.model}`}
          row={row}
          rank={idx + 1}
          isFastest={idx === 0}
          rankW={rankW}
          nameW={nameW}
          provW={provW}
          layout={layout}
          maxTotalMs={maxTotalMs}
          maxTokPerSec={maxTokPerSec}
        />
      ))}
      {/* Unavailable models — dim, no bar. Provider column kept aligned. */}
      {unavailable.map((row) => (
        <text key={`lb-na:${row.model}`}>
          <span fg={C.dim}>{`  ${" ".repeat(rankW)}   `}</span>
          <span fg={C.dim}>{padEndSafe(row.model, nameW)}</span>
          <span fg={C.dim}> </span>
          <span fg={C.dim}>{padEndSafe(row.provider, provW)}</span>
          <span fg={C.dim}>{` — ${row.missing}`}</span>
        </text>
      ))}
    </box>
  );
}

export function ProbeApp({
  store,
  onQuit,
}: {
  store: ProbeStore;
  onQuit?: () => void;
}) {
  const state = useProbeStore(store);
  const animFrame = useAnimationFrame(state.phase === "live");
  const { height: termHeight, width: termWidth } = useTerminalDimensions();

  const isDone = state.phase === "done";

  // Ref to the native OpenTUI scrollbox. We scroll it IMPERATIVELY from the
  // keyboard handler below (rather than relying on focus routing reaching the
  // box) — this is the same proven pattern the config TUI uses, and it works in
  // inline (non-alternate-screen) mode where focus-based key delivery is unreliable.
  const listScrollRef = useRef<ScrollBoxRenderable | null>(null);

  // Keyboard handler. In the "done" phase it also handles tab switching
  // (Tab/Shift+Tab/1/2/3) and quit (q/Esc) — resolving the quit promise via
  // onQuit so cli.ts can shut down cleanly (nothing dumped to scrollback).
  // Scrolling (arrows / j-k / PgUp-PgDn / g-G) drives the single scrollbox on
  // ALL THREE tabs (its children swap by activeTab; the ref stays stable).
  useKeyboard((key) => {
    // Quit + tab switching only matter once the interactive phase is up.
    if (isDone) {
      if (key.name === "q" || key.name === "escape") {
        onQuit?.();
        return;
      }
      if (key.name === "tab") {
        // Tab cycles forward through the three tabs; Shift+Tab cycles back.
        const order: ProbeTab[] = ["summary", "leaderboard", "details"];
        const cur = order.indexOf(store.getState().activeTab);
        const next = key.shift ? (cur - 1 + order.length) % order.length : (cur + 1) % order.length;
        store.setActiveTab(order[next]);
        return;
      }
      if (key.name === "1") {
        store.setActiveTab("summary");
        return;
      }
      if (key.name === "2") {
        store.setActiveTab("leaderboard");
        return;
      }
      if (key.name === "3") {
        store.setActiveTab("details");
        return;
      }
    }

    const sb = listScrollRef.current;
    if (!sb) return;
    const page = Math.max(1, sb.viewport.height - 1);
    switch (key.name) {
      case "up":
      case "k":
        sb.scrollBy(-1);
        break;
      case "down":
      case "j":
        sb.scrollBy(1);
        break;
      case "pageup":
        sb.scrollBy(-page);
        break;
      case "pagedown":
      case "space":
        sb.scrollBy(page);
        break;
      case "home":
        sb.scrollTo(0);
        break;
      case "end":
        sb.scrollTo(sb.content.height);
        break;
      case "g":
        // OpenTUI delivers letter keys with a lowercase `name` and shift tracked
        // separately, so an uppercase `case "G"` is unreachable. Branch on shift:
        // Shift+G → bottom (vim convention), g → top.
        sb.scrollTo(key.shift ? sb.content.height : 0);
        break;
    }
  });

  // Group links by model preserving insertion order
  const groups: Array<{ model: string; links: ProbeLinkState[] }> = [];
  for (const link of state.links) {
    let group = groups.find((g) => g.model === link.model);
    if (!group) {
      group = { model: link.model, links: [] };
      groups.push(group);
    }
    group.links.push(link);
  }

  // Shared max name length so bars align across all groups
  const maxNameLen = Math.min(25, Math.max(...state.links.map((l) => l.displayName.length), 12));

  // Per-width layout tier (which bars/columns survive) + the matching row width
  // so the model header bar spans exactly the active row.
  const layout = deriveLayout(termWidth || 100);
  const rowWidth = computeRowWidth(layout, maxNameLen);

  // Run-level shared scales (derived in-component each render — no store change).
  //   maxTotalMs   = slowest live link's totalMs → that link's timeline bar = full B.
  //   maxTokPerSec = fastest live generator → that link's tok/s bar = full T.
  // The tok/s SCALE denominator floors streaming time to ≥50ms so one artifact
  // link can't crush the scale; the per-row bar still uses the raw tokensPerSec.
  let maxTotalMs = 1;
  let maxTokPerSec = 1;
  let fastestLinkId: string | null = null;
  let fastestTokPerSec = Number.NEGATIVE_INFINITY;
  for (const link of state.links) {
    if (link.status !== "live" || !link.timing) continue;
    const t = link.timing;
    if (t.totalMs > maxTotalMs) maxTotalMs = t.totalMs;
    const streamMs = Math.max(STREAM_MS_FLOOR, t.totalMs - t.ttftMs);
    const scaledTps = t.tokens > 0 ? (t.tokens / streamMs) * 1000 : 0;
    if (scaledTps > maxTokPerSec) maxTokPerSec = scaledTps;
    if (t.tokensPerSec > fastestTokPerSec) {
      fastestTokPerSec = t.tokensPerSec;
      fastestLinkId = link.id;
    }
  }
  // No live generator produced tokens → no fastest crown.
  if (fastestTokPerSec <= 0) fastestLinkId = null;

  // Three-way tab selector (DONE phase). The legend + the grouped Summary rows
  // belong to the "summary" tab; the new Leaderboard + Details tabs render their
  // own headers inside the scrollbox. While LIVE we always show the grouped rows
  // (+ legend) regardless of activeTab.
  const showDetails = isDone && state.activeTab === "details";
  const showLeaderboard = isDone && state.activeTab === "leaderboard";
  const showSummary = !showDetails && !showLeaderboard; // includes the LIVE phase

  // Viewport height for the scrollable list = terminal rows minus the fixed
  // chrome. In the LIVE phase that's banner + steps block + top legend + scroll
  // hint. In the DONE phase the steps block is gone and a tab-bar row takes its
  // place; the legend only shows on the Summary tab. Floored so a short
  // terminal can't produce a zero height.
  // No pipeline-step indicator any more — the live probing rows are the feedback.
  const stepsRows = 0;
  const tabBarRows = isDone ? TAB_BAR_ROWS : 0;
  const legendRows = showSummary ? LEGEND_ROWS : 0;
  const listH = Math.max(
    MIN_LIST_H,
    termHeight - BANNER_ROWS - stepsRows - tabBarRows - legendRows - SCROLL_HINT_ROWS
  );

  // Does the scrollbox content overflow its viewport? Only then are the scroll
  // keys meaningful — hide them otherwise so the hint doesn't advertise a
  // no-op. The ref's content/viewport heights are populated after the first
  // layout pass; store-/anim-driven re-renders settle this within a frame.
  // Default to true on the first render (null ref) — better to briefly show a
  // hint than to hide a needed one.
  const sbForHint = listScrollRef.current;
  const overflow = sbForHint ? sbForHint.content.height > sbForHint.viewport.height : true;

  // Bottom hint. Scroll keys appear ONLY when content overflows. Tab-switch +
  // quit appear in the done phase regardless (they always apply).
  const scrollKeys = "↑↓ scroll · PgUp/PgDn page · g/G top/bottom";
  const footerHint = isDone
    ? `  ${overflow ? `${scrollKeys} · ` : ""}Tab/1/2/3 switch · q quit`
    : `  ${overflow ? scrollKeys : ""}`;

  return (
    // `key={state.phase}` forces React to discard the old subtree at the
    // live→done flip and mount a fresh one. Without it, OpenTUI's in-place
    // reconciliation tore the panel in inline mode when the chrome below the
    // banner changed shape (steps block → tab bar) — the documented #1 risk of
    // this stay-in-TUI redesign. A clean remount sidesteps the reconciliation
    // path. The banner is wrapped in its own fixed-height box so its last
    // (subtitle) row is always reserved regardless of the sibling below it.
    <box key={state.phase} flexDirection="column">
      <box flexDirection="column" height={BANNER_ROWS}>
        <Banner />
      </box>

      {/* DONE phase: interactive tab bar. LIVE phase shows NO pipeline-step
          indicator — the probing model rows below ARE the feedback. */}
      {isDone ? <TabBar activeTab={state.activeTab} /> : null}

      {/* Results alone are enough: a run whose models are all native or all
          unroutable probes nothing, and its Details tab must still render. */}
      {groups.length > 0 || state.results.length > 0 ? (
        <>
          {/* The Summary tab keeps the run legend; the Leaderboard + Details
              tabs have their own header text inside the scrollbox. Wrapped in a
              FIXED-HEIGHT box so its cell footprint is stable frame-to-frame —
              an unconstrained column here lets OpenTUI's inline diff bleed the
              scrollbox's first frame up into the legend's last line (the banner
              had the same bug, fixed the same way). */}
          {showSummary && (
            <box flexDirection="column" height={LEGEND_ROWS}>
              <Legend rowWidth={rowWidth} />
            </box>
          )}
          {/* Single native OpenTUI scrollbox — its children swap by activeTab so
              ALL THREE tabs scroll (wheel + keys) through one stable ref. The
              view scrolls WITHIN a fixed viewport so a long run never pushes the
              banner off-screen. */}
          <scrollbox
            ref={listScrollRef}
            scrollX={false}
            scrollY={true}
            focused={true}
            style={{ height: listH }}
          >
            {showDetails ? (
              <DetailsView
                results={state.results}
                layout={layout}
                termWidth={termWidth}
                maxTotalMs={maxTotalMs}
                maxTokPerSec={maxTokPerSec}
              />
            ) : showLeaderboard ? (
              <LeaderboardView
                results={state.results}
                layout={layout}
                maxTotalMs={maxTotalMs}
                maxTokPerSec={maxTokPerSec}
              />
            ) : (
              groups.map((g, idx) => (
                <ModelGroup
                  key={g.model}
                  model={g.model}
                  links={g.links}
                  animFrame={animFrame}
                  maxNameLen={maxNameLen}
                  rowWidth={rowWidth}
                  isLast={idx === groups.length - 1}
                  layout={layout}
                  maxTotalMs={maxTotalMs}
                  maxTokPerSec={maxTokPerSec}
                  fastestLinkId={fastestLinkId}
                />
              ))
            )}
          </scrollbox>
          <text>
            <span fg={C.dim}>{footerHint}</span>
          </text>
        </>
      ) : null}
    </box>
  );
}
