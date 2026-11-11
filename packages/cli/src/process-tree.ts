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
import {
  type GroupMember,
  type ProcessTable,
  type PsRow,
  liveMembers,
  readProcessTableAsync,
} from "./pane/process-identity.js";

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

/**
 * Every process below `rootPid` in `table`, nearest first. Excludes `rootPid`, init and
 * this process, and stops at a repeated pid, so a table read mid-change cannot loop.
 */
export function descendantsOf(
  table: ReadonlyArray<Pick<PsRow, "pid" | "ppid" | "lstart">>,
  rootPid: number
): GroupMember[] {
  const childrenOf = new Map<number, Pick<PsRow, "pid" | "lstart">[]>();
  for (const { pid, ppid, lstart } of table) {
    const siblings = childrenOf.get(ppid);
    if (siblings) siblings.push({ pid, lstart });
    else childrenOf.set(ppid, [{ pid, lstart }]);
  }
  const seen = new Set<number>([rootPid, process.pid]);
  const out: GroupMember[] = [];
  const queue = [rootPid];
  for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
    for (const child of childrenOf.get(parent) ?? []) {
      if (child.pid <= 1 || seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

/**
 * The process table, or null when it cannot be read within `budgetMs`. The `ps` is
 * cancelled at that point; the timer holds the bound even if the cancel has no effect.
 */
async function readTableWithin(budgetMs: number): Promise<ProcessTable> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const table = await Promise.race([
    readProcessTableAsync(budgetMs),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), budgetMs);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
  return table;
}

/**
 * The descendants of `rootPid` now, for a kill that cannot be aimed at a process group:
 * a child that is not detached shares its parent's group, and the tree has to be read
 * before the kill, because a dead parent's children reparent to init.
 *
 * Empty when the process table cannot be read within `budgetMs`, so a failed or hung
 * `ps` costs the descendants and never the kill that follows.
 */
export async function snapshotDescendants(
  rootPid: number,
  budgetMs: number
): Promise<GroupMember[]> {
  const table = await readTableWithin(budgetMs);
  return table ? descendantsOf(table, rootPid) : [];
}

/**
 * SIGKILLs the `members` that a fresh table read shows are still the same processes,
 * and returns how many. A pid can be reused once its process exits, and reparenting
 * changes neither pid nor start time, so the match survives the parent's death. With no
 * table within `budgetMs` nothing is signalled: a wrong kill is worse than a missed one.
 */
export async function killStillLiveMembers(
  members: readonly GroupMember[],
  budgetMs: number
): Promise<number> {
  if (members.length === 0) return 0;
  const table = await readTableWithin(budgetMs);
  if (!table) return 0;
  const pids = liveMembers(table, members);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, or not this user's to signal.
    }
  }
  return pids.length;
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
