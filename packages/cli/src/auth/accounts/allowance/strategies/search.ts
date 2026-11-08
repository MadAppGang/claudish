/**
 * The bounded depth-first search over account SEQUENCES behind `lookahead`
 * (architecture §1.8 steps 3–5, revision 2 item 2). A heuristic with a depth
 * bound, not an optimum: the tournament (§4) decides whether it earns a default.
 *
 * - **Sequences.** One account per kept branch point. Between two points the
 *   assigned account serves first and leftover demand spills in EBR order
 *   (inside the search only); after the last point the last account stays first
 *   to the end of the horizon. Every segment is rolled out with `stepBucket`,
 *   the stepper `simulate` uses.
 * - **A segment with no demand is not branched:** its account is carried from
 *   the previous point (the hand traces' "·"), so an idle hour never counts as
 *   a switch and never multiplies the leaves.
 * - **Feasibility.** At the root an account must be feasible now; at a later
 *   point the assigned account must be usable and not hard-full the first time
 *   it is asked, AFTER that bucket's resets (so every read account is a child:
 *   one that refills at the point is a candidate there). Otherwise that child
 *   is dropped. When no child of a point is feasible, the segment is rolled out
 *   with the previous account first and everything spilling, so a sequence
 *   that runs into a block is still priced, never lost.
 * - **Cost** `J = UNSERVED_WEIGHT·Σ unserved + waste_H + Σ c_sw`: waste only at
 *   governing resets inside the horizon; `c_sw` = c_s for a switch at a point
 *   before the thread's expected end, 0 at or after it; the root switch is left
 *   out (the decision gate prices it).
 * - **Branch-and-bound.** Every term of J only grows along a rollout, so the
 *   partial J is a lower bound. A partial sequence is cut when its bound exceeds
 *   the best complete J found so far FOR ITS FIRST ACCOUNT, or equals it with at
 *   least as many switches (ties go to fewer switches).
 * - **Budget.** `budget` rolled-out segments; when it runs out the result says
 *   `truncated` and keeps the best found.
 */

import { feasible, isRead } from "../capacity.js";
import { type BucketOutcome, type SimWorld, cloneWorld, createWorld, stepBucket } from "../step.js";
import type { AccountId, AccountView, AllowanceConfig, Ms, WindowKey } from "../types.js";
import { byBindingReset } from "./ebr.js";

export interface SearchInput {
  now: Ms;
  /** The read accounts the search may assign (AFTER the policy blockers). */
  views: readonly AccountView[];
  /** cu per bucket from `floor(now/1h)`; a missing bucket is 0. */
  demand: readonly number[];
  /** Kept branch points as bucket indices, ascending, the first 0. */
  points: readonly number[];
  /** Buckets rolled out: the search's horizon. */
  horizon: number;
  /** The bucket of the thread's expected end: a switch at a point before it costs `switchCost`. */
  tailBucket: number;
  /** c_s in cu. */
  switchCost: number;
  contextTokens: number | null;
  /** Rolled-out segments allowed. */
  budget: number;
}

export interface SequenceResult {
  /** J on this demand path, in cu. */
  j: number;
  /** Switches after the root. */
  switches: number;
  /** One account per kept branch point. */
  sequence: AccountId[];
  /** Every read window's remaining at the start of each bucket of the first segment. */
  projected: { at: Ms; remaining: Record<AccountId, Record<WindowKey, number>> }[];
}

export interface SearchResult {
  /** The best sequence per first account, for every first account fully explored or cut. */
  perFirst: Record<AccountId, SequenceResult>;
  /** Rolled-out segments. */
  nodes: number;
  truncated: boolean;
}

type SearchCfg = Pick<
  AllowanceConfig,
  | "UNSERVED_WEIGHT"
  | "SHORT_WINDOW_MAX_MIN"
  | "provider"
  | "REQ_CTX_DEFAULT"
  | "REQ_OUTPUT_EST"
  | "HARD_MIN_REMAINING"
>;

