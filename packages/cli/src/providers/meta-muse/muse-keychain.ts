/**
 * The Muse Code CLI's login in the macOS Keychain: presence, and a value read
 * that runs at most once per machine at a time and is never killed.
 *
 * ## The item (muse-wire.md §1, §7)
 *
 * Generic password, service `ai.meta.dev.credentials`, account `meta`, in the
 * login keychain. Its value is JSON
 * `{secret_schema_version, api_key, access_token}`. claudish reads ONLY
 * `access_token` — the durable `dca:` token it mints its own key from. The
 * item's `api_key` is the Muse CLI's current minted key; it rotates under the
 * CLI and is never used here.
 *
 * ## Presence is free, a value read is a dialog
 *
 * Presence is `find-generic-password` without `-w`: attributes only, no item
 * data, no dialog, async, memoized for 3 s, never on a render path. A value read
 * (`-w`) of an item another application created opens the macOS access dialog
 * the first time, and the user may take minutes to answer.
 *
 * ## Who may read the value
 *
 * Only a process whose credential prompt role is not `never`
 * (`auth/credentials/prompt-role.ts`): an interactive launch, or the config
 * TUI inside an explicit user action. Every other process reads claudish's
 * own files (`muse-store.ts`) and nothing else.
 *
 * ## Never kill `security`
 *
 * A killed `security` mid-transaction is how this codebase once made macOS
 * restart `securityd` (keychain.md). The read goes through the joinable
 * `startGenericPasswordRead`: each caller races its `done` against ITS OWN
 * deadline and, when the deadline wins, stops waiting. `done` stays alive, a
 * late approval still resolves it, and the next caller in this process joins it
 * instead of opening a second dialog.
 *
 * ## One read per machine: `~/.claudish/muse-keychain-read.lock`
 *
 * Joining works inside one process. Across processes (a fan-out of CLI `--team`
 * grid panes, two launches in two terminals) the lock does the same job:
 *
 * - The holder creates it exclusively (`wx`) holding its own pid, then records
 *   the `security` CHILD's pid while the dialog is up — so a holder that gives
 *   up and exits leaves a lock that is still live for exactly as long as the
 *   dialog is, and goes stale the moment `security` exits (review M4). It holds
 *   the lock, with its own pid again, while its caller mints and writes the
 *   borrowed copy, then removes it.
 * - A process that finds a LIVE lock does not spawn. It waits for the lock to
 *   clear (bounded by its own deadline), then reads the borrowed copy the
 *   holder wrote DURING the wait (by mtime; an older copy is the one that
 *   sent it here). When the lock clears and no new copy appeared (the holder
 *   was denied, or its mint failed), it reads for itself — if its role allows.
 * - A lock whose pid is dead is removed and the read proceeds. The lock is
 *   re-read right before the `rm`, which NARROWS the window in which a fresh
 *   lock could be removed but does not close it: two processes that both judged
 *   the same stale lock can race, one acquiring a new lock that the other then
 *   unlinks. The cost is one extra access dialog, and only when two launches
 *   reclaim the same stale lock within microseconds; closing it would need an
 *   OS-level lock around acquire and reclaim. A lock naming this process's own
 *   pid that this process does not hold is stale.
 * - Only EEXIST means "held". Any other failure to create the lock ends the
 *   call with `failed`; every pass of the loop sleeps and honours the deadline.
 * - A token the user approved whose mint then failed TRANSIENTLY is kept in
 *   memory, so the retry mints again without a second dialog.
 *
 * `CLAUDISH_DISABLE_KEYCHAIN=1` disables every Keychain touch here (the suite's
 * escape hatch). `CLAUDISH_MUSE_KEYCHAIN_FILE` points both reads at a THROWAWAY
 * keychain file for verification; the real login keychain is never a test
 * target.
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { credentialPromptRole } from "../../auth/credentials/prompt-role.js";
import {
  type GenericPasswordResult,
  findGenericPasswordPresence,
  startGenericPasswordRead,
} from "../keychain.js";
import { defaultMuseStoreDir, museStorePath, readMuseStore } from "./muse-store.js";

export const MUSE_KEYCHAIN_SERVICE = "ai.meta.dev.credentials";
export const MUSE_KEYCHAIN_ACCOUNT = "meta";
const LOCK_FILE = "muse-keychain-read.lock";
const PRESENCE_TTL_MS = 3000;
const LOCK_POLL_MS = 500;
/** A lock older than this is stale whatever its pid says: pids are reused. */
const LOCK_MAX_AGE_MS = 30 * 60_000;
/** A lock file with no readable record yet is live only this long. */
const UNREADABLE_LOCK_GRACE_MS = 5000;

