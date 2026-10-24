import { describe, expect, test } from "bun:test";
import { poolRemaining } from "../allowance-service.js";
import * as api from "./index.js";
import { GPT_8, OPUS_M4, R2, SERVED_TRACES, bucketDemandOf } from "./sim/adversarial.js";
import { oracle } from "./sim/oracle.js";
import { GAP_TRACE_SCALE, exactViews, gapTraceEvents } from "./sim/tournament.js";
import type {
  AccountView,
  AllowanceConfig,
  AllowanceEvent,
  AllowanceState,
  ChooseRequest,
  Forecast,
  Gap,
  ReadingPoint,
  WindowReading,
} from "./types.js";

const M = { ...api };
const H = 3_600_000;
const MIN = 60_000;
const T = Date.parse("2026-10-26T00:00:00Z");
const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const C = "cccccccccccc";
const W = "len:10080";
const S = "len:300";
const utc = { offsets: [] };
const cfg: AllowanceConfig = {
  ...api.DEFAULT_ALLOWANCE_CONFIG,
  seed: 7,
  CAL_MIN_DELTA: 0.1,
  EPOCH_TOL_MS: 120_000,
  KAPPA_MIN_LONG: 0.1,
  SWITCH_HYSTERESIS: 2,
  SWITCH_DWELL_MS: 30 * MIN,
  LOOKAHEAD_HORIZON_H: 24,
  LOOKAHEAD_DEPTH: 4,
  LOOKAHEAD_NODE_BUDGET: 4096,
  SESSION_TAIL_H: 3,
  PLAN_DRIFT: 0.05,
  PLAN_MAX_AGE_MS: H,
  FORECAST_PATHS: 1000,
  TRAJ_PATHS: 32,
  WARN_GAP_H: 12,
  WARN_LEAD_H: 72,
  CRIT_GAP_H: 24,
  CRIT_LEAD_H: 24,
  WARN_CLEAR_H: 6,
  CRIT_DEESCALATE_H: 12,
  ENTRY_HOLD_MS: 15 * MIN,
  EXIT_HOLD_MS: H,
  EXIT_HOLD_SHORT_MS: 3 * H,
  ENTRY_STALE_MS: 6 * H,
  EVAL_GAP_BREAK_MS: 30 * MIN,
  EPISODE_MATCH_MS: 6 * H,
  REFIRE_GUARD_MS: 4 * H,
  REFIRE_GROWTH: 1.5,
};
function reading(u: number, reset = T + 100 * H, key = W): WindowReading {
  return {
    key,
    slot: key === S ? "secondary" : "primary",
    lengthMinutes: key === S ? 300 : 10080,
    usedFraction: u,
    resetAt: reset,
    quantum: 0.01,
    rejected: false,
  };
}
function response(
  at: number,
  cu: number,
  windows: WindowReading[] | null = null,
  account = A,
  session: string | null = null,
  id = String(at) + ":" + account
): AllowanceEvent {
  return {
    kind: "response",
    id,
    at,
    account,
    session,
    model: "contract-model",
    tokens: { input: cu, output: 0, cacheRead: 0, cacheWrite: 0 },
    finalInput: cu,
    windows,
    outcome: "ok",
  };
}
function fold(events: AllowanceEvent[], c = cfg): AllowanceState {
  return M.observeAll(M.initialState(), events, c);
}
function snapshot(u: number, reset = T + 100 * H, account = A, key = W, at = T): AllowanceEvent {
  return { kind: "snapshot", at, account, windows: [reading(u, reset, key)] };
}
function calibrationEvents(account = A, beta = 1e-8, key = W): AllowanceEvent[] {
  const start = T - 8 * 24 * H;
  const reset = T - 1 * H;
  return [
    response(start, 0, [reading(0.1, reset, key)], account),
    response(start + H, 0.12 / beta, [reading(0.22, reset, key)], account),
    response(start + 3 * H, 0.12 / beta, [reading(0.34, reset, key)], account),
    response(start + 6 * H, 0.12 / beta, [reading(0.46, reset, key)], account),
  ];
}
function steady(days: number, rate = 1e6, now = T): AllowanceEvent[] {
  return Array.from({ length: days * 24 }, (_, i) =>
    response(now - (days * 24 - i) * H + 30 * MIN, rate)
  );
}
function history(days = 7, rate = 1e6): AllowanceState {
  const start = T - days * 24 * H;
  const delta = 12 * rate * 1e-8;
  return fold(
    [
      snapshot(0.1, T - H, A, W, start),
      ...steady(days, rate),
      snapshot(0.1 + delta, T - H, A, W, start + 12 * H),
      snapshot(0.3, T + 96 * H),
    ].sort((a, b) => ("at" in a ? a.at : 0) - ("at" in b ? b.at : 0))
  );
}
function view(id = A, remaining = 0.5, reset = T + 10 * H, beta = 1e-8): AccountView {
  return M.finishView(
    {
      account: id,
      order: id === A ? 2 : 1,
      windows: [
        {
          ...reading(1 - remaining, reset),
          remaining,
          provenance: "observed",
          semantics: "fixed-start",
        },
      ],
      beta: { [W]: { value: beta, quality: "calibrated", relSd: 0 } },
      kappa: {},
      externalPerHour: { value: 0, relSd: 0, quality: "calibrated" },
      observedAt: T,
    },
    T
  );
}
function fc(rate: number): Forecast {
  return {
    evidence: "full",
    unit: "cu",
    buckets: Array.from({ length: 216 }, (_, k) => ({ start: T + k * H, mean: rate })),
    cumulative: [],
    scale75: 1,
    scale90: 1,
    paths: 1000,
    key: "contract-flat",
  };
}
function request(
  views: AccountView[],
  a0: string | null = null,
  contextTokens: number | null = 50_000
): ChooseRequest {
  return {
    now: T,
    session: "session",
    thread: "thread",
    threadAccount: a0,
    lastSwitchAt: null,
    poolActive: a0,
    contextTokens,
    eligible: views.map((v) => M.eligibleOfView(v, 0.9)),
  };
}
function decide(
  views: AccountView[],
  rate: number,
  a0: string | null = null,
  contextTokens: number | null = 50_000,
  lastSwitchAt: number | null = null
) {
  const c = { ...cfg, strategy: "lookahead" as const };
  const input = {
    now: T,
    views,
    thread: { account: a0, lastSwitchAt, contextTokens },
    poolActive: a0,
    eligible: views.map((v) => M.eligibleOfView(v, 0.9)),
  };
  const demand = Array(216).fill(rate);
  const plan = M.lookahead.plan!(
    { ...input, demand: { d75: demand, d90: demand }, withLambda: true },
    c
  );
  return {
    input,
    plan,
    decision: M.lookahead.decide(input, plan, c),
    assessment: M.assess(input, plan, c),
  };
}
function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object") {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

