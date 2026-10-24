/**
 * The vocabulary of the account pool: what an account IS, what a usage reading
 * is, and what a request reports back about the account that served it.
 *
 * Deliberately I/O-free and dependency-free, so `policy.ts` can be pure and a
 * test can build any of these by hand.
 *
 * The error taxonomy lives in `errors.ts` and is re-exported here, because the
 * design names the errors as part of this vocabulary and a caller should need
 * exactly one import to speak it.
 */

import type { StrategyName } from "./allowance/types.js";
import type { AccountBlocker } from "./errors.js";

export type {
  AccountBlocker,
  AccountSourceFailure,
  AccountSourceFailureType,
  AccountsErrorInfo,
  NeedsReauthRecord,
} from "./errors.js";
export {
  AccountListInvalidError,
  AccountListUnavailableError,
  AccountsError,
  AllAccountsExhaustedError,
  MeteredEscapeError,
  NeedsReauthError,
  NoUsableAccountError,
  PersistOutcomeUnknownError,
  RefreshUnavailableError,
  buildExhaustedMessage,
  buildUnusableMessage,
  formatReset,
  isAccountsError,
} from "./errors.js";

/**
 * The vendors with a pool in version 1.
 *
 * A closed union rather than a bare string: the provider name is interpolated
 * into lock and token PATHS, and an unvalidated one is a path-traversal surface
 * as well as a typo that would silently create a second, empty account list.
 */
export const ACCOUNT_PROVIDERS = ["native-anthropic", "openai-codex"] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];

export function isAccountProvider(value: unknown): value is AccountProvider {
  return typeof value === "string" && (ACCOUNT_PROVIDERS as readonly string[]).includes(value);
}

/** Where an account's token material is kept. A closed enum, per the design. */
export type AccountStoreKind = "keychain" | "file" | "legacy-codex-file";

/**
 * Who the account is, for display and for duplicate detection.
 *
 * Never a credential. Nothing in this object is secret, which is what lets the
 * account list live in `config.json`.
 */
export interface AccountIdentity {
  /** Anthropic's account uuid, when the profile endpoint reported one. */
  accountUuid?: string;
  /** `chatgpt-account-id`, extracted from the Codex id_token. */
  chatgptAccountId?: string;
  email?: string;
  /** Plan name as the vendor reports it (`pro`, `max`, `plus`) — display only. */
  plan?: string;
}

/**
 * One configured account.
 *
 * `id` is generated and opaque (`^[a-z0-9]{12}$`) and is never user-supplied,
 * because it is interpolated into two paths. `label` is the user-facing handle
 * and is the only thing a command line ever names.
 */
export interface AccountRecord {
  id: string;
  label: string;
  provider: AccountProvider;
  identity: AccountIdentity;
  store: AccountStoreKind;
  /** Absent means enabled. An explicit `false` is the only way to be disabled. */
  enabled: boolean;
  /** ISO 8601. */
  addedAt: string;
  /**
   * True for the Codex `default` account SYNTHESIZED in memory from
   * `~/.claudish/codex-oauth.json`. It is never written into `config.json`, and
   * `account remove` refuses it without `--delete-file`.
   */
  legacy: boolean;
}

/** The identity a request carries so its outcome lands on the right account. */
export interface AccountRef {
  provider: AccountProvider;
  id: string;
  label: string;
}

export interface AccountLeaseFailure {
  at: number;
  blocker: AccountBlocker;
}

/** Mutable evidence owned by ONE inbound request, never transport scratch state. */
export interface AccountSelectionContext {
  provider: AccountProvider;
  /** Actual lease failures on this request; exclusions/blockers survive re-signs. */
  failed: Map<string, AccountBlocker>;
  /** Captured process ranking evidence, updated only by this request's leases. */
  leaseFailures: Map<string, AccountLeaseFailure>;
  reauthAttempts: Map<string, number>;
  /**
   * The allowance model's thread hint (architecture §2.2), set only while the
   * provider's `strategy` is `ebr` or `lookahead`. Data only: `policy.ts` never
   * reads it. `contextTokens` is THIS request's input estimate, never the
   * thread's history.
   */
  allowance?: AllowanceSelectionHint;
}

export interface AllowanceSelectionHint {
  sessionKey: string | null;
  /** `sessionId:fnv1a32(system + "\0" + whole first user message)`; null without a session. */
  threadKey: string | null;
  contextTokens: number | null;
}

export function sameAccount(a: AccountRef, b: AccountRef): boolean {
  return a.provider === b.provider && a.id === b.id;
}

/**
 * One plan window's reading.
 *
 * **`windows[]` carries each window's LENGTH, and the design says so twice.**
 * There is no fixed `{fiveHour, weekly}` pair: Codex reports the duration in
 * `x-codex-<slot>-window-minutes`, and measured on a Pro account the PRIMARY
 * slot was the seven-day window while the secondary reported zero — the opposite
 * of the long-standing assumption. Slot names are positions; the duration is the
 * fact. Anthropic's window set is likewise discovered from the header names
 * rather than pinned.
 */
