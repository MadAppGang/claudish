/**
 * Every way claudish could call one model, gathered from the catalog and ordered.
 *
 * The step of the bare-name path (`explainBareName`) that runs when no USER rule
 * matches: `explainCatalogChain` (also behind `buildCatalogChain`) calls
 * {@link gatherRouteCandidates}. It replaced a hand-written table that named
 * providers per model family and had to be edited whenever a vendor, a plan or
 * a gateway changed.
 *
 * WHAT THIS MODULE IS NOT. It does not decide whether a candidate can be USED.
 * Two filters already own that question and neither is duplicated here:
 *
 *   - the CREDENTIAL filter (`hasCredentialsForProvider` → the credential
 *     authority) — no key, no candidate;
 *   - the AVAILABILITY filter (`providerServesModel`, `model-availability.ts`) —
 *     the account's own dynamic models catalog may DENY, and absence of evidence
 *     never denies.
 *
 * So a candidate returned from here is a claim about what the CATALOG publishes,
 * not a claim that this user can call it. Re-asking either question here would
 * create a second oracle, and the pair would disagree the first time one changed.
 *
 * ── Why the catalog can be the only source ─────────────────────────────────
 *
 * Measured on generation `g-20260921062451697-f490edba` (1,123 entries):
 *
 *   - `aggregators[]` carries SUBSCRIPTION routes alongside gateways and native
 *     APIs — `moonshotai/kimi-code-subscription`, `openai/codex-subscription`,
 *     `z-ai/glm-coding-subscription`, `qwen/qwencloud-token-plan`,
 *     `opencode/go-subscription`. One source therefore covers every tier, and the
 *     tier is the only thing that has to come from claudish's own table.
 *   - The VENDOR needs no local table either: a connection whose
 *     `route.routeId` equals the entry's `provider` IS the vendor's own route.
 *     412 of 1,123 models have one; the remaining 709 are served only by
 *     gateways, which is a fact about those models rather than a gap. 100 entries
 *     carry vendor `unknown` and simply get no vendor preference.
 *   - 25 of the 28 published route pairs map to a claudish provider. The three
 *     that do not are `qwen/realtime-websocket` (a WebSocket API with no chat
 *     transport here), `openrouter/decisions` (output modality `["decisions"]`,
 *     not chat) and `opencode/systemone` (a profile claudish has never seen).
 *     Each is SKIPPED and counted in {@link CandidateGathering.unmappedRoutes} —
 *     never guessed at, because a guessed route binding sends a request to the
 *     wrong transport and reads as the model's failure.
 *   - Of 1,734 mapped connections, 923 carry a usable price and 811 do not.
 *     Unknown is a large minority, so the comparator must order it rather than
 *     treat it as an edge case: it sorts LAST among its tier.
 *
 * ── The order ──────────────────────────────────────────────────────────────
 *
 * Decided by the project owner; {@link compareRouteCandidates} implements exactly
 * this and nothing else:
 *
 *     user rules (elsewhere, verbatim, never merged with any of this)
 *       then band:  subscription (both subscription tiers) → native → gateway → fallback
 *       within a band:  the model's own vendor first
 *                  then tier: subscription before dynamic-subscription
 *                  then cheapest by catalog price (unknown last)
 *                  then larger context window
 *                  then provider name, ascending, for determinism
 *
 * The two subscription tiers share one band so that a vendor's OWN dynamic
 * subscription goes first: `grok-4.x` goes Grok Build → OpenCode Zen Go → xAI.
 * With tier first, Zen Go's catalog-published plan led Grok Build, xAI's own,
 * on 3 of 1,143 catalog models (generation g-20260923145315478-d7a326bd); the
 * project owner decided the vendor's own plan leads (2026-09-24).
 *
 * No local preference list, and NO LOCAL STATE. A spent subscription limit is
 * never remembered: the request moves to the next hop, which is the existing
 * chain's job. A module that remembered would answer differently on two
 * identical inputs, and the reason would live nowhere a user could see.
 */