describe("observations, semantics and calibration contracts", () => {
  test("S1 seeded draws and gamma shape below one are reproducible", () => {
    expect(M.fnv1a32("a")).toBe(0xe40c292c);
    expect(M.fnv1a32("")).toBe(0x811c9dc5);
    const x = M.mulberry32(7);
    const y = M.mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const n = x();
      expect(n).toBe(y());
      expect(n >= 0 && n < 1).toBe(true);
    }
    const g = M.mulberry32(7);
    let sum = 0;
    for (let i = 0; i < 20_000; i++) sum += M.sampleGamma(g, 0.5);
    expect(sum / 20_000).toBeGreaterThan(0.48);
    expect(sum / 20_000).toBeLessThan(0.52);
  });
  test("S2 positional lengths, named windows and invalid slots", () => {
    const usage = {
      observedAt: T,
      windows: [
        {
          slot: "primary",
          displayId: "7d",
          lengthMinutes: 10080,
          usedFraction: 0.4,
          resetAt: T + H,
        },
      ],
    };
    expect(M.readingsFromSnapshot("openai-codex", usage)?.[0]).toMatchObject({
      key: W,
      quantum: 0.01,
    });
    expect(
      M.windowKey("openai-codex", { slot: "primary", displayId: "?", usedFraction: 0.2 })
    ).toBe("slot:primary");
    expect(
      M.windowKey("native-anthropic", {
        slot: "seven_day_opus",
        displayId: "7d",
        usedFraction: 0.2,
      })
    ).toBe("seven_day_opus");
    expect(
      M.readingsFromSnapshot("openai-codex", {
        ...usage,
        windows: [{ ...usage.windows[0]!, slot: "a b" }],
      })
    ).toBeNull();
    expect(M.readingsFromSnapshot("openai-codex", { ...usage, windows: [] })).toBeNull();
  });
  test("S3-S4 observe is immutable, idempotent and orders reading heads by time", () => {
    const s = deepFreeze(M.initialState());
    const event = response(T, 100, [reading(0.4)]);
    const next = M.observe(s, event, cfg);
    expect(next).not.toBe(s);
    expect(s).toEqual(M.initialState());
    const twice = M.observe(next, event, cfg);
    expect(twice).toEqual(next);
    const late = M.observe(twice, response(T - H, 0, [reading(0.8)]), cfg);
    expect(M.accountView(late, A, T, cfg).windows[0]?.remaining).toBeCloseTo(0.6, 12);
    expect(late.accounts[A]?.windows[W]?.readings).toHaveLength(2);
    expect(late.demand.reduce((n, h) => n + h.cu, 0)).toBe(100);
  });
  test("S5 reset boundaries never create negative calibration spans", () => {
    const points: ReadingPoint[] = [
      { at: T - MIN, usedFraction: 0.98, resetAt: T, rejected: false },
      { at: T + MIN, usedFraction: 0.02, resetAt: T + 168 * H, rejected: false },
    ];
    expect(M.epochOf(points, "fixed-start", 0.01, cfg)).toEqual([0, 1]);
    const s = fold([
      response(T - MIN, 0, [reading(0.98, T)]),
      response(T + MIN, 50, [reading(0.02, T + 168 * H)]),
    ]);
    expect(M.calibration(s, A, cfg).beta[W]).toBeUndefined();
  });
  test("S6 sliding is classified before epochs and calibrates without a prior", () => {
    const events = Array.from({ length: 6 }, (_, i) =>
      response(T + i * 40 * MIN, i ? 150_000 : 0, [
        reading(0.1 + 0.15 * i, T + 5 * H + i * 40 * MIN, S),
      ])
    );
    const s = fold(events);
    const points = s.accounts[A]!.windows[S]!.readings;
    expect(M.classifySemantics(points, cfg)).toBe("sliding");
    expect(M.epochOf(points, "sliding", 0.01, cfg)).toEqual([0, 0, 0, 0, 0, 0]);
    const b = M.calibration(s, A, cfg).beta[S]!;
    expect(b.quality).toBe("calibrated");
    expect(b.value).toBeGreaterThanOrEqual(0.9e-6);
    expect(b.value).toBeLessThanOrEqual(1.1e-6);
  });
  test("S7 stable evidence needs three pairs", () => {
    const points = Array.from({ length: 4 }, (_, i) => ({
      at: T + i * MIN,
      usedFraction: i / 10,
      resetAt: T + 5 * H + (i % 2) * MIN,
      rejected: false,
    }));
    expect(M.classifySemantics(points, cfg)).toBe("fixed-start");
    expect(M.classifySemantics(points.slice(0, 2), cfg)).toBe("unknown");
  });
  test("S8 null snapshots do not retire; two complete omissions do", () => {
    let s = fold([
      { kind: "snapshot", at: T, account: A, windows: [reading(0.2), reading(0.3, T + H, S)] },
      response(T + MIN, 0),
      response(T + 2 * MIN, 0),
    ]);
    expect(M.accountView(s, A, T + 2 * MIN, cfg).windows.map((w) => w.key)).toContain(S);
    s = M.observe(s, snapshot(0.3, T + 100 * H, A, W, T + 3 * MIN), cfg);
    expect(M.accountView(s, A, T + 3 * MIN, cfg).windows.map((w) => w.key)).toContain(S);
    s = M.observe(s, snapshot(0.4, T + 100 * H, A, W, T + 4 * MIN), cfg);
    expect(M.accountView(s, A, T + 4 * MIN, cfg).windows.map((w) => w.key)).not.toContain(S);
  });
  test("S9 one-quantum changes cannot estimate beta", () => {
    const s = fold([response(T, 0, [reading(0.41)]), response(T + H, 50, [reading(0.42)])]);
    expect(M.calibration(s, A, cfg).beta[W]).toBeUndefined();
  });
  test("S10 spans at least ten pp calibrate beta with quantization uncertainty", () => {
    const c = M.calibration(fold(calibrationEvents(A, 0.01)), A, cfg);
    expect(c.beta[W]?.value).toBeCloseTo(0.01, 10);
    expect(c.beta[W]?.quality).toBe("calibrated");
    expect(c.externalPerHour.value).toBeCloseTo(0, 10);
    const coarse = M.calibration(fold(calibrationEvents(A, 0.01).slice(0, 2)), A, cfg).beta[W]!;
    expect(coarse.quality).toBe("coarse");
    expect(coarse.relSd).toBeGreaterThanOrEqual(0.5);
    expect(c.beta[W]!.relSd).toBeGreaterThan(0);
  });
  test("S14-S15 stale future resets stay observed; passed resets infer finite full capacity", () => {
    const old = fold([snapshot(0.95, T + 48 * H, A, W, T - 72 * H)]);
    expect(M.accountView(old, A, T, cfg).windows[0]).toMatchObject({
      remaining: 0.050000000000000044,
      provenance: "observed",
    });
    const inferred = M.accountView(fold([snapshot(1, T - H, A, W, T - 2 * H)]), A, T, cfg);
    expect(inferred.windows[0]).toMatchObject({
      remaining: 1,
      provenance: "reset-inferred",
      resetAt: T + 167 * H,
    });
    expect(M.isRead(inferred)).toBe(true);
    expect(M.usable(inferred)).toBe(true);
  });
  test("S19 censoring is pool-wide, never one-account quota", () => {
    const s = fold([{ kind: "no-eligible", at: T + 50 * MIN }, response(T + 3 * H + 10 * MIN, 1)]);
    expect(s.demand.map((h) => h.censoredMinutes)).toEqual([10, 60, 60, 10]);
    const q = response(T, 0, null, A);
    if (q.kind === "response") q.outcome = "quota";
    expect(fold([q, response(T + MIN, 100, null, B)]).demand[0]).toMatchObject({
      cu: 100,
      censoredMinutes: 0,
    });
  });
});

