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
 *   holder wrote. When the lock clears and no copy appeared (the holder was
 *   denied, or its mint failed), it reads for itself — if its role allows.
 * - A lock whose pid is dead is removed and the read proceeds.
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
import { defaultMuseStoreDir, readMuseStore } from "./muse-store.js";

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

/** Replace the side-effect seam; `null` restores the real one. */
export function setMuseKeychainTestDeps(next: Partial<MuseKeychainDeps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
  presenceMemo = null;
  inFlight = null;
  lateResult = null;
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

/** Create the lock exclusively. False when another process holds it. */
function tryAcquireLock(): boolean {
  mkdirSync(deps.dir(), { recursive: true, mode: 0o700 });
  const record: LockRecord = { pid: deps.pid(), holder: "claudish", startedAt: deps.now() };
  try {
    writeFileSync(lockPath(), JSON.stringify(record), { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
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
  const lock = readLock();
  // Only our own lock: never remove one a later holder created.
  if (lock && (lock.pid === deps.pid() || !lockIsLive(lock))) rmSync(lockPath(), { force: true });
}

/**
 * Read the Muse login from the Keychain and hand its `dca:` token to `use`
 * (which mints, confirms and writes the borrowed copy) while this process still
 * holds the per-machine lock. Returns what the read produced.
 *
 * `deadlineMs` bounds THIS caller only; `security` is never killed.
 */
export async function withMuseKeychainLogin<T>(
  use: (accessToken: string) => Promise<T>,
  deadlineMs: number = MUSE_KEYCHAIN_READ_DEADLINE_MS
): Promise<MuseKeychainRead | { kind: "used"; value: T; source: "keychain" | "borrowed-copy" }> {
  if (disabled()) return { kind: "absent" };
  if (credentialPromptRole() === "never") return { kind: "not-allowed" };
  const deadline = deps.now() + deadlineMs;

  for (;;) {
    // A value a previous, timed-out caller of THIS process left behind.
    if (lateResult) {
      const result = lateResult;
      lateResult = null;
      return settle(result, use);
    }
    if (inFlight) return raceJoin(inFlight, deadline, use);

    const lock = readLock();
    if (lock && lockIsLive(lock) && lock.pid !== deps.pid()) {
      // Another process holds the dialog: wait for it, then take its copy.
      const copy = await waitForLockThenCopy(deadline);
      if (copy === "timeout") return { kind: "timeout" };
      if (copy) return { kind: "used", value: await use(copy), source: "borrowed-copy" };
      continue; // cleared with no copy: read for ourselves (role already allows it)
    }
    if (lock && !lockIsLive(lock)) rmSync(lockPath(), { force: true });
    if (!tryAcquireLock()) continue; // lost the race to another process

    const spawn = deps.startRead(query());
    if (spawn.pid !== undefined) rewriteLock(spawn.pid, "security");
    const done = spawn.done.finally(() => {
      rewriteLock(deps.pid(), "claudish");
    });
    inFlight = done;
    const outcome = await raceJoin(done, deadline, use);
    return outcome;
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
    void done.then((result) => {
      if (inFlight === done) {
        inFlight = null;
        lateResult = result;
        releaseLock();
      }
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
  return { kind: "used", value: await use(token), source: "keychain" };
}

/**
 * Wait until another process's lock clears, then read the borrowed copy it
 * wrote. `null` when the lock cleared with no copy; `"timeout"` past the deadline.
 */
async function waitForLockThenCopy(deadline: number): Promise<string | null | "timeout"> {
  for (;;) {
    const lock = readLock();
    if (!lock || !lockIsLive(lock)) {
      const copy = readMuseStore("borrowed-copy", deps.dir());
      return copy ? copy.access_token : null;
    }
    if (deps.now() >= deadline) return "timeout";
    await deps.sleep(Math.min(LOCK_POLL_MS, Math.max(0, deadline - deps.now())));
  }
}