/** A caller's deadline for a value read: long enough to read the dialog and click. */
export const MUSE_KEYCHAIN_READ_DEADLINE_MS = 120_000;

/** What a value read produced. `failed` and `absent` are never the same answer. */
export type MuseKeychainRead =
  | { kind: "absent" }
  | { kind: "not-allowed" }
  | { kind: "timeout" }
  | { kind: "failed"; detail: string };

/** Side effects, injectable so the module is testable with no Keychain and no clock. */
export interface MuseKeychainDeps {
  presence: (query: {
    service: string;
    account: string;
    keychainFile?: string;
  }) => Promise<GenericPasswordResult>;
  startRead: (query: { service: string; account: string; keychainFile?: string }) => {
    done: Promise<GenericPasswordResult>;
    pid: number | undefined;
  };
  /** Liveness of a pid: signal 0 delivers nothing; it only asks whether the pid exists. */
  isAlive: (pid: number) => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  dir: () => string;
  env: () => Record<string, string | undefined>;
  pid: () => number;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0: an existence check; no signal is delivered
    return true;
  } catch (err) {
    // EPERM: the pid exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

const defaultDeps: MuseKeychainDeps = {
  presence: findGenericPasswordPresence,
  startRead: startGenericPasswordRead,
  isAlive: processExists,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  dir: defaultMuseStoreDir,
  env: () => process.env,
  pid: () => process.pid,
};

let deps: MuseKeychainDeps = defaultDeps;
let presenceMemo: { at: number; value: MuseKeychainPresence } | null = null;
/** This process's outstanding `security -w`, joined by every caller. */
let inFlight: Promise<GenericPasswordResult> | null = null;
/** A value a timed-out caller left behind; the next caller takes it without a dialog. */
let lateResult: GenericPasswordResult | null = null;
/**
 * The Keychain-state epoch. `resetMuseKeychainState()` bumps it; a read or a
 * token use that started in an older epoch may finish, but its result is
 * DROPPED: it never becomes `lateResult` or `retainedToken`, and a caller
 * after the reset never joins it. `security` itself is never killed.
 */
let keychainEpoch = 0;
/** The epoch `inFlight` was started in. */
let inFlightEpoch = 0;

/** Replace the side-effect seam; `null` restores the real one. */
/**
 * Forget every token this module holds for the process: the approved token
 * kept after a transient mint failure and an answer a timed-out caller left
 * behind. Called by `resetMuseCredentialState()` (login, logout,
 * `credentials.invalidate`), so a logout leaves nothing a later Test could mint
 * from without asking again. An outstanding `security` is left alone.
 */
export function resetMuseKeychainState(): void {
  keychainEpoch++;
  retainedToken = null;
  lateResult = null;
  // The outstanding read keeps running (never killed), but no caller after
  // the reset joins it; its answer is dropped (see `keychainEpoch`).
  inFlight = null;
}

export function setMuseKeychainTestDeps(next: Partial<MuseKeychainDeps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
  presenceMemo = null;
  inFlight = null;
  lateResult = null;
  holdsLock = false;
  retainedToken = null;
}

function disabled(): boolean {
  return deps.env().CLAUDISH_DISABLE_KEYCHAIN === "1";
}

function query(): { service: string; account: string; keychainFile?: string } {
  const file = deps.env().CLAUDISH_MUSE_KEYCHAIN_FILE;
  return {
    service: MUSE_KEYCHAIN_SERVICE,
    account: MUSE_KEYCHAIN_ACCOUNT,
    ...(file ? { keychainFile: file } : {}),
  };
}

export type MuseKeychainPresence = "present" | "absent" | "failed";

/** Whether the Muse login item exists. Attributes only; no dialog. Memoized 3 s. */
export async function museKeychainPresence(): Promise<MuseKeychainPresence> {
  if (disabled()) return "absent";
  const at = deps.now();
  if (presenceMemo && at - presenceMemo.at < PRESENCE_TTL_MS) return presenceMemo.value;
  const result = await deps.presence(query());
  const value: MuseKeychainPresence =
    result.kind === "found" ? "present" : result.kind === "absent" ? "absent" : "failed";
  presenceMemo = { at, value };
  return value;
}

/** The last presence answer without asking again, for sync status reads. */
export function museKeychainPresenceCached(): MuseKeychainPresence | "unknown" {
  return presenceMemo ? presenceMemo.value : "unknown";
}

/** The `dca:` token inside the item's JSON value, or null. `api_key` is ignored. */
export function parseMuseKeychainValue(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as { access_token?: unknown };
    const token = parsed?.access_token;
    return typeof token === "string" && token.trim().length > 0 ? token : null;
  } catch {
    return null;
  }
}

