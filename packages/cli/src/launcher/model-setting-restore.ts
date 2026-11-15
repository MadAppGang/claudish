/**
 * Putting back the user's Claude Code `model` setting after a /model lineup session.
 *
 * Enter in `/model` saves the pick as Claude Code's default: Claude Code writes
 * `model` into the user `settings.json`, and nothing claudish hands it changes
 * where that write goes. A pick of a listed claudish spec (`devin@swe-1.7`) left
 * there makes plain `claude` start on a model only claudish can route. So:
 *
 * - Before Claude Code starts, the launch records the file's `model` value (or
 *   its absence) in a ledger, keyed by the file's canonical path, with one
 *   session row per running launch.
 * - The last session to end for that file puts the old value back (or deletes
 *   the key), but only while the file still holds one of the listed specs. Any
 *   other value is the user's own and is left alone.
 * - The write is a compare-and-set: the file is re-read and re-stat'ed right
 *   before the rename, and any change sends the decision round again (up to 3
 *   rounds). Only `model` is ever written; an unparsable file is never written.
 * - A session counts as live while its launcher OR its Claude Code child is
 *   live (pid + start time), because Claude Code outlives a SIGKILLed launcher
 *   and can still write the file. A child never recorded is looked for by the
 *   `--settings <path>` its launch handed it.
 * - A crash or a deadline exit leaves the entry; the next interactive launch of
 *   any kind sweeps it once every session is gone.
 *
 * The ledger (`model-setting-ledger-path.ts`) is 0600 in a 0700 directory and
 * guarded by a cross-process lock. An unavailable lock writes nothing: the
 * entry stays for the next sweep. The ledger file is deleted with its last
 * entry, so a launch with nothing pending only stats a missing file.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { atomicWriteFileSync } from "../auth/accounts/atomic-write.js";
import {
  FileLockUnavailableError,
  type LockHandle,
  acquireFileLockSync,
  withFileLock,
} from "../auth/accounts/file-lock.js";
import { userSettingsFile } from "../claude-runner.js";
import { log, logStderr } from "../logger.js";
import {
  type ProcessTable,
  pidMayBeAlive,
  readProcessTable,
  startedAt,
} from "../pane/process-identity.js";
import { modelSettingLedgerPath } from "./model-setting-ledger-path.js";

/** A process identified by pid and start time (epoch ms), so a reused pid is not it. */
export interface ProcessMark {
  pid: number;
  /** Measured by the process that recorded the mark; null when unknown. */
  startedEpochMs: number | null;
}

export interface LedgerSession {
  /** This launch's own id, so its exit finds exactly its row. */
  id: string;
  launcher: ProcessMark;
  child: ProcessMark | "pending";
  /** The `--settings <path>` value handed to this session's Claude Code; null until recorded. */
  settingsArg: string | null;
  startedAt: number;
}

/** The five fields compared to decide whether a file changed. */
export interface FileStat {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  mode: number;
}

export type OriginalModel = { present: false } | { present: true; value: unknown };

export interface LedgerEntry {
  original: OriginalModel;
  /** Every spec handed to Claude Code since `original` was recorded. */
  listed: string[];
  sessions: LedgerSession[];
  /** A restore that could not read or write the file; retried only once the file changes. */
  failure?: {
    outcome: "unparsable" | "not-writable";
    firstAt: number;
    stat: FileStat | null;
    reported: true;
  };
}

interface Ledger {
  version: 1;
  entries: Record<string, LedgerEntry>;
}

export type RestoreOutcome =
  | "restored"
  | "left"
  | "changed-under-us"
  | "unparsable"
  | "absent"
  | "not-writable"
  /** The ledger lock was taken from this holder before the rename; nothing was written. */
  | "fenced";

/**
 * Answers whether this process still holds the ledger lock. Asked immediately
 * before every durable write: a holder suspended past the stale TTL may have
 * been stolen from, and its stale copy must not overwrite the new holder's.
 */
export type LockFence = () => boolean;

/** The file operations the compare-and-set uses; real ones by default. */
export interface RestoreFsDeps {
  realpath(path: string): string;
  readFile(path: string): Buffer;
  stat(path: string): FileStat;
  /** Create `path` exclusively with `mode`, write `data`, fsync, close. */
  writeNew(path: string, data: string, mode: number): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  /** Test hook: runs between the temp write and the final re-check. */
  beforeRename?: () => void;
  pid?: number;
}

