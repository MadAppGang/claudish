/**
 * A cross-process advisory file lock: `O_EXCL` acquire, ownership nonce,
 * heartbeat, dead-holder detection, identity-checked steal, fenced release.
 *
 * ## Why this exists next to `providers/onepassword-handshake-lock.ts`
 *
 * That module's lock and this one want OPPOSITE failure semantics, and the
 * difference is the whole point:
 *
 *   - the 1Password handshake lock is "an OPTIMISATION OF WHEN, not a gate on
 *     WHETHER" — on timeout or any filesystem error it runs the work UNLOCKED,
 *     because a desktop handshake that is merely badly timed is better than a
 *     secret that cannot be resolved at all;
 *   - a token REFRESH that proceeds unlocked is two exchanges against a server
 *     that rotates refresh tokens, i.e. the second presenter gets
 *     `invalid_grant` and an account is logged out. Failing the request is
 *     strictly better.
 *
 * So the acquire-failure behaviour is the CALLER's choice, expressed as
 * `onUnavailable: "proceed" | "fail"` on {@link withFileLock}, and neither
 * caller can inherit the other's default by accident. `refresh-lock.ts` chooses
 * `fail`; `state-lock.ts` chooses `fail` and its caller then DROPS the update
 * rather than failing the turn (a late exhaustion mark beats a failed turn).
 *
 * The 1Password lock is deliberately NOT re-based on this helper: it also
 * carries `lastHandshake`, `isAbandoned` and `peerHoldsHandshakeLock` — the
 * fourth 1Password denial cause — and its `CLAUDISH_NO_OP_HANDSHAKE_LOCK`
 * bypass, none of which belong to a renewable lease. See
 * ai-docs/architecture/accounts.md, decision 6.
 *
 * ## Ownership is a NONCE, not a pid
 *
 * The op lock releases on `pid` alone, which is sound for a single-machine
 * desktop handshake and NOT sound for a lease that can be stolen: two hosts
 * sharing a HOME can hold the same pid, and a paused holder can resume after a
 * steal and remove its successor's lock. Here every holder writes 16 random
 * bytes, release compares `{host, pid, nonce}`, and {@link LockHandle.holdsLock}
 * is the FENCE a caller checks immediately before the write that matters.
 *
 * ## A steal is atomic with respect to WHO is being stolen from
 *
 * "Read the holder, judge it dead, `rm` the path" is not a steal, it is a race:
 * two waiters that read the same stale holder both `rm`, and the second `rm`
 * deletes the lock the first waiter has just created. Both then believe they
 * hold it. So a steal RENAMES the lock file to a unique tombstone (atomic), then
 * checks that the tombstone is the very record it judged — same nonce, pid,
 * host and heartbeat — before discarding it. If it is anything else, the waiter
 * moved a live lock by mistake and puts it back with `link` (which, unlike
 * `rename`, refuses to overwrite a lock a third party created meanwhile).
 * Release uses the same move-verify-discard sequence, so it cannot delete a
 * successor's lock either.
 *
 * ## The lock file is never empty on purpose
 *
 * A crash between `O_EXCL` create and the holder write, or a write that fails
 * (`ENOSPC`, `EIO`), leaves an empty file. `readHolder` returns `null` for it,
 * and a holder that cannot be read used to be "a live acquirer mid-write; never
 * steal" — so the lock was dead forever. Now: a failed holder write unlinks the
 * file it created, and an UNREADABLE record is stealable once the file's own
 * mtime is older than the stale TTL (a live acquirer finishes its write in
 * microseconds, so an old unreadable file is debris).
 *
 * The heartbeat never truncates. It rewrites the record in place through the
 * descriptor the acquire opened, padded to a fixed width, so there is no
 * truncate-then-write window in which the file is empty. Writing through the
 * DESCRIPTOR rather than the path is also what keeps it safe after a steal: the
 * descriptor names the holder's own inode, so a late heartbeat lands on the
 * orphaned file and can never overwrite a successor's lock. (Write-temp-and-
 * rename would give a torn-free file too, but `rename` replaces whatever is at
 * the path — including a successor's lock — so it trades an empty-file window
 * for a clobbered-successor window.)
 *
 * ## Cross-host stealing never happens
 *
 * A remote holder's liveness is unobservable, so any TTL is a guess. When the
 * lock file's `host` differs from ours we wait out the timeout and fail. Shared
 * HOME across hosts is therefore not supported for the account pool, which is
 * the honest position rather than a claim of exactly-once that would not be
 * true.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

/** What a lock file contains. Small, JSON, rewritten by the heartbeat. */
export interface LockHolder {
  pid: number;
  host: string;
  nonce: string;
  /** Last heartbeat, ms since epoch. */
  at: number;
  /** Optional generation the holder read before taking the lock. */
  gen?: number;
}

