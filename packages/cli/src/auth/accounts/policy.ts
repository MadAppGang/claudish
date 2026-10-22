/**
 * Selection policy. **Pure**: no I/O, no imports that do I/O, and no clock of its
 * own — `now` is a parameter, because a policy that reads `Date.now()` cannot be
 * tested at a window boundary without sleeping through it.
 *
 * ## The order, and why each step is where it is
 *
 * 1. **A pin wins.** `acquire({pin})` is the 401 forced re-sign of the SAME
 *    account; honouring anything else there would re-sign a different account and
 *    the retry would prove nothing.
 * 2. **The active account, if eligible and under threshold.** Stickiness is not a
 *    preference — the prompt cache belongs to one account, so every switch costs
 *    a cache rebuild.
 * 3. **The first account under threshold, in CONFIG order.** Config order is the
 *    user's own stated preference and is stable across processes, which two
 *    concurrent sessions need in order to agree.
 * 4. **The lowest-pressure eligible account.** Everything is over threshold, so
 *    take whatever has the most room left rather than failing.
 * 5. **None, with blockers** — each account's reason, so the error can name it.
 *
 * ## Three rules that look like details and are not
 *
 * - **`unknown` is ELIGIBLE.** claudish never spends quota to measure quota, so
 *   an idle account's usage is genuinely unknown; skipping it would make "we
 *   have not asked" mean "it is full".
 * - **`unknown` is NOT what a stale reading decays into.** An account last seen
 *   at 92 % stays at 92 % for selection until its window's recorded reset
 *   passes, however old the reading is. Decaying it into `unknown` re-selects a
 *   spent account minutes after it rejected a request — and the reading, not the
 *   clock, is the evidence.
 * - **`unknown-failed` is eligible but ranked LAST.** An account whose state
 *   could not be READ may be chosen when nothing better exists, and never in
 *   preference to one with a known-good snapshot.
 */

import type { AccountBlocker } from "./errors.js";
import type { AccountRef, UsageSnapshot, UsageWindow } from "./types.js";
import { DEFAULT_SWITCH_AT } from "./types.js";

/** Everything the policy needs to know about one account. Data only. */
export interface AccountCandidate {
  ref: AccountRef;
  /** Position in the account list. The tiebreak, because it is stable across processes. */
  order: number;
  enabled: boolean;
  /** The latest snapshot, or null when there has never been a usable one. */
  usage: UsageSnapshot | null;
  /** True when the STATE READ failed — eligible, ranked last. */
  usageFailed: boolean;
  /** Epoch ms; the account cannot serve until then. */
  exhaustedUntil?: number;
  exhaustedEstimated?: boolean;
  /** Set while the account needs a browser re-login. */
  needsReauth?: { since: number; attempts: number; lastReason: string } | null;
  /** True for the account `state.json` currently calls active. */
  isActive: boolean;
  /**
   * This process failed to lease the account a moment ago (the refresh gate
   * was held, the store unreadable, the login missing). A LAST RESORT: never
   * sticky, and chosen only when no other eligible account exists — so one
   * wedged account costs one request its wait, not every request.
   */
  recentCredentialFailure?: boolean;
}

export interface SelectOptions {
  now: number;
  /** Fraction, per window. Default 0.90. */
  switchAt?: number;
  /** Per-window override, keyed on `UsageWindow.slot`. */
  switchAtByWindow?: Record<string, number>;
  exclude?: AccountRef[];
  pin?: AccountRef;
}

export type SelectReason = "pinned" | "sticky" | "first-under-threshold" | "lowest-pressure";

export type SelectResult =
  | { kind: "selected"; candidate: AccountCandidate; reason: SelectReason }
  | { kind: "none"; blockers: AccountBlocker[] };

/**
 * The retry schedule for an account marked `needsReauth`: **1 min, then 5 min,
 * then a 30 min floor** for every subsequent attempt.
 *
 * A genuinely revoked token is therefore retried on this schedule rather than
 * pinned off after one failure. The cost is a bounded trickle of failed
 * exchanges and a persistent re-login line in `account status`; a false lockout
 * of a working paid account is strictly more expensive.
 */
export function reauthRetryDelayMs(attempts: number): number {
  if (attempts <= 1) return 60_000;
  if (attempts === 2) return 5 * 60_000;
  return 30 * 60_000;
}

