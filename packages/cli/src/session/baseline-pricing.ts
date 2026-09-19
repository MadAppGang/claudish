import { catalogRouteMatchesProvider } from "../providers/catalog-route-bindings.js";
/**
 * baseline-pricing — what the same tokens would have cost on Anthropic's own models.
 *
 * The session summary's headline is "you spent $X instead of $Y". `$Y` needs a
 * reference rate, and there are two ways to get one: write Anthropic's price list into
 * this file, or ask the catalog. This asks the catalog.
 *
 * WHY NOT A CONSTANT. Hardcoding `sonnet = 3/15` would be wrong within a release —
 * claude-sonnet-5 is 2/10 while claude-sonnet-4-5 is 3/15, and a pinned model id ages
 * into a lie the moment the next model ships. The rule claudish already follows for
 * rosters and context windows applies verbatim to prices: defaults are RULES, not
 * pinned ids. So the baseline is resolved through the catalog's own
 * `~anthropic/claude-<tier>-latest` aliases — a rule that keeps pointing at the current
 * flagship without this file knowing which model that is. Today they resolve to
 * claude-sonnet-5 and claude-opus-5; when they stop, nothing here changes.
 *
 * WHY THE `anthropic` AGGREGATOR SPECIFICALLY. A comparison is only honest against the
 * FIRST-PARTY list price. Gateways resell the same model at their own rate — the
 * catalog currently carries claude-opus-5 at 5/25 from `anthropic` and a `-fast`
 * variant at 10/50 from `openrouter` — so picking "any aggregator with a price" would
 * silently double the savings figure depending on which row sorted first.
 *
 * WHEN THE CATALOG CANNOT ANSWER, THIS RETURNS `null` AND THE SUMMARY OMITS THE LINE.
 * A missing baseline is not an excuse to fall back to a guess: an invented number
 * presented as "saved vs Opus" is worse than no line at all, and the catalog is absent
 * exactly when claudish has never fetched it (a first run, an offline machine).
 */

import { findEntryByAlias } from "../providers/catalog-query.js";

/** A resolved reference model and its first-party per-million rates (USD). */
export interface Baseline {
  /** Catalog model id the alias resolved to, e.g. `claude-sonnet-5`. Shown to the user. */
  modelId: string;
  /** Human tier label used in the summary, e.g. `Sonnet`. */
  label: string;
  inputPerM: number;
  outputPerM: number;
}

/**
 * The tiers compared against, as ALIAS RULES rather than model ids.
 *
 * Both are `~`-prefixed "latest" pointers the catalog maintains. Jack asked for Sonnet
 * and Opus specifically; Haiku is deliberately absent, because a cheap-tier comparison
 * would flatter almost nothing and the panel has room for two.
 */
const BASELINE_ALIASES: ReadonlyArray<{ alias: string; label: string }> = [
  { alias: "~anthropic/claude-sonnet-latest", label: "Sonnet" },
  { alias: "~anthropic/claude-opus-latest", label: "Opus" },
];

/** The catalog provider whose price counts as the reference. See file header. */
const FIRST_PARTY = "anthropic";

/**
 * Resolve one tier. `null` when the catalog is missing, the alias no longer resolves,
 * or the entry carries no first-party price — every one of which is "we don't know",
 * and none of which is "assume something".
 */
function resolveBaseline(alias: string, label: string): Baseline | null {
  const entry = findEntryByAlias(alias);
  if (!entry) return null;

  const firstParty = entry.aggregators?.find(
    (a) => catalogRouteMatchesProvider(a.route, FIRST_PARTY) && typeof a.pricing?.input === "number"
  );
  const input = firstParty?.pricing?.input;
  const output = firstParty?.pricing?.output;
  // Both rates are required. An input-only row would under-report the baseline and so
  // under-report the saving — the safe direction is to skip the tier entirely.
  if (typeof input !== "number" || typeof output !== "number") return null;
  // A zero-rate Anthropic row is a catalog defect, not a free model; comparing against
  // it would render "saved -$0.42", which reads as claudish costing the user money.
  if (input <= 0 || output <= 0) return null;

  return { modelId: entry.modelId, label, inputPerM: input, outputPerM: output };
}

/** Every resolvable baseline tier, in display order. Possibly empty. */
export function getBaselines(): Baseline[] {
  return BASELINE_ALIASES.map(({ alias, label }) => resolveBaseline(alias, label)).filter(
    (b): b is Baseline => b !== null
  );
}

/** What `inputTokens`/`outputTokens` would have cost at this baseline's rates, in USD. */
export function baselineCost(b: Baseline, inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * b.inputPerM + (outputTokens / 1_000_000) * b.outputPerM;
}
