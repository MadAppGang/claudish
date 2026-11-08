import { describe, expect, test } from "bun:test";
import { allowanceReportSchema } from "../allowance-report-schema.js";
import { buildReport } from "../allowance-service.js";
import {
  GOLDEN_ALLOWANCE_NO_EVIDENCE_ANSWER,
  GOLDEN_ALLOWANCE_WARN_ANSWER,
} from "../allowance-status-golden.js";
import * as M from "./index.js";
import * as scenarios from "./sim/scenarios.js";
import * as traces from "./sim/traces.js";
import type { AllowanceConfig, AllowanceEvent, AllowanceState } from "./types.js";

const H = 3_600_000;
const MIN = 60_000;
const T = Date.parse("2026-10-26T00:00:00Z");
const A = "aaaaaaaaaaaa";
const utc = { offsets: [] };
const cfg: AllowanceConfig = {
  ...M.DEFAULT_ALLOWANCE_CONFIG,
  seed: 7,
  FORECAST_PATHS: 1000,
  TRAJ_PATHS: 2,
  BURN_LONG_HL_H: 24,
  BURN_SHORT_HL_H: 2,
};

function response(at: number, input = 1000): AllowanceEvent {
  return {
    kind: "response",
    id: String(at),
    at,
    account: A,
    session: null,
    model: "contract-model",
    tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
    finalInput: input,
    outcome: "ok",
    windows: [
      {
        key: "len:10080",
        slot: "primary",
        lengthMinutes: 10080,
        usedFraction: 0.2,
        resetAt: T + 100 * H,
        quantum: 0.01,
        rejected: false,
      },
    ],
  };
}

function report(s: AllowanceState, now: number, c = cfg) {
  return buildReport({
    s,
    now,
    horizonMs: H,
    cfg: c,
    cal: utc,
    fc: null,
    labels: new Map([[A, "work"]]),
    alerts: { active: [], blockedNow: false, status: "ok" },
  });
}

describe("allowance F17 leftovers", () => {
  test("L1 sliced forecast yields eleven times for 1000 paths and equals the synchronous result", () => {
    const s = M.observeAll(M.initialState(), [response(T - 3 * H), response(T - MIN)], cfg);
    const sliced = M.forecastSliced(s, T, 24 * H, utc, cfg);
    let yields = 0;
    let next = sliced.next();
    while (!next.done) {
      yields++;
      next = sliced.next();
    }
    expect(yields).toBe(11);
    expect(next.value.paths).toBe(1000);
    expect(next.value).toEqual(M.forecast(s, T, 24 * H, utc, cfg));
  });

  test("L1 no-evidence sliced forecast yields once, then returns zero paths", () => {
    const s = M.initialState();
    const sliced = M.forecastSliced(s, T, H, utc, cfg);
    expect(sliced.next().done).toBe(false);
    const next = sliced.next();
    expect(next.done).toBe(true);
    expect(next.value).toEqual(M.forecast(s, T, H, utc, cfg));
    expect(next.value!.paths).toBe(0);
  });

  test("L2 reports disclose ebr for lookahead, while older v1 reports remain valid", () => {
    const s = M.observeAll(M.initialState(), [response(T - 3 * H)], cfg);
    for (const strategy of ["sticky", "ebr", "lookahead"] as const) {
      expect(report(s, T, { ...cfg, strategy })).toMatchObject({
        strategy,
        alertModel: strategy === "lookahead" ? "ebr" : strategy,
      });
    }
    const old: Record<string, unknown> = { ...GOLDEN_ALLOWANCE_WARN_ANSWER.allowance };
    delete old.alertModel;
    expect(allowanceReportSchema.safeParse(old).success).toBe(true);
    expect(GOLDEN_ALLOWANCE_WARN_ANSWER.allowance.alertModel).toBe("ebr");
    expect(GOLDEN_ALLOWANCE_NO_EVIDENCE_ANSWER.allowance.alertModel).toBe("sticky");
    expect(allowanceReportSchema.safeParse({ ...old, alertModel: "unknown" }).success).toBe(false);
  });

  test("L7 removed helper exports stay absent and trajectory takes five arguments", () => {
    expect("sampleBeta" in M).toBe(false);
    expect("scenarioNamed" in scenarios).toBe(false);
    expect("TRACE_PROFILES" in traces).toBe(false);
    const args: Parameters<typeof M.trajectory> = [M.initialState(), T, H, utc, cfg];
    expect(M.trajectory(...args)).toEqual(M.trajectory(M.initialState(), T, H, utc, cfg));
  });

  test("L8 three turns in forty minutes with fifty minutes of ledger hide both burn rates", () => {
    const now = T + 50 * MIN;
    const s = M.observeAll(
      M.initialState(),
      [10, 25, 40].map((m) => response(T + m * MIN)),
      cfg
    );
    expect(report(s, now).burn).toMatchObject({ long: null, short: null });
    // The pure estimator and alert inputs must not be nulled by the reporting rule.
    expect(M.burnRates(s, now, utc, cfg).short).toBeGreaterThan(0);
  });

  for (const hours of [3, 25]) {
    test("L8 " + hours + " hours of ledger exposes only rates whose half-life is covered", () => {
      const s = M.observeAll(M.initialState(), [response(T - hours * H), response(T - MIN)], cfg);
      const burn = report(s, T).burn;
      expect(burn.short).toBeNumber();
      expect(burn.short).toBeGreaterThanOrEqual(0);
      if (hours < 24) expect(burn.long).toBeNull();
      else {
        expect(burn.long).toBeNumber();
        expect(burn.long).toBeGreaterThanOrEqual(0);
      }
    });
  }

  test("L8 the exact half-life boundary is inclusive and honors explicit constants", () => {
    const s = M.observeAll(M.initialState(), [response(T), response(T + MIN)], cfg);
    const custom = { ...cfg, BURN_LONG_HL_H: 4, BURN_SHORT_HL_H: 1 };
    expect(report(s, T + H - 1, custom).burn.short).toBeNull();
    expect(report(s, T + H, custom).burn.short).toBeNumber();
    expect(report(s, T + 4 * H - 1, custom).burn.long).toBeNull();
    expect(report(s, T + 4 * H, custom).burn.long).toBeNumber();
  });

  test("L8 no evidence reports null burn, including the v1 golden answer", () => {
    for (const value of [
      report(M.initialState(), T),
      GOLDEN_ALLOWANCE_NO_EVIDENCE_ANSWER.allowance,
    ]) {
      expect(value.burn).toMatchObject({ long: null, short: null, sustainable: null });
      expect(allowanceReportSchema.safeParse(value).success).toBe(true);
    }
  });
});
