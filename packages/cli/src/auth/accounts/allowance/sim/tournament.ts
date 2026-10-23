/**
 * The tournament's contestants and its adversarial round (architecture §4).
 *
 * **Contestants**, all behind the ONE `Strategy` interface (§1.6): the three
 * deployable members of `STRATEGIES` exactly as production builds them, plus
 * the baselines `governing-fefo` (order by the governing reset only) and
 * `water-fill` (the most binding remaining at each decision). In a scenario run
 * (`run.ts`) `sticky` is the real `selectAccount` with no `rank`, and every
 * other contestant is the real `selectAccount` with a `rank`: the real `choose`
 * for `ebr` and `lookahead` (the production call path, hook included), the
 * baseline's `decide` over the same views for the two baselines.
 *
 * **The adversarial round** runs EVERY trace of `adversarial.ts`:
 * - served traces through `simulate` over the trace's exact views (β = 1/C,
 *   the §1.8 hand parameters), per contestant, against the §4 table and the
 *   oracle; a four-request trace gives no calibration evidence, so it judges
 *   the strategies, not the learning (scenario runs judge both);
 * - gap traces (R2, gpt #8) through `gaps` on a state folded from public
 *   events (a calibration epoch, then a reading at T0), their level through
 *   `alertStep` at T0 and T0 + 15 min, and gpt #8's remedy through `remedy`;
 * - opus M4 through `alertStep` over its evaluation steps;
 * - R3 through each deployable strategy's `decide` (and `plan`);
 * - the sliding release through `simulate`; the observation traces through
 *   `observeAll`.
 */

import { alertStep, gaps, initialAlertMemory, remedy } from "../alerts.js";
import { accountViews, deliverable, feasible, finishView, isRead } from "../capacity.js";
import { simulate } from "../simulate.js";
import { initialState, observeAll } from "../state.js";
import { STRATEGIES } from "../strategies/strategy.js";
import type {
  AccountView,
  AllowanceConfig,
  AllowanceEvent,
  Calendar,
  ChooseReason,
  Decision,
  Gap,
  GapEval,
  Ms,
  Strategy,
  StrategyName,
  ViewWindow,
  WindowReading,
} from "../types.js";
import {
  ALERT_TRACES,
  type DecisionTrace,
  type EpisodeTrace,
  type GapTrace,
  type ObservationTrace,
  SERVED_TRACES,
  type ServedTrace,
  type SlidingTrace,
  bucketDemandOf,
} from "./adversarial.js";
import { oracle } from "./oracle.js";
import type { VendorAccountSpec, VendorWindowSpec } from "./vendor.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const EPS = 1e-9;
export const UTC: Calendar = { offsets: [{ from: 0, offsetMinutes: 0 }] };

// ---------------------------------------------------------------------------
// Contestants

export type ContestantName = StrategyName | "governing-fefo" | "water-fill";

export interface Contestant {
  name: ContestantName;
  strategy: Strategy;
  /** A member of `DEPLOYABLE`, run through the real `choose`. */
  deployable: boolean;
}

function baselineDecision(
  input: Parameters<Strategy["decide"]>[0],
  cfg: AllowanceConfig,
  order: (a: AccountView, b: AccountView) => number
): Decision {
  const ctx = input.thread.contextTokens;
  const ok = input.views.filter((v) => feasible(v, ctx, cfg));
  const a0 = input.thread.account ?? input.poolActive;
  const best = ok.filter(isRead).sort(order)[0] ?? ok[0];
  // Baselines borrow `ebr-*` reasons: they never reach a ledger row or a log.
  if (!best) return { account: null, reason: "ebr-forced", usedPlan: false };
  const reason: ChooseReason =
    a0 === null
      ? "ebr-initial"
      : !ok.some((v) => v.account === a0)
        ? "ebr-forced"
        : best.account === a0
          ? "ebr-sticky"
          : "ebr-switch";
  return { account: best.account, reason, usedPlan: false };
}

function governingResetAt(v: AccountView): number {
  return v.windows.find((w) => w.key === v.governing)?.resetAt ?? Number.POSITIVE_INFINITY;
}

