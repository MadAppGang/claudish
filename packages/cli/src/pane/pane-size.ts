/**
 * A pane's terminal size: the launch default, the bounds a resize is clamped to, and the
 * quiet window after a resize.
 *
 * The size belongs to the viewer: a pane is born `DEFAULT_PANE_COLS × DEFAULT_PANE_ROWS`
 * (`COLUMNS`/`LINES` in magmux's environment) and `resize_session` / `team(mode:"resize")`
 * may change it at any time. magmux refuses a size outside its own limits (< 20 × 3, a side
 * over 10 000, over 4 M cells); claudish CLAMPS instead and reports the size it set.
 *
 * The upper bounds are magmux's, nothing tighter. No claudish decision depends on the width
 * any more: readiness, prompt acceptance and dialogs come from magmux's input gate, and the
 * input box is located by the cursor row, not by a rule `cols − 1` long. Two magmux limits
 * meet here (mux/size.go at v0.17.0):
 * - a side: the `resize` op refuses a side over 10 000, but the launch size parsed from
 *   `COLUMNS`/`LINES` is EXCLUSIVE of 10 000. A size requested while the pane is starting is
 *   applied through those variables, so 9 999 is the largest side valid on both paths.
 * - the product: `maxScreenCells` = 4 000 000. When `cols × rows` exceeds it, `rows` drops to
 *   `floor(4 000 000 / cols)`, so a clamped size never earns magmux's `too_large`.
 *
 * The floor is claudish's (MTL-140). At 40 columns, real Claude Code 2.1.304 screens
 * (`size-40x24-*`) still give magmux's gate `dialog:permission` and `dialog:question`, a
 * ready empty box and a located box; the classifier matches every marker against the
 * dialog region flattened into one string, so a marker wrapped across rows still names its
 * dialog. 24 rows still hold the tallest captured dialog (Bash permission, rows 6–23).
 * A smaller screen would turn a dialog into "no input box, no dialog": an honest unknown
 * that never settles.
 */

export const DEFAULT_PANE_COLS = 160;
export const DEFAULT_PANE_ROWS = 50;

export const MIN_PANE_COLS = 40;
export const MAX_PANE_COLS = 9_999;
export const MIN_PANE_ROWS = 24;
export const MAX_PANE_ROWS = 9_999;
/** magmux's `maxScreenCells`: the most cells one pane screen may hold. */
export const MAX_PANE_CELLS = 4_000_000;

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

/**
 * The size claudish sets for a requested one: each side clamped into its bounds, then `rows`
 * lowered until the screen fits `MAX_PANE_CELLS`. At the widest side (9 999) that still leaves
 * 400 rows, far above the 24-row floor.
 */
export function clampPaneSize(cols: number, rows: number): PaneSize {
  const c = clamp(cols, MIN_PANE_COLS, MAX_PANE_COLS);
  const r = clamp(rows, MIN_PANE_ROWS, MAX_PANE_ROWS);
  return { cols: c, rows: Math.min(r, Math.floor(MAX_PANE_CELLS / c)) };
}

export function samePaneSize(a: PaneSize | null, b: PaneSize | null): boolean {
  return !!a && !!b && a.cols === b.cols && a.rows === b.rows;
}