describe("code-review capacity contracts", () => {
  test("F12 removing an account removes its capacity and re-listing restores it", () => {
    const listed = (ids: string[], at: number): AllowanceEvent => ({
      kind: "accounts",
      at,
      accounts: ids.map((id, order) => ({ id, order, enabled: true, planClass: "pro" })),
    });
    const both = fold([
      listed([A, B], T),
      snapshot(0.5, T + 100 * H, A),
      snapshot(0.25, T + 100 * H, B),
    ]);
    const removed = M.observe(both, listed([A], T + MIN), cfg);
    expect(M.accountViews(removed, T + MIN, cfg).map((v) => v.account)).toEqual([A]);
    expect(M.combinedNow(M.accountViews(removed, T + MIN, cfg)).value).toBeCloseTo(0.5);
    const restored = M.observe(removed, listed([A, B], T + 2 * MIN), cfg);
    expect(M.accountViews(restored, T + 2 * MIN, cfg).map((v) => v.account)).toEqual([A, B]);
    expect(M.combinedNow(M.accountViews(restored, T + 2 * MIN, cfg)).value).toBeCloseTo(1.25);
  });

  test("F16 calibrated remaining and capacity share cu units", () => {
    const views = [view(A, 0.5, T + 100 * H, 0.01)];
    expect(poolRemaining(views)).toEqual({ remainingNow: 50, capacity: 100, unit: "cu" });
    const nested = structuredClone(views[0]!);
    nested.windows.push({ ...nested.windows[0]!, key: S, lengthMinutes: 300, remaining: 0.25 });
    nested.beta[S] = { value: 0.02, quality: "calibrated", relSd: 0 };
    expect(poolRemaining([nested])).toEqual({ remainingNow: 12.5, capacity: 50, unit: "cu" });
    const prior = structuredClone(views[0]!);
    prior.beta[W]!.quality = "prior";
    expect(poolRemaining([prior])).toEqual({
      remainingNow: 0.5,
      capacity: 1,
      unit: "account-fraction",
    });
    expect(poolRemaining([])).toBeNull();
  });
});

describe("capacity and simulation contracts", () => {
  test("S12 combined capacity takes the minimum nested window, then sums accounts", () => {
    const a = view(A, 1, T + 100 * H, 0.02);
    const b = view(B, 1, T + 100 * H, 0.01);
    for (const [v, beta] of [
      [a, 0.05],
      [b, 0.1],
    ] as const) {
      v.windows.push({ ...v.windows[0]!, key: S, lengthMinutes: 300, resetAt: T + 5 * H });
      v.beta[S] = { value: beta, quality: "calibrated", relSd: 0 };
    }
    expect(M.combinedNow([a, b])).toMatchObject({ value: 30, unit: "cu" });
    a.beta[S]!.quality = "prior";
    expect(M.combinedNow([a, b])).toMatchObject({
      unit: "account-fraction",
      assumption: "equal-capacity",
    });
  });
  for (const [reset, expected, tolerance] of [
    [1, 0.23, 0.001],
    [9 + 59 / 60, 0.0503, 0.0005],
  ]) {
    test("S13 floor plus residual deliverable at short reset " + reset, () => {
      const a = view();
      a.windows.push({
        ...a.windows[0]!,
        key: S,
        lengthMinutes: 300,
        remaining: 0.5,
        resetAt: T + reset! * H,
      });
      a.kappa[S] = { value: 10, quality: "calibrated", relSd: 0 };
      expect(Math.abs(M.deliverable(a, T)! - expected!)).toBeLessThan(tolerance!);
      a.kappa[S]!.quality = "coarse";
      expect(M.deliverable(a, T)).toBe(0.5);
    });
  }
  test("S16 unequal beta converts fractions into seventy-five tasks", () => {
    expect(M.combinedNow([view(A, 0.5, T + H, 0.01), view(B, 0.5, T + H, 0.02)]).value).toBe(75);
  });
  test("S17 hard-full is request-specific, not a fixed percentage", () => {
    const a = view(A, 0.02, T + H, 1e-7);
    expect(M.requestCostCu(200_000, cfg)).toBe(216_000);
    expect(M.hardFull(a, 200_000, cfg)).toBe(true);
    expect(M.requestCostCu(20_000, cfg)).toBe(36_000);
    expect(M.hardFull(a, 20_000, cfg)).toBe(false);
    a.beta[W]!.quality = "prior";
    expect(M.hardFull(a, 200_000, cfg)).toBe(false);
  });
  test("S18 overlay replaces only newer readings without changing input views", () => {
    const a = view();
    const fresh = { id: A, order: 1, at: T + 1, readings: [reading(0.2)] };
    const next = M.overlayReadings([a], [fresh], T)[0]!;
    expect(next).not.toBe(a);
    expect(next.windows[0]!.remaining).toBeCloseTo(0.8, 12);
    expect(a.windows[0]!.remaining).toBe(0.5);
    expect(M.overlayReadings([a], [{ ...fresh, at: T }], T)[0]).toBe(a);
    expect(M.overlayReadings([a], [{ ...fresh, readings: null }], T)[0]).toBe(a);
  });
  test("D1 idle exhaustion is not a gap; positive demand while blocked is", () => {
    const a = view(A, 0, T + 10 * H, 0.01);
    const c = { ...cfg, REQ_OUTPUT_EST: 0 };
    const idle = M.simulate([a], Array(12).fill(0), c, { now: T, strategy: M.ebr });
    expect(idle.gaps).toEqual([]);
    expect(idle.blocked.every((b) => !b.blocked)).toBe(true);
    const busy = M.simulate([a], Array(12).fill(1), c, {
      now: T,
      strategy: M.ebr,
      thread: { account: null, lastSwitchAt: null, contextTokens: 0 },
    });
    expect(busy.gaps[0]).toMatchObject({ start: T, end: T + 10 * H });
  });
  test("D2 external usage alone creates the h5 to h100 gap", () => {
    const a = view(A, 0.1, T + 100 * H, 0.01);
    a.externalPerHour = { value: 2, relSd: 0, quality: "calibrated" };
    const r = M.simulate([a], Array(124).fill(0), cfg, { now: T, strategy: M.ebr });
    expect(r.gaps[0]).toMatchObject({ start: T + 5 * H, end: T + 100 * H, kind: "7d" });
  });
  test("P14 sliding releases usage, never a full refill at the first release", () => {
    const a = view(A, 1, T + 5 * H, 0.2);
    a.windows[0] = {
      ...a.windows[0]!,
      key: S,
      lengthMinutes: 300,
      semantics: "sliding",
      releases: [],
    };
    a.beta = { [S]: { value: 0.2, quality: "calibrated", relSd: 0 } };
    const r = M.simulate(
      [M.finishView(a, T)],
      [1, 1, 1, 0, 0, 0],
      { ...cfg, REQ_OUTPUT_EST: 0 },
      { now: T, strategy: M.sticky }
    );
    expect(r.remainingAt[5]![A]![S]).toBeCloseTo(0.6, 10);
  });
});

