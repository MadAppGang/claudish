/**
 * The identity-checked reap of one pane, shared by every pane class: `close_pane`, magmux
 * by its handle, the verified group backstop, verify, clean, then the watcher.
 *
 * The subject supplies what the reap reads and writes. Nothing here is signalled without a
 * check: magmux and the watcher go through this process's own `ChildProcess` handles, which
 * refuse to signal once reaped, and the group through `groupCheck` on a table read just
 * before the signal. A process table that cannot be read leaves the reap unverified, with
 * its files kept, for the registry's retry.
 */

import type { ChildProcess } from "node:child_process";
import { waitForExit } from "../process-tree.js";
import type { MagmuxClient } from "./magmux-client.js";
import {
  type PaneFiles,
  refreshGroupOf,
  removePaneFiles,
  unregisterPane,
  updateRecord,
} from "./pane-registry.js";
import {
  type GroupSnapshot,
  type PaneIdentity,
  groupCheck,
  liveEscaped,
  readProcessTableAsync,
  verifiedGroupSnapshot,
} from "./process-identity.js";

/** What the reap needs from a pane. `group` and `reapFailed` are the pane's own fields. */
export interface PaneReapSubject {
  readonly paneId: string;
  readonly root: string;
  readonly identity: PaneIdentity;
  group: GroupSnapshot | null;
  reapFailed: boolean;
  panePid(): number | null;
  /** the pane leader, found by parentage while no `list` reply had named it */
  adoptPanePid(pid: number): void;
  client(): MagmuxClient | null;
  paneClosed(): boolean;
  magmux(): ChildProcess | null;
  watcher(): ChildProcess | null;
  files(): PaneFiles;
  /** the shutdown reap's short timings; read at each wait, because a shutdown can start mid-reap */
  fast(): boolean;
  /** the group and magmux are verified gone and the files removed */
  onVerified(): void;
  /** the group or magmux may still live: the record keeps `reapFailed` */
  onUnverified(): void;
}

export function alive(p: ChildProcess | null): boolean {
  return !!p && p.exitCode === null && p.signalCode === null;
}

function ms(h: PaneReapSubject, normal: number, fast: number): number {
  return h.fast() ? fast : normal;
}

async function waitFor(pred: () => boolean, waitMs: number): Promise<void> {
  const end = Date.now() + waitMs;
  while (!pred() && Date.now() < end) await Bun.sleep(25);
}

function signalQuietly(target: number, sig: NodeJS.Signals): void {
  try {
    process.kill(target, sig);
  } catch {
    // gone between the read and the signal
  }
}

/** Step 0: refresh the verified group while its members still carry their identity. */
async function captureGroupBeforeReap(h: PaneReapSubject): Promise<void> {
  const table = await readProcessTableAsync();
  if (!table) return;
  const magmuxPid = h.magmux()?.pid;
  if (!h.panePid() && magmuxPid) {
    const lead = table.find((r) => r.ppid === magmuxPid && r.pgid === r.pid);
    if (lead) {
      const snap = verifiedGroupSnapshot(table, lead.pgid, h.identity);
      if (snap) h.adoptPanePid(lead.pid);
    }
  }
  refreshGroupOf(h, table);
}

/**
 * The verified group, or a recorded escaped descendant (own process group), is alive.
 * True while the table is unavailable: the reap stays unverified and keeps its files.
 */
async function groupAlive(h: PaneReapSubject): Promise<boolean> {
  if (!h.group) return false;
  const table = await readProcessTableAsync();
  if (!table) return true;
  return groupCheck(table, h.group) || liveEscaped(table, h.group).length > 0;
}

/** The verified group (`-pgid`) and each live escaped descendant (its pid), re-read now. */
async function backstopTargets(h: PaneReapSubject): Promise<number[]> {
  if (!h.group) return [];
  const table = await readProcessTableAsync();
  if (!table) return [];
  return [...(groupCheck(table, h.group) ? [-h.group.pgid] : []), ...liveEscaped(table, h.group)];
}

async function groupBackstop(h: PaneReapSubject): Promise<void> {
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    const targets = await backstopTargets(h);
    if (targets.length === 0) return;
    for (const target of targets) signalQuietly(target, sig);
    const end = Date.now() + (sig === "SIGTERM" ? ms(h, 2000, 500) : 1000);
    while (Date.now() < end && (await groupAlive(h))) await Bun.sleep(150);
  }
}

/** Step 6, only after a verified reap: `done`, end stdin, then SIGKILL through the handle. */
async function endWatcher(h: PaneReapSubject): Promise<void> {
  const w = h.watcher();
  if (!w || !alive(w)) return;
  try {
    w.stdin?.write("done\n");
    w.stdin?.end();
  } catch {
    // EPIPE: the watcher is already gone
  }
  await waitForExit(w, 1000);
  if (alive(w)) w.kill("SIGKILL");
}

async function verifyAndClean(h: PaneReapSubject): Promise<void> {
  const groupGone = !(await groupAlive(h));
  const magGone = !alive(h.magmux());
  h.client()?.close();
  if (groupGone && magGone) {
    removePaneFiles(h.root, h.files());
    h.reapFailed = false;
    h.onVerified();
    await endWatcher(h);
    unregisterPane(h.paneId);
    return;
  }
  h.reapFailed = true;
  h.onUnverified();
  updateRecord(h.root, h.paneId, { reapFailed: true });
}

/** `close_pane`, magmux by its handle, the verified group backstop, verify, clean, watcher. */
export async function reapPaneProcesses(h: PaneReapSubject): Promise<void> {
  await captureGroupBeforeReap(h);
  const c = h.client();
  if (c && !c.isClosed && !h.paneClosed()) {
    const r = await c.request({ type: "close_pane", pane: 0, force: true }, ms(h, 1000, 500));
    if (r.ok || r.code === "no_such_pane")
      await waitFor(() => h.paneClosed() || c.isClosed, ms(h, 3000, 1000));
  }
  const mag = h.magmux();
  if (mag) await waitForExit(mag, ms(h, 3000, 1000));
  if (alive(mag)) {
    mag?.kill("SIGTERM");
    if (mag) await waitForExit(mag, ms(h, 2000, 500));
    if (alive(mag)) mag?.kill("SIGKILL");
    if (mag) await waitForExit(mag, 1000);
  }
  await groupBackstop(h);
  await verifyAndClean(h);
}

/** Re-run the last steps (the registry's 2 s tick, after an unverified reap). */
export async function retryPaneReap(h: PaneReapSubject): Promise<boolean> {
  const mag = h.magmux();
  if (alive(mag)) mag?.kill("SIGKILL");
  await groupBackstop(h);
  await verifyAndClean(h);
  return !h.reapFailed;
}