import { resolveSubscriptionRouting } from "../adapters/model-catalog.js";
import type { AggregatorEntry } from "../model-loader.js";
import { type SlimModelEntry, readAllModelsCache } from "./all-models-cache.js";
import { externalIdFor, getCatalogEntries, isMovingPointer } from "./catalog-client.js";
import {
  CATALOG_ROUTE_BINDINGS,
  type CatalogRouteBinding,
  catalogRouteForProvider,
  catalogRouteMatchesProvider,
  routingProvidersForRoute,
} from "./catalog-route-bindings.js";
import {
  type ConnectionPrice,
  compareByConnectionPrice,
  connectionPrice,
} from "./connection-price.js";
import { readProbeModelsCache } from "./probe-catalog.js";
import { type RouteTier, getAllProviders, getProviderByName } from "./provider-definitions.js";

export type { RouteTier };

/** One way to call one model, with everything the order needs to place it. */
export interface RouteCandidate {
  /** claudish provider name. */
  provider: string;
  /** The exact id to send that provider. */
  wireId: string;
  tier: RouteTier;
  /** route.routeId === the catalog entry's `provider`: this vendor makes the model. */
  isVendorOwn: boolean;
  price: ConnectionPrice;
  /** Per-connection context window, when the catalog publishes one. */
  contextWindow?: number;
  source: "catalog-connection" | "namespace-claim";
}

/**
 * Why the gatherer set a candidate aside instead of returning it. Each names a
 * `CandidateOutcome` (`routing-rules.ts`), so a display can show the drop.
 *
 * - `excluded-by-content-use`: the provider maps the model only through a
 *   content-use opt-in wire id, which claudish never chooses (`content-use.ts`).
 * - `excluded-by-membership`: a subscription's catalog-published plan
 *   membership does not include the model, although its route is mapped.
 */
export type GatheringExclusion = "excluded-by-content-use" | "excluded-by-membership";

/** A candidate the catalog publishes and the gatherer did not keep, with why. */
export interface ExcludedCandidate {
  candidate: RouteCandidate;
  outcome: GatheringExclusion;
}

export interface CandidateGathering {
  /** The candidates a routing chain may use, ordered. Never contains an excluded one. */
  candidates: RouteCandidate[];
  /**
   * Candidates set aside before any credential is read, ordered like
   * `candidates`. Kept apart so the only consumer, `explainCatalogChain`, can
   * show each one with its outcome and never mark it `kept`: one list for both
   * would make every explanation a hop.
   */
  excluded: ExcludedCandidate[];
  /** Mapped connections skipped because their route resolves to no claudish provider. */
  unmappedRoutes: string[];
  /** True when no catalog entry matched the name at all. */
  catalogMiss: boolean;
  /**
   * Whether a catalog could be READ, independent of whether it knew this name.
   *
   * `catalogMiss` alone conflates two situations a caller must treat
   * differently: "there is no catalog on this machine" and "the catalog is here
   * and does not publish this id". The first means claudish knows nothing and
   * must say so — the project owner's rule is that with no catalog claudish
   * serves local providers and explicit `provider@model` specs only, never a
   * guessed hop. The second is ordinary: a name the backend has not published
   * yet still has a last-resort fallback, because absence from a catalog that
   * IS readable is only denial for a route the catalog owns (see
   * `routing-rules.ts`, the fallback append).
   */
  catalogReadable: boolean;
}

/**
 * Tier precedence, as a total map rather than a list.
 *
 * `Record<RouteTier, number>` is exhaustive by construction: adding a sixth tier
 * to the union stops this file compiling, which is the only way to be sure a new
 * tier gets a deliberate position instead of silently sorting as `undefined`.
 */
const TIER_RANK: Record<RouteTier, number> = {
  subscription: 0,
  "dynamic-subscription": 1,
  native: 2,
  gateway: 3,
  fallback: 4,
};

/** A tier's band: both subscription tiers share the first; every other tier is its own. */
function bandRank(tier: RouteTier): number {
  return tier === "dynamic-subscription" ? TIER_RANK.subscription : TIER_RANK[tier];
}

/** `routeId/routeProfileId`, the spelling the backend contract and the reports use. */
function routeLabel(route: CatalogRouteBinding | undefined): string {
  return route ? `${route.routeId}/${route.routeProfileId}` : "(no route)";
}

/**
 * The catalog entry for a requested name, or `undefined`.
 *
 * Canonical model id first, then alias — the order `resolveExternalId` already
 * uses, so both paths agree about which entry a name denotes. The
 * case-insensitive passes come last and exist because users paste ids from vendor
 * docs (`MiniMax-M3`) while the catalog is lowercase; `matchRoutingRule` lowers
 * for the same reason. Exact always wins, so a case-folded collision can never
 * displace a real id.
 */