describe("forecast and digest contracts", () => {
  test("F1 cold window-only rate is in account fractions with broad uncertainty", () => {
    const f = M.forecast(fold([snapshot(0.3, T + 96 * H)]), T, 96 * H, utc, cfg);
    expect(f.evidence).toBe("window-only");
    expect(f.unit).toBe("account-fraction");
    expect(f.buckets).toHaveLength(96);
    expect(Math.abs(f.buckets.reduce((s, b) => s + b.mean, 0) - 0.4)).toBeLessThan(0.005);
    const q = f.cumulative.at(-1)!.q;
    expect(q.p10).toBeLessThan(q.p50);
    expect(q.p50).toBeLessThan(q.p90);
    expect(q.p90 / q.p10).toBeGreaterThanOrEqual(1.5);
  });
  test("F8 no evidence is a valid empty forecast", () => {
    expect(M.forecast(M.initialState(), T, 168 * H, utc, cfg)).toMatchObject({
      evidence: "none",
      unit: "account-fraction",
      buckets: [],
      cumulative: [],
      scale75: 1,
      scale90: 1,
      paths: 0,
    });
  });
  function weekday(now = T, shift = false) {
    const events: AllowanceEvent[] = [];
    for (let i = 21 * 24; i > 0; i--) {
      const at = now - i * H;
      const d = new Date(at);
      const h = d.getUTCHours();
      const day = d.getUTCDay();
      let active = day >= 1 && day <= 5 && h >= 9 && h < 19;
      if (shift && at >= now - 24 * H) {
        if (h >= 15 && h < 19) active = false;
        if (h >= 1 && h < 5) active = true;
      }
      events.push(response(at + 30 * MIN, active ? 10 : 0));
    }
    return fold(
      [...calibrationEvents(A, 0.001), ...events, snapshot(0.3, now + 96 * H, A, W, now)].sort(
        (a, b) => ("at" in a ? a.at : 0) - ("at" in b ? b.at : 0)
      )
    );
  }
  test("F2 weekday and daytime seasonality survive zero weekends", () => {
    const f = M.forecast(weekday(), T, 168 * H, utc, cfg);
    const mean = (k: number) => f.buckets[k]!.mean;
    expect(mean(12)).toBeGreaterThanOrEqual(3 * mean(132));
    expect(mean(12)).toBeGreaterThanOrEqual(3 * mean(3));
    const sum = f.buckets.reduce((s, b) => s + b.mean, 0);
    expect(sum).toBeGreaterThanOrEqual(400);
    expect(sum).toBeLessThanOrEqual(600);
  });
  test("F3 one-day uncertainty is wider than four-week uncertainty", () => {
    const ratios = [1, 28].map((days) => {
      const f = M.forecast(history(days), T, 168 * H, utc, cfg);
      expect(f.evidence).toBe(days === 1 ? "partial" : "full");
      const q = f.cumulative.at(-1)!.q;
      expect(q.p10 <= q.p50 && q.p50 <= q.p90).toBe(true);
      return q.p90 / q.p50;
    });
    expect(ratios[0]!).toBeGreaterThanOrEqual(1.5);
    expect(ratios[1]!).toBeLessThanOrEqual(1.3);
  });
  test("F4 censored zero demand does not train the level downward", () => {
    const events = steady(8).filter((e) => !("at" in e && e.at >= T - 5 * H && e.at < T - 4 * H));
    const s = fold(
      [
        ...events,
        { kind: "no-eligible" as const, at: T - 5 * H },
        response(T - 4 * H - 30 * MIN, 0),
      ].sort((a, b) => ("at" in a ? a.at : 0) - ("at" in b ? b.at : 0))
    );
    expect(M.demandProfile(s, T, utc, cfg).level).toBeCloseTo(24e6, 4);
  });
  test("F5 open-hour burst changes only short burn and is not scaled twice", () => {
    const s = fold(steady(7));
    const b = M.observe(s, response(T + 10 * MIN, 30e6), cfg);
    const now = T + 30 * MIN;
    expect(M.burnRates(b, now, utc, cfg).long).toBeCloseTo(M.burnRates(s, now, utc, cfg).long, 9);
    expect(M.burnRates(b, now, utc, cfg).long / 1e6).toBeCloseTo(1, 6);
    const short = M.burnRates(b, now, utc, cfg).short / 1e6;
    expect(short).toBeGreaterThan(9.5);
    expect(short).toBeLessThan(10);
  });
  test("F6 shifted Friday hours change long burn by the decay-weighted amount", () => {
    const now = Date.parse("2026-10-24T00:00:00Z");
    const ratio =
      M.burnRates(weekday(now, true), now, utc, cfg).long /
      M.burnRates(weekday(now), now, utc, cfg).long;
    expect(ratio).toBeGreaterThanOrEqual(0.88);
    expect(ratio).toBeLessThanOrEqual(0.97);
  });
  test("F7 repeated seed is exact; open-hour demand and full-evidence readings do not move forecast", () => {
    const s = history(28);
    const next = M.observe(s, response(T + 10 * MIN, 1e6, [reading(0.31, T + 96 * H)]), cfg);
    const f = M.forecast(s, T, 168 * H, utc, cfg);
    expect(M.forecast(s, T, 168 * H, utc, cfg)).toEqual(f);
    expect(M.forecast(next, T + 20 * MIN, 168 * H, utc, cfg)).toEqual(f);
    expect(M.seedOf(next, T + 20 * MIN, cfg)).toBe(M.seedOf(s, T, cfg));
    expect(M.burnRates(next, T + 20 * MIN, utc, cfg).short).not.toBe(
      M.burnRates(s, T + 20 * MIN, utc, cfg).short
    );
    const other = M.forecast(s, T, 168 * H, utc, { ...cfg, seed: 8 });
    expect(other.cumulative).not.toEqual(f.cumulative);
    const x = f.cumulative.at(-1)!.q;
    const y = other.cumulative.at(-1)!.q;
    expect(Math.abs(y.p50 / x.p50 - 1)).toBeLessThan(0.02);
  });
  test("F8-F10 horizons are unique, buckets align, local calendar and profile normalization hold", () => {
    const s = history();
    expect(M.forecast(s, T + MIN, 96 * H, utc, cfg).cumulative.map((x) => x.horizonMs)).toEqual([
      24 * H,
      72 * H,
      96 * H,
    ]);
    expect(M.forecast(s, T + MIN, 24 * H, utc, cfg).buckets[0]!.start).toBe(T);
    expect(M.localHourFn({ offsets: [{ from: 0, offsetMinutes: 120 }] })(T).how).toBe(2);
    expect(M.localHourFn(utc)(T - 1).how).toBe(167);
    const p = M.demandProfile(s, T, utc, cfg);
    expect(p.factors.reduce((a, b) => a + b, 0) / 168).toBeCloseTo(1, 10);
  });
});

