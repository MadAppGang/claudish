/**
 * Model metadata catalog — Firebase slim cache is the sole source of truth.
 *
 * All model facts (contextWindow, supportsVision) come from the slim catalog
 * at ~/.claudish/all-models.json, populated at proxy startup by the OpenRouter
 * catalog resolver.
 *
 * Adapter-specific behavior (temperature ranges, tool name limits, max tool
 * counts) lives in the dialect/format classes themselves — those are CLI
 * constraints, not model metadata.
 */

import type { ReasoningModeCapabilities } from "../model-loader.js";
import {
  type CachedSubscriptionPlan,
  type ModelEndpoint,
  type ReasoningCapability,
  type RouteVariant,
  type SlimModelEntry,
  readAllModelsCache,
} from "../providers/all-models-cache.js";
import { compareByReleaseDateDesc } from "../providers/model-ordering.js";

export type {
  ModelEndpoint,
  ReasoningCapability,
  ReasoningControl,
  RouteVariant,
} from "../providers/all-models-cache.js";
export type { ReasoningModeCapabilities } from "../model-loader.js";

export interface ModelEntry {
  /** Model ID as stored in the slim catalog (not lowercased) */
  modelId: string;
  /** Context window in tokens */
  contextWindow: number;
  /** Whether model supports vision/image input (may be undefined if Firebase didn't specify) */
  supportsVision?: boolean;
  /**
   * Curated release date (ISO `YYYY-MM-DD`), when Firebase has one. The
   * authoritative freshness signal — pickers prefer it over any date a provider
   * endpoint reports, which is a roster-added timestamp, not a release.
   */
  releaseDate?: string;
}

/**
 * Look up model metadata from the Firebase slim catalog cache.
 *
 * Accepts:
 *   - Bare model IDs ("glm-5", "minimax-m2.7")
 *   - Vendor-prefixed IDs ("x-ai/grok-4")
 *
 * Throws if `modelId` contains "@" — callers must strip the provider prefix
 * before calling (contract enforcement).
 *
 * Returns undefined when:
 *   - The cache file doesn't exist (cold start)
 *   - modelId isn't in the cache
 *   - The entry exists but has no `contextWindow`
 *
 * @param cachePath Override cache path. Defaults to `~/.claudish/all-models.json`.
 *                  Only tests should pass this.
 */
export function lookupModel(modelId: string, cachePath?: string): ModelEntry | undefined {
  const entry = findCacheEntry(modelId, cachePath);
  if (!entry || entry.contextWindow === undefined) return undefined;
  return {
    modelId: entry.modelId,
    contextWindow: entry.contextWindow,
    supportsVision: entry.supportsVision,
    releaseDate: entry.releaseDate,
  };
}

/**
 * Reasoning capability for a model, straight from the slim catalog.
 *
 * Separate from {@link lookupModel} on purpose: that one gates on
 * `contextWindow` being present (its callers want a window), whereas reasoning
 * metadata is useful on its own — a model can carry `reasoning` with no window.
 *
 * Returns undefined for a cold cache or an unknown model. Callers MUST treat
 * that as "no information" and keep their existing behaviour; it is never an
 * error, and it must never block a request.
 */
export function lookupModelReasoning(
  modelId: string,
  cachePath?: string
): ReasoningCapability | undefined {
  return findCacheEntry(modelId, cachePath)?.reasoning;
}

/**
 * The output-token parameter name this model's API expects.
 *
 * Returns `max_tokens` / `max_completion_tokens` / `max_output_tokens`, or
 * undefined for a cold cache or a model the catalog has no opinion on — in
 * which case the caller keeps whatever it did before.
 *
 * Callers must PREFER this over any name-based guess. Measured against the live
 * catalog, guessing from the name sends the wrong parameter to the whole
 * gpt-5.6-* family (they take `max_output_tokens`, the guess says
 * `max_completion_tokens`).
 */
export function lookupModelTokenParam(modelId: string, cachePath?: string): string | undefined {
  return findCacheEntry(modelId, cachePath)?.tokenParam;
}

/**
 * Preset-variant metadata — which family this model belongs to, and whether it
 * is that family's default on its provider.
 *
 * This is the sanctioned replacement for ranking variant suffixes client-side:
 * the catalog names the default (`isDefault`), so there is nothing to rank.
 */