export interface RestoreDeps {
  /** The user settings file; default: the one Claude Code loads for this environment. */
  settingsFile?: string;
  ledgerPath?: string;
  pid?: number;
  processTable?: () => ProcessTable;
  fs?: RestoreFsDeps;
  beforeRename?: () => void;
  now?: () => number;
  /** Where the user-facing lines go; default `logStderr`. */
  report?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface ModelSettingWatch {
  /**
   * True when this session holds a row in the ledger, so its exit can put the
   * setting back. False for an inert watch, whose cause was already reported.
   */
  readonly registered: boolean;
  /** Records the temp settings path in this session's row before spawn. Never rejects. */
  recordSettingsArg(settingsPath: string): Promise<void>;
  /** Records the Claude Code child's pid and start time, synchronously when the lock is free. */
  recordChild(pid: number): void;
  /** Runs the exit transaction; resolves when it is done or given up. */
  end(): Promise<void>;
  /** The deadline path's exit transaction, with a short synchronous lock wait. */
  endSync(): void;
}

/** Async lock wait (begin, end, sweep). */
const LOCK_TIMEOUT_MS = 2_000;
/** How often an async holder refreshes its lock, well inside {@link LOCK_STALE_MS}. */
const LOCK_HEARTBEAT_MS = 2_000;
/** Sync lock wait: the event loop is blocked for the whole of it. */
const SYNC_LOCK_WAIT_MS = 250;
/** A holder this old is dead debris; every holder here finishes in milliseconds. */
const LOCK_STALE_MS = 10_000;
/** How often the compare-and-set decides again after a concurrent change. */
const RESTORE_ROUNDS = 3;
/** How long an entry is kept for a session whose liveness cannot be read, or a failed file. */
const GIVE_UP_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
/** The prefix of a compare-and-set temp file, next to the settings file. */
const TEMP_PREFIX = ".settings.json.claudish-";

/* ─────────────────────────── canonical path ─────────────────────────── */

/**
 * One identity per settings file: `realpath` of the longest existing ancestor,
 * plus the rest. A symlinked config dir, `..` and a case variant on a
 * case-insensitive volume all give one key; a file that does not exist yet
 * still gets one.
 */
export function canonicalSettingsPath(path: string): string {
  let head = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(head), ...rest);
    } catch {
      const parent = dirname(head);
      if (parent === head) return join(head, ...rest);
      rest.unshift(basename(head));
      head = parent;
    }
  }
}

/* ─────────────────────────── the decision ─────────────────────────── */

/** Pure: what the file's current `model` value calls for. */
export function restoreDecision(
  current: unknown,
  entry: { original: OriginalModel; listed: string[] }
): { action: "leave" } | { action: "set"; value: unknown } | { action: "delete" } {
  if (typeof current !== "string" || !entry.listed.includes(current)) return { action: "leave" };
  // The original value is itself a listed spec and still in place: nothing to put back.
  if (entry.original.present && entry.original.value === current) return { action: "leave" };
  return entry.original.present
    ? { action: "set", value: entry.original.value }
    : { action: "delete" };
}

/* ─────────────────────────── compare-and-set ─────────────────────────── */

function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

function toFileStat(s: { dev: number; ino: number; size: number; mtimeMs: number; mode: number }) {
  return { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, mode: s.mode };
}

function sameStat(a: FileStat, b: FileStat): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.mode === b.mode
  );
}