/** Order by the governing reset only (rev 0's FEFO), then config order. */
export const governingFefo: Strategy = {
  name: "governing-fefo",
  decide(input, _plan, cfg) {
    return baselineDecision(input, cfg, (a, b) => {
      const ra = governingResetAt(a);
      const rb = governingResetAt(b);
      return ra !== rb ? (ra < rb ? -1 : 1) : a.order - b.order;
    });
  },
};

function bindingRemaining(v: AccountView): number {
  return v.windows.find((w) => w.key === v.binding)?.remaining ?? 0;
}

/** The least-used binding window first (water-filling), then config order. */
export const waterFill: Strategy = {
  name: "water-fill",
  decide(input, _plan, cfg) {
    return baselineDecision(
      input,
      cfg,
      (a, b) => bindingRemaining(b) - bindingRemaining(a) || a.order - b.order
    );
  },
};

export const CONTESTANTS: readonly Contestant[] = [
  { name: "sticky", strategy: STRATEGIES.sticky, deployable: true },
  { name: "ebr", strategy: STRATEGIES.ebr, deployable: true },
  { name: "lookahead", strategy: STRATEGIES.lookahead, deployable: true },
  { name: "governing-fefo", strategy: governingFefo, deployable: false },
  { name: "water-fill", strategy: waterFill, deployable: false },
];

export function contestant(name: ContestantName): Contestant {
  const c = CONTESTANTS.find((x) => x.name === name);
  if (!c) throw new RangeError(`unknown contestant ${name}`);
  return c;
}

// ---------------------------------------------------------------------------
// Exact views of vendor accounts (the adversarial traces' hand model)

function governingSpec(a: VendorAccountSpec): VendorWindowSpec | undefined {
  let g = a.windows[0];
  for (const w of a.windows) if (g && w.lengthMinutes > g.lengthMinutes) g = w;
  return g;
}

/** One exact view per account at `start`: β = 1/C (calibrated), κ = β_s/β_g, the true external drift. */
export function exactViews(accounts: readonly VendorAccountSpec[], start: Ms): AccountView[] {
  return accounts.map((a, i) => {
    const g = governingSpec(a);
    const beta: AccountView["beta"] = {};
    const kappa: AccountView["kappa"] = {};
    const windows: ViewWindow[] = a.windows.map((w) => {
      const key = `len:${w.lengthMinutes}`;
      beta[key] = { value: 1 / w.capacityCu, relSd: 0, quality: "calibrated" };
      if (g && w !== g) {
        kappa[key] = { value: g.capacityCu / w.capacityCu, relSd: 0, quality: "calibrated" };
      }
      const used =
        w.semantics === "sliding"
          ? (w.history ?? []).reduce((s, c) => s + c.cu, 0)
          : (w.usedCu ?? 0);
      const releases =
        w.semantics === "sliding"
          ? (w.history ?? []).map((c) => ({
              at: c.at + w.lengthMinutes * MINUTE_MS,
              amount: c.cu / w.capacityCu,
            }))
          : undefined;
      return {
        key,
        slot: w.slot,
        lengthMinutes: w.lengthMinutes,
        remaining: Math.max(0, (w.capacityCu - used) / w.capacityCu),
        resetAt:
          w.semantics === "sliding"
            ? (releases?.[0]?.at ?? null)
            : w.semantics === "first-use"
              ? (w.resetAt ?? null)
              : (w.resetAt ?? start + w.lengthMinutes * MINUTE_MS),
        provenance: "observed",
        semantics:
          w.semantics === "sliding"
            ? "sliding"
            : w.semantics === "first-use"
              ? "unknown"
              : "fixed-start",
        quantum: a.quantum ?? 0.01,
        rejected: false,
        ...(releases ? { releases } : {}),
      };
    });
    const external = a.externalCuPerHour ?? 0;
    return finishView(
      {
        account: a.id,
        order: i + 1,
        windows,
        beta,
        kappa,
        externalPerHour: {
          value: external,
          relSd: 0,
          quality: external > 0 ? "calibrated" : "prior",
        },
        observedAt: start,
      },
      start
    );
  });
}