// ── The per-machine lock ────────────────────────────────────────────────────

interface LockRecord {
  pid: number;
  holder: "security" | "claudish";
  startedAt: number;
}

function lockPath(): string {
  return join(deps.dir(), LOCK_FILE);
}

function readLock(): LockRecord | null {
  let mtime: number;
  try {
    mtime = statSync(lockPath()).mtimeMs;
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(lockPath(), "utf8")) as Partial<LockRecord>;
    if (typeof parsed.pid === "number" && parsed.pid > 0) {
      return {
        pid: parsed.pid,
        holder: parsed.holder === "security" ? "security" : "claudish",
        startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : mtime,
      };
    }
  } catch {
    // Unreadable: possibly a holder between creating the file and writing it.
  }
  return { pid: -1, holder: "claudish", startedAt: mtime };
}

/**
 * Whether a lock still guards a read: a pid that exists, within
 * {@link LOCK_MAX_AGE_MS} (pids are reused, and a reused one must not hold the
 * machine forever); an unreadable lock only while younger than
 * {@link UNREADABLE_LOCK_GRACE_MS}.
 */
function lockIsLive(lock: LockRecord): boolean {
  const age = deps.now() - lock.startedAt;
  if (lock.pid <= 0) return age < UNREADABLE_LOCK_GRACE_MS;
  return age < LOCK_MAX_AGE_MS && deps.isAlive(lock.pid);
}

/** Whether THIS process holds the lock file (between acquire and release). */
let holdsLock = false;

/**
 * A `dca:` token this process read from the Keychain whose `use` (the mint)
 * failed TRANSIENTLY after the user approved the dialog. Kept in memory only,
 * so the retry mints again without a second read and a second dialog. Dropped
 * on success and on a terminal failure (the login itself was rejected).
 */
let retainedToken: string | null = null;

type AcquireResult = "acquired" | "held" | { error: string };

function errorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code ?? (err as Error)?.message ?? String(err);
}

/**
 * Create the lock exclusively. `held` ONLY for EEXIST — another holder. Any
 * other failure (ENOSPC, EACCES, EROFS) is an error the caller reports: read
 * as "held", it made the loop retry forever.
 */
