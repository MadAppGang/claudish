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
 * Every process-table read is ONE `LC_ALL=C ps -ax -ww -o pid=,ppid=,pgid=,lstart=,command=`
 * (portable across macOS and Linux; `ps -g` means different things on the two).
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
  /** `lstart`, whitespace collapsed: `Mon Oct 6 12:34:56 2026` */
  lstart: string;
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

const PS_ARGS = ["-ax", "-ww", "-o", "pid=,ppid=,pgid=,lstart=,command="];
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s?(.*)$/;

export function collapse(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

/** Parse `ps -o pid=,ppid=,pgid=,lstart=,command=` output. Unparseable rows are dropped. */
export function parsePsTable(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(PS_ROW);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      lstart: collapse(m[4] ?? ""),
      command: (m[5] ?? "").trim(),
    });
  }
  return rows;
}

const PS_ENV = { PATH: "/bin:/usr/bin:/usr/sbin:/sbin", LC_ALL: "C" };

/** The whole process table, synchronously (exit hooks, the sweep). */
export function readProcessTable(): PsRow[] {
  try {
    return parsePsTable(
      execFileSync("ps", PS_ARGS, {
        env: PS_ENV,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      })
    );
  } catch {
    return [];
  }
}

/** The whole process table without blocking the event loop (the registry tick). */
export function readProcessTableAsync(): Promise<PsRow[]> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      PS_ARGS,
      { env: PS_ENV, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => resolve(err ? [] : parsePsTable(String(stdout)))
    );
  });
}

/** `lstart` of one pid, or null when it is gone. */
export function lstartOf(pid: number, table?: PsRow[]): string | null {
  const rows = table ?? readProcessTable();
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

/** `pid` is, right now, pane `paneId`'s magmux. */
export function isPaneMagmux(pid: number, paneId: string, table?: PsRow[]): boolean {
  const rows = table ?? readProcessTable();
  const row = rows.find((r) => r.pid === pid);
  return !!row && isPaneMagmuxCommand(row.command, paneId);
}

/** Every magmux process carrying pane `paneId` (normally zero or one). */
export function findPaneMagmux(paneId: string, table?: PsRow[]): PsRow[] {
  return (table ?? readProcessTable()).filter((r) => isPaneMagmuxCommand(r.command, paneId));
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
