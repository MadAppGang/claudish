/**
 * Pins every default of the allowance model (architecture §1.11), written after
 * the simulator bench as §6 step 10 requires. A P-level test passes the
 * constants it depends on explicitly, so a tuned default never breaks a
 * contract; this file is the only place the defaults themselves are held.
 *
 * Changing a value here needs a bench report in `ai-docs/benches/` that shows
 * the reason: the first one is `allowance-sim-2026-10-24.md`. Killing
 * mutation: change any default in `constants.ts`.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_ALLOWANCE_CONFIG, PROVIDER_COST_PRIORS } from "./constants.js";
import { DEPLOYABLE } from "./strategies/strategy.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

describe("allowance defaults (§1.11), pinned after the 2026-10-24 bench", () => {
  test("the default strategy stays sticky until a contestant passes the §4 gate", () => {
    expect(DEFAULT_ALLOWANCE_CONFIG.strategy).toBe("sticky");
    expect([...DEPLOYABLE]).toEqual(["sticky", "ebr", "lookahead"]);
  });

  test("cost priors per vendor", () => {
    expect(PROVIDER_COST_PRIORS).toEqual({
      "openai-codex": { cacheRead: 0.1, cacheWrite: 1.0, output: 4 },
      anthropic: { cacheRead: 0.1, cacheWrite: 1.25, output: 5 },
    });
  });

  test("every constant", () => {
    expect({ ...DEFAULT_ALLOWANCE_CONFIG }).toEqual({
      seed: 0,
      strategy: "sticky",
      provider: "openai-codex",
      QUANTUM_CODEX: 0.01,
      EPOCH_TOL_MS: 2 * MINUTE_MS,
      CAL_MIN_DELTA: 0.1,
      CAL_FORGET: 0.7,
      KAPPA_MIN_LONG: 0.1,
      HARD_MIN_REMAINING: 0.02,
      REQ_CTX_DEFAULT: 100_000,
      REQ_OUTPUT_EST: 4_000,
      SELECTION_THRESHOLD: 0.9,
      LAMBDA_EPS: 0.01,
      UNSERVED_WEIGHT: 10,
      SWITCH_HYSTERESIS: 2,
      SWITCH_DWELL_MS: 30 * MINUTE_MS,
      SESSION_TAIL_H: 3,
      LOOKAHEAD_HORIZON_H: 24,
      LOOKAHEAD_DEPTH: 4,
      LOOKAHEAD_NODE_BUDGET: 4096,
      PLAN_DRIFT: 0.05,
      PLAN_MAX_AGE_MS: HOUR_MS,
      GAP_MERGE_H: 2,
      SIM_MAX_STEPS: 216,
      SHORT_WINDOW_MAX_MIN: 360,
      LEVEL_ALPHA: 0.2,
      PROFILE_TAU_WEEKS: 2,
      PROFILE_TAU_DAYS: 3,
      PI_TAU: 4,
      SIGMA0: 0.7,
      NU0: 4,
      BURN_LONG_HL_H: 24,
      BURN_SHORT_HL_H: 2,
      FORECAST_PATHS: 1000,
      TRAJ_PATHS: 200,
      WARN_GAP_H: 12,
      WARN_LEAD_H: 72,
      CRIT_GAP_H: 24,
      CRIT_LEAD_H: 24,
      WARN_CLEAR_H: 6,
      CRIT_DEESCALATE_H: 12,
      ENTRY_HOLD_MS: 15 * MINUTE_MS,
      EXIT_HOLD_MS: 60 * MINUTE_MS,
      EXIT_HOLD_SHORT_MS: 3 * HOUR_MS,
      ENTRY_STALE_MS: 6 * HOUR_MS,
      EVAL_CADENCE_MS: 5 * MINUTE_MS,
      EVAL_GAP_BREAK_MS: 30 * MINUTE_MS,
      EPISODE_MATCH_MS: 6 * HOUR_MS,
      REFIRE_GUARD_MS: 4 * HOUR_MS,
      REFIRE_GROWTH: 1.5,
      READINGS_MAX: 512,
      DEMAND_WEEKS: 6,
      SESSION_TTL_D: 8,
      SESSIONS_MAX: 2048,
    });
  });

  test("the defaults are frozen at the type level and never mutated by a read", () => {
    const before = JSON.stringify(DEFAULT_ALLOWANCE_CONFIG);
    const copy = { ...DEFAULT_ALLOWANCE_CONFIG, UNSERVED_WEIGHT: 99 };
    expect(copy.UNSERVED_WEIGHT).toBe(99);
    expect(JSON.stringify(DEFAULT_ALLOWANCE_CONFIG)).toBe(before);
  });
});
