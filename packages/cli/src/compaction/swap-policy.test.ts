import { describe, expect, test } from "bun:test";
import { type SwapDecisionInput, breakEvenRequests, decideHistorySwap } from "./swap-policy.js";

/**
 * The measured figures of one history swap on a 200K window: the swap wrote
 * 60,897 tokens fresh to the cache and removed about 74,000, and Claude Code
 * compacted on its own about 6 requests later.
 */
const WRITTEN = 60_897;
const REMOVED = 74_000;
const LIMIT = 200_000;
const CC_POINT = 166_000;
/** 6 requests of 2,000 tokens each reach Claude Code's compaction point. */
const GROWTH = 2_000;
const COUNT = CC_POINT - 6 * GROWTH;

/** Sonnet 5.5 on the Claude API: $2 input, $0.10 cache read; a 5-minute cache write. */
const SONNET_5M = { inputPerMTok: 2, readRatio: 0.05, writeRatio: 1.25 };

function costInput(overrides: Partial<SwapDecisionInput> = {}): SwapDecisionInput {
  return {
    policy: "cost",
    count: COUNT,
    limit: LIMIT,
    precomputeAt: 0.5,
    applyAt: 0.7,
    ccCompactAt: CC_POINT,
    tailTokens: WRITTEN - 8_000,
    summaryTokens: 8_000,
    removedTokens: REMOVED,
    ratios: SONNET_5M,
    haikuCostUsd: 0,
    gapMs: 20_000,
    cacheTtlMs: 300_000,
    growthPerRequest: GROWTH,
    ...overrides,
  };
}

