/**
 * The ONE definition of "this pid is that pane's magmux" and "this process group is
 * that pane's group" (architecture §2.11, D15, X-C1), used by the reap, the startup
 * sweep and — as generated shell — the pane watcher.
 *
 * Identity is never a bare pid. A pid is reused; a pane id is not (it embeds the owner
 * pid, the owner's start time and six random hex digits), and a (pid, start time) pair
 * cannot be impersonated by a new process. So:
 *
 *   - magmux: its command line contains `--id <paneId> --sock-dir`;
 *   - a pane group member: its command line contains `--session-id <uuid>` or
 *     `<ctlDir>/pane-launch.sh` (the pane leader before and after its `exec`, bun, claude);
 *   - the pane group: some process whose pgid is the recorded pgid has a (pid, start time)
 *     pair in the member set recorded while the group's identity was verified. A pgid is
 *     not reused while any member lives, so a passing check proves the group is the
 *     pane's — even when only an unidentifiable grandchild is left.
 *
 * Every process-table read is ONE
 * `LC_ALL=C ps -ax -ww -o pid=,ppid=,pgid=,etime=,lstart=,command=` (portable across macOS
 * and Linux; `ps -g` means different things on the two).
 *
 * Paths are validated before any `rm` (R3-M2): a control or turn directory is a DIRECT
 * child of the socket root named `launch-` + six `[A-Za-z0-9]`; a socket is exactly
 * `<root>/magmux-<paneId>.sock`; a record is exactly `<root>/panes/<paneId>.json`.
 */

import { execFile, execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface PsRow {
  pid: number;
  ppid: number;
  pgid: number;
  /**
   * `lstart`, whitespace collapsed: `Mon Oct 6 12:34:56 2026`. Wall-clock time in the
   * SYSTEM zone with no offset: an identity string, compared only with another `lstart`.
   */
  lstart: string;
  /**
   * Start time in epoch ms: when `ps` was spawned minus its `etime` (whole seconds), so
   * within about 1 s and independent of every timezone. Absent when the read carried no
   * `etime` column.
   */
  startMs?: number;
  command: string;
}

/** One verified member of a pane group. */
export interface GroupMember {
  pid: number;
  lstart: string;
}

export interface GroupSnapshot {
  pgid: number;
  members: GroupMember[];
  /**
   * Descendants of group members that run in a process group of their OWN. Measured
   * (code-review iteration 1, Claude Code 2.1.291): a `run_in_background` Bash shell is
   * its own group leader (pgid = its pid), so a group signal never reaches it. Each is
   * signalled by pid, only while its (pid, start time) pair still matches.
   */
  escaped?: GroupMember[];
}

/** What identifies one pane's processes. */
export interface PaneIdentity {
  paneId: string;
  sessionUuid: string;
  /** the control directory holding `pane-launch.sh` */
  ctlDir: string;
}

const PS_ARGS = ["-ax", "-ww", "-o", "pid=,ppid=,pgid=,etime=,lstart=,command="];
// `etime` is `[[dd-]hh:]mm:ss`; it is optional so a recorded table without it still parses
const PS_ROW =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(?:((?:\d+-)?(?:\d+:)?\d+:\d+)\s+)?(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s?(.*)$/;

export function collapse(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

/** `etime` (`[[dd-]hh:]mm:ss`) in seconds. */
export function etimeSeconds(etime: string): number {
  const [days, clock] = etime.includes("-") ? etime.split("-") : ["0", etime];
  const parts = (clock ?? "").split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h = 0, m = 0, s = 0] = parts;
  return Number(days) * 86_400 + h * 3600 + m * 60 + s;
}

/**
 * Parse `ps -o pid=,ppid=,pgid=[,etime=],lstart=,command=` output. Unparseable rows are
 * dropped. `spawnedAtMs` (when that `ps` was spawned) turns each `etime` into `startMs`.
 */
export function parsePsTable(text: string, spawnedAtMs?: number): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(PS_ROW);
    if (!m) continue;
    const row: PsRow = {
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      lstart: collapse(m[5] ?? ""),
      command: (m[6] ?? "").trim(),
    };
    if (m[4] && spawnedAtMs !== undefined) row.startMs = spawnedAtMs - etimeSeconds(m[4]) * 1000;
    rows.push(row);
  }
  return rows;
}

