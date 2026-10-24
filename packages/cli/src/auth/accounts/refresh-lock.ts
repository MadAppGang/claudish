/**
 * The refresh GATE — one token exchange per account, across processes.
 *
 * `~/.claudish/accounts/locks/<provider>/<accountId>.lock`, provider-namespaced
 * so two vendors' account ids can never collide.
 *
 * | Property | Value | Why |
 * |---|---|---|
 * | Acquire timeout | 20 s | long enough to outwait a real exchange, short enough to fail a turn rather than hang it |
 * | Heartbeat | 10 s, for the WHOLE hold | a holder doing slow work is never mistaken for a wedged one |
 * | Stale TTL | 60 s | six missed heartbeats; with the heartbeat covering the whole hold, a live holder is never stale |
 * | Dead holder | stolen immediately (same host, `kill(pid,0)` → ESRCH) | waiting 60 s behind a crashed process is pure latency |
 * | Foreign host | never stolen, never waited out | a remote holder's liveness is unobservable |
 *
 * **It never degrades to unlocked, and there is no bypass env var.**
 * `CLAUDISH_NO_OP_HANDSHAKE_LOCK` is scoped to 1Password and is NOT read here:
 * an unlocked refresh is two exchanges against a rotating server, i.e. an
 * `invalid_grant` and a logged-out account. Anything other than `EEXIST` from
 * `mkdir`/`open` DISABLES refresh and is surfaced in `account status` as
 * "refresh disabled: <reason>".
 *
 * What a caller does when acquisition fails is specified by the design and is
 * NOT this module's business: re-read the token store uncached, and if the
 * generation advanced past the value it started with, the holder persisted while
 * it waited — use that token. Only otherwise does it raise the transient,
 * no-quota-wording refresh error.
 */

import { log } from "../../logger.js";
import {
  type FileLockOptions,
  FileLockUnavailableError,
  type LockHandle,
  acquireFileLock,
} from "./file-lock.js";
import { accountLockPath } from "./paths.js";

/** 20 s, polled at 50 ms + jitter. */
export const GATE_TIMEOUT_MS = 20_000;
/** Rewritten every 10 s for the entire hold, not only during an exchange. */
export const GATE_HEARTBEAT_MS = 10_000;
/** Six missed heartbeats. */
export const GATE_STALE_MS = 60_000;

/**
 * `~/.claudish/accounts/locks/<provider>/<accountId>.lock`.
 *
 * Delegates to `paths.ts`, the one authority for account paths: it honours
 * `CLAUDISH_ACCOUNTS_DIR` and refuses a provider or id that is not safe to
 * interpolate (throws `UnsafeAccountPathError`).
 */
export function refreshLockPath(provider: string, accountId: string): string {
  return accountLockPath(provider, accountId);
}

export interface AcquireGateOptions {
  /** Generation the caller read before queueing, stamped for diagnostics. */
  gen?: number;
  /** Seams: clock, hostname, liveness, sleep. */
  deps?: FileLockOptions["deps"];
  /** Override the whole path (tests point it at a temp HOME). */
  path?: string;
}

/**
 * Take the gate for one account, or throw {@link FileLockUnavailableError}.
 *
 * The handle carries `holdsLock()` — the FENCE. Call it immediately before the
 * durable persist: a holder that was suspended past the stale TTL and stolen
 * from must not write, and the fence is what stops it.
 */
export async function acquireRefreshGate(
  provider: string,
  accountId: string,
  opts: AcquireGateOptions = {}
): Promise<LockHandle> {
  return acquireFileLock(opts.path ?? refreshLockPath(provider, accountId), {
    timeoutMs: GATE_TIMEOUT_MS,
    pollMs: 50,
    staleMs: GATE_STALE_MS,
    heartbeatMs: GATE_HEARTBEAT_MS,
    ...(opts.gen === undefined ? {} : { gen: opts.gen }),
    ...(opts.deps ? { deps: opts.deps } : {}),
    log,
  });
}

/**
 * Run `work` under the gate. Rethrows {@link FileLockUnavailableError} — this
 * helper has no "proceed unlocked" mode at all, by construction rather than by
 * default.
 */
export async function withRefreshGate<T>(
  provider: string,
  accountId: string,
  work: (handle: LockHandle) => Promise<T>,
  opts: AcquireGateOptions = {}
): Promise<T> {
  const handle = await acquireRefreshGate(provider, accountId, opts);
  try {
    return await work(handle);
  } finally {
    handle.release();
  }
}

/** Is this error the gate reporting that it could not be taken? */
export function isGateUnavailable(err: unknown): err is FileLockUnavailableError {
  return err instanceof FileLockUnavailableError;
}
