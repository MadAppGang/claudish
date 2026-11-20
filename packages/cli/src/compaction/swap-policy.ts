/**
 * When a ready history summary is swapped in: a pure decision over measured
 * numbers. No I/O, no clock, no catalog: the caller reads those and passes
 * the numbers in.
 *
 * Three policies (`compaction.history.policy`):
 *
 * - `threshold`: swap once the count reaches `applyAt` of the limit.
 * - `early`: the same rule; the policy only changes the default thresholds.
 * - `cost`: swap only when the swap pays for itself before Claude Code would
 *   compact on its own, or costs nothing extra.
 *
 * The cost of a swap. It rewrites the prompt from the summary on, so the
 * summary and the kept tail (`S + L` tokens) are written to the cache again
 * instead of read: an extra `(writeRatio − readRatio)·(L + S)` input tokens of
 * the main model, plus the Haiku call that made the summary. What it saves:
 * the removed `R` tokens are no longer read from the cache on each later
 * request, `readRatio·R` per request. It breaks even after
 *
 *   N* = [(writeRatio − readRatio)·(L + S) + haikuCost / p] / (readRatio·R)
 *
 * requests, where `p` is the main model's input price per token. Claude Code
 * compacts on its own at its compaction point, which ends the savings, so the
 * swap pays only when at least `N*` requests are projected before that point.
 * Two cases need no projection: a request that crosses Claude Code's point
 * gets the swap instead of Claude Code's compaction, and after a gap longer
 * than the cache TTL the cache is cold, so the request writes everything
 * anyway and the swap's write costs nothing extra.
 *
 * The room a swap leaves. The swapped request is `count − R` tokens: the
 * fixed prefix, the summary and what it carries (`S`) and the tail (`L`). It
 * reaches Claude Code's compaction point again after
 * `(ccCompactAt − (count − R)) / growth` requests, and the next swap writes
 * the cache again there. A swap that leaves fewer requests than `N*` cannot
 * pay for itself before that next write, so it holds, even when the next
 * request crosses the point. Measured on Claude Code 2.1.328: forced swaps
 * that left 4 requests of room swapped 14 times in 8 minutes of one turn.
 */

/**
 * `topic` swaps on a new topic (`topic.ts`) and otherwise follows the
 * `threshold` rule here.
 */
export type HistoryPolicy = "threshold" | "early" | "cost" | "topic";

export const HISTORY_POLICIES: readonly HistoryPolicy[] = ["threshold", "early", "cost", "topic"];

/** The main model's cache prices, as multiples of its input price. */
export interface CacheRatios {
  /** Input price, dollars per million tokens. */
  inputPerMTok: number;
  /** Cache-read price over input price. */
  readRatio: number;
  /** Cache-write price over input price, for the TTL the session writes with. */
  writeRatio: number;
}

export interface BreakEvenInput {
  /** L: the kept tail's tokens, written to the cache again by the swap. */
  tailTokens: number;
  /** S: the summary message's tokens. */
  summaryTokens: number;
  /** R: the tokens the swap removes from the request as sent, and from every later one. */
  removedTokens: number;
  ratios: CacheRatios;
  /** What the Haiku call that made the summary cost, in dollars. */
  haikuCostUsd: number;
}

export interface SwapDecisionInput extends Omit<BreakEvenInput, "ratios"> {
  policy: HistoryPolicy;
  /** The request's token count without the swap. */
  count: number;
  /** The effective limit, in tokens. */
  limit: number;
  /** Fractions of `limit`. */
  precomputeAt: number;
  applyAt: number;
  /** The token count at which Claude Code compacts on its own. */
  ccCompactAt: number;
  /** Undefined when the model has no published cache prices. */
  ratios?: CacheRatios;
  /** Time since the previous request of the thread; undefined for the first. */
  gapMs?: number;
  /** How long the session's cache entries live. */
  cacheTtlMs: number;
  /** Recent prompt growth per request, in tokens; undefined until measured. */
  growthPerRequest?: number;
}

export interface SwapDecision {
  swap: boolean;
  reason: string;
  /** Requests for the swap to break even; undefined without cache prices. */
  nStar?: number;
  /**
   * Requests until one reaches Claude Code's compaction point, that request
   * included: 1 means the next request crosses it, 0 that the count is
   * already past it. Undefined until growth is measured.
   */
  projectedRequestsBeforeCcCompact?: number;
  /**
   * Requests until the swapped request (`count − R`) reaches Claude Code's
   * compaction point, that request included. Undefined until growth is
   * measured.
   */
  requestsAfterSwap?: number;
}