export function lookupModelRouteVariant(
  modelId: string,
  cachePath?: string
): RouteVariant | undefined {
  return findCacheEntry(modelId, cachePath)?.routeVariant;
}

/**
 * `reasoning.mode` support for the exact route selected by `provider`.
 *
 * The same base model can support the parameter on one host, reject it on a
 * second, and remain unverified on a third. Never fall back to model-level
 * reasoning metadata or another aggregator row.
 */
export function lookupRouteReasoningMode(
  modelId: string,
  provider: string,
  cachePath?: string
): ReasoningModeCapabilities | undefined {
  return findCacheEntry(modelId, cachePath)?.aggregators?.find(
    (aggregator) => aggregator.provider === provider
  )?.reasoning?.mode;
}

/**
 * The default preset variant for a family on a given provider, if the catalog
 * knows one.
 *
 * Answers "the user typed `gemini-3.6-flash`, which id do we actually send to
 * Antigravity?" by scanning for the family's `isDefault` variant. Returns
 * undefined when the cache is cold or the family has no marked default, and the
 * caller then falls back to its own resolution.
 */
export function lookupFamilyDefaultVariant(
  familyId: string,
  provider: string,
  cachePath?: string
): string | undefined {
  const cache = readAllModelsCache(cachePath);
  if (!cache) return undefined;
  for (const entry of cache.entries) {
    const rv = entry.routeVariant;
    if (!rv?.isDefault) continue;
    if (rv.provider !== provider) continue;
    if (rv.familyId === familyId || rv.baseModelId === familyId) return entry.modelId;
  }
  return undefined;
}

/**
 * Every catalog variant whose preset expands `baseModelId`, optionally narrowed
 * to one serving provider.
 *
 * The inverse of {@link lookupModelRouteVariant}: that answers "which model is
 * this variant a preset OF?", this answers "which presets exist FOR this
 * model?".
 *
 * This is the sanctioned replacement for a name regex that asks "does this
 * model support capability X?". The catalog records BOTH halves of the fact —
 * which base model a preset applies to (`baseModelId`) and what the preset
 * actually sets (`preset`, in `--model-params` `k=v` syntax) — so the caller
 * carries neither a model list nor a hardcoded payload. Feed `preset` to
 * `parseModelParams()` to get the params the provider would have applied.
 *
 * Returns [] for a cold cache or a model with no variants. Callers MUST treat
 * that as "no information" and keep their existing behaviour; absence is never
 * an error and must never block a request.
 *
 * @param provider Only return variants recorded on this serving provider. A
 *   preset is an observation about ONE provider's roster, not a portable fact
 *   about the model — the same parameter may not exist on another host — so a
 *   caller that cannot verify the parameter independently should pass the
 *   provider it is actually routing to.
 */
export function lookupVariantPresets(
  baseModelId: string,
  provider?: string,
  cachePath?: string
): { modelId: string; preset: string; provider?: string }[] {
  const cache = readAllModelsCache(cachePath);
  if (!cache) return [];
  // Same key rule as findCacheEntry — the caller passes a BARE name, and on the
  // OpenRouter route a bare name still carries the vendor prefix
  // ("openai/gpt-5.6-sol") because OpenRouter's API requires it. Comparing raw
  // strings here matched nothing on precisely the provider whose presets the
  // catalog records, i.e. the feature was dead where it was meant to work.
  const wanted = stripVendorPrefix(baseModelId.toLowerCase());
  const found: { modelId: string; preset: string; provider?: string }[] = [];
  for (const entry of cache.entries) {
    const rv = entry.routeVariant;
    if (!rv?.preset || !rv.baseModelId) continue;
    if (stripVendorPrefix(rv.baseModelId.toLowerCase()) !== wanted) continue;
    if (provider !== undefined && rv.provider !== provider) continue;
    found.push({ modelId: entry.modelId, preset: rv.preset, provider: rv.provider });
  }
  return found;
}

/**
 * Coarse capability flags straight from the catalog. Each is undefined when the
 * catalog has no opinion — never defaulted to false, because "unknown" and "no"
 * lead to different behaviour (dropping tools from a request that needs them is
 * worse than sending them to a model that ignores them).
 */
