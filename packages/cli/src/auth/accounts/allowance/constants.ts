/**
 * Every named constant of the allowance model (architecture §1.11), each with
 * its reason. A P-level test passes the constants it depends on explicitly in
 * `cfg`, so tuning a default here never breaks a contract; the defaults are
 * pinned only by `constants.test.ts`, written after the simulator bench (§6
 * step 10). Any change to a default needs a bench report in `ai-docs/benches/`.
 */

import type {
  AllowanceConfig,
  CostPriors,
  CostProvider,
  StrategyName,
  TokenCounts,
} from "./types.js";

/**
 * ω_r / ω_w / ω_o per vendor: API price ratios used as weak priors, because
 * vendor allowance accounting is opaque. OpenAI has no cache-write premium, so
 * a written token is billed as uncached input (ω_w = 1.0). No decision needs a
 * vendor token price.
 */
export const PROVIDER_COST_PRIORS: Readonly<Record<CostProvider, CostPriors>> = {
  "openai-codex": { cacheRead: 0.1, cacheWrite: 1.0, output: 4 },
  anthropic: { cacheRead: 0.1, cacheWrite: 1.25, output: 5 },
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const DEFAULT_ALLOWANCE_CONFIG: Readonly<AllowanceConfig> = {
  seed: 0,
  /** The default changes only through the §4 tournament. */
  strategy: "sticky",
  provider: "openai-codex",
  /** `used-percent` is a whole percent (#49645). */
  QUANTUM_CODEX: 0.01,
  /** `resetAt` is second-granular, and a header and a body can disagree by seconds. */
  EPOCH_TOL_MS: 2 * MINUTE_MS,
  /** Quantization error < δ/Δu = 10 %. */
  CAL_MIN_DELTA: 0.1,
  /** Per week: half weight after about 2 weeks; plans change mid-month. */
  CAL_FORGET: 0.7,
  /** Under 10 % error on the long side of κ. */
  KAPPA_MIN_LONG: 0.1,
  /** Hard-full floor used ONLY for a window whose β is a prior or null; otherwise r < β·ĉ_req. */
  HARD_MIN_REMAINING: 0.02,
  /** ĉ_req when this request's context is unknown, in tokens. */
  REQ_CTX_DEFAULT: 100_000,
  /** A typical agent turn's output, in tokens. */
  REQ_OUTPUT_EST: 4_000,
  /** Today's `policy.ts` threshold; `sticky` reads it through the real `selectAccount`. */
  SELECTION_THRESHOLD: 0.9,
  /** One quantum; a smaller leftover is noise. */
  LAMBDA_EPS: 0.01,
  /** One unserved cu costs more than ten wasted ones: a block stops work, waste only loses value. */
  UNSERVED_WEIGHT: 10,
  /** Switch only when the gain is at least 2× the cache rebuild. */
  SWITCH_HYSTERESIS: 2,
  /** No opportunistic `ebr`/`lookahead` switch within 30 min of the last one. */
  SWITCH_DWELL_MS: 30 * MINUTE_MS,
  /** The thread's expected end: the median remaining active hours of a thread. */
  SESSION_TAIL_H: 3,
  /** The search's rollout and waste horizon: four 5h refills and the next day, not far resets. */
  LOOKAHEAD_HORIZON_H: 24,
  /** Branch points per sequence; 5⁴ = 625 leaves at 5 accounts. gpt #1 needs 4. */
  LOOKAHEAD_DEPTH: 4,
  /** Rolled-out segments per plan; bounds the cost when pools grow. */
  LOOKAHEAD_NODE_BUDGET: 4096,
  /** A reading this far (window fraction) from the plan's projection makes the plan stale. */
  PLAN_DRIFT: 0.05,
  /** A plan never outlives the hourly forecast. */
  PLAN_MAX_AGE_MS: HOUR_MS,
  /** 7d runs separated by less service than this are one gap (sliding nightly releases). */
  GAP_MERGE_H: 2,
  /** 7 d + 24 h = 192 buckets, plus room for a 7 d CLI horizon. */
  SIM_MAX_STEPS: 216,
  /** A gap closed by windows ≤ 6 h is a 5h gap and never alerts. */
  SHORT_WINDOW_MAX_MIN: 360,
  /** Per day; half-life 3.1 d: one refactor day moves the level by 20 % and decays within a week. */
  LEVEL_ALPHA: 0.2,
  /** The hour-of-week factor needs about 2 repeats before it outweighs its parent. */
  PROFILE_TAU_WEEKS: 2,
  PROFILE_TAU_DAYS: 3,
  /** Pseudo-observations for P(active). */
  PI_TAU: 4,
  /** The day factor is the dominant variance; a weak prior. */
  SIGMA0: 0.7,
  NU0: 4,
  /** Short ≈ 1/12 of long, as in the SRE workbook; lead time is measured by the simulator. */
  BURN_LONG_HL_H: 24,
  BURN_SHORT_HL_H: 2,
  /** 1000 for the request-path forecast (memoized); 200 for per-path simulation. */
  FORECAST_PATHS: 1000,
  TRAJ_PATHS: 200,
  /** Owner: a large gap, warned days ahead (F5). */
  WARN_GAP_H: 12,
  WARN_LEAD_H: 72,
  CRIT_GAP_H: 24,
  CRIT_LEAD_H: 24,
  /** Dead band: half the entry gap. */
  WARN_CLEAR_H: 6,
  CRIT_DEESCALATE_H: 12,
  /** Clearing is harder than raising; a short lull is not recovery. */
  ENTRY_HOLD_MS: 15 * MINUTE_MS,
  EXIT_HOLD_MS: 60 * MINUTE_MS,
  EXIT_HOLD_SHORT_MS: 3 * HOUR_MS,
  /** An entry chain whose earlier true evaluation is older restarts. */
  ENTRY_STALE_MS: 6 * HOUR_MS,
  /** The `alertStep` cadence, in production AND in `sim/run.ts`. */
  EVAL_CADENCE_MS: 5 * MINUTE_MS,
  /** Six missed steps at EVAL_CADENCE: a stale exit chain proves nothing. */
  EVAL_GAP_BREAK_MS: 30 * MINUTE_MS,
  /** Gap start estimates move by hours between evaluations. */
  EPISODE_MATCH_MS: 6 * HOUR_MS,
  /** One notice per real change, keyed on the gap at raise. */
  REFIRE_GUARD_MS: 4 * HOUR_MS,
  REFIRE_GROWTH: 1.5,
  /** Bound the state at about 1 MB. */
  READINGS_MAX: 512,
  DEMAND_WEEKS: 6,
  SESSION_TTL_D: 8,
  SESSIONS_MAX: 2048,
};

/**
 * TRAJ_PATHS under `lookahead`: each of its paths replans hourly inside
 * `simulate` (~50–70 ms a path on a dense 5h state against ~1 ms under
 * `sticky`/`ebr`), so 200 paths cannot fit the 0.5 s alert budget. 40 paths
 * keep the p10/p90 band within about ±5 percentile points (orchestrator
 * decision 2 after step 12). Not a config field: the defaults are pinned.
 */
export const LOOKAHEAD_TRAJ_PATHS = 40;

/** The Monte Carlo path count for `cfg`'s strategy (alerts and trajectory alike). */
export function trajPaths(cfg: Pick<AllowanceConfig, "strategy" | "TRAJ_PATHS">): number {
  const paths = Math.max(1, cfg.TRAJ_PATHS);
  return cfg.strategy === "lookahead" ? Math.min(paths, LOOKAHEAD_TRAJ_PATHS) : paths;
}

/**
 * The strategy the alert model simulates (alerts and trajectory) when `strategy`
 * is configured. `lookahead` simulates `ebr`: a cold lookahead alert evaluation
 * measured 3.7 s wall against the 0.5 s budget (sliced, 187 ms longest block),
 * ebr's 390–489 ms. Selection still uses `lookahead`; only the forecast of what
 * it will do is ebr's. `account forecast` discloses it. Lifted when a per-bucket
 * generator `simulate` brings lookahead's cold evaluation under 0.5 s
 * (orchestrator decision after step 13).
 */
export function alertStrategy(strategy: StrategyName): StrategyName {
  return strategy === "lookahead" ? "ebr" : strategy;
}

/** `cfg` as the alert model runs it: `alertStrategy` applied, everything else unchanged. */
export function alertModelConfig<C extends Pick<AllowanceConfig, "strategy">>(cfg: C): C {
  const strategy = alertStrategy(cfg.strategy);
  return strategy === cfg.strategy ? cfg : { ...cfg, strategy };
}

/** The vendor's cost priors for `cfg`. */
export function costPriorsFor(cfg: Pick<AllowanceConfig, "provider">): CostPriors {
  return PROVIDER_COST_PRIORS[cfg.provider];
}

/** cu = uncached + ω_r·cacheRead + ω_w·cacheWrite + ω_o·output, uncached = max(0, input − cacheRead − cacheWrite). */
export function cuOf(tokens: TokenCounts, cfg: Pick<AllowanceConfig, "provider">): number {
  const w = costPriorsFor(cfg);
  const uncached = Math.max(0, tokens.input - tokens.cacheRead - tokens.cacheWrite);
  return (
    uncached +
    w.cacheRead * tokens.cacheRead +
    w.cacheWrite * tokens.cacheWrite +
    w.output * tokens.output
  );
}