export interface UsageWindow {
  /**
   * The STABLE slot id: `"primary"`/`"secondary"` for Codex (recovered from
   * which header pair produced the window), the window name for Anthropic.
   * `switchAtByWindow` is keyed on this, never on `displayId` — a formatted
   * duration changes with the user's plan, so a threshold keyed on it silently
   * never matches.
   */
  slot: string;
  /** What a status line should render: `"5h"`, `"7d"`. May equal `slot`. */
  displayId: string;
  /** The window's length, when the vendor reports it. Minutes. */
  lengthMinutes?: number;
  /** 0..1. A fraction, not a percentage — percentages get compared to 0.9 once. */
  usedFraction: number;
  /** Epoch ms when this window resets, when the vendor said. */
  resetAt?: number;
  /** The vendor named THIS window as the one that rejected the request. */
  rejected?: boolean;
}

/** Everything one response told us about one account's plan state. */
export interface UsageSnapshot {
  windows: UsageWindow[];
  /** Epoch ms. The merge rule for two snapshots is newest-`observedAt` wins. */
  observedAt: number;
  /** Plan label as the vendor reports it (`Codex Pro`, `Max`) — display only. */
  label?: string;
}

/**
 * What a request says about the account that served it.
 *
 * Reported from a dedicated call site, never from `capturePlanUsage`, whose body
 * swallows every error as "non-fatal, always" — a failed state write there would
 * be discarded with no diagnostic.
 */
export type AccountOutcome =
  | { kind: "ok"; usage?: UsageSnapshot }
  | { kind: "usage"; usage: UsageSnapshot }
  | { kind: "http-error"; status: number }
  | { kind: "quota"; resetAt: number; estimated: boolean; usage?: UsageSnapshot }
  /** A 401/403 that is NOT quota wording. */
  | { kind: "auth-failed"; status: number }
  /** `invalid_grant`, confirmed under the gate. */
  | { kind: "needs-reauth"; reason: string }
  | { kind: "transport-error"; message: string };

/**
 * Per-vendor pool settings, as they appear in `config.json`.
 *
 * Holds NO secrets and NO `owner` — the named refresher lives in `state.json`
 * alone, because two documents with no rule for which wins is how two processes
 * come to disagree about who may refresh.
 */
export interface SubscriptionAccountsEntry {
  enabled?: boolean;
  /** Switch before the request when a window passes this. Default 0.90. */
  switchAt?: number;
  /** Per-window override, keyed on `UsageWindow.slot`. */
  switchAtByWindow?: Record<string, number>;
  /** ISO 8601 — the one-time notice shown on the first `account add`. */
  noticeAcceptedAt?: string;
  /** Durable opt-out from synthesizing the legacy Codex file after removal. */
  legacyCodexSuppressed?: boolean;
  /** The allowance model's selection strategy. Absent means `sticky`. */
  strategy?: StrategyName;
  /** Bumped by every account-list mutation, so a reader can detect one. */
  generation: number;
  accounts: Array<{
    id: string;
    label: string;
    identity?: AccountIdentity;
    store: AccountStoreKind;
    enabled?: boolean;
    addedAt: string;
  }>;
}

export type SubscriptionAccountsConfig = Partial<
  Record<AccountProvider, SubscriptionAccountsEntry>
>;

/** The default switch threshold, as a fraction. Per window. */
export const DEFAULT_SWITCH_AT = 0.9;

/**
 * `^[a-z0-9]{12}$` — generated, opaque, never user-supplied.
 *
 * Enforced TWICE: by `registry.ts`, which rejects a configured account list
 * carrying any other id, and by `paths.ts`, which refuses to build a lock or
 * token path from one. The id is interpolated into both paths, so a hand-edited
 * `"../../../tmp/x"` would otherwise put a refresh token outside
 * `~/.claudish/accounts`.
 */
export const ACCOUNT_ID_PATTERN = /^[a-z0-9]{12}$/;

/**
 * The id the synthesized legacy Codex account carries.
 *
 * Deliberately OUTSIDE {@link ACCOUNT_ID_PATTERN} (it has a hyphen), so no
 * configured account can ever collide with it, and `registry.ts` rejects a
 * config row that tries. It is the one non-pattern id `paths.ts` accepts, and
 * only under `openai-codex`: the legacy account's refresh gate lives at
 * `locks/openai-codex/legacy-codex.lock`.
 */
export const LEGACY_CODEX_ACCOUNT_ID = "legacy-codex";

/** `^[\w][\w .-]{0,31}$` — user-facing, unique per vendor. */
export const ACCOUNT_LABEL_PATTERN = /^[\w][\w .-]{0,31}$/;