function tryAcquireLock(): AcquireResult {
  try {
    mkdirSync(deps.dir(), { recursive: true, mode: 0o700 });
  } catch (err) {
    return { error: errorCode(err) };
  }
  const record: LockRecord = { pid: deps.pid(), holder: "claudish", startedAt: deps.now() };
  try {
    writeFileSync(lockPath(), JSON.stringify(record), { flag: "wx", mode: 0o600 });
    holdsLock = true;
    return "acquired";
  } catch (err) {
    return errorCode(err) === "EEXIST" ? "held" : { error: errorCode(err) };
  }
}

function rewriteLock(pid: number, holder: LockRecord["holder"]): void {
  try {
    writeFileSync(lockPath(), JSON.stringify({ pid, holder, startedAt: deps.now() }), {
      mode: 0o600,
    });
  } catch {
    // The lock is advisory; a failed rewrite leaves the previous holder's pid.
  }
}

function releaseLock(): void {
  if (!holdsLock) return;
  holdsLock = false;
  rmSync(lockPath(), { force: true });
}

/**
 * Remove a stale lock only if it is still the one we judged stale: re-read
 * right before the `rm`, so a lock another process created before that re-read
 * is left alone. One created between the re-read and the `rm` is not; see the
 * module comment for that residual window and its cost.
 */
function removeStaleLock(seen: LockRecord): void {
  const now = readLock();
  if (now && now.pid === seen.pid && now.startedAt === seen.startedAt) {
    rmSync(lockPath(), { force: true });
  }
}

/** The borrowed copy's mtime, or 0 when there is none. */
function borrowedCopyStamp(): number {
  try {
    return statSync(museStorePath("borrowed-copy", deps.dir())).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Read the Muse login from the Keychain and hand its `dca:` token to `use`
 * (which mints, confirms and writes the borrowed copy) while this process still
 * holds the per-machine lock. Returns what the read produced.
 *
 * `deadlineMs` bounds THIS caller only; `security` is never killed. Every pass
 * of the loop that does not return awaits a short sleep and re-checks the
 * deadline, so it can neither spin nor outlive it.
 */
export async function withMuseKeychainLogin<T>(
  use: (accessToken: string) => Promise<T>,
  deadlineMs: number = MUSE_KEYCHAIN_READ_DEADLINE_MS
): Promise<MuseKeychainRead | { kind: "used"; value: T; source: "keychain" | "borrowed-copy" }> {
  if (disabled()) return { kind: "absent" };
  if (credentialPromptRole() === "never") return { kind: "not-allowed" };
  const deadline = deps.now() + deadlineMs;
  const pause = () => deps.sleep(Math.min(LOCK_POLL_MS, Math.max(0, deadline - deps.now())));

  for (;;) {
    // The approved token from a read whose mint failed transiently.
    if (retainedToken) return settleToken(retainedToken, use);
    // A value a previous, timed-out caller of THIS process left behind.
    if (lateResult) {
      const result = lateResult;
      lateResult = null;
      return settle(result, use);
    }
    if (inFlight) return raceJoin(inFlight, deadline, use);
    if (deps.now() >= deadline) return { kind: "timeout" };

    const lock = readLock();
    if (lock && lockIsLive(lock)) {
      if (lock.pid === deps.pid()) {
        // Our own pid. While we hold it, our read is settling: wait for it.
        // Without holding it, it is a reused pid or a leftover: stale for us.
        if (!holdsLock) removeStaleLock(lock);
        await pause();
        continue;
      }
      // Another process holds the dialog: wait for it, then take the copy it
      // WROTE during the wait. An older copy is the one that sent us here.
      const since = borrowedCopyStamp();
      const copy = await waitForLockThenCopy(deadline, since);
      if (copy === "timeout") return { kind: "timeout" };
      if (copy) return { kind: "used", value: await use(copy), source: "borrowed-copy" };
      await pause();
      continue; // cleared with no new copy: read for ourselves (the role allows it)
    }
    if (lock) removeStaleLock(lock);

    const acquired = tryAcquireLock();
    if (acquired === "held") {
      await pause(); // lost the race to another process
      continue;
    }
    if (acquired !== "acquired") {
      return {
        kind: "failed",
        detail: `could not create the Keychain read lock in ${deps.dir()} (${acquired.error})`,
      };
    }

    const spawn = deps.startRead(query());
    if (spawn.pid !== undefined) rewriteLock(spawn.pid, "security");
    const done = spawn.done.finally(() => {
      rewriteLock(deps.pid(), "claudish");
    });
    inFlight = done;
    inFlightEpoch = keychainEpoch;
    return raceJoin(done, deadline, use);
  }
}

/** Join an outstanding read, bounded by this caller's deadline; never kills it. */
async function raceJoin<T>(
  done: Promise<GenericPasswordResult>,
  deadline: number,
  use: (accessToken: string) => Promise<T>
): Promise<MuseKeychainRead | { kind: "used"; value: T; source: "keychain" | "borrowed-copy" }> {
  const remaining = Math.max(0, deadline - deps.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), remaining);
  });
  const winner = await Promise.race([done, timedOut]);
  if (timer) clearTimeout(timer);
  if (winner === "timeout") {
    // `security` keeps running. When it answers, keep the answer for the next
    // caller in this process and free the machine-wide lock.
    const startedIn = inFlightEpoch;
    void done.then((result) => {
      if (inFlight === done) inFlight = null;
      // An answer approved after a reset (a logout) is dropped, not kept.
      if (startedIn === keychainEpoch) lateResult = result;
      releaseLock();
    });
    return { kind: "timeout" };
  }
  if (inFlight === done) inFlight = null;
  try {
    return await settle(winner, use);
  } finally {
    releaseLock();
  }
}

