/**
 * The shell's two entry points into selection (architecture §1.3, §1.8):
 *
 * - `planFor` builds a plan OFF the request path: the views of the eligible
 *   accounts with their fresh snapshots overlaid, the forecast's p75 and p90
 *   demand per bucket (`D75_k = scale75·m_k`, `D90_k = scale90·m_k`), and
 *   `STRATEGIES[cfg.strategy].plan`. It reads only `fc.buckets`, `scale75` and
 *   `scale90`, so a test can hand it a literal `Forecast`. With no forecast
 *   evidence, or a strategy that does not plan, there is no plan (null).
 * - `choose` decides ON the request path and never computes a plan or a
 *   forecast: it is `STRATEGIES[cfg.strategy].decide` over the overlaid views
 *   and the plan it is handed, plus the per-candidate report. Fresh snapshots
 *   are an overlay; the state is never folded or cloned here (opus M2).
 *
 * A P-u test of `lookahead` therefore calls `planFor` and then `choose` with
 * that plan, which is exactly what the shell does in two ticks.
 */

import { accountViews, feasible, isRead, overlayReadings, requestCostCu } from "./capacity.js";
import { forecast } from "./forecast.js";
import { hourStart } from "./step.js";
import { assess, switchCostCu } from "./strategies/lookahead.js";
import { STRATEGIES } from "./strategies/strategy.js";
import type {
  AccountView,
  AllowanceConfig,
  AllowanceState,
  Calendar,
  ChooseCandidate,
  ChooseRequest,
  ChooseResult,
  DecisionInput,
  Forecast,
  Plan,
} from "./types.js";

const HOUR_MS = 3_600_000;

/**
 * The views of the eligible accounts at `req.now`: the state's views with each
 * fresh snapshot laid over them (a new object only where the snapshot is newer
 * than the view's head), in the pool's config order. An eligible account the
 * state has never seen gets a view from its snapshot, or an unread one.
 */
function requestViews(s: AllowanceState, req: ChooseRequest, cfg: AllowanceConfig): AccountView[] {
  const order = new Map(req.eligible.map((e) => [e.id, e.order]));
  const base = accountViews(s, req.now, cfg).filter((v) => order.has(v.account));
  const fresh = req.eligible.map((e) => ({
    id: e.id,
    order: e.order,
    at: e.snapshotAt,
    readings: e.snapshot,
  }));
  return overlayReadings(base, fresh, req.now)
    .map((v) => {
      const o = order.get(v.account);
      return o === undefined || o === v.order ? v : { ...v, order: o };
    })
    .sort((a, b) => a.order - b.order || (a.account < b.account ? -1 : 1));
}

function decisionInput(s: AllowanceState, req: ChooseRequest, cfg: AllowanceConfig): DecisionInput {
  return {
    now: req.now,
    views: requestViews(s, req, cfg),
    thread: {
      account: req.threadAccount,
      lastSwitchAt: req.lastSwitchAt,
      contextTokens: req.contextTokens,
    },
    poolActive: req.poolActive,
    eligible: req.eligible,
  };
}

/**
 * In `account-fraction` the forecast's demand is in governing-window fractions,
 * so the plan reads every window in fractions too (β 1, no κ): it never mixes a
 * prior β's cu with a W demand. The decision keeps the real views.
 */
function inUnit(views: readonly AccountView[], unit: Forecast["unit"]): AccountView[] {
  if (unit === "cu") return [...views];
  return views.map((v) => ({ ...v, beta: {}, kappa: {} }));
}

/** The forecast's per-bucket demand from `floor(now/1h)`, scaled. */
function demandFrom(fc: Forecast, now: number, scale: number): number[] {
  const h0 = hourStart(now);
  const out: number[] = [];
  for (const b of fc.buckets) {
    if (b.start + HOUR_MS <= h0) continue;
    out.push(Math.max(0, b.mean) * scale);
  }
  return out;
}

export function planFor(
  s: AllowanceState,
  req: ChooseRequest,
  cal: Calendar,
  cfg: AllowanceConfig,
  fc?: Forecast
): Plan | null {
  const strategy = STRATEGIES[cfg.strategy];
  if (!strategy.plan) return null;
  const f = fc ?? forecast(s, req.now, cfg.SIM_MAX_STEPS * HOUR_MS, cal, cfg);
  if (f.evidence === "none" || f.buckets.length === 0) return null;
  const input = decisionInput(s, req, cfg);
  return strategy.plan(
    {
      ...input,
      views: inUnit(input.views, f.unit),
      forecastKey: f.key,
      withLambda: true,
      demand: { d75: demandFrom(f, req.now, f.scale75), d90: demandFrom(f, req.now, f.scale90) },
    },
    cfg
  );
}

export function choose(
  s: AllowanceState,
  req: ChooseRequest,
  plan: Plan | null,
  _cal: Calendar,
  cfg: AllowanceConfig
): ChooseResult {
  const strategy = STRATEGIES[cfg.strategy];
  const input = decisionInput(s, req, cfg);
  const d = strategy.decide(input, plan, cfg);
  const stale = plan !== null && (strategy.needsReplan?.(plan, input, cfg) ?? false);
  const fresh = plan !== null && !stale ? plan : null;
  const assessment = fresh ? assess(input, fresh, cfg) : null;
  const ctx = req.contextTokens;

  const candidates: Record<string, ChooseCandidate> = {};
  for (const e of req.eligible) {
    const v = input.views.find((x) => x.account === e.id);
    const read = v !== undefined && isRead(v);
    const entry = read && fresh ? fresh.perFirst[e.id] : undefined;
    candidates[e.id] = {
      feasible: v !== undefined && feasible(v, ctx, cfg),
      read,
      j75: entry?.j75 ?? null,
      j90: entry?.j90 ?? null,
      lambda: read && plan ? (plan.lambda?.[e.id] ?? null) : null,
      deliverable: v?.deliverable ?? null,
      binding: v?.binding ?? null,
    };
  }

  return {
    account: d.account,
    reason: d.reason,
    plan: plan ? { key: plan.key, at: plan.at, stale } : null,
    candidates,
    gainCu: assessment?.gainCu ?? null,
    switchCostCu: switchCostCu(ctx, cfg),
    requestCostCu: requestCostCu(ctx, cfg),
    usedPlan: d.usedPlan,
  };
}
