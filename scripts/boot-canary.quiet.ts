/**
 * When the boot canary stops waiting for a screen. A boot is read once the screen has been
 * static for QUIET_MS, and never later than MAX_MS after the pane started.
 *
 * magmux answers `watch` with a blank keyframe at once, and the screen model counts any first
 * frame as a change. Counted from that keyframe, the quiet wait would give Claude Code about
 * QUIET_MS for its first paint, which a loaded machine misses. So the quiet clock runs only once
 * a frame has drawn a non-blank row; before that only MAX_MS ends the wait.
 */

export const MAX_MS = 25_000;
/** A boot is read once the screen has been static this long (the logo animates for ~10 s). */
export const QUIET_MS = 4_000;

/** Times are epoch ms; 0 means "not yet". */
export interface BootClock {
  /** the last frame that changed the screen */
  lastChangeAt: number;
  /** the first frame that changed the screen with any non-blank row */
  paintedAt: number;
}

export const BOOT_CLOCK_START: BootClock = { lastChangeAt: 0, paintedAt: 0 };

/** Records one frame. `changed` is whether it changed the screen model. */
export function noteFrame(
  clock: BootClock,
  frame: { changed: boolean; lines: readonly string[] },
  now: number
): BootClock {
  if (!frame.changed) return clock;
  const painted = clock.paintedAt !== 0 || frame.lines.some((l) => l.trim() !== "");
  return {
    lastChangeAt: now,
    paintedAt: clock.paintedAt !== 0 ? clock.paintedAt : painted ? now : 0,
  };
}

/** Whether the screen has been painted and then static long enough to be read. */
export function bootSettled(clock: BootClock, now: number): boolean {
  return clock.paintedAt !== 0 && now - clock.lastChangeAt >= QUIET_MS;
}

/**
 * The boot reading's label: `repl`, `booting`, `dialog:<name>`, `choice`, `exited`, or
 * `no-paint` when the pane is alive and nothing was ever drawn.
 */
export function bootLabel(
  b: { kind: "repl" | "booting" | "dialog" | "choice"; name?: string },
  exited: boolean,
  clock: BootClock
): string {
  if (exited && b.kind === "booting") return "exited";
  if (clock.paintedAt === 0 && b.kind === "booting") return "no-paint";
  return b.kind === "dialog" ? `dialog:${b.name}` : b.kind;
}