export interface FileLockDeps {
  now(): number;
  hostname(): string;
  /** `kill(pid, 0)` — false means the process is provably gone. */
  isProcessAlive(pid: number): boolean;
  /** Injected so a test can advance time without waiting. */
  sleep(ms: number): Promise<void>;
}

export interface FileLockOptions {
  /** How long to wait for the lock before giving up. */
  timeoutMs: number;
  /** Poll interval; jitter of the same magnitude is added. */
  pollMs?: number;
  /**
   * A holder whose `at` is older than this is stale and may be stolen (same host
   * only). An UNREADABLE record is stealable once the file's mtime is this old.
   */
  staleMs: number;
  /** Rewrite `at` this often for the WHOLE time the lock is held. 0 disables. */
  heartbeatMs?: number;
  /** Generation stamped into the holder record, for diagnostics. */
  gen?: number;
  /** Seams — every one of them defaulted, so production passes nothing. */
  deps?: Partial<FileLockDeps>;
  /** Diagnostics. */
  log?: (message: string) => void;
}

const defaultDeps: FileLockDeps = {
  now: () => Date.now(),
  hostname: () => hostname(),
  isProcessAlive: (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means it exists and is not ours to signal — alive.
      return (err as NodeJS.ErrnoException)?.code === "EPERM";
    }
  },
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Holder records are padded to this width, so the heartbeat can rewrite one in
 * place with a single positional write and never has to shrink (truncate) the
 * file. A record that is somehow longer is written whole; the file only grows.
 */
export const LOCK_RECORD_WIDTH = 256;

/** Why an acquire failed. Carried on the error so a caller can word its message. */
export type LockUnavailableReason =
  /** The acquire timeout elapsed with a live holder in place. */
  | "timeout"
  /** A holder on ANOTHER host — never stolen, never waited out. */
  | "foreign-host"
  /** The lock directory or file could not be created (permissions, read-only HOME). */
  | "unwritable";

export class FileLockUnavailableError extends Error {
  readonly reason: LockUnavailableReason;
  readonly path: string;
  constructor(path: string, reason: LockUnavailableReason, detail?: string) {
    super(`could not acquire ${path}: ${reason}${detail ? ` (${detail})` : ""}`);
    this.name = "FileLockUnavailableError";
    this.reason = reason;
    this.path = path;
  }
}

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

/** `{…json…}   \n`, padded to `width` bytes. */
function encodeHolder(holder: LockHolder, width: number): Buffer {
  const json = JSON.stringify(holder);
  const line = json.length + 1 >= width ? `${json}\n` : `${json.padEnd(width - 1, " ")}\n`;
  return Buffer.from(line, "utf8");
}

function sameIdentity(
  a: Pick<LockHolder, "pid" | "host" | "nonce"> | null,
  b: Pick<LockHolder, "pid" | "host" | "nonce">
): boolean {
  return a !== null && a.nonce === b.nonce && a.pid === b.pid && a.host === b.host;
}

/** A unique sibling name for a moved-aside lock. Same directory, so `rename` is atomic. */
function tombstoneFor(path: string, tag: string): string {
  return `${path}.${tag}-${process.pid}-${randomBytes(6).toString("hex")}`;
}

/**
 * Put a lock we moved aside by mistake back where it was, without overwriting a
 * lock someone created in the meantime (`link` fails with `EEXIST` where
 * `rename` would silently replace). Then drop the tombstone name.
 */
function restoreTombstone(tombstone: string, path: string): void {
  try {
    linkSync(tombstone, path);
  } catch {
    // EEXIST: a third party holds the path now. The owner we displaced is
    // fenced out by `holdsLock()`, which is what keeps this safe.
  }
  rmSync(tombstone, { force: true });
}

/** A held lock. Release is idempotent and never frees someone else's lock. */
export class LockHandle {
  readonly path: string;
  readonly nonce: string;
  readonly pid: number;
  readonly host: string;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private released = false;
  private readonly deps: FileLockDeps;
  private readonly gen: number | undefined;
  /** The descriptor of OUR inode, kept for the whole hold — see the header. */
  private fd: number | null;
  private width: number;