/** Is a `needsReauth` account due for another attempt? */
export function isReauthRetryDue(
  record: { since: number; attempts: number } | null | undefined,
  lastAttemptAt: number,
  now: number
): boolean {
  if (!record) return true;
  return now - lastAttemptAt >= reauthRetryDelayMs(record.attempts);
}

/**
 * The `needsReauth` self-heal: is the STORED material no longer the material
 * the mark was recorded against?
 *
 * True when the stored refresh-token fingerprint differs from
 * `failedFingerprint` (the user logged in again, or another process wrote new
 * material), or the stored generation is past `failedGeneration` (a persist,
 * which only a successful exchange or a login produces). Either way the mark
 * describes material the account no longer holds, so it is cleared and the
 * account is eligible again at once — no exchange is spent to find out, and no
 * retry interval is waited out.
 *
 * False for the SAME material. That account stays on the retry schedule above,
 * so a revoked token costs a bounded trickle of exchanges and never a tight
 * loop: every heal needs a new write to the store.
 *
 * A baseline field that is missing or malformed (the mark is raw JSON from
 * `state.json`) is no evidence either way and never heals. Clearing on every
 * read is the failure the recorded baseline exists to prevent.
 */
export function reauthMaterialMoved(
  mark: { failedFingerprint?: unknown; failedGeneration?: unknown },
  stored: { fingerprint: string; generation: number }
): boolean {
  const fingerprintMoved =
    typeof mark.failedFingerprint === "string" && mark.failedFingerprint !== stored.fingerprint;
  const generationMoved =
    typeof mark.failedGeneration === "number" &&
    Number.isFinite(mark.failedGeneration) &&
    stored.generation > mark.failedGeneration;
  return fingerprintMoved || generationMoved;
}

/**
 * The windows that still SAY something at `now`.
 *
 * A window whose recorded reset has passed no longer constrains anything, so it
 * is dropped. A window with no recorded reset is kept indefinitely — dropping it
 * on age is the decay this policy refuses to do.
 */
export function liveWindows(usage: UsageSnapshot | null, now: number): UsageWindow[] {
  if (!usage) return [];
  return usage.windows.filter((w) => w.resetAt === undefined || w.resetAt > now);
}

/**
 * How full an account is: the MAXIMUM used fraction across its live windows.
 *
 * Maximum, not average: a spent weekly window is spent no matter how empty the
 * five-hour one is. Returns `null` when nothing is known, which callers read as
 * "no evidence", never as zero.
 */
export function pressure(candidate: AccountCandidate, now: number): number | null {
  const windows = liveWindows(candidate.usage, now);
  if (windows.length === 0) return null;
  return windows.reduce((max, w) => Math.max(max, w.usedFraction), 0);
}

/** The threshold for one window: its own override, else the pool default. */
function thresholdFor(slot: string, opts: SelectOptions): number {
  return opts.switchAtByWindow?.[slot] ?? opts.switchAt ?? DEFAULT_SWITCH_AT;
}

/**
 * Is any live window at or past its threshold?
 *
 * Per window, because the thresholds are per window: a 0.95 five-hour window is
 * a reason to switch even when the weekly one is at 0.10.
 */
export function isOverThreshold(
  candidate: AccountCandidate,
  now: number,
  opts: SelectOptions
): boolean {
  return liveWindows(candidate.usage, now).some(
    (w) => w.usedFraction >= thresholdFor(w.slot, opts)
  );
}

function isExcluded(candidate: AccountCandidate, opts: SelectOptions): boolean {
  return (opts.exclude ?? []).some(
    (e) => e.provider === candidate.ref.provider && e.id === candidate.ref.id
  );
}

/**
 * Why this account cannot serve, or null when it can.
 *
 * Exported because `account status` must be able to say why EACH account is
 * blocked, whether or not some other account happens to be selectable — reading
 * the blocker list off a failed selection shows nothing at all whenever the pool
 * still has one working account, which is the case a user is most likely to be
 * looking at.
 */
