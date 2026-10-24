/**
 * Per-account token refresh: **exactly one exchange per account, across
 * processes**, and never a token in a caller's hands that the store does not
 * hold.
 *
 * ## The sequence, entirely under the gate
 *
 * 1. **Single-flight in-process**, then take the account's refresh gate
 *    (`onUnavailable: "fail"` — a refresh NEVER runs unlocked; two exchanges
 *    against a server that rotates refresh tokens means the second presenter gets
 *    `invalid_grant` and the account is logged out).
 * 2. **Uncached re-read under the gate.** If the access token still has more
 *    than {@link FRESH_MARGIN_MS} left — and is not the token a forced refresh
 *    names as rejected — return what is on disk: the holder ahead of us already
 *    did the work.
 * 3. **Journal, made durable BEFORE the HTTP call.** A crash between the exchange
 *    and the persist is otherwise invisible, and the next process would present a
 *    refresh token the server has already revoked.
 * 4. Exchange — bounded by `EXCHANGE_TIMEOUT_MS` (`exchange.ts`).
 * 5. **Fence, then persist, then — and only then — return the token.** The fence
 *    is `handle.holdsLock()`: a holder suspended past the stale TTL and stolen
 *    from must not write.
 * 6. Clear the journal, release the gate.
 *
 * ## A forced refresh names the token that was REJECTED
 *
 * A 401 from the vendor means "this bearer is dead", whatever its `expiresAt`
 * says. So `getAccessToken(ref, {rejectedAccessToken})` carries the rejected
 * bearer's fingerprint through the gate: under the gate, if the stored access
 * token is still that one, it is exchanged REGARDLESS of expiry; if another
 * process already replaced it, the replacement is returned without an exchange.
 * The previous rule re-read the record, saw it was not near expiry, and handed
 * the dead token straight back — so the retry 401'd exactly as the first try did.
 *
 * A forced request also never joins a NON-forced in-flight refresh: that one may
 * well resolve to the rejected token.
 *
 * ## Every persist carries a write id, and an ambiguous write is resolved by it
 *
 * A write whose outcome is unknown (a `security` call that timed out) is
 * resolved by re-reading uncached and looking for THIS write's id — never by
 * `generation` or fingerprint. The journal write changes neither of those, and a
 * final persist whose vendor did not rotate the refresh token keeps the
 * fingerprint, so both used to resolve as "committed" whether or not they had
 * landed. A write id that is not on disk did not commit.
 *
 * ## What happens when the gate cannot be taken
 *
 * Never a refresh. In order: re-read the store **uncached**; if the generation
 * advanced past the value we started with, the holder persisted while we waited,
 * so use that token and call it success. Otherwise raise
 * `RefreshUnavailableError` — transient, non-terminal, and carrying **no quota
 * wording**, so it can never masquerade as exhaustion. Nothing is marked
 * exhausted and nothing is marked `needsReauth`.
 *
 * ## `invalid_grant` is not automatically "revoked"
 *
 * Under the gate there is no race to lose between lock-honouring claudish
 * processes, so three causes remain: an OUT-OF-BAND rotation (Claude Code
 * rotating its own item, which the pool's own record cannot show), an
 * INTERRUPTED predecessor (`journal.state === "unknown"`), and a genuinely
 * revoked token. Only the third sets `needsReauth` — and only while this process
 * still holds the gate. A holder that lost the gate mid-way has proven nothing
 * about the CURRENT material and raises `RefreshUnavailableError` instead.
 *
 * ## A rejected exchange closes its journal
 *
 * The journal answers one question: did a rotation happen that was never
 * persisted? `invalid_grant` answers it (the vendor issued nothing, and the
 * presented refresh token is dead), so the gate holder closes its own journal
 * before it writes `needsReauth`. Left open, every later retry took the
 * answered exchange for an interrupted one, and a revoked token was reported
 * as "a token rotation was interrupted" from its second attempt on. The clear
 * writes the material back unchanged, so the stored `fingerprint` and
 * `generation` still equal the mark's baseline and the self-heal does not take
 * a closed journal for new material.
 *
 * The journal stays open wherever the answer is missing or cannot be written:
 * no usable response (marked `unknown`), a crash, an unresolved final persist,
 * a holder that lost the gate. It also stays open after any other vendor error
 * (the catch in `exchangeAndPersist` says why).
 *
 * The first failure of a material names its cause, and a retry of the same
 * material keeps it ({@link needsReauthReason}): only a journal recovery can
 * tell an interrupted rotation from a revocation, and once the journal is
 * closed a retry is a plain exchange of the same dead token.
 *
 * ## `needsReauth` heals against the material it names
 *
 * The mark records the fingerprint and generation of the material whose
 * exchange failed. Every read that decides a request's token compares the
 * stored material against that baseline ({@link reauthMaterialMoved}): moved —
 * a re-login, or another process's write — clears the mark at once, with no
 * exchange and no retry interval. `AccountPool.acquire` runs the same check
 * before selection ({@link TokenManager.healNeedsReauth}), because a marked
 * account is not leased, and so never read here, until its retry comes due.
 * The SAME material stays on the 1 min → 5 min → 30 min retry schedule, and a
 * due retry is an exchange whatever the access token's expiry: a read that
 * finds the mark still naming the stored material treats that bearer as
 * rejected. It may be the one a 401 killed. The open journal used to force
 * this exchange by accident; closed, it would lease the dead bearer instead.
 *
 * A false lockout of a working paid account is strictly more expensive than a
 * bounded trickle of failed exchanges, which is the trade this schedule makes.
 *
 * ## Fault-injection sites (`CLAUDISH_ACCOUNTS_FAULT`, armed only with a loopback upstream)
 *
 * | Fault | Site |
 * |---|---|
 * | `journal-persist-*` | the journal write, before any exchange |
 * | `persist-*` | the FINAL write, after a successful exchange |
 * | `crash-after-refresh` | between the exchange and the final write |
 * | `steal-lock-mid-exchange` | the gate is re-created under another nonce while the exchange is in flight |
 * | `steal-lock-after-fence` | the same, between the final write's fence and the write itself |
 * | `lock-hold-forever` | the holder, having taken the gate, never proceeds and never releases |
 */

