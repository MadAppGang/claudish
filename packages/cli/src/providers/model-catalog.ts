import { catalogRouteMatchesProvider, providerForCatalogRoute } from "./catalog-route-bindings.js";
/**
 * CatalogClient — single entry point for all Firebase-backed model catalog
 * questions. Replaces the three independent slug maps and per-provider
 * catalog calls with one interface over `model-loader.ts`.
 *
 * Caching policy: only Firebase responses go to disk; all caches share
 * `FIREBASE_CACHE_TTL_HOURS` from `cache-ttl.ts`. Direct-provider catalog
 * calls (Zen, LiteLLM `/model_group/info`) are removed in commit 5.
 *
 * See `ai-docs/sessions/dev-arch-20260427-140813-663f2981/architecture.md`
 * (plan §A) and `firebase-reality-check.md` for the data shape we read.
 */

import {
  type AggregatorEntry,
  type ModelDoc,
  getModelByIdFromFirebase,
  getModelsByProvider,
  searchModels as searchModelsFromFirebase,
} from "../model-loader.js";
import { type SlimModelEntry, readDiskCatalog, reasoningStatusOf } from "./all-models-cache.js";
import { FIREBASE_CACHE_TTL_MS } from "./cache-ttl.js";

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Catalog-shaped model record used by picker, routing-rules, and search UX.
 * A subset of `ModelDoc` chosen so callers don't depend on the full Firebase
 * schema — fields are added here as new picker/routing surfaces need them.
 */
export interface CatalogModel {
  modelId: string;
  displayName: string;
  /**
   * Owner provider (e.g. "anthropic", "openai"). Optional because the slim
   * catalog (used by aggregator-vendor queries) does not carry the owner
   * field — only `aggregators[]`. Callers that need the owner should query
   * via `modelsByVendor(<owner-slug>)` which uses the rich provider query.
   */
  provider?: string;
  description?: string;
  aggregators?: AggregatorEntry[];
  contextWindow?: number;
  supportsVision?: boolean;
  pricing?: ModelDoc["pricing"];
  releaseDate?: string;
  capabilities?: ModelDoc["capabilities"];
}

/**
 * The `CatalogClient` interface. Implemented by `createCatalogClient()`.
 *
 * Three operations, all backed by Firebase. Each is intentionally small so
 * the picker and routing layer can replace their hardcoded slug tables
 * with a single dependency.
 */
export interface CatalogClient {
  /**
   * All models a vendor SERVES. `vendorSlug` is a Firebase aggregator
   * provider name (e.g. "opencode-zen", "openrouter", "anthropic", "google").
   *
   * For owner-providers (e.g. "anthropic"): returns the rich provider query
   * `getModelsByProvider(slug)`.
   *
   * For aggregator/gateway providers (e.g. "opencode-zen", "openrouter"):
   * returns models whose `aggregators[]` lists this vendor. Reads from the
   * slim catalog cache at ~/.claudish/cloud-models-catalog-v3.json (24h TTL).
   *
   * For LiteLLM, Ollama, LM Studio: returns []. These have no Firebase
   * catalog by design — callers handle this with a free-text input prompt.
   */
  modelsByVendor(vendorSlug: string): Promise<CatalogModel[]>;

  /**
   * Aggregators that serve a given model. Reads from slim catalog cache.
   * Returns null if the model isn't in the catalog (caller decides whether
   * to error or attempt the request anyway).
   */
  vendorsForModel(modelId: string): Promise<AggregatorEntry[] | null>;

  /**
   * Cross-vendor search. Delegates to Firebase `?search=...` for live results.
   */
  searchModels(term: string, limit?: number): Promise<CatalogModel[]>;