export function blockerFor(
  candidate: AccountCandidate,
  now: number,
  opts: SelectOptions
): AccountBlocker | null {
  if (isExcluded(candidate, opts)) return { kind: "excluded", ref: candidate.ref };
  if (!candidate.enabled) return { kind: "disabled", ref: candidate.ref };
  if (candidate.exhaustedUntil !== undefined && candidate.exhaustedUntil > now) {
    return {
      kind: "exhausted",
      ref: candidate.ref,
      resetAt: candidate.exhaustedUntil,
      ...(candidate.exhaustedEstimated ? { estimated: true } : {}),
    };
  }
  if (candidate.needsReauth) {
    return {
      kind: "needs-reauth",
      ref: candidate.ref,
      reason: candidate.needsReauth.lastReason,
    };
  }
  return null;
}

/**
 * Sort key: known-good state first, then config order.
 *
 * This is the `unknown-failed` rule. Removing it lets an account whose state
 * could not be read outrank one with a known-good snapshot, which is how an
 * unreadable file quietly becomes the preferred account.
 */
function rankKey(candidate: AccountCandidate): [number, number] {
  return [candidate.usageFailed ? 1 : 0, candidate.order];
}

function byRank(a: AccountCandidate, b: AccountCandidate): number {
  const [af, ao] = rankKey(a);
  const [bf, bo] = rankKey(b);
  return af - bf || ao - bo;
}

/**
 * Choose the account for this request.
 *
 * A `pin` is honoured for any account that exists and is not excluded, INCLUDING
 * one over threshold or marked exhausted: the caller has asked to re-sign one
 * specific account (the 401 forced refresh), and quietly substituting another
 * would make that retry a different experiment.
 */
export function selectAccount(candidates: AccountCandidate[], opts: SelectOptions): SelectResult {
  const { now } = opts;

  if (opts.pin) {
    const pinned = candidates.find(
      (c) => c.ref.provider === opts.pin?.provider && c.ref.id === opts.pin?.id
    );
    if (!pinned) {
      return {
        kind: "none",
        blockers: [
          { kind: "unavailable", ref: opts.pin, reason: "pinned account is no longer configured" },
        ],
      };
    }
    if (!pinned.enabled) return { kind: "none", blockers: [{ kind: "disabled", ref: pinned.ref }] };
    if (isExcluded(pinned, opts))
      return { kind: "none", blockers: [{ kind: "excluded", ref: pinned.ref }] };
    return { kind: "selected", candidate: pinned, reason: "pinned" };
  }

  const blockers: AccountBlocker[] = [];
  const eligible: AccountCandidate[] = [];
  for (const candidate of candidates) {
    const blocker = blockerFor(candidate, now, opts);
    if (blocker) blockers.push(blocker);
    else eligible.push(candidate);
  }
  if (eligible.length === 0) return { kind: "none", blockers };

  // Accounts this process just failed to lease are a last resort: the normal
  // order runs over the rest, and only when nothing else is eligible over them.
  const preferred = eligible.filter((c) => !c.recentCredentialFailure);
  return selectAmong(preferred.length > 0 ? preferred : eligible, opts);
}

/** Steps 2-4 of the order, over accounts already known to be eligible. */
function selectAmong(eligible: AccountCandidate[], opts: SelectOptions): SelectResult {
  const { now } = opts;
  const ranked = [...eligible].sort(byRank);

  // 2. Sticky, while it is under threshold.
  const active = ranked.find((c) => c.isActive);
  if (active && !isOverThreshold(active, now, opts)) {
    return { kind: "selected", candidate: active, reason: "sticky" };
  }

  // 3. First under threshold, in config order. An account with NO live windows
  //    is under threshold by construction — `unknown` is eligible, and being
  //    untried is not evidence of being full.
  const under = ranked.find((c) => !isOverThreshold(c, now, opts));
  if (under) return { kind: "selected", candidate: under, reason: "first-under-threshold" };

  // 4. Everything is over threshold: least full wins, `unknown-failed` last.
  let best = ranked[0] as AccountCandidate;
  let bestPressure = pressure(best, now) ?? 0;
  for (const candidate of ranked.slice(1)) {
    const p = pressure(candidate, now) ?? 0;
    if (p < bestPressure) {
      best = candidate;
      bestPressure = p;
    }
  }
  return { kind: "selected", candidate: best, reason: "lowest-pressure" };
}
