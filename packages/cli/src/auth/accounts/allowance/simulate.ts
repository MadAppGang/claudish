/**
 * The ONE forward simulator (architecture §1.6). It drives a `Strategy` exactly
 * as the pool does — the same `plan`, `needsReplan` and `decide` — so the alert
 * model is the deployed strategy by construction (revision 2 item 3), and every
 * bucket goes through `stepBucket`, the same stepper the lookahead search uses.
 *
 * - Unread accounts are dropped first: nothing simulated ever sees a null
 *   remaining, so no NaN can reach a cost.
 * - The grid is `K = min(ceil((max(horizon, max_a R_g,a + 24h) − now)/1h),
 *   SIM_MAX_STEPS)` buckets.
 * - The simulated thread's a0 is the account of the previous bucket's first
 *   decision; `lastSwitchAt` moves on a `*-switch` reason; its context is the
 *   caller's (the shell passes the median final input of the last 24 h), else
 *   REQ_CTX_DEFAULT. The pool's active account follows the thread.
 * - A strategy with `plan` is replanned whenever `needsReplan` says so (when it
 *   has no `needsReplan`, whenever it has no plan yet), synchronously, at the
 *   decision that needs it: a stale-plan fallback cannot happen here, and
 *   `sim/run.ts` reproduces production's latency instead (§4).
 * - Every maximal blocked run is returned as a gap, not only the first (R2),
 *   when it has demand (orchestrator decision 1). A run whose first bucket
 *   was usable at its start and served all its demand begins at the NEXT
 *   boundary: that bucket's demand was served at `h_k`, and only its end was
 *   blocked (R2 at 15 cu/h drains A and B in bucket 19, so the gap starts at
 *   h20; gpt #8's drift empties A during bucket 4, so it starts at h5). What
 *   remains is a gap only when some bucket of it has unserved demand, claudish
 *   demand or external use; otherwise it is idle and its buckets are reported
 *   unblocked, so opus H1 under `lookahead`, which serves everything and then
 *   drains both accounts, has no gap.
 */

import { combinedNow, isRead } from "./capacity.js";
import { eligibleOfView } from "./request.js";
import { type BucketOutcome, type DecideFn, createWorld, stepBucket } from "./step.js";
import type {
  AccountId,
  AccountView,
  AllowanceConfig,
  Decision,
  DecisionInput,
  Gap,
  Ms,
  Plan,
  Strategy,
  WindowKey,
} from "./types.js";

const HOUR_MS = 3_600_000;

export interface SimOpts {
  /** The simulation's `now`; the grid starts at `floor(now/1h)`. */
  now: Ms;
  strategy: Strategy;
  thread?: DecisionInput["thread"];
  /** `state.json` active at `now`; defaults to the thread's account. */
  poolActive?: AccountId | null;
  /** The demand a plan is computed against, from bucket 0; defaults to `demand` itself (d75 = d90). */
  planDemand?: { d75: number[]; d90: number[] };
  /** Grid length to cover at least; defaults to `demand.length` hours. */
  horizonMs?: Ms;
}

export interface SimDecision {
  k: number;
  account: AccountId | null;
  reason: Decision["reason"];
  usedPlan: boolean;
  /** cu this decision served (0 for a decline, or an account with nothing left). */
  cu: number;
}

export interface SimResult {
  /** h_0. */
  start: Ms;
  buckets: number;
  served: number[];
  unserved: number[];
  blocked: { blocked: boolean; kind: "7d" | "5h" | null }[];
  /** Each account's governing remaining just before its first governing reset in the grid; null when none. */
  leftoverAtReset: Record<AccountId, number | null>;
  /** cu lost at every governing reset applied in the grid. */
  waste: number;
  gaps: Gap[];
  /** Combined immediate capacity at each bucket's start (after its resets), in `combinedNow`'s unit. */
  remainingCombined: number[];
  /** Every read window's remaining at each bucket's start (after its resets). */
  remainingAt: Record<AccountId, Record<WindowKey, number>>[];
  decisions: SimDecision[];
  replans: number;
}

/** The grid length for these views (§1.6). */
export function gridBuckets(
  views: readonly AccountView[],
  now: Ms,
  horizonMs: Ms,
  cfg: Pick<AllowanceConfig, "SIM_MAX_STEPS">
): number {
  let end = now + horizonMs;
  for (const v of views) {
    const g = v.windows.find((w) => w.key === v.governing);
    if (g?.resetAt != null) end = Math.max(end, g.resetAt + 24 * HOUR_MS);
  }
  return Math.max(0, Math.min(Math.ceil((end - now) / HOUR_MS), cfg.SIM_MAX_STEPS));
}

/** A blocked run is a gap only when someone would be working in it (decision 1). */
function hasDemand(run: readonly BucketOutcome[]): boolean {
  return run.some((o) => o.unserved > 0 || o.demand > 0 || o.external > 0);
}

function unblock(o: BucketOutcome): void {
  o.blocked = false;
  o.kind = null;
  o.blocking = [];
}

