/**
 * A pane's terminal size: the launch default, the bounds a resize is clamped to, and the
 * quiet window after a resize.
 *
 * The size belongs to the viewer: a pane is born `DEFAULT_PANE_COLS × DEFAULT_PANE_ROWS`
 * (`COLUMNS`/`LINES` in magmux's environment) and `resize_session` / `team(mode:"resize")`
 * may change it at any time. magmux refuses a size outside its own limits (< 20 × 3, a side
 * over 10 000, over 4 M cells); claudish CLAMPS instead and reports the size it set.
 *
 * The bounds are tighter than magmux's on purpose (plan review H1, L4): at 80 columns every
 * closed-list dialog marker the classifier matches still fits one row, and 24 rows hold a
 * whole permission or trust dialog. A smaller screen would turn a dialog into "no input box,
 * no dialog" — an honest unknown that never settles. The column cap is 250 because the
 * real classifier fixtures stop there: above it, `isBoxRule`'s cols − 1 rule is unverified.
 */

export const DEFAULT_PANE_COLS = 160;
export const DEFAULT_PANE_ROWS = 50;

export const MIN_PANE_COLS = 80;
export const MAX_PANE_COLS = 250;
export const MIN_PANE_ROWS = 24;
export const MAX_PANE_ROWS = 200;

/**
 * After a resize the child redraws everything it shows (SIGWINCH reflow). From the send
 * until this long after the reply (or the lost reply), that redraw is not evidence: degraded admission ignores a change above the box (H2), and
 * the activity timestamp behind `idle_seconds` / `last_activity_at` skips its frames (M4).
 */
export const RESIZE_QUIET_MS = 2_000;

export interface PaneSize {
  cols: number;
  rows: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

/** The size claudish sets for a requested one: each side clamped into its bounds. */
export function clampPaneSize(cols: number, rows: number): PaneSize {
  return {
    cols: clamp(cols, MIN_PANE_COLS, MAX_PANE_COLS),
    rows: clamp(rows, MIN_PANE_ROWS, MAX_PANE_ROWS),
  };
}

export function samePaneSize(a: PaneSize | null, b: PaneSize | null): boolean {
  return !!a && !!b && a.cols === b.cols && a.rows === b.rows;
}
