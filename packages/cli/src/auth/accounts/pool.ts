/**
 * `AccountPool` — one per provider. Selection, leasing, outcome reporting, and
 * the presence predicate the billing layer reads.
 *
 * ## `hasAnyCredentials()` is CONFIGURATION, never token material
 *
 * > ≥1 enabled account in `config.subscriptionAccounts[provider].accounts`,
 * > OR the legacy `~/.claudish/codex-oauth.json` path present in the account list.
 *
 * It performs no Keychain call, opens no token file and cannot `await`. And it
 * has three properties that each closed a real hole:
 *
 * - **An unreadable store does not lower it.** Revision 1 of the design
 *   (ai-docs/reports/multi-subscription-plan-review-2026-09.md) computed
 *   it from stored token material, which is an I/O question — and the interface
 *   that predicate implements answers I/O failures with `false`, so a locked
 *   Keychain re-opened the metered door the predicate exists to close.
 * - **It may THROW.** An unreadable ACCOUNT LIST is "unknown", and where the answer
 *   decides who pays, unknown must resolve to the safe side. The only way to say
 *   unknown through a boolean is to throw. Typed source failures use the shared
 *   terminal/transient auth verdict, never a metered signature.
 * - **Exhaustion and `needsReauth` do not lower it.** Those are READINESS facts;
 *   this answers a CONFIGURATION question. An exhausted pool must fail visibly,
 *   not fall through to a per-token key.
 *
 * The cost of all three, recorded rather than discovered later: a pooled user can
 * no longer silently degrade to a working metered request, so a claudish bug or
 * an unreadable store becomes a visible failed request instead of an invisible
 * charge. That is the intended direction.
 *
 * ## Nothing here is on the request path in this phase
 *
 * Phase 1 (phases: ai-docs/architecture/accounts.md) builds the pool and the
 * read-only CLI. No handler, transport or
 * credential half calls `acquire()` yet, so a user with one account sees
 * byte-identical behaviour.
 */

import { classifyConnectionError } from "../../handlers/shared/connection-error.js";
import { log } from "../../logger.js";
import { shellWord } from "./account-label.js";
import { getAllowanceService, safeRanker } from "./allowance-service.js";
import type { StrategyName } from "./allowance/types.js";
import { exchangeFor } from "./exchange.js";
import { accountRefreshLockPath } from "./paths.js";
import {
  type AccountCandidate,
  type SelectOptions,
  type SelectReason,
  type SelectResult,
  blockerFor,
  isReauthRetryDue,
  pressure,
  selectAccount,
} from "./policy.js";
import { type AccountRegistry, getAccountRegistry } from "./registry.js";
import { type AccountState, type StateStore, getStateStore } from "./state-store.js";
import {
  type AccessTokenResult,
  type GetAccessTokenOptions,
  TokenManager,
} from "./token-manager.js";
import { type TokenStore, storeFor } from "./token-store.js";
import {
  type AccountBlocker,
  type AccountLeaseFailure,
  type AccountOutcome,
  type AccountProvider,
  type AccountRecord,
  type AccountRef,
  type AccountSelectionContext,
  type AccountsError,
  AllAccountsExhaustedError,
  type AllowanceSelectionHint,
  DEFAULT_SWITCH_AT,
  NeedsReauthError,
  NoUsableAccountError,
  PersistOutcomeUnknownError,
  RefreshUnavailableError,
  type UsageSnapshot,
  buildExhaustedMessage,
  buildUnusableMessage,
  isAccountsError,
  sameAccount,
} from "./types.js";

/** What a request is handed: a token, and the account it belongs to. */
export interface AccountLease {
  account: AccountRef;
  accessToken: string;
  /** From the leased token record, never the config's display identity. */
  accountId?: string;
  selectionContext?: AccountSelectionContext;
  /** Why the policy chose it — logged, and shown by `account status`. */
  reason: SelectReason;
}

export interface AcquireOptions {
  exclude?: AccountRef[];
  pin?: AccountRef;
  forceRefresh?: boolean;
  /**
   * The bearer the vendor just rejected (the 401 re-sign). Passed to the token
   * manager so the forced refresh replaces THAT token rather than returning it.
   */
  rejectedAccessToken?: string;
  selectionContext?: AccountSelectionContext;
}