function findCatalogEntry(entries: SlimModelEntry[], model: string): SlimModelEntry | undefined {
  const exact = entries.find((entry) => entry.modelId === model);
  if (exact) return exact;
  const byAlias = entries.find((entry) => entry.aliases.includes(model));
  if (byAlias) return byAlias;

  const lowered = model.toLowerCase();
  const loweredId = entries.find((entry) => entry.modelId.toLowerCase() === lowered);
  if (loweredId) return loweredId;
  return entries.find((entry) => entry.aliases.some((alias) => alias.toLowerCase() === lowered));
}

/**
 * The canonical model id the cloud models catalog resolves `model` to (exact id,
 * alias, or either ignoring case), the lookup routing itself uses. Undefined
 * when the catalog is unreadable or lacks the name.
 */
export function catalogModelId(model: string, cachePath?: string): string | undefined {
  const entries = cachePath ? readAllModelsCache(cachePath)?.entries : getCatalogEntries();
  return entries ? findCatalogEntry(entries, model)?.modelId : undefined;
}

/**
 * Candidates from the catalog's own connections — the primary source.
 *
 * Every skip below is deliberate and each has a different reason:
 *
 *   - a route that binds to no claudish provider is COUNTED (`unmappedRoutes`),
 *     because "the catalog grew a route we cannot execute" is a fact the next
 *     contract review needs, not noise;
 *   - a provider name with no DEFINITION in this process is counted the same way.
 *     That is how `together-ai/gateway` and `fireworks/gateway` read when the
 *     bundled endpoint catalog has not registered them — which happens exactly
 *     when the user holds no key for them, so the credential filter would have
 *     dropped the candidate anyway;
 *   - a connection whose own `externalModelId` is not the id
 *     {@link externalIdFor} chose for its provider is skipped SILENTLY: another
 *     connection of the same provider carries the chosen id, and this one is the
 *     moving pointer beside it. Reading price and context window from the row
 *     that actually carries the wire id is the whole point of the check;
 *   - `externalIdFor` returning null means every id this provider publishes for
 *     the model is a moving pointer. Its rule — never send a pointer the user did
 *     not ask for — is the one claudish already applies everywhere, so there is
 *     no honest id to send and no candidate.
 *
 * One candidate is EXPLAINED rather than skipped or kept: a `subscription`-tier
 * connection for a model outside its plan's published membership
 * (`resolveSubscriptionRouting` → `not-served`) goes to `excluded` as
 * `excluded-by-membership`. A mapped connection is not membership: the catalog
 * can map a plan's route for a model the plan does not include, and a user rule
 * naming that provider was already dropped for it, while the gathered path kept
 * it as a hop. Both paths now ask the same question of the same function.
 */
function gatherFromConnections(
  entry: SlimModelEntry,
  candidates: RouteCandidate[],
  excluded: ExcludedCandidate[],
  unmappedRoutes: Set<string>,
  cachePath: string | undefined
): void {
  for (const connection of entry.aggregators ?? []) {
    if (connection.routeStatus !== "mapped") continue;
    const routable = routableProviders(connection, unmappedRoutes);

    for (const provider of routable) {
      const tier = getProviderByName(provider)?.tier;
      if (!tier) continue;

      const wireId = externalIdFor(entry, provider);
      if (!wireId || wireId !== connection.externalModelId) continue;

      const candidate = connectionCandidate(entry, connection, provider, tier, wireId);
      // The catalog-published subscription tier only: a dynamic subscription's
      // account decides its models, and `resolveSubscriptionRouting` answers
      // `unknown` for a client-selected plan anyway.
      if (
        tier === "subscription" &&
        resolveSubscriptionRouting(entry.modelId, provider, cachePath).kind === "not-served"
      ) {
        excluded.push({ candidate, outcome: "excluded-by-membership" });
        continue;
      }
      candidates.push(candidate);
    }
  }

  // Content-use opt-in rows (`content-use.ts`). They were moved out of
  // `aggregators` where the catalog entered memory, so nothing above can pick
  // one. They are EXPLAINED here, never returned as candidates: a provider that
  // maps this model ONLY through an opt-in id (OpenCode Go's
  // `muse-spark-1.3-contributor`) shows in `--probe` as dropped, with the reason.
  // A provider that also maps a plain id already has its candidate, and its
  // opt-in sibling is not news.
  const gatheredProviders = new Set([
    ...candidates.map((candidate) => candidate.provider),
    ...excluded.map(({ candidate }) => candidate.provider),
  ]);
  for (const connection of entry.optInConnections ?? []) {
    if (connection.routeStatus !== "mapped") continue;
    for (const provider of routableProviders(connection, unmappedRoutes)) {
      const tier = getProviderByName(provider)?.tier;
      if (!tier || gatheredProviders.has(provider)) continue;

      const wireId = optInIdFor(entry, provider);
      if (!wireId || wireId !== connection.externalModelId) continue;

      excluded.push({
        candidate: connectionCandidate(entry, connection, provider, tier, wireId),
        outcome: "excluded-by-content-use",
      });
    }
  }
}

