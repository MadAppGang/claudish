/**
 * One scenario run (architecture §4 `run.ts`): a loop of requests where the
 * contestant picks, the vendor charges and emits the row, and `observe` folds
 * it. Pure: the caller hands in the trace, the plan latency and, optionally, a
 * `measure` wrapper that times `planFor` (the CLI's clock, never read here).
 *
 * **What a contestant sees** (§5 case 37): only what production sees — the
 * emitted `response`/`no-eligible`/`snapshot` events folded into its own state,
 * and the pool's `state.json` analogue (each account's last reported usage, and
 * `exhaustedUntil` after a 429). The vendor's hidden truth reaches the metrics
 * only; `assertObservable` checks every state and request a contestant is
 * handed at runtime, and the types never carry a vendor object.
 *
 * **The production call path.** Each request goes through the real
 * `selectAccount`: with no `rank` for `sticky`; with a `rank` closure built as
 * `safeRanker` builds it (§2.3) for every other contestant —
 * `candidatesToChooseRequest`, then the real `choose` with the thread's plan
 * (else the pool plan) for `ebr`/`lookahead`, declining when `decide` declined
 * or fell back to sticky; the baseline's `decide` over the same views for
 * `governing-fefo` and `water-fill`. A 429 marks the account exhausted until
 * its rejected window resets and the request rotates, as the pool does.
 *
 * **Cadence (item 5).** After each response it asks `needsReplan` for the
 * thread's plan and the pool plan and computes a stale one with `planFor`,
 * which becomes visible PLAN_LATENCY later: a request in between is decided by
 * the sticky fallback, as in production, and counted in `staleDecisions`.
 * `alerts` steps every EVAL_CADENCE (5 simulated minutes), reusing its
 * `GapEval` while the inputs key holds; the forecast is recomputed hourly.
 * The state folds the pending rows before every read of it (a plan, an alert
 * step, the hourly tick); between folds the request path reads fresh usage
 * through the overlay, as production's ranker does.
 *
 * A switch costs what it costs: the first request of a thread on a new account
 * writes the context it would have read from cache (cacheRead → cacheWrite).
 */

import {
  type AccountCandidate,
  type SelectOptions,
  blockerFor,
  selectAccount,
} from "../../policy.js";
import type { UsageSnapshot } from "../../types.js";
import { alerts, initialAlertMemory } from "../alerts.js";
import { accountViews, overlayReadings } from "../capacity.js";
import { choose, planFor } from "../choose.js";
import { forecast } from "../forecast.js";
import { accountProviderOf, candidatesToChooseRequest } from "../request.js";
import { simulate } from "../simulate.js";
import { initialState, observeAll } from "../state.js";
import { needsReplan } from "../strategies/lookahead.js";
import type {
  AccountId,
  AccountView,
  AlertMemory,
  AllowanceConfig,
  AllowanceEvent,
  AllowanceState,
  ChooseRequest,
  DecisionInput,
  Forecast,
  Ms,
  Plan,
  StrategyName,
  TokenCounts,
  Transition,
  WindowReading,
} from "../types.js";
import type { Scenario } from "./scenarios.js";
import { type Contestant, UTC } from "./tournament.js";
import { type Demand, PROFILE_LOAD, keyed } from "./traces.js";
import { type Vendor, type VendorAccountSpec, costOf, createVendor } from "./vendor.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A thread's plan is dropped after this long without a request. */
const THREAD_PLAN_IDLE_MS = 2 * HOUR_MS;
/** §5 case 38b: demand after the recovery, as a share of weekly capacity. */
const RECOVERY_LOAD = 0.3;
const EPS = 1e-9;

export interface RunInput {
  seed: number;
  scenario: Scenario;
  contestant: Contestant;
  days: number;
  /** The run's start: an hour boundary. */
  start: Ms;
  /** The scenario's trace for this seed (matched across contestants). */
  trace: readonly Demand[];
  cfg: AllowanceConfig;
  /** PLAN_LATENCY: a plan is visible this long after it was started. */
  planLatencyMs: number;
  /** A served-forecast sample every this many hours (each costs one `simulate`). */
  forecastEveryH?: number;
  /** Wraps every `planFor` call and every alert step; the CLI times them. */
  measure?: <T>(kind: "plan" | "alerts", fn: () => T) => T;
}