export const realRestoreFs: RestoreFsDeps = {
  realpath: (path) => realpathSync.native(path),
  readFile: (path) => readFileSync(path),
  stat: (path) => toFileStat(statSync(path)),
  writeNew: (path, data, mode) => {
    const fd = openSync(path, "wx", mode);
    try {
      // `open`'s mode is masked by the umask; the file keeps the original's mode.
      fchmodSync(fd, mode);
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  rename: (from, to) => renameSync(from, to),
  unlink: (path) => unlinkSync(path),
};

/** The indentation the file uses: none for a one-line file, else its own (2 when it cannot be told). */
function detectIndent(text: string): string | number | undefined {
  if (!text.trim().includes("\n")) return undefined;
  const m = text.match(/^\{\s*?\n([ \t]+)\S/);
  return m?.[1] ? m[1] : 2;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The compare-and-set write. Starts from the ledger key, never from a path the
 * caller recomputes. Writes `model` alone, keeps every other key, the file's
 * indentation, its trailing newline, its mode, and a symlink as a symlink (the
 * rename replaces the link's target). Any change between the read and the
 * rename sends the decision round again; after {@link RESTORE_ROUNDS} it gives up.
 */
export function restoreSettingsFile(
  settingsKey: string,
  entry: Pick<LedgerEntry, "original" | "listed">,
  deps: RestoreFsDeps = realRestoreFs,
  fence: LockFence = () => true
): RestoreOutcome {
  let target: string;
  try {
    target = deps.realpath(settingsKey);
  } catch (err) {
    return errnoOf(err) === "ENOENT" ? "absent" : "not-writable";
  }
  for (let round = 0; round < RESTORE_ROUNDS; round++) {
    const outcome = restoreRound(settingsKey, target, entry, deps, fence);
    if (outcome !== "retry") return outcome;
  }
  return "changed-under-us";
}

/** The file's new text with only `model` changed, or the outcome that stops the restore. */
function nextSettingsText(
  text: string,
  entry: Pick<LedgerEntry, "original" | "listed">
): { next: string } | { outcome: "unparsable" | "left" } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { outcome: "unparsable" };
  }
  if (!isPlainObject(parsed)) return { outcome: "unparsable" };
  const decision = restoreDecision(parsed.model, entry);
  if (decision.action === "leave") return { outcome: "left" };
  if (decision.action === "set") parsed.model = decision.value;
  else delete parsed.model;
  const newline = text.endsWith("\n") ? "\n" : "";
  return { next: `${JSON.stringify(parsed, null, detectIndent(text))}${newline}` };
}

function unlinkQuietly(deps: RestoreFsDeps, path: string): void {
  try {
    deps.unlink(path);
  } catch {
    // never created, or already gone
  }
}

/** One read-decide-write round; "retry" when the file changed before the rename. */
function restoreRound(
  settingsKey: string,
  target: string,
  entry: Pick<LedgerEntry, "original" | "listed">,
  deps: RestoreFsDeps,
  fence: LockFence
): RestoreOutcome | "retry" {
  let bytesA: Buffer;
  let statA: FileStat;
  try {
    bytesA = deps.readFile(target);
    statA = deps.stat(target);
  } catch (err) {
    return errnoOf(err) === "ENOENT" ? "absent" : "not-writable";
  }
  const text = bytesA.toString("utf8");
  const planned = nextSettingsText(text, entry);
  if ("outcome" in planned) return planned.outcome;

  const temp = join(dirname(target), `${TEMP_PREFIX}${deps.pid ?? process.pid}-${randomUUID()}`);
  try {
    deps.writeNew(temp, planned.next, statA.mode & 0o7777);
  } catch {
    unlinkQuietly(deps, temp);
    return "not-writable";
  }
  deps.beforeRename?.();

  let unchanged = false;
  try {
    unchanged =
      deps.realpath(settingsKey) === target &&
      sameStat(deps.stat(target), statA) &&
      deps.readFile(target).equals(bytesA);
  } catch {
    unchanged = false;
  }
  if (!unchanged) {
    unlinkQuietly(deps, temp);
    return "retry";
  }
  if (!fence()) {
    unlinkQuietly(deps, temp);
    return "fenced";
  }
  try {
    deps.rename(temp, target);
  } catch {
    unlinkQuietly(deps, temp);
    return "not-writable";
  }
  return "restored";
}

/* ─────────────────────────── the ledger ─────────────────────────── */

type LedgerUnreadable = "unreadable" | "unparsable" | "unknown-shape";

type LedgerRead = { ok: true; ledger: Ledger } | { ok: false; reason: LedgerUnreadable };

function readLedger(path: string): LedgerRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (errnoOf(err) === "ENOENT") return { ok: true, ledger: { version: 1, entries: {} } };
    log(`[model-restore] ledger unreadable (${path}): ${errnoOf(err) ?? String(err)}`);
    return { ok: false, reason: "unreadable" };
  }
  // Never rewritten when it cannot be read: an entry this process cannot read
  // may still be pending.
  let parsed: Ledger;
  try {
    parsed = JSON.parse(text) as Ledger;
  } catch (err) {
    log(`[model-restore] ledger unparsable (${path}): ${(err as Error).message}`);
    return { ok: false, reason: "unparsable" };
  }
  if (parsed?.version !== 1 || !isPlainObject(parsed.entries)) {
    log(`[model-restore] ledger of unknown shape (${path})`);
    return { ok: false, reason: "unknown-shape" };
  }
  return { ok: true, ledger: parsed };
}

/** Ledger paths whose unreadable state this process already reported. */
const reportedUnreadableLedgers = new Set<string>();

/**
 * Tells the user, once per process, that a ledger claudish cannot read stops
 * every restore until it is deleted: it is never rewritten, so nothing else
 * clears it.
 */
function reportUnreadableLedger(ctx: Context, reason: LedgerUnreadable): void {
  if (reportedUnreadableLedgers.has(ctx.ledgerPath)) return;
  reportedUnreadableLedgers.add(ctx.ledgerPath);
  const why =
    reason === "unreadable"
      ? "cannot be read"
      : reason === "unparsable"
        ? "is not valid JSON"
        : "has a version or shape this claudish does not read";
  ctx.report(
    `${ctx.ledgerPath} ${why}, so claudish cannot put back your Claude Code default model; delete that file`
  );
}

/**
 * Writes the ledger, or deletes it when its last entry is gone. Writes nothing
 * and answers false when `fence` says the lock is no longer this process's.
 */
function writeLedger(path: string, ledger: Ledger, fence: LockFence): boolean {
  if (!fence()) {
    log(`[model-restore] ledger lock taken by another claudish; ${path} not written`);
    return false;
  }
  if (Object.keys(ledger.entries).length === 0) {
    rmSync(path, { force: true });
    return true;
  }
  atomicWriteFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  });
  return true;
}