import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { classifyAuthFailure } from "../../handlers/shared/auth-failure.js";
import { classifyConnectionError } from "../../handlers/shared/connection-error.js";
import { log } from "../../logger.js";
import { type AccountsFault, accountsFaultArmed } from "../../test-upstream.js";
import type { LockHandle } from "./file-lock.js";
import { accountLockPath } from "./paths.js";
import { reauthMaterialMoved, reauthRetryDelayMs } from "./policy.js";
import { isGateUnavailable, withRefreshGate } from "./refresh-lock.js";
import type { StateStore } from "./state-store.js";
import {
  type StoredTokenRecord,
  type TokenJournal,
  type TokenStore,
  TokenStoreAmbiguousWriteError,
  TokenStoreReadError,
  fingerprintOf,
} from "./token-store.js";
import {
  type AccountRef,
  NeedsReauthError,
  type NeedsReauthRecord,
  PersistOutcomeUnknownError,
  RefreshUnavailableError,
} from "./types.js";

/**
 * Refresh when less than two minutes of validity remain.
 *
 * Long enough that a slow request cannot outlive its own token; short enough
 * that N processes waking together mostly find the token still fresh and never
 * queue on the gate at all.
 */
export const FRESH_MARGIN_MS = 120_000;

/** What the vendor's token endpoint gives back. */
export interface TokenExchangeResult {
  accessToken: string;
  /** Absent means the vendor did not rotate; the old refresh token stands. */
  refreshToken?: string;
  expiresAt: number;
  accountId?: string;
}

/** The OAuth port. One implementation per vendor; injected, never imported. */
export interface TokenExchange {
  refresh(record: StoredTokenRecord, ref: AccountRef): Promise<TokenExchangeResult>;
}

/** The vendor said the presented refresh token is no longer valid. */
export class InvalidGrantError extends Error {
  constructor(detail?: string) {
    super(`invalid_grant${detail ? `: ${detail}` : ""}`);
    this.name = "InvalidGrantError";
  }
}

/**
 * The token host refused the presented refresh token with a 400/401/403 that
 * is not `invalid_grant` (`refresh_token_reused`, `refresh_token_expired`, …).
 * Handled exactly like {@link InvalidGrantError}: the vendor answered and did
 * not rotate, so the gate holder closes its journal and records `needsReauth`.
 * `code` is the body's structured error identifier, never its free text.
 */
export class RefreshTokenRejectedError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string
  ) {
    super(`HTTP ${status}${code ? ` ${code}` : ""}`);
    this.name = "RefreshTokenRejectedError";
  }
}

/**
 * The exchange got no usable answer — a timeout, a dropped connection, a 2xx
 * whose body could not be read. The vendor MAY have rotated the refresh token,
 * so this is an unknown outcome, never a clean failure.
 */
export class ExchangeOutcomeUnknownError extends Error {
  constructor(detail: string, options?: ErrorOptions) {
    super(`the token exchange outcome is unknown: ${detail}`, options);
    this.name = "ExchangeOutcomeUnknownError";
  }
}

export interface TokenManagerOptions {
  store: TokenStore;
  exchange: TokenExchange;
  /** Written only for `needsReauth`; absent in a pure-refresh unit test. */
  state?: StateStore;
  now?: () => number;
  /** Override the gate path (tests point it at a temp HOME). */
  lockPathFor?: (ref: AccountRef) => string;
  /**
   * Revalidate the configured row under its gate. `before-exchange` may refuse
   * for any reason (nothing was spent yet); `before-persist` runs after the
   * vendor rotated, so it refuses only a CONFIRMED removal or rebinding — a
   * disabled row or an unreadable account list must not discard a new grant.
   */
  validateAccount?: (ref: AccountRef, phase: "before-exchange" | "before-persist") => void;
  /**
   * A SECOND store that also holds this account's material (Claude Code's
   * item). Phase 4 (ai-docs/architecture/accounts.md) wires it; the out-of-band
   * rotation detector reads it, because
   * re-reading only claudish's own record can never see a rotation Claude Code
   * performed and would classify a perfectly good shared account as revoked.
   */
  secondaryStore?: TokenStore;
  env?: NodeJS.ProcessEnv;
  /** Seam: mint the per-persist write id (random by default). */
  newWriteId?: () => string;
  /**
   * Seam: how a `lock-hold-forever` holder waits. The default never resolves and
   * keeps the process alive, so the gate's heartbeat keeps running.
   */
  holdForever?: () => Promise<void>;
}

