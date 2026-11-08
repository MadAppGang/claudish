/**
 * Scrolling a child Claude Code's transcript view (MTL-369): which bytes one
 * `scroll_session` / `team(mode:"scroll")` call sends, and where it believes the view is
 * afterwards. Pure: no I/O, no clock. `PaneSessionImpl.scroll` owns the state and the send.
 *
 * Measured on Claude Code 2.1.316 in magmux 0.18.1 with `wheelScrollAccelerationEnabled:
 * false` (the pane-child `--settings` overlay, `claude-runner.ts`):
 * - one SGR wheel event moves one row (`scroll:lineUp` / `scroll:lineDown`);
 * - the first event after a direction change moves 0, and leaving the live bottom costs
 *   one extra event, so this planner adds ONE event in both cases. `by` is therefore a
 *   target, ± 1 row; `CLAUDE_CODE_SCROLL_SPEED` in the owner's environment scales it;
 * - ctrl-End (`ESC [ 1 ; 5 F`) is `scroll:bottom`. Plain End (`ESC [ F`) edits the prompt
 *   and is never sent;
 * - none of these bytes typed into an empty or a typed-not-submitted prompt, submitted, or
 *   answered an open AskUserQuestion or permission dialog;
 * - 201 wheel-ups in one send (2010 bytes) moved exactly 200 rows, so MAX_SCROLL_ROWS is
 *   200 (about four 50-row screens).
 */

/** The most rows one call moves; `|by|` above it is clamped. Fixed by measurement M1. */
export const MAX_SCROLL_ROWS = 200;

/** SGR mouse wheel-up at column 1, row 1 (inside every pane). */
export const WHEEL_UP = "\x1b[<64;1;1M";
/** SGR mouse wheel-down at column 1, row 1. */
export const WHEEL_DOWN = "\x1b[<65;1;1M";
/** ctrl-End: Claude Code's `scroll:bottom`, back to the live bottom. */
export const CTRL_END = "\x1b[1;5F";

/** One call: a signed row count (negative = toward older content), or back to the bottom. */
export type ScrollRequest = { by: number } | { to: "end" };

export type ScrollDirection = "up" | "down";

/**
 * Where claudish BELIEVES the child's view is. `atBottom` = following the live bottom;
 * `lastDirection` = the direction of the last wheel events sent, null when none since the
 * bottom or when unknown. A wrong belief costs at most one row, never a dead wheel.
 */
export interface ScrollPosition {
  readonly atBottom: boolean;
  readonly lastDirection: ScrollDirection | null;
}

/** Following the live bottom: a fresh pane, after ctrl-End, after an accepted submit. */
export const LIVE_BOTTOM: ScrollPosition = Object.freeze({ atBottom: true, lastDirection: null });

/** After a send magmux did not confirm: the next scroll pays the extra event. */
export const UNKNOWN_POSITION: ScrollPosition = Object.freeze({
  atBottom: false,
  lastDirection: null,
});

export interface ScrollPlan {
  /** the bytes of ONE magmux send; "" = nothing to send */
  bytes: string;
  /** wheel events (or 1 for ctrl-End) in `bytes` */
  events: number;
  /** the position once the bytes are delivered */
  next: ScrollPosition;
}

export function isLiveBottom(pos: ScrollPosition): boolean {
  return pos.atBottom && pos.lastDirection === null;
}

/** `|by|` clamped to MAX_SCROLL_ROWS; 0 for a non-finite or zero value. */
export function scrollRowsOf(by: number): number {
  if (!Number.isFinite(by)) return 0;
  return Math.min(Math.abs(Math.trunc(by)), MAX_SCROLL_ROWS);
}

/**
 * The bytes for one request from `pos`.
 *
 * | Request | Position | Bytes | Next |
 * |---|---|---|---|
 * | `to:"end"` | any | CTRL_END | LIVE_BOTTOM |
 * | `by` | at bottom, or another or no last direction | event × (n+1) | `{false, dir}` |
 * | `by` | same direction, not at bottom | event × n | `{false, dir}` |
 *
 * `n = min(|by|, MAX_SCROLL_ROWS)`. A wheel-down at a believed bottom is still sent: the
 * belief can be wrong, and a silently dead wheel-down is worse than one harmless event.
 * `by: 0` (refused upstream) plans nothing.
 */
export function planScroll(pos: ScrollPosition, req: ScrollRequest): ScrollPlan {
  if ("to" in req) return { bytes: CTRL_END, events: 1, next: LIVE_BOTTOM };
  const n = scrollRowsOf(req.by);
  if (n === 0) return { bytes: "", events: 0, next: pos };
  const dir: ScrollDirection = req.by < 0 ? "up" : "down";
  const extra = pos.atBottom || pos.lastDirection !== dir ? 1 : 0;
  const events = n + extra;
  return {
    bytes: (dir === "up" ? WHEEL_UP : WHEEL_DOWN).repeat(events),
    events,
    next: { atBottom: false, lastDirection: dir },
  };
}