  /**
   * Every model the slim catalog says this vendor SERVES — synchronous, local,
   * no network, for EVERY slug rather than only the aggregator ones.
   *
   * WHY IT EXISTS SEPARATELY FROM `modelsByVendor`. The picker draws ONE flat
   * cross-provider list, so it asks this question about ~31 providers at once.
   * `modelsByVendor` answers it for an owner slug with a live `?provider=` query,
   * and 22 of those fired together took 10 s and returned nothing (measured:
   * every one aborted on its shared timeout, while the same query alone takes
   * ~1.1 s). A picker cannot spend that, and it must not degrade to "this
   * provider has no models", which is the exact complaint this feature exists to
   * remove.
   *
   * IT IS NOT A SECOND AUTHORITY. Each `aggregators[]` row's route binding is
   * already the served-by index — `modelsByVendor`'s own owner branch filters its
   * rich lineage list THROUGH it (`filterToServedByProvider`) precisely because
   * lineage is not service. This applies the same rule to the same question and
   * skips the lineage query, so its membership is the served-by set exactly. The
   * cost is per-model richness: `description` and the owner slug are absent from
   * the slim payload, so a row's blurb is derived rather than editorial.
   */
  servedByVendor(vendorSlug: string): CatalogModel[];
}

// ─── Slug classification ─────────────────────────────────────────────────────

/**
 * Vendors that OWN models — these are values that appear in the Firebase
 * `provider` field and answer the rich `?provider=...` query well. When a
 * slug is in this set we prefer `getModelsByProvider()` which returns the
 * full ModelDoc shape.
 *
 * Note: a slug can be BOTH an owner and a name bound to a route. "anthropic"
 * owns Claude models AND is the claudish provider of Anthropic's native API route
 * (`anthropic/direct-api`, the Claude API). The owner path wins because it returns
 * more complete data.
 */
const OWNER_PROVIDER_SLUGS = new Set<string>([
  "anthropic",
  "openai",
  "google",
  "x-ai",
  "z-ai",
  "deepseek",
  "minimax",
  "moonshotai",
  "qwen",
  "sakana",
]);

/**
 * Cold-start seed for the aggregator set. NOT the list itself — see
 * {@link aggregatorProviderSlugs}, which derives the real one from the catalog.
 *
 * Used only when the slim cache is empty (first run, before the first fetch),
 * where an empty set would make `modelsByVendor()` return nothing for everyone.
 *
 * Each seed is a claudish provider name, the spelling `modelsByVendor()` is asked
 * in and the one the derived set holds. `together`, not the catalog's `routeId`
 * `together-ai`: no caller asks for `together-ai`, so that seed matched nothing
 * and a cold `modelsByVendor("together")` fell through to the owner query.
 */
const AGGREGATOR_SLUG_SEED = new Set<string>([
  "openrouter",
  "opencode-zen",
  "opencode-zen-go",
  "fireworks",
  "together",
]);

/**
 * Which providers SERVE other owners' models, derived from the catalog itself.
 *
 * `aggregators[].provider` IS this set — every provider that serves anything
 * appears there by construction. Hardcoding it meant the list went stale the
 * moment the backend added a provider, silently: `modelsByVendor()` fell
 * through and returned nothing, and the picker papered over the empty list by
 * aliasing to a DIFFERENT provider's catalog (`antigravity` → `google`), so
 * users were shown the direct Gemini API's models under the Antigravity
 * subscription. Measured against the live catalog, the hardcoded set of 5
 * missed 4 real providers: antigravity (20 models), mistralai (19),
 * kimi-coding (4), openai-codex (1).
 *
 * Recomputed per call from the passed-in cache reader — the cache is already
 * memoized upstream, and the set must track a refresh without a restart.
 */
function aggregatorProviderSlugs(
  readSlimCache: () => { entries: SlimModelEntry[] } | null
): Set<string> {
  const cache = readSlimCache();
  if (!cache || cache.entries.length === 0) return AGGREGATOR_SLUG_SEED;

  const slugs = new Set<string>();
  for (const entry of cache.entries) {
    for (const agg of entry.aggregators ?? []) {
      if (agg.routeStatus === "mapped") {
        const provider = providerForCatalogRoute(agg.route!);
        if (provider) slugs.add(provider.toLowerCase());
      }
    }
  }
  // Union with the seed: a provider claudish knows how to reach should not
  // vanish from the picker just because the current catalog snapshot happens
  // to carry no models for it.
  for (const seed of AGGREGATOR_SLUG_SEED) slugs.add(seed);
  return slugs;
}

