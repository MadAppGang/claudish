/**
 * Process-wide pane safety (architecture §2.11, D15): pane records, verified group
 * snapshots, the cross-owner pane limit, the shutdown hooks and the startup sweep.
 *
 * Three layers keep NFR1 ("nothing outlives its owner") even when the owner is
 * SIGKILLed with no restart:
 *
 *   1. the pane watcher (pane-launch.ts): kernel-delivered pipe EOF, then verify and kill;
 *   2. the startup sweep below, from the 0600 records, for the rare case the watcher
 *      itself was killed;
 *   3. the shutdown hooks below (signals, stdin EOF), a parallel ≤ 3 s reap.
 *
 * Every signal to a process that is not this process's own unreaped child is preceded
 * by an identity check from `process-identity.ts`. A process table that does not list
 * this process (`processTableTrusted`) decides nothing: the sweep keeps the pane.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { claimSignalExit } from "../signal-owner.js";
import { MagmuxClient } from "./magmux-client.js";
import { ensureSockRoot, sockRootFor } from "./pane-launch.js";
import {
  type GroupSnapshot,
  type PaneIdentity,
  type ProcessTable,
  type PsRow,
  findPaneMagmux,
  formatGroupFile,
  groupCheck,
  isLaunchDirPath,
  isPaneMagmux,
  isPaneMagmuxCommand,
  isPaneRecordPath,
  isPaneSockPath,
  isPaneWatcherCommand,
  isValidPaneId,
  liveEscaped,
  mergeSnapshots,
  parseGroupFile,
  pidMayBeAlive,
  readProcessTable,
  readProcessTableAsync,
  recordPathOf,
  sameSnapshot,
  sockPathOf,
  startedAt,
  verifiedGroupSnapshot,
} from "./process-identity.js";

export const MAX_LIVE_PANES = 48;

/** `<SOCK_ROOT>/panes/<paneId>.json`, mode 0600. */
export interface PaneRecord {
  paneId: string;
  ownerPid: number;
  /** the owner's `lstart`, whitespace collapsed */
  ownerStart: string;
  watcherPid: number | null;
  magmuxPid: number | null;
  panePid: number | null;
  sessionUuid: string;
  sockPath: string;
  /** the control directory (pane-launch.sh, sh-shim, magmux.pid, group) */
  launcherDir: string;
  /** the turn directory (`--add-dir`, turn files only) */
  turnDir: string;
  createdAt: string;
  reapFailed?: boolean;
}

export class PaneLimitError extends Error {
  readonly code = "pane_limit";
}

/* ───────────────────────────── owner identity ───────────────────────────── */

let ownStart: string | null = null;

/** This process's `lstart` (one `ps` call, cached only when it found this process). */
export function ownerStartOfSelf(): string {
  if (ownStart) return ownStart;
  const row = readProcessTable()?.find((r) => r.pid === process.pid);
  if (row) ownStart = row.lstart;
  return row?.lstart ?? "";
}

/** Who owns a pane: the record's fields, or the pid a recordless socket's pane id embeds. */
export type PaneOwner = Pick<PaneRecord, "paneId" | "ownerPid" | "ownerStart">;

/**
 * THE owner-liveness check, for the pane limit, the record sweep and the recordless-socket
 * sweep: the owner's pid is alive and is the same process. A recorded `ownerStart` must
 * equal the row's `lstart`. Without one (written while the owner could not read the
 * table, or a recordless socket) the start time the pane id embeds must match the row's
 * timezone-free `startMs`; an id that embeds none is not ours to judge and counts alive.
 * With the table unavailable only `kill(pid, 0)` can answer (`pidMayBeAlive`): ESRCH is
 * dead, anything else alive.
 */
export function ownerAlive(owner: PaneOwner, table: ProcessTable): boolean {
  if (!table) return pidMayBeAlive(owner.ownerPid);
  const row = table.find((r) => r.pid === owner.ownerPid);
  if (!row) return false;
  if (owner.ownerStart) return row.lstart === owner.ownerStart;
  const minted = ownerOfPaneId(owner.paneId);
  return !minted || startedAt(row, minted.startMs);
}

/* ───────────────────────────── records ───────────────────────────── */

function recordsDir(root: string): string {
  return join(root, "panes");
}

