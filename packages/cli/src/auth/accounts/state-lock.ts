/**
 * `state.lock` — the OTHER lock, with deliberately different failure semantics
 * from the refresh gate.
 *
 * `~/.claudish/accounts/state.lock`, guarding the field-wise read-modify-write
 * of `~/.claudish/accounts/state.json`.
 *
 * | Property | Value |
 * |---|---|
 * | Acquire timeout | 2 s — a state write is read, merge, rename |
 * | Stale TTL | 10 s, same-host steal only |
 * | Heartbeat | none: the hold is milliseconds, and the 10 s TTL already covers it |
 *
 * ## Why failing differs from the gate, and why that is not an inconsistency
 *
 * Failing a user's turn because an EXHAUSTION MARK could not be persisted is
 * worse than the mark being late. Failing a REFRESH because the gate could not
 * be taken is better than two refreshes. So:
 *
 *   - a COALESCIBLE update (sub-threshold usage movement) that cannot take the
 *     lock is dropped SILENTLY;
 *   - a SELECTION-RELEVANT update (threshold crossing, exhaustion, needsReauth,
 *     active, owner, handoff) that cannot take the lock is dropped LOUDLY: it is
 *     logged, surfaced in `account status` as "state not persisted — <field> for
 *     <account>", and the request continues. The in-memory value is still used
 *     for this process's own selection.
 *
 * Neither case runs the write unlocked: a whole-document rename built on a
 * snapshot taken outside the lock is how a concurrent exhaustion mark gets
 * erased.
 *
 * ## Lock order
 *
 * `state.lock` is ALWAYS innermost and is NEVER held across an account-gate
 * acquisition. The refresh path takes the gate, does its work, releases the
 * gate, then takes `state.lock`. Because the two are never held in the other
 * order there is no deadlock to bound.
 */

import { log } from "../../logger.js";
import {
  type FileLockOptions,
  FileLockUnavailableError,
  type LockHandle,
  acquireFileLock,
} from "./file-lock.js";
import { stateLockFilePath } from "./paths.js";

/** Short, because the critical section is short. One retry fits inside it. */
export const STATE_LOCK_TIMEOUT_MS = 2_000;
export const STATE_LOCK_STALE_MS = 10_000;

/**
 * `~/.claudish/accounts/state.lock`. Delegates to `paths.ts`, the one authority
 * for account paths, so `CLAUDISH_ACCOUNTS_DIR` moves this lock with the state
 * file it guards.
 */
export function stateLockPath(): string {
  return stateLockFilePath();
}

export interface StateLockOptions {
  deps?: FileLockOptions["deps"];
  /** Override the path (tests point it at a temp HOME). */
  path?: string;
}

/**
 * Run `work` under `state.lock`, or return `null` when the lock could not be
 * taken within 2 s.
 *
 * `null` — rather than a throw — is the signal the caller needs, because the
 * decision of whether a dropped update is silent or loud belongs to the FIELD
 * being written, and only the caller knows which field that is.
 */
export async function withStateLock<T>(
  work: (handle: LockHandle) => Promise<T>,
  opts: StateLockOptions = {}
): Promise<T | null> {
  const path = opts.path ?? stateLockPath();
  let handle: LockHandle;
  try {
    handle = await acquireFileLock(path, {
      timeoutMs: STATE_LOCK_TIMEOUT_MS,
      pollMs: 25,
      staleMs: STATE_LOCK_STALE_MS,
      // No heartbeat: the hold is milliseconds and the TTL is 10 s.
      heartbeatMs: 0,
      ...(opts.deps ? { deps: opts.deps } : {}),
      log,
    });
  } catch (err) {
    if (err instanceof FileLockUnavailableError) {
      log(`[StateLock] not acquired (${err.reason}) — the caller decides whether to drop loudly`);
      return null;
    }
    throw err;
  }
  try {
    return await work(handle);
  } finally {
    handle.release();
  }
}