describe("breakEvenRequests", () => {
  test("Sonnet 5.5, 5-minute write: (1.25 - 0.05) x 60,897 / (0.05 x 74,000) is about 19.7", () => {
    const n = breakEvenRequests({
      tailTokens: WRITTEN,
      summaryTokens: 0,
      removedTokens: REMOVED,
      ratios: SONNET_5M,
      haikuCostUsd: 0,
    });
    expect(n).toBeCloseTo((1.2 * WRITTEN) / (0.05 * REMOVED), 6);
    expect(n).toBeGreaterThan(19.7);
    expect(n).toBeLessThan(19.8);
  });

  test("Fable 5.2, 5-minute write: a 0.025 read ratio puts it at about 40", () => {
    const n = breakEvenRequests({
      tailTokens: WRITTEN,
      summaryTokens: 0,
      removedTokens: REMOVED,
      ratios: { inputPerMTok: 8, readRatio: 0.025, writeRatio: 1.25 },
      haikuCostUsd: 0,
    });
    expect(n).toBeCloseTo((1.225 * WRITTEN) / (0.025 * REMOVED), 6);
    expect(Math.round(n)).toBe(40);
  });

  test("Opus 5.5, 5-minute write: a 0.05 read ratio, the same as Sonnet 5.5", () => {
    const n = breakEvenRequests({
      tailTokens: WRITTEN,
      summaryTokens: 0,
      removedTokens: REMOVED,
      ratios: { inputPerMTok: 4, readRatio: 0.05, writeRatio: 1.25 },
      haikuCostUsd: 0,
    });
    expect(n).toBeCloseTo((1.2 * WRITTEN) / (0.05 * REMOVED), 6);
  });

  test("an older model with a 0.1 read ratio breaks even sooner, at about 9.5", () => {
    const n = breakEvenRequests({
      tailTokens: WRITTEN,
      summaryTokens: 0,
      removedTokens: REMOVED,
      ratios: { inputPerMTok: 3, readRatio: 0.1, writeRatio: 1.25 },
      haikuCostUsd: 0,
    });
    expect(n).toBeCloseTo((1.15 * WRITTEN) / (0.1 * REMOVED), 6);
    expect(Math.round(n)).toBe(9);
  });

  test("a 1-hour cache write (2x) on Sonnet 5.5 raises it to about 32", () => {
    const n = breakEvenRequests({
      tailTokens: WRITTEN,
      summaryTokens: 0,
      removedTokens: REMOVED,
      ratios: { ...SONNET_5M, writeRatio: 2 },
      haikuCostUsd: 0,
    });
    expect(n).toBeCloseTo((1.95 * WRITTEN) / (0.05 * REMOVED), 6);
    expect(Math.round(n)).toBe(32);
  });

  test("the Haiku cost counts as input tokens of the main model: $0.03 at $2/MTok is 15,000", () => {
    const without = breakEvenRequests({
      tailTokens: WRITTEN,
      summaryTokens: 0,
      removedTokens: REMOVED,
      ratios: SONNET_5M,
      haikuCostUsd: 0,
    });
    const withHaiku = breakEvenRequests({
      tailTokens: WRITTEN,
      summaryTokens: 0,
      removedTokens: REMOVED,
      ratios: SONNET_5M,
      haikuCostUsd: 0.03,
    });
    expect(withHaiku - without).toBeCloseTo(15_000 / (0.05 * REMOVED), 6);
  });

  test("the summary is written to the cache with the tail: L + S", () => {
    const split = breakEvenRequests({
      tailTokens: WRITTEN - 8_000,
      summaryTokens: 8_000,
      removedTokens: REMOVED,
      ratios: SONNET_5M,
      haikuCostUsd: 0,
    });
    const whole = breakEvenRequests({
      tailTokens: WRITTEN,
      summaryTokens: 0,
      removedTokens: REMOVED,
      ratios: SONNET_5M,
      haikuCostUsd: 0,
    });
    expect(split).toBeCloseTo(whole, 9);
  });

  test("a swap that removes nothing never breaks even", () => {
    const n = breakEvenRequests({
      tailTokens: WRITTEN,
      summaryTokens: 0,
      removedTokens: 0,
      ratios: SONNET_5M,
      haikuCostUsd: 0,
    });
    expect(n).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("decideHistorySwap, policy cost", () => {
  test("at the measured figures it holds: 6 projected requests are fewer than nStar", () => {
    const d = decideHistorySwap(costInput());
    expect(d.swap).toBe(false);
    expect(d.projectedRequestsBeforeCcCompact).toBe(6);
    expect(d.nStar).toBeGreaterThan(19.7);
    expect(d.nStar).toBeLessThan(19.8);
    expect(d.reason).toContain("projected 6 < nStar");
  });

  test("it swaps when the next request is projected to cross Claude Code's compaction point", () => {
    const d = decideHistorySwap(costInput({ count: CC_POINT - GROWTH }));
    expect(d.swap).toBe(true);
    expect(d.projectedRequestsBeforeCcCompact).toBe(1);
    expect(d.reason).toContain("crosses Claude Code's compaction point");
  });

  test("it swaps when the count is already past Claude Code's compaction point", () => {
    const d = decideHistorySwap(costInput({ count: CC_POINT + 500 }));
    expect(d.swap).toBe(true);
    expect(d.projectedRequestsBeforeCcCompact).toBe(0);
  });

  test("it swaps on a cold cache: the gap is longer than the cache TTL", () => {
    const d = decideHistorySwap(costInput({ gapMs: 301_000 }));
    expect(d.swap).toBe(true);
    expect(d.reason).toContain("cold cache");
  });

  test("a cold cache below precomputeAt does not swap", () => {
    const d = decideHistorySwap(costInput({ gapMs: 301_000, count: 0.49 * LIMIT }));
    expect(d.swap).toBe(false);
  });

  test("a 1-hour cache is still warm after 6 minutes", () => {
    const d = decideHistorySwap(costInput({ gapMs: 360_000, cacheTtlMs: 3_600_000 }));
    expect(d.swap).toBe(false);
  });

  test("it swaps when the projected requests reach nStar", () => {
    // 30 requests of 1,000 tokens before Claude Code's point; nStar is about 19.7.
    const d = decideHistorySwap(costInput({ growthPerRequest: 1_000, count: CC_POINT - 30_000 }));
    expect(d.swap).toBe(true);
    expect(d.projectedRequestsBeforeCcCompact).toBe(30);
    expect(d.reason).toContain("projected 30 >= nStar");
  });

  test("with no price data it holds, and reports no nStar", () => {
    const d = decideHistorySwap(costInput({ ratios: undefined }));
    expect(d.swap).toBe(false);
    expect(d.nStar).toBeUndefined();
    expect(d.reason).toContain("no cache prices");
  });

  test("with no price data it still swaps before Claude Code's compaction point", () => {
    const d = decideHistorySwap(costInput({ ratios: undefined, count: CC_POINT - GROWTH }));
    expect(d.swap).toBe(true);
  });

  test("with no growth measured yet it holds, and reports no projection", () => {
    const d = decideHistorySwap(costInput({ growthPerRequest: undefined }));
    expect(d.swap).toBe(false);
    expect(d.projectedRequestsBeforeCcCompact).toBeUndefined();
  });

  test("below precomputeAt it holds", () => {
    const d = decideHistorySwap(costInput({ count: 0.49 * LIMIT }));
    expect(d.swap).toBe(false);
    expect(d.reason).toContain("below precomputeAt");
  });
});

describe("decideHistorySwap, policies threshold and early", () => {
  test("threshold swaps at applyAt, as before, whatever the cost", () => {
    const d = decideHistorySwap(
      costInput({ policy: "threshold", precomputeAt: 0.6, applyAt: 0.75, count: 0.75 * LIMIT })
    );
    expect(d.swap).toBe(true);
    expect(d.reason).toContain("applyAt");
  });

  test("threshold holds below applyAt, even when the cost model would swap", () => {
    const d = decideHistorySwap(
      costInput({
        policy: "threshold",
        precomputeAt: 0.6,
        applyAt: 0.75,
        count: 0.74 * LIMIT,
        gapMs: 3_600_000,
      })
    );
    expect(d.swap).toBe(false);
  });

  test("early swaps at its own applyAt", () => {
    const d = decideHistorySwap(
      costInput({ policy: "early", precomputeAt: 0.5, applyAt: 0.7, count: 0.7 * LIMIT })
    );
    expect(d.swap).toBe(true);
  });

  test("threshold still reports nStar and the projection for the log", () => {
    const d = decideHistorySwap(
      costInput({ policy: "threshold", precomputeAt: 0.6, applyAt: 0.75, count: 0.75 * LIMIT })
    );
    expect(d.nStar).toBeGreaterThan(19);
    expect(d.projectedRequestsBeforeCcCompact).toBe(Math.ceil((CC_POINT - 0.75 * LIMIT) / GROWTH));
  });
});

const SONNET_1H = { inputPerMTok: 2, readRatio: 0.05, writeRatio: 2 };

/**
 * A forced swap measured on Claude Code 2.1.328 in the bench (cost policy,
 * Sonnet 5.5, 1-hour cache writes): the next request crossed Claude Code's
 * compaction point at 166,000, the swap carried a 71,080-token tail and
 * 10,410 tokens of summary and inline system messages, and the swapped
 * request was 115,671 tokens. Prompts grew about 12,700 tokens a request, so
 * the next forced swap came 4 requests later.
 */
describe("the room a swap leaves", () => {
  const SENT = 160_000;
  const AFTER_SWAP = 115_671;
  const bench = (overrides: Partial<SwapDecisionInput> = {}) =>
    costInput({
      count: SENT,
      tailTokens: 71_080,
      summaryTokens: 10_410,
      removedTokens: SENT - AFTER_SWAP,
      ratios: SONNET_1H,
      growthPerRequest: 12_700,
      ...overrides,
    });

  test("an optional swap that reaches the compaction point again before it pays back holds", () => {
    const count = 140_000;
    const d = decideHistorySwap(bench({ count, removedTokens: count - (AFTER_SWAP - 20_000) }));
    expect(d.projectedRequestsBeforeCcCompact).toBe(3);
    expect(d.requestsAfterSwap).toBe(6);
    expect(d.nStar ?? 0).toBeGreaterThan(6);
    expect(d.swap).toBe(false);
    expect(d.reason).toBe(
      `the swap leaves ${AFTER_SWAP - 20_000} tokens, Claude Code's compaction point again in 6 requests, fewer than nStar ${(d.nStar ?? 0).toFixed(1)}`
    );
  });

  test("the 02:17:25 bench swap, with no Claude Code compaction measured, swaps", () => {
    const d = decideHistorySwap(bench());
    expect(d.projectedRequestsBeforeCcCompact).toBe(1);
    expect(d.requestsAfterSwap).toBe(4);
    expect(d.requestsAfterCcCompact).toBeUndefined();
    expect(d.swap).toBe(true);
    expect(d.reason).toBe(
      "the next request crosses Claude Code's compaction point; no Claude Code compaction measured yet"
    );
  });

  test("the 02:17:25 bench swap holds when Claude Code's measured compaction leaves more room", () => {
    const d = decideHistorySwap(bench({ ccCompactedTokens: 60_000 }));
    expect(d.requestsAfterSwap).toBe(4);
    expect(d.requestsAfterCcCompact).toBe(9);
    expect(d.swap).toBe(false);
    expect(d.reason).toBe(
      "the next request crosses Claude Code's compaction point; the swap leaves 4 requests, Claude Code's compaction 9"
    );
  });

  test("a forced swap that leaves room for nStar requests swaps", () => {
    const d = decideHistorySwap(
      bench({
        count: 162_000,
        tailTokens: 21_000,
        summaryTokens: 11_000,
        removedTokens: 102_000,
        growthPerRequest: 5_000,
      })
    );
    expect(d.requestsAfterSwap).toBe(22);
    expect(d.nStar ?? Number.POSITIVE_INFINITY).toBeLessThan(22);
    expect(d.swap).toBe(true);
    expect(d.reason).toContain("the next request crosses Claude Code's compaction point");
  });

  test("on a cold cache the swap writes nothing extra, so little room does not hold it", () => {
    const d = decideHistorySwap(bench({ gapMs: 301_000, ccCompactedTokens: 60_000 }));
    expect(d.requestsAfterSwap).toBe(4);
    expect(d.swap).toBe(true);
    expect(d.reason).toContain("cold cache");
  });
});

/**
 * The forced decision at 03:04:06 in a live session on Claude Code 2.1.328
 * (cost policy, Sonnet 5.5): 165,927 tokens, L 13,227, S 62,052, R 56,548,
 * nStar 52.2, so the swapped request was 109,379 tokens, 12 requests of
 * room at about 5,000 tokens a request. The session's previous Claude Code
 * compaction left 129,383 tokens (98,552 written, 30,831 read): 8 requests.
 */
describe("a forced swap against Claude Code's compaction", () => {
  const live = (overrides: Partial<SwapDecisionInput> = {}) =>
    costInput({
      count: 165_927,
      tailTokens: 13_227,
      summaryTokens: 62_052,
      removedTokens: 56_548,
      ratios: SONNET_1H,
      growthPerRequest: 5_000,
      ccCompactedTokens: 129_383,
      ...overrides,
    });

  test("the 03:04:06 swap leaves more room than Claude Code's compaction, so it swaps", () => {
    const d = decideHistorySwap(live());
    expect(d.projectedRequestsBeforeCcCompact).toBe(1);
    expect(d.requestsAfterSwap).toBe(12);
    expect(d.requestsAfterCcCompact).toBe(8);
    expect(d.nStar ?? 0).toBeGreaterThan(12);
    expect(d.swap).toBe(true);
    expect(d.reason).toBe(
      "the next request crosses Claude Code's compaction point; the swap leaves 12 requests, Claude Code's compaction 8"
    );
  });

  test("equal room swaps: the compaction also writes the cache and costs a main-model call", () => {
    const d = decideHistorySwap(live({ ccCompactedTokens: 109_379 }));
    expect(d.requestsAfterCcCompact).toBe(12);
    expect(d.swap).toBe(true);
  });
});

/** Opus 5.5 on the Claude API: $4 input, a 0.05 read ratio; a 1-hour cache write. */
const OPUS_1H = { inputPerMTok: 4, readRatio: 0.05, writeRatio: 2 };

/**
 * The Opus 5.5 bench trial on Claude Code 2.1.329 (cost policy): Claude Code
 * never compacted, so nothing was measured, and six forced swaps came 5 to 11
 * requests apart between 04:25:17 and 04:28:00, each writing 18K-82K tokens.
 * Growth per request is solved from each line's projected and
 * requestsAfterSwap.
 */
describe("a forced swap soon after a forced swap, with nothing measured", () => {
  const opus = (overrides: Partial<SwapDecisionInput>) =>
    costInput({ ratios: OPUS_1H, ...overrides });
  const line0425_38 = {
    count: 149_399,
    tailTokens: 69_204,
    summaryTokens: 9_165,
    removedTokens: 38_850,
    growthPerRequest: 17_000,
  };

  test("04:25:38, 5 requests after the forced swap at 04:25:17, holds so Claude Code compacts once", () => {
    const d = decideHistorySwap(opus({ ...line0425_38, lastForcedSwapGap: 5 }));
    expect(d.projectedRequestsBeforeCcCompact).toBe(1);
    expect(d.requestsAfterSwap).toBe(4);
    expect(d.nStar ?? 0).toBeGreaterThan(78);
    expect(d.lastForcedSwapGap).toBe(5);
    expect(d.swap).toBe(false);
    expect(d.reason).toBe(
      `the next request crosses Claude Code's compaction point; no Claude Code compaction measured yet, and the last forced swap left 5 requests, fewer than nStar ${(d.nStar ?? 0).toFixed(1)}`
    );
  });

  test("the rest of the burst holds too: 6, 8 and 7 requests after a forced swap, below nStar", () => {
    const lines = [
      {
        count: 158_430,
        tailTokens: 46_810,
        summaryTokens: 8_819,
        removedTokens: 70_597,
        growthPerRequest: 8_000,
        lastForcedSwapGap: 6,
        room: 10,
      },
      {
        count: 165_010,
        tailTokens: 61_862,
        summaryTokens: 8_914,
        removedTokens: 62_004,
        growthPerRequest: 10_000,
        lastForcedSwapGap: 8,
        room: 7,
      },
      {
        count: 158_124,
        tailTokens: 42_698,
        summaryTokens: 9_041,
        removedTokens: 74_322,
        growthPerRequest: 8_500,
        lastForcedSwapGap: 7,
        room: 10,
      },
    ];
    for (const { room, ...line } of lines) {
      const d = decideHistorySwap(opus(line));
      expect(d.projectedRequestsBeforeCcCompact).toBe(1);
      expect(d.requestsAfterSwap).toBe(room);
      expect(d.swap).toBe(false);
    }
  });

  test("04:25:17, the first forced swap after a cost swap, still swaps", () => {
    const d = decideHistorySwap(
      opus({
        count: 167_810,
        tailTokens: 26_023,
        summaryTokens: 8_726,
        removedTokens: 101_312,
        growthPerRequest: 13_000,
      })
    );
    expect(d.projectedRequestsBeforeCcCompact).toBe(0);
    expect(d.requestsAfterSwap).toBe(8);
    expect(d.swap).toBe(true);
    expect(d.reason).toBe(
      "the next request crosses Claude Code's compaction point; no Claude Code compaction measured yet"
    );
  });

  test("04:28:00, 11 requests after a forced swap, above nStar 6.4, swaps", () => {
    const d = decideHistorySwap(
      opus({
        count: 161_370,
        tailTokens: 8_874,
        summaryTokens: 9_015,
        removedTokens: 111_953,
        growthPerRequest: 6_000,
        lastForcedSwapGap: 11,
      })
    );
    expect(d.requestsAfterSwap).toBe(20);
    expect(d.nStar ?? Number.POSITIVE_INFINITY).toBeLessThan(11);
    expect(d.swap).toBe(true);
  });

  test("a measured Claude Code compaction decides instead of the gap", () => {
    const d = decideHistorySwap(
      opus({ ...line0425_38, lastForcedSwapGap: 5, ccCompactedTokens: 120_000 })
    );
    expect(d.requestsAfterCcCompact).toBe(3);
    expect(d.swap).toBe(true);
    expect(d.reason).toBe(
      "the next request crosses Claude Code's compaction point; the swap leaves 4 requests, Claude Code's compaction 3"
    );
  });

  test("the Sonnet XL trial keeps its 3 swaps, 47, 29 and 44 requests apart", () => {
    const sonnet = (overrides: Partial<SwapDecisionInput>) =>
      costInput({ ratios: SONNET_1H, ...overrides });
    const decisions = [
      // 03:40:43, a cost swap.
      sonnet({
        count: 100_690,
        tailTokens: 6_592,
        summaryTokens: 8_774,
        removedTokens: 56_796,
        growthPerRequest: 2_340,
      }),
      // 03:46:31, forced, 29 requests after the cost swap.
      sonnet({
        count: 157_004,
        tailTokens: 86_962,
        summaryTokens: 8_854,
        removedTokens: 30_565,
        growthPerRequest: 10_000,
      }),
      // 03:57:57, forced, 44 requests after the forced swap, Claude Code's compaction measured at 55,437.
      sonnet({
        count: 161_525,
        tailTokens: 9_240,
        summaryTokens: 7_851,
        removedTokens: 111_522,
        growthPerRequest: 12_000,
        lastForcedSwapGap: 44,
        ccCompactedTokens: 55_437,
      }),
    ].map(decideHistorySwap);
    expect(decisions.map((d) => d.requestsAfterSwap)).toEqual([53, 4, 10]);
    expect(decisions[0].reason).toContain("projected 28 >= nStar");
    expect(decisions[1].nStar ?? 0).toBeGreaterThan(120);
    expect(decisions[2].requestsAfterCcCompact).toBe(10);
    expect(decisions.map((d) => d.swap)).toEqual([true, true, true]);
  });
});

/**
 * A ready summary can be as long as the messages it replaces: the request as
 * sent then loses nothing (`R` is 0), and a swap only costs a cache write.
 */
describe("a swap that removes nothing", () => {
  test("holds on a cold cache", () => {
    const d = decideHistorySwap(costInput({ removedTokens: 0, gapMs: 400_000 }));
    expect(d.swap).toBe(false);
    expect(d.reason).toBe("the swap removes no tokens from the request");
  });

  test("holds at the forced point with no Claude Code compaction measured", () => {
    const d = decideHistorySwap(costInput({ removedTokens: 0, count: 165_000 }));
    expect(d.projectedRequestsBeforeCcCompact).toBe(1);
    expect(d.swap).toBe(false);
    expect(d.reason).toBe("the swap removes no tokens from the request");
  });

  test("holds under threshold at applyAt", () => {
    const d = decideHistorySwap(
      costInput({ policy: "threshold", removedTokens: 0, applyAt: 0.75, count: 0.75 * LIMIT })
    );
    expect(d.swap).toBe(false);
    expect(d.reason).toBe("the swap removes no tokens from the request");
  });
});

/** The forced point on a model with no published cache prices: no nStar. */
describe("a forced swap with no cache prices", () => {
  const unpriced = (overrides: Partial<SwapDecisionInput>): SwapDecisionInput => {
    const { ratios: _none, ...input } = costInput({ count: 165_000, ...overrides });
    return input;
  };

  test("the first forced swap is made", () => {
    const d = decideHistorySwap(unpriced({}));
    expect(d.nStar).toBeUndefined();
    expect(d.swap).toBe(true);
  });

  test("a forced swap after a forced swap holds, so Claude Code compacts once", () => {
    const d = decideHistorySwap(unpriced({ lastForcedSwapGap: 40 }));
    expect(d.swap).toBe(false);
    expect(d.reason).toBe(
      "the next request crosses Claude Code's compaction point; no Claude Code compaction measured yet, and the last forced swap left 40 requests with no cache prices to weigh them"
    );
  });
});

/**
 * Right after a swap the growth window holds one count, so no growth is
 * measured and neither room is known in requests. The measured compaction
 * size still decides: at the same growth, a smaller request leaves at least
 * as much room.
 */
describe("a forced swap with a measured compaction and no growth", () => {
  const noGrowth = (overrides: Partial<SwapDecisionInput>): SwapDecisionInput => {
    const { growthPerRequest: _none, ...input } = costInput({
      count: 170_000,
      removedTokens: 40_000,
      ...overrides,
    });
    return input;
  };

  test("holds when Claude Code's compaction leaves the smaller request", () => {
    const d = decideHistorySwap(noGrowth({ ccCompactedTokens: 110_000 }));
    expect(d.projectedRequestsBeforeCcCompact).toBe(0);
    expect(d.requestsAfterSwap).toBeUndefined();
    expect(d.swap).toBe(false);
    expect(d.reason).toBe(
      "the next request crosses Claude Code's compaction point; no growth measured, the swap leaves 130000 tokens, Claude Code's compaction 110000"
    );
  });

  test("swaps when the swap leaves the smaller request", () => {
    const d = decideHistorySwap(noGrowth({ ccCompactedTokens: 140_000 }));
    expect(d.swap).toBe(true);
    expect(d.reason).toBe(
      "the next request crosses Claude Code's compaction point; no growth measured, the swap leaves 130000 tokens, Claude Code's compaction 140000"
    );
  });
});