/** How a caller asks for a token. */
export interface GetAccessTokenOptions {
  /** Refresh through the gate even if the stored token looks fresh. */
  forceRefresh?: boolean;
  /**
   * The access token the vendor just REJECTED (a 401). Implies `forceRefresh`,
   * and is what makes it effective: under the gate that exact token is exchanged
   * whatever its expiry, and a different one — someone else's rotation — is
   * returned as-is.
   */
  rejectedAccessToken?: string;
}

/** A usable access token, and what it cost to get one. */
export interface AccessTokenResult {
  accessToken: string;
  record: StoredTokenRecord;
  refreshed: boolean;
}

/** Which of the refresh's writes a persist is. Fault injection and error mapping key on it. */
type PersistKind = "journal" | "final" | "journal-clear" | "adopt";

/** The fault names that target each persist kind. */
const PERSIST_FAULTS: Partial<
  Record<
    PersistKind,
    { throw: AccountsFault; committed: AccountsFault; uncommitted: AccountsFault }
  >
> = {
  journal: {
    throw: "journal-persist-throw",
    committed: "journal-persist-timeout-committed",
    uncommitted: "journal-persist-timeout-uncommitted",
  },
  final: {
    throw: "persist-throw",
    committed: "persist-timeout-committed",
    uncommitted: "persist-timeout-uncommitted",
  },
};

const PERSIST_WHAT: Record<PersistKind, string> = {
  journal: "the rotation journal",
  final: "the rotated tokens",
  "journal-clear": "the journal clear",
  adopt: "the adopted peer material",
};

function isExpiring(record: StoredTokenRecord, now: number): boolean {
  return record.expiresAt - now <= FRESH_MARGIN_MS;
}