export interface RequestRecord {
  at: Ms;
  thread: string;
  /** The request's cost at the hidden weights, as the trace has it (no switch). */
  cu: number;
  account: AccountId | null;
  switched: boolean;
  /** The extra cu the switch cost at the hidden weights. */
  rebuildCu: number;
  /** The ranker declined on the first attempt (sticky fallback); only for ranked contestants. */
  stale: boolean;
  ranked: boolean;
  /** For an unserved request: what blocked the pool at that moment, by the hidden truth. */
  blockedBy: "7d" | "5h" | null;
}

export interface HourRecord {
  at: Ms;
  /** Every account had an exhausted window at the hour's start, or a request in it went unserved. */
  blocked: "7d" | "5h" | null;
}

export interface ResetRecord {
  at: Ms;
  account: AccountId;
  /** The governing window's unused cu just before its reset. */
  leftCu: number;
  capacityCu: number;
}

export interface ForecastRecord {
  at: Ms;
  /** Served cu over the next 24 h as `simulate` forecasts it under the contestant; null in account-fraction. */
  servedCu: number | null;
  /** The forecast's 24 h cumulative demand band; null when absent. */
  demandP10: number | null;
  demandP90: number | null;
}

export interface RunLog {
  scenario: string;
  contestant: string;
  seed: number;
  start: Ms;
  end: Ms;
  requests: RequestRecord[];
  hours: HourRecord[];
  resets: ResetRecord[];
  forecasts: ForecastRecord[];
  /** WARN and CRITICAL transitions, in order; empty when the scenario steps no alerts. */
  transitions: Transition[];
  plans: number;
  /** When the vendor-side reset of §5 case 38b happened. */
  recoveryAt: Ms | null;
}

interface ThreadMemory {
  account: AccountId | null;
  lastSwitchAt: Ms | null;
  lastAt: Ms;
}

interface PlanSlot {
  plan: Plan | null;
  pending: { plan: Plan | null; readyAt: Ms } | null;
  lastAt: Ms;
  /** The request it was last asked for: the 5-minute tick re-asks with it. */
  request: ChooseRequest | null;
}

interface PoolEntry {
  spec: VendorAccountSpec;
  order: number;
  usage: UsageSnapshot | null;
  exhaustedUntil?: number;
}

/** Vendor-only field names: a contestant's input must never carry them (§5 case 37). */
const HIDDEN_KEYS = ["capacityCu", "usedCu", "epochEnd", "remainingCu", "weights"];

/** Throws when a value handed to a contestant carries vendor internals. */
export function assertObservable(value: unknown): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === null || typeof v !== "object") continue;
    for (const [k, child] of Object.entries(v)) {
      if (HIDDEN_KEYS.includes(k))
        throw new Error(`run: vendor internals reached a contestant (${k})`);
      if (child !== null && typeof child === "object") stack.push(child);
    }
  }
}

function snapshotOf(windows: readonly WindowReading[], at: Ms): UsageSnapshot {
  return {
    observedAt: at,
    windows: windows.map((w) => ({
      slot: w.slot,
      displayId: w.key,
      ...(w.lengthMinutes !== null ? { lengthMinutes: w.lengthMinutes } : {}),
      usedFraction: w.usedFraction,
      ...(w.resetAt !== null ? { resetAt: w.resetAt } : {}),
      ...(w.rejected ? { rejected: true } : {}),
    })),
  };
}

function governingSlot(spec: VendorAccountSpec): string | undefined {
  let g = spec.windows[0];
  for (const w of spec.windows) if (g && w.lengthMinutes > g.lengthMinutes) g = w;
  return g?.slot;
}

