/**
 * The main model's cache prices as the ratios the history swap policy reads
 * (`swap-policy.ts`).
 *
 * The input and cache-read rates come from the model's own connection in the
 * cloud models catalog (`getModelPricing` / the Claude API meter's banded
 * rates). The catalog publishes no cache-write rate for any Claude connection
 * today, so the write ratio follows Anthropic's billing rule by TTL: a
 * 5-minute write costs 1.25x input and a 1-hour write 2x. A published
 * `cacheWriteCostPer1M` (the 5-minute rate) replaces the 5-minute multiplier.
 */

import type { CacheRatios } from "./swap-policy.js";

/** Anthropic bills a 5-minute cache write at this multiple of the input price. */
export const FIVE_MINUTE_WRITE_MULTIPLIER = 1.25;
/** Anthropic bills a 1-hour cache write at this multiple of the input price. */
export const ONE_HOUR_WRITE_MULTIPLIER = 2;

export const FIVE_MINUTE_TTL_MS = 5 * 60_000;
export const ONE_HOUR_TTL_MS = 60 * 60_000;

/** The tokens one response wrote to the cache, by TTL (`usage.cache_creation`). */
export interface CacheWriteSplit {
  fiveMinute: number;
  oneHour: number;
}

/** The rates the ratios are read from, per million tokens. */
export interface CachePricing {
  inputCostPer1M: number;
  outputCostPer1M?: number;
  cacheReadCostPer1M?: number;
  cacheWriteCostPer1M?: number;
  isEstimate?: boolean;
}

function positive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * The ratios, or undefined when the pricing is an estimate or publishes no
 * cache-read rate: an unpublished rate is not guessed.
 */
export function cacheRatios(
  pricing: CachePricing | undefined,
  split: CacheWriteSplit | undefined
): CacheRatios | undefined {
  if (!pricing || pricing.isEstimate) return undefined;
  const input = pricing.inputCostPer1M;
  if (!positive(input) || !positive(pricing.cacheReadCostPer1M)) return undefined;
  const fiveMinute = positive(pricing.cacheWriteCostPer1M)
    ? pricing.cacheWriteCostPer1M / input
    : FIVE_MINUTE_WRITE_MULTIPLIER;
  const five = positive(split?.fiveMinute) ? split.fiveMinute : 0;
  const hour = positive(split?.oneHour) ? split.oneHour : 0;
  const writeRatio =
    five + hour > 0
      ? (five * fiveMinute + hour * ONE_HOUR_WRITE_MULTIPLIER) / (five + hour)
      : fiveMinute;
  return { inputPerMTok: input, readRatio: pricing.cacheReadCostPer1M / input, writeRatio };
}

/**
 * How long until the whole cache is cold: 1 hour when the last write held any
 * 1-hour entry, else 5 minutes. A mixed write's 1-hour entries can still be
 * read after its 5-minute ones expire, and the split does not say where in
 * the prompt they sit, so only the longer lifetime proves the cache cold.
 */
export function cacheTtlMs(split: CacheWriteSplit | undefined): number {
  const hour = positive(split?.oneHour) ? split.oneHour : 0;
  return hour > 0 ? ONE_HOUR_TTL_MS : FIVE_MINUTE_TTL_MS;
}