/** `sha256(accessToken).slice(0,16)` — which bearer a forced refresh names as dead. */
export function accessTokenFingerprint(accessToken: string): string {
  return fingerprintOf(accessToken);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A journal recovery's `invalid_grant`: the predecessor's rotation landed and was lost. V9 pins it. */
const INTERRUPTED_ROTATION = "a token rotation was interrupted";

/**
 * Why the presented material needs a login.
 *
 * `previous` is a mark about this SAME material ({@link TokenManager}'s
 * `previousFailureOf`), and its reason stands. Only the first failure of a
 * material can tell the causes apart: a recovery's `invalid_grant` means a
 * predecessor's rotation was lost, a plain one that the token was revoked.
 * With the journal closed, every retry after that is a plain exchange of the
 * same dead token, and would relabel an interrupted rotation as a revocation.
 */
function needsReauthReason(
  previous: NeedsReauthRecord | undefined,
  recovering: boolean,
  cause: InvalidGrantError | RefreshTokenRejectedError
): string {
  if (typeof previous?.lastReason === "string" && previous.lastReason.length > 0) {
    return previous.lastReason;
  }
  return recovering
    ? INTERRUPTED_ROTATION
    : `the vendor rejected the refresh token (${cause.message})`;
}

/**
 * One account's refresher.
 *
 * Holds NO account identity of its own beyond the ref it is constructed for, and
 * caches nothing across a persist failure — see {@link TokenManager.persist}.
 */
export class TokenManager {
  private readonly store: TokenStore;
  private readonly secondary: TokenStore | undefined;
  private readonly exchange: TokenExchange;
  private readonly state: StateStore | undefined;
  private readonly now: () => number;
  private readonly lockPathFor: (ref: AccountRef) => string;
  private readonly validateAccount: TokenManagerOptions["validateAccount"];
  private readonly env: NodeJS.ProcessEnv;
  private readonly newWriteId: () => string;
  private readonly holdForever: () => Promise<void>;

  /**
   * In-process single flight. Non-forced requests share `provider:id`; a forced
   * request is keyed by the token it names as rejected, so it can only ever
   * join a request that is replacing that same token.
   */
  private readonly inFlight = new Map<string, Promise<AccessTokenResult>>();

  constructor(opts: TokenManagerOptions) {
    this.store = opts.store;
    this.validateAccount = opts.validateAccount;
    this.secondary = opts.secondaryStore;
    this.exchange = opts.exchange;
    this.state = opts.state;
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? (() => Date.now());
    this.lockPathFor =
      opts.lockPathFor ?? ((ref) => accountLockPath(ref.provider, ref.id, this.env));
    this.newWriteId = opts.newWriteId ?? (() => randomBytes(8).toString("hex"));
    this.holdForever =
      opts.holdForever ??
      (() =>
        new Promise<void>(() => {
          // A REF'D timer: an unresolved promise alone would let the process
          // exit, and the gate (and its heartbeat) with it.
          setInterval(() => {}, 60_000);
        }));
  }

  /**
   * A usable access token for `ref`.
   *
   * Reads are cached-friendly until the token is near expiry; everything past
   * that point runs under the gate.
   */
  async getAccessToken(
    ref: AccountRef,
    opts: GetAccessTokenOptions = {}
  ): Promise<AccessTokenResult> {
    const rejectedFp =
      opts.rejectedAccessToken === undefined
        ? undefined
        : accessTokenFingerprint(opts.rejectedAccessToken);
    const forced = opts.forceRefresh === true || rejectedFp !== undefined;
    const base = `${ref.provider}:${ref.id}`;
    // A forced request must NEVER coalesce onto a non-forced one, whose result
    // may be the very token the vendor just rejected.
    const key = forced ? `${base}#forced:${rejectedFp ?? "current"}` : base;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const work = this.resolve(ref, forced, rejectedFp).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, work);
    return work;
  }

  private async resolve(
    ref: AccountRef,
    forced: boolean,
    rejectedFp: string | undefined
  ): Promise<AccessTokenResult> {
    const current = await this.readOrThrow(ref, { uncached: forced });
    if (!current) {
      throw new NeedsReauthError(
        `No stored credential for ${ref.label}. Run a login for this account.`
      );
    }
    await this.healIfMaterialMoved(ref, current);
    // A forced refresh with no named token rejects whatever is stored NOW. So
    // does a read of material a `needsReauth` mark still names: its due retry
    // is an exchange, because the stored bearer may be the one a 401 rejected.
    const markedDead = this.previousFailureOf(ref, current) !== undefined;
    const rejected =
      forced || markedDead
        ? (rejectedFp ?? accessTokenFingerprint(current.accessToken))
        : undefined;
    if (
      !isExpiring(current, this.now()) &&
      !current.journal &&
      !this.isRejected(current, rejected)
    ) {
      return { accessToken: current.accessToken, record: current, refreshed: false };
    }
    return this.withGate(ref, current, rejected);
  }

  /** Is this the access token a forced refresh named as rejected? */
  private isRejected(record: StoredTokenRecord, rejectedFp: string | undefined): boolean {
    return rejectedFp !== undefined && accessTokenFingerprint(record.accessToken) === rejectedFp;
  }

  /** Read, mapping a store failure onto the transient half of the taxonomy. */
  private async readOrThrow(
    ref: AccountRef,
    opts: { uncached?: boolean } = {}
  ): Promise<StoredTokenRecord | null> {
    try {
      return await this.store.read(ref, opts);
    } catch (err) {
      if (err instanceof TokenStoreReadError) {
        // A store that cannot be READ is transient and must never read as
        // "absent" — absent is what puts a flat-rate user on a metered key.
        throw new RefreshUnavailableError("token store unreadable", err.message);
      }
      throw err;
    }
  }

  /**
   * The selection-time half of the `needsReauth` self-heal, for
   * `AccountPool.acquire`: read the stored credential and clear the mark if it
   * is not the material the mark names.
   *
   * The pool needs this because a marked account is not LEASED until its retry
   * comes due, so the checks inside {@link getAccessToken} cannot see a re-login
   * for up to 30 minutes. It is a plain read — cached, since it runs on every
   * lease and a re-login need only be seen within the store's memo window — and
   * it never exchanges. It never throws either: a store that cannot be read, or
   * holds nothing, is no evidence the material moved, so the mark stays and the
   * retry schedule decides.
   *
   * Returns true when the mark was cleared.
   */
  async healNeedsReauth(ref: AccountRef): Promise<boolean> {
    if (!this.state?.stateFor(ref).state.needsReauth) return false;
    let record: StoredTokenRecord | null;
    try {
      record = await this.store.read(ref);
    } catch (err) {
      log(
        `[accounts] ${ref.label}: needsReauth self-heal skipped, store unreadable: ${errorText(err)}`
      );
      return false;
    }
    return record ? this.healIfMaterialMoved(ref, record) : false;
  }

  /**
   * Clear `needsReauth` if `record` is not the material the mark was recorded
   * against ({@link reauthMaterialMoved}). The clear carries that baseline as
   * its guard, so it can only remove this stale mark, never a newer failure
   * another process recorded against the new material.
   *
   * A failed write is logged, not thrown: the clear is already in this
   * process's pending overlay, rides on the next write that lands, and must not
   * fail a request whose credential is good.
   */
  private async healIfMaterialMoved(ref: AccountRef, record: StoredTokenRecord): Promise<boolean> {
    if (!this.state) return false;
    const mark = this.state.stateFor(ref).state.needsReauth;
    if (!mark || !reauthMaterialMoved(mark, record)) return false;
    log(
      `[accounts] ${ref.label}: the stored credential is not the one that failed ` +
        `(gen ${mark.failedGeneration} → ${record.generation}); clearing needsReauth`
    );
    try {
      await this.state.clearNeedsReauth(ref, {
        failedAgainst: {
          failedFingerprint: mark.failedFingerprint,
          failedGeneration: mark.failedGeneration,
        },
      });
    } catch (err) {
      log(`[accounts] ${ref.label}: the needsReauth clear was not persisted: ${errorText(err)}`);
    }
    return true;
  }

  private async withGate(
    ref: AccountRef,
    startedFrom: StoredTokenRecord,
    rejectedFp: string | undefined
  ): Promise<AccessTokenResult> {
    let lockPath: string;
    try {
      lockPath = this.lockPathFor(ref);
    } catch (err) {
      // An account whose gate path cannot be built safely cannot be refreshed.
      throw new RefreshUnavailableError("refresh disabled", errorText(err));
    }
    try {
      return await withRefreshGate(
        ref.provider,
        ref.id,
        (handle) => this.refreshUnderGate(ref, handle, rejectedFp),
        { path: lockPath, gen: startedFrom.generation }
      );
    } catch (err) {
      if (!isGateUnavailable(err)) throw err;
      // The gate is held, or unwritable. NEVER refresh unlocked.
      const latest = await this.readOrThrow(ref, { uncached: true });
      if (latest) await this.healIfMaterialMoved(ref, latest);
      if (
        latest &&
        latest.generation > startedFrom.generation &&
        !isExpiring(latest, this.now()) &&
        !this.isRejected(latest, rejectedFp)
      ) {
        // The holder persisted while we waited. That IS the success path.
        log(`[accounts] ${ref.label}: used the gate holder's rotation (gen ${latest.generation})`);
        return { accessToken: latest.accessToken, record: latest, refreshed: false };
      }
      throw new RefreshUnavailableError(
        err.reason === "unwritable" ? "refresh disabled" : "another process holds the refresh gate",
        err.message
      );
    }
  }

  /** Everything from here down runs with the gate held. */
  private async refreshUnderGate(
    ref: AccountRef,
    handle: LockHandle,
    rejectedFp: string | undefined
  ): Promise<AccessTokenResult> {
    if (accountsFaultArmed("lock-hold-forever", this.env)) {
      // V2c's precondition (ai-docs/architecture/accounts-validation.md): a LIVE,
      // heartbeating holder that never proceeds and never releases, so a waiter
      // must reach its acquire timeout.
      log("[accounts] CLAUDISH_ACCOUNTS_FAULT=lock-hold-forever — holding the gate indefinitely");
      await this.holdForever();
    }

    // 2. Uncached re-read. The memo would hand back the pre-rotation token.
    this.validateAccount?.(ref, "before-exchange");
    let record = await this.readOrThrow(ref, { uncached: true });
    if (!record) {
      throw new NeedsReauthError(
        `No stored credential for ${ref.label}. Run a login for this account.`
      );
    }
    // The material may have moved while we queued for the gate. Healed here, a
    // failure of the NEW material below starts its own schedule instead of
    // inheriting the stale mark's attempts.
    await this.healIfMaterialMoved(ref, record);

    if (record.journal) {
      const recovery = await this.recoverJournal(ref, record, handle);
      if (recovery.kind === "done") return recovery.result;
      record = recovery.record;
    }

    if (!isExpiring(record, this.now()) && !this.isRejected(record, rejectedFp)) {
      // Someone rotated while we queued — or, for a forced refresh, someone
      // already replaced the token the vendor rejected.
      return { accessToken: record.accessToken, record, refreshed: false };
    }

    return this.exchangeAndPersist(ref, record, handle, false, false);
  }

  /**
   * An open journal means a predecessor died mid-rotation.
   *
   * If the fingerprint already moved, the predecessor's write DID land: the
   * journal is cleared and the caller carries on with its normal decision (the
   * token may still need refreshing, or be the one a forced refresh rejected).
   * Otherwise the on-disk token is exchanged exactly once: success means the
   * previous write never landed, `invalid_grant` means it landed and was lost, so
   * the account needs a login with that exact reason recorded (unless a mark
   * about this same material already names the cause: {@link needsReauthReason}).
   */
  private async recoverJournal(
    ref: AccountRef,
    record: StoredTokenRecord,
    handle: LockHandle
  ): Promise<
    { kind: "continue"; record: StoredTokenRecord } | { kind: "done"; result: AccessTokenResult }
  > {
    const journal = record.journal as TokenJournal;
    if (journal.state === "refreshing" && journal.nonce === handle.nonce) {
      return { kind: "continue", record };
    }

    log(`[accounts] ${ref.label}: recovering an interrupted rotation (${journal.state})`);
    if (journal.from !== record.fingerprint) {
      const cleared = await this.persist(
        ref,
        { ...record, journal: null },
        handle,
        "journal-clear"
      );
      return { kind: "continue", record: cleared };
    }
    return {
      kind: "done",
      result: await this.exchangeAndPersist(ref, record, handle, true, false),
    };
  }

  private async exchangeAndPersist(
    ref: AccountRef,
    record: StoredTokenRecord,
    handle: LockHandle,
    recovering: boolean,
    outOfBandRetried: boolean
  ): Promise<AccessTokenResult> {
    // 3. Journal FIRST, durably. Without it a crash in the next few hundred
    //    milliseconds is indistinguishable from "nothing happened".
    const journal: TokenJournal = {
      state: "refreshing",
      from: record.fingerprint,
      at: this.now(),
      pid: process.pid,
      host: hostname(),
      nonce: handle.nonce,
    };
    const journalled = await this.persist(ref, { ...record, journal }, handle, "journal");

    let result: TokenExchangeResult;
    try {
      const inFlight = this.exchange.refresh(record, ref);
      if (accountsFaultArmed("steal-lock-mid-exchange", this.env)) {
        // V2f / V10b (ai-docs/architecture/accounts-validation.md): ownership
        // changes while the exchange is on the wire.
        this.injectSteal(handle, "steal-lock-mid-exchange");
      }
      result = await inFlight;
    } catch (err) {
      if (err instanceof InvalidGrantError || err instanceof RefreshTokenRejectedError) {
        return this.handleInvalidGrant(ref, record, handle, recovering, outOfBandRetried, err);
      }
      if (err instanceof ExchangeOutcomeUnknownError) {
        // The vendor may have rotated and the answer was lost. The ambiguous
        // path: leave the journal for recovery, marked unknown, and do not call
        // this a clean failure.
        await this.markJournalUnknown(ref, journalled, handle);
        // No-response failures retain the actual token endpoint/cause for auth
        // recovery. A known 2xx body loss deliberately has neither and waits for
        // the next request's journal recovery instead of re-exchanging now.
        if (classifyConnectionError(err)) throw err;
        throw new PersistOutcomeUnknownError(err.message);
      }
      // Any other vendor error leaves the journal open, deliberately: this answer
      // does not settle what a recovery needs. A 5xx may follow a rotation the
      // server committed, and after a forced refresh the open journal is the
      // only record that the stored bearer was rejected, so the next lease
      // exchanges instead of handing that bearer out.
      const failure = classifyAuthFailure(err);
      if (failure.kind === "connection" || failure.kind === "terminal") throw err;
      if (failure.kind === "transient") {
        throw new RefreshUnavailableError(
          "the token exchange failed",
          errorText(err),
          [],
          failure.status
        );
      }
      throw new RefreshUnavailableError("the token exchange failed", errorText(err));
    }

    if (accountsFaultArmed("crash-after-refresh", this.env)) {
      // The e2e's crash point: the exchange succeeded, the journal is open, and
      // nothing has been persisted. A following process must recover from it.
      log("[accounts] CLAUDISH_ACCOUNTS_FAULT=crash-after-refresh — exiting before the persist");
      process.exit(9);
    }

    // A login that does not take this gate (the legacy file's `claudish login
    // codex`) may land while the exchange is on the wire: the newer login wins,
    // and a store removed meanwhile is never recreated by this exchange.
    this.validateAccount?.(ref, "before-persist");
    const latest = await this.readOrThrow(ref, { uncached: true });
    if (!latest) {
      throw new NeedsReauthError(
        `The stored credential for ${ref.label} was removed during refresh.`
      );
    }
    if (latest.generation > record.generation || latest.fingerprint !== record.fingerprint) {
      await this.healIfMaterialMoved(ref, latest);
      return { accessToken: latest.accessToken, record: latest, refreshed: false };
    }

    const refreshToken = result.refreshToken ?? record.refreshToken;
    const next: StoredTokenRecord = {
      accessToken: result.accessToken,
      refreshToken,
      expiresAt: result.expiresAt,
      generation: record.generation + 1,
      fingerprint: fingerprintOf(refreshToken),
      journal: null,
      updatedAt: this.now(),
      ...((result.accountId ?? record.accountId)
        ? { accountId: result.accountId ?? record.accountId }
        : {}),
    };

    // 5. Fence, persist, THEN return. A token returned before its persist
    //    resolves is a token this process uses and no other process has.
    const written = await this.persist(ref, next, handle, "final");
    if (this.state?.stateFor(ref).state.needsReauth) {
      // Only a failure recorded against an OLDER generation is healed by this one.
      await this.state.clearNeedsReauth(ref, { belowGeneration: written.generation });
    }
    return { accessToken: written.accessToken, record: written, refreshed: true };
  }

  /**
   * Persist under the fence, stamped with a fresh write id, and return the
   * record exactly as it was written.
   *
   * An ambiguous write is resolved by RE-READING UNCACHED — never by writing
   * anything back first — and by looking for THIS write's id. Writing the
   * pre-write record back would turn "committed but the acknowledgement was
   * lost" into definite loss of the new refresh token.
   */
  private async persist(
    ref: AccountRef,
    record: StoredTokenRecord,
    handle: LockHandle,
    kind: PersistKind
  ): Promise<StoredTokenRecord> {
    const intended: StoredTokenRecord = { ...record, writeId: this.newWriteId() };
    if (!handle.holdsLock()) {
      throw new RefreshUnavailableError(
        "the refresh gate was stolen before the persist",
        `${ref.provider}/${ref.id}`
      );
    }
    if (kind === "final" && accountsFaultArmed("steal-lock-after-fence", this.env)) {
      // T-C4's window (ai-docs/architecture/accounts-validation.md): ownership
      // changes AFTER the fence passed and BEFORE the write. This persist then
      // writes anyway — the window is open by construction, which is exactly
      // what T-C4 exists to measure.
      this.injectSteal(handle, "steal-lock-after-fence");
    }

    const faults = PERSIST_FAULTS[kind];
    try {
      if (faults && accountsFaultArmed(faults.throw, this.env)) {
        throw new Error(`CLAUDISH_ACCOUNTS_FAULT=${faults.throw}`);
      }
      if (faults && accountsFaultArmed(faults.committed, this.env)) {
        await this.store.write(ref, intended);
        throw new TokenStoreAmbiguousWriteError(this.store.kind, "fault: committed then timed out");
      }
      if (faults && accountsFaultArmed(faults.uncommitted, this.env)) {
        throw new TokenStoreAmbiguousWriteError(this.store.kind, "fault: timed out before writing");
      }
      await this.store.write(ref, intended);
    } catch (err) {
      if (err instanceof TokenStoreAmbiguousWriteError) {
        await this.resolveAmbiguousWrite(ref, intended, err, handle, kind);
      } else {
        throw this.persistFailure(kind, errorText(err));
      }
    }

    if (kind === "final" && !handle.holdsLock()) {
      log(
        `[accounts] ${ref.label}: the refresh gate changed hands DURING the final persist (T-C4 window)`
      );
    }
    return intended;
  }

  /**
   * A persist that definitely did not land.
   *
   * Before the exchange (journal, journal clear, adoption) that means no refresh
   * can be attempted SAFELY — transient. After it, the vendor has rotated and
   * the new material is not stored: the rotation's outcome is unknown to every
   * other process, and the journal left on disk is how the next one recovers.
   */
  private persistFailure(kind: PersistKind, detail: string): Error {
    if (kind === "final") return new PersistOutcomeUnknownError(detail);
    return new RefreshUnavailableError(`${PERSIST_WHAT[kind]} could not be written`, detail);
  }

  /** Did the ambiguous write actually land? Read for its write id; never write to find out. */
  private async resolveAmbiguousWrite(
    ref: AccountRef,
    intended: StoredTokenRecord,
    cause: TokenStoreAmbiguousWriteError,
    handle: LockHandle,
    kind: PersistKind
  ): Promise<void> {
    let onDisk: StoredTokenRecord | null;
    try {
      onDisk = await this.store.read(ref, { uncached: true });
    } catch (err) {
      throw this.persistFailure(
        kind,
        `${cause.message}; the re-read that would resolve it failed (${errorText(err)})`
      );
    }
    if (onDisk?.writeId === intended.writeId) {
      // It DID commit; the acknowledgement was what got lost.
      log(
        `[accounts] ${ref.label}: ambiguous ${kind} write resolved as COMMITTED (write id on disk)`
      );
      return;
    }
    log(`[accounts] ${ref.label}: ambiguous ${kind} write resolved as NOT committed`);
    if (kind === "final" && onDisk) await this.markJournalUnknown(ref, onDisk, handle);
    throw this.persistFailure(kind, cause.message);
  }

  /**
   * Best effort: flip OUR open journal to `unknown`, so the record says what
   * this process knows — a rotation may have happened and was not persisted.
   * The next gate holder recovers from it either way; a failure here is logged.
   */
  private async markJournalUnknown(
    ref: AccountRef,
    onDisk: StoredTokenRecord,
    handle: LockHandle
  ): Promise<void> {
    const journal = onDisk.journal;
    if (!journal || journal.nonce !== handle.nonce || !handle.holdsLock()) return;
    try {
      await this.store.write(ref, {
        ...onDisk,
        journal: { ...journal, state: "unknown" },
        writeId: this.newWriteId(),
      });
    } catch (err) {
      log(`[accounts] ${ref.label}: could not mark the journal unknown: ${errorText(err)}`);
    }
  }

  /**
   * Fault injection only: re-create the gate under a different nonce, the way a
   * same-host successor that judged us stale would. The fake holder carries
   * OUR pid, so once this process exits it reads as dead and is stolen at once.
   */
  private injectSteal(handle: LockHandle, fault: AccountsFault): void {
    const successor = {
      pid: process.pid,
      host: handle.host,
      nonce: randomBytes(16).toString("hex"),
      at: this.now(),
    };
    try {
      rmSync(handle.path, { force: true });
      writeFileSync(handle.path, `${JSON.stringify(successor)}\n`, { flag: "wx", mode: 0o600 });
      log(`[accounts] CLAUDISH_ACCOUNTS_FAULT=${fault} — the gate now carries another nonce`);
    } catch (err) {
      log(
        `[accounts] CLAUDISH_ACCOUNTS_FAULT=${fault} could not replace the gate: ${errorText(err)}`
      );
    }
  }

  /**
   * Close THIS holder's journal after the vendor rejected the presented refresh
   * token. Nothing was issued, so a recovery has nothing to find; left open,
   * the next holder would take this answered exchange for an interrupted one.
   *
   * The clear goes through {@link persist} (the fence, a fresh write id, the
   * ambiguous-write resolution) and writes the stored material back unchanged:
   * `fingerprint` and `generation` stay the baseline the `needsReauth` mark
   * records, so {@link reauthMaterialMoved} does not read the closed journal as
   * new material. It is skipped unless an uncached re-read still shows this
   * holder's journal on the presented material, so a login that landed
   * meanwhile (a login does not take the gate) is never overwritten.
   *
   * Best effort: a failure is logged, never thrown, and never stops the mark.
   * The journal is then left to the next holder's recovery, which costs one
   * exchange, and the reason survives through {@link needsReauthReason}.
   */
  private async closeAnsweredJournal(
    ref: AccountRef,
    presented: StoredTokenRecord,
    handle: LockHandle
  ): Promise<void> {
    try {
      const onDisk = await this.store.read(ref, { uncached: true });
      if (
        !onDisk ||
        onDisk.journal?.nonce !== handle.nonce ||
        onDisk.fingerprint !== presented.fingerprint ||
        onDisk.generation !== presented.generation
      ) {
        log(
          `[accounts] ${ref.label}: journal left open; the stored record is not the one presented`
        );
        return;
      }
      await this.persist(ref, { ...onDisk, journal: null }, handle, "journal-clear");
    } catch (err) {
      log(`[accounts] ${ref.label}: the rejected exchange's journal stays open: ${errorText(err)}`);
    }
  }

  /**
   * The mark a new failure of `record` continues: the current one, but only if
   * it is about this same material. The retry schedule counts failures of ONE
   * credential, so a mark about other material (one whose clear is still
   * pending, say) is not this failure's history and must not lend it `since` or
   * `attempts`. Also how `resolve` recognises a due retry of material the mark
   * still names as dead.
   */
  private previousFailureOf(
    ref: AccountRef,
    record: StoredTokenRecord
  ): NeedsReauthRecord | undefined {
    const mark = this.state?.stateFor(ref).state.needsReauth;
    if (!mark || reauthMaterialMoved(mark, record)) return undefined;
    return mark;
  }

  /**
   * `invalid_grant` (or another refusal of the refresh token): decide between
   * out-of-band rotation, an interrupted predecessor, and a genuinely revoked
   * token.
   */
  private async handleInvalidGrant(
    ref: AccountRef,
    record: StoredTokenRecord,
    handle: LockHandle,
    recovering: boolean,
    outOfBandRetried: boolean,
    cause: InvalidGrantError | RefreshTokenRejectedError
  ): Promise<AccessTokenResult> {
    // Cause 1: the material moved under us. Read EVERY store that holds this
    // account — reading only our own record can never see a rotation another
    // party performed, and would route a working shared account to cause 3.
    // Retried ONCE: a second rotation during the retry is not chased.
    if (!outOfBandRetried) {
      const fresh = await this.readOrThrow(ref, { uncached: true });
      if (fresh && fresh.fingerprint !== record.fingerprint) {
        log(`[accounts] ${ref.label}: material rotated out of band; retrying once`);
        return this.exchangeAndPersist(ref, fresh, handle, recovering, true);
      }
      if (this.secondary) {
        const other = await this.secondary.read(ref, { uncached: true });
        if (other && other.fingerprint !== record.fingerprint) {
          log(`[accounts] ${ref.label}: the peer store rotated; adopting and retrying once`);
          const adopted = await this.persist(ref, { ...other, journal: null }, handle, "adopt");
          return this.exchangeAndPersist(ref, adopted, handle, recovering, true);
        }
      }
    }

    // A holder that lost the gate while its exchange was in flight has proven
    // nothing about the CURRENT material — the new owner may be mid-rotation.
    // It must not write `needsReauth`, and it must not report a login as needed.
    if (!handle.holdsLock()) {
      throw new RefreshUnavailableError(
        "the refresh gate was lost during the exchange",
        `${ref.provider}/${ref.id}`
      );
    }

    // Cause 3: genuinely revoked. `needsReauth` is written ONLY by the gate
    // holder, and only after the fence still names us. The vendor answered, so
    // this holder's journal is closed first, while the fence proof is fresh.
    await this.closeAnsweredJournal(ref, record, handle);
    const previous = this.previousFailureOf(ref, record);
    const reason = needsReauthReason(previous, recovering, cause);
    if (this.state) {
      const attempts = (previous?.attempts ?? 0) + 1;
      await this.state.setNeedsReauth(ref, {
        since: previous?.since ?? this.now(),
        attempts,
        lastReason: reason,
        failedGeneration: record.generation,
        failedFingerprint: record.fingerprint,
      });
      log(
        `[accounts] ${ref.label}: needs login (${reason}); next attempt in ` +
          `${Math.round(reauthRetryDelayMs(attempts) / 60_000)} min`
      );
    }
    throw new NeedsReauthError(`${ref.label} needs a browser login: ${reason}.`, [
      { kind: "needs-reauth", ref, reason },
    ]);
  }
}