export function runScenario(input: RunInput): RunLog {
  const { seed, scenario, contestant, cfg: base, start, trace } = input;
  const cfg: AllowanceConfig = {
    ...base,
    strategy: contestant.deployable ? (contestant.name as StrategyName) : base.strategy,
  };
  const end = start + input.days * DAY_MS;
  const specs = scenario.accounts(start);
  const vendor: Vendor = createVendor(specs, start);
  const provider = accountProviderOf(cfg);
  const ranked = contestant.name !== "sticky";
  const plans = contestant.strategy.plan !== undefined;
  const alertsOn = scenario.alerts && contestant.deployable;
  const forecastEveryH = Math.max(1, input.forecastEveryH ?? 6);
  const measure = input.measure ?? (<T>(_kind: "plan" | "alerts", fn: () => T) => fn());

  const log: RunLog = {
    scenario: scenario.name,
    contestant: contestant.name,
    seed,
    start,
    end,
    requests: [],
    hours: [],
    resets: [],
    forecasts: [],
    transitions: [],
    plans: 0,
    recoveryAt: null,
  };

  // --- what the contestant sees -------------------------------------------
  let state: AllowanceState = initialState();
  let pending: AllowanceEvent[] = [];
  const fold = () => {
    if (pending.length === 0) return;
    state = observeAll(state, pending, cfg);
    pending = [];
    assertObservable(state);
  };
  const pool: PoolEntry[] = specs.map((spec, i) => ({ spec, order: i + 1, usage: null }));
  // The accounts and their `state.json` usage at the start, as a usage poll reports it.
  pending.push({
    kind: "accounts",
    at: start,
    accounts: pool.map((p) => ({ id: p.spec.id, order: p.order, enabled: true, planClass: "pro" })),
  });
  for (const p of pool) {
    const windows = vendor.poll(p.spec.id, start);
    p.usage = snapshotOf(windows, start);
    pending.push({ kind: "snapshot", at: start, account: p.spec.id, windows });
  }
  let active: AccountId | null = null;
  const threads = new Map<string, ThreadMemory>();
  const threadPlans = new Map<string, PlanSlot>();
  const poolPlan: PlanSlot = { plan: null, pending: null, lastAt: start, request: null };
  let fc: Forecast | null = null;
  let memory: AlertMemory = initialAlertMemory();
  let warnRaised = false;

  // --- hidden truth, for the metrics only ---------------------------------
  const nextGovReset = new Map<AccountId, Ms | null>();
  const refreshGov = (at: Ms) => {
    const truth = vendor.truth(at);
    for (const p of pool) {
      const slot = governingSlot(p.spec);
      const w = truth[p.spec.id]?.find((x) => x.slot === slot);
      nextGovReset.set(p.spec.id, w && w.resetAt !== null && w.resetAt > at ? w.resetAt : null);
    }
  };
  refreshGov(start);
  /** Book the leftover of every governing reset due by `at`, just before it applies. */
  const bookResets = (at: Ms) => {
    for (;;) {
      let due: { id: AccountId; R: Ms } | null = null;
      for (const [id, R] of nextGovReset)
        if (R !== null && R <= at && (due === null || R < due.R)) due = { id, R };
      if (due === null) return;
      const truth = vendor.truth(due.R - 1);
      const p = pool.find((x) => x.spec.id === due?.id);
      const slot = p ? governingSlot(p.spec) : undefined;
      const w = truth[due.id]?.find((x) => x.slot === slot);
      if (w)
        log.resets.push({
          at: due.R,
          account: due.id,
          leftCu: Math.max(0, w.remainingCu),
          capacityCu: w.capacityCu,
        });
      refreshGov(due.R);
    }
  };

  /** Every account has an exhausted window (by the truth): the kind, else null. */
  const truthBlocked = (at: Ms): "7d" | "5h" | null => {
    const truth = vendor.truth(at);
    let kind: "7d" | "5h" | null = "5h";
    for (const p of pool) {
      const blocking = (truth[p.spec.id] ?? []).filter(
        (w) => w.active && w.remainingCu <= EPS * w.capacityCu
      );
      if (blocking.length === 0) return null;
      if (blocking.some((w) => w.lengthMinutes > cfg.SHORT_WINDOW_MAX_MIN)) kind = "7d";
    }
    return kind;
  };

  // --- the pool --------------------------------------------------------------
  const candidates = (now: Ms): AccountCandidate[] =>
    pool.map((p) => ({
      ref: { provider, id: p.spec.id, label: p.spec.id },
      order: p.order,
      enabled: true,
      usage: p.usage,
      usageFailed: false,
      isActive: active !== null && p.spec.id === active,
      ...(p.exhaustedUntil !== undefined && p.exhaustedUntil > now
        ? { exhaustedUntil: p.exhaustedUntil }
        : {}),
    }));
  const selectOpts = (now: Ms): SelectOptions => ({ now, switchAt: cfg.SELECTION_THRESHOLD });

  const requestFor = (
    d: Demand,
    thread: ThreadMemory,
    now: Ms,
    eligible: AccountCandidate[]
  ): ChooseRequest =>
    candidatesToChooseRequest(
      eligible,
      selectOpts(now),
      {
        session: d.session,
        thread: d.thread,
        threadAccount: thread.account,
        lastSwitchAt: thread.lastSwitchAt,
        contextTokens: d.tokens.input,
      },
      cfg.QUANTUM_CODEX
    );

  /** The views `choose` decides over: the state's, with each fresh snapshot laid over them. */
  const viewsFor = (req: ChooseRequest): AccountView[] => {
    const ids = new Set(req.eligible.map((e) => e.id));
    return overlayReadings(
      accountViews(state, req.now, cfg).filter((v) => ids.has(v.account)),
      req.eligible.map((e) => ({
        id: e.id,
        order: e.order,
        at: e.snapshotAt,
        readings: e.snapshot,
      })),
      req.now
    );
  };
  const decisionInput = (req: ChooseRequest): DecisionInput => ({
    now: req.now,
    views: viewsFor(req),
    thread: {
      account: req.threadAccount,
      lastSwitchAt: req.lastSwitchAt,
      contextTokens: req.contextTokens,
    },
    poolActive: req.poolActive,
    eligible: req.eligible,
  });

  const settle = (slot: PlanSlot, at: Ms) => {
    if (slot.pending && slot.pending.readyAt <= at) {
      slot.plan = slot.pending.plan;
      slot.pending = null;
    }
  };

  const rankFor = (d: Demand, thread: ThreadMemory, now: Ms) => (eligible: AccountCandidate[]) => {
    const req = requestFor(d, thread, now, eligible);
    assertObservable(req);
    if (contestant.deployable) {
      const plan = threadPlans.get(d.thread)?.plan ?? poolPlan.plan;
      if (plans && plan === null) return null;
      const r = choose(state, req, plan, UTC, cfg);
      if (r.account === null || (plans && !r.usedPlan)) return null;
      return { id: r.account, reason: r.reason };
    }
    const decision = contestant.strategy.decide(decisionInput(req), null, cfg);
    return decision.account === null ? null : { id: decision.account, reason: decision.reason };
  };

  const maybeReplan = (slot: PlanSlot, req: ChooseRequest, at: Ms) => {
    slot.request = req;
    settle(slot, at);
    if (slot.pending) return;
    if (slot.plan !== null && !needsReplan(slot.plan, decisionInput(req), cfg)) return;
    fold();
    if (fc === null) fc = forecast(state, at, cfg.SIM_MAX_STEPS * HOUR_MS, UTC, cfg);
    const f = fc;
    const plan = measure("plan", () => planFor(state, req, UTC, cfg, f));
    log.plans++;
    slot.pending = { plan, readyAt: at + input.planLatencyMs };
  };

  const serve = (d: Demand, index: number) => {
    bookResets(d.at);
    let thread = threads.get(d.thread);
    if (!thread) {
      thread = { account: null, lastSwitchAt: null, lastAt: d.at };
      threads.set(d.thread, thread);
    }
    thread.lastAt = d.at;
    const slot = threadPlans.get(d.thread);
    if (slot) settle(slot, d.at);
    settle(poolPlan, d.at);

    const record: RequestRecord = {
      at: d.at,
      thread: d.thread,
      cu: costOf({ id: "", windows: [] }, d),
      account: null,
      switched: false,
      rebuildCu: 0,
      stale: false,
      ranked,
      blockedBy: null,
    };
    const exclude: AccountCandidate["ref"][] = [];
    for (let attempt = 0; attempt <= pool.length; attempt++) {
      const result = selectAccount(candidates(d.at), {
        ...selectOpts(d.at),
        exclude,
        ...(ranked ? { rank: rankFor(d, thread, d.at) } : {}),
      });
      if (attempt === 0 && ranked && result.kind === "selected" && result.reverted !== undefined) {
        record.stale = true;
      }
      if (result.kind !== "selected") {
        pending.push({ kind: "no-eligible", at: d.at });
        break;
      }
      const account = result.candidate.ref.id;
      const entry = pool.find((p) => p.spec.id === account);
      if (!entry) break;
      const switched = thread.account !== null && thread.account !== account;
      const tokens: TokenCounts = switched
        ? { ...d.tokens, cacheWrite: d.tokens.cacheWrite + d.tokens.cacheRead, cacheRead: 0 }
        : d.tokens;
      const r = vendor.serve({
        id: `q${index}:${attempt}:${account}`,
        at: d.at,
        account,
        session: d.session,
        model: d.model,
        tokens,
        finalInput: d.tokens.input,
      });
      pending.push(r.event);
      if (r.event.windows !== null) entry.usage = snapshotOf(r.event.windows, d.at);
      if (r.accepted) {
        record.account = account;
        record.switched = switched;
        record.rebuildCu = switched ? r.cu - costOf(entry.spec, d) : 0;
        if (result.reason.endsWith("-switch")) thread.lastSwitchAt = d.at;
        thread.account = account;
        if (!ranked) active = account;
        break;
      }
      const resets = (r.event.windows ?? [])
        .filter((w) => w.rejected)
        .map((w) => w.resetAt ?? d.at + HOUR_MS);
      entry.exhaustedUntil = Math.max(d.at + 60_000, ...resets);
      exclude.push(result.candidate.ref);
    }
    if (record.account === null) record.blockedBy = truthBlocked(d.at) ?? "7d";
    log.requests.push(record);

    if (plans) {
      const eligible = candidates(d.at).filter(
        (c) => blockerFor(c, d.at, selectOpts(d.at)) === null
      );
      if (eligible.length > 0) {
        let own = threadPlans.get(d.thread);
        if (!own) {
          own = { plan: null, pending: null, lastAt: d.at, request: null };
          threadPlans.set(d.thread, own);
        }
        own.lastAt = d.at;
        maybeReplan(own, requestFor(d, thread, d.at, eligible), d.at);
        const poolThread: ThreadMemory = { account: null, lastSwitchAt: null, lastAt: d.at };
        maybeReplan(
          poolPlan,
          { ...requestFor(d, poolThread, d.at, eligible), session: null, thread: null },
          d.at
        );
      }
    }
  };

  const hourTick = (t: Ms, hourIndex: number) => {
    bookResets(t);
    fold();
    log.hours.push({ at: t, blocked: truthBlocked(t) });

    for (const [key, slot] of threadPlans)
      if (t - slot.lastAt > THREAD_PLAN_IDLE_MS) threadPlans.delete(key);
    for (const [key, th] of threads) if (t - th.lastAt > DAY_MS) threads.delete(key);

    const sample = hourIndex % forecastEveryH === 0;
    if (plans || alertsOn || sample) fc = forecast(state, t, cfg.SIM_MAX_STEPS * HOUR_MS, UTC, cfg);
    if (sample && fc) {
      const day = fc.cumulative.find((c) => c.horizonMs === DAY_MS)?.q ?? null;
      let servedCu: number | null = null;
      if (fc.unit === "cu" && fc.buckets.length > 0) {
        const r = simulate(
          accountViews(state, t, cfg),
          fc.buckets.map((b) => b.mean),
          cfg,
          {
            now: t,
            strategy: contestant.strategy,
            thread: { account: null, lastSwitchAt: null, contextTokens: null },
            poolActive: active,
          }
        );
        servedCu = r.served.slice(0, 24).reduce((a, b) => a + b, 0);
      }
      log.forecasts.push({
        at: t,
        servedCu,
        demandP10: day?.p10 ?? null,
        demandP90: day?.p90 ?? null,
      });
    }

    if (scenario.recovery && warnRaised && log.recoveryAt === null) {
      vendor.resetAll(t);
      log.recoveryAt = t;
      refreshGov(t);
    }
  };

  const alertTick = (t: Ms) => {
    fold();
    const r = measure("alerts", () =>
      alerts(state, t, memory, UTC, cfg, fc ?? undefined, { payload: false })
    );
    memory = r.memory;
    for (const tr of r.transitions) {
      log.transitions.push(tr);
      if (tr.level === "warn" && tr.to === "raised") warnRaised = true;
    }
  };

  /** The alert timer asks too (§2.4): every plan is re-checked on the 5-minute tick. */
  const planTick = (t: Ms) => {
    for (const slot of [poolPlan, ...threadPlans.values()]) {
      if (slot.request) maybeReplan(slot, { ...slot.request, now: t }, t);
    }
  };

  const recoveryKeep =
    PROFILE_LOAD[scenario.profile] > 0 ? RECOVERY_LOAD / PROFILE_LOAD[scenario.profile] : 1;
  let next = 0;
  let hourIndex = 0;
  for (let t = start; t < end; t += cfg.EVAL_CADENCE_MS) {
    if ((t - start) % HOUR_MS === 0) hourTick(t, hourIndex++);
    if (alertsOn) alertTick(t);
    if (plans) planTick(t);
    const tickEnd = t + cfg.EVAL_CADENCE_MS;
    while (next < trace.length && (trace[next]?.at ?? Number.POSITIVE_INFINITY) < tickEnd) {
      const d = trace[next] as Demand;
      if (d.at >= t) {
        const dropped =
          log.recoveryAt !== null &&
          d.at >= log.recoveryAt &&
          keyed(seed, "user0", "recovery", next)() >= recoveryKeep;
        if (!dropped) serve(d, next);
      }
      next++;
    }
  }
  bookResets(end);

  // An hour with an unserved request is blocked even when the hour's start was not.
  for (const r of log.requests) {
    if (r.account !== null) continue;
    const h = log.hours[Math.floor((r.at - start) / HOUR_MS)];
    if (h && (h.blocked === null || r.blockedBy === "7d")) h.blocked = r.blockedBy;
  }
  return log;
}