/** N*, the requests a swap needs to pay for itself. Infinite when it removes nothing. */
export function breakEvenRequests(input: BreakEvenInput): number {
  const { readRatio, writeRatio, inputPerMTok } = input.ratios;
  const savedPerRequest = readRatio * input.removedTokens;
  if (!(savedPerRequest > 0)) return Number.POSITIVE_INFINITY;
  const pricePerToken = inputPerMTok / 1_000_000;
  const haikuTokens = pricePerToken > 0 ? input.haikuCostUsd / pricePerToken : 0;
  const extraWrite = (writeRatio - readRatio) * (input.tailTokens + input.summaryTokens);
  return (extraWrite + haikuTokens) / savedPerRequest;
}

/**
 * Requests until a request of `count` tokens reaches Claude Code's
 * compaction point; undefined without growth.
 */
function requestsUntilCcCompact(input: SwapDecisionInput, count: number): number | undefined {
  const remaining = input.ccCompactAt - count;
  if (remaining <= 0) return 0;
  const growth = input.growthPerRequest;
  if (!(typeof growth === "number" && growth > 0)) return undefined;
  return Math.ceil(remaining / growth);
}

function formatN(n: number): string {
  return Number.isFinite(n) ? n.toFixed(1) : "infinite";
}

/** The figures one decision is made from. */
interface DecisionFigures {
  nStar?: number;
  projected?: number;
  /** The swapped request's tokens, `count − R`. */
  afterSwap: number;
  room?: number;
}

function figuresOf(input: SwapDecisionInput): DecisionFigures {
  const afterSwap = input.count - input.removedTokens;
  const f: DecisionFigures = { afterSwap };
  if (input.ratios) f.nStar = breakEvenRequests({ ...input, ratios: input.ratios });
  const projected = requestsUntilCcCompact(input, input.count);
  if (projected !== undefined) f.projected = projected;
  const room = requestsUntilCcCompact(input, afterSwap);
  if (room !== undefined) f.room = room;
  return f;
}

function decisionOf(f: DecisionFigures, swap: boolean, reason: string): SwapDecision {
  const d: SwapDecision = { swap, reason };
  if (f.nStar !== undefined) d.nStar = f.nStar;
  if (f.projected !== undefined) d.projectedRequestsBeforeCcCompact = f.projected;
  if (f.room !== undefined) d.requestsAfterSwap = f.room;
  return d;
}

export function decideHistorySwap(input: SwapDecisionInput): SwapDecision {
  const f = figuresOf(input);
  if (input.policy === "cost") return decideCost(input, f);
  return input.count >= input.applyAt * input.limit
    ? decisionOf(f, true, `count reached applyAt ${input.applyAt}`)
    : decisionOf(f, false, `count below applyAt ${input.applyAt}`);
}

function decideCost(input: SwapDecisionInput, f: DecisionFigures): SwapDecision {
  const decide = (swap: boolean, reason: string) => decisionOf(f, swap, reason);
  const { nStar, projected, room, afterSwap } = f;
  if (input.count < input.precomputeAt * input.limit) {
    return decide(false, `count below precomputeAt ${input.precomputeAt}`);
  }
  if (input.gapMs !== undefined && input.gapMs > input.cacheTtlMs) {
    return decide(true, `cold cache: ${Math.round(input.gapMs / 1000)} s since the last request`);
  }
  if (nStar !== undefined && room !== undefined && room < nStar) {
    return decide(
      false,
      `the swap leaves ${Math.round(afterSwap)} tokens, Claude Code's compaction point again in ${room} requests, fewer than nStar ${formatN(nStar)}`
    );
  }
  if (projected !== undefined && projected <= 1) {
    return decide(true, "the next request crosses Claude Code's compaction point");
  }
  if (nStar === undefined) return decide(false, "no cache prices for the model");
  if (projected === undefined) return decide(false, "no growth per request measured yet");
  return projected >= nStar
    ? decide(true, `projected ${projected} >= nStar ${formatN(nStar)}`)
    : decide(false, `projected ${projected} < nStar ${formatN(nStar)}`);
}