interface PoolEvaluation {
  records: AccountRecord[];
  candidates: AccountCandidate[];
  options: SelectOptions;
  selection: SelectResult;
  /** True when the allowance model's ranker took part (`strategy` `ebr`/`lookahead`, no pin). */
  ranked: boolean;
}

/**
 * How long a failed lease keeps an account at the back of the queue.
 *
 * Deprioritised, not blocked: a single-account pool still tries it on the next
 * request (the gate holder may have finished), while a pool with a healthy
 * second account stops paying the failed one's 20 s gate wait on every request.
 */
export const LEASE_FAILURE_DEPRIORITIZE_MS = 60_000;

/**
 * The token options for the account the policy chose. A forced refresh belongs
 * to the account the caller PINNED; a pin the policy could not honour must not
 * force-refresh some other account.
 */
function tokenOptionsFor(opts: AcquireOptions, reason: SelectReason): GetAccessTokenOptions {
  if (opts.pin && reason !== "pinned") return {};
  return {
    ...(opts.forceRefresh ? { forceRefresh: true } : {}),
    ...(opts.rejectedAccessToken ? { rejectedAccessToken: opts.rejectedAccessToken } : {}),
  };
}

/**
 * The per-account blocker a lease failure becomes, or `null` for an error that
 * is not about THIS account (an unreadable account list, a bug) — those
 * propagate instead of being tried around.
 */
/**
 * The row was removed, disabled or rebound while its lease waited on the gate.
 * Still a `NoUsableAccountError` for a pin (that account cannot serve); for any
 * other lease it is a per-account blocker, so the next account is tried.
 */
class AccountChangedDuringLeaseError extends NoUsableAccountError {}

function leaseFailureBlocker(ref: AccountRef, err: unknown): AccountBlocker | null {
  if (err instanceof AccountChangedDuringLeaseError) {
    return {
      kind: "unavailable",
      ref,
      reason: "account changed while leasing",
      upstreamStatus: 503,
    };
  }
  if (err instanceof NeedsReauthError) {
    const recorded = err.blockers.find((b) => b.kind === "needs-reauth");
    return {
      kind: "needs-reauth",
      ref,
      reason:
        recorded?.kind === "needs-reauth" && recorded.reason
          ? recorded.reason
          : "no stored credential",
    };
  }
  if (err instanceof RefreshUnavailableError) {
    return { kind: "unavailable", ref, reason: err.reason, upstreamStatus: err.upstreamStatus };
  }
  if (err instanceof PersistOutcomeUnknownError) {
    return {
      kind: "unavailable",
      ref,
      reason: "a token rotation's persist outcome is unknown",
      upstreamStatus: err.upstreamStatus,
    };
  }
  return null;
}

/** One row of `account list` / `account status`. */
export interface AccountDescription {
  ref: AccountRef;
  record: AccountRecord;
  state: AccountState;
  /** True when the state READ failed — "unknown", not "fresh". */
  stateFailed: boolean;
  isActive: boolean;
  /** 0..1, or null when nothing is known. */
  pressure: number | null;
  eligible: boolean;
  blocker: AccountBlocker | null;
  store: string;
}

export interface PoolDescription {
  provider: AccountProvider;
  accounts: AccountDescription[];
  switchAt: number;
  switchAtByWindow: Record<string, number>;
  /** The selection strategy in config (`sticky` when unset), allowance §2.5. */
  strategy: StrategyName;
  poolEnabled: boolean;
  /** Selection-relevant state updates this process could not persist. */
  dropped: readonly { field: string; account: string; reason: string }[];
  /** Account-list source states — `account status` must be able to SAY "failed". */
  sources: ReturnType<AccountRegistry["sources"]>;
}

export interface AccountPoolOptions {
  registry?: AccountRegistry;
  state?: StateStore;
  now?: () => number;
  /** Override the store for every account (tests hand in a fake). */
  storeFactory?: (record: AccountRecord) => TokenStore;
  env?: NodeJS.ProcessEnv;
}