// ---------------------------------------------------------------------------
// The adversarial round

export interface ServedResult {
  trace: string;
  contestant: ContestantName;
  served: number;
  expected: number | null;
  oracle: number;
  /** 7d gaps in hours from the trace's start. */
  gaps: { startH: number; endH: number }[];
  expectedGaps: { startH: number; endH: number }[] | null;
  pass: boolean;
}

export interface CheckResult {
  trace: string;
  /** The strategy or the check it ran under. */
  under: string;
  pass: boolean;
  detail: string;
}

export interface AdversarialReport {
  served: ServedResult[];
  checks: CheckResult[];
}

function traceCfg(trace: Pick<ServedTrace, "params">, cfg: AllowanceConfig): AllowanceConfig {
  return {
    ...cfg,
    REQ_OUTPUT_EST: 0,
    SESSION_TAIL_H: trace.params.sessionTailH,
    LOOKAHEAD_HORIZON_H: trace.params.lookaheadHorizonH,
    LOOKAHEAD_DEPTH: trace.params.lookaheadDepth,
    SWITCH_HYSTERESIS: trace.params.switchHysteresis,
  };
}

/** The context that makes c_s the trace's switch cost at the cfg's priors (ω_w − ω_r = 0.9 for Codex). */
function contextFor(switchCostCu: number): number {
  return switchCostCu / 0.9;
}

function hoursOf(gs: readonly Gap[], start: Ms): { startH: number; endH: number }[] {
  return gs
    .filter((g) => g.kind === "7d")
    .map((g) => ({ startH: (g.start - start) / HOUR_MS, endH: (g.end - start) / HOUR_MS }));
}

function runServed(trace: ServedTrace, cfg: AllowanceConfig): ServedResult[] {
  const c = traceCfg(trace, cfg);
  const best = oracle({ accounts: trace.accounts, start: trace.start, requests: trace.requests });
  const demand = bucketDemandOf(trace, c.SIM_MAX_STEPS);
  return CONTESTANTS.map((k) => {
    const r = simulate(exactViews(trace.accounts, trace.start), demand, c, {
      now: trace.start,
      strategy: k.strategy,
      thread: {
        account: null,
        lastSwitchAt: null,
        contextTokens: contextFor(trace.params.switchCostCu),
      },
    });
    const served = Math.round(r.served.reduce((a, b) => a + b, 0) * 1e6) / 1e6;
    const promised =
      k.name === "water-fill"
        ? undefined
        : trace.expected.served[k.name as keyof typeof trace.expected.served];
    const expectedGaps =
      k.name === "ebr" || k.name === "lookahead" ? (trace.expected.gaps?.[k.name] ?? null) : null;
    const got = hoursOf(r.gaps, trace.start);
    const gapsOk =
      expectedGaps === null ||
      (expectedGaps.length === got.length &&
        expectedGaps.every(
          (g, i) =>
            Math.abs((got[i]?.startH ?? -1) - g.startH) < EPS &&
            Math.abs((got[i]?.endH ?? -1) - g.endH) < EPS
        ));
    return {
      trace: trace.name,
      contestant: k.name,
      served,
      expected: promised ?? null,
      oracle: best.servedCu,
      gaps: got,
      expectedGaps,
      pass: (promised === undefined || Math.abs(served - promised) < EPS) && gapsOk,
    };
  });
}

// --- gap traces: a state from public events ---------------------------------

function reading(used: number, resetAt: Ms): WindowReading[] {
  return [
    {
      key: "len:10080",
      slot: "primary",
      lengthMinutes: 10_080,
      usedFraction: used,
      resetAt,
      rejected: false,
      quantum: 0.01,
    },
  ];
}

/**
 * The gap traces' cu are scaled by this to real request sizes: with a 100 cu
 * window every request would be hard-full at the default ĉ_req (116 000 cu),
 * so `ebr` and `lookahead` would decline everything. 1 trace cu = 1 Mcu.
 */
export const GAP_TRACE_SCALE = 1e6;