export function lookupModelCapabilities(
  modelId: string,
  cachePath?: string
): { supportsTools?: boolean; supportsThinking?: boolean } | undefined {
  const entry = findCacheEntry(modelId, cachePath);
  if (!entry) return undefined;
  return { supportsTools: entry.supportsTools, supportsThinking: entry.supportsThinking };
}

/**
 * The wire API this model is reachable on for a transport family
 * (`openai` / `anthropic` / `gemini`).
 */
export function lookupModelEndpoint(
  modelId: string,
  transport: string,
  cachePath?: string
): ModelEndpoint | undefined {
  return findCacheEntry(modelId, cachePath)?.endpoints?.[transport];
}

/**
 * Provider-aware context window lookup.
 *
 * The same model id can enforce DIFFERENT windows on different serving backends
 * (e.g. gpt-5.6-sol = 1.05M on the OpenAI API but ~372K on the ChatGPT Codex
 * OAuth backend). The slim catalog carries the per-provider window on each
 * `aggregators[]` entry; this returns the window for `provider` if present,
 * else the model's top-level `contextWindow`.
 *
 * @param provider The resolved CLI provider name (e.g. "openai-codex").
 * @returns The provider-specific window, the top-level window, or undefined if
 *          the model isn't in the catalog at all.
 */
export function lookupModelForProvider(
  modelId: string,
  provider: string,
  cachePath?: string
): number | undefined {
  const entry = findCacheEntry(modelId, cachePath);
  if (!entry) return undefined;
  return (
    entry.aggregators?.find((a) => a.provider === provider)?.contextWindow ?? entry.contextWindow
  );
}

/**
 * Whether a subscription endpoint can serve a model, and under which wire id.
 *
 * - `serves`     — the plan includes this model; send `externalId` (the wire id
 *                  the endpoint accepts, e.g. `k3` for catalog `kimi-k3`).
 * - `not-served` — the provider IS a subscription plan, but this model isn't in
 *                  it. Routing should DROP the candidate: sending the model
 *                  anyway is a guaranteed rejection, and silently substituting a
 *                  different model gives the user something they didn't ask for.
 * - `unknown`    — not a subscription plan, or the model isn't in the catalog.
 *                  Caller keeps its existing behaviour.
 */
export type SubscriptionRouting =
  | { kind: "serves"; externalId: string }
  | { kind: "not-served" }
  | { kind: "unknown" };

/**
 * Resolve how a subscription provider should route a model, from catalog data
 * alone (`subscriptionPlans[]` plan IDs joined through cached `queryPlans`,
 * plus `aggregators[].externalId`).
 *
 * Nothing about which models a plan includes is hardcoded — that is exactly the
 * data that goes stale. Kimi Code shipping K3 while the CLI pinned
 * `kimi-for-coding` is the worked example.
 */