/** The vendor name used in the pinned exhaustion message. */
function vendorName(provider: AccountProvider): string {
  return provider === "openai-codex" ? "Codex" : "Claude";
}

/** The command that re-logs in one account, named in the pinned message. */
function loginCommandFor(ref: AccountRef): string {
  const vendor = ref.provider === "openai-codex" ? "codex" : "claude";
  return `claudish account login ${vendor} ${shellWord(ref.label)}`;
}

/** Selection-observation bugs are never a newly metered unknown auth failure. */
function rethrowSelectionFailure(err: unknown): never {
  if (classifyConnectionError(err) || isAccountsError(err)) throw err;
  throw new RefreshUnavailableError(
    "account selection unavailable",
    err instanceof Error ? err.message : String(err)
  );
}

export class AccountPool {
  readonly provider: AccountProvider;
  private readonly registry: AccountRegistry;
  private readonly state: StateStore;
  private readonly now: () => number;
  private readonly storeFactory: (record: AccountRecord) => TokenStore;
  private readonly env: NodeJS.ProcessEnv;
  private readonly managers = new Map<string, TokenManager>();
  /** Last refresh attempt per account, for the `needsReauth` retry schedule. */
  private readonly lastReauthAttempt = new Map<string, number>();
  /** The last failed lease per account, which deprioritises it for a while. */
  private readonly leaseFailures = new Map<string, AccountLeaseFailure>();

  constructor(provider: AccountProvider, opts: AccountPoolOptions = {}) {
    this.provider = provider;
    this.registry = opts.registry ?? getAccountRegistry();
    this.state = opts.state ?? getStateStore();
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? (() => Date.now());
    this.storeFactory = opts.storeFactory ?? ((record) => storeFor(record.store, this.env));
  }

  /**
   * **The presence fact.** See the header — configuration only, may throw
   * `AccountListUnavailableError`, and neither exhaustion nor an unreadable token
   * store may lower it.
   */
  hasAnyCredentials(): boolean {
    return this.registry.hasConfiguredAccounts(this.provider);
  }

  /** Every configured account, in config order. */
  accounts(): AccountRecord[] {
    return this.registry.listAccounts(this.provider);
  }

  private refOf(record: AccountRecord): AccountRef {
    return { provider: this.provider, id: record.id, label: record.label };
  }

  /**
   * Capture process ranking facts once; another request cannot change this map.
   *
   * `allowance` builds the request's thread hint (§2.2). It runs only while the
   * provider's `strategy` is `ebr` or `lookahead`, so a sticky pool pays for no
   * hashing, and a throw from it leaves the hint absent.
   */
  createSelectionContext(allowance?: () => AllowanceSelectionHint): AccountSelectionContext {
    const context: AccountSelectionContext = {
      provider: this.provider,
      failed: new Map(),
      leaseFailures: new Map(this.leaseFailures),
      reauthAttempts: new Map(this.lastReauthAttempt),
    };
    if (allowance && this.allowanceStrategyOn()) {
      try {
        context.allowance = allowance();
      } catch {
        /* advisory: no hint, the ranker sees an unknown thread */
      }
    }
    return context;
  }

  /** `strategy` is `ebr` or `lookahead`. Never throws: an unreadable list reads as sticky. */
  private allowanceStrategyOn(): boolean {
    try {
      const strategy = this.registry.snapshot(this.provider).settings[this.provider]?.strategy;
      return strategy !== undefined && strategy !== "sticky";
    } catch {
      return false;
    }
  }