/** How far a `startMs` may sit from a start time measured in-process (`etime` is whole seconds). */
const START_TOLERANCE_MS = 2000;

/**
 * `row` started at `startMs` (epoch ms, measured by the process itself), within
 * `START_TOLERANCE_MS`. True when the row has no `startMs`: nothing to contradict it.
 */
export function startedAt(row: PsRow, startMs: number): boolean {
  return row.startMs === undefined || Math.abs(row.startMs - startMs) < START_TOLERANCE_MS;
}

/**
 * The process table, or null when it is UNAVAILABLE: `ps` could not run, failed, or
 * printed no row. A readable table is never empty (it lists the reader), so null never
 * means "no process": every caller treats what it would have looked up as possibly
 * alive — no reap, no sweep, no file removed, no owner counted dead.
 *
 * Measured: macOS refuses to exec the setuid `/bin/ps` from ANY Seatbelt sandbox, even
 * `sandbox-exec -p '(version 1)(allow default)'` (EPERM, `posix_spawn 'ps'`), so inside
 * one every read is null for the life of the process.
 */
export type ProcessTable = PsRow[] | null;

const PS_ENV = { PATH: "/bin:/usr/bin:/usr/sbin:/sbin", LC_ALL: "C" };
const PS_OPTIONS = { env: PS_ENV, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 } as const;

type PsOptions = typeof PS_OPTIONS;

/** How `ps` is spawned: node's `execFile`/`execFileSync`, narrowed to the one call made. */
export interface PsSpawn {
  execFileSync(file: string, args: string[], opts: PsOptions & { stdio: StdioPipeOut }): string;
  execFile(
    file: string,
    args: string[],
    opts: PsOptions,
    cb: (err: Error | null, stdout: string) => void
  ): unknown;
}

type StdioPipeOut = ["ignore", "pipe", "ignore"];

let psSpawn: PsSpawn = { execFile, execFileSync };

/** @internal tests: replace how `ps` is spawned; returns the previous spawn, to restore. */
export function setPsSpawnForTest(next: PsSpawn): PsSpawn {
  const prev = psSpawn;
  psSpawn = next;
  return prev;
}

/**
 * Whether rows a `ps` run printed are a real table: they list THIS process. A run that
 * failed part way (EAGAIN/EMFILE, maxBuffer) or printed something else does not, and no
 * liveness or destructive decision may be taken from it.
 */
export function processTableTrusted(rows: PsRow[]): boolean {
  return rows.some((r) => r.pid === process.pid);
}

/**
 * The table one `ps` run gives: its parsed stdout, or null when the run produced no output
 * or no trusted table (`processTableTrusted`). Both readers end here, so they agree on
 * what "unavailable" is.
 */
function tableOf(stdout: string | null, spawnedAtMs: number): ProcessTable {
  if (stdout === null) return null;
  const rows = parsePsTable(stdout, spawnedAtMs);
  return processTableTrusted(rows) ? rows : null;
}