/**
 * EVERY provider bound to a connection's route, not just the first. One endpoint
 * can wear several claudish names, each owning a different key silo, and the
 * user's credential may be in any of them — see `routingProvidersForRoute`. The
 * routing table only: a lookup-only name is never a candidate. A route bound to
 * no defined provider is counted in `unmappedRoutes`.
 */
function routableProviders(connection: AggregatorEntry, unmappedRoutes: Set<string>): string[] {
  const bound = routingProvidersForRoute(connection.route);
  const routable = bound.filter((name) => getProviderByName(name)?.tier !== undefined);
  if (routable.length === 0) unmappedRoutes.add(routeLabel(connection.route));
  return routable;
}

/**
 * The opt-in wire id `provider` publishes for the entry, chosen like
 * {@link externalIdFor} (an exact id over a moving pointer). Only to EXPLAIN a
 * drop; nothing sends it.
 */
function optInIdFor(entry: SlimModelEntry, provider: string): string | null {
  const wireIds = (entry.optInConnections ?? []).flatMap((connection) =>
    connection.routeStatus === "mapped" &&
    catalogRouteMatchesProvider(connection.route, provider) &&
    typeof connection.externalModelId === "string"
      ? [connection.externalModelId]
      : []
  );
  if (wireIds.length === 0) return null;
  if (isMovingPointer(entry.modelId)) return wireIds[0] ?? null;
  return wireIds.find((wireId) => !isMovingPointer(wireId)) ?? null;
}

function connectionCandidate(
  entry: SlimModelEntry,
  connection: AggregatorEntry,
  provider: string,
  tier: RouteTier,
  wireId: string
): RouteCandidate {
  return {
    provider,
    wireId,
    tier,
    isVendorOwn: isVendorOwnRoute(connection.route, entry),
    price: connectionPrice(connection.pricing),
    // A connection that omits `contextWindow` serves the model's headline
    // window — that is what the field's absence MEANS in the contract, not
    // missing data. Carrying the entry's value is therefore reading the
    // catalog, not defaulting: without it, `openai-codex`'s measured 372K cap
    // on gpt-5.6-sol would sort AHEAD of the OpenAI API's full 1.05M, which
    // publishes no per-connection number because it is the headline one.
    contextWindow: connection.contextWindow ?? entry.contextWindow,
    source: "catalog-connection",
  };
}

/**
 * The vendor that MAKES the model is the vendor whose own route this is.
 *
 * False with no entry and false for the 100 entries whose vendor is `unknown`:
 * both are an absence of evidence, and this flag's only job is to promote a
 * candidate, so an absence must never promote one.
 */
function isVendorOwnRoute(
  route: CatalogRouteBinding | undefined,
  entry: SlimModelEntry | undefined
): boolean {
  return route !== undefined && entry?.provider !== undefined && route.routeId === entry.provider;
}

/**
 * The claudish provider that calls a vendor's own native API, or `undefined`.
 *
 * The same rule as {@link isVendorOwnRoute}, asked from the vendor's side: a
 * vendor's own routes are the ones whose `routeId` is its slug. Of the routing
 * table's providers bound to one of them, the first whose tier is `native` calls
 * the vendor's metered API. A subscription on the same route (`openai-codex`,
 * `kimi-coding`, `qwen-coding`) is never the answer, and neither is a
 * lookup-only name, which calls nothing.
 *
 * Read by the recommended-models listings (`--models-top`, MCP `list_models`) to
 * show a vendor's `provider@` shortcut beside its models. Deriving it replaced a
 * hand-written vendor table that mapped `qwen` to the steering placeholder `qwen`,
 * which has no shortcut, so Qwen rows showed none; the answer is `qwen-payg`
 * (`qpay@`). `anthropic` has no answer: Claude's own route here is the
 * `native-anthropic` subscription, and Anthropic's native API is lookup-only.
 */