describe("lookahead decisions and oracle figures", () => {
  test("K1 every served trace reaches the independent oracle under lookahead", () => {
    for (const trace of SERVED_TRACES) {
      const c = {
        ...cfg,
        REQ_OUTPUT_EST: 0,
        SESSION_TAIL_H: trace.params.sessionTailH,
        LOOKAHEAD_HORIZON_H: trace.params.lookaheadHorizonH,
        LOOKAHEAD_DEPTH: trace.params.lookaheadDepth,
        SWITCH_HYSTERESIS: trace.params.switchHysteresis,
      };
      const demand = bucketDemandOf(trace, 216);
      const run = () =>
        M.simulate(exactViews(trace.accounts, trace.start), demand, c, {
          now: trace.start,
          strategy: M.lookahead,
          thread: {
            account: null,
            lastSwitchAt: null,
            contextTokens: trace.params.switchCostCu / 0.9,
          },
        });
      const result = run();
      const expected = oracle({
        start: trace.start,
        accounts: trace.accounts,
        requests: trace.requests,
      }).servedCu;
      expect(result.served.reduce((a, b) => a + b, 0)).toBe(expected);
      expect(run()).toEqual(result);
      if (trace.name.includes("H1")) {
        expect(result.gaps).toEqual([]);
        const ebr = M.simulate(exactViews(trace.accounts, trace.start), demand, c, {
          now: trace.start,
          strategy: M.ebr,
          thread: { account: null, lastSwitchAt: null, contextTokens: 0 },
        });
        expect(ebr.gaps[0]).toMatchObject({
          start: trace.start + 50 * H,
          end: trace.start + 100 * H,
        });
      }
    }
  });
  for (const [name, ra, rb, rate, a0, ctx, expected, reason, gain] of [
    ["1 earlier governing reset", 0.5, 0.5, 2e6, null, 50_000, A, "lookahead-initial", null],
    ["6 hysteresis", 0.5, 0.5, 1000, B, 50_000, B, "lookahead-sticky", 3000],
    ["7 gains exceed rebuild", 0.4, 0.5, 1.5e6, B, 100_000, A, "lookahead-switch", 4.5e6],
    ["8 large context", 0.4, 0.025, 50_000, B, 100_000, B, "lookahead-sticky", 150_000],
    ["8 small context", 0.4, 0.025, 50_000, B, 2000, A, "lookahead-switch", 150_000],
  ] as const) {
    test("K case " + name, () => {
      const a = view(A, ra, T + (name.startsWith("1") || name.startsWith("6") ? 10 : 20) * H);
      const b = view(B, rb, T + (name.startsWith("1") || name.startsWith("6") ? 120 : 100) * H);
      const r = decide([b, a], rate, a0, ctx);
      expect(r.decision).toMatchObject({ account: expected, reason, usedPlan: true });
      if (gain !== null) expect(r.assessment.gainCu).toBeCloseTo(gain, 3);
      if (a0) expect(r.assessment.switchCostCu).toBe(ctx * 0.9);
    });
  }
  test("K7 dwell prevents an otherwise profitable switch", () => {
    expect(
      decide([view(B, 0.5, T + 100 * H), view(A, 0.4, T + 20 * H)], 1.5e6, B, 100_000, T - 10 * MIN)
        .decision
    ).toMatchObject({ account: B, reason: "lookahead-sticky" });
  });
  test("K8 threshold alone does not move a feasible live thread", () => {
    const r = decide([view(A, 0.08, T + 10 * H), view(B, 0.7, T + 120 * H)], 0.5e6, A);
    expect(r.decision).toMatchObject({ account: A, reason: "lookahead-sticky" });
    expect(r.plan.lambda?.[A]).toBe(0);
  });
  test("K9 unread capacity has no search cost and is learned only when read capacity drains", () => {
    const c = view(C);
    c.windows = [];
    c.beta = {};
    const a = view(A, 0.5, T + 10 * H);
    const b = view(B, 0.03, T + 144 * H);
    const r = decide([a, b, c], 2e6);
    expect(r.decision.account).toBe(A);
    expect(r.plan.perFirst[C]).toBeUndefined();
    a.windows[0]!.remaining = 0;
    expect(decide([a, b, c], 2e6).decision).toMatchObject({
      account: C,
      reason: "lookahead-unknown-usage",
    });
  });
  test("K10 public planFor plus choose rejects the short binding window", () => {
    const s = fold([
      ...calibrationEvents(A),
      ...calibrationEvents(A, 1e-8, S),
      ...calibrationEvents(B),
      ...calibrationEvents(B, 1e-8, S),
      { kind: "snapshot", at: T, account: A, windows: [reading(0.2), reading(0.99, T + 3 * H, S)] },
      { kind: "snapshot", at: T, account: B, windows: [reading(0.5), reading(0.1, T + 3 * H, S)] },
    ]);
    const views = M.accountViews(s, T, cfg);
    const req = request(views, null, 20_000);
    const c = { ...cfg, strategy: "lookahead" as const };
    const plan = M.planFor(s, req, utc, c, fc(0.5e6));
    const r = M.choose(s, req, plan, utc, c);
    expect(r.account).toBe(B);
    expect(r.candidates[A]).toMatchObject({ feasible: false, binding: S });
    expect(r.requestCostCu).toBe(36_000);
  });
  test("K12 reset-inferred feasible a0 is read and retained", () => {
    const a = view(A, 0.5, T + 100 * H);
    const b = view(B, 0.5, T + 120 * H);
    b.windows.push({
      ...b.windows[0]!,
      key: S,
      lengthMinutes: 300,
      resetAt: T + 5 * H,
      remaining: 1,
      provenance: "reset-inferred",
    });
    b.beta[S] = { ...b.beta[W]! };
    const r = decide([a, b], 0.5e6, B);
    expect(r.decision).toMatchObject({ account: B, reason: "lookahead-sticky" });
    expect(r.plan.lambda?.[B]).toBeNull();
  });
  test("K14-K16 stale plans fall back without planning on the request path", () => {
    const r = decide([view(A), view(B, 0.5, T + 120 * H)], 2e6);
    expect(M.needsReplan(null, r.input, cfg)).toBe(true);
    expect(M.needsReplan(r.plan, { ...r.input, now: r.plan.nextEventAt }, cfg)).toBe(true);
    expect(M.needsReplan(r.plan, { ...r.input, forecastKey: "changed" }, cfg)).toBe(true);
    expect(M.lookahead.decide({ ...r.input, now: r.plan.nextEventAt }, r.plan, cfg).usedPlan).toBe(
      false
    );
    expect(
      M.planFor(M.initialState(), request([]), utc, { ...cfg, strategy: "lookahead" })
    ).toBeNull();
  });
});

