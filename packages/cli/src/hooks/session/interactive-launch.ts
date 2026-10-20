/**
 * What the interactive launcher plans before it spawns Claude Code, when session hooks
 * are loaded (hook-system architecture §2.1, §3.2, §7.5). Pure, so `claude-runner.ts`
 * and its tests ask the same functions.
 *
 * Two reasons now plan the magmux wrap, and they are kept apart on purpose:
 *
 *   1. the recovery surface (`recoverySurfaceAllowed()`), as before: the banner and,
 *      through `applyRetryWatchdog`, the client's retry watchdog;
 *   2. `sessionHooksNeedDriver`: a loaded hook declares `responseEnd` or a session
 *      event, so the `InteractiveDriver` needs a pane to read and type into.
 *
 * Reason 2 alone wraps the launch and starts the driver. It never installs the recovery
 * UI and never exports the watchdog: those stay gated on reason 1 alone, so
 * `--no-recovery` keeps its "pre-recovery behaviour, byte for byte" promise for the
 * RESPONSE even when a hook needs the pane.
 */

import type { MagmuxPaneCapability } from "../../launcher/magmux-wrapper.js";

export interface SurfacePlan {
  /** spawn Claude Code inside a visible `-w` magmux claudish launches */
  wrap: boolean;
  /** where the recovery banner installs: the wrap's socket, the ambient one, or nowhere */
  recoveryUi: "wrap" | "ambient" | null;
  /** where the interactive driver runs, or null when it does not */
  driver: "wrap" | "ambient" | null;
  /**
   * Session hooks are loaded but no pane can carry them (`no-tty`, `no-magmux`, `-p`):
   * `sessionStart` fires at spawn and `sessionEnd` at exit, and every injection is
   * dropped `unavailable` (§2.1, §4.7 rule 8). Never for a pane child, whose owner fires
   * its session events.
   */
  noSurfaceSession: boolean;
}

export function planInteractiveSurfaces(input: {
  capability: MagmuxPaneCapability;
  /** `recoverySurfaceAllowed()`: both recovery switches on */
  recoveryAllowed: boolean;
  /** a loaded hook declares `responseEnd` or a session event (`sessionHooksNeedBinding`) */
  sessionHooksNeedDriver: boolean;
}): SurfacePlan {
  const { capability, recoveryAllowed, sessionHooksNeedDriver } = input;
  const wrap = capability.kind === "wrap" && (recoveryAllowed || sessionHooksNeedDriver);
  const recoveryUi = !recoveryAllowed
    ? null
    : capability.kind === "wrap"
      ? "wrap"
      : capability.kind === "ambient"
        ? "ambient"
        : null;
  const driver = !sessionHooksNeedDriver
    ? null
    : wrap
      ? "wrap"
      : capability.kind === "ambient"
        ? "ambient"
        : null;
  const paneChild = capability.kind === "none" && capability.reason === "pane-child";
  return {
    wrap,
    recoveryUi,
    driver,
    noSurfaceSession: sessionHooksNeedDriver && driver === null && !paneChild,
  };
}

/** Flags after which Claude Code picks the session itself, so claudish mints none. */
const RESUME_FLAGS = new Set(["--resume", "-r", "--continue", "-c", "--fork-session"]);

/**
 * What the user's own arguments say about the session id: an explicit `--session-id`
 * (then the driver knows it from boot), or a resume (`--resume`/`-r`, `--continue`/`-c`,
 * `--fork-session`: Claude Code decides, and the driver learns it from the first proxy
 * request that names it). Neither → claudish mints one.
 */
export function sessionFlagsOf(args: ReadonlyArray<string>): {
  sessionId: string | null;
  resumes: boolean;
} {
  let sessionId: string | null = null;
  let resumes = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") break;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (RESUME_FLAGS.has(name)) resumes = true;
    else if (name === "--session-id") {
      const v = eq > 0 ? a.slice(eq + 1) : args[i + 1];
      if (v && !v.startsWith("-")) sessionId = v;
    }
  }
  return { sessionId: resumes ? null : sessionId, resumes };
}

/**
 * The arguments the driver adds IN FRONT of Claude Code's argv: `--session-id <minted>`
 * when one was minted, and `--add-dir <turn dir>` so the model may Read a long
 * injection's turn file without a permission prompt (S2b, measured: no prompt in default
 * mode, including for a file written after launch).
 *
 * Front, because `--add-dir` takes a VARIADIC list: placed before the user's arguments
 * it would swallow a positional prompt as a second directory. `claude-runner` puts
 * these ahead of its own `--settings <file>`, which ends the list.
 */
export function driverLeadingArgs(input: {
  mintedSessionId: string | null;
  turnDir: string;
}): string[] {
  return [
    ...(input.mintedSessionId ? ["--session-id", input.mintedSessionId] : []),
    "--add-dir",
    input.turnDir,
  ];
}