export function resolveSubscriptionRouting(
  modelId: string,
  provider: string,
  cachePath?: string
): SubscriptionRouting {
  const entry = findCacheEntry(modelId, cachePath);
  if (!entry) return { kind: "unknown" };

  const cache = readAllModelsCache(cachePath);
  const providerPlans =
    cache?.plans?.filter((plan) => plan.routing?.providerUid === provider) ?? [];

  // Legacy v2 caches predate queryPlans and stored provider UIDs directly in
  // subscriptionPlans. Preserve their old behavior until the next refresh.
  if (cache?.plans === undefined) {
    if (entry.subscriptionPlans?.includes(provider)) {
      const agg = entry.aggregators?.find((a) => a.provider === provider);
      return agg?.externalId ? { kind: "serves", externalId: agg.externalId } : { kind: "unknown" };
    }
    return isLegacySubscriptionPlan(provider, cachePath)
      ? { kind: "not-served" }
      : { kind: "unknown" };
  }

  if (providerPlans.length === 0) return { kind: "unknown" };

  const providerPlanIds = new Set(providerPlans.map((plan) => plan.id));
  const hasMembership = entry.subscriptionPlans?.some((planId) => providerPlanIds.has(planId));
  if (hasMembership) {
    const agg = entry.aggregators?.find((a) => a.provider === provider);
    // A plan membership without an aggregator entry has no wire id to send;
    // keep the candidate as unknown rather than inventing one. The normal
    // catalog resolver may still know the canonical provider wire ID.
    return agg?.externalId ? { kind: "serves", externalId: agg.externalId } : { kind: "unknown" };
  }

  // queryModels and queryPlans are separate requests, so a client can briefly
  // pair a new plan contract with an older slim snapshot. Static absence only
  // becomes authoritative after this cache demonstrates that it contains at
  // least one membership row for the provider's plans. Otherwise treating
  // zero coverage as a complete empty roster would drop every candidate during
  // a backend rollout (the exact OpenAI/Anthropic gap that motivated the join).
  const hasPublishedProviderRoster = cache.entries.some((candidate) =>
    candidate.subscriptionPlans?.some((planId) => providerPlanIds.has(planId))
  );
  if (!hasPublishedProviderRoster) return { kind: "unknown" };

  // Static absence is conclusive only for catalog-authoritative plans. Client
  // and hybrid plans may expose additional account-specific models after auth.
  return providerPlans.every(isCatalogDiscoveredPlan)
    ? { kind: "not-served" }
    : { kind: "unknown" };
}

function isCatalogDiscoveredPlan(plan: CachedSubscriptionPlan): boolean {
  return plan.modelDiscovery === "catalog";
}

/** Legacy provider-UID membership detection for caches without queryPlans. */
function isLegacySubscriptionPlan(provider: string, cachePath?: string): boolean {
  const cache = readAllModelsCache(cachePath);
  if (!cache) return false;
  return cache.entries.some((e) => e.subscriptionPlans?.includes(provider));
}

/**
 * Find the slim catalog entry for a model id (bare or vendor-prefixed), matching
 * on modelId or aliases. Shared by lookupModel / lookupModelForProvider.
 * Throws if `modelId` contains "@" — callers must strip the provider prefix.
 */
/**
 * The catalog's matching key for a model id: lowercased, vendor prefix dropped.
 *
 * `openai/gpt-5.6-sol` and `gpt-5.6-sol` are the SAME model — the prefix is
 * aggregator routing vocabulary, and OpenRouter's route keeps it on the bare
 * name (see the vendor-prefix note in proxy-server's getOpenRouterHandler).
 * Every catalog lookup must apply this rule or it silently misses exactly the
 * models reached through an aggregator.
 */
function stripVendorPrefix(lowerId: string): string {
  return lowerId.includes("/") ? lowerId.substring(lowerId.lastIndexOf("/") + 1) : lowerId;
}

function findCacheEntry(modelId: string, cachePath?: string): SlimModelEntry | undefined {
  if (modelId.includes("@")) {
    throw new Error(
      `model-catalog lookup received provider-routed ID "${modelId}" — callers must strip the "@" prefix before calling`
    );
  }

  const cache = readAllModelsCache(cachePath);
  if (!cache || cache.entries.length === 0) return undefined;

  const lower = modelId.toLowerCase();
  const unprefixed = stripVendorPrefix(lower);

  for (const entry of cache.entries) {
    const entryId = entry.modelId.toLowerCase();

    const exactMatch = entryId === unprefixed || entryId === lower;
    const aliasMatch = entry.aliases?.some(
      (a) => a.toLowerCase() === unprefixed || a.toLowerCase() === lower
    );

    if (exactMatch || aliasMatch) {
      return entry;
    }
  }

  return undefined;
}

/** Default context window when no catalog match (0 = unknown, shows N/A in status line) */
export const DEFAULT_CONTEXT_WINDOW = 0;

/** Default vision support when no catalog match */
export const DEFAULT_SUPPORTS_VISION = true;

/**
 * One catalog hit for a free-text model search.
 *
 * `modelId` is the BARE name routing accepts. `aliases` is the load-bearing
 * field: subscription endpoints speak their own wire ids (`k3` for `kimi-k3`,
 * `kimi-for-coding` for `kimi-k2.7-code`), and those ids exist in NO
 * aggregator's namespace. A search that consults only an aggregator listing
 * therefore reports them as nonexistent, which reads as "unroutable" and sends
 * the caller to a metered route instead.
 */