describe("gap, alert, trajectory and contributions contracts", () => {
  function gap(startH = 10, lengthH = 14): Gap {
    return {
      kind: "7d",
      start: T + startH * H,
      end: T + (startH + lengthH) * H,
      lengthMs: lengthH * H,
      binding: [{ account: A, window: W }],
    };
  }
  function step(
    mem: api.AlertMemory | null,
    min: number,
    long: Gap[],
    short = long,
    blockedNow = false,
    level: "warn" | "critical" = "warn"
  ) {
    return M.alertStep(
      mem,
      {
        at: T + min * MIN,
        now: T + min * MIN,
        inputsKey: "contract",
        long,
        short,
        blockedNow,
        level,
      },
      cfg
    );
  }
  test("P26 every live long window constrains the end of a weekly gap", () => {
    const a = view(A, 0.3, T + 108 * H, 0.01);
    const b = view(B, 0.3, T + 132 * H, 0.01);
    a.windows.push({
      ...a.windows[0]!,
      key: "second-week",
      lengthMinutes: 20160,
      resetAt: T + 130 * H,
    });
    a.beta["second-week"] = { value: 0.01, relSd: 0, quality: "calibrated" };
    for (const v of [a, b]) for (const w of v.windows) w.quantum = 0;
    const r = M.simulate(
      [M.finishView(a, T), b],
      Array(216).fill(1),
      { ...cfg, REQ_OUTPUT_EST: 0 },
      { now: T, strategy: M.ebr, thread: { account: null, lastSwitchAt: null, contextTokens: 0 } }
    );
    expect(r.gaps[0]).toMatchObject({ start: T + 60 * H, end: T + 130 * H, lengthMs: 70 * H });
  });
  test("AL9 sustained demand raises WARN with a fifty-percent cut remedy", () => {
    const events: AllowanceEvent[] = [...steady(7, 1.25e6)];
    // Calibration is embedded in the same flat stream: each span's total cu
    // determines its reading delta, so calibration adds no unrelated demand.
    const begin = T - 168 * H;
    const beta = 1e-8;
    const oldReset = T - H;
    for (const account of [A, B]) {
      events.push(snapshot(0.1, oldReset, account, W, begin));
      events.push(snapshot(0.2, oldReset, account, W, begin + 8 * H));
      if (account === B) {
        for (let k = 0; k < 8; k++)
          events.push(response(begin + k * H + MIN, 1.25e6, null, B, null, "B-cal-" + k));
      }
      events.push(snapshot(0.6, T + (account === A ? 120 : 144) * H, account));
    }
    const s = fold(events.sort((a, b) => ("at" in a ? a.at : 0) - ("at" in b ? b.at : 0)));
    expect(M.calibration(s, A, cfg).beta[W]!.value).toBeCloseTo(beta, 12);
    const gs = M.gaps(s, T, 1.25e6, utc, cfg);
    expect(gs[0]!.start / H - T / H).toBeGreaterThanOrEqual(62);
    expect(gs[0]!.start / H - T / H).toBeLessThanOrEqual(66);
    expect(M.remedy(s, T, "warn", utc, cfg)).toMatchObject({ kind: "cut", cutToFraction: 0.5 });
    const first = M.alerts(s, T, null, utc, cfg);
    const raised = M.alerts(s, T + 15 * MIN, first.memory, utc, cfg);
    expect(raised.active.map((a) => a.level)).toEqual(["warn"]);
    expect(raised.active[0]!.remedy).toMatchObject({ kind: "cut", cutToFraction: 0.5 });
  });
  test("AL7 escalation, de-escalation and replayed transition ids", () => {
    const raised = step(step(null, 0, [gap(10, 30)]).memory, 15, [gap(10, 30)]).memory;
    const c0 = step(raised, 15, [gap(10, 30)], undefined, false, "critical");
    const c1 = step(c0.memory, 30, [gap(10, 30)], undefined, false, "critical");
    expect(c1.transition?.to).toBe("escalated");
    expect(step(c0.memory, 30, [gap(10, 30)], undefined, false, "critical").transition).toEqual(
      c1.transition
    );
    let mem = c1.memory;
    for (let m = 35; m <= 95; m += 5) {
      const r = step(mem, m, [gap(10, 10)], undefined, false, "critical");
      expect(r.transition?.to ?? null).toBe(m === 95 ? "deescalated" : null);
      mem = r.memory;
    }
  });
  test("P36 H1 selection serves five but the disclosed alert model predicts a fifty-hour gap", () => {
    const trace = SERVED_TRACES.find((t) => t.name === "opus H1")!;
    const c = { ...cfg, strategy: "lookahead" as const, REQ_OUTPUT_EST: 0 };
    const demand = bucketDemandOf(trace, 216);
    const views = exactViews(trace.accounts, trace.start);
    const opts = {
      now: trace.start,
      thread: { account: null, lastSwitchAt: null, contextTokens: 0 },
    };
    const selection = M.simulate(views, demand, c, { ...opts, strategy: M.lookahead });
    const alertModel = M.simulate(views, demand, M.alertModelConfig(c), {
      ...opts,
      strategy: M.STRATEGIES[M.alertStrategy(c.strategy)],
    });
    expect(selection.served.reduce((n, x) => n + x, 0)).toBe(5);
    expect(selection.gaps).toEqual([]);
    expect(alertModel.gaps[0]).toMatchObject({
      start: trace.start + 50 * H,
      end: trace.start + 100 * H,
      lengthMs: 50 * H,
    });
  });
  test("AL1 requires long and short rate conditions, not a short burst", () => {
    let mem: api.AlertMemory | null = null;
    for (let m = 0; m <= 120; m += 5) {
      const r = step(mem, m, [], [gap(10, 30)]);
      expect(r.transition).toBeNull();
      mem = r.memory;
    }
    const first = step(mem, 125, [gap()]);
    expect(first.transition).toBeNull();
    expect(step(first.memory, 140, [gap()]).transition?.to).toBe("raised");
  });
  test("AL2 entry persistence handles dense, sparse and stale chains", () => {
    for (const [times, raised] of [
      [[0, 5, 10, 15], 15],
      [[0, 40], 40],
      [[0, 420, 435], 435],
    ] as const) {
      let mem: api.AlertMemory | null = null;
      for (const m of times) {
        const r = step(mem, m, [gap(20, 30)]);
        expect(r.transition?.to ?? null).toBe(m === raised ? "raised" : null);
        mem = r.memory;
      }
    }
  });
  test("AL3 exit persistence and gap-at-raise refire guard", () => {
    let mem = step(step(null, 0, [gap()]).memory, 15, [gap()]).memory;
    expect(step(mem, 20, [gap(10, 10)]).transition).toBeNull();
    for (let m = 25; m <= 85; m += 5) {
      const r = step(mem, m, [gap(10, 5)]);
      expect(r.transition?.to ?? null).toBe(m === 85 ? "cleared" : null);
      mem = r.memory;
    }
    for (let m = 145; m <= 175; m += 5) {
      const r = step(mem, m, [gap(10, 13)]);
      expect(r.transition).toBeNull();
      mem = r.memory;
    }
    expect(step(mem, 180, [gap(10, 22)]).transition).toBeNull();
    mem = step(mem, 180, [gap(10, 22)]).memory;
    expect(step(mem, 195, [gap(10, 22)]).transition?.to).toBe("raised");
  });
  test("AL4 episode matches every qualifying gap, not just the longest", () => {
    let mem: api.AlertMemory | null = null;
    const ids = new Set();
    const transitions = [];
    for (const e of OPUS_M4.steps) {
      const convert = (g: { startH: number; lengthH: number }) => gap(g.startH, g.lengthH);
      const r = step(mem, e.atMinutes, e.long.map(convert), e.short.map(convert), e.blockedNow);
      mem = r.memory;
      if (mem.warn.raised) ids.add(mem.warn.episode);
      if (r.transition) transitions.push({ atMinutes: e.atMinutes, to: r.transition.to });
    }
    expect(ids.size).toBe(1);
    expect(transitions).toEqual([{ atMinutes: 15, to: "raised" }]);
  });
  test("AL5 missed exit evaluations are not evidence of recovery", () => {
    let mem = step(step(null, 0, [gap()]).memory, 15, [gap()]).memory;
    mem = step(mem, 20, [gap(10, 5)]).memory;
    mem = step(mem, 51, [gap(10, 5)]).memory;
    for (let m = 56; m <= 111; m += 5) {
      const r = step(mem, m, [gap(10, 5)]);
      expect(r.transition?.to ?? null).toBe(m === 111 ? "cleared" : null);
      mem = r.memory;
    }
  });
  test("AL6 a live block holds the alert despite low-rate projections", () => {
    let mem = step(step(null, 0, [gap(0)]).memory, 15, [gap(0)], undefined, true).memory;
    for (let m = 20; m <= 140; m += 5) {
      const r = step(mem, m, [], [], true);
      expect(r.transition).toBeNull();
      mem = r.memory;
    }
    for (let m = 145; m <= 205; m += 5) {
      const r = step(mem, m, [], [], false);
      expect(r.transition?.to ?? null).toBe(m === 205 ? "cleared" : null);
      mem = r.memory;
    }
  });
  test("AL8 every horizon gap is returned and the longest later one raises critical", () => {
    for (const strategy of ["sticky", "ebr", "lookahead"] as const) {
      const s = fold(gapTraceEvents(R2));
      const c = { ...cfg, strategy };
      const found = M.gaps(s, R2.start, 21 * GAP_TRACE_SCALE, utc, c);
      expect(found[0]).toMatchObject({ start: R2.start + 9 * H, end: R2.start + 10 * H });
      expect(found.some((g) => g.start === R2.start + 14 * H && g.end === R2.start + 100 * H)).toBe(
        true
      );
      const ev = {
        at: R2.start,
        now: R2.start,
        inputsKey: "R2",
        long: found,
        short: found,
        blockedNow: false,
        level: "critical" as const,
      };
      const r = M.alertStep(null, ev, c);
      expect(
        M.alertStep(r.memory, { ...ev, now: R2.start + 15 * MIN, at: R2.start + 15 * MIN }, c)
          .transition?.to
      ).toBe("raised");
      const low = M.gaps(s, R2.start, 15 * GAP_TRACE_SCALE, utc, c).find(
        (g) => g.end === R2.start + 100 * H
      )!;
      expect(low.lengthMs / H).toBeGreaterThanOrEqual(79);
      expect(low.lengthMs / H).toBeLessThanOrEqual(81);
    }
  });
  test("AL10 external-use gap is not addressable by cutting or pausing local work", () => {
    const s = fold(gapTraceEvents(GPT_8));
    const gs = M.gaps(s, GPT_8.start, 0, utc, cfg);
    expect(gs[0]!.start).toBe(GPT_8.start + 5 * H);
    expect(gs[0]!.lengthMs / H).toBe(95);
    const remedy = M.remedy(s, GPT_8.start, "critical", utc, cfg);
    expect(remedy).toEqual({ kind: "not-addressable", reason: "external-use" });
    expect(M.remedyText(remedy!, GPT_8.start + 5 * H, String)).toStartWith(
      "not addressable by pausing claudish work"
    );
    const first = M.alerts(s, GPT_8.start, null, utc, cfg);
    const raised = M.alerts(s, GPT_8.start + 15 * MIN, first.memory, utc, cfg);
    expect(raised.active.some((a) => a.level === "critical")).toBe(true);
    expect(raised.active.every((a) => a.remedy.kind === "not-addressable")).toBe(true);
  });
  test("AL12 no evidence is insufficient and produces no alert", () => {
    expect(M.alerts(M.initialState(), T, null, utc, cfg)).toMatchObject({
      status: "insufficient-evidence",
      active: [],
      transitions: [],
    });
  });
  test("AL14 a new short epoch cannot force-clear an existing weekly alert", () => {
    const s = fold(
      [...gapTraceEvents(R2), ...steady(7, 21e6, R2.start)].sort(
        (a, b) => ("at" in a ? a.at : 0) - ("at" in b ? b.at : 0)
      )
    );
    const c = { ...cfg, TRAJ_PATHS: 8 };
    const first = M.alerts(s, R2.start, null, utc, c, undefined, { payload: false });
    const raised = M.alerts(s, R2.start + 15 * MIN, first.memory, utc, c, undefined, {
      payload: false,
    });
    expect(raised.memory.warn.raised).toBe(true);
    const account = R2.accounts[0]!.id;
    const next = M.observe(
      s,
      {
        kind: "snapshot",
        at: R2.start + 20 * MIN,
        account,
        windows: [reading(0, R2.start + 10 * H), reading(0, R2.start + 25 * H, S)],
      },
      c
    );
    const r = M.alerts(next, R2.start + 20 * MIN, raised.memory, utc, c, undefined, {
      payload: false,
    });
    expect(r.memory.warn.raised).toBe(true);
    expect(r.transitions).toEqual([]);
  });
  test("sliced alert evaluation equals sync, yields per path, and reuses payload", () => {
    const s = fold(
      [...gapTraceEvents(R2), ...steady(7, 21e6, R2.start)].sort(
        (a, b) => ("at" in a ? a.at : 0) - ("at" in b ? b.at : 0)
      )
    );
    const c = { ...cfg, strategy: "lookahead" as const, TRAJ_PATHS: 200 };
    const qualifying = {
      kind: "7d" as const,
      start: R2.start + 14 * H,
      end: R2.start + 100 * H,
      lengthMs: 86 * H,
      binding: [{ account: R2.accounts[0]!.id, window: W }],
    };
    let prior = M.initialAlertMemory();
    for (const minute of [0, 15])
      for (const level of ["warn", "critical"] as const)
        prior = M.alertStep(
          prior,
          {
            at: R2.start + minute * MIN,
            now: R2.start + minute * MIN,
            inputsKey: "entry",
            long: [qualifying],
            short: [qualifying],
            blockedNow: false,
            level,
          },
          c
        ).memory;
    const at = R2.start + 15 * MIN;
    const generator = M.alertsSliced(s, at, prior, utc, c);
    let yields = 0;
    let result: api.AlertsRun;
    for (;;) {
      const next = generator.next();
      if (next.done) {
        result = next.value;
        break;
      }
      yields++;
    }
    expect(yields).toBeGreaterThanOrEqual(200);
    const sync = M.alerts(s, at, prior, utc, c);
    expect(result.memory).toEqual(sync.memory);
    expect(result.active).toEqual(sync.active);
    expect(result.transitions).toEqual(sync.transitions);
    expect(result.active.length).toBeGreaterThan(1);
    expect(new Set(result.active.map((a) => a.pGap)).size).toBe(1);
    const reuse = M.alertsSliced(s, at + 5 * MIN, result.memory, utc, c, undefined, {
      reuse: result.payload,
    });
    let next = reuse.next();
    while (!next.done) next = reuse.next();
    expect(next.value.memory.lastEval).toEqual(result.memory.lastEval);
    expect(next.value.payload).toBe(result.payload);
  });
  test("CO28 identified external drift leaves exact 0.30 / 0.10 / 0.10 attribution", () => {
    const start = T - 8 * 24 * H;
    const reset = T - H;
    const old = [
      response(start, 0, [reading(0.1, reset)]),
      response(start + H, 80, [reading(0.1 + 0.08 + 1 / 30, reset)]),
      response(start + 3 * H, 40, [reading(0.1 + 0.12 + 3 / 30, reset)]),
      response(start + 6 * H, 0, [reading(0.1 + 0.12 + 6 / 30, reset)]),
    ];
    const s = fold([
      ...old,
      snapshot(0.1, T + 100 * H, A, W, T - 3 * H),
      response(T - 2 * H, 300, null, A, "s1"),
      response(T - H, 100, null, A, "s2"),
      snapshot(0.6),
    ]);
    expect(M.calibration(s, A, cfg).beta[W]!.value).toBeCloseTo(0.001, 10);
    const rows = M.contributions(s, { now: T, account: A }, cfg);
    expect(rows.map((r) => r.session)).toEqual(["s1", "s2", "unattributed"]);
    for (const [i, expected] of [0.3, 0.1, 0.1].entries())
      expect(rows[i]!.usedFraction).toBeCloseTo(expected, 9);
  });
  test("CO28 a smaller observed debit scales sessions without negative unattributed use", () => {
    const c = { ...cfg, CAL_MIN_DELTA: 0.31 };
    const start = T - 8 * 24 * H;
    const reset = T - H;
    const old = [
      response(start, 0, [reading(0, reset)]),
      response(start + H, 320, [reading(0.32, reset)]),
      response(start + 3 * H, 320, [reading(0.64, reset)]),
      response(start + 6 * H, 320, [reading(0.96, reset)]),
    ];
    const s = fold(
      [
        ...old,
        snapshot(0.1, T + 100 * H, A, W, T - 3 * H),
        response(T - 2 * H, 300, null, A, "s1"),
        response(T - H, 100, null, A, "s2"),
        snapshot(0.4),
      ],
      c
    );
    const rows = M.contributions(s, { now: T, account: A }, c);
    expect(rows[0]!.usedFraction).toBeCloseTo(0.225, 9);
    expect(rows[1]!.usedFraction).toBeCloseTo(0.075, 9);
    expect(rows.at(-1)!.usedFraction).toBeCloseTo(0, 9);
  });
  test("TR1 reset is one discrete step and trajectory is deterministic with or without forecast", () => {
    const s = fold(
      [...calibrationEvents(A, 1e-7), ...steady(7, 1000), snapshot(0.5, T + 6 * H)].sort(
        (a, b) => ("at" in a ? a.at : 0) - ("at" in b ? b.at : 0)
      )
    );
    const t = M.trajectory(s, T, 24 * H, utc, cfg);
    expect(t.resets.filter((r) => r.at === T + 6 * H)).toEqual([
      { at: T + 6 * H, account: A, window: W, projected: false },
    ]);
    expect(t.forecast[6]!.q.p50).toBeGreaterThan(t.forecast[5]!.q.p50);
    expect(M.trajectory(s, T, 24 * H, utc, cfg)).toEqual(t);
    expect(
      (M.trajectory as (...args: unknown[]) => unknown)(
        s,
        T,
        24 * H,
        utc,
        cfg,
        M.forecast(s, T, 24 * H, utc, cfg)
      )
    ).toEqual(t);
    const spark = M.sparkline(t, 48);
    expect(spark).toHaveLength(48);
    expect(spark).toMatch(/^[▁▂▃▄▅▆▇█▒▓┊ ]*$/u);
    expect(spark).toContain("┊");
    expect(M.sparkline(t, 0)).toBe("");
  });
  test("TR3 inferred historical segments are explicitly marked", () => {
    const s = fold([snapshot(1, T - H, A, W, T - 3 * H)]);
    expect(
      M.trajectory(s, T, 12 * H, utc, cfg).history.some(
        (p) => p.at > T - H && p.provenance === "reset-inferred"
      )
    ).toBe(true);
  });
  test("TR4 empty state has no trajectory or block", () => {
    expect(M.trajectory(M.initialState(), T, 24 * H, utc, cfg)).toMatchObject({
      history: [],
      forecast: [],
      blocked: [],
    });
  });
  test("CO1-CO2 attributed plus unattributed conserves observed usage and ranking", () => {
    const events = [
      ...calibrationEvents(A, 0.001),
      snapshot(0.1, T + 100 * H, A, W, T - 3 * H),
      response(T - 2 * H, 300, null, A, "session-one"),
      response(T - H, 100, null, A, "session-two"),
      snapshot(0.6),
    ];
    const s = fold(events);
    const beta = M.calibration(s, A, cfg).beta[W]!.value;
    const rows = M.contributions(s, { now: T, account: A }, cfg);
    expect(rows.map((r) => r.session)).toEqual(["session-one", "session-two", "unattributed"]);
    const scale = Math.min(1, 0.5 / (400 * beta));
    expect(rows[0]!.usedFraction).toBeCloseTo(300 * beta * scale, 9);
    expect(rows[1]!.usedFraction).toBeCloseTo(100 * beta * scale, 9);
    expect(rows.reduce((n, r) => n + (r.usedFraction ?? 0), 0)).toBeCloseTo(0.5, 9);
    expect(rows.reduce((n, r) => n + r.share, 0)).toBeCloseTo(1, 9);
    expect(rows.at(-1)!.usedFraction).toBeGreaterThanOrEqual(0);
  });
  test("CO3 uncalibrated shares never claim an observed fraction", () => {
    const s = fold([
      snapshot(0.1, T + 100 * H, A, W, T - 2 * H),
      response(T - H, 300, null, A, "s1"),
      snapshot(0.11),
    ]);
    const rows = M.contributions(s, { now: T, account: A }, cfg);
    expect(rows.at(-1)?.session).toBe("unattributed");
    expect(rows.every((r) => r.usedFraction === null && r.exactness === "uncalibrated")).toBe(true);
  });
  test("disclosure maps only the alert model from lookahead to ebr", () => {
    expect(M.alertStrategy("lookahead")).toBe("ebr");
    expect(M.alertStrategy("ebr")).toBe("ebr");
    expect(M.alertModelConfig(cfg)).toBe(cfg);
    const c: AllowanceConfig = { ...cfg, strategy: "lookahead" };
    expect(M.alertModelConfig(c)).toEqual({ ...c, strategy: "ebr" });
    expect(c.strategy).toBe("lookahead");
    const s = fold(gapTraceEvents(R2));
    expect(M.gaps(s, R2.start, 21 * GAP_TRACE_SCALE, utc, c)).toEqual(
      M.gaps(s, R2.start, 21 * GAP_TRACE_SCALE, utc, { ...c, strategy: "ebr" })
    );
    expect(M.trajectory(s, R2.start, 24 * H, utc, c)).toEqual(
      M.trajectory(s, R2.start, 24 * H, utc, { ...c, strategy: "ebr" })
    );
  });
});
