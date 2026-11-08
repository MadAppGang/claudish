/**
 * `lookahead` (architecture §1.8, revision 2 item 2): an event-branching search
 * over account sequences, computed OFF the request path, and a gated decision
 * that reads it. A heuristic; no optimality is claimed (§7 Q15).
 *
 * **`plan`.** Branch points are `now`, every reset of every live window of every
 * read account inside LOOKAHEAD_HORIZON_H (snapped by the bucket rule, §1.6),
 * every demand step (`D75_{k−1} = 0 < D75_k`) and the thread's expected end
 * `now + SESSION_TAIL_H`; the first LOOKAHEAD_DEPTH are kept. `searchSequences`
 * finds the best sequence per first account on p75 and on p90 (the node budget
 * split evenly between the two). λ_a comes from the stay simulation: `simulate`
 * under `ebr` with the thread on a0 over the full grid; λ_a = 0 when a's
 * leftover at its first governing reset exceeds LAMBDA_EPS on both paths, null
 * for an account with a reset-inferred window, 1 otherwise.
 *
 * **`needsReplan`.** No plan; a root that is not the thread's a0; `now ≥
 * nextEventAt`; a best account no longer usable or hard-full; a read window
 * drifted from the projection by more than PLAN_DRIFT; a changed forecast key
 * (when the caller passes one); a plan older than PLAN_MAX_AGE.
 *
 * **`decide`.** A stale or absent plan → `sticky`'s decision (`usedPlan:
 * false`; the ranker then declines). Otherwise a* = the best first account
 * among the feasible read accounts, `gain = min(ΔJ75, ΔJ90)` against a0, and
 * `c_s = ctx·(ω_w − ω_r)`. A read, feasible a0 (observed OR reset-inferred) is
 * left only when `gain ≥ SWITCH_HYSTERESIS·c_s`, both β are at least coarse and
 * SWITCH_DWELL has passed; the 0.9 threshold never moves a thread (R7). With no
 * a0 → a* (`initial`); an infeasible or ineligible a0 → a* (`forced`). An unread
 * account is taken (`unknown-usage`) when the chosen one has λ = 1, or when no
 * read account is feasible.
 */

import { feasible, hardFull, isRead, strongBetas, usable } from "../capacity.js";
import { costPriorsFor } from "../constants.js";
import { planKey } from "../digest.js";
import { simulate } from "../simulate.js";
import { hourStart } from "../step.js";
import type {
  AccountId,
  AccountView,
  AllowanceConfig,
  ChooseReason,
  Decision,
  DecisionInput,
  Ms,
  Plan,
  PlanInput,
  Strategy,
} from "../types.js";
import { byBindingReset, ebr } from "./ebr.js";
import { evaluateSequence, searchSequences } from "./search.js";
import { sticky } from "./sticky.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** c_s in cu: the extra debit of the first request after a switch; null when ctx is unknown. */
export function switchCostCu(
  contextTokens: number | null,
  cfg: Pick<AllowanceConfig, "provider">
): number | null {
  if (contextTokens === null) return null;
  const w = costPriorsFor(cfg);
  return contextTokens * (w.cacheWrite - w.cacheRead);
}

/** The first boundary `h_k ≥ at`, as a bucket index from `h_0` (§1.6). */
function bucketOf(at: Ms, h0: Ms): number {
  return Math.ceil((at - h0) / HOUR_MS);
}

/**
 * The kept branch points (§1.8 step 2) as bucket indices, ascending, the first
 * 0: resets of every live window of every read account (each recurrence of a
 * fixed-start window, each release of a sliding one), demand steps on p75 and
 * the thread's expected end, inside `horizon` buckets; the first
 * LOOKAHEAD_DEPTH kept.
 */
export function branchPoints(
  views: readonly AccountView[],
  now: Ms,
  d75: readonly number[],
  horizon: number,
  cfg: Pick<AllowanceConfig, "SESSION_TAIL_H" | "LOOKAHEAD_DEPTH">
): number[] {
  const h0 = hourStart(now);
  const end = h0 + horizon * HOUR_MS;
  const points = new Set<number>([0]);
  const add = (k: number) => {
    if (k >= 1 && k < horizon) points.add(k);
  };
  for (const v of views) {
    if (!isRead(v)) continue;
    for (const w of v.windows) {
      if (w.semantics === "sliding") {
        for (const r of w.releases ?? []) if (r.at < end) add(bucketOf(r.at, h0));
        continue;
      }
      if (w.resetAt === null) continue;
      const L = w.lengthMinutes !== null && w.lengthMinutes > 0 ? w.lengthMinutes * MINUTE_MS : 0;
      for (let at = w.resetAt; at < end; at += L) {
        add(bucketOf(at, h0));
        if (L === 0) break;
      }
    }
  }
  for (let k = 1; k < horizon; k++) {
    if ((d75[k - 1] ?? 0) === 0 && (d75[k] ?? 0) > 0) add(k);
  }
  add(bucketOf(now + cfg.SESSION_TAIL_H * HOUR_MS, h0));
  return [...points].sort((a, b) => a - b).slice(0, Math.max(1, cfg.LOOKAHEAD_DEPTH));
}

