/**
 * One comparable price per CONNECTION, read from the cloud models catalog.
 *
 * A connection is one mapped way to call a model — an `aggregators[]` entry
 * with `routeStatus: "mapped"`. Each carries the serving gateway's OWN rate, so
 * two connections to the same canonical model id routinely cost different
 * amounts. To order them, routing needs one number per connection, and this
 * module is the only place that decides what that number is.
 *
 * **What the number is for.** It exists to ORDER connections BEFORE a request
 * is built, when the input size is not yet known. That constrains it hard:
 *
 *   - Tiered prices are read from the FIRST tier and nothing else. The number
 *     never averages tiers, and it never selects a tier from a request's size —
 *     there is no request yet. A per-request cost estimate is a different
 *     calculation that would take the real input size as an argument; this is
 *     not it, and it must not be mistaken for it.
 *   - It is a rate in dollars per million tokens, summed over input and output
 *     (`input + output`), which is a ranking key rather than a bill. It assumes
 *     nothing about the input:output mix of the eventual request.
 *
 * **What an unknown price means.** claudish reads the discriminator
 * `pricing.type` and only `pricing.type` — there is no alias and no fallback
 * to any other field name. Unknown therefore means one of three concrete things:
 * the catalog published `type: "unavailable"` for that connection (467 of them
 * on generation `g-20260921062451697-f490edba`), the connection carries no
 * pricing object at all, or it quotes a metered price of exactly zero, which is
 * missing data rather than a price ({@link isUnmeasuredZero}). Measured on that
 * generation, 644 of 1,734 mapped connections read as unknown, so every caller
 * must render and sort it — it is a sizeable minority, never a rare case.
 *
 * Absent-means-unknown is a rule, never an inference: without the
 * discriminator this module does not know how to read the rest of the object,
 * so it does not treat the presence of `input`/`output` as evidence of a flat
 * price. Numbers read under a guessed type are worse than no numbers.
 */

import type { ModelPricing } from "../handlers/shared/remote-provider-types.js";
import type { AggregatorEntry } from "../model-loader.js";

/** A connection's price reduced to one number that can be ordered, plus what to show a user. */
export type ConnectionPrice =
  | { known: true; perMillionTokens: number; label: string }
  | { known: false; label: string };

/**
 * A fresh object per call, so a caller that decorates or mutates the result
 * cannot corrupt a shared one.
 */
function unknownPrice(): ConnectionPrice {
  return { known: false, label: "unknown" };
}

/**
 * A catalog rate claudish is willing to act on, or `null`.
 *
 * Rejecting instead of trusting matters because the catalog aggregates
 * scraped sources: a missing field arrives as `undefined`, a failed parse can
 * arrive as `NaN`, and a sentinel can arrive as `-1`. Any of those summed into
 * a ranking key would sort a connection to a position nothing justifies, and
 * `-1` would sort it AHEAD of a genuinely free one. Zero is kept — free is a
 * real price.
 */
function usableRate(value: number | undefined): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  if (value < 0) return null;
  return value;
}

/** `input + output`, or `null` when either side is not a rate worth acting on. */
function sumRates(input: number | undefined, output: number | undefined): number | null {
  const inputRate = usableRate(input);
  const outputRate = usableRate(output);
  if (inputRate === null || outputRate === null) return null;
  return inputRate + outputRate;
}

/**
 * A summed rate of exactly zero under `flat` or `tiered` is MISSING DATA, not free.
 *
 * The contract has a way to say free, and 30 connections use it: `type: "free"`.
 * A metered gateway that quotes `flat` with `input: 0, output: 0` is quoting a
 * price nobody measured. Measured on generation `g-20260921062451697-f490edba`:
 * 167 connections do exactly that, and 163 of them are `together-ai/gateway`, on
 * models Together AI plainly charges for (`glm-5.3-fp8`, `minimax-h3`, `flux-3`).
 *
 * Reading those as free would put them FIRST in every price comparison, so
 * routing would prefer a gateway on a number that does not exist — the one
 * ordering error that costs a user money rather than merely a better option. An
 * unknown price sorts last instead, which is recoverable: the connection is still
 * reachable, just not preferred on a fabricated zero.
 *
 * Asymmetric on purpose. A zero on ONE side is kept: free input with paid output
 * is a real tariff several gateways publish. Only zero on BOTH sides is rejected.
 */
function isUnmeasuredZero(perMillionTokens: number): boolean {
  return perMillionTokens === 0;
}