  /** One registry read, one shared-state read, one evaluation time. No token I/O. */
  private evaluate(opts: AcquireOptions, context: AccountSelectionContext): PoolEvaluation {
    try {
      if (context.provider !== this.provider)
        throw new Error("selection context belongs to another claudish provider");
      const snapshot = this.registry.snapshot(this.provider);
      const records = snapshot.accounts[this.provider];
      const settings = snapshot.settings[this.provider];
      const now = this.now();
      const read = this.state.read();
      const providerState = read.state.providers[this.provider];
      const candidates = records.map((record, order) => {
        const state = providerState?.accounts[record.id] ?? {};
        const retryDue = isReauthRetryDue(
          state.needsReauth,
          context.reauthAttempts.get(record.id) ?? state.needsReauth?.since ?? 0,
          now
        );
        const failure = context.leaseFailures.get(record.id);
        return {
          ref: this.refOf(record),
          order,
          enabled: record.enabled,
          usage: state.usage ?? null,
          usageFailed: read.kind === "failed",
          isActive: providerState?.active === record.id,
          exhaustedUntil: state.exhaustedUntil,
          exhaustedEstimated: state.exhaustedEstimated,
          needsReauth: state.needsReauth && !retryDue ? state.needsReauth : null,
          recentCredentialFailure:
            failure !== undefined && now - failure.at < LEASE_FAILURE_DEPRIORITIZE_MS,
        } satisfies AccountCandidate;
      });
      const options: SelectOptions = {
        now,
        switchAt: settings?.switchAt ?? DEFAULT_SWITCH_AT,
        switchAtByWindow: settings?.switchAtByWindow ?? {},
        exclude: [...(opts.exclude ?? []), ...Array.from(context.failed.values(), (b) => b.ref)],
        ...(opts.pin ? { pin: opts.pin } : {}),
      };
      // The allowance model (§2.3). Absent `strategy` or `sticky` adds nothing,
      // so `selectAccount` runs the same code path as before the model existed.
      // `safeRanker` is total: it can decline, never throw.
      const ranked =
        settings?.strategy !== undefined && settings.strategy !== "sticky" && !opts.pin;
      const rank = ranked
        ? safeRanker(this.provider, context.allowance ?? null, options)
        : undefined;
      const selectOptions: SelectOptions = rank ? { ...options, rank } : options;
      const selection = selectAccount(candidates, selectOptions);
      return { records, candidates, options, selection, ranked: rank !== undefined };
    } catch (err) {
      return rethrowSelectionFailure(err);
    }
  }

  /** Read-only capacity query. Never leases, heals, refreshes or writes active. */
  errorIfNoEligible(opts: AcquireOptions = {}): AccountsError | null {
    try {
      const context = opts.selectionContext ?? this.createSelectionContext();
      const evaluation = this.evaluate(opts, context);
      return evaluation.selection.kind === "none"
        ? this.noEligibleError(evaluation, context)
        : null;
    } catch (err) {
      return rethrowSelectionFailure(err);
    }
  }

  private settings() {
    return this.registry.settingsFor(this.provider);
  }