/**
 * Local-only / undocumented-catalog vendors. These have no Firebase catalog
 * by design; the picker shows a free-text input instead of a model list.
 * claudish provider names only: LM Studio is `lmstudio`.
 */
const NO_CATALOG_VENDOR_SLUGS = new Set<string>(["litellm", "ollama", "lmstudio"]);

// ─── Internal helpers ────────────────────────────────────────────────────────

function modelDocToCatalogModel(doc: ModelDoc): CatalogModel {
  return {
    modelId: doc.modelId,
    displayName: doc.displayName ?? doc.modelId,
    provider: doc.provider,
    description: doc.description,
    aggregators: doc.aggregators,
    contextWindow: doc.contextWindow,
    supportsVision: doc.capabilities?.vision,
    pricing: doc.pricing,
    releaseDate: doc.releaseDate,
    capabilities: doc.capabilities,
  };
}

/**
 * Filter an owner-lineage model list down to the models the slim catalog's
 * served-by index (`aggregators[].provider`) confirms THIS provider actually
 * serves, and graft the matched served-by aggregators onto each kept model (the
 * owner query returns `aggregators: null`, so the picker's downstream pricing /
 * externalId resolution needs them attached here).
 *
 * The backend emits the owner's canonical slug in the served-by index for
 * first-party serving, so this is a plain exact-match — no slug translation.
 *
 * Safety: if the slim cache is empty/unavailable (cold start), DON'T filter —
 * return the full list so the picker isn't blanked. A model present in the owner
 * list but absent from the slim cache is excluded (conservative: better to hide
 * a possibly-unservable model than to offer one that 404s).
 */
function filterToServedByProvider(
  models: CatalogModel[],
  slug: string,
  reader: () => ReturnType<typeof readDiskCatalog>
): CatalogModel[] {
  const { entries } = readSlimCacheWithFreshness(reader);
  if (entries.length === 0) return models; // cold start — don't blank the picker

  // Index slim entries by modelId AND every alias, so an owner doc whose id is
  // an alias in the slim catalog still matches.
  const byId = new Map<string, SlimModelEntry>();
  for (const entry of entries) {
    byId.set(entry.modelId.toLowerCase(), entry);
    for (const alias of entry.aliases) byId.set(alias.toLowerCase(), entry);
  }

  const kept: CatalogModel[] = [];
  for (const model of models) {
    const slim = byId.get(model.modelId.toLowerCase());
    // A connection is a MAPPED aggregator entry; a route on any other status is
    // not a way to call the model.
    const served = slim?.aggregators?.some(
      (agg) => agg.routeStatus === "mapped" && catalogRouteMatchesProvider(agg.route, slug)
    );
    if (served) {
      kept.push({ ...model, aggregators: slim?.aggregators ?? model.aggregators });
    }
  }
  return kept;
}

