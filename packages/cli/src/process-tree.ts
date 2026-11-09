/**
 * Killing a spawned `claudish` means killing a TREE, not a process.
 *
 * The shape, on every spawn site in this repo:
 *
 *   orchestrator / session manager
 *    └─ node bin/claudish.cjs        ← the pid we hold
 *        └─ bun dist/index.js        ← the real CLI, owns the proxy
 *            └─ claude               ← Claude Code
 *                └─ bash, MCP servers, …
 *
 * `stdio: "inherit"` passes fd 0/1/2 all the way down, so the DEEPEST process
 * holds the write end of the pipe our caller reads. Signalling only the pid we
 * hold therefore kills the launcher and orphans everything that matters: it
 * keeps running, keeps billing, and keeps writing into our pipe.
 *
 * Measured 2026-08-15 against this exact topology:
 *
 *   SIGTERM to pid    → launcher dies, child leaks 330 B AFTER the kill
 *   SIGKILL to pid    → identical — 330 B still leaks
 *   SIGTERM to GROUP  → clean, 0 B
 *
 * SIGKILL not helping is the tell: this was never a stubborn process ignoring
 * signals, it was signalling the wrong process. In a real `team` run it cost a
 * model that was declared TIMEOUT with 0 B and then wrote a complete 40,699 B
 * answer into the response file 375 s later, where the judging phase scored it
 * as an empty submission.
 *
 * bin/claudish.cjs now forwards catchable signals, which fixes the common case
 * on its own. The group kill is still required, because nothing running inside
 * the launcher can forward a SIGKILL aimed at the launcher.
 */

import type { ChildProcess } from "node:child_process";

/**
 * Whether to spawn children `detached` (own process group) and signal the group.
 *
 * Windows has no POSIX process groups and `process.kill(-pid)` is not
 * meaningful there, so it keeps the direct-pid behaviour it always had.
 */
export const KILL_PROCESS_GROUP = process.platform !== "win32";

/**
 * Send a signal to a child AND everything it spawned.
 *
 * Never throws — ESRCH just means the target is already gone, which is the
 * outcome we wanted.
 *
 * The group is only signalled when the child was spawned with
 * `detached: KILL_PROCESS_GROUP`. Sending `-pid` for a NON-detached child would
 * address our own process group, i.e. signal the orchestrator itself, so the
 * two must always be changed together.
 *
 * The pid itself is signalled whenever the child has not exited. `proc.killed`
 * is no guard: Node sets it once ANY signal was delivered, so gating on it
 * would drop the SIGKILL that follows a SIGTERM the child ignored — and for a
 * non-detached child, or on Windows, nothing else would deliver it.
 */
export function signalProcessTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (KILL_PROCESS_GROUP && proc.pid) {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      // Group already gone.
    }
  }
  try {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
  } catch {
    // Already dead.
  }
}

/** Resolves when the child has exited, or after `ms` — whichever comes first. */
export function waitForExit(proc: ChildProcess, ms: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      proc.off("exit", onExit);
      resolve(value);
    };
    const onExit = () => done(true);
    proc.once("exit", onExit);
    const t = setTimeout(() => done(false), ms);
    t.unref?.();
  });
}

/** Default pause between SIGTERM and the SIGKILL that follows it. */
export const TERMINATE_GRACE_MS = 5_000;

/**
 * Stop a child and everything it started: SIGTERM to the tree, then SIGKILL to
 * the tree if it is still alive after `graceMs`.
 *
 * Returns whether the child was observed to exit. `false` means something
 * survived SIGKILL — worth reporting rather than assuming the kill worked.
 */
export async function terminateChildTree(
  proc: ChildProcess,
  graceMs: number = TERMINATE_GRACE_MS
): Promise<boolean> {
  signalProcessTree(proc, "SIGTERM");
  if (await waitForExit(proc, graceMs)) return true;

  signalProcessTree(proc, "SIGKILL");
  return waitForExit(proc, graceMs);
}