export interface CatalogSearchMatch {
  /** Bare catalog identity — the name to hand to routing. */
  modelId: string;
  aliases: string[];
  /** Subscription plans that include this model, verbatim from the catalog. */
  subscriptionPlans: string[];
  /** Set when the query matched an alias rather than the model id itself. */
  matchedAlias?: string;
}

/**
 * How one catalog entry matches a query, or undefined when it does not.
 *
 * Split out of {@link searchCatalogModels} so the matching RULE reads on its
 * own: an id hit and an alias hit are different answers, and only the alias
 * branch can resolve a subscription wire id to its catalog identity.
 */
function classifyCatalogHit(
  entry: SlimModelEntry,
  q: string
): { bucket: "exact" | "id" | "alias"; matchedAlias?: string } | undefined {
  const id = entry.modelId.toLowerCase();
  if (id === q || stripVendorPrefix(id) === q) return { bucket: "exact" };

  const aliases = entry.aliases ?? [];
  const exactAlias = aliases.find(
    (a) => a.toLowerCase() === q || stripVendorPrefix(a.toLowerCase()) === q
  );
  if (exactAlias) return { bucket: "exact", matchedAlias: exactAlias };

  if (id.includes(q)) return { bucket: "id" };

  const partialAlias = aliases.find((a) => a.toLowerCase().includes(q));
  return partialAlias ? { bucket: "alias", matchedAlias: partialAlias } : undefined;
}

/**
 * Search the local catalog cache by model id or alias.
 *
 * Deliberately separate from the aggregator-listing search in the MCP server:
 * that one answers "what does OpenRouter sell", this one answers "what name
 * does claudish know". Only the second can resolve a subscription wire id.
 *
 * Ranking is exact-match first (an exact alias hit is the whole point — it is
 * how `k3` resolves to `kimi-k3`), then substring hits on the id, then
 * substring hits on an alias.
 *
 * Returns [] for a cold or missing cache. Callers MUST treat that as "no
 * information" rather than "no such model".
 */
export function searchCatalogModels(
  query: string,
  limit = 10,
  cachePath?: string
): CatalogSearchMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const cache = readAllModelsCache(cachePath);
  if (!cache || cache.entries.length === 0) return [];

  type Ranked = { match: CatalogSearchMatch; entry: SlimModelEntry };
  const exact: Ranked[] = [];
  const idPartial: Ranked[] = [];
  const aliasPartial: Ranked[] = [];

  for (const entry of cache.entries) {
    const hit = classifyCatalogHit(entry, q);
    if (!hit) continue;
    const ranked: Ranked = {
      entry,
      match: {
        modelId: entry.modelId,
        aliases: entry.aliases ?? [],
        subscriptionPlans: entry.subscriptionPlans ?? [],
        ...(hit.matchedAlias ? { matchedAlias: hit.matchedAlias } : {}),
      },
    };
    if (hit.bucket === "exact") exact.push(ranked);
    else if (hit.bucket === "id") idPartial.push(ranked);
    else aliasPartial.push(ranked);
  }

  // Partial hits arrive in cache order, which buries the canonical model under
  // every superseded sibling sharing its family name: "kimi" returned five K2
  // variants and cut off K3 entirely.
  //
  // Rank by SPECIFICITY first, freshness second. Freshness alone is wrong here
  // because release dates are sparse — `kimi-k3` carries none while its own
  // derivative `kimi-k3-256k` is dated 2026-07-16, and compareByReleaseDateDesc
  // reads a missing date as the epoch, so the parent sorts below its variant.
  // The shortest id containing the query is the one with the least extra
  // material bolted on, which is what someone typing a family name means.
  const byRelevance = (a: Ranked, b: Ranked) => {
    const lengthDelta = a.entry.modelId.length - b.entry.modelId.length;
    if (lengthDelta !== 0) return lengthDelta;
    return compareByReleaseDateDesc(a.entry, b.entry);
  };
  idPartial.sort(byRelevance);
  aliasPartial.sort(byRelevance);

  return [...exact, ...idPartial, ...aliasPartial].slice(0, limit).map((r) => r.match);
}