/**
 * The trace's accounts as events: a closed calibration epoch with three spans
 * of Δu 0.12 over 1, 2 and 3 h (cu set so that β = 1/C and η = the account's
 * external drift, both identifiable), then a reading at T0. The epoch closes
 * within the last day, so the evidence is `window-only` and the profile flat:
 * `gaps` then runs the trace's constant rate in every hour.
 */
export function gapTraceEvents(trace: Pick<GapTrace, "accounts" | "start">): AllowanceEvent[] {
  const out: AllowanceEvent[] = [];
  const T0 = trace.start;
  const priorReset = T0 - HOUR_MS;
  trace.accounts.forEach((a, i) => {
    const w = a.windows[0];
    if (!w) return;
    const beta = 1 / (w.capacityCu * GAP_TRACE_SCALE);
    const eta = (a.externalCuPerHour ?? 0) * GAP_TRACE_SCALE * beta;
    let at = T0 - 20 * HOUR_MS + i * MINUTE_MS;
    let used = 0.4;
    const respond = (id: string, cu: number) => {
      out.push({
        kind: "response",
        id: `${id}:0:${a.id}`,
        at,
        account: a.id,
        session: null,
        model: "gpt-6-astra",
        tokens: { input: cu, cacheRead: 0, cacheWrite: 0, output: 0 },
        finalInput: cu,
        windows: reading(Number(used.toFixed(2)), priorReset),
        outcome: "ok",
      });
    };
    respond(`cal0-${i}`, 0);
    [1, 2, 3].forEach((dur, j) => {
      at += dur * HOUR_MS;
      used += 0.12;
      respond(`cal${j + 1}-${i}`, (0.12 - eta * dur) / beta);
    });
    out.push({
      kind: "snapshot",
      at: T0,
      account: a.id,
      windows: reading((w.usedCu ?? 0) / w.capacityCu, w.resetAt ?? T0 + 168 * HOUR_MS),
    });
  });
  const at = (e: AllowanceEvent) => (e.kind === "rollup" ? e.hour : e.at);
  return out.sort((x, y) => at(x) - at(y));
}

/** The levels raised by two evaluations of the same gaps, at T0 and T0 + 15 min. */
function levelOf(gs: readonly Gap[], now: Ms, cfg: AllowanceConfig): "warn" | "critical" | null {
  const sorted = [...gs]
    .filter((g) => g.kind === "7d")
    .sort((a, b) => b.lengthMs - a.lengthMs || a.start - b.start);
  let memory = initialAlertMemory();
  for (const at of [now, now + cfg.ENTRY_HOLD_MS]) {
    const ev: GapEval = { at, inputsKey: "trace", long: sorted, short: sorted };
    for (const level of ["warn", "critical"] as const) {
      memory = alertStep(memory, { ...ev, level, now: at, blockedNow: false }, cfg).memory;
    }
  }
  return memory.critical.raised ? "critical" : memory.warn.raised ? "warn" : null;
}

function runGapTrace(trace: GapTrace, cfg: AllowanceConfig): CheckResult[] {
  const s = observeAll(initialState(), gapTraceEvents(trace), cfg);
  const out: CheckResult[] = [];
  for (const scenario of trace.scenarios) {
    for (const strategy of trace.strategies) {
      const c = { ...cfg, strategy };
      const got = gaps(s, trace.start, scenario.rateCuPerHour * GAP_TRACE_SCALE, UTC, c).filter(
        (g) => g.kind === "7d"
      );
      const hours = hoursOf(got, trace.start);
      // The listed gaps are a prefix: a gap after the last one (B's fresh week
      // running out again before the grid's end) is real and not a miss.
      const gapsOk =
        hours.length >= scenario.gaps.length &&
        scenario.gaps.every((e, i) => {
          const g = hours[i];
          if (!g) return false;
          // An accepted length range is the gap's tolerance: its end is then
          // checked by the length (R2 at 15 cu/h under sticky: A's 10 cu wasted
          // at h10 move the start to h19, 81 h, inside [79, 81]).
          const startOk = e.startRangeH
            ? g.startH >= e.startRangeH[0] && g.startH <= e.startRangeH[1]
            : e.lengthRangeH !== undefined || Math.abs(g.startH - e.startH) < EPS;
          const length = g.endH - g.startH;
          const lengthOk = e.lengthRangeH
            ? length >= e.lengthRangeH[0] && length <= e.lengthRangeH[1]
            : Math.abs(g.endH - e.endH) < EPS;
          return startOk && lengthOk;
        });
      const level = levelOf(got, trace.start, c);
      let remedyOk = true;
      let remedyText = "";
      if (scenario.remedy && scenario.level) {
        const r = remedy(s, trace.start, scenario.level, UTC, c);
        remedyText = r ? `${r.kind}${r.kind === "not-addressable" ? `/${r.reason}` : ""}` : "none";
        remedyOk =
          r !== null &&
          r.kind === scenario.remedy.kind &&
          (r.kind !== "not-addressable" || r.reason === scenario.remedy.reason);
      }
      out.push({
        trace: `${trace.name} @ ${scenario.rateCuPerHour} cu/h`,
        under: strategy,
        pass: gapsOk && level === scenario.level && remedyOk,
        detail: `gaps ${hours.map((g) => `[h${g.startH}, h${g.endH}]`).join(" ") || "none"}; level ${level ?? "none"}${remedyText ? `; remedy ${remedyText}` : ""}`,
      });
    }
  }
  return out;
}