export function slimEntryToCatalogModel(entry: SlimModelEntry): CatalogModel {
  return {
    modelId: entry.modelId,
    displayName: entry.modelId,
    // `provider` (owner) is intentionally omitted — the slim catalog doesn't
    // carry it. Aggregator queries are about "who serves this model", not
    // "who owns this model"; callers don't need owner here.
    aggregators: entry.aggregators,
    contextWindow: entry.contextWindow,
    supportsVision: entry.supportsVision,
    releaseDate: entry.releaseDate,
    // THE TWO CAPABILITY FLAGS THE SLIM CACHE ACTUALLY CARRIES, forwarded in the
    // shape every renderer reads. They were dropped here: `supportsVision` above
    // goes into a field only the probe path reads, and `reasoning` was not mapped
    // at all — so every aggregator-served list (OpenRouter's 349 models, and it is
    // the default provider) rendered its capability column entirely dead while the
    // data sat in the cache. Visible the moment a row carries a capability column.
    //
    // `supportsTools` IS carried by the slim payload (~97% of models, per its own
    // field doc) and was left unmapped here, so every aggregator-served row showed
    // a dead tools flag while the answer sat one property away. It is forwarded
    // ONLY when present — `undefined` stays `undefined` rather than becoming
    // `false`, because "the catalog does not say" and "this model cannot take
    // tools" are different claims and only the second one disqualifies a model.
    capabilities: {
      ...(entry.supportsVision === undefined ? {} : { vision: entry.supportsVision }),
      // v3 `reasoning` is an OBJECT, `{ supported: false }` included — reading its
      // mere presence as "thinks" flagged 469 of 1137 non-reasoning entries as
      // reasoning models. Same rule as the adapters: an UNKNOWN status says nothing.
      ...(entry.reasoning === undefined || reasoningStatusOf(entry) === "unknown"
        ? {}
        : { thinking: entry.reasoning.supported }),
      ...(entry.supportsTools === undefined ? {} : { tools: entry.supportsTools }),
    },
  };
}

/**
 * Read the slim cache fresh-or-stale, plus a flag indicating whether it's
 * past the shared TTL. Callers use the flag to decide whether to try a live
 * Firebase fetch as a fallback.
 *
 * Firebase-derived data — OK to cache locally per the catalog policy.
 * TTL shared with all other Firebase caches via FIREBASE_CACHE_TTL_HOURS.
 */
function readSlimCacheWithFreshness(reader: () => ReturnType<typeof readDiskCatalog>): {
  entries: SlimModelEntry[];
  stale: boolean;
} {
  const cache = reader();
  if (!cache) return { entries: [], stale: true };

  const lastUpdatedMs = new Date(cache.lastUpdated).getTime();
  const ageMs = Date.now() - lastUpdatedMs;
  const stale = !Number.isFinite(lastUpdatedMs) || ageMs > FIREBASE_CACHE_TTL_MS;

  return { entries: cache.entries ?? [], stale };
}

// ─── Dependency injection ────────────────────────────────────────────────────

/**
 * Optional dependency overrides for testing. Production callers pass nothing
 * and get the real `model-loader.ts` + `all-models-cache.ts` wiring.
 */
