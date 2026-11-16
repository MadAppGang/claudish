/**
 * Whether a stderr line is new, or a repeat of one printed a moment ago.
 *
 * claudish answers a terminal upstream failure with 400 so Claude Code shows it
 * instead of retrying it. Claude Code reads a 400 as a possible request-shape
 * problem and re-sends the same turn up to five more times, each time without
 * one feature (the thinking-token beta, deferred tools). Measured with a
 * rejected DashScope key: six requests in 2.2 s, and six identical
 * `Error [Qwen-payg]: HTTP 401` lines on stderr. The upstream answers every one
 * the same way, so the user needs the line once.
 *
 * A window, not once per process: the same failure on a later turn is news and
 * prints again. The debug log keeps every occurrence; only stderr is thinned.
 */

/** Longer than the measured re-send burst (2.2 s), shorter than a user's next turn. */
export const REPEAT_WINDOW_MS = 30_000;

const lastPrinted = new Map<string, number>();

/**
 * True when `line` was not printed in the last {@link REPEAT_WINDOW_MS}, and
 * records it as printed at `now`. A suppressed repeat does not move the window.
 */
export function firstInWindow(line: string, now: number = Date.now()): boolean {
  const at = lastPrinted.get(line);
  if (at !== undefined && now - at < REPEAT_WINDOW_MS) return false;
  lastPrinted.set(line, now);
  if (lastPrinted.size > 256) {
    for (const [key, t] of lastPrinted) {
      if (now - t >= REPEAT_WINDOW_MS) lastPrinted.delete(key);
    }
  }
  return true;
}

export function _resetRepeatWindowForTest(): void {
  lastPrinted.clear();
}