/** The whole process table, synchronously (exit hooks, the sweep); null when unavailable. */
export function readProcessTable(): ProcessTable {
  const spawnedAt = Date.now();
  let stdout: string | null;
  try {
    stdout = psSpawn.execFileSync("ps", PS_ARGS, {
      ...PS_OPTIONS,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    stdout = null;
  }
  return tableOf(stdout, spawnedAt);
}

/**
 * The whole process table without blocking the event loop (the registry tick); null when
 * unavailable. Never rejects: Bun throws a spawn failure (EPERM in a sandbox) from
 * `execFile` itself rather than passing it to the callback, so the call is guarded too.
 */
export function readProcessTableAsync(): Promise<ProcessTable> {
  return new Promise((resolve) => {
    const spawnedAt = Date.now();
    try {
      psSpawn.execFile("ps", PS_ARGS, PS_OPTIONS, (err, stdout) =>
        resolve(tableOf(err ? null : String(stdout), spawnedAt))
      );
    } catch {
      resolve(tableOf(null, spawnedAt));
    }
  });
}

/** `lstart` of one pid; null when it is gone or the table is unavailable. */
export function lstartOf(pid: number, table?: PsRow[]): string | null {
  const rows = table ?? readProcessTable() ?? [];
  return rows.find((r) => r.pid === pid)?.lstart ?? null;
}

/* ───────────────────────────── needles ───────────────────────────── */

/** What magmux's argv carries for pane `paneId`. Shell form: `--id $1 --sock-dir`. */
export function magmuxNeedle(paneId: string): string {
  return `--id ${paneId} --sock-dir`;
}

/** What every identifiable pane member's argv carries. Shell form: `--session-id $2`. */
export function sessionNeedle(sessionUuid: string): string {
  return `--session-id ${sessionUuid}`;
}

/** The launcher the pane leader runs before its `exec`. Shell form: `$3/pane-launch.sh`. */
export function launcherNeedle(ctlDir: string): string {
  return `${ctlDir}/pane-launch.sh`;
}

export function isPaneMagmuxCommand(command: string, paneId: string): boolean {
  return command.includes(magmuxNeedle(paneId));
}

/** `pid` is, right now, verifiably pane `paneId`'s magmux (false when the table is unavailable). */
export function isPaneMagmux(pid: number, paneId: string, table?: PsRow[]): boolean {
  const rows = table ?? readProcessTable() ?? [];
  const row = rows.find((r) => r.pid === pid);
  return !!row && isPaneMagmuxCommand(row.command, paneId);
}

/** Every magmux process verifiably carrying pane `paneId` (normally zero or one). */
export function findPaneMagmux(paneId: string, table?: PsRow[]): PsRow[] {
  return (table ?? readProcessTable() ?? []).filter((r) => isPaneMagmuxCommand(r.command, paneId));
}

export function paneIdentityMatches(command: string, pane: PaneIdentity): boolean {
  return (
    command.includes(sessionNeedle(pane.sessionUuid)) ||
    command.includes(launcherNeedle(pane.ctlDir))
  );
}

/**
 * The verified snapshot of group `pgid`: every member's (pid, start time), but only when
 * at least one member still carries the pane's identity. Null otherwise.
 */
export function verifiedGroupSnapshot(
  table: PsRow[],
  pgid: number,
  pane: PaneIdentity
): GroupSnapshot | null {
  if (!Number.isInteger(pgid) || pgid <= 1) return null;
  const members = table.filter((r) => r.pgid === pgid);
  if (!members.some((r) => paneIdentityMatches(r.command, pane))) return null;
  return withEscaped(
    pgid,
    members.map((r) => ({ pid: r.pid, lstart: r.lstart })),
    escapedDescendants(table, pgid, new Set(members.map((r) => r.pid)))
  );
}

function withEscaped(pgid: number, members: GroupMember[], escaped: GroupMember[]): GroupSnapshot {
  return escaped.length ? { pgid, members, escaped } : { pgid, members };
}

/** Processes outside group `pgid` whose parent chain reaches one of its members. */
function escapedDescendants(table: PsRow[], pgid: number, inGroup: Set<number>): GroupMember[] {
  const parentOf = new Map(table.map((r) => [r.pid, r.ppid]));
  const out: GroupMember[] = [];
  for (const r of table) {
    if (r.pgid === pgid) continue;
    let p = r.ppid;
    for (let hops = 0; hops < 64 && p > 1; hops++) {
      if (inGroup.has(p)) {
        out.push({ pid: r.pid, lstart: r.lstart });
        break;
      }
      p = parentOf.get(p) ?? 0;
    }
  }
  return out;
}

/** The recorded escaped descendants still alive: same pid AND same start time. */
export function liveEscaped(table: PsRow[], snap: GroupSnapshot | null): number[] {
  if (!snap?.escaped?.length) return [];
  const keys = new Set(snap.escaped.map((m) => `${m.pid} ${collapse(m.lstart)}`));
  return table.filter((r) => keys.has(`${r.pid} ${r.lstart}`)).map((r) => r.pid);
}

/**
 * Merge a fresh VERIFIED snapshot into a recorded one. The fresh snapshot lists every
 * live member of the group, so a recorded member missing from it is dead (its (pid,
 * start) pair can never match again) or has left the group (`groupCheck` only looks at
 * the recorded pgid): the fresh one replaces the record, which therefore stays bounded
 * over a session of days. With no fresh snapshot (no member carries the identity any
 * more) the record is kept as it is: it is what still recognises an orphaned grandchild.
 *
 * Escaped descendants are the exception to "the fresh one replaces": the fresh snapshot
 * finds one only while its parent chain still reaches a member, and when `claude` dies
 * without its own cleanup its `run_in_background` shells are reparented to pid 1 while
 * the claudish wrapper (a verified member) lives on. So the merged list is the fresh one
 * PLUS every recorded escaped (pid, start) pair still in `table` — the same process, by
 * the identity rule — plus that survivor's own descendants outside the group. Dead or
 * reused entries drop out, so this list stays bounded too.
 */
export function mergeSnapshots(
  a: GroupSnapshot | null,
  b: GroupSnapshot | null,
  table: PsRow[]
): GroupSnapshot | null {
  if (!a) return b;
  if (!b || b.pgid !== a.pgid || b.members.length === 0) return a;
  const kept = new Set(liveEscaped(table, a));
  const survivors = table
    .filter((r) => kept.has(r.pid) && r.pgid !== a.pgid)
    .map((r) => ({ pid: r.pid, lstart: r.lstart }));
  const theirs = escapedDescendants(table, a.pgid, new Set(survivors.map((m) => m.pid)));
  return withEscaped(a.pgid, [...b.members], unionMembers(b.escaped ?? [], survivors, theirs));
}

function unionMembers(...lists: GroupMember[][]): GroupMember[] {
  const seen = new Set<string>();
  const out: GroupMember[] = [];
  for (const m of lists.flat()) {
    const k = `${m.pid} ${collapse(m.lstart)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out;
}

/** Same pgid and the same (pid, start) members, in any order. */
export function sameSnapshot(a: GroupSnapshot | null, b: GroupSnapshot | null): boolean {
  if (!a || !b) return a === b;
  if (a.pgid !== b.pgid) return false;
  const same = (x: GroupMember[], y: GroupMember[]) => {
    if (x.length !== y.length) return false;
    const keys = new Set(x.map((m) => `${m.pid} ${collapse(m.lstart)}`));
    return y.every((m) => keys.has(`${m.pid} ${collapse(m.lstart)}`));
  };
  return same(a.members, b.members) && same(a.escaped ?? [], b.escaped ?? []);
}

/**
 * The group check, before every group signal: some LIVE process whose pgid is the
 * recorded pgid has a (pid, start time) pair in the recorded members.
 */
export function groupCheck(table: PsRow[], snap: GroupSnapshot | null): boolean {
  if (!snap || !Number.isInteger(snap.pgid) || snap.pgid <= 1) return false;
  const keys = new Set(snap.members.map((m) => `${m.pid} ${collapse(m.lstart)}`));
  return table.some((r) => r.pgid === snap.pgid && keys.has(`${r.pid} ${r.lstart}`));
}

/**
 * Serialise a snapshot as the `group` file: the pgid, one `pid lstart` line per member,
 * then `--` and one line per escaped descendant. \`member_in_pg\` reads only the lines
 * before `--`, so an escaped line never widens the group check.
 */
export function formatGroupFile(snap: GroupSnapshot): string {
  const line = (m: GroupMember) => `${m.pid} ${collapse(m.lstart)}`;
  const esc = snap.escaped?.length ? `--\n${snap.escaped.map(line).join("\n")}\n` : "";
  return `${snap.pgid}\n${snap.members.map(line).join("\n")}\n${esc}`;
}

export function parseGroupFile(text: string): GroupSnapshot | null {
  const lines = text.split("\n").filter((l) => l.trim());
  const pgid = Number(lines[0]);
  if (!Number.isInteger(pgid) || pgid <= 1) return null;
  const members: GroupMember[] = [];
  const escaped: GroupMember[] = [];
  let into = members;
  for (const l of lines.slice(1)) {
    if (l.trim() === "--") {
      into = escaped;
      continue;
    }
    const m = l.match(/^(\d+) (.+)$/);
    if (m) into.push({ pid: Number(m[1]), lstart: collapse(m[2] ?? "") });
  }
  return withEscaped(pgid, members, escaped);
}

/* ───────────────────────────── paths (R3-M2) ───────────────────────────── */

export const LAUNCH_DIR_RE = /^launch-[A-Za-z0-9]{6}$/;

/** A control or turn directory: a real (non-symlink) directory, a direct child of `root`. */
export function isLaunchDirPath(root: string, p: string): boolean {
  if (dirname(p) !== root || !LAUNCH_DIR_RE.test(basename(p))) return false;
  try {
    const st = lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

const PANE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A pane id is one path component: `[A-Za-z0-9_-]`, at most 64, never all digits. */
export function isValidPaneId(id: string): boolean {
  return PANE_ID_RE.test(id) && !/^\d+$/.test(id);
}

export function sockPathOf(root: string, paneId: string): string {
  return join(root, `magmux-${paneId}.sock`);
}

export function recordPathOf(root: string, paneId: string): string {
  return join(root, "panes", `${paneId}.json`);
}

/**
 * The checks below compare a path against the ROOT and a validated pane id, never a
 * path against itself: a pane id read from a record is data, and `join` would turn a
 * `../` in it into a path outside the root.
 */
export function isPaneSockPath(root: string, p: string, paneId: string): boolean {
  return isValidPaneId(paneId) && dirname(p) === root && basename(p) === `magmux-${paneId}.sock`;
}

export function isPaneRecordPath(root: string, p: string, paneId: string): boolean {
  return (
    isValidPaneId(paneId) && dirname(p) === join(root, "panes") && basename(p) === `${paneId}.json`
  );
}

/* ───────────────────────────── the watcher, as shell ───────────────────────────── */

/**
 * Shell versions of the predicates above. Positional parameters (values are NEVER
 * interpolated into the script): $1 paneId, $2 sessionUuid, $3 ctlDir, $4 sockPath,
 * $5 recordPath, $6 turnDir, $7 sockRoot. `ps` and `pgrep` come from PATH, so a test can
 * source these functions against a recorded table.
 */
export const WATCHER_FUNCTIONS = `
set -f
export LC_ALL=C
PANE=$1 UUID=$2 CTL=$3 SOCKP=$4 REC=$5 TURN=$6 ROOT=$7
pstable() { ps -ax -ww -o pid=,pgid=,lstart=,command=; }
ps_ok() { ps -o pid= -p $$ >/dev/null 2>&1; }
mag=""
mag_ok() {
  case "$mag" in (''|*[!0-9]*) return 1;; esac
  ps -ww -o command= -p "$mag" 2>/dev/null | N="--id $PANE --sock-dir" awk 'index($0, ENVIRON["N"]) { f = 1 } END { exit !f }'
}
find_mag() {
  if [ -f "$CTL/magmux.pid" ]; then mag=$(head -n 1 "$CTL/magmux.pid"); fi
  mag_ok && return 0
  mag=$(pstable | N="--id $PANE --sock-dir" awk 'index($0, ENVIRON["N"]) { print $1; exit }')
  mag_ok
}
pg=""
ident_in_pg() {
  pstable | P="$pg" A="--session-id $UUID" B="$CTL/pane-launch.sh" awk '$2 == ENVIRON["P"] && (index($0, ENVIRON["A"]) || index($0, ENVIRON["B"])) { f = 1 } END { exit !f }'
}
member_in_pg() {
  [ -f "$CTL/group" ] || return 1
  pstable | P="$pg" G="$CTL/group" awk 'BEGIN { g = ENVIRON["G"]; while ((getline l < g) > 0) { if (++n == 1) continue; if (l == "--") break; k[l] = 1 } } $2 == ENVIRON["P"] && (($1 " " $3 " " $4 " " $5 " " $6 " " $7) in k) { f = 1 } END { exit !f }'
}
group_ok() {
  case "$pg" in (''|*[!0-9]*|0|1) return 1;; esac
  member_in_pg || ident_in_pg
}
find_pg() {
  pg=""
  if [ -f "$CTL/group" ]; then pg=$(head -n 1 "$CTL/group"); fi
  case "$pg" in (''|*[!0-9]*) pg="";; esac
  if [ -z "$pg" ] && mag_ok; then
    lead=$(pgrep -P "$mag" | head -n 1)
    [ -n "$lead" ] && pg=$(ps -o pgid= -p "$lead" | tr -d ' ')
  fi
  group_ok
}
escaped_live() {
  [ -f "$CTL/group" ] || return 0
  pstable | G="$CTL/group" awk 'BEGIN { g = ENVIRON["G"]; while ((getline l < g) > 0) { if (l == "--") f = 1; else if (f) k[l] = 1 } } { if (($1 " " $3 " " $4 " " $5 " " $6 " " $7) in k) print $1 }'
}
alive() { group_ok || mag_ok || [ -n "$(escaped_live)" ]; }
settle_wait() { i=0; while [ "$i" -lt "$1" ] && alive; do sleep 0.2; i=$((i + 1)); done; }
launch_dir_ok() {
  case "$1" in ("$ROOT"/launch-??????) ;; (*) return 1;; esac
  b=\${1#"$ROOT"/launch-}
  case "$b" in (*[!A-Za-z0-9]*) return 1;; esac
  [ -d "$1" ] && [ ! -L "$1" ]
}
`;

/** The pane watcher's main body, run after the functions. */
const WATCHER_MAIN = `
while IFS= read -r l; do [ "$l" = done ] && exit 0; done
# EOF without "done": the owner is gone (SIGKILL included: the kernel closed its end).
# No readable table (a sandbox refuses the setuid ps): nothing can be verified, so nothing
# is signalled or removed; the files stay for a sweep that can read the table.
ps_ok || exit 1
find_mag
find_pg
for s in TERM KILL; do
  alive || break
  group_ok && kill -"$s" -"$pg" 2>/dev/null
  for e in $(escaped_live); do kill -"$s" "$e" 2>/dev/null; done
  mag_ok && kill -"$s" "$mag" 2>/dev/null
  if [ "$s" = TERM ]; then settle_wait 10; else settle_wait 5; fi
done
alive && exit 1
[ "$SOCKP" = "$ROOT/magmux-$PANE.sock" ] && rm -f -- "$SOCKP"
[ "$REC" = "$ROOT/panes/$PANE.json" ] && rm -f -- "$REC"
launch_dir_ok "$CTL" && rm -rf -- "$CTL"
launch_dir_ok "$TURN" && rm -rf -- "$TURN"
exit 0
`;

export const WATCHER_SCRIPT = `${WATCHER_FUNCTIONS}${WATCHER_MAIN}`;

/** `argv[0]` the watcher runs under; the sweep recognises a live watcher by it. */
export const WATCHER_ARGV0 = "claudish-pane-watcher";

export interface WatcherArgs {
  paneId: string;
  sessionUuid: string;
  ctlDir: string;
  sockPath: string;
  recordPath: string;
  turnDir: string;
  sockRoot: string;
}

/** `/bin/sh` argv for one watcher: values only as positional parameters. */
export function watcherArgv(a: WatcherArgs): string[] {
  return [
    "-c",
    WATCHER_SCRIPT,
    WATCHER_ARGV0,
    a.paneId,
    a.sessionUuid,
    a.ctlDir,
    a.sockPath,
    a.recordPath,
    a.turnDir,
    a.sockRoot,
  ];
}

/** A process table row is pane `paneId`'s watcher. */
export function isPaneWatcherCommand(command: string, paneId: string): boolean {
  return command.includes(` ${WATCHER_ARGV0} ${paneId} `);
}