export function writeRecord(root: string, rec: PaneRecord): void {
  const p = recordPathOf(root, rec.paneId);
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
  renameSync(tmp, p);
}

export function readRecord(root: string, paneId: string): PaneRecord | null {
  if (!isValidPaneId(paneId)) return null;
  try {
    return validRecord(JSON.parse(readFileSync(recordPathOf(root, paneId), "utf8")), paneId);
  } catch {
    return null;
  }
}

export function updateRecord(root: string, paneId: string, patch: Partial<PaneRecord>): void {
  const rec = readRecord(root, paneId);
  if (rec) writeRecord(root, { ...rec, ...patch });
}

export function deleteRecord(root: string, paneId: string): void {
  try {
    unlinkSync(recordPathOf(root, paneId));
  } catch {
    // already gone
  }
}

/** A record is trusted only when its pane id is a valid id AND the file it was read from (R3-M2). */
function validRecord(v: unknown, stem: string): PaneRecord | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.paneId !== "string" || typeof r.ownerPid !== "number") return null;
  if (!isValidPaneId(r.paneId) || r.paneId !== stem) return null;
  if (typeof r.sockPath !== "string" || typeof r.launcherDir !== "string") return null;
  return {
    paneId: r.paneId,
    ownerPid: r.ownerPid,
    ownerStart: typeof r.ownerStart === "string" ? r.ownerStart : "",
    watcherPid: typeof r.watcherPid === "number" ? r.watcherPid : null,
    magmuxPid: typeof r.magmuxPid === "number" ? r.magmuxPid : null,
    panePid: typeof r.panePid === "number" ? r.panePid : null,
    sessionUuid: typeof r.sessionUuid === "string" ? r.sessionUuid : "",
    sockPath: r.sockPath,
    launcherDir: r.launcherDir,
    turnDir: typeof r.turnDir === "string" ? r.turnDir : "",
    createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
    reapFailed: r.reapFailed === true,
  };
}

