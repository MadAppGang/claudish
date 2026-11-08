/**
 * The account pool's error taxonomy. Terminal errors carry the shared auth
 * verdict (subscription-only continuation); transient errors retry the same hop.
 * Only AllAccountsExhaustedError uses the advancing quota response seam.
 * Transient statuses default to 503 and retain a token host's actual 429/5xx.
 *
 * ## Which pool-level error a spent pool raises
 *
 * `AccountPool.acquire` picks by the blockers it actually found, and the
 * quota-worded one is reserved for a pool where quota is really the reason:
 *
 * - **any account exhausted** → `AllAccountsExhaustedError`. The design's
 *   mixed-pool rule: exhaustion dominates, because that capacity returns on a
 *   clock and the chain should advance with the cost warning.
 * - **every account needs a login** → `NeedsReauthError`.
 * - **any account transiently unavailable** (gate held, store unreadable, a
 *   persist outcome unknown) → `RefreshUnavailableError`, non-terminal, because
 *   the next attempt may simply work.
 * - **otherwise** — disabled accounts, a disabled/needs-login mix, an account
 *   list that emptied under the request → `NoUsableAccountError`.
 *
 * Only the first carries quota wording. A disabled or logged-out pool that said
 * "usage limit reached" would advance a bare chain as if the plan were spent and
 * fire the "billed PER TOKEN" warning on a healthy subscription.
 *
 * `upstreamStatus` preserves the actual failure through the inline 400 remap.
 * The auth verdict, not this status, controls credential-failure continuation.
 * A transient error is 429/503 with its actual upstream status in the body.
 *
 * ## Why the exhaustion WORDING is pinned
 *
 * `hasQuotaExhaustionWording` decides two separate things: whether
 * `isRetryableError` lets a bare chain advance, and whether the "billed PER
 * TOKEN" cost warning fires. The template therefore LEADS with `usage limit`, a
 * `PLAN_LIMIT_PHRASES` member — leading with it also survives the balance-phrase
 * veto. Editing that phrase out of the template stops a bare chain dead and
 * silently suppresses the cost warning; row U10 in
 * ai-docs/architecture/accounts-validation.md pins exactly that.
 *
 * `NoPooledCredentialError` deliberately does NOT exist. "No pool configured" is
 * represented solely by the availability predicate answering false; a named error
 * that can never be thrown implies a third contract outcome where there are two.
 */

import type { AccountRef } from "./types.js";

/** The fixed facts every accounts error carries. */
export interface AccountsErrorInfo {
  /** Terminal errors are remapped to 400 and surfaced inline. */
  readonly terminal: boolean;
  readonly transient: boolean;
  /**
   * The status `extractUpstreamStatus` must recover from the remapped 400.
   * `undefined` only where the design's table says so.
   */
  readonly upstreamStatus?: number;
}