/** The fence of a held lock; a missing handle holds nothing. */
function fenceOf(handle: LockHandle | null): LockFence {
  return () => handle?.holdsLock() ?? false;
}

function lockPathOf(ledgerPath: string): string {
  return `${ledgerPath}.lock`;
}

/* ─────────────────────────── liveness ─────────────────────────── */

/** A mark is live while its pid's row exists and started when the mark says. */
function markLive(mark: ProcessMark, table: ProcessTable): boolean {
  if (table === null || mark.startedEpochMs === null) return pidMayBeAlive(mark.pid);
  const row = table.find((r) => r.pid === mark.pid);
  return row !== undefined && startedAt(row, mark.startedEpochMs);
}

/**
 * A process whose command line carries this session's `--settings` path: its
 * Claude Code, even when the launcher died before recording the child. With
 * no recorded path, the temp file's name pattern for the launcher's pid, on
 * rows started at or after the launcher.
 */
function settingsWriterLive(session: LedgerSession, table: NonNullable<ProcessTable>): boolean {
  if (session.settingsArg) {
    const needle = `--settings ${session.settingsArg}`;
    return table.some((r) => r.command.includes(needle));
  }
  const nameNeedle = `/.claudish/settings-${session.launcher.pid}-`;
  const since = session.launcher.startedEpochMs;
  return table.some(
    (r) =>
      r.command.includes("--settings ") &&
      r.command.includes(nameNeedle) &&
      (since === null || r.startMs === undefined || r.startMs >= since - 2_000)
  );
}

type Liveness = "live" | "ended" | "unknown";

/** A session is live while its launcher or its Claude Code child is. */
function sessionLiveness(session: LedgerSession, table: ProcessTable): Liveness {
  if (markLive(session.launcher, table)) return "live";
  if (session.child !== "pending") return markLive(session.child, table) ? "live" : "ended";
  if (table === null) return "unknown";
  return settingsWriterLive(session, table) ? "live" : "ended";
}

/* ─────────────────────────── outcomes ─────────────────────────── */

interface Context {
  ledgerPath: string;
  fs: RestoreFsDeps;
  now: () => number;
  report: (line: string) => void;
  processTable: () => ProcessTable;
}

function contextOf(deps: RestoreDeps): Context {
  const fs = deps.fs ?? realRestoreFs;
  const withHooks: RestoreFsDeps = {
    ...fs,
    ...(deps.beforeRename ? { beforeRename: deps.beforeRename } : {}),
    ...(deps.pid !== undefined ? { pid: deps.pid } : {}),
  };
  return {
    ledgerPath: deps.ledgerPath ?? modelSettingLedgerPath(deps.env ?? process.env),
    fs: withHooks,
    now: deps.now ?? Date.now,
    report: deps.report ?? logStderr,
    processTable: deps.processTable ?? readProcessTable,
  };
}