  /**
   * Choose an account and hand back a usable token.
   *
   * **A per-account credential failure is tried around, not propagated.** When
   * the chosen account's token cannot be had — it needs a login
   * (`NeedsReauthError`), its refresh is unavailable (`RefreshUnavailableError`),
   * or a rotation's persist outcome is unknown (`PersistOutcomeUnknownError`) —
   * the account is recorded (and deprioritised for
   * {@link LEASE_FAILURE_DEPRIORITIZE_MS}), excluded, and the next eligible
   * account is tried. The loop is bounded to one pass over the account list. A
   * `needsReauth` account whose retry came due is therefore retried WITHOUT
   * failing the request when another account is healthy. One whose stored
   * credential is no longer the one that failed is not waiting on a retry at
   * all: {@link healReauthMarks} clears its mark before selection.
   *
   * A PIN is the exception: `acquire({pin})` is the 401 re-sign of one specific
   * account, and quietly signing a different one would make that retry a
   * different experiment — so the pinned account's failure propagates.
   *
   * When nothing is left, the error is chosen by what was actually found — see
   * the table in `errors.ts`. Quota wording is reserved for a pool with at least
   * one EXHAUSTED account (the design's mixed-pool rule: exhaustion dominates,
   * because that capacity returns on a clock and the chain should advance with
   * the cost warning). A disabled, logged-out or transiently unavailable pool
   * never says "usage limit".
   */
  async acquire(opts: AcquireOptions = {}): Promise<AccountLease> {
    const context = opts.selectionContext ?? this.createSelectionContext();
    // Check exact pins before any heal can read another account's store.
    let evaluation = this.evaluate(opts, context);
    if (opts.pin && evaluation.selection.kind === "none")
      throw this.acquireNoEligibleError(evaluation, context, opts);
    await this.healReauthMarks(context, opts.pin);
    evaluation = this.evaluate(opts, context);
    // One bounded pass, including removals between selection and lease.
    const attempts = evaluation.records.length + 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) evaluation = this.evaluate(opts, context);
      const selection = evaluation.selection;
      if (selection.kind === "none") throw this.acquireNoEligibleError(evaluation, context, opts);
      const { candidate, reason } = selection;
      const record = this.accounts().find(
        (a) => sameAccount(this.refOf(a), candidate.ref) && a.enabled
      );
      if (!record) {
        context.failed.set(candidate.ref.id, {
          kind: "unavailable",
          ref: candidate.ref,
          reason: "removed or disabled in the account list",
          upstreamStatus: 503,
        });
        continue;
      }
      const at = this.now();
      this.lastReauthAttempt.set(record.id, at);
      context.reauthAttempts.set(record.id, at);
      const token = await this.tryLease(record, opts, reason, context);
      if (!token) continue;
      // A lease may await a refresh. Removal/disable/rebinding during that await
      // cannot publish an artifact or move active back to the old account.
      const stillConfigured = this.accounts().some(
        (a) => a.id === record.id && a.enabled && a.store === record.store
      );
      if (!stillConfigured) {
        context.failed.set(record.id, {
          kind: "unavailable",
          ref: candidate.ref,
          reason: "account changed while leasing",
          upstreamStatus: 503,
        });
        if (opts.pin)
          throw new NoUsableAccountError(
            `Pinned ${vendorName(this.provider)} account ${record.label} changed while leasing.`
          );
        continue;
      }
      this.leaseFailures.delete(record.id);
      context.leaseFailures.delete(record.id);
      // Only successful leases may change stickiness; capacity queries never do.
      // Under the allowance model a threaded request keeps its stickiness in the
      // service's thread map instead, so two threads on different accounts do
      // not rewrite `active` on alternate requests (§2.3).
      const threadKey = evaluation.ranked ? (context.allowance?.threadKey ?? null) : null;
      if (!candidate.isActive && !threadKey) {
        await this.state.setActive(this.provider, record.id, this.state.activeId(this.provider));
      }
      if (evaluation.ranked) {
        if (selection.reverted !== undefined)
          log(
            `[accounts] ${this.provider}: allowance model reverted to sticky (${selection.reverted})`
          );
        try {
          getAllowanceService().noteSelection(this.provider, threadKey, record.id, at);
        } catch {
          /* the thread map is advisory; a broken service never fails a lease */
        }
      }
      log(`[accounts] ${this.provider}: selected ${record.label} (${reason})`);
      return {
        account: candidate.ref,
        accessToken: token.accessToken,
        reason,
        selectionContext: context,
        ...(token.record.accountId ? { accountId: token.record.accountId } : {}),
      };
    }
    evaluation = this.evaluate(opts, context);
    if (evaluation.selection.kind === "none")
      throw this.acquireNoEligibleError(evaluation, context, opts);
    throw new RefreshUnavailableError("account list changed during selection");
  }

  /**
   * `noEligibleError` for `acquire`'s throw path, which is the ONE place a
   * pool-wide block reaches the usage ledger: an `AllAccountsExhaustedError`
   * opens a censored interval there (allowance architecture §2.2). Never from
   * `describe()` or `errorIfNoEligible()`, which are capacity queries. The
   * record is synchronous and cannot throw, so the error thrown is unchanged.
   */
  private acquireNoEligibleError(
    evaluation: PoolEvaluation,
    context: AccountSelectionContext,
    opts: AcquireOptions
  ): AccountsError {
    const error = this.noEligibleError(evaluation, context);
    // A PINNED account's exhaustion is not a pool-wide block: other accounts may still serve.
    if (error instanceof AllAccountsExhaustedError && !opts.pin) {
      getAllowanceService().recordNoEligible(this.provider, this.now());
    }
    return error;
  }

  private async tryLease(
    record: AccountRecord,
    opts: AcquireOptions,
    reason: SelectReason,
    context: AccountSelectionContext
  ): Promise<AccessTokenResult | null> {
    const ref = this.refOf(record);
    try {
      return await this.managerFor(record).getAccessToken(ref, tokenOptionsFor(opts, reason));
    } catch (err) {
      if (classifyConnectionError(err)) throw err;
      const blocker = leaseFailureBlocker(ref, err);
      if (!blocker) throw err;
      const evidence = { at: this.now(), blocker };
      this.leaseFailures.set(record.id, evidence);
      context.leaseFailures.set(record.id, evidence);
      context.failed.set(record.id, blocker);
      if (reason === "pinned") throw err;
      log(
        `[accounts] ${this.provider}: ${record.label} could not be leased (${blocker.kind}); trying the next account`
      );
      return null;
    }
  }

  /**
   * The selection-time half of the `needsReauth` self-heal.
   *
   * A marked account is blocked until its retry comes due, and until then it is
   * never leased — so the token manager's own check, which runs on a lease,
   * would leave an account the user has already logged in again blocked for up
   * to 30 minutes. Before selecting, each enabled marked account's stored
   * credential is compared with the material its mark names; one that moved is
   * cleared and is a candidate on THIS request. Same material: nothing changes,
   * and the retry schedule decides.
   *
   * Token material is read only for MARKED accounts, so an unmarked pool reads
   * exactly what it read before. Never throws (see `healNeedsReauth`), apart
   * from an unreadable account list, which the lease loop would raise anyway.
   */
  private async healReauthMarks(context: AccountSelectionContext, pin?: AccountRef): Promise<void> {
    for (const record of this.accounts()) {
      const ref = this.refOf(record);
      if (!record.enabled || (pin && !sameAccount(pin, ref))) continue;
      if (!this.state.stateFor(ref).state.needsReauth) continue;
      if (await this.managerFor(record).healNeedsReauth(ref)) {
        // The retry clock belonged to the mark just cleared.
        this.lastReauthAttempt.delete(record.id);
        context.reauthAttempts.delete(record.id);
      }
    }
  }

  /**
   * Build the error for a pool with nothing eligible left.
   *
   * Every account's REAL state is reported, including one the caller excluded:
   * the rotation after a quota 429 excludes the account it just marked
   * exhausted, and naming it "excluded" would drop its reset from the message
   * and hide the one fact that makes the error a quota error.
   */
  private noEligibleError(
    evaluation: PoolEvaluation,
    context: AccountSelectionContext
  ): AccountsError {
    const { records, options } = evaluation;
    const { now, pin } = options;
    const failed = context.failed;
    const pinned = pin && evaluation.candidates.find((c) => sameAccount(pin, c.ref));
    if (pin && (!pinned || !pinned.enabled || !failed.has(pin.id))) {
      const blockers = evaluation.selection.kind === "none" ? evaluation.selection.blockers : [];
      return new NoUsableAccountError(
        `Pinned ${vendorName(this.provider)} account ${pin.label} cannot serve this request: ` +
          (!pinned
            ? "no longer configured."
            : !pinned.enabled
              ? "disabled."
              : "excluded for this request."),
        blockers
      );
    }
    const candidates = pin
      ? evaluation.candidates.filter((c) => sameAccount(pin, c.ref))
      : evaluation.candidates;
    // Strip request exclusions to recover each account's real quota/reset state.
    const underlyingOpts: SelectOptions = {
      now,
      switchAt: options.switchAt,
      switchAtByWindow: options.switchAtByWindow,
    };
    const blockers: AccountBlocker[] = [];
    for (const candidate of candidates) {
      const underlying = failed.get(candidate.ref.id) ?? blockerFor(candidate, now, underlyingOpts);
      if (underlying) blockers.push(underlying);
      else if ((options.exclude ?? []).some((e) => sameAccount(e, candidate.ref))) {
        blockers.push({ kind: "excluded", ref: candidate.ref });
      }
    }
    // A removed account may still have a real failed-lease observation this request.
    for (const [id, blocker] of failed) {
      if (pin && !sameAccount(pin, blocker.ref)) continue;
      if (!candidates.some((c) => c.ref.id === id)) blockers.push(blocker);
    }
    const vendor = vendorName(this.provider);
    const input = { vendor, total: records.length, blockers, now, loginCommand: loginCommandFor };
    const named = blockers.filter((b) => b.kind !== "excluded");

    if (named.some((b) => b.kind === "exhausted")) {
      return new AllAccountsExhaustedError(buildExhaustedMessage(input), blockers);
    }
    if (named.length > 0 && named.every((b) => b.kind === "needs-reauth")) {
      return new NeedsReauthError(
        `Every ${vendor} account needs a browser login.\n` +
          named.map((b) => `  ${b.ref.label} — run \`${loginCommandFor(b.ref)}\``).join("\n"),
        named
      );
    }
    if (named.some((b) => b.kind === "unavailable")) {
      // Transient: the next attempt may simply work, so this stays non-terminal.
      const statuses = named.flatMap((b) =>
        b.kind === "unavailable" && b.upstreamStatus !== undefined ? [b.upstreamStatus] : []
      );
      const status = statuses.find((s) => s === 429) ?? statuses.find((s) => s !== 503) ?? 503;
      return new RefreshUnavailableError(buildUnusableMessage(input), undefined, blockers, status);
    }
    return new NoUsableAccountError(buildUnusableMessage(input), blockers);
  }

  private managerFor(record: AccountRecord): TokenManager {
    const key = `${record.id}:${record.store}:${record.identity.chatgptAccountId ?? ""}`;
    const existing = this.managers.get(key);
    if (existing) return existing;
    const manager = new TokenManager({
      store: this.storeFactory(record),
      exchange: exchangeFor(this.provider),
      lockPathFor: () => accountRefreshLockPath(record, this.env),
      validateAccount: (_ref, phase) => {
        let rows: AccountRecord[];
        try {
          rows = this.registry.snapshot(this.provider).accounts[this.provider];
        } catch (err) {
          // After the vendor rotated, an unreadable list is not a removal.
          if (phase === "before-persist") return;
          throw err;
        }
        const current = rows.find((row) => row.id === record.id);
        const rebound =
          !current ||
          current.store !== record.store ||
          current.identity.chatgptAccountId !== record.identity.chatgptAccountId;
        if (rebound || (phase === "before-exchange" && !current.enabled)) {
          throw new AccountChangedDuringLeaseError(
            `Account ${record.label} was removed, disabled or rebound during refresh.`
          );
        }
      },
      state: this.state,
      now: this.now,
      env: this.env,
    });
    this.managers.set(key, manager);
    return manager;
  }

  /**
   * Record what a request learned about an account.
   *
   * Errors are logged and surfaced through `account status` rather than
   * swallowed: routing this through `capturePlanUsage`, whose body discards every
   * error as non-fatal, would make a failed `state.json` write invisible — and an
   * exhaustion that was never recorded is an account that gets picked again on
   * the next turn.
   */
  isActive(ref: AccountRef): boolean {
    return this.state.activeId(ref.provider) === ref.id;
  }

  observationState(ref: AccountRef): AccountState {
    return this.state.stateFor(ref).state;
  }

  /** The pending overlay precedes the fallible reporter, not just its disk write. */
  stageOutcome(
    ref: AccountRef,
    outcome: AccountOutcome,
    context: { requestId: string; observedAt: number }
  ): void {
    if (outcome.kind === "quota") {
      this.state.noteQuota(
        ref,
        context.requestId,
        { at: context.observedAt, resetAt: outcome.resetAt, estimated: outcome.estimated },
        outcome.usage
      );
    } else if ("usage" in outcome && outcome.usage) {
      this.state.noteUsage(ref, outcome.usage);
      if (outcome.kind === "ok") this.state.noteSuccessfulUsage(ref, outcome.usage.observedAt);
    }
  }

  noteOutcomeFailure(ref: AccountRef): void {
    this.state.noteOutcomeFailure(ref);
  }

  async report(
    ref: AccountRef,
    outcome: AccountOutcome,
    context?: { requestId: string; observedAt: number }
  ): Promise<void> {
    try {
      switch (outcome.kind) {
        case "usage":
        case "ok":
          if (outcome.usage) {
            if (outcome.kind === "ok")
              this.state.noteSuccessfulUsage(ref, outcome.usage.observedAt);
            let selectionRelevant = true;
            try {
              selectionRelevant = this.crossesThreshold(outcome.usage);
            } catch {
              // Configuration failure must not discard a response observation.
            }
            await this.state.recordUsage(ref, outcome.usage, { selectionRelevant });
          }
          break;
        case "quota":
          if (context) {
            await this.state.markQuota(
              ref,
              context.requestId,
              {
                at: context.observedAt,
                resetAt: outcome.resetAt,
                estimated: outcome.estimated,
              },
              outcome.usage
            );
          } else {
            await this.state.markExhausted(ref, outcome.resetAt, {
              estimated: outcome.estimated,
              ...(outcome.usage ? { usage: outcome.usage } : {}),
            });
          }
          break;
        case "needs-reauth":
          // The FLAG itself is written under the gate by `token-manager.ts`;
          // this path only records that a request saw the condition.
          log(`[accounts] ${ref.label}: reported needs-reauth (${outcome.reason})`);
          break;
        case "http-error":
        case "auth-failed":
        case "transport-error":
          log(`[accounts] ${ref.label}: ${outcome.kind}`);
          break;
      }
    } catch (err) {
      log(`[accounts] failed to record an outcome for ${ref.label}`);
      throw err;
    }
  }

  /** Does this reading put any window at or past its threshold? */
  private crossesThreshold(usage: UsageSnapshot): boolean {
    const settings = this.settings();
    return usage.windows.some(
      (w) => w.usedFraction >= (settings.switchAtByWindow[w.slot] ?? settings.switchAt)
    );
  }

  /** Everything `account list` / `account status` renders. Read-only. */
  describe(): PoolDescription {
    const settings = this.settings();
    const evaluation = this.evaluate({}, this.createSelectionContext());
    const { candidates, records, options: selectOpts } = evaluation;
    const { now } = selectOpts;

    const accounts: AccountDescription[] = candidates.map((candidate, i) => {
      const record = records[i] as AccountRecord;
      const { state, failed } = this.state.stateFor(candidate.ref);
      // Per account, not read off a failed selection: a pool with one healthy
      // account and one exhausted one selects fine, and the user still needs to
      // be told why the second is sitting out.
      const blocker = blockerFor(candidate, now, selectOpts);
      return {
        ref: candidate.ref,
        record,
        state,
        stateFailed: failed,
        isActive: candidate.isActive,
        pressure: pressure(candidate, now),
        eligible: blocker === null,
        blocker,
        store: this.storeFactory(record).describe(),
      };
    });

    return {
      provider: this.provider,
      accounts,
      switchAt: settings.switchAt,
      switchAtByWindow: settings.switchAtByWindow,
      strategy: settings.strategy,
      poolEnabled: settings.enabled,
      dropped: this.state.dropped(),
      sources: this.registry.sources(),
    };
  }
}

// ---------------------------------------------------------------------------
// Process singletons + the test seam
// ---------------------------------------------------------------------------

const pools = new Map<AccountProvider, AccountPool>();

/** The process-wide pool for one provider. */
export function getAccountPool(provider: AccountProvider): AccountPool {
  const existing = pools.get(provider);
  if (existing) return existing;
  const pool = new AccountPool(provider);
  pools.set(provider, pool);
  return pool;
}

/**
 * Install (or with `null`, drop) a pool for one provider.
 *
 * The seam every account test uses instead of `mock.module()`, whose registry is
 * process-global in Bun and has broken sibling e2e files in this repo before.
 */
export function setAccountPoolForTests(provider: AccountProvider, pool: AccountPool | null): void {
  if (pool) pools.set(provider, pool);
  else pools.delete(provider);
}

/** Drop every installed pool. For a test's `afterEach`. */
export function resetAccountPoolsForTests(): void {
  pools.clear();
}