/** Base class, so one `instanceof` recognises the whole taxonomy. */
export abstract class AccountsError extends Error implements AccountsErrorInfo {
  abstract readonly terminal: boolean;
  abstract readonly transient: boolean;
  abstract readonly upstreamStatus?: number;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Why an account cannot serve, rendered per account in the pinned message. */
export type AccountBlocker =
  | { kind: "exhausted"; ref: AccountRef; resetAt?: number; estimated?: boolean }
  | { kind: "needs-reauth"; ref: AccountRef; reason?: string }
  | { kind: "disabled"; ref: AccountRef }
  | { kind: "excluded"; ref: AccountRef }
  /**
   * A credential failure that may clear on its own: the refresh gate was held,
   * the token store could not be read, a persist outcome was unknown. Produced by
   * `AccountPool.acquire` for an account it tried and could not lease, never by
   * the pure policy.
   */
  | { kind: "unavailable"; ref: AccountRef; reason: string; upstreamStatus?: number };

/** What `needsReauth` records, and the baseline its self-healing compares against. */
export interface NeedsReauthRecord {
  /** Epoch ms of the first failure in this run of failures. */
  since: number;
  /** Consecutive failed exchanges. Drives the 1 / 5 / 30 min retry schedule. */
  attempts: number;
  lastReason: string;
  /**
   * The generation and fingerprint the failure was observed AGAINST.
   *
   * Without a recorded baseline a restarted process has no comparison point, so
   * the self-healing cannot be implemented: it would either clear on every read
   * or never clear. Built (`policy.ts` `reauthMaterialMoved`): the flag clears
   * when a read finds the stored fingerprint differs from `failedFingerprint`,
   * or the stored generation exceeds `failedGeneration` — on every token read
   * and, through `AccountPool.acquire`, before selection — and when a later
   * rotation succeeds. The clear is guarded by this pair, so it never removes a
   * newer failure. Planned: `account login` clears it too (Phase 2).
   */
  failedGeneration: number;
  failedFingerprint: string;
}

/** Render an absolute reset as `14:32 (in 1h 12m)`. */
export function formatReset(resetAt: number | undefined, now: number, estimated = false): string {
  if (resetAt === undefined) return "reset time unknown";
  const when = new Date(resetAt);
  const clock = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  const deltaMs = resetAt - now;
  if (deltaMs <= 0) return `resets ${clock} (any moment)`;
  const minutes = Math.round(deltaMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const rel = hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
  return estimated ? `retry after ~${rel} (estimated)` : `resets ${clock} (in ${rel})`;
}

export interface ExhaustedMessageInput {
  /** `Codex` / `Claude` — the vendor as the user names it. */
  vendor: string;
  total: number;
  blockers: AccountBlocker[];
  now: number;
  /** The command that re-logs in, per provider. */
  loginCommand?: (ref: AccountRef) => string;
}

/**
 * The pinned all-accounts message.
 *
 * ```
 * Codex subscription usage limit reached on every account (3 of 3).
 *   work     — resets 14:32 (in 1h 12m)
 *   personal — resets 18:05 (in 4h 45m)
 *   spare    — needs login: run `claudish account login codex spare`
 * ```
 *
 * The first line is the load-bearing one: `usage limit` must survive every edit.
 */
export function buildExhaustedMessage(input: ExhaustedMessageInput): string {
  const { vendor, total } = input;
  const named = input.blockers.filter((b) => b.kind !== "excluded");
  return [
    `${vendor} subscription usage limit reached on every account (${named.length} of ${total}).`,
    ...blockerLines(input),
  ].join("\n");
}

/**
 * One aligned line per blocker. Shared by both pool messages; the quota message
 * omits accounts the caller excluded, the no-quota one names them too, so it
 * never reports "0 usable" with nothing listed.
 */
function blockerLines(input: ExhaustedMessageInput, includeExcluded = false): string[] {
  const { now } = input;
  const named = input.blockers.filter((b) => includeExcluded || b.kind !== "excluded");
  const width = named.reduce((max, b) => Math.max(max, b.ref.label.length), 0);
  return named.map((b) => {
    const label = b.ref.label.padEnd(width);
    switch (b.kind) {
      case "exhausted":
        return `  ${label} — ${formatReset(b.resetAt, now, b.estimated)}`;
      case "needs-reauth": {
        const cmd = input.loginCommand?.(b.ref);
        return `  ${label} — needs login${cmd ? `: run \`${cmd}\`` : ""}`;
      }
      case "disabled":
        return `  ${label} — disabled`;
      case "unavailable":
        return `  ${label} — unavailable: ${b.reason}`;
      case "excluded":
        return `  ${label} — skipped for this request`;
    }
  });
}

/**
 * The pool-level message for a pool that cannot serve for a reason that is NOT
 * quota — disabled accounts, missing logins, transient credential failures.
 *
 * ```
 * No Codex subscription account can serve this request (0 of 2 usable).
 *   work  — disabled
 *   spare — needs login: run `claudish account login codex spare`
 * ```
 *
 * **It must never carry quota wording** (`hasQuotaExhaustionWording` matches a
 * bare "quota", "usage limit", "plan limit", …). That wording is what advances a
 * bare chain AS IF the plan were spent and fires the per-token cost warning; a
 * pool the user disabled, or one that needs a login, has spent nothing.
 */
export function buildUnusableMessage(input: ExhaustedMessageInput): string {
  const { vendor, total } = input;
  return [
    `No ${vendor} subscription account can serve this request (0 of ${total} usable).`,
    ...blockerLines(input, true),
  ].join("\n");
}

/**
 * Every eligible account is spent.
 *
 * Raised when at least one account is EXHAUSTED, even if others need re-auth:
 * the exhausted state dominates, because at least one account's capacity returns
 * on a clock and the chain should advance with the cost warning. The message
 * still renders every account's state.
 */
export class AllAccountsExhaustedError extends AccountsError {
  readonly terminal = true;
  readonly transient = false;
  readonly upstreamStatus = 429;
  readonly blockers: AccountBlocker[];

  constructor(message: string, blockers: AccountBlocker[] = []) {
    super(message);
    this.blockers = blockers;
  }
}

/**
 * EVERY account in the pool needs a browser re-login.
 *
 * Carries the upstream 401 for diagnostics. The terminal auth verdict permits
 * only remaining subscription candidates, never metered continuation.
 */
export class NeedsReauthError extends AccountsError {
  readonly terminal = true;
  readonly transient = false;
  readonly upstreamStatus = 401;
  readonly blockers: AccountBlocker[];

  constructor(message: string, blockers: AccountBlocker[] = []) {
    super(message);
    this.blockers = blockers;
  }
}

/**
 * A refresh could not be attempted, or could not be attempted SAFELY.
 *
 * Transient by definition: the gate was held, the lock directory is unwritable,
 * a store read failed, or a fence check failed after the material was stolen.
 *
 * **It must never carry quota wording.** A transient disk error that
 * masquerades as exhaustion would make a bare chain advance for the wrong
 * reason and would fire the "billed PER TOKEN" warning on a healthy plan.
 */
export class RefreshUnavailableError extends AccountsError {
  readonly terminal = false;
  readonly transient = true;
  readonly upstreamStatus: number;
  readonly reason: string;
  /** Per-account blockers, when the pool raised this for every account it tried. */
  readonly blockers: AccountBlocker[];

  constructor(
    reason: string,
    detail?: string,
    blockers: AccountBlocker[] = [],
    upstreamStatus = 503
  ) {
    super(`Account refresh unavailable: ${reason}${detail ? ` (${detail})` : ""}`);
    this.upstreamStatus = validateTransientStatus(upstreamStatus);
    this.reason = reason;
    this.blockers = blockers;
  }
}

/**
 * Nothing in the pool can serve, and the reason is NOT quota and NOT transient:
 * every account is disabled, or disabled and logged-out accounts are mixed, or
 * the account list emptied between selection and lease.
 *
 * Terminal (the user must act), with upstream 401 for diagnostics. Like
 * `NeedsReauthError`, its auth verdict permits subscription-only continuation.
 * Its message comes from {@link buildUnusableMessage} and carries no quota
 * wording, so the per-token cost warning stays silent.
 */
export class NoUsableAccountError extends AccountsError {
  readonly terminal = true;
  readonly transient = false;
  readonly upstreamStatus = 401;
  readonly blockers: AccountBlocker[];

  constructor(message: string, blockers: AccountBlocker[] = []) {
    super(message);
    this.blockers = blockers;
  }
}

/**
 * The account list could not be READ — which is not the same as "there are no
 * accounts", and the whole design turns on the two never collapsing.
 *
 * `loadConfig()` answers a read failure with absence: it catches and returns
 * `DEFAULT_CONFIG`, which would make the availability predicate false and put a
 * flat-rate user on a metered key. `CodexOAuth.loadCredentials()` did the same
 * for the legacy file (catch, return `null`) until the V16b fix; it now records
 * the failure, `hasCredentials()` answers true, and the request fails visibly.
 * The registry reads both documents itself either way, and raises this error
 * when one fails with no last-known-good account list to serve.
 */
export type AccountSourceFailureType = "io" | "invalid";

export interface AccountSourceFailure {
  source: "config" | "legacy";
  path: string;
  type: AccountSourceFailureType;
  detail: string;
}

/** Only retryable upstream statuses belong on a transient accounts error. */
function validateTransientStatus(status: number): number {
  if (status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599)) return status;
  throw new RangeError(`Unsupported transient accounts status: ${status}`);
}

export class AccountListUnavailableError extends AccountsError {
  readonly terminal = false;
  readonly transient = true;
  readonly upstreamStatus: number;
  readonly source: string;
  readonly failure?: AccountSourceFailure;

  constructor(
    source: string,
    detail?: string,
    upstreamStatus = 503,
    failure?: AccountSourceFailure
  ) {
    super(
      `Could not read the ${source} account list${detail ? `: ${detail}` : ""}. ` +
        "Refusing to treat an unreadable account list as an empty one."
    );
    this.upstreamStatus = validateTransientStatus(upstreamStatus);
    this.source = source;
    this.failure = failure;
  }
}

/** Invalid config bytes require repair, not an indefinite same-hop retry. */
export class AccountListInvalidError extends AccountsError {
  readonly terminal = true;
  readonly transient = false;
  readonly upstreamStatus = 400;

  constructor(readonly failure: AccountSourceFailure) {
    super(
      `Invalid account list in ${failure.path}: ${failure.detail}. Repair the named config field.`
    );
  }
}

/**
 * A persist neither succeeded nor provably failed.
 *
 * The new token is NOT returned and NOT cached: serving a token the store may
 * not hold is how the next process gets `invalid_grant` on a token nobody has.
 */
export class PersistOutcomeUnknownError extends AccountsError {
  readonly terminal = false;
  readonly transient = true;
  readonly upstreamStatus: number;

  constructor(detail: string, upstreamStatus = 503) {
    super(
      `A token rotation's persist outcome is unknown (${detail}). ` +
        "The new token was not used; the next attempt recovers from the journal."
    );
    this.upstreamStatus = validateTransientStatus(upstreamStatus);
  }
}

/**
 * An internal assertion failure: a pooled provider was about to sign with a
 * metered artifact. Never expected, and it STOPS rather than advancing — an
 * advance would be the silent charge this whole design exists to prevent.
 */
export class MeteredEscapeError extends AccountsError {
  readonly terminal = true;
  readonly transient = false;
  readonly upstreamStatus = undefined;

  constructor(detail: string) {
    super(
      `Refusing to sign a pooled subscription request with a metered credential (${detail}). ` +
        "This is a claudish bug; no request was sent."
    );
  }
}

/** Is this one of ours? The single test every call site's catch uses. */
export function isAccountsError(err: unknown): err is AccountsError {
  return err instanceof AccountsError;
}