function statOrNull(ctx: Context, key: string): FileStat | null {
  try {
    return ctx.fs.stat(ctx.fs.realpath(key));
  } catch {
    return null;
  }
}

/**
 * Runs the restore for an entry no live session holds, and applies its outcome
 * to the ledger: deleted when settled, kept for a later sweep otherwise.
 * `silent` is the sweep's retry of a recorded failure: nothing is printed again.
 */
function settleEntry(
  ctx: Context,
  ledger: Ledger,
  key: string,
  silent: boolean,
  fence: LockFence
): void {
  const entry = ledger.entries[key];
  if (!entry) return;
  const outcome = restoreSettingsFile(key, entry, ctx.fs, fence);
  log(`[model-restore] ${key}: ${outcome}`);
  switch (outcome) {
    case "fenced":
      // The ledger is another holder's now; this copy is written nowhere.
      return;
    case "restored":
      ctx.report(`Put back your Claude Code default model in ${key}`);
      delete ledger.entries[key];
      return;
    case "left":
    case "absent":
      delete ledger.entries[key];
      return;
    case "changed-under-us":
      entry.sessions = [];
      if (!silent) {
        ctx.report(
          `${key} kept changing while claudish put back your default model; it will try again at the next launch`
        );
      }
      return;
    case "unparsable":
    case "not-writable": {
      entry.sessions = [];
      if (!entry.failure) {
        entry.failure = {
          outcome,
          firstAt: ctx.now(),
          stat: statOrNull(ctx, key),
          reported: true,
        };
        const why = outcome === "unparsable" ? "is not valid JSON" : "cannot be written";
        ctx.report(
          `${key} ${why}, so claudish did not put back your default model; set or remove "model" in ${key} by hand`
        );
      } else {
        entry.failure.stat = statOrNull(ctx, key);
      }
      return;
    }
  }
}

/** Removes compare-and-set temp files of processes that are gone, next to the settings file. */
function removeOrphanTemps(ctx: Context, key: string, table: ProcessTable): void {
  const dirs = new Set([dirname(key)]);
  try {
    dirs.add(dirname(ctx.fs.realpath(key)));
  } catch {
    // the file is gone; its key's directory is still checked
  }
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(TEMP_PREFIX)) continue;
      const pid = Number(name.slice(TEMP_PREFIX.length).split("-")[0]);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      const live = table === null ? pidMayBeAlive(pid) : table.some((r) => r.pid === pid);
      if (live) continue;
      try {
        unlinkSync(join(dir, name));
      } catch {
        // already gone
      }
    }
  }
}

/* ─────────────────────────── the sweep ─────────────────────────── */

function sweepLedger(ctx: Context, ledger: Ledger, fence: LockFence): void {
  const table = ctx.processTable();
  const now = ctx.now();
  for (const key of Object.keys(ledger.entries)) {
    const entry = ledger.entries[key];
    if (!entry) continue;
    removeOrphanTemps(ctx, key, table);
    const kept: LedgerSession[] = [];
    let unknownOnly = true;
    for (const session of entry.sessions) {
      const liveness = sessionLiveness(session, table);
      if (liveness === "ended") continue;
      kept.push(session);
      if (liveness === "live" || now - session.startedAt <= GIVE_UP_AFTER_MS) unknownOnly = false;
    }
    entry.sessions = kept;
    if (kept.length > 0) {
      if (!unknownOnly) continue;
      // Liveness unreadable for 14 days: the entry is dropped, not restored.
      ctx.report(
        `Gave up putting back your Claude Code default model in ${key}: no process table for 14 days`
      );
      delete ledger.entries[key];
      continue;
    }
    if (entry.failure) {
      if (now - entry.failure.firstAt > GIVE_UP_AFTER_MS) {
        ctx.report(
          `Gave up putting back your Claude Code default model in ${key}; set or remove "model" there by hand`
        );
        delete ledger.entries[key];
        continue;
      }
      const stat = statOrNull(ctx, key);
      const unchanged =
        stat !== null && entry.failure.stat !== null && sameStat(stat, entry.failure.stat);
      if (unchanged) continue;
      settleEntry(ctx, ledger, key, true, fence);
      continue;
    }
    settleEntry(ctx, ledger, key, false, fence);
  }
}