/**
 * Maximal blocked runs with demand as gaps; a run still blocked at the grid's
 * end ends there. A drained first bucket and an idle run are marked unblocked
 * in `outcomes`.
 */
function gapsOf(outcomes: BucketOutcome[], start: Ms, buckets: number): Gap[] {
  const gaps: Gap[] = [];
  let run: BucketOutcome[] = [];
  const close = (endK: number) => {
    const head = run[0];
    if (head?.usableAtStart && head.unserved === 0) {
      const next = run[1];
      if (next) {
        next.blocking = head.blocking;
        next.kind = next.kind === null ? head.kind : next.kind;
      }
      unblock(head);
      run = run.slice(1);
    }
    const first = run[0];
    if (!first) return;
    if (!hasDemand(run)) {
      for (const o of run) unblock(o);
      run = [];
      return;
    }
    const end = start + endK * HOUR_MS;
    gaps.push({
      kind: run.some((o) => o.kind === "7d") ? "7d" : "5h",
      start: first.at,
      end,
      lengthMs: end - first.at,
      binding: first.blocking,
    });
    run = [];
  };
  for (const o of outcomes) {
    if (o.blocked) run.push(o);
    else close(o.k);
  }
  close(buckets);
  return gaps;
}

export function simulate(
  views: readonly AccountView[],
  demand: readonly number[],
  cfg: AllowanceConfig,
  opts: SimOpts
): SimResult {
  const read = views.filter(isRead);
  const world = createWorld(read, opts.now);
  const buckets = gridBuckets(read, opts.now, opts.horizonMs ?? demand.length * HOUR_MS, cfg);
  const planDemand = opts.planDemand ?? { d75: [...demand], d90: [...demand] };
  const strategy = opts.strategy;

  let a0: AccountId | null = opts.thread?.account ?? null;
  let poolActive: AccountId | null = opts.poolActive ?? a0;
  let lastSwitchAt: Ms | null = opts.thread?.lastSwitchAt ?? null;
  const contextTokens = opts.thread?.contextTokens ?? cfg.REQ_CTX_DEFAULT;
  let plan: Plan | null = null;
  let replans = 0;

  const outcomes: BucketOutcome[] = [];
  const decisions: SimDecision[] = [];
  const remainingCombined: number[] = [];
  const remainingAt: SimResult["remainingAt"] = [];

  for (let k = 0; k < buckets; k++) {
    const at = world.start + k * HOUR_MS;
    const now = Math.max(opts.now, at);
    let first: AccountId | null | undefined;
    const bucketDecisions: SimDecision[] = [];

    const decideFn: DecideFn = (candidates) => {
      const input: DecisionInput = {
        now,
        views: candidates,
        thread: { account: a0, lastSwitchAt, contextTokens },
        poolActive,
        eligible: candidates.map((v) => eligibleOfView(v, cfg.SELECTION_THRESHOLD)),
      };
      if (strategy.plan) {
        const stale = strategy.needsReplan ? strategy.needsReplan(plan, input, cfg) : plan === null;
        if (stale) {
          plan = strategy.plan(
            {
              ...input,
              demand: { d75: planDemand.d75.slice(k), d90: planDemand.d90.slice(k) },
            },
            cfg
          );
          replans++;
        }
      }
      const d = strategy.decide(input, plan, cfg);
      if (first === undefined) first = d.account;
      if (d.account !== null && d.reason.endsWith("-switch")) lastSwitchAt = now;
      const entry: SimDecision = {
        k,
        account: d.account,
        reason: d.reason,
        usedPlan: d.usedPlan,
        cu: 0,
      };
      bucketDecisions.push(entry);
      decisions.push(entry);
      return d.account;
    };

    const outcome = stepBucket(world, k, demand[k] ?? 0, decideFn, cfg);
    outcomes.push(outcome);
    remainingAt.push(outcome.remainingAtStart);
    remainingCombined.push(combinedAtStart(world.views, outcome));
    for (const s of outcome.servedBy) {
      const entry = bucketDecisions.find((d) => d.account === s.account && d.cu === 0);
      if (entry) entry.cu = s.cu;
    }
    if (first !== undefined && first !== null) {
      a0 = first;
      poolActive = first;
    }
  }

  const gaps = gapsOf(outcomes, world.start, buckets);
  return {
    start: world.start,
    buckets,
    served: outcomes.map((o) => o.served),
    unserved: outcomes.map((o) => o.unserved),
    blocked: outcomes.map((o) => ({ blocked: o.blocked, kind: o.kind })),
    leftoverAtReset: world.leftoverAtReset,
    waste: world.waste,
    gaps,
    remainingCombined,
    remainingAt,
    decisions,
    replans,
  };
}

/** The combined capacity of `views` with each window at its bucket-start remaining. */
function combinedAtStart(views: readonly AccountView[], outcome: BucketOutcome): number {
  const atStart = views.map((v) => ({
    ...v,
    windows: v.windows.map((w) => ({
      ...w,
      remaining: outcome.remainingAtStart[v.account]?.[w.key] ?? w.remaining,
    })),
  }));
  return combinedNow(atStart).value;
}
