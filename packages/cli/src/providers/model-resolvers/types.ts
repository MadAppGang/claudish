/**
 * ProviderModelResolver — per-provider collapse/expand between a raw roster and
 * the rows a human picks.
 *
 * ## Why this exists
 *
 * A provider's live roster is not always the list a human wants to choose from.
 * Devin is the motivating case: it encodes reasoning tier, speed modifier, and
 * context window in the model *uid* rather than in request parameters, so its
 * 170 served uids are really ~33 models with knobs on them. Listing all 170 is
 * unusable, and — worse — the naive 1:1 listing hid variants that no request
 * could reach (see `devin.ts`).
 *
 * ## The one idea
 *
 * **Collapse and expand are inverse functions of the same rule.** If the picker
 * folds five effort tiers into one row, routing must be able to unfold that row
 * using the effort the harness sends. Two independently-written helpers WILL
 * drift; Devin already demonstrated the drift. So they live behind one
 * interface, on one set of facts, and are tested against each other.
 *
 * ## Scope
 *
 * This is deliberately NOT the same seam as `ModelCatalogResolver`
 * (`providers/catalog-resolvers/`). That one answers "what vendor prefix does
 * this aggregator want?" — a naming question about a model the user already
 * chose. This one answers "which of the provider's wire ids IS this choice,
 * right now, at this effort?" — a selection question. They compose: a catalog
 * resolver can feed a model id that a model resolver then expands.
 *
 * ## Default is identity
 *
 * `getModelResolver()` returns undefined for every provider that has not opted
 * in, and callers treat that as 1 row per roster entry with `expand` returning
 * the selection unchanged. Adding this seam therefore changes nothing for a
 * provider that does not implement it.
 */

import type { EffortLevel } from "../../adapters/base-api-format.js";

/**
 * A knob the provider DECLARES for one roster entry, with the value that entry
 * sits at.
 *
 * The point of carrying this is that a provider which states what each variant
 * is beats any rule we could write over its naming. Devin publishes
 * `{ key: "Effort", label: "XHigh" }` per uid; reading that is strictly better
 * than parsing `-xhigh` off the end of the id, and it survives a vendor adding
 * a level whose spelling we never anticipated.
 */
export interface RosterAxis {
  /** The provider's own name for the knob (`Effort`, `1M Context`, `Fast Mode`). */
  key: string;
  /** The value THIS entry sits at (`XHigh`, `Max`, `No Thinking`). */
  label?: string;
  /** Whether this entry has the knob engaged. */
  enabled: boolean;
}

/** A time-boxed or plan-included price on one roster entry. */
export interface ModelOffer {
  /**
   * - `promo` — a temporary price the vendor is advertising. ALWAYS carries an
   *   end date in practice; render it, because an expired promo shown as
   *   current is a wrong-price bug.
   * - `included` — covered by a flat-rate subscription, no per-token charge.
   */
  kind: "promo" | "included";
  /** Unix SECONDS. Absent = no stated end. Compare against the clock at render. */
  expiresAt?: number;
}

/**
 * One roster entry, exactly as the provider reports it.
 *
 * Every field beyond `wireId` is optional because providers report wildly
 * different amounts: Ollama's `/api/tags` gives a name and little else, while
 * Devin publishes a label, a cost multiplier, a default flag, and the list of
 * knobs each model exposes.
 */
export interface RosterEntry {
  /** Exactly what goes in the request's model field. The only required fact. */
  wireId: string;
  displayName?: string;
  contextWindow?: number;
  /**
   * The vendor's OWN row label, when it publishes one. Preferred over anything
   * derived from the wire id — a vendor-authored `"Claude Opus 4.8"` beats a
   * string we reconstructed from `claude-opus-4-8-xhigh-fast`.
   */
  groupLabel?: string;
  /** Provider-declared family id, as a fallback grouping key. */
  family?: string;
  /** Relative cost within this provider. Not a currency — a multiplier. */
  costFactor?: number;
  /** Coarse vendor cost band, used only to order the default fallback. */
  costTier?: number;
  /** The vendor designates this entry as its family's default. */
  isFamilyDefault?: boolean;
  /** The vendor marks this entry as recommended. */
  isRecommended?: boolean;
  /** The knobs the vendor says this entry exposes, in the vendor's own words. */
  axes?: RosterAxis[];
  offer?: ModelOffer;
}

/** One wire id a {@link ModelChoice} can resolve to. */
export interface RosterVariant {
  wireId: string;
  /** The reasoning level this variant represents, when it maps to one. */
  effort?: EffortLevel;
  /**
   * Non-effort modifiers carrying a cost premium (Devin: `fast`, `priority`).
   *
   * A variant with any modifier is NEVER selected automatically — reaching it
   * requires naming its wire id exactly. They cost ~2x, and silently doubling a
   * user's bill to satisfy an effort request is not a trade the resolver may make.
   */
  modifiers: string[];
  costFactor?: number;
}

/** One row a human picks. May stand for many wire ids. */
export interface ModelChoice {
  /**
   * Stable id. MUST be a real wire id, not a synthetic label, so it survives
   * `parseModelSpec`, argv, and the parent-side route pinning unchanged.
   */
  id: string;
  displayName: string;
  contextWindow?: number;
  /** Every wire id this choice can expand into, including `id` itself. */
  variants: RosterVariant[];
  /** Cost at the default variant. */
  costFactor?: number;
  offer?: ModelOffer;
  /** True when the vendor recommends the default variant of this choice. */
  isRecommended?: boolean;
}

/** Runtime signals available when a choice is resolved to a wire id. */
export interface ExpandContext {
  /** The level Claude Code asked for this turn, when it sent one. */
  effort?: EffortLevel;
}

export interface ProviderModelResolver {
  /** Canonical provider name — must match `PROVIDER_PROFILES` / `BUILTIN_PROVIDERS`. */
  readonly provider: string;

  /**
   * Raw roster -> the rows a human chooses from.
   *
   * Must be pure and total: any entry it cannot interpret still has to reach
   * the user somehow, because a model silently missing from the picker is
   * indistinguishable from a model the subscription does not serve.
   */
  collapse(roster: RosterEntry[]): ModelChoice[];

  /**
   * A chosen id + runtime signals -> the wire id to send.
   *
   * Must be total: an unrecognised selection is returned UNCHANGED so the
   * backend can answer for itself. Guessing here would replace an actionable
   * "that model is not served, here is what is" with a silent substitution.
   */
  expand(selection: string, roster: RosterEntry[], ctx: ExpandContext): string;
}

/**
 * A non-empty string, or undefined.
 *
 * Providers report absent fields as `""` as often as they omit them, and `??`
 * does not catch the empty string — a real bug found while grouping the Devin
 * roster, where six entries with `family: ""` collapsed into one bogus group.
 */
export function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** The label to group a roster entry under: vendor label, else family, else its own id. */
export function groupKeyOf(entry: RosterEntry): string {
  return nonEmpty(entry.groupLabel) ?? nonEmpty(entry.family) ?? entry.wireId;
}

/** Whether an offer is still live at `now` (unix ms). An expired promo is not an offer. */
export function offerIsLive(offer: ModelOffer | undefined, now: number = Date.now()): boolean {
  if (!offer) return false;
  if (offer.expiresAt === undefined) return true;
  return offer.expiresAt * 1000 > now;
}