/**
 * The crash and deadline sweep, run by every interactive launch that finds the
 * ledger. Drops the sessions that ended, restores each entry no session holds
 * any more, and removes orphaned temp files. An unavailable lock does nothing.
 */
export async function sweepModelSettingLedger(deps: RestoreDeps = {}): Promise<void> {
  const ctx = contextOf(deps);
  try {
    await withFileLock(
      lockPathOf(ctx.ledgerPath),
      {
        timeoutMs: LOCK_TIMEOUT_MS,
        staleMs: LOCK_STALE_MS,
        heartbeatMs: LOCK_HEARTBEAT_MS,
        onUnavailable: "fail",
      },
      async (handle) => {
        const read = readLedger(ctx.ledgerPath);
        if (!read.ok) {
          reportUnreadableLedger(ctx, read.reason);
          return;
        }
        const fence = fenceOf(handle);
        sweepLedger(ctx, read.ledger, fence);
        writeLedger(ctx.ledgerPath, read.ledger, fence);
      }
    );
  } catch (err) {
    log(`[model-restore] sweep skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ─────────────────────────── the watch ─────────────────────────── */

const INERT_WATCH: ModelSettingWatch = {
  registered: false,
  recordSettingsArg: async () => {},
  recordChild: () => {},
  end: async () => {},
  endSync: () => {},
};

/** The model setting as it is now; null when the file cannot be read or parsed. */
function readOriginal(ctx: Context, key: string): OriginalModel | null {
  let text: string;
  try {
    text = ctx.fs.readFile(ctx.fs.realpath(key)).toString("utf8");
  } catch (err) {
    return errnoOf(err) === "ENOENT" ? { present: false } : null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed)) return null;
    return "model" in parsed ? { present: true, value: parsed.model } : { present: false };
  } catch {
    return null;
  }
}

/** This process's own start time, measured in-process. */
function selfStartEpochMs(): number {
  return Math.round(Date.now() - process.uptime() * 1000);
}

/**
 * Begins this launch's watch on the user settings file: records the original
 * value (or reuses the entry another live session recorded), the listed specs
 * and this session's row. Never rejects; when the ledger or the settings file
 * cannot be read, or the lock is unavailable, the watch is inert, nothing will
 * be written for this session, and one line naming the cause and the file is
 * reported.
 */
export async function beginModelSettingWatch(
  listedSpecs: readonly string[],
  deps: RestoreDeps = {}
): Promise<ModelSettingWatch> {
  const ctx = contextOf(deps);
  const env = deps.env ?? process.env;
  const settingsFile =
    deps.settingsFile ??
    userSettingsFile(
      env.CLAUDE_CONFIG_DIR,
      env.HOME && env.HOME.length > 0 ? env.HOME : homedir(),
      deps.cwd ?? process.cwd()
    );
  const key = canonicalSettingsPath(settingsFile);
  const lockPath = lockPathOf(ctx.ledgerPath);
  const lockOpts = {
    timeoutMs: LOCK_TIMEOUT_MS,
    staleMs: LOCK_STALE_MS,
    heartbeatMs: LOCK_HEARTBEAT_MS,
    onUnavailable: "fail" as const,
  };
  const sessionId = randomUUID();
  const launcherPid = deps.pid ?? process.pid;

  const noRestore =
    "so claudish will not put back your Claude Code default model after this session";
  let registered = false;
  try {
    registered = await withFileLock(lockPath, lockOpts, async (handle) => {
      const read = readLedger(ctx.ledgerPath);
      if (!read.ok) {
        reportUnreadableLedger(ctx, read.reason);
        return false;
      }
      const unreadableAtLaunch = (): false => {
        log(`[model-restore] ${key} unreadable at launch; no restore for this session`);
        ctx.report(`${key} cannot be read or is not a JSON object, ${noRestore}`);
        return false;
      };
      let entry = read.ledger.entries[key];
      if (!entry) {
        const original = readOriginal(ctx, key);
        if (original === null) return unreadableAtLaunch();
        entry = { original, listed: [], sessions: [] };
        read.ledger.entries[key] = entry;
      } else if (entry.failure) {
        // A restore already failed on this file, and its exit stays silent about
        // that failure: register only once the file can be read again. The
        // entry keeps its `original`, the user's value from before the first
        // listed pick; a still-failing file leaves the entry for a later sweep.
        if (readOriginal(ctx, key) === null) return unreadableAtLaunch();
        delete entry.failure;
      }
      for (const spec of listedSpecs) if (!entry.listed.includes(spec)) entry.listed.push(spec);
      entry.sessions.push({
        id: sessionId,
        launcher: { pid: launcherPid, startedEpochMs: selfStartEpochMs() },
        child: "pending",
        settingsArg: null,
        startedAt: ctx.now(),
      });
      if (!writeLedger(ctx.ledgerPath, read.ledger, fenceOf(handle))) {
        ctx.report(`${lockPath} was taken by another claudish, ${noRestore}`);
        return false;
      }
      return true;
    });
  } catch (err) {
    log(`[model-restore] watch not begun: ${err instanceof Error ? err.message : String(err)}`);
    ctx.report(
      err instanceof FileLockUnavailableError && err.reason !== "unwritable"
        ? `${lockPath} is held by another claudish, ${noRestore}`
        : `${ctx.ledgerPath} cannot be written, ${noRestore}`
    );
  }
  if (!registered) return INERT_WATCH;

  let childMark: ProcessMark | null = null;
  let ended = false;

  /** Updates this session's row; false when the ledger, entry or row is gone. */
  const updateRow = (fence: LockFence, update: (session: LedgerSession) => void): void => {
    const read = readLedger(ctx.ledgerPath);
    if (!read.ok) return;
    const session = read.ledger.entries[key]?.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    update(session);
    writeLedger(ctx.ledgerPath, read.ledger, fence);
  };

  /** The exit transaction, run under the ledger lock. */
  const exitTransaction = (fence: LockFence): void => {
    const read = readLedger(ctx.ledgerPath);
    if (!read.ok) return;
    const entry = read.ledger.entries[key];
    if (!entry) return;
    const index = entry.sessions.findIndex((s) => s.id === sessionId);
    if (index < 0) return;
    const table = ctx.processTable();
    // This session's own Claude Code is still running (killed but not reaped):
    // it can still write the file, so the row stays for the next sweep.
    if (childMark && markLive(childMark, table)) return;
    entry.sessions.splice(index, 1);
    const othersLive = entry.sessions.some((s) => sessionLiveness(s, table) !== "ended");
    if (!othersLive) {
      entry.sessions = [];
      settleEntry(ctx, read.ledger, key, false, fence);
    }
    writeLedger(ctx.ledgerPath, read.ledger, fence);
  };

  return {
    registered: true,
    recordSettingsArg: async (settingsPath) => {
      try {
        await withFileLock(lockPath, lockOpts, async (handle) =>
          updateRow(fenceOf(handle), (s) => {
            s.settingsArg = settingsPath;
          })
        );
      } catch (err) {
        log(`[model-restore] settings path not recorded: ${(err as Error)?.message ?? err}`);
      }
    },
    recordChild: (pid) => {
      const mark: ProcessMark = { pid, startedEpochMs: Date.now() };
      childMark = mark;
      const apply = (handle: LockHandle | null) =>
        updateRow(fenceOf(handle), (s) => {
          s.child = mark;
        });
      try {
        const handle = acquireFileLockSync(lockPath, {
          staleMs: LOCK_STALE_MS,
          waitMs: SYNC_LOCK_WAIT_MS,
        });
        try {
          apply(handle);
        } finally {
          handle.release();
        }
      } catch {
        void withFileLock(lockPath, lockOpts, async (handle) => apply(handle)).catch(
          (err: unknown) =>
            log(`[model-restore] child not recorded: ${(err as Error)?.message ?? err}`)
        );
      }
    },
    end: async () => {
      if (ended) return;
      ended = true;
      try {
        await withFileLock(lockPath, lockOpts, async (handle) => exitTransaction(fenceOf(handle)));
      } catch (err) {
        log(`[model-restore] exit skipped: ${(err as Error)?.message ?? err}`);
      }
    },
    endSync: () => {
      if (ended) return;
      ended = true;
      try {
        const handle = acquireFileLockSync(lockPath, {
          staleMs: LOCK_STALE_MS,
          waitMs: SYNC_LOCK_WAIT_MS,
        });
        try {
          exitTransaction(fenceOf(handle));
        } finally {
          handle.release();
        }
      } catch (err) {
        log(`[model-restore] deadline exit skipped: ${(err as Error)?.message ?? err}`);
      }
    },
  };
}