export function nativeProviderForVendor(vendorSlug: string): string | undefined {
  for (const [provider, binding] of Object.entries(CATALOG_ROUTE_BINDINGS)) {
    if (binding.routeId !== vendorSlug) continue;
    if (getProviderByName(provider)?.tier === "native") return provider;
  }
  return undefined;
}

/**
 * Candidates from a provider's NAMESPACE CLAIM — dynamic subscriptions only.
 *
 * A dynamic subscription publishes no connection at all, because the ACCOUNT
 * selects what it serves: `antigravity`, `grok-subscription`, `devin` and
 * `sakana-subscription` sit in the probe map as
 * `client_model_selection_required`. The catalog cannot say what a seat was
 * given, so without this source a user's flat-rate plan would be invisible to
 * every gathered chain and the request would land on a metered hop — the one
 * ordering error that costs money rather than a better option.
 *
 * A claim is NOT evidence of service, and that asymmetry is the whole design:
 * the candidate exists so the AVAILABILITY filter can ask the account's own
 * dynamic models catalog, which is the only thing that can answer. Extending
 * this to any other tier would invent routes — a gateway's `nativeModelPatterns`
 * would claim every model in a namespace it may not carry, and nothing
 * downstream would contradict it, because a gateway answers a model it does not
 * have with a 4xx that reads as a credential problem.
 *
 * All four dynamic subscriptions now declare one: `devin` (`/^swe-/i`),
 * `antigravity` (`/^gemini-/i`), `grok-subscription` (`/^grok-/i`) and
 * `sakana-subscription` (`/^fugu/i`). The last three were added when the
 * hand-written table was deleted — without them the 15 models measured on
 * generation `g-20260921062451697-f490edba` as CLAIM-GAP would have moved off a
 * flat-rate plan onto a metered hop.
 *
 * A SECOND CLAIMANT ON A NAMESPACE IS FINE HERE, and that is a change from the
 * rule the old note stated. `getProviderForModel` — the function that picked one
 * winner per pattern — no longer exists. The two surviving consumers of
 * `nativeModelPatterns` both tolerate the overlap:
 *
 *   - `getNativeModelPatterns()` → `parseModelSpec` is FIRST-WINS on
 *     `BUILTIN_PROVIDERS` order, and each new claimant is defined BELOW the
 *     metered sibling that already owned the pattern (`google` < `antigravity`,
 *     `x-ai` < `grok-subscription`, `sakana` < `sakana-subscription`), so bare-name
 *     auto-detection is byte-identical to before;
 *   - this function, which iterates ALL providers and pushes every match — it
 *     wants the overlap, because that is how a flat-rate plan and the metered
 *     vendor both reach the ordering in {@link compareRouteCandidates}, where the
 *     tier puts the subscription first.
 */
function gatherFromNamespaceClaims(
  model: string,
  entry: SlimModelEntry | undefined,
  candidates: RouteCandidate[]
): void {
  for (const def of getAllProviders()) {
    if (def.tier !== "dynamic-subscription") continue;
    if (!def.nativeModelPatterns?.some(({ pattern }) => pattern.test(model))) continue;

    candidates.push({
      provider: def.name,
      // The requested name verbatim. There is no catalog connection to read a
      // wire id from, and the transport resolves the account's own id itself.
      wireId: model,
      tier: def.tier,
      // Same rule as a connection's, asked of the provider's own binding: the
      // claim has no route of its own to compare.
      isVendorOwn: isVendorOwnRoute(catalogRouteForProvider(def.name), entry),
      // Unknown, and unknowable here: a flat-rate plan publishes no per-token
      // rate, and `connectionPrice` is the only thing allowed to say what a
      // missing price is.
      price: connectionPrice(undefined),
      // No context window either: a plan's window varies by tier and comes from
      // the account's own discovery (see `modelDiscovery`).
      source: "namespace-claim",
    });
  }
}