/** Strip the trailing zeros a fixed-precision render leaves behind: `"0.0060"` → `"0.006"`. */
function trimTrailingZeros(text: string): string {
  if (!text.includes(".") || text.includes("e")) return text;
  return text.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Short, currency-marked, and derived entirely from the number — no price is
 * ever hardcoded here.
 *
 * Two decimals read naturally for the common range (`"$1.50/M"`), but sub-cent
 * rates exist and `toFixed(2)` renders them as `"$0.00/M"`, which a user reads
 * as free. Those fall back to two significant digits (`"$0.006/M"`). A rate of
 * exactly zero is free whatever the `type` said, so it says so.
 */
function perMillionLabel(perMillionTokens: number): string {
  if (perMillionTokens === 0) return "free";
  if (perMillionTokens < 0.01) return `$${trimTrailingZeros(perMillionTokens.toPrecision(2))}/M`;
  return `$${perMillionTokens.toFixed(2)}/M`;
}

/**
 * Reduce one connection's catalog pricing to a single orderable number.
 *
 * The rules, agreed with the backend — these and no others:
 *
 * | `pricing.type`      | number                               | label                  |
 * |---------------------|--------------------------------------|------------------------|
 * | `"flat"`            | `input + output`                     | `"$1.50/M"`            |
 * | `"tiered"`          | `tiers[0].input + tiers[0].output`   | `"$0.16/M (first tier)"` |
 * | `"free"`            | `0`                                  | `"free"`               |
 * | `"unavailable"`     | —                                    | `"unknown"`            |
 * | `"flat"`/`"tiered"` summing to exactly 0 | —                | `"unknown"` (see {@link isUnmeasuredZero}) |
 * | absent / unrecognised / no pricing object | —              | `"unknown"`            |
 *
 * No branch here is speculative: on generation `g-20260921062451697-f490edba`
 * the catalog publishes `flat` for 975 connections, `unavailable` for 467,
 * `free` for 30 and `tiered` for 28.
 *
 * A `"tiered"` connection with no usable `tiers[0]` falls back to the
 * top-level `input`/`output`, which the catalog guarantees equal the first
 * tier, and keeps the `(first tier)` label because that is still what the
 * number is. A `"flat"` or `"tiered"` connection whose numbers survive neither
 * route is unknown — a declared type is not itself a price.
 */
export function connectionPrice(pricing: AggregatorEntry["pricing"]): ConnectionPrice {
  if (!pricing) return unknownPrice();

  switch (pricing.type) {
    case "flat": {
      const perMillionTokens = sumRates(pricing.input, pricing.output);
      if (perMillionTokens === null || isUnmeasuredZero(perMillionTokens)) return unknownPrice();
      return { known: true, perMillionTokens, label: perMillionLabel(perMillionTokens) };
    }

    case "tiered": {
      const firstTier = pricing.tiers?.[0];
      const perMillionTokens =
        (firstTier ? sumRates(firstTier.input, firstTier.output) : null) ??
        sumRates(pricing.input, pricing.output);
      if (perMillionTokens === null || isUnmeasuredZero(perMillionTokens)) return unknownPrice();
      return {
        known: true,
        perMillionTokens,
        label: `${perMillionLabel(perMillionTokens)} (first tier)`,
      };
    }

    case "free":
      return { known: true, perMillionTokens: 0, label: perMillionLabel(0) };

    case "unavailable":
      // The catalog knows this connection publishes no price. Same outcome as
      // not knowing how to read the object at all: nothing to order it by.
      return unknownPrice();

    default:
      // An absent `type`, or a value this build does not recognise because the
      // contract grew one. Reached even when `input`/`output` are present:
      // without the discriminator, how to read them is not known.
      return unknownPrice();
  }
}

/**
 * The rates one request on this connection is billed at, read by the same
 * `pricing.type` rules as {@link connectionPrice} (no alias, and an unmeasured
 * zero is unknown): `flat` → the published input and output rates, and
 * `cachedRead` as the cache-read rate; `tiered` → the first tier, marked an
 * estimate, because a request above that tier's `maxInputTokens` is billed at a
 * higher band this does not select; `free` → zero; `unavailable`, no pricing, an
 * unrecognised type or an unmeasured zero → undefined, so the caller falls back.
 */
export function connectionRequestRates(agg: AggregatorEntry): ModelPricing | undefined {
  const pricing = agg.pricing;
  if (!pricing) return undefined;
  const rates = (
    input: number | undefined,
    output: number | undefined,
    cachedRead: number | undefined
  ): ModelPricing | undefined => {
    const inputRate = usableRate(input);
    const outputRate = usableRate(output);
    if (inputRate === null || outputRate === null) return undefined;
    if (isUnmeasuredZero(inputRate + outputRate)) return undefined;
    const cacheReadRate = usableRate(cachedRead);
    return {
      inputCostPer1M: inputRate,
      outputCostPer1M: outputRate,
      ...(cacheReadRate !== null ? { cacheReadCostPer1M: cacheReadRate } : {}),
    };
  };

  switch (pricing.type) {
    case "flat":
      return rates(pricing.input, pricing.output, pricing.cachedRead);
    case "tiered": {
      const firstTier = pricing.tiers?.[0];
      const tierRates = firstTier
        ? rates(firstTier.input, firstTier.output, firstTier.cachedRead ?? pricing.cachedRead)
        : undefined;
      const result = tierRates ?? rates(pricing.input, pricing.output, pricing.cachedRead);
      return result ? { ...result, isEstimate: true } : undefined;
    }
    case "free":
      return { inputCostPer1M: 0, outputCostPer1M: 0 };
    default:
      return undefined;
  }
}

/**
 * Ascending by price; an unknown price sorts after every known one.
 *
 * Ties return 0 so the caller applies its own tie-break — freshness, provider
 * preference, whatever that list orders by. Two unknowns also tie, which keeps
 * the unpriced tail of a list (the `unavailable` connections) in the caller's
 * own order under a stable sort rather than scrambling it.
 */
export function compareByConnectionPrice(a: ConnectionPrice, b: ConnectionPrice): number {
  if (a.known && b.known) {
    if (a.perMillionTokens < b.perMillionTokens) return -1;
    if (a.perMillionTokens > b.perMillionTokens) return 1;
    return 0;
  }
  if (a.known) return -1;
  if (b.known) return 1;
  return 0;
}