async function settle<T>(
  result: GenericPasswordResult,
  use: (accessToken: string) => Promise<T>
): Promise<MuseKeychainRead | { kind: "used"; value: T; source: "keychain" }> {
  if (result.kind === "absent") return { kind: "absent" };
  if (result.kind === "failed") return { kind: "failed", detail: result.error };
  const token = result.value ? parseMuseKeychainValue(result.value) : null;
  if (!token)
    return { kind: "failed", detail: "the Muse Code login item has no readable access token" };
  return settleToken(token, use);
}

/** Hand a read token to `use`, keeping it in memory if `use` fails transiently. */
async function settleToken<T>(
  token: string,
  use: (accessToken: string) => Promise<T>
): Promise<{ kind: "used"; value: T; source: "keychain" }> {
  // Held only AFTER a failure: holding it while `use` runs would hand it to a
  // second in-process caller, which would then mint in parallel.
  if (retainedToken === token) retainedToken = null;
  const startedIn = keychainEpoch;
  try {
    const value = await use(token);
    return { kind: "used", value, source: "keychain" };
  } catch (err) {
    // A rejected login will not get better on retry; anything else keeps the
    // approved token so the retry needs no second dialog — unless a reset (a
    // logout) happened while `use` ran, in which case the token is dropped.
    if ((err as { terminal?: unknown })?.terminal !== true && startedIn === keychainEpoch) {
      retainedToken = token;
    }
    throw err;
  }
}

/**
 * Wait until another process's lock clears, then read the borrowed copy it
 * wrote — only one written after `sinceMtime`. `null` when the lock cleared with
 * no new copy; `"timeout"` past the deadline.
 */
async function waitForLockThenCopy(
  deadline: number,
  sinceMtime: number
): Promise<string | null | "timeout"> {
  for (;;) {
    const lock = readLock();
    if (!lock || !lockIsLive(lock)) {
      if (borrowedCopyStamp() <= sinceMtime) return null;
      const copy = readMuseStore("borrowed-copy", deps.dir());
      return copy ? copy.access_token : null;
    }
    if (deps.now() >= deadline) return "timeout";
    await deps.sleep(Math.min(LOCK_POLL_MS, Math.max(0, deadline - deps.now())));
  }
}