/**
 * Ascending: the candidate a request should be sent to comes first.
 *
 * Exported separately from {@link gatherRouteCandidates} so the order can be
 * tested on constructed candidates, without a catalog — the two halves fail for
 * different reasons and a test that could only reach the sort through a cache
 * file would attribute a gathering bug to the order.
 *
 * Total, not merely consistent: `(provider, wireId)` is unique after deduping, so
 * the last two keys guarantee one fixed answer for any input permutation. A
 * routing order that depended on the catalog's row order would change under a
 * backend re-publish with nothing in claudish having changed.
 */
export function compareRouteCandidates(a: RouteCandidate, b: RouteCandidate): number {
  const byBand = bandRank(a.tier) - bandRank(b.tier);
  if (byBand !== 0) return byBand;

  // The vendor's own route, before anyone reselling it — across both
  // subscription tiers, which is the only place a band holds two.
  if (a.isVendorOwn !== b.isVendorOwn) return a.isVendorOwn ? -1 : 1;

  // Inside the subscription band, a catalog-published plan before a dynamic
  // one: its membership is evidence, where a namespace claim is only a question
  // the availability filter asks the account.
  const byTier = TIER_RANK[a.tier] - TIER_RANK[b.tier];
  if (byTier !== 0) return byTier;

  const byPrice = compareByConnectionPrice(a.price, b.price);
  if (byPrice !== 0) return byPrice;

  // Larger window first; an unpublished window sorts last, for the same reason an
  // unknown price does — a missing number is not a small number.
  const byContext = (b.contextWindow ?? -1) - (a.contextWindow ?? -1);
  if (byContext !== 0) return byContext;

  if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
  if (a.wireId !== b.wireId) return a.wireId < b.wireId ? -1 : 1;
  return 0;
}

/**
 * Every candidate for one model name, ordered.
 *
 * `cachePath` reads one specific catalog file instead of the process's own
 * snapshot — the seam every routing function already offers so a test can pin a
 * generation rather than depend on whatever the machine last refreshed.
 *
 * With no readable catalog and no namespace claim the answer is an EMPTY list and
 * `catalogMiss: true`. Not a guessed id, and not an invented gateway: the project
 * owner's rule is that with no catalog claudish serves local providers and
 * explicit `provider@model` specs only. Inventing `openrouter@<name>` here would
 * send a name nobody published to a metered gateway and bill for the 404.
 */
