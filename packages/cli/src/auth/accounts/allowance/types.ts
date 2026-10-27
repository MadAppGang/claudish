/**
 * The allowance model's vocabulary (architecture §1.3). Step 1 holds the EVENT
 * types only: what the usage ledger hands the model. The model's own state,
 * views, forecasts and strategies arrive with the steps that build them.
 *
 * Pure by rule (§1.1): no `node:*` import, no clock, no randomness, no
 * `process`, and no import outside `allowance/` except `../types.js` (types
 * only) and `../policy.js` from the three files allowed to. `purity.test.ts`
 * enforces it.
 */

export type Ms = number;
/** `AccountRef.id`. */
export type AccountId = string;
/** The Claude Code session id (`extractSessionId`), stored locally only. */
export type SessionKey = string;
/** In memory only, never persisted (§2.2). */
export type ThreadKey = string;
/** `len:<minutes>` for a positional Codex slot, the name for a named window, else `slot:<slot>`. */
export type WindowKey = string;

/**
 * One request's billed tokens. `input` is billed input across EVERY leg of the
 * request; uncached = max(0, input − cacheRead − cacheWrite).
 */
export interface TokenCounts {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** One window of one reading. */
export interface WindowReading {
  key: WindowKey;
  slot: string;
  lengthMinutes: number | null;
  /** 0..1. */
  usedFraction: number;
  resetAt: Ms | null;
  rejected: boolean;
  /** 0.01 for Codex whole percent; 0 when exact. */
  quantum: number;
}

/** The vendor's plan, lower-cased into a closed set. Anything else is `"other"`. */
export type PlanClass = "free" | "plus" | "pro" | "team" | "business" | "enterprise" | "other";

export type ResponseOutcome = "ok" | "quota" | "error" | "cancelled";

export type AllowanceEvent =
  | {
      kind: "response";
      /** `requestId:attempt:account`. */
      id: string;
      at: Ms;
      account: AccountId;
      session: SessionKey | null;
      model: string;
      tokens: TokenCounts;
      finalInput: number;
      /** null = no usable snapshot, never "windows absent". */
      windows: WindowReading[] | null;
      outcome: ResponseOutcome;
      /** The delegating conversation (ledger `parent`); absent = null. */
      parent?: SessionKey | null;
    }
  /** A state.json reading. */
  | { kind: "snapshot"; at: Ms; account: AccountId; windows: WindowReading[] }
  /**
   * A pool-wide block: opens a censored interval (§1.4). With `until` it is a
   * SEALED interval from an hourly file: [at, until) is censored, and
   * `continues` leaves it open from `until` (a day's end) on.
   */
  | { kind: "no-eligible"; at: Ms; until?: Ms; continues?: boolean }
  | {
      kind: "accounts";
      at: Ms;
      accounts: { id: AccountId; order: number; enabled: boolean; planClass: PlanClass | null }[];
      /** The pool's active account; absent leaves the last one. */
      active?: AccountId | null;
    }
  | {
      kind: "rollup";
      id: string;
      /** The hour's start. */
      hour: Ms;
      account: AccountId;
      session: SessionKey | null;
      model: string;
      n: number;
      tokens: TokenCounts;
      first: WindowReading[] | null;
      last: WindowReading[] | null;
      /** The hour's POOL-WIDE censored minutes, the same on every rollup of that hour. */
      censoredMinutes: number;
      /** The delegating conversation (ledger `parent`); absent = null. */
      parent?: SessionKey | null;
    };

// ---------------------------------------------------------------------------
// Step 3: configuration, state, calibration estimates and account views.

/** The deployable selection rules, and the config enum (§2.5). */
export type StrategyName = "sticky" | "ebr" | "lookahead";

/** The cost-model priors are per vendor, not per claudish provider (§1.5). */
export type CostProvider = "openai-codex" | "anthropic";

/** ω_r / ω_w / ω_o: the cu of one cache-read, cache-write and output token, an uncached input token being 1. */
export interface CostPriors {
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** Local time, DST-correct: the UTC offset from each `from` on. Resets stay in UTC. */
export interface Calendar {
  offsets: { from: Ms; offsetMinutes: number }[];
}

/**
 * Every constant of §1.11, typed, under its own name, plus the seed, the
 * strategy and the vendor whose cost priors apply. A P-level test passes the
 * constants it depends on explicitly, so a tuned default never breaks a
 * contract.
 */
export interface AllowanceConfig {
  seed: number;
  strategy: StrategyName;
  provider: CostProvider;
  QUANTUM_CODEX: number;
  EPOCH_TOL_MS: number;
  CAL_MIN_DELTA: number;
  CAL_FORGET: number;
  KAPPA_MIN_LONG: number;
  HARD_MIN_REMAINING: number;
  REQ_CTX_DEFAULT: number;
  REQ_OUTPUT_EST: number;
  SELECTION_THRESHOLD: number;
  LAMBDA_EPS: number;
  UNSERVED_WEIGHT: number;
  SWITCH_HYSTERESIS: number;
  SWITCH_DWELL_MS: number;
  SESSION_TAIL_H: number;
  LOOKAHEAD_HORIZON_H: number;
  LOOKAHEAD_DEPTH: number;
  LOOKAHEAD_NODE_BUDGET: number;
  PLAN_DRIFT: number;
  PLAN_MAX_AGE_MS: number;
  GAP_MERGE_H: number;
  SIM_MAX_STEPS: number;
  SHORT_WINDOW_MAX_MIN: number;
  LEVEL_ALPHA: number;
  PROFILE_TAU_WEEKS: number;
  PROFILE_TAU_DAYS: number;
  PI_TAU: number;
  SIGMA0: number;
  NU0: number;
  BURN_LONG_HL_H: number;
  BURN_SHORT_HL_H: number;
  FORECAST_PATHS: number;
  TRAJ_PATHS: number;
  WARN_GAP_H: number;
  WARN_LEAD_H: number;
  CRIT_GAP_H: number;
  CRIT_LEAD_H: number;
  WARN_CLEAR_H: number;
  CRIT_DEESCALATE_H: number;
  ENTRY_HOLD_MS: number;
  EXIT_HOLD_MS: number;
  EXIT_HOLD_SHORT_MS: number;
  ENTRY_STALE_MS: number;
  EVAL_CADENCE_MS: number;
  EVAL_GAP_BREAK_MS: number;
  EPISODE_MATCH_MS: number;
  REFIRE_GUARD_MS: number;
  REFIRE_GROWTH: number;
  READINGS_MAX: number;
  DEMAND_WEEKS: number;
  SESSION_TTL_D: number;
  SESSIONS_MAX: number;
}

/** One reading of one window, as the state keeps it. */
export interface ReadingPoint {
  at: Ms;
  usedFraction: number;
  resetAt: Ms | null;
  rejected: boolean;
}

/** The readings of one (account, window key), oldest first: the head is the LAST entry. */
export interface WindowTrack {
  key: WindowKey;
  slot: string;
  lengthMinutes: number | null;
  quantum: number;
  /** Ascending `at`, at most READINGS_MAX (oldest dropped first). */
  readings: ReadingPoint[];
  /** Consecutive COMPLETE snapshots of the account that omitted this window. */
  missedComplete: number;
  /** Omitted by two consecutive complete snapshots: constrains nothing (§1.4). */
  retired: boolean;
}

export interface AccountTrack {
  id: AccountId;
  order: number;
  enabled: boolean;
  planClass: PlanClass | null;
  windows: Record<WindowKey, WindowTrack>;
  /** claudish cu this account served, ascending `at` (a rollup lands at its hour's middle). */
  served: { at: Ms; cu: number }[];
  /** The newest complete snapshot folded so far, so a LATE one never retires a window. */
  lastCompleteAt: Ms | null;
}

/** One hour of the provider's claudish demand. */
export interface HourBucket {
  /** The hour's start. */
  hour: Ms;
  cu: number;
  n: number;
  /** Minutes of the hour the POOL was unavailable (§1.4), at most 60. */
  censoredMinutes: number;
}

export interface SessionTrack {
  firstAt: Ms;
  lastAt: Ms;
  /** cu per (hour, account). */
  hours: { hour: Ms; account: AccountId; cu: number }[];
  tokens: TokenCounts;
  /** Requests per model. */
  models: Record<string, number>;
  /** The conversation that delegated it: the first non-null `parent` folded; absent = null. */
  parent?: SessionKey | null;
}

export interface AllowanceState {
  version: 1;
  accounts: Record<AccountId, AccountTrack>;
  /** Ascending hours, at most DEMAND_WEEKS of them. */
  demand: HourBucket[];
  sessions: Record<SessionKey, SessionTrack>;
  /** Ring of the last 4096 event ids (dedup). */
  seen: string[];
  /** A `no-eligible` opened a censored interval that no successful response has closed yet. */
  censorOpenAt: Ms | null;
  /** The newest event time folded: the state's own "now" for ages, bounds and calibration weights. */
  lastAt: Ms | null;
  /**
   * The account the POOL is on (`state.json` `active`) as of the last
   * `accounts` event: where the alert and trajectory simulations start.
   * Absent = unknown.
   */
  poolActive?: AccountId | null;
}

export type Semantics = "fixed-start" | "sliding" | "unknown";

export interface Estimate {
  value: number;
  relSd: number;
  quality: "prior" | "coarse" | "calibrated";
}

export type Provenance = "observed" | "reset-inferred" | "unknown";

export interface ViewWindow {
  key: WindowKey;
  slot: string;
  /** null ⇔ provenance "unknown" (never read); finite otherwise. */
  remaining: number | null;
  resetAt: Ms | null;
  lengthMinutes: number | null;
  provenance: Provenance;
  semantics: Semantics;
  quantum: number;
  /** The vendor named this window as the one that rejected a request, and it has not reset since. */
  rejected: boolean;
  /** Sliding only: when usage ages out, in window fractions. */
  releases?: { at: Ms; amount: number }[];
}

/**
 * One account as every strategy, the search and the simulator see it.
 * `beta`/`kappa` hold a key only when an estimate exists: an absent β is a
 * null β (no reading of this account and no same-plan prior).
 */
export interface AccountView {
  account: AccountId;
  order: number;
  windows: ViewWindow[];
  /** argmin over live windows of remaining/β (remaining alone unless every β is at least coarse). */
  binding: WindowKey | null;
  /** The longest live window. */
  governing: WindowKey | null;
  /** Governing-window fraction deliverable before the governing reset (§1.5). */
  deliverable: number | null;
  /** Fraction per cu. */
  beta: Record<WindowKey, Estimate>;
  /** Per shorter window, relative to the governing one. */
  kappa: Record<WindowKey, Estimate>;
  /** cu/h not routed by claudish. */
  externalPerHour: Estimate;
  /** The newest reading behind the view, or null for an unread account (the overlay's freshness test). */
  observedAt: Ms | null;
}

// ---------------------------------------------------------------------------
// Step 4: the request the pool hands the model, and the Strategy interface (§1.6).

/** The ten reasons a non-sticky strategy gives; `policy.ts` `SelectReason` includes them. A closed set. */
export type ChooseReason = `${"ebr" | "lookahead"}-${
  | "initial"
  | "sticky"
  | "switch"
  | "forced"
  | "unknown-usage"}`;

export interface EligibleAccount {
  id: AccountId;
  order: number;
  usageFailed: boolean;
  overThreshold: boolean;
  snapshot: WindowReading[] | null;
  /** When `snapshot` was observed: the overlay applies it only when newer than the view's head. */
  snapshotAt: Ms | null;
}

export interface ChooseRequest {
  now: Ms;
  session: SessionKey | null;
  thread: ThreadKey | null;
  /** The thread's last account (shell memory). */
  threadAccount: AccountId | null;
  /** The thread's last strategy switch. */
  lastSwitchAt: Ms | null;
  /** `state.json` active. */
  poolActive: AccountId | null;
  /** AFTER `policy.ts` blockers. */
  eligible: EligibleAccount[];
  /** THIS request's input estimate (§2.2), not the thread's history. */
  contextTokens: number | null;
}

export interface DecisionInput {
  now: Ms;
  /** AFTER `overlayReadings` and the policy blockers. */
  views: AccountView[];
  thread: { account: AccountId | null; lastSwitchAt: Ms | null; contextTokens: number | null };
  poolActive: AccountId | null;
  /** order, usageFailed, overThreshold: what `sticky` reads. */
  eligible: EligibleAccount[];
  /**
   * The current forecast's key, when the caller knows it: a plan made against
   * another forecast is stale (§1.8 `needsReplan`). `plan` records it.
   */
  forecastKey?: string;
}

export interface PlanInput extends DecisionInput {
  /** cu per hourly bucket from `now`. */
  demand: { d75: number[]; d90: number[] };
  /**
   * Compute λ for the report (§1.8 step 6): two full-grid stay simulations.
   * `planFor` asks for it; `simulate` does not, because it drops unread
   * accounts, so λ cannot change one of its decisions.
   */
  withLambda?: boolean;
}

export interface Plan {
  /** `planKey(PlanInput)`: quantised views + thread + demand digest. */
  key: string;
  at: Ms;
  /** The first branch point after `at` (§1.8); the plan is stale from it. */
  nextEventAt: Ms;
  /** The a0 it was planned for. */
  root: AccountId | null;
  /** First account of the best sequence on p75. */
  best: AccountId | null;
  perFirst: Record<AccountId, { j75: number; j90: number; sequence: AccountId[] }>;
  /** Per bucket of the first segment of the best p75 sequence. */
  projected: { at: Ms; remaining: Record<AccountId, Record<WindowKey, number>> }[];
  forecastKey: string;
  /** The node budget ran out (§1.8). */
  truncated: boolean;
  /** λ per account from the stay simulation (§1.8 step 6); null for reset-inferred or unread. */
  lambda?: Record<AccountId, 0 | 1 | null>;
}

export interface Decision {
  /** null ⇔ decline: the pool reverts to sticky. */
  account: AccountId | null;
  reason: ChooseReason | "sticky" | "first-under-threshold" | "lowest-pressure";
  usedPlan: boolean;
}

export interface Strategy {
  /** The last two are simulator baselines only, never deployable. */
  readonly name: StrategyName | "governing-fefo" | "water-fill";
  /** Pure; may be expensive; NEVER on the request path. */
  plan?(input: PlanInput, cfg: AllowanceConfig): Plan;
  /** Pure and cheap: is `plan` stale for this input? */
  needsReplan?(plan: Plan | null, input: DecisionInput, cfg: AllowanceConfig): boolean;
  /** Pure, O(accounts × windows): the only part on the request path. */
  decide(input: DecisionInput, plan: Plan | null, cfg: AllowanceConfig): Decision;
}

export interface Gap {
  kind: "7d" | "5h";
  /** `h_k` of the first blocked bucket. */
  start: Ms;
  /** `h_k` of the first bucket after it that is not blocked (the grid's end when none). */
  end: Ms;
  lengthMs: Ms;
  binding: { account: AccountId; window: WindowKey }[];
}

// ---------------------------------------------------------------------------
// Step 6: the demand profile, the forecast and the burn rates (§1.7).

export type Evidence = "none" | "window-only" | "partial" | "full";

export type ForecastUnit = "cu" | "account-fraction";

export interface Quantiles {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

/**
 * The ledger's demand shape: hour-of-week factors, activity, magnitude shape,
 * level and its uncertainty. Built from CLOSED hours only, so it is stable for
 * the hour whatever the responses inside it do.
 */
export interface DemandProfile {
  /** f_h for local hour-of-week h (0 = Monday 00:00 local), mean 1. */
  factors: number[];
  /** π_h, P(active hour), shrunk to its parents. */
  active: number[];
  /** ν_m, the magnitude's gamma shape. */
  magnitudeShape: number;
  /** ℓ, cu per day, from the ledger; null when no closed uncensored hour exists. */
  level: number | null;
  /** σ², the day factor's log-variance (posterior over the closed days). */
  dayVariance: number;
  /** n_eff: Σ of the daily weights behind `level`. */
  levelWeight: number;
  /** Closed hours read (censored ones included, at their weight). */
  hours: number;
}

/** Demand only: no per-account term and no burn rate (§1.1). */
export interface Forecast {
  evidence: Evidence;
  /** account-fraction ⇒ assumption "equal-capacity". */
  unit: ForecastUnit;
  /** Hourly, from the open hour's start, in `unit` per hour. */
  buckets: { start: Ms; mean: number }[];
  /** At 24 h, 72 h, 7 d (each when within) and the horizon. */
  cumulative: { horizonMs: Ms; q: Quantiles }[];
  /** Q75 / Q90 of the horizon's demand ÷ Σ mean. */
  scale75: number;
  scale90: number;
  paths: number;
  /** `forecastKey` (§1.1). */
  key: string;
}

/** ρ_L, ρ_S in claudish cu per hour, computed fresh on every call (§1.7). */
export interface BurnRates {
  long: number;
  short: number;
}

// ---------------------------------------------------------------------------
// Step 7: the request-path decision and its report (§1.3, §1.8).

export interface ChooseCandidate {
  feasible: boolean;
  read: boolean;
  j75: number | null;
  j90: number | null;
  lambda: 0 | 1 | null;
  deliverable: number | null;
  binding: WindowKey | null;
}

export interface ChooseResult {
  /** null ⇔ decline: the pool reverts to sticky. */
  account: AccountId | null;
  reason: Decision["reason"];
  /** The plan decided on; `stale` = `needsReplan` held, so the decision is sticky's. */
  plan: { key: string; at: Ms; stale: boolean } | null;
  /** Every eligible account. */
  candidates: Record<AccountId, ChooseCandidate>;
  /** min(ΔJ75, ΔJ90) of a0 over a*, in cu; null without a fresh plan or a0. */
  gainCu: number | null;
  /** c_s = ctx·(ω_w − ω_r) in cu; null with ctx unknown. */
  switchCostCu: number | null;
  /** ĉ_req: this request's worst-case cost in cu (§1.8 step 2). */
  requestCostCu: number;
  /** The decision read the plan (false: sticky's fallback, or a non-plan strategy). */
  usedPlan: boolean;
}

// ---------------------------------------------------------------------------
// Step 8: gap alerts (§1.9).

export type AlertLevel = "warn" | "critical";

/**
 * One gap evaluation: every 7d-kind gap of the deployed strategy's simulation at
 * ρ_L and at ρ_S, longest first, in absolute times. `alertStep` filters them by
 * each level's lead, so one evaluation serves both levels. `inputsKey` is what
 * the simulation read: the evaluation is recomputed only when it changes.
 */
export interface GapEval {
  at: Ms;
  inputsKey: string;
  long: Gap[];
  short: Gap[];
}

export type Remedy =
  | { kind: "cut"; cutToFraction: number; until: Ms; pauseMs: Ms | null }
  /** No grid cut works, a pause does. */
  | { kind: "pause"; pauseMs: Ms; until: Ms }
  /** External use alone causes the gap (gpt #8), or no grid point closes it. */
  | { kind: "not-addressable"; reason: "external-use" | "no-grid-point" };

export interface Alert {
  level: AlertLevel;
  raisedAt: Ms;
  episode: string;
  gap: {
    atLongRate: Gap;
    atShortRate: Gap | null;
    /** Over the Monte Carlo paths with a qualifying gap; null when fewer than 10 % have one. */
    start: Quantiles | null;
    end: Quantiles | null;
    lengthMs: Quantiles | null;
  };
  /** Share of Monte Carlo paths with a qualifying WARN gap: payload, never a gate. */
  pGap: number;
  /** In the simulation's unit per hour (cu/h, or W/h in account-fraction). */
  burn: { long: number; short: number; sustainable: number };
  remedy: Remedy;
}

/** One level's hysteresis memory (§1.9 `alertStep`). Plain JSON. */
export interface LevelMemory {
  raised: boolean;
  /** The current entry chain: its true evaluations within ENTRY_STALE of the latest, oldest first. */
  entryChain: Ms[];
  /** The long-rate exit chain: its first evaluation and its length. */
  exitSince: Ms | null;
  exitCount: number;
  /** The short-rate exit chain. */
  exitShortSince: Ms | null;
  exitShortCount: number;
  raisedAt: Ms | null;
  /** G(ρ_L) in ms when the alert was RAISED: the refire guard's yardstick (kept after a clear). */
  gapAtRaise: Ms | null;
  episode: string | null;
  /** The gap the episode currently matches. */
  episodeGap: { start: Ms; end: Ms } | null;
  lastClearedAt: Ms | null;
  lastEvalAt: Ms | null;
}

export interface AlertMemory {
  version: 1;
  warn: LevelMemory;
  critical: LevelMemory;
  /** The last gap evaluation, reused while its `inputsKey` holds. */
  lastEval: GapEval | null;
}

export interface Transition {
  /** `fnv(level | to | episode | raisedAt)`: the shell announces each id once. */
  id: string;
  level: AlertLevel;
  to: "raised" | "cleared" | "escalated" | "deescalated";
  at: Ms;
}

/**
 * The safe pace of one evaluation while no alert is active (`paceScan`): the
 * highest tested rate ρ at which `ρ·f` has no 7d gap ≥ 1 h over the alert
 * horizon, with every tested rate below it clean too. Under an active alert
 * the shell takes the remedy's cut instead, so this is never computed then.
 */
export interface PaceResult {
  /** `inputsKey` of the evaluation that scanned; reused while it holds. */
  key: string;
  /** In the simulation's unit per hour (cu/h, or W/h in account-fraction). */
  rate: number;
  /** ρ_L of that evaluation, in the same unit. */
  simLong: number;
  /** `rate / simLong` when `simLong > 0`, else null: what the shell scales the reported burn by. */
  phi: number | null;
  unit: ForecastUnit;
  /**
   * How it was found: `cut-scan` (ρ_L gaps: the remedy's cut grid on ρ_L),
   * `bisect` (the refill anchor gaps: bisected down to ρ_L), `bracket` (doubled
   * then bisected), `capped` (clean up to PACE_MAX_MULT × the anchor).
   * Diagnostics and tests only.
   */
  basis: "cut-scan" | "bisect" | "bracket" | "capped";
}

export interface AlertsResult {
  memory: AlertMemory;
  /** Raised levels, critical first. */
  active: Alert[];
  transitions: Transition[];
  blockedNow: boolean;
  status: "ok" | "insufficient-evidence";
  /** The safe pace, only when `AlertsOptions.pace` asked for it and no alert is active; else null. */
  pace: PaceResult | null;
}

// ---------------------------------------------------------------------------
// Step 9: trajectory and contributions (§1.10).

export interface Trajectory {
  /** `cu` when every β is at least coarse, else `account-fraction` (equal-size accounts). */
  unit: ForecastUnit;
  /** One point per hour, oldest first, ending at `now`: Σ deliverable from each account's latest reading then. */
  history: { at: Ms; remaining: number; provenance: "observed" | "reset-inferred" }[];
  /** Per bucket from `floor(now/1h)` inside the horizon: combined remaining at the bucket's start over the paths. */
  forecast: { at: Ms; q: Quantiles; pBlocked: number }[];
  /** Every reset of every live window inside the horizon; `projected` after each window's first. */
  resets: { at: Ms; account: AccountId; window: WindowKey; projected: boolean }[];
  /** Maximal runs with `pBlocked ≥ 0.5`: the paths' gap start and end overlapping each run. */
  blocked: { from: Quantiles; to: Quantiles; kind: "7d" | "5h"; probability: number }[];
  /**
   * Each account's FIRST takeover inside the horizon, over the paths: the time
   * quantiles of the paths where it takes over and the share of paths that
   * do (only ≥ MIN_PATH_SHARE). Ordered by p50, then account order.
   */
  switches: { account: AccountId; q: Quantiles; probability: number }[];
  /**
   * Per read account with a fixed governing reset: the governing window's
   * remaining fraction just before that reset (`SimResult.leftoverAtReset`),
   * over the paths that reach it (only when ≥ MIN_PATH_SHARE of them do).
   * `at` is the same on every path: capacity draws vary β, never reset times.
   */
  lostAtReset: Record<AccountId, { at: Ms; q: Quantiles }>;
  /**
   * `history` split per read account: each point is that account's own term of
   * the combined sum, with its own provenance, at the same `at`s (an account
   * with no reading yet at `at` has no point there).
   */
  historyByAccount: Record<AccountId, Trajectory["history"]>;
}

export interface Contribution {
  session: SessionKey | "unattributed";
  /** The session's delegating conversation (`SessionTrack.parent`); null for none and for `unattributed`. */
  parent: SessionKey | null;
  /** `all` when the rows sum several accounts. */
  account: AccountId | "all";
  window: WindowKey;
  /** Of that account's window; null when β is a prior or the row sums several accounts. */
  usedFraction: number | null;
  cu: number;
  /** Of the observed Δu (cu when uncalibrated); the rows and the unattributed row sum to 1. */
  share: number;
  tokens: TokenCounts;
  /** Requests per model. */
  models: Record<string, number>;
  firstAt: Ms;
  lastAt: Ms;
  exactness: "single-session" | "pro-rata" | "external-unidentified" | "uncalibrated";
}