function runEpisodeTrace(trace: EpisodeTrace, cfg: AllowanceConfig): CheckResult {
  const toGap = (g: { startH: number; lengthH: number }): Gap => {
    const start = trace.start + g.startH * HOUR_MS;
    const end = start + g.lengthH * HOUR_MS;
    return {
      kind: "7d",
      start,
      end,
      lengthMs: end - start,
      binding: [{ account: g.startH < 40 ? "xxxxxxxxxxxx" : "yyyyyyyyyyyy", window: "len:10080" }],
    };
  };
  let memory = initialAlertMemory();
  const transitions: { atMinutes: number; to: string }[] = [];
  const episodes = new Set<string>();
  for (const step of trace.steps) {
    const now = trace.start + step.atMinutes * MINUTE_MS;
    const long = step.long.map(toGap).sort((a, b) => b.lengthMs - a.lengthMs);
    const short = step.short.map(toGap).sort((a, b) => b.lengthMs - a.lengthMs);
    const r = alertStep(
      memory,
      {
        at: now,
        inputsKey: `${step.atMinutes}`,
        long,
        short,
        level: trace.level,
        now,
        blockedNow: step.blockedNow,
      },
      cfg
    );
    memory = r.memory;
    if (r.transition) transitions.push({ atMinutes: step.atMinutes, to: r.transition.to });
    const ep = memory[trace.level].episode;
    if (ep) episodes.add(ep);
  }
  const pass =
    JSON.stringify(transitions) === JSON.stringify(trace.expected.transitions) &&
    episodes.size === trace.expected.episodes;
  return {
    trace: trace.name,
    under: "alertStep",
    pass,
    detail: `transitions ${transitions.map((t) => `${t.to}@${t.atMinutes}m`).join(", ") || "none"}; episodes ${episodes.size}`,
  };
}

function runDecisionTrace(trace: DecisionTrace, cfg: AllowanceConfig): CheckResult[] {
  const c = { ...traceCfg(trace, cfg) };
  const views = exactViews(trace.accounts, trace.start);
  const ctx = contextFor(trace.params.switchCostCu);
  const target = views.find((v) => v.account === trace.expected.deliverable.account);
  const d = target ? deliverable(target, trace.start) : null;
  const deliverableOk =
    d !== null &&
    Math.abs(d - trace.expected.deliverable.value) <= trace.expected.deliverable.tolerance;
  return (["sticky", "ebr", "lookahead"] as const).map((name) => {
    const strategy = STRATEGIES[name];
    const input = {
      now: trace.start,
      views,
      thread: { account: trace.threadAccount, lastSwitchAt: null, contextTokens: ctx },
      poolActive: trace.threadAccount,
      eligible: views.map((v) => ({
        id: v.account,
        order: v.order,
        usageFailed: false,
        overThreshold: v.windows.some(
          (w) => w.remaining !== null && 1 - w.remaining >= c.SELECTION_THRESHOLD
        ),
        snapshot: null,
        snapshotAt: null,
      })),
    };
    const flat = new Array(c.SIM_MAX_STEPS).fill(trace.demandCuPerHour);
    const plan = strategy.plan
      ? strategy.plan({ ...input, demand: { d75: flat, d90: flat } }, c)
      : null;
    const decision = strategy.decide(input, plan, c);
    const pass = decision.account === trace.expected.account && deliverableOk;
    return {
      trace: trace.name,
      under: name,
      pass,
      detail: `→ ${decision.account ?? "none"} (${decision.reason}); deliverable(${trace.expected.deliverable.account}) ${d?.toFixed(4) ?? "null"}`,
    };
  });
}