export function gatherRouteCandidates(model: string, cachePath?: string): CandidateGathering {
  const entries = cachePath ? readAllModelsCache(cachePath)?.entries : getCatalogEntries();
  const entry = entries ? findCatalogEntry(entries, model) : undefined;

  const gathered: RouteCandidate[] = [];
  const setAside: ExcludedCandidate[] = [];
  const unmappedRoutes = new Set<string>();

  // Source order is the dedupe rule: a real catalog connection beats a namespace
  // claim for the same (provider, wireId), because it carries a price and a
  // window the claim cannot know.
  if (entry) gatherFromConnections(entry, gathered, setAside, unmappedRoutes, cachePath);
  gatherFromNamespaceClaims(model, entry, gathered);

  // JSON, not a delimiter: an injective key is the whole requirement, and any
  // literal separator is a guess about what a wire id cannot contain. This line
  // briefly held a raw NUL byte, which made `file(1)` report the module as
  // binary and grep stop matching it — the trap `devin.ts` hit once before.
  const keyOf = (candidate: RouteCandidate) =>
    JSON.stringify([candidate.provider, candidate.wireId]);
  const seen = new Set<string>();
  const candidates = gathered.filter((candidate) => {
    const key = keyOf(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  candidates.sort(compareRouteCandidates);

  const excluded = setAside.filter(({ candidate }) => {
    const key = keyOf(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  excluded.sort((a, b) => compareRouteCandidates(a.candidate, b.candidate));

  return {
    candidates,
    excluded,
    unmappedRoutes: [...unmappedRoutes],
    catalogMiss: entry === undefined,
    catalogReadable: entries !== null && entries !== undefined,
  };
}

/**
 * Does the CATALOG deny that `provider` carries `model`?
 *
 * Only ever true for a BACKEND-OWNED route, and the catalog draws that line
 * itself. A route the probe map marks `client_model_selection_required` is
 * ACCOUNT-SELECTED: the backend cannot enumerate what a seat was given, so
 * absence from a model's connections proves nothing about it. Every other
 * probed route publishes its complete connection list, so for those, absence IS
 * denial.
 *
 * Deliberately three-valued in effect, collapsed to a boolean that is false
 * whenever anything is unknown:
 *
 *   - no catalog entry for the model → no denial (the id may simply be newer
 *     than this machine's catalog);
 *   - the provider has no catalog route binding at all (a local transport, a
 *     custom endpoint, a bundled row) → the catalog never speaks about it, so
 *     its silence says nothing;
 *   - no probe map cached → route ownership is unknown, so nothing is denied.
 *     The cost is one hop that may 404, which is exactly today's behaviour;
 *     the alternative is dropping a real route on missing evidence.
 *
 * This is NOT the availability filter and does not duplicate it.
 * `providerServesModel` may never conclude "not served" from the catalog alone
 * (see its comment — `openai-codex` appears on one row out of ~760 and the rule
 * was unsound). This asks a narrower question that the route-ownership split
 * makes answerable, and only the fallback APPEND uses it: the difference is
 * whether claudish is about to invent a hop nobody published, versus drop one
 * something else put in the chain.
 */
export function catalogDeniesProvider(
  provider: string,
  model: string,
  cachePath?: string
): boolean {
  if (!catalogRouteForProvider(provider)) return false;
  if (routeOwnership(provider) !== "backend-owned") return false;

  const entries = cachePath ? readAllModelsCache(cachePath)?.entries : getCatalogEntries();
  if (!entries) return false;
  const entry = findCatalogEntry(entries, model);
  if (!entry) return false;

  // `catalogRouteMatchesProvider`, NOT `providerForCatalogRoute(...) === provider`.
  // The reverse lookup returns ONE name per route pair, and a pair can carry
  // several. In the routing table only `z-ai`/`glm` share one (two key silos on
  // one endpoint); the reads add `kimi`/`moonshotai` and `opencode-zen`/`zen`
  // through the lookup-only names. Comparing its answer would declare `glm`
  // denied on every model `z-ai` serves, a denial built out of a second key
  // silo. Comparing BINDINGS is what `externalIdFor` and `model-availability.ts`
  // already do, for this reason.
  //
  // `aggregators` only, so a model this provider maps ONLY through a content-use
  // opt-in id is denied implicitly: the fallback hop would otherwise send the
  // plain name to a route that never published it (`content-use.ts`).
  return !(entry.aggregators ?? []).some(
    (connection) =>
      connection.routeStatus === "mapped" && catalogRouteMatchesProvider(connection.route, provider)
  );
}

/**
 * Does `provider` map `model` ONLY through a content-use opt-in wire id?
 *
 * True when the catalog entry has no ordinary mapped connection for the
 * provider and at least one opt-in one (`content-use.ts`). For a routing entry
 * that names a provider without a model (a user rule `["zgo"]`, the fallback
 * hop): such a provider can only be sent the opt-in id, which claudish never
 * chooses, or the plain name, which the route never published. False with no
 * catalog or no entry — absence of evidence excludes nothing.
 */
export function catalogMapsOnlyOptIn(provider: string, model: string, cachePath?: string): boolean {
  const entries = cachePath ? readAllModelsCache(cachePath)?.entries : getCatalogEntries();
  if (!entries) return false;
  const entry = findCatalogEntry(entries, model);
  if (!entry) return false;
  const mapsHere = (connection: AggregatorEntry) =>
    connection.routeStatus === "mapped" && catalogRouteMatchesProvider(connection.route, provider);
  return !(entry.aggregators ?? []).some(mapsHere) && (entry.optInConnections ?? []).some(mapsHere);
}

/** Who decides which models a route serves. `unknown` denies nothing. */
export type RouteOwnership = "backend-owned" | "account-selected" | "unknown";

/**
 * Read route ownership out of the probe map — the backend's own statement.
 *
 * `tier === "dynamic-subscription"` is claudish's local transcription of the
 * same fact and the two agree on all four providers today, but the probe map is
 * the source and is what this asks, so a backend that reclassifies a route moves
 * claudish without an edit here.
 */
export function routeOwnership(provider: string): RouteOwnership {
  const probe = readProbeModelsCache();
  if (!probe) return "unknown";
  if (probe.unavailable[provider] === "client_model_selection_required") {
    return "account-selected";
  }
  if (provider in probe.providers || provider in probe.unavailable) return "backend-owned";
  return "unknown";
}