  constructor(
    path: string,
    nonce: string,
    deps: FileLockDeps,
    gen?: number,
    fd: number | null = null,
    width: number = LOCK_RECORD_WIDTH
  ) {
    this.path = path;
    this.nonce = nonce;
    this.pid = process.pid;
    this.host = deps.hostname();
    this.deps = deps;
    this.gen = gen;
    this.fd = fd;
    this.width = width;
  }

  /**
   * The FENCE. Re-reads the lock file and answers whether `{host, pid, nonce}`
   * still names us.
   *
   * Called immediately before the write that matters. A holder that was stolen
   * from — because it was suspended past the stale TTL — must not persist, and
   * this is the check that stops it. A read failure answers `false`: unknown
   * ownership resolves to "do not write".
   */
  holdsLock(): boolean {
    if (this.released) return false;
    return sameIdentity(readHolder(this.path), this);
  }

  /** Start rewriting `at` every `intervalMs`, on an `unref`'d timer. */
  startHeartbeat(intervalMs: number): void {
    if (intervalMs <= 0 || this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      // Only OUR record may be refreshed — a stolen lock must be allowed to go
      // stale under its new owner rather than be kept warm by the old one.
      if (!this.holdsLock()) return;
      try {
        this.rewrite();
      } catch {
        /* a failed heartbeat just lets the lock age */
      }
    }, intervalMs);
    this.heartbeat.unref?.();
  }

  /**
   * Rewrite the record in place through OUR descriptor: one positional write of
   * a fixed-width record, no truncate, so the file is never empty and never
   * someone else's.
   */
  private rewrite(): void {
    if (this.fd === null) return;
    const bytes = encodeHolder(
      {
        pid: this.pid,
        host: this.host,
        nonce: this.nonce,
        at: this.deps.now(),
        ...(this.gen === undefined ? {} : { gen: this.gen }),
      },
      this.width
    );
    writeSync(this.fd, bytes, 0, bytes.length, 0);
    this.width = Math.max(this.width, bytes.length);
  }

  /** Drop the lock if — and only if — we still own it. Idempotent. */
  release(): void {
    if (this.released) return;
    this.released = true;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    try {
      if (sameIdentity(readHolder(this.path), this)) removeIfStillOurs(this.path, this);
    } catch {
      /* already gone, or unreadable — nothing safe left to do */
    } finally {
      if (this.fd !== null) {
        try {
          closeSync(this.fd);
        } catch {
          /* already closed */
        }
        this.fd = null;
      }
    }
  }
}

/**
 * Move the lock aside, and discard it only if what moved is still ours; a
 * successor's lock that slipped in between the check and the move is put back.
 */
function removeIfStillOurs(path: string, identity: Pick<LockHolder, "pid" | "host" | "nonce">) {
  const tombstone = tombstoneFor(path, "release");
  try {
    renameSync(path, tombstone);
  } catch {
    return;
  }
  if (sameIdentity(readHolder(tombstone), identity)) rmSync(tombstone, { force: true });
  else restoreTombstone(tombstone, path);
}

/** Read a holder record, or null when the file is absent or unparseable. */
export function readHolder(path: string): LockHolder | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockHolder>;
    if (typeof parsed?.pid !== "number" || typeof parsed?.nonce !== "string") return null;
    return {
      pid: parsed.pid,
      host: String(parsed.host ?? ""),
      nonce: parsed.nonce,
      at: typeof parsed.at === "number" ? parsed.at : 0,
      ...(typeof parsed.gen === "number" ? { gen: parsed.gen } : {}),
    };
  } catch {
    return null;
  }
}

/** A file's identity, for judging an unreadable lock by its inode and age. */
interface LockStamp {
  ino: number;
  dev: number;
  size: number;
  mtimeMs: number;
}