function runSlidingTrace(trace: SlidingTrace, cfg: AllowanceConfig): CheckResult {
  const views = exactViews([trace.account], trace.start);
  const r = simulate(views, trace.demand, cfg, {
    now: trace.start,
    strategy: STRATEGIES.sticky,
    horizonMs: (trace.expected.remainingAtBucket + 2) * HOUR_MS,
  });
  const key = views[0]?.windows[0]?.key ?? "";
  const got =
    r.remainingAt[trace.expected.remainingAtBucket]?.[trace.account.id]?.[key] ?? Number.NaN;
  return {
    trace: trace.name,
    under: "simulate",
    pass: Math.abs(got - trace.expected.remaining) <= trace.expected.tolerance,
    detail: `r at bucket ${trace.expected.remainingAtBucket} = ${got.toFixed(4)}`,
  };
}

function runObservationTrace(trace: ObservationTrace, cfg: AllowanceConfig): CheckResult {
  const account = "aaaaaaaaaaaa";
  const live = (n: number, key: string) => {
    const s = observeAll(initialState(), trace.events.slice(0, n), cfg);
    const w = s.accounts[account]?.windows[key];
    return w !== undefined && !w.retired;
  };
  const results: boolean[] = [];
  const e = trace.expected;
  const notes: string[] = [];
  if (typeof e.liveAfterEvent3 === "string") results.push(live(3, e.liveAfterEvent3));
  if (typeof e.liveAfterEvent4 === "string") results.push(live(4, e.liveAfterEvent4));
  if (typeof e.retiredAfterEvent5 === "string") results.push(!live(5, e.retiredAfterEvent5));
  if (typeof e.headUsedFraction === "number") {
    const s = observeAll(initialState(), trace.events, cfg);
    const v = accountViews(s, trace.start, cfg).find((x) => x.account === account);
    const track = s.accounts[account]?.windows["len:10080"];
    const head = track?.readings[track.readings.length - 1];
    const counted = s.demand.reduce((a, b) => a + b.cu, 0);
    results.push(
      head?.usedFraction === e.headUsedFraction,
      head?.at === e.headAt,
      v?.windows.some((w) => w.key === e.windowLive) === true,
      counted === e.tokensCounted
    );
    notes.push(
      `head ${head?.usedFraction}@${head?.at === e.headAt ? "h0" : head?.at}, demand ${counted} cu`
    );
  }
  return {
    trace: trace.name,
    under: "observeAll",
    pass: results.length > 0 && results.every(Boolean),
    detail:
      notes.join("; ") || `${results.filter(Boolean).length}/${results.length} expectations hold`,
  };
}

/** EVERY adversarial trace against every contestant it promises a figure for. */
export function runAdversarial(cfg: AllowanceConfig): AdversarialReport {
  const served = SERVED_TRACES.flatMap((t) => runServed(t, cfg));
  const checks: CheckResult[] = [];
  for (const t of ALERT_TRACES) {
    if (t.kind === "gaps") checks.push(...runGapTrace(t, cfg));
    else if (t.kind === "episode") checks.push(runEpisodeTrace(t, cfg));
    else if (t.kind === "decision") checks.push(...runDecisionTrace(t, cfg));
    else if (t.kind === "sliding") checks.push(runSlidingTrace(t, cfg));
    else checks.push(runObservationTrace(t, cfg));
  }
  return { served, checks };
}
