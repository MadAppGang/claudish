/**
 * Which providers collapse their roster, and which are 1:1.
 *
 * Returning `undefined` is the DEFAULT and means identity — one picker row per
 * roster entry, `expand` returning the selection unchanged. That is correct for
 * every provider whose live endpoint already lists exactly what a human would
 * choose (Ollama's tags, LM Studio's models, Kimi Coding's plan roster), so
 * adding this seam changes nothing for them.
 *
 * Only a provider that encodes knobs INTO its model ids needs an entry here.
 */

import { DevinModelResolver } from "./devin.js";
import type { ExpandContext, ModelChoice, ProviderModelResolver, RosterEntry } from "./types.js";

/**
 * Antigravity is a deliberate NON-member for now. Its resolution rule grew a
 * fourth authority (`lookupFamilyDefaultVariant`, the slim catalog's
 * `routeVariant.isDefault`) that {@link ExpandContext} does not model, and
 * adopting it would mean either regressing that rule or redesigning the seam's
 * context type. Its rule stays in `transport/antigravity.ts`; folding it in is a
 * follow-up, not a merge-time decision.
 */
const RESOLVERS: ProviderModelResolver[] = [new DevinModelResolver()];

const BY_PROVIDER = new Map(RESOLVERS.map((resolver) => [resolver.provider, resolver]));

/** The resolver for a provider, or undefined when it is 1:1 (the common case). */
export function getModelResolver(provider: string): ProviderModelResolver | undefined {
  return BY_PROVIDER.get(provider);
}

/**
 * Roster -> picker rows, falling back to 1:1 for providers with no resolver.
 *
 * Callers should use this rather than branching on `getModelResolver`, so the
 * identity path is written once instead of at every call site.
 */
export function collapseRoster(provider: string, roster: RosterEntry[]): ModelChoice[] {
  const resolver = getModelResolver(provider);
  if (resolver) return resolver.collapse(roster);
  return roster.map((entry) => ({
    id: entry.wireId,
    displayName: entry.displayName ?? entry.wireId,
    contextWindow: entry.contextWindow,
    variants: [{ wireId: entry.wireId, modifiers: [] }],
    costFactor: entry.costFactor,
    offer: entry.offer,
    isRecommended: entry.isRecommended,
  }));
}

/**
 * Selection + runtime signals -> wire id, identity when no resolver applies.
 *
 * Total by construction: an unknown selection comes back unchanged so the
 * provider can answer for itself.
 */
export function expandSelection(
  provider: string,
  selection: string,
  roster: RosterEntry[],
  ctx: ExpandContext = {}
): string {
  return getModelResolver(provider)?.expand(selection, roster, ctx) ?? selection;
}