/** Two costs are equal within a relative 1e-9: cu run to 10⁶ and more. */
function same(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

interface Rollout {
  valid: boolean;
  unserved: number;
  outcomes: BucketOutcome[];
}

/**
 * Buckets [from, to) with `account` first and the rest spilling in EBR order.
 * Invalid when the account is not usable, or is hard-full for this request, the
 * first time it is asked in the segment.
 */
function rollSegment(
  world: SimWorld,
  from: number,
  to: number,
  account: AccountId,
  input: SearchInput,
  cfg: SearchCfg,
  strict = true
): Rollout {
  let asked = false;
  let valid = true;
  let unserved = 0;
  const outcomes: BucketOutcome[] = [];
  for (let k = from; k < to && valid; k++) {
    const outcome = stepBucket(
      world,
      k,
      input.demand[k] ?? 0,
      (candidates) => {
        const own = candidates.find((v) => v.account === account);
        if (!asked && strict) {
          asked = true;
          if (!own || !feasible(own, input.contextTokens, cfg)) {
            valid = false;
            return null;
          }
        }
        if (own) return own.account;
        return [...candidates].sort(byBindingReset)[0]?.account ?? null;
      },
      cfg
    );
    unserved += outcome.unserved;
    outcomes.push(outcome);
  }
  return { valid, unserved, outcomes };
}

function demandIn(demand: readonly number[], from: number, to: number): number {
  let sum = 0;
  for (let k = from; k < to; k++) sum += demand[k] ?? 0;
  return sum;
}

export function searchSequences(input: SearchInput, cfg: SearchCfg): SearchResult {
  const perFirst: Record<AccountId, SequenceResult> = {};
  const points = input.points.filter((k) => k >= 0 && k < input.horizon);
  if (points[0] !== 0) points.unshift(0);
  const read = input.views.filter(isRead);
  const roots = read
    .filter((v) => feasible(v, input.contextTokens, cfg))
    .sort(byBindingReset)
    .map((v) => v.account);
  let nodes = 0;
  let truncated = false;

  const cut = (first: AccountId, bound: number, switches: number): boolean => {
    const best = perFirst[first];
    if (!best) return false;
    if (same(bound, best.j)) return switches >= best.switches;
    return bound > best.j;
  };

  const visit = (
    world: SimWorld,
    level: number,
    sequence: AccountId[],
    unserved: number,
    switchCost: number,
    switches: number,
    projected: SequenceResult["projected"]
  ): void => {
    const from = points[level] ?? 0;
    const to = points[level + 1] ?? input.horizon;
    const previous = sequence[sequence.length - 1];
    let children: AccountId[];
    if (level === 0) children = roots;
    else if (previous !== undefined && demandIn(input.demand, from, to) <= 0) children = [previous];
    else
      children = world.views
        .filter(isRead)
        .sort(byBindingReset)
        .map((v) => v.account);
    // The last entry, the previous account rolled out non-strictly, is tried only when no child was feasible.
    const tries: { account: AccountId; strict: boolean }[] = children.map((account) => ({
      account,
      strict: true,
    }));
    let anyValid = false;

    for (let i = 0; i <= tries.length; i++) {
      let attempt = tries[i];
      if (!attempt) {
        if (anyValid || level === 0 || previous === undefined) break;
        attempt = { account: previous, strict: false };
      }
      if (nodes >= input.budget) {
        truncated = true;
        return;
      }
      nodes++;
      const child = attempt.account;
      const next = cloneWorld(world);
      const rollout = rollSegment(next, from, to, child, input, cfg, attempt.strict);
      if (!rollout.valid) continue;
      anyValid = true;
      const switched = level > 0 && previous !== undefined && child !== previous;
      const cost = switchCost + (switched && from < input.tailBucket ? input.switchCost : 0);
      const totalUnserved = unserved + rollout.unserved;
      const bound = cfg.UNSERVED_WEIGHT * totalUnserved + next.waste + cost;
      const first = level === 0 ? child : (sequence[0] ?? child);
      const nextSwitches = switches + (switched ? 1 : 0);
      if (cut(first, bound, nextSwitches)) continue;
      const seq = [...sequence, child];
      const proj =
        level === 0
          ? rollout.outcomes.map((o) => ({ at: o.at, remaining: o.remainingAtStart }))
          : projected;
      if (level + 1 >= points.length) {
        perFirst[first] = { j: bound, switches: nextSwitches, sequence: seq, projected: proj };
      } else {
        visit(next, level + 1, seq, totalUnserved, cost, nextSwitches, proj);
        if (truncated) return;
      }
    }
  };

  if (points.length > 0 && roots.length > 0) {
    visit(createWorld(read, input.now), 0, [], 0, 0, 0, []);
  }
  return { perFirst, nodes, truncated };
}

/**
 * J of ONE fixed sequence on a demand path, or null when the sequence is not
 * feasible on it: the p90 figure for a first account whose p90 search ran out of
 * budget before reaching it.
 */
export function evaluateSequence(
  input: Omit<SearchInput, "budget">,
  sequence: readonly AccountId[],
  cfg: SearchCfg
): number | null {
  const points = input.points.filter((k) => k >= 0 && k < input.horizon);
  if (points[0] !== 0) points.unshift(0);
  const world = createWorld(input.views.filter(isRead), input.now);
  const full: SearchInput = { ...input, budget: Number.POSITIVE_INFINITY };
  let unserved = 0;
  let cost = 0;
  for (let level = 0; level < points.length; level++) {
    const account = sequence[level] ?? sequence[sequence.length - 1];
    if (account === undefined) return null;
    const from = points[level] ?? 0;
    const to = points[level + 1] ?? input.horizon;
    const rollout = rollSegment(world, from, to, account, full, cfg);
    if (!rollout.valid && demandIn(input.demand, from, to) > 0) return null;
    unserved += rollout.unserved;
    const previous = level > 0 ? sequence[level - 1] : undefined;
    if (previous !== undefined && previous !== account && from < input.tailBucket)
      cost += input.switchCost;
  }
  return cfg.UNSERVED_WEIGHT * unserved + world.waste + cost;
}