export function readRecords(root: string): PaneRecord[] {
  let names: string[];
  try {
    names = readdirSync(recordsDir(root)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: PaneRecord[] = [];
  for (const n of names) {
    const rec = readRecord(root, n.slice(0, -".json".length));
    if (rec) out.push(rec);
  }
  return out;
}

/* ───────────────────────────── verified group files ───────────────────────────── */

export function readGroupFile(ctlDir: string): GroupSnapshot | null {
  try {
    return parseGroupFile(readFileSync(join(ctlDir, "group"), "utf8"));
  } catch {
    return null;
  }
}

export function writeGroupFile(ctlDir: string, snap: GroupSnapshot): void {
  const p = join(ctlDir, "group");
  const tmp = `${p}.tmp`;
  try {
    writeFileSync(tmp, formatGroupFile(snap), { mode: 0o600 });
    renameSync(tmp, p);
  } catch {
    // the dir is gone: the pane is being cleaned
  }
}

/** Remove a pane's files, each path validated first (R3-M2). */
export function removePaneFiles(
  root: string,
  f: { paneId: string; sockPath: string; launcherDir: string; turnDir: string }
): void {
  if (isPaneSockPath(root, f.sockPath, f.paneId)) rmSync(f.sockPath, { force: true });
  for (const d of [f.launcherDir, f.turnDir])
    if (d && isLaunchDirPath(root, d)) rmSync(d, { recursive: true, force: true });
  const rec = recordPathOf(root, f.paneId);
  if (isPaneRecordPath(root, rec, f.paneId)) deleteRecord(root, f.paneId);
}

/* ───────────────────────────── live panes of this process ───────────────────────────── */

/** What the registry needs from a live pane (implemented by `PaneSession`). */
export interface RegisteredPane {
  readonly paneId: string;
  readonly root: string;
  readonly identity: PaneIdentity;
  panePid(): number | null;
  /** the verified group snapshot; the registry merges fresh ones in */
  group: GroupSnapshot | null;
  /** parallel shutdown reap, bounded at ≈ 3 s */
  shutdownReap(reason: string): Promise<void>;
  /** re-run reap steps 4–6 after an unverified reap; true when they succeeded */
  retryReap(): Promise<boolean>;
  /** SIGKILL the magmux handle (sync; safe by construction) */
  killMagmuxSync(): void;
  reapFailed: boolean;
}

const live = new Map<string, RegisteredPane>();
let reserved = 0;
let ticker: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export function registerPane(p: RegisteredPane): void {
  live.set(p.paneId, p);
  startTicker();
}

export function unregisterPane(paneId: string): void {
  live.delete(paneId);
  if (live.size === 0 && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

export function registeredPanes(): RegisteredPane[] {
  return [...live.values()];
}

function startTicker(): void {
  if (ticker) return;
  ticker = setInterval(() => void tick(), 2000);
  ticker.unref?.();
}

/** Refresh every live pane's group snapshot with ONE ps call. */
export function refreshGroups(table: PsRow[]): void {
  for (const p of live.values()) refreshGroupOf(p, table);
}

export function refreshGroupOf(p: RegisteredPane, table: PsRow[]): void {
  const pid = p.panePid();
  if (!pid) return;
  const fresh = verifiedGroupSnapshot(table, pid, p.identity);
  const merged = mergeSnapshots(p.group, fresh, table);
  if (!merged || sameSnapshot(merged, p.group)) return;
  p.group = merged;
  writeGroupFile(p.identity.ctlDir, merged);
}

async function tick(): Promise<void> {
  if (ticking || live.size === 0) return;
  ticking = true;
  try {
    const table = await readProcessTableAsync();
    if (table) refreshGroups(table);
    for (const p of live.values()) if (p.reapFailed) await p.retryReap();
  } finally {
    ticking = false;
  }
}

/* ───────────────────────────── the pane limit ───────────────────────────── */

/** Records with a live owner whose reap has not finished, across every owner, plus our reservations. */
export function livePaneCount(root: string = sockRootFor()): number {
  const table = readProcessTable();
  const counted = readRecords(root).filter((r) => !r.reapFailed && ownerAlive(r, table)).length;
  return counted + reserved;
}

export function reservePanes(n: number, root: string = sockRootFor()): void {
  const liveNow = livePaneCount(root);
  if (liveNow + n > MAX_LIVE_PANES)
    throw new PaneLimitError(
      `pane_limit: ${liveNow} live panes for this user, ${n} more would exceed ${MAX_LIVE_PANES}`
    );
  reserved += n;
}

/**
 * Consume one reservation (synchronously; the caller writes its record before its next
 * await, so the pane is never uncounted). False when none is held.
 */
export function takePaneReservation(): boolean {
  if (reserved <= 0) return false;
  reserved--;
  return true;
}

/** Give back reservations a caller will not use. */
export function releasePaneReservations(n: number): void {
  reserved = Math.max(0, reserved - n);
}

/** @internal tests */
export function reservedPaneCount(): number {
  return reserved;
}

/* ───────────────────────────── shutdown ───────────────────────────── */

export async function reapAllPanes(reason: "shutdown" | "stdin_closed" | "signal"): Promise<void> {
  await Promise.allSettled([...live.values()].map((p) => p.shutdownReap(reason)));
}

export interface ShutdownHookOptions {
  /** exit with 128 + n after a signal reap (CLI default true) */
  exitAfter?: boolean;
  /** runs before the reap (the MCP server settles its records here) */
  before?: () => Promise<void>;
  /** MCP server: stdin EOF/close also shuts down, then exits 0 */
  stdin?: boolean;
}

let hookOpts: ShutdownHookOptions = { exitAfter: true };
let hooksInstalled = false;
let stdinHooked = false;
let shuttingDown = false;

const SIGNALS: Array<[NodeJS.Signals, number]> = [
  ["SIGINT", 2],
  ["SIGTERM", 15],
  ["SIGHUP", 1],
];

async function shutdown(reason: "stdin_closed" | "signal", code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await hookOpts.before?.();
  } catch {
    // a failing record writer must not keep panes alive
  }
  // The reap's last waits (the pane watcher, waitForExit's timer) are unref'd. Once
  // the cancel lets the run's main flow return, they are all that is left, and Bun
  // exits 0 before process.exit(code) below. This interval holds the loop open for
  // the reap only: every wait in it is bounded, and `before` is not.
  const hold = setInterval(() => {}, 1_000);
  try {
    await reapAllPanes(reason);
  } finally {
    clearInterval(hold);
  }
  if (reason === "stdin_closed" || hookOpts.exitAfter !== false) process.exit(code);
  shuttingDown = false;
}

/**
 * Install the signal hooks (idempotent). A call WITH options replaces the options a
 * previous call stored; `startPaneSession` calls it without options only when nothing
 * is installed yet, so an MCP server's own `before` is never overwritten.
 */
export function installPaneShutdownHooks(opts?: ShutdownHookOptions): void {
  if (opts) hookOpts = { exitAfter: true, ...opts };
  if (!hooksInstalled) {
    hooksInstalled = true;
    // stats-buffer's module-load listeners must not exit before our records are settled
    claimSignalExit();
    for (const [sig, n] of SIGNALS) process.on(sig, () => void shutdown("signal", 128 + n));
    // A synchronous exit can only SIGKILL magmux handles; groups and files are the watchers' job.
    process.on("exit", () => {
      for (const p of live.values()) p.killMagmuxSync();
    });
  }
  if (hookOpts.stdin && !stdinHooked) {
    stdinHooked = true;
    process.stdin.on("end", () => void shutdown("stdin_closed", 0));
    process.stdin.on("close", () => void shutdown("stdin_closed", 0));
  }
}

export function paneShutdownHooksInstalled(): boolean {
  return hooksInstalled;
}

/* ───────────────────────────── the startup sweep ───────────────────────────── */

export interface SweepResult {
  reaped: string[];
  cleaned: string[];
  kept: string[];
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // gone
  }
}

interface SweepTargets {
  mag: number | null;
  group: GroupSnapshot | null;
  unverified: boolean;
}

/** The record's magmux, verified by argv; `unverified` when a recorded pid is someone else's. */
function sweepMagmux(rec: PaneRecord, table: PsRow[]): { mag: number | null; unverified: boolean } {
  if (rec.magmuxPid && isPaneMagmux(rec.magmuxPid, rec.paneId, table))
    return { mag: rec.magmuxPid, unverified: false };
  const unverified = !!rec.magmuxPid && table.some((r) => r.pid === rec.magmuxPid);
  return { mag: findPaneMagmux(rec.paneId, table)[0]?.pid ?? null, unverified };
}

/** The recorded group plus a fresh identity snapshot; else the verified magmux's own child group. */
function sweepGroup(
  rec: PaneRecord,
  root: string,
  table: PsRow[],
  mag: number | null
): GroupSnapshot | null {
  const identity: PaneIdentity = {
    paneId: rec.paneId,
    sessionUuid: rec.sessionUuid,
    ctlDir: rec.launcherDir,
  };
  const recorded = isLaunchDirPath(root, rec.launcherDir) ? readGroupFile(rec.launcherDir) : null;
  const pgid = recorded?.pgid ?? rec.panePid ?? null;
  const group = mergeSnapshots(
    recorded,
    pgid ? verifiedGroupSnapshot(table, pgid, identity) : null,
    table
  );
  if (group || !mag) return group;
  const lead = table.find((r) => r.ppid === mag && r.pgid === r.pid);
  return lead ? { pgid: lead.pgid, members: [{ pid: lead.pid, lstart: lead.lstart }] } : null;
}

function sweepTargets(rec: PaneRecord, root: string, table: PsRow[]): SweepTargets {
  const m = sweepMagmux(rec, table);
  const group = sweepGroup(rec, root, table, m.mag);
  const groupImpostor =
    !!group && !groupCheck(table, group) && table.some((r) => r.pgid === group.pgid);
  return { mag: m.mag, group, unverified: m.unverified || groupImpostor };
}

async function killVerified(rec: PaneRecord, root: string): Promise<SweepTargets> {
  // an unavailable table verifies nothing, so nothing below is signalled
  const t = sweepTargets(rec, root, readProcessTable() ?? []);
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    const table = readProcessTable() ?? [];
    if (t.group && groupCheck(table, t.group)) signal(-t.group.pgid, sig);
    for (const pid of liveEscaped(table, t.group)) signal(pid, sig);
    if (t.mag && isPaneMagmux(t.mag, rec.paneId, table)) signal(t.mag, sig);
    await Bun.sleep(sig === "SIGTERM" ? 2000 : 300);
  }
  return t;
}

async function sweepRecord(rec: PaneRecord, root: string, out: SweepResult): Promise<void> {
  const table = readProcessTable();
  if (ownerAlive(rec, table)) return;
  if (!table) {
    await sweepUnidentifiable(rec, root, out);
    return;
  }
  const watcher = rec.watcherPid ? table.find((r) => r.pid === rec.watcherPid) : undefined;
  if (watcher && isPaneWatcherCommand(watcher.command, rec.paneId)) {
    out.kept.push(rec.paneId); // the watcher is mid-job
    return;
  }
  const t0 = sweepTargets(rec, root, table);
  const anyVerified = (t0.group && groupCheck(table, t0.group)) || t0.mag !== null;
  if (anyVerified) await killVerified(rec, root);
  const after = readProcessTable();
  const stillAlive =
    !after ||
    (t0.group && groupCheck(after, t0.group)) ||
    liveEscaped(after, t0.group).length > 0 ||
    (t0.mag !== null && isPaneMagmux(t0.mag, rec.paneId, after));
  if (stillAlive) {
    out.kept.push(rec.paneId);
    return;
  }
  removePaneFiles(root, rec);
  if (anyVerified) out.reaped.push(rec.paneId);
  else if (t0.unverified) out.kept.push(rec.paneId);
  else out.cleaned.push(rec.paneId);
}

/**
 * What one connection attempt says about a pane socket:
 *   - `answers`: the connect succeeded; some magmux serves it (the caller owns `client`);
 *   - `stale`: ENOENT, or ECONNREFUSED while the caller has proved the pane's magmux dead;
 *   - `inconclusive`: any other error (EPERM, EACCES, EMFILE, ENFILE, ...), ECONNREFUSED
 *     while that magmux may live, or no answer within `SOCKET_PROBE_TIMEOUT_MS`; says
 *     nothing about the listener, so files stay.
 *
 * ECONNREFUSED alone is not proof: on darwin a LIVE listener whose accept queue is full
 * answers it (measured, magmux `sockdir.go` ReapStale), which is why magmux reaps by pid.
 * So the caller passes `magmuxMayLive`, its own pid evidence for the pane's magmux.
 */
export type SocketProbe =
  | { state: "answers"; client: MagmuxClient }
  | { state: "stale"; code: string }
  | { state: "inconclusive"; code: string };

const SOCKET_PROBE_TIMEOUT_MS = 2000;

let dialSocket: (sockPath: string) => Promise<MagmuxClient> = (p) => MagmuxClient.dial(p);

/** @internal tests: replace how the sweep dials a pane socket; returns the previous dial. */
export function setSocketDialForTest(
  next: (sockPath: string) => Promise<MagmuxClient>
): (sockPath: string) => Promise<MagmuxClient> {
  const prev = dialSocket;
  dialSocket = next;
  return prev;
}

/** THE pane-socket probe, for the record sweep and the recordless-socket sweep. */
export async function probeSocket(sockPath: string, magmuxMayLive: boolean): Promise<SocketProbe> {
  const dial = dialSocket(sockPath);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), SOCKET_PROBE_TIMEOUT_MS);
  });
  try {
    const won = await Promise.race([dial, timeout]);
    if (won !== "timeout") return { state: "answers", client: won };
    void dial.then(
      (c) => c.close(),
      () => undefined
    );
    return { state: "inconclusive", code: "ETIMEDOUT" };
  } catch (e) {
    const code = (e as { errno?: string | null; code?: string }).errno ?? "unknown";
    const stale = code === "ENOENT" || (code === "ECONNREFUSED" && !magmuxMayLive);
    return stale ? { state: "stale", code } : { state: "inconclusive", code };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A dead owner's record (kill(pid, 0) answered ESRCH) while the table is unavailable.
 * No process can be identified, so nothing is signalled. A watcher pid that may be alive
 * may be mid-job, and a socket that answers (a live magmux) or whose probe is
 * inconclusive may still be served: each keeps the files, and the pane is left running
 * for a sweep that can read the table. Only a stale socket (`probeSocket`, with the
 * recorded magmux pid as its evidence) means the pane's magmux is gone; then its files are removed, as the dead-owner path does when
 * nothing is verified alive.
 */
async function sweepUnidentifiable(rec: PaneRecord, root: string, out: SweepResult) {
  if (rec.watcherPid && pidMayBeAlive(rec.watcherPid)) {
    out.kept.push(rec.paneId);
    return;
  }
  // no recorded pid: the owner died before it recorded magmux, which may still be starting
  const magmuxMayLive = rec.magmuxPid === null || pidMayBeAlive(rec.magmuxPid);
  const probe = await probeSocket(sockPathOf(root, rec.paneId), magmuxMayLive);
  if (probe.state !== "stale") {
    if (probe.state === "answers") probe.client.close();
    out.kept.push(rec.paneId);
    return;
  }
  removePaneFiles(root, rec);
  out.cleaned.push(rec.paneId);
}

/** `c<pid>-<start36>-…`: the owner pid and start (ms) a pane id embeds. */
export function ownerOfPaneId(id: string): { pid: number; startMs: number } | null {
  const m = id.match(/^c(\d+)-([0-9a-z]+)-/);
  if (!m) return null;
  return { pid: Number(m[1]), startMs: Number.parseInt(m[2] ?? "", 36) };
}

/** The owner a recordless socket's pane id names; null when the id embeds none. */
function ownerOfSocketId(id: string): PaneOwner | null {
  const o = ownerOfPaneId(id);
  return o ? { paneId: id, ownerPid: o.pid, ownerStart: "" } : null;
}

async function sweepRecordlessSocket(root: string, name: string, out: SweepResult): Promise<void> {
  const id = name.slice("magmux-".length, -".sock".length);
  const table = readProcessTable();
  const owner = ownerOfSocketId(id);
  if (!owner || ownerAlive(owner, table)) return; // no owner in the id: not ours to judge
  const sockPath = join(root, name);
  // the table names the pane's magmux; without it no pid is known for a recordless socket
  const magmuxMayLive = !table || table.some((r) => isPaneMagmuxCommand(r.command, id));
  const probe = await probeSocket(sockPath, magmuxMayLive);
  if (probe.state === "stale") {
    rmSync(sockPath, { force: true });
    out.cleaned.push(id);
    return;
  }
  if (probe.state === "inconclusive") {
    out.kept.push(id); // the probe says nothing about the listener
    return;
  }
  const client = probe.client;
  if (!table) {
    // a live magmux of a dead owner: without the table nothing identifies its processes
    client.close();
    out.kept.push(id);
    return;
  }
  const list = await client.request<{ panes?: Array<{ pid?: number; pane?: number }> }>({
    type: "list",
  });
  client.close();
  const mag = table.find((r) => isPaneMagmuxCommand(r.command, id));
  const panePid = list.ok ? list.result.panes?.find((p) => p.pane === 0)?.pid : undefined;
  const lead = panePid ? table.find((r) => r.pid === panePid) : undefined;
  // identity by parentage: the pane leader is the VERIFIED magmux's child and its own group leader
  if (mag && lead && lead.ppid === mag.pid && lead.pgid === lead.pid) signal(-lead.pgid, "SIGKILL");
  if (mag) signal(mag.pid, "SIGKILL");
  await Bun.sleep(300);
  rmSync(sockPath, { force: true });
  (mag ? out.reaped : out.kept).push(id);
}

const sweptRoots = new Set<string>();

/** The sweep, at most once per root per process (before the first spawn). */
export async function ensureSwept(root: string): Promise<void> {
  if (sweptRoots.has(root)) return;
  sweptRoots.add(root);
  await sweepOrphanPanes(root);
}

/** Startup sweep: dead-owner records (identity-validated) and recordless `magmux-c<pid>-*` sockets. */
export async function sweepOrphanPanes(root: string = sockRootFor()): Promise<SweepResult> {
  const out: SweepResult = { reaped: [], cleaned: [], kept: [] };
  if (!existsSync(root)) return out;
  ensureSockRoot(root);
  const records = readRecords(root);
  await Promise.all(records.map((r) => sweepRecord(r, root, out)));
  const known = new Set(readRecords(root).map((r) => r.paneId));
  let names: string[] = [];
  try {
    names = readdirSync(root).filter((n) => /^magmux-c\d+-[A-Za-z0-9_-]+\.sock$/.test(n));
  } catch {
    names = [];
  }
  for (const n of names) {
    const id = n.slice("magmux-".length, -".sock".length);
    if (!known.has(id) && !live.has(id)) await sweepRecordlessSocket(root, n, out);
  }
  return out;
}
