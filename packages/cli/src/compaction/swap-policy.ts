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
  /** R: the tokens the swap removes from every later request. */
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

/** Requests until Claude Code's compaction point is reached; undefined without growth. */
function projectedRequests(input: SwapDecisionInput): number | undefined {
  const remaining = input.ccCompactAt - input.count;
  if (remaining <= 0) return 0;
  const growth = input.growthPerRequest;
  if (!(typeof growth === "number" && growth > 0)) return undefined;
  return Math.ceil(remaining / growth);
}

function formatN(n: number): string {
  return Number.isFinite(n) ? n.toFixed(1) : "infinite";
}

export function decideHistorySwap(input: SwapDecisionInput): SwapDecision {
  const nStar = input.ratios ? breakEvenRequests({ ...input, ratios: input.ratios }) : undefined;
  const projected = projectedRequests(input);
  const figures = {
    ...(nStar !== undefined ? { nStar } : {}),
    ...(projected !== undefined ? { projectedRequestsBeforeCcCompact: projected } : {}),
  };
  const decide = (swap: boolean, reason: string): SwapDecision => ({ swap, reason, ...figures });

  if (input.policy !== "cost") {
    return input.count >= input.applyAt * input.limit
      ? decide(true, `count reached applyAt ${input.applyAt}`)
      : decide(false, `count below applyAt ${input.applyAt}`);
  }

  if (input.count < input.precomputeAt * input.limit) {
    return decide(false, `count below precomputeAt ${input.precomputeAt}`);
  }
  if (projected !== undefined && projected <= 1) {
    return decide(true, "the next request crosses Claude Code's compaction point");
  }
  if (input.gapMs !== undefined && input.gapMs > input.cacheTtlMs) {
    return decide(true, `cold cache: ${Math.round(input.gapMs / 1000)} s since the last request`);
  }
  if (nStar === undefined) return decide(false, "no cache prices for the model");
  if (projected === undefined) return decide(false, "no growth per request measured yet");
  return projected >= nStar
    ? decide(true, `projected ${projected} >= nStar ${formatN(nStar)}`)
    : decide(false, `projected ${projected} < nStar ${formatN(nStar)}`);
}