function lockStamp(path: string): LockStamp | null {
  try {
    const st = lstatSync(path);
    return { ino: st.ino, dev: st.dev, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function sameStamp(a: LockStamp | null, b: LockStamp): boolean {
  return (
    a !== null && a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs
  );
}

/** What is at the lock path right now. */
type Inspection =
  | { kind: "absent" }
  | { kind: "holder"; holder: LockHolder }
  | { kind: "unreadable"; stamp: LockStamp };

function inspectLock(path: string): Inspection {
  const stamp = lockStamp(path);
  if (!stamp) return { kind: "absent" };
  const holder = readHolder(path);
  return holder ? { kind: "holder", holder } : { kind: "unreadable", stamp };
}

/**
 * Steal the lock ONLY IF it is still exactly the one we judged dead or stale.
 *
 * - `"stolen"` — the judged lock is gone; retry the create.
 * - `"gone"` — someone else already moved it; retry the create.
 * - `"restored"` — we moved a DIFFERENT lock (a successor, or a holder that
 *   heartbeat in between); it is back; wait behind it.
 * - `"failed"` — the rename itself failed; wait and re-judge.
 */
function stealIfUnchanged(
  path: string,
  judged: Exclude<Inspection, { kind: "absent" }>
): "stolen" | "gone" | "restored" | "failed" {
  const tombstone = tombstoneFor(path, "stale");
  try {
    renameSync(path, tombstone);
  } catch (err) {
    return errno(err) === "ENOENT" ? "gone" : "failed";
  }
  const unchanged =
    judged.kind === "holder"
      ? (() => {
          const moved = readHolder(tombstone);
          return sameIdentity(moved, judged.holder) && moved?.at === judged.holder.at;
        })()
      : sameStamp(lockStamp(tombstone), judged.stamp);
  if (unchanged) {
    rmSync(tombstone, { force: true });
    return "stolen";
  }
  restoreTombstone(tombstone, path);
  return "restored";
}

/**
 * `O_EXCL` create and write the holder record, or `null` when the lock exists.
 *
 * A write that fails after the create UNLINKS the file it created — checked by
 * inode, so it can only ever remove its own — and reports `unwritable`: an
 * empty lock file left behind is a lock nobody can take.
 */
function tryCreate(path: string, bytes: Buffer): number | null {
  let fd: number;
  try {
    // "wx" = O_CREAT | O_EXCL: succeeds for exactly one process.
    fd = openSync(path, "wx", 0o600);
  } catch (err) {
    if (errno(err) === "EEXIST") return null;
    // Anything other than "someone holds it" is an environment failure.
    // It NEVER degrades to unlocked — see the header.
    throw new FileLockUnavailableError(path, "unwritable", (err as Error)?.message);
  }
  try {
    writeSync(fd, bytes, 0, bytes.length, 0);
    return fd;
  } catch (err) {
    try {
      const mine = fstatSync(fd);
      const there = lstatSync(path);
      if (mine.ino === there.ino && mine.dev === there.dev) rmSync(path, { force: true });
    } catch {
      /* nothing of ours left at the path */
    }
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    throw new FileLockUnavailableError(
      path,
      "unwritable",
      `holder record not written: ${(err as Error)?.message}`
    );
  }
}

/**
 * Take the lock, or throw {@link FileLockUnavailableError}.
 *
 * NEVER degrades to unlocked. A caller that wants the 1Password lock's
 * fail-open behaviour asks for it explicitly through {@link withFileLock}'s
 * `onUnavailable: "proceed"`.
 */
function prepareAcquire(path: string, opts: FileLockOptions): FileLockDeps {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new FileLockUnavailableError(path, "unwritable", (err as Error)?.message);
  }
  return { ...defaultDeps, ...(opts.deps ?? {}) };
}

type AcquireAttempt = { handle: LockHandle } | { retryNow: boolean; detail: string };

/** One shared O_EXCL/inspection/identity-checked steal protocol for both APIs. */
function attemptAcquire(
  path: string,
  opts: FileLockOptions,
  deps: FileLockDeps,
  nonce: string
): AcquireAttempt {
  const host = deps.hostname();
  const bytes = encodeHolder(
    {
      pid: process.pid,
      host,
      nonce,
      at: deps.now(),
      ...(opts.gen === undefined ? {} : { gen: opts.gen }),
    },
    LOCK_RECORD_WIDTH
  );
  const fd = tryCreate(path, bytes);
  if (fd !== null) {
    const handle = new LockHandle(
      path,
      nonce,
      deps,
      opts.gen,
      fd,
      Math.max(LOCK_RECORD_WIDTH, bytes.length)
    );
    handle.startHeartbeat(opts.heartbeatMs ?? 0);
    return { handle };
  }
  const seen = inspectLock(path);
  let retryNow = seen.kind === "absent";
  if (seen.kind === "holder") {
    if (seen.holder.host !== host) {
      throw new FileLockUnavailableError(
        path,
        "foreign-host",
        `held by pid ${seen.holder.pid} on ${seen.holder.host}`
      );
    }
    const dead = !deps.isProcessAlive(seen.holder.pid);
    const stale = deps.now() - seen.holder.at > opts.staleMs;
    if (dead || stale) {
      const outcome = stealIfUnchanged(path, seen);
      opts.log?.(
        `[FileLock] steal of ${path} from pid ${seen.holder.pid} (${dead ? "dead" : "stale"}): ${outcome}`
      );
      retryNow = outcome === "stolen" || outcome === "gone";
    }
  } else if (seen.kind === "unreadable" && deps.now() - seen.stamp.mtimeMs > opts.staleMs) {
    const outcome = stealIfUnchanged(path, seen);
    opts.log?.(`[FileLock] steal of ${path} (unreadable holder record, old mtime): ${outcome}`);
    retryNow = outcome === "stolen" || outcome === "gone";
  }
  return {
    retryNow,
    detail: seen.kind === "holder" ? `held by pid ${seen.holder.pid}` : "holder record unreadable",
  };
}

export async function acquireFileLock(path: string, opts: FileLockOptions): Promise<LockHandle> {
  const deps = prepareAcquire(path, opts);
  const nonce = randomBytes(16).toString("hex");
  const pollMs = opts.pollMs ?? 50;
  const deadline = deps.now() + opts.timeoutMs;
  let immediate = 0;
  for (;;) {
    const attempt = attemptAcquire(path, opts, deps, nonce);
    if ("handle" in attempt) return attempt.handle;
    if (attempt.retryNow && immediate < 3) {
      immediate++;
      continue;
    }
    immediate = 0;
    if (deps.now() >= deadline) throw new FileLockUnavailableError(path, "timeout", attempt.detail);
    await deps.sleep(pollMs + Math.floor(Math.random() * pollMs));
  }
}

/** Non-waiting, fail-closed entry point for short synchronous config commits. */
export function acquireFileLockSync(
  path: string,
  opts: Omit<FileLockOptions, "timeoutMs" | "pollMs" | "heartbeatMs"> & {
    /**
     * Bounded wait for a live holder, in ms (default 0: give up at once). The
     * thread SLEEPS between attempts (`Atomics.wait`), so keep it short — the
     * event loop is blocked for the whole wait.
     */
    waitMs?: number;
  }
): LockHandle {
  const { waitMs = 0, ...rest } = opts;
  const options: FileLockOptions = { ...rest, timeoutMs: 0, heartbeatMs: 0 };
  const deps = prepareAcquire(path, options);
  const nonce = randomBytes(16).toString("hex");
  const deadline = Date.now() + waitMs;
  for (let immediate = 0; ; ) {
    const attempt = attemptAcquire(path, options, deps, nonce);
    if ("handle" in attempt) return attempt.handle;
    if (attempt.retryNow && immediate < 3) {
      immediate++;
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new FileLockUnavailableError(path, "timeout", attempt.detail);
    sleepSync(Math.min(SYNC_LOCK_POLL_MS, remaining));
    immediate = 0;
  }
}

const SYNC_LOCK_POLL_MS = 25;

/** Block this thread for `ms`; the sync lock's only way to wait for a holder. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface WithFileLockOptions extends FileLockOptions {
  /**
   * What to do when the lock cannot be taken.
   *
   * - `"fail"` (the token-refresh gate): rethrow the
   *   {@link FileLockUnavailableError}. The caller NEVER runs the work unlocked.
   * - `"proceed"` (the 1Password-handshake semantics): run the work anyway, with
   *   `held: false`. The lock was an optimisation of WHEN, not a gate on
   *   WHETHER.
   *
   * There is no default. Choosing it silently is exactly the mistake that
   * copying the nearest precedent produces.
   */
  onUnavailable: "fail" | "proceed";
}

/**
 * Run `work` under the lock. The handle is passed so the work can fence itself
 * immediately before its durable write.
 */
export async function withFileLock<T>(
  path: string,
  opts: WithFileLockOptions,
  work: (handle: LockHandle | null) => Promise<T>
): Promise<T> {
  let handle: LockHandle | null = null;
  try {
    handle = await acquireFileLock(path, opts);
  } catch (err) {
    if (opts.onUnavailable === "fail") throw err;
    opts.log?.(`[FileLock] proceeding unlocked: ${(err as Error)?.message}`);
    handle = null;
  }
  try {
    return await work(handle);
  } finally {
    handle?.release();
  }
}