export interface CatalogClientDeps {
  getModelsByProvider?: typeof getModelsByProvider;
  getModelByIdFromFirebase?: typeof getModelByIdFromFirebase;
  searchModels?: typeof searchModelsFromFirebase;
  /** Returns the parsed slim cache or null. Default reads ~/.claudish/cloud-models-catalog-v3.json. */
  readSlimCache?: () => ReturnType<typeof readDiskCatalog>;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Construct a `CatalogClient`. Pass `deps` only in tests — real callers omit
 * the argument and get the production wiring.
 */
export function createCatalogClient(deps: CatalogClientDeps = {}): CatalogClient {
  const _getModelsByProvider = deps.getModelsByProvider ?? getModelsByProvider;
  const _getModelByIdFromFirebase = deps.getModelByIdFromFirebase ?? getModelByIdFromFirebase;
  const _searchModels = deps.searchModels ?? searchModelsFromFirebase;
  const _readSlimCache = deps.readSlimCache ?? readDiskCatalog;

  return {
    async modelsByVendor(vendorSlug: string): Promise<CatalogModel[]> {
      const slug = vendorSlug.toLowerCase();

      // No-catalog vendors short-circuit without I/O. Picker is expected to
      // detect [] and switch to the free-text input path.
      if (NO_CATALOG_VENDOR_SLUGS.has(slug)) return [];

      // Owners → rich provider query (returns full ModelDoc).
      //
      // The `?provider=` query returns every model the provider OWNS by lineage,
      // but a provider can only SERVE the subset its API actually exposes (e.g.
      // `gpt-latest` is OpenAI-owned but only OpenRouter serves it → calling it
      // via oai@ 404s). The slim catalog's `aggregators[].provider` is the
      // served-by index; since the backend now emits the owner's canonical slug
      // there for first-party serving, we keep only models whose slim entry lists
      // THIS provider as a server, and graft the served-by aggregators (pricing /
      // externalId) onto the kept models. The picker selects a provider exactly
      // to see what that provider can run — lineage is not service.
      if (OWNER_PROVIDER_SLUGS.has(slug)) {
        const docs = await _getModelsByProvider(slug);
        return filterToServedByProvider(docs.map(modelDocToCatalogModel), slug, _readSlimCache);
      }

      // Aggregators → filter slim cache by aggregators[].provider. The set of
      // aggregator slugs is DERIVED from that same field, so a provider the
      // backend starts serving shows up here without a code change.
      if (aggregatorProviderSlugs(_readSlimCache).has(slug)) {
        const { entries } = readSlimCacheWithFreshness(_readSlimCache);
        const matches = entries.filter((entry) =>
          entry.aggregators?.some((agg) => catalogRouteMatchesProvider(agg.route, slug))
        );
        return matches.map(slimEntryToCatalogModel);
      }

      // Unknown slug — fall through to the rich provider query. Firebase
      // returns [] for genuinely unknown providers; this preserves the
      // owner-path completeness for any new owner slug we haven't enumerated
      // here yet.
      const docs = await _getModelsByProvider(slug);
      return docs.map(modelDocToCatalogModel);
    },

    async vendorsForModel(modelId: string): Promise<AggregatorEntry[] | null> {
      // Firebase-derived data — OK to cache locally per the catalog policy.
      // TTL shared with all other Firebase caches via FIREBASE_CACHE_TTL_HOURS.
      const { entries, stale } = readSlimCacheWithFreshness(_readSlimCache);

      // Try the in-cache lookup first regardless of staleness — even a stale
      // cache is better than a network round-trip if the model is present.
      for (const entry of entries) {
        if (entry.modelId === modelId || entry.aliases.includes(modelId)) {
          return entry.aggregators ?? [];
        }
      }

      // Cache miss. If the cache is fresh and the model wasn't there, treat
      // the catalog as authoritative for this question and return null.
      if (!stale) return null;

      // Stale (or empty) cache + cache miss: fall back to live Firebase to
      // give the caller a definitive answer. We don't refresh the slim cache
      // here — that's a separate code path (openrouter resolver) and adding
      // a fire-and-forget refresh from the catalog read site has historically
      // caused interleaved-write bugs.
      const doc = await _getModelByIdFromFirebase(modelId);
      if (!doc) return null;
      return doc.aggregators ?? [];
    },

    async searchModels(term: string, limit = 50): Promise<CatalogModel[]> {
      const docs = await _searchModels(term, limit);
      return docs.map(modelDocToCatalogModel);
    },

    servedByVendor(vendorSlug: string): CatalogModel[] {
      const slug = vendorSlug.toLowerCase();
      // Local-only vendors are absent from the catalog BY DESIGN, so an empty
      // answer here is a fact, not a miss. Their dynamic models catalogs come from their own
      // daemons through `modelDiscovery`.
      if (NO_CATALOG_VENDOR_SLUGS.has(slug)) return [];
      const { entries } = readSlimCacheWithFreshness(_readSlimCache);
      const out: CatalogModel[] = [];
      for (const entry of entries) {
        // The same rule `filterToServedByProvider` applies, so the two answers
        // cannot drift: a v3 row names who serves it by a mapped connection's
        // route binding.
        if (
          entry.aggregators?.some(
            (agg) => agg.routeStatus === "mapped" && catalogRouteMatchesProvider(agg.route, slug)
          )
        ) {
          out.push(slimEntryToCatalogModel(entry));
        }
      }
      return out;
    },
  };
}