function lambdaOf(
  input: PlanInput,
  read: readonly AccountView[],
  cfg: AllowanceConfig
): Record<AccountId, 0 | 1 | null> {
  const thread = input.thread;
  const opts = (demand: number[]) =>
    simulate(read, demand, cfg, {
      now: input.now,
      strategy: ebr,
      thread: { ...thread, account: thread.account ?? input.poolActive },
      poolActive: input.poolActive,
      horizonMs: demand.length * HOUR_MS,
    });
  const s75 = opts(input.demand.d75);
  const s90 = opts(input.demand.d90);
  const out: Record<AccountId, 0 | 1 | null> = {};
  for (const v of input.views) {
    if (!isRead(v) || v.windows.some((w) => w.provenance === "reset-inferred")) {
      out[v.account] = null;
      continue;
    }
    const l75 = s75.leftoverAtReset[v.account];
    const l90 = s90.leftoverAtReset[v.account];
    const spare =
      l75 !== null &&
      l75 !== undefined &&
      l75 > cfg.LAMBDA_EPS &&
      l90 !== null &&
      l90 !== undefined &&
      l90 > cfg.LAMBDA_EPS;
    out[v.account] = spare ? 0 : 1;
  }
  return out;
}

function sameCost(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** a* among `candidates`: least J75, then fewer switches, then the earlier binding reset, then order. */
function bestFirst(plan: Plan, candidates: readonly AccountView[]): AccountView | null {
  let best: AccountView | null = null;
  let top: Plan["perFirst"][AccountId] | undefined;
  for (const v of candidates) {
    const entry = plan.perFirst[v.account];
    if (!entry) continue;
    let better = best === null || top === undefined;
    if (!better && best !== null && top !== undefined) {
      if (!sameCost(entry.j75, top.j75)) better = entry.j75 < top.j75;
      else {
        const a = switchesOf(entry.sequence);
        const b = switchesOf(top.sequence);
        better = a !== b ? a < b : byBindingReset(v, best) < 0;
      }
    }
    if (better) {
      best = v;
      top = entry;
    }
  }
  return best;
}

function switchesOf(sequence: readonly AccountId[]): number {
  let n = 0;
  for (let i = 1; i < sequence.length; i++) if (sequence[i] !== sequence[i - 1]) n++;
  return n;
}

/** Some read window is more than PLAN_DRIFT from the projection at `now` (the last projected bucket at or before it). */
function drifted(plan: Plan, input: DecisionInput, cfg: AllowanceConfig): boolean {
  let projected: Plan["projected"][number] | null = null;
  for (const p of plan.projected) if (p.at <= input.now) projected = p;
  if (!projected) return false;
  for (const v of input.views) {
    const expected = projected.remaining[v.account];
    if (!expected) continue;
    for (const w of v.windows) {
      const e = expected[w.key];
      if (w.remaining !== null && e !== undefined && Math.abs(w.remaining - e) > cfg.PLAN_DRIFT)
        return true;
    }
  }
  return false;
}

/** The plan's best account is gone from the views, unusable, or hard-full for this request. */
function bestLost(plan: Plan, input: DecisionInput, cfg: AllowanceConfig): boolean {
  if (plan.best === null) return false;
  const best = input.views.find((v) => v.account === plan.best);
  return !best || !usable(best) || hardFull(best, input.thread.contextTokens, cfg);
}

export function needsReplan(
  plan: Plan | null,
  input: DecisionInput,
  cfg: AllowanceConfig
): boolean {
  if (plan === null) return true;
  return (
    plan.root !== (input.thread.account ?? input.poolActive) ||
    input.now >= plan.nextEventAt ||
    input.now - plan.at > cfg.PLAN_MAX_AGE_MS ||
    (input.forecastKey !== undefined && input.forecastKey !== plan.forecastKey) ||
    bestLost(plan, input, cfg) ||
    drifted(plan, input, cfg)
  );
}

/** What `decide` weighs, also reported by `choose` (§1.3 `ChooseResult`). */
export interface Assessment {
  a0: AccountId | null;
  /** Feasible read accounts, in config order. */
  feasibleRead: AccountView[];
  /** Feasible unread accounts, in config order. */
  feasibleUnread: AccountView[];
  aStar: AccountView | null;
  gainCu: number | null;
  switchCostCu: number | null;
}

export function assess(input: DecisionInput, plan: Plan, cfg: AllowanceConfig): Assessment {
  const ctx = input.thread.contextTokens;
  const ok = input.views.filter((v) => feasible(v, ctx, cfg)).sort((a, b) => a.order - b.order);
  const feasibleRead = ok.filter(isRead);
  const feasibleUnread = ok.filter((v) => !isRead(v));
  const a0 = input.thread.account ?? input.poolActive;
  const aStar = bestFirst(plan, feasibleRead);
  const at0 = a0 === null ? undefined : plan.perFirst[a0];
  const atStar = aStar === null ? undefined : plan.perFirst[aStar.account];
  const gainCu = at0 && atStar ? Math.min(at0.j75 - atStar.j75, at0.j90 - atStar.j90) : null;
  return {
    a0,
    feasibleRead,
    feasibleUnread,
    aStar,
    gainCu,
    switchCostCu: switchCostCu(ctx, cfg),
  };
}

function decision(account: AccountId | null, reason: ChooseReason): Decision {
  return { account, reason, usedPlan: true };
}

/** The unread fallback (§1.8 step 7): the chosen account has λ = 1 and an unread one is feasible. */
function learnOrKeep(chosen: Decision, plan: Plan, unread: readonly AccountView[]): Decision {
  const first = unread[0];
  if (!first || chosen.account === null) return chosen;
  return plan.lambda?.[chosen.account] === 1
    ? decision(first.account, "lookahead-unknown-usage")
    : chosen;
}

function decideOnPlan(input: DecisionInput, plan: Plan, cfg: AllowanceConfig): Decision {
  const a = assess(input, plan, cfg);
  const a0View = a.a0 === null ? undefined : a.feasibleRead.find((v) => v.account === a.a0);

  if (a.feasibleRead.length === 0) {
    const unread = a.feasibleUnread[0];
    return unread
      ? decision(unread.account, "lookahead-unknown-usage")
      : decision(null, "lookahead-forced");
  }
  if (a.aStar === null) return { ...sticky.decide(input, null, cfg), usedPlan: false };

  let chosen: Decision;
  if (a.a0 === null) chosen = decision(a.aStar.account, "lookahead-initial");
  else if (!a0View) chosen = decision(a.aStar.account, "lookahead-forced");
  else {
    const dwelling =
      input.thread.lastSwitchAt !== null &&
      input.now - input.thread.lastSwitchAt < cfg.SWITCH_DWELL_MS;
    const gate =
      a.aStar.account !== a0View.account &&
      a.gainCu !== null &&
      a.switchCostCu !== null &&
      a.gainCu >= cfg.SWITCH_HYSTERESIS * a.switchCostCu &&
      strongBetas([a0View]) &&
      strongBetas([a.aStar]) &&
      !dwelling;
    chosen = gate
      ? decision(a.aStar.account, "lookahead-switch")
      : decision(a0View.account, "lookahead-sticky");
  }
  return learnOrKeep(chosen, plan, a.feasibleUnread);
}

export const lookahead: Strategy = {
  name: "lookahead",

  plan(input: PlanInput, cfg: AllowanceConfig): Plan {
    const horizon = Math.max(1, Math.round(cfg.LOOKAHEAD_HORIZON_H));
    const h0 = hourStart(input.now);
    const read = input.views.filter(isRead);
    const points = branchPoints(read, input.now, input.demand.d75, horizon, cfg);
    const ctx = input.thread.contextTokens;
    const base = {
      now: input.now,
      views: read,
      points,
      horizon,
      tailBucket: bucketOf(input.now + cfg.SESSION_TAIL_H * HOUR_MS, h0),
      switchCost: switchCostCu(ctx ?? cfg.REQ_CTX_DEFAULT, cfg) ?? 0,
      contextTokens: ctx,
    };
    const half = Math.max(1, Math.floor(cfg.LOOKAHEAD_NODE_BUDGET / 2));
    const d75 = input.demand.d75.slice(0, horizon);
    const d90 = input.demand.d90.slice(0, horizon);
    const r75 = searchSequences({ ...base, demand: d75, budget: half }, cfg);
    const r90 = searchSequences({ ...base, demand: d90, budget: half }, cfg);

    const perFirst: Plan["perFirst"] = {};
    for (const [account, s75] of Object.entries(r75.perFirst)) {
      const j90 =
        r90.perFirst[account]?.j ?? evaluateSequence({ ...base, demand: d90 }, s75.sequence, cfg);
      perFirst[account] = { j75: s75.j, j90: j90 ?? s75.j, sequence: s75.sequence };
    }
    const draft: Plan = {
      key: planKey(input),
      at: input.now,
      nextEventAt:
        points[1] !== undefined ? h0 + points[1] * HOUR_MS : input.now + horizon * HOUR_MS,
      root: input.thread.account ?? input.poolActive,
      best: null,
      perFirst,
      projected: [],
      forecastKey: input.forecastKey ?? "",
      truncated: r75.truncated || r90.truncated,
    };
    const best = bestFirst(draft, read);
    draft.best = best?.account ?? null;
    draft.projected = best ? (r75.perFirst[best.account]?.projected ?? []) : [];
    if (input.withLambda) draft.lambda = lambdaOf(input, read, cfg);
    return draft;
  },

  needsReplan,

  decide(input, plan, cfg): Decision {
    if (plan === null || needsReplan(plan, input, cfg)) {
      return { ...sticky.decide(input, null, cfg), usedPlan: false };
    }
    return decideOnPlan(input, plan, cfg);
  },
};
