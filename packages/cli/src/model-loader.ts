import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readAllModelsCache } from "./providers/all-models-cache.js";
import { PROVIDER_TO_PREFIX } from "./providers/auto-route.js";
import { FIREBASE_CACHE_TTL_HOURS } from "./providers/cache-ttl.js";
import { ensureCatalogReady } from "./providers/catalog-client.js";
import { modelsBaseUrl } from "./providers/catalog-endpoints.js";
import { providerForCatalogRoute } from "./providers/catalog-route-bindings.js";
import {
  CATALOG_V3_ACCEPT,
  type CatalogV3Envelope,
  parseCatalogV3Envelope,
} from "./providers/catalog-v3.js";
import { compareByReleaseDateDesc } from "./providers/model-ordering.js";
import type { OpenRouterModel } from "./types.js";

// ─── Firebase Model Catalog Types ────────────────────────────────────────────
// These mirror `firebase/functions/src/schema.ts` but are defined locally so we
// don't cross the monorepo tsconfig boundary.

/**
 * Single recommended model entry from Firebase `?catalog=recommended`.
 * Matches `RecommendedModelEntry` in firebase/functions/src/schema.ts.
 */
export interface RecommendedModelEntry {
  id: string;
  name: string;
  description: string;
  provider: string;
  category: string;
  priority: number;
  pricing: {
    input: string;
    output: string;
    average: string;
  };
  context: string;
  /**
   * ISO release date, when the backend supplies one. Optional — the current
   * `?catalog=recommended` payload omits it, in which case the freshness
   * tiebreak in `groupRecommendedModels` degrades to version-parts-in-id.
   */
  releaseDate?: string;
  maxOutputTokens?: number | null;
  modality?: string;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
  isModerated?: boolean;
  recommended?: boolean;
  subscription?: RecommendedSubscriptionRoute;
  /**
   * Every executable subscription route for this model, in preference order.
   * Native Claude routes use a bare model command without a provider prefix.
   */
  subscriptions?: RecommendedSubscriptionRoute[];
}

export type RecommendedRouteTier = "native" | "general" | "metered" | "aggregator";

/** A callable route projected from catalog v3 recommendations. */
export interface RecommendedSubscriptionRoute {
  prefix?: string;
  plan: string;
  command: string;
  planIds?: string[];
  routingProvider?: string;
  tier?: RecommendedRouteTier;
}

/**
 * Response from Firebase `?catalog=recommended`.
 * Matches `RecommendedModelsDoc` in firebase/functions/src/schema.ts.
 */
export interface RecommendedModelsDoc {
  contractVersion?: 3;
  generationId?: string;
  version: string;
  lastUpdated: string;
  generatedAt?: string;
  source?: string;
  models: RecommendedModelEntry[];
}

/**
 * Confidence tier for source provenance — mirrors `ConfidenceTier` in
 * models-index/functions/src/schema.ts.
 */
export type ConfidenceTier =
  | "scrape_unverified"
  | "scrape_verified"
  | "aggregator_reported"
  | "gateway_official"
  | "api_official";

export type ReasoningModeCapabilities =
  | {
      status: "supported";
      values: string[];
      default?: string;
    }
  | {
      status: "rejected" | "unknown";
    };

export interface RouteReasoningCapabilities {
  mode?: ReasoningModeCapabilities;
}

/**
 * CLI-friendly aggregator entry — flattened view of `sources` keyed by the
 * canonical CLI provider name. Mirrors `AggregatorEntry` in
 * models-index/functions/src/schema.ts. Routing consults this to learn which
 * aggregators (OpenRouter, Fireworks, etc.) serve a given model.
 */
export interface AggregatorEntry {
  sourceProviderId: string;
  sourceCollectorId: string;
  confidence: ConfidenceTier;
  routeStatus: "mapped" | "unmapped";
  route?: { routeId: string; routeProfileId: string };
  externalModelId?: string;
  /**
   * True per-aggregator price for this (provider, externalId), as served by the
   * `?catalog=slim` endpoint. Present when the catalog knows this vendor's rate,
   * omitted otherwise (so consumers show N/A rather than a wrong price). This is
   * the gateway's actual rate, NOT the owner list price — an aggregator like
   * OpenRouter/OpenCode Zen can charge differently from the model owner.
   */
  pricing?: {
    /** How to read the rest of this object. Absent means the price is unknown. */
    type?: "flat" | "tiered" | "free" | "unavailable";
    input?: number;
    output?: number;
    cachedRead?: number;
    cachedWrite?: number;
    imageInput?: number;
    audioInput?: number;
    batchDiscountPct?: number;
    /**
     * Ascending price bands by input size. The catalog guarantees the top-level
     * `input`/`output` equal the first tier, verified on all 28 tiered
     * connections of generations g-20260920154425586-418ad3dd and
     * g-20260921062451697-f490edba (the latter being the first to carry the
     * agreed `type` field name).
     */
    tiers?: Array<{
      maxInputTokens?: number;
      input?: number;
      output?: number;
      cachedRead?: number;
      cachedWrite?: number;
    }>;
  };
  /**
   * True per-aggregator context window (max input tokens) for this
   * (provider, externalId), as served by the `?catalog=slim` endpoint. Present
   * when a serving backend enforces a DIFFERENT window than the model's headline
   * spec — e.g. the ChatGPT Codex OAuth backend (`openai-codex`) caps gpt-5.6-sol
   * at ~372K while the OpenAI API serves the full 1.05M. Omitted when the
   * aggregator matches the model default; consumers fall back to the top-level
   * `contextWindow`.
   */
  contextWindow?: number;
  /** Reasoning behavior verified for this exact serving provider/model route. */
  reasoning?: RouteReasoningCapabilities;
}

/**
 * Per-vendor availability row. Distinguishes the model OWNER from the
 * vendor that SERVES the model. Mirrors `VendorRecord` in
 * models-index/functions/src/schema.ts. The Firestore `Timestamp` is
 * degraded to `string | unknown` here so we don't pull firebase-admin into
 * the CLI bundle.
 */
export interface VendorRecord {
  vendor: string;
  role: "owner" | "gateway" | "aggregator";
  externalId: string;
  confidence: ConfidenceTier;
  lastSeen: string | unknown;
  sourceUrl?: string;
  pricing?: {
    input?: number;
    output?: number;
    cachedRead?: number;
    cachedWrite?: number;
    imageInput?: number;
    audioInput?: number;
    batchDiscountPct?: number;
  };
  contextWindow?: number;
  maxOutputTokens?: number;
}

/**
 * Full model document from Firebase `?search=...` or `?provider=...`.
 * Matches `ModelDoc` in models-index/functions/src/schema.ts.
 */
export interface ModelDoc {
  modelId: string;
  displayName?: string;
  provider: string;
  family?: string;
  description?: string;
  releaseDate?: string;
  pricing?: {
    input?: number;
    output?: number;
    inputCacheRead?: number;
    inputCacheWrite?: number;
    currency?: string;
    unit?: string;
  };
  contextWindow?: number;
  maxOutputTokens?: number;
  /**
   * IDs of subscription plans (e.g. "cognition-devin", "z-ai-glm-coding-plan")
   * that include this model.
   *
   * NAME MATTERS: the backend sends `subscriptionPlanIds`. This field was declared
   * as `availableInPlans` and read by nothing, so claudish was blind to it —
   * which is how a subscription-only model with no published per-token rate came
   * out as a bare "N/A" that reads as "unknown / not provisioned".
   */
  subscriptionPlanIds?: string[];
  /**
   * Vendor's own prose explaining an ABSENT `pricing` — e.g. "Cognition does not
   * publish standalone token pricing" / "Z.ai says the standalone API is coming
   * soon". Missing pricing is usually a deliberate vendor fact, not a data gap,
   * and this is the sentence that says which.
   */
  pricingSummary?: string;
  /** Upstream owner slug (e.g. "cognition", "z-ai"). Distinct from `provider`. */
  owner?: string;
  capabilities?: {
    vision?: boolean;
    thinking?: boolean;
    tools?: boolean;
    streaming?: boolean;
    jsonMode?: boolean;
    embedding?: boolean;
    imageGeneration?: boolean;
    audioInput?: boolean;
    audioOutput?: boolean;
  };
  aliases?: string[];
  status?: "active" | "deprecated" | "preview" | "unknown";
  /**
   * Multi-aggregator routing index. Optional, additive. Derived server-side
   * from `sources` at merge time. Field is omitted when no aggregators
   * contributed data for this model.
   */
  aggregators?: AggregatorEntry[];
  /**
   * Per-vendor availability rows used by routing logic. Optional and
   * additive — omitted when no vendor rows can be derived.
   */
  vendors?: VendorRecord[];
}

// ─── Model metadata for --model flag resolution ──────────────────────────────

interface ModelMetadata {
  name: string;
  description: string;
  priority: number;
  provider: string;
}

// ─── Module caches ───────────────────────────────────────────────────────────

let _cachedModelInfo: Record<string, ModelMetadata> | null = null;
let _cachedModelIds: string[] | null = null;
let _cachedRecommendedModels: RecommendedModelsDoc | null = null;

// ─── Firebase config ─────────────────────────────────────────────────────────

/**
 * The views this module asks the catalog service for.
 *
 * Each is built from `modelsBaseUrl()`, read once at the top of the operation
 * that uses it, so the fetches of one operation name one service even if the
 * setting moves underneath a later one. The endpoint itself lives in
 * `providers/catalog-endpoints.ts`, which is what makes `CLAUDISH_CATALOG_URL`
 * reach these requests as well as the slim catalog's.
 */
const RECOMMENDED_VIEW = "?catalog=recommended";

export const RECOMMENDED_MODELS_CACHE_PATH = join(
  homedir(),
  ".claudish",
  "recommended-models-cache.json"
);
const RECOMMENDED_FETCH_TIMEOUT_MS = 5000;
const SEARCH_FETCH_TIMEOUT_MS = 10000;

async function fetchCatalogPage<T>(
  url: string,
  timeoutMs: number,
  generationId?: string
): Promise<CatalogV3Envelope<T>> {
  const requestUrl = new URL(url);
  if (generationId) requestUrl.searchParams.set("generationId", generationId);
  const response = await fetch(requestUrl, {
    headers: { Accept: CATALOG_V3_ACCEPT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Model catalog returned HTTP ${response.status}`);
  const envelope = parseCatalogV3Envelope<T>(await response.json());
  if (!envelope) throw new Error("Model catalog returned an invalid v3 response");
  if (generationId && envelope.generationId !== generationId) {
    throw new Error("Model catalog generation changed during the read");
  }
  return envelope;
}

async function fetchCatalogData<T>(
  url: string,
  timeoutMs: number,
  generationId?: string
): Promise<T> {
  return (await fetchCatalogPage<T>(url, timeoutMs, generationId)).data;
}

function recommendationProjection(
  recommendations: {
    contractVersion: number;
    generationId: string;
    entries: Array<{
      modelId: string;
      tier: "flagship" | "lightweight" | "subscription";
      route?: { routeId: string; routeProfileId: string };
      planId?: string;
    }>;
  },
  richModels: ModelDoc[] = []
): RecommendedModelsDoc {
  if (recommendations.contractVersion !== 3 || !Array.isArray(recommendations.entries)) {
    throw new Error("Model catalog recommendations do not match v3");
  }
  const cache = readAllModelsCache();
  if (!cache || cache.catalogGenerationId !== recommendations.generationId) {
    throw new Error("Recommendation and model catalog generations differ");
  }
  const byId = new Map(cache?.entries.map((entry) => [entry.modelId, entry]) ?? []);
  const richById = new Map(richModels.map((model) => [model.modelId, model]));
  return {
    contractVersion: 3,
    generationId: recommendations.generationId,
    version: recommendations.generationId,
    lastUpdated: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    models: recommendations.entries.map((recommended, index) => {
      const model = byId.get(recommended.modelId);
      const rich = richById.get(recommended.modelId);
      const provider = recommended.route ? providerForCatalogRoute(recommended.route) : undefined;
      const connection = model?.aggregators?.find(
        (candidate) =>
          candidate.route?.routeId === recommended.route?.routeId &&
          candidate.route?.routeProfileId === recommended.route?.routeProfileId
      );
      const plan = cache?.plans.find((candidate) => candidate.id === recommended.planId);
      const prefix = provider ? (PROVIDER_TO_PREFIX[provider] ?? provider) : undefined;
      const command =
        prefix && connection?.externalModelId
          ? provider === "native-anthropic"
            ? connection.externalModelId
            : `${prefix}@${connection.externalModelId}`
          : undefined;
      const subscription =
        recommended.tier === "subscription" && provider && command
          ? {
              ...(provider === "native-anthropic" ? {} : { prefix }),
              plan: plan?.id ?? recommended.planId ?? provider,
              command,
              planIds: recommended.planId ? [recommended.planId] : [],
              routingProvider: provider,
              tier: provider === "native-anthropic" ? ("native" as const) : ("general" as const),
            }
          : undefined;
      return {
        id: recommended.modelId,
        name: rich?.displayName ?? model?.displayName ?? recommended.modelId,
        description: rich?.description ?? "",
        provider: rich?.provider ?? model?.provider ?? "",
        category:
          recommended.tier === "flagship"
            ? "programming"
            : recommended.tier === "lightweight"
              ? "fast"
              : "subscription",
        priority: index + 1,
        pricing: {
          input: typeof rich?.pricing?.input === "number" ? `$${rich.pricing.input}/1M` : "N/A",
          output: typeof rich?.pricing?.output === "number" ? `$${rich.pricing.output}/1M` : "N/A",
          average:
            typeof rich?.pricing?.input === "number" && typeof rich?.pricing?.output === "number"
              ? `$${((rich.pricing.input + rich.pricing.output) / 2).toFixed(2)}/1M`
              : "N/A",
        },
        context: rich?.contextWindow
          ? String(rich.contextWindow)
          : model?.contextWindow
            ? String(model.contextWindow)
            : "N/A",
        releaseDate: model?.releaseDate,
        ...(subscription ? { subscription, subscriptions: [subscription] } : {}),
      };
    }),
  };
}

// ─── Recommended models grouping + formatting helpers ───────────────────────

/**
 * A group of recommended-model entries that all share the same `id`. The
 * `primary` is the non-subscription entry (programming/vision/reasoning/fast);
 * `subscriptions` is every `category:"subscription"` entry in the group, in the
 * order they appeared in the source doc (which reflects access-method order).
 */
export interface RecommendedModelGroup {
  id: string;
  primary: RecommendedModelEntry;
  subscriptions: RecommendedModelEntry[];
  /** Category bucket for display: "flagship" = programming/vision/reasoning; "fast" = fast variants. */
  bucket: "flagship" | "fast";
}

/**
 * Group `entries` by `id`, preserving priority order. Each returned group's
 * bucket is derived from the primary entry's `category`:
 *   - "programming" | "vision" | "reasoning" → "flagship"
 *   - "fast"                                  → "fast"
 * Subscription-only groups (no non-subscription primary) are defensively
 * classified as "fast" — shouldn't happen in practice but keeps them visible.
 *
 * **Ordering.** The backend's curated ranking stays PRIMARY; freshness is only
 * the tiebreak (the repo-wide model-ordering rule). The curated ranking is two
 * keys, not one: `priority` restarts at 1 for every `category`, so sorting on
 * the bare number would interleave tiers (flagship #1, lightweight #1,
 * flagship #2, …). The sort key is therefore:
 *
 *   1. order of first appearance of the entry's `category` in the doc
 *   2. `priority` ascending within that category
 *   3. `compareByReleaseDateDesc` — newest first, only on a genuine tie
 *
 * Keys 1+2 reproduce the doc's own order exactly for a well-formed doc, so on
 * real data this is a no-op and key 3 never fires. It engages only when the
 * backend leaves two same-category entries at the same priority. As a bonus,
 * the explicit sort makes the output independent of any in-place reordering of
 * the shared cached doc (`getAvailableModels` sorts `data.models` in place).
 */
export function groupRecommendedModels(entries: RecommendedModelEntry[]): {
  flagship: RecommendedModelGroup[];
  fast: RecommendedModelGroup[];
} {
  const byId = new Map<string, RecommendedModelEntry[]>();
  const categoryOrder = new Map<string, number>();
  for (const entry of entries) {
    const list = byId.get(entry.id);
    if (list) list.push(entry);
    else byId.set(entry.id, [entry]);
    if (!categoryOrder.has(entry.category)) categoryOrder.set(entry.category, categoryOrder.size);
  }

  const flagship: RecommendedModelGroup[] = [];
  const fast: RecommendedModelGroup[] = [];

  for (const [id, members] of byId.entries()) {
    const primary = members.find((m) => m.category !== "subscription") ?? members[0];
    const subscriptions = members.filter((m) => m.category === "subscription");
    const bucket: "flagship" | "fast" =
      primary.category === "programming" ||
      primary.category === "vision" ||
      primary.category === "reasoning"
        ? "flagship"
        : "fast";
    const group: RecommendedModelGroup = { id, primary, subscriptions, bucket };
    if (bucket === "flagship") flagship.push(group);
    else fast.push(group);
  }

  const byCuratedPriorityThenFreshness = (
    a: RecommendedModelGroup,
    b: RecommendedModelGroup
  ): number => {
    const aCat = categoryOrder.get(a.primary.category) ?? Number.MAX_SAFE_INTEGER;
    const bCat = categoryOrder.get(b.primary.category) ?? Number.MAX_SAFE_INTEGER;
    if (aCat !== bCat) return aCat - bCat;
    if (a.primary.priority !== b.primary.priority) return a.primary.priority - b.primary.priority;
    return compareByReleaseDateDesc(a.primary, b.primary);
  };

  flagship.sort(byCuratedPriorityThenFreshness);
  fast.sort(byCuratedPriorityThenFreshness);

  return { flagship, fast };
}

/**
 * Compute the ordered, deduped list of routing prefixes for a group:
 *   [native-provider-prefix, ...subscription-prefixes]
 * Each prefix is bare (no `@`). `getNativePrefix` receives the lower-cased
 * Firebase slug and returns the native shortcut or null if the provider is
 * unknown / has no shortcut.
 */
export function collectRoutingPrefixes(
  group: RecommendedModelGroup,
  getNativePrefix: (firebaseSlug: string) => string | null
): string[] {
  const slug = (group.primary.provider || "").toLowerCase();
  const native = getNativePrefix(slug);
  const seen = new Set<string>();
  const out: string[] = [];
  if (native) {
    out.push(native);
    seen.add(native);
  }
  // `group.subscriptions` is ROWS (RecommendedModelEntry[], :282).
  // `row.subscriptions` is ROUTES. Same word, different things — renamed here
  // because reading one as the other reintroduces exactly the defect being fixed.
  for (const subscriptionRow of group.subscriptions) {
    // Plural first. An EMPTY plural is treated as an absent one: an empty array
    // and a missing field are indistinguishable as intent, and falling back can
    // only re-add a route the backend itself declared — it can never invent one.
    // NOT `??`: that falls through only on null/undefined, so an empty plural
    // would silently swallow a present singular.
    const routes =
      subscriptionRow.subscriptions && subscriptionRow.subscriptions.length > 0
        ? subscriptionRow.subscriptions
        : subscriptionRow.subscription
          ? [subscriptionRow.subscription]
          : [];
    const orderedRoutes = [...routes].sort(compareRecommendedRoutes);
    for (const route of orderedRoutes) {
      // `route?.` and not `route.`: these are WIRE elements. TypeScript types the
      // array as non-nullable objects (:59) so it will not warn, but a JSON `null`
      // inside `subscriptions[]` would throw a TypeError out of this function and
      // take down the entire list_models render (mcp-server.ts) and the CLI listing
      // (cli.ts) instead of dropping one route. The code this replaced read
      // `sub.subscription?.prefix`; that guard is not optional here. This whole
      // change exists because the wire omits fields we assumed were present.
      const p = route?.prefix;
      // LOAD-BEARING. Four native Claude rows ship a subscription entry with no
      // `prefix` at all; without this they emit `undefined@claude-opus-5`.
      if (!p || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

const RECOMMENDED_ROUTE_TIER_ORDER: Record<RecommendedRouteTier, number> = {
  native: 0,
  general: 1,
  metered: 2,
  aggregator: 3,
};

function compareRecommendedRoutes(
  left: RecommendedSubscriptionRoute,
  right: RecommendedSubscriptionRoute
): number {
  const leftRank =
    left?.tier && Object.hasOwn(RECOMMENDED_ROUTE_TIER_ORDER, left.tier)
      ? RECOMMENDED_ROUTE_TIER_ORDER[left.tier]
      : Number.MAX_SAFE_INTEGER;
  const rightRank =
    right?.tier && Object.hasOwn(RECOMMENDED_ROUTE_TIER_ORDER, right.tier)
      ? RECOMMENDED_ROUTE_TIER_ORDER[right.tier]
      : Number.MAX_SAFE_INTEGER;
  return leftRank - rightRank;
}

/** Parse "$1.32/1M" → 1.32, "FREE" → 0, "N/A"/"varies"/undefined → Infinity */
export function parsePriceAvg(s?: string): number {
  if (!s || s === "N/A") return Number.POSITIVE_INFINITY;
  if (s === "FREE") return 0;
  const m = s.match(/\$([\d.]+)/);
  return m ? Number.parseFloat(m[1]) : Number.POSITIVE_INFINITY;
}

/** Parse "196K" → 196000, "1M" → 1000000, "1048K" → 1048000 */
export function parseCtx(s?: string): number {
  if (!s || s === "N/A") return 0;
  const upper = s.toUpperCase();
  if (upper.includes("M")) return Number.parseFloat(upper) * 1_000_000;
  if (upper.includes("K")) return Number.parseFloat(upper) * 1_000;
  return Number.parseInt(s, 10) || 0;
}

/**
 * Normalize a raw pricing string from Firebase to what the renderers display.
 * - "$0.00/1M" or "FREE" → "FREE"
 * - strings containing "-1000000" (legacy-bug pattern) → "varies"
 * - otherwise returned unchanged (falling back to "N/A")
 */
export function normalizePricingDisplay(raw?: string): string {
  const pricing = raw || "N/A";
  if (pricing.includes("-1000000")) return "varies";
  if (pricing === "$0.00/1M" || pricing === "FREE") return "FREE";
  return pricing;
}

/**
 * Render a model's price for a LISTING, using the model's access route to
 * explain an absent rate instead of printing a bare "N/A".
 *
 * "N/A" is not a data gap for these models — it is the truthful answer, and the
 * catalog says why per model ("Cognition does not publish standalone token
 * pricing…", "Z.ai says the standalone API is coming soon…"). Both are
 * subscription-only models with no published per-token rate. Printing the raw
 * sentinel loses that entirely and reads as "unknown / never provisioned",
 * which is exactly how `swe-1.7` was triaged as unroutable while `dv@swe-1.7`
 * was serving 509-token replies.
 *
 * So when there is no rate AND the catalog names a subscription that includes
 * the model, say `SUB` — the same label the picker already uses for a flat-rate
 * provider (see `SUBSCRIPTION_PROVIDERS`) — qualified by the plan name. A model
 * with neither a rate nor a subscription keeps "N/A", which now genuinely means
 * "we don't know" rather than doubling as "subscription-only".
 *
 * Deliberately NOT a per-model cloud lookup: `subscription` already rides along
 * on the recommended catalog. `catalog-client.ts` is explicit that re-querying
 * the cloud one model at a time to fill gaps is not how this works.
 */
export function formatListingPrice(
  entry: {
    pricing?: { average?: string };
    subscription?: { plan?: string };
  },
  opts?: { compact?: boolean }
): string {
  const rate = normalizePricingDisplay(entry.pricing?.average);
  if (rate !== "N/A") return rate;
  const plan = entry.subscription?.plan;
  if (!plan) return "N/A";
  // `compact` exists for FIXED-WIDTH tables. Plan names are unbounded in
  // practice — "Devin" is 5, "Claude Code" is 11, so `SUB (Claude Code)` is 17
  // against a 10-wide column — and a price cell that overflows shoves every
  // column after it out of alignment for that ONE row, which looks like a
  // rendering bug rather than a longer name. Markdown surfaces have no column
  // to break, so they get the plan.
  return opts?.compact ? "SUB" : `SUB (${plan})`;
}

/**
 * Pick highlights from a deduped list of primary entries. Any field that can't
 * be computed is returned as null so callers can skip the line.
 */
export interface QuickPicks {
  budget: RecommendedModelEntry | null;
  largeContext: RecommendedModelEntry | null;
  mostCapable: RecommendedModelEntry | null;
  visionCoding: RecommendedModelEntry | null;
  agentic: RecommendedModelEntry | null;
}

export function computeQuickPicks(primaries: RecommendedModelEntry[]): QuickPicks {
  if (primaries.length === 0) {
    return {
      budget: null,
      largeContext: null,
      mostCapable: null,
      visionCoding: null,
      agentic: null,
    };
  }

  // Budget: cheapest non-FREE (skip FREE because they're typically gateways)
  const priced = primaries
    .filter((m) => {
      const p = parsePriceAvg(m.pricing?.average);
      return p > 0 && p !== Number.POSITIVE_INFINITY;
    })
    .sort((a, b) => parsePriceAvg(a.pricing?.average) - parsePriceAvg(b.pricing?.average));
  const budget = priced[0] ?? null;

  // Large context: max parseCtx
  const byCtx = [...primaries].sort((a, b) => parseCtx(b.context) - parseCtx(a.context));
  const largeContext = byCtx[0] ?? null;

  // Most capable: priciest
  const byPrice = [...primaries].sort(
    (a, b) => parsePriceAvg(b.pricing?.average) - parsePriceAvg(a.pricing?.average)
  );
  const mostCapable =
    byPrice.find((m) => parsePriceAvg(m.pricing?.average) !== Number.POSITIVE_INFINITY) ?? null;

  // Vision + code: first with vision, excluding budget/priciest
  const visionCoding =
    primaries.find(
      (m) => m.supportsVision === true && m.id !== budget?.id && m.id !== mostCapable?.id
    ) ?? null;

  // Agentic: first with reasoning, excluding priciest
  const agentic =
    primaries.find((m) => m.supportsReasoning === true && m.id !== mostCapable?.id) ?? null;

  return { budget, largeContext, mostCapable, visionCoding, agentic };
}

// ─── Recommended models loader ───────────────────────────────────────────────

/**
 * Load the recommended models doc asynchronously, with Firebase as the primary source.
 *
 * Resolution order:
 *   1. In-memory cache (unless forceRefresh)
 *   2. Disk cache at RECOMMENDED_MODELS_CACHE_PATH (24h TTL via FIREBASE_CACHE_TTL_HOURS)
 *   3. Firebase ?catalog=recommended (writes disk cache on success)
 *
 * Throws when all three tiers fail. The bundled fallback was removed in commit
 * 5 of the model-catalog and routing redesign — Firebase is the single catalog
 * source now (see plan §A and CLAUDE.md).
 */
export async function getRecommendedModels(
  opts: { forceRefresh?: boolean } = {}
): Promise<RecommendedModelsDoc> {
  const { forceRefresh = false } = opts;
  const cached = _cachedRecommendedModels;

  // Tier 1: in-memory cache
  if (
    !forceRefresh &&
    cached &&
    cached.generationId === readAllModelsCache()?.catalogGenerationId
  ) {
    return cached;
  }

  // Tier 2: disk cache (if fresh)
  // Firebase-derived data — OK to cache locally per the catalog policy.
  // TTL shared with all other Firebase caches via FIREBASE_CACHE_TTL_HOURS.
  if (!forceRefresh && existsSync(RECOMMENDED_MODELS_CACHE_PATH)) {
    try {
      const cacheData = JSON.parse(
        readFileSync(RECOMMENDED_MODELS_CACHE_PATH, "utf-8")
      ) as RecommendedModelsDoc;
      if (
        cacheData.contractVersion === 3 &&
        cacheData.generationId === readAllModelsCache()?.catalogGenerationId &&
        cacheData.models &&
        cacheData.models.length > 0 &&
        isFreshEnough(cacheData)
      ) {
        _cachedRecommendedModels = cacheData;
        return cacheData;
      }
    } catch {
      // Corrupt disk cache — fall through to Firebase
    }
  }

  // Tier 3: Firebase fetch
  let fetchFailure: unknown;
  try {
    await ensureCatalogReady(20000);
    const generationId = readAllModelsCache()?.catalogGenerationId;
    if (!generationId) throw new Error("No complete v3 model and plan snapshot");
    // One service for the whole operation: the recommendations and the top100
    // they are projected onto have to describe the same catalog.
    const base = modelsBaseUrl();
    const response = await fetchCatalogData<{
      mode: "recommended";
      recommendations: Parameters<typeof recommendationProjection>[0];
    }>(`${base}${RECOMMENDED_VIEW}`, RECOMMENDED_FETCH_TIMEOUT_MS, generationId);
    if (response.mode !== "recommended") throw new Error("Unexpected recommendation mode");
    if (response.recommendations.generationId !== generationId) {
      throw new Error("Recommendation and model catalog generations differ");
    }
    const top100 = await fetchCatalogData<{ mode: "top100"; models: ModelDoc[] }>(
      `${base}?catalog=top100`,
      RECOMMENDED_FETCH_TIMEOUT_MS,
      generationId
    );
    const data = recommendationProjection(response.recommendations, top100.models);
    if (data.models.length > 0) {
      _cachedRecommendedModels = data;
      try {
        const cacheDir = join(homedir(), ".claudish");
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(RECOMMENDED_MODELS_CACHE_PATH, JSON.stringify(data), "utf-8");
      } catch {
        // A disk write failure does not invalidate the fetched result.
      }
      return data;
    }
  } catch (error) {
    fetchFailure = error;
  }

  throw new Error(
    `Unable to load v3 recommended models: ${fetchFailure instanceof Error ? fetchFailure.message : "empty recommendation projection"}`
  );
}

/**
 * Synchronous accessor for the recommended models doc.
 *
 * Tiers (no network):
 *   1. In-memory cache
 *   2. Disk cache (no freshness check — best-effort)
 *
 * Sync access is best-effort; bundled fallback removed per the Firebase-only
 * catalog rule. Help text degrades to an empty doc if Firebase has never been
 * reached. Callers (`loadModelInfo()`, `getAvailableModels()` for `--model`
 * flag help) handle empty data.
 */
export function getRecommendedModelsSync(): RecommendedModelsDoc {
  const generationId = readAllModelsCache()?.catalogGenerationId;
  const cached = _cachedRecommendedModels;
  if (cached && cached.generationId === generationId) return cached;

  if (existsSync(RECOMMENDED_MODELS_CACHE_PATH)) {
    try {
      const cacheData = JSON.parse(
        readFileSync(RECOMMENDED_MODELS_CACHE_PATH, "utf-8")
      ) as RecommendedModelsDoc;
      if (
        cacheData.contractVersion === 3 &&
        cacheData.generationId === generationId &&
        cacheData.models &&
        cacheData.models.length > 0 &&
        isFreshEnough(cacheData)
      ) {
        _cachedRecommendedModels = cacheData;
        return cacheData;
      }
    } catch {
      // Fall through to empty doc
    }
  }

  return { version: "0", lastUpdated: "", models: [] };
}

/**
 * Fetches the current recommendation projection — fetches the Firebase catalog and warms caches.
 * Used by proxy-server.ts to kick off the background warm on startup.
 */
export async function warmRecommendedModels(): Promise<RecommendedModelsDoc | null> {
  try {
    return await getRecommendedModels({ forceRefresh: true });
  } catch {
    return null;
  }
}

function isFreshEnough(doc: RecommendedModelsDoc): boolean {
  const generatedAt = doc.generatedAt;
  if (!generatedAt) return false;
  const ageHours = (Date.now() - new Date(generatedAt).getTime()) / (1000 * 60 * 60);
  return ageHours <= FIREBASE_CACHE_TTL_HOURS;
}

// ─── On-demand Firebase search API ───────────────────────────────────────────

/**
 * Substring search across Firebase's model catalog (modelId, displayName, aliases).
 * Network-only — no local caching. Callers handle error UX.
 */
export async function searchModels(query: string, limit = 50): Promise<ModelDoc[]> {
  const url = `${modelsBaseUrl()}?search=${encodeURIComponent(query)}&limit=${limit}&status=active`;
  const data = await fetchCatalogData<{ models?: ModelDoc[]; total?: number }>(
    url,
    SEARCH_FETCH_TIMEOUT_MS
  );
  return data.models ?? [];
}

/**
 * Provider-scoped substring search across Firebase's model catalog.
 * Uses the same queryModels endpoint but narrows results to one provider slug.
 */
export async function searchModelsByProvider(
  provider: string,
  query: string,
  limit = 50
): Promise<ModelDoc[]> {
  const url = `${modelsBaseUrl()}?provider=${encodeURIComponent(
    provider
  )}&search=${encodeURIComponent(query)}&limit=${limit}&status=active`;
  const data = await fetchCatalogData<{ models?: ModelDoc[]; total?: number }>(
    url,
    SEARCH_FETCH_TIMEOUT_MS
  );
  return data.models ?? [];
}

/**
 * Look up a single model by its canonical ID (or alias) via Firebase search.
 * Returns null if not found, throws on network error.
 */
export async function getModelByIdFromFirebase(modelId: string): Promise<ModelDoc | null> {
  const url = `${modelsBaseUrl()}?modelId=${encodeURIComponent(modelId)}`;
  const data = await fetchCatalogData<{ mode: "exact"; model: ModelDoc | null }>(
    url,
    SEARCH_FETCH_TIMEOUT_MS
  );
  return data.mode === "exact" ? data.model : null;
}

/**
 * A ranked entry from `?catalog=top100` — a full `ModelDoc` augmented with
 * a 1-indexed `rank` and composite `score`. Shape mirrors the JSON response
 * emitted by `firebase/functions/src/query-handler.ts`.
 */
export interface Top100Entry extends ModelDoc {
  rank: number;
  score: number;
  /** Populated only when `?includeScores=1` is passed. */
  scoreBreakdown?: {
    total: number;
    popularity: number;
    recency: number;
    generation: number;
    capabilities: number;
    context: number;
    confidence: number;
  };
}

/**
 * Full response envelope for `?catalog=top100`. Unlike the
 * `?catalog=recommended` endpoint this is a flat ranked list of raw
 * `ModelDoc`s — it is NOT compatible with `RecommendedModelsDoc` or the
 * grouping helpers (groupRecommendedModels, collectRoutingPrefixes,
 * computeQuickPicks) which all expect `RecommendedModelEntry`.
 */
export interface Top100Response {
  models: Top100Entry[];
  total: number;
  poolSize: number;
  scoring: {
    weights: {
      popularity: number;
      recency: number;
      generation: number;
      capabilities: number;
      context: number;
      confidence: number;
    };
  };
}

/**
 * Fetch the top-100 ranked models from Firebase. Network-only — meant to be
 * fresh on every `--models` call; response is small (~50KB) so no disk
 * cache is maintained.
 */
export async function getTop100Models(): Promise<Top100Response> {
  const url = `${modelsBaseUrl()}?catalog=top100`;
  const data = await fetchCatalogData<Top100Response>(url, SEARCH_FETCH_TIMEOUT_MS);
  return data;
}

/**
 * Response from Firebase `?catalog=providers`. Each entry is a provider
 * slug and the number of active models attributed to that provider.
 * Sorted by count desc.
 */
export interface ProviderListEntry {
  slug: string;
  count: number;
}

/**
 * Fetch the list of active providers and their model counts.
 * Powers the CLI `--providers` command.
 */
export async function getProviderList(): Promise<ProviderListEntry[]> {
  const url = `${modelsBaseUrl()}?catalog=providers`;
  const data = await fetchCatalogData<{ providers?: ProviderListEntry[] }>(
    url,
    SEARCH_FETCH_TIMEOUT_MS
  );
  return data.providers ?? [];
}

/** Fetch every active model for a provider from one pinned generation. */
export async function getModelsByProvider(provider: string, pageSize = 200): Promise<ModelDoc[]> {
  const base = `${modelsBaseUrl()}?provider=${encodeURIComponent(provider)}&status=active&limit=${pageSize}`;
  return fetchPinnedModelDocs(base, "provider catalog");
}

/**
 * Every row of one cursor-paginated `queryModels` read, pinned to ONE generation.
 *
 * Shared by {@link getModelsByProvider} and {@link getAllModelDocs} because the
 * checks are the subtle part and must not drift between two copies: the total
 * may not change mid-read, a cursor may not repeat, and the rows collected must
 * match the total with no id twice. `label` only names the read in the errors.
 */
async function fetchPinnedModelDocs(base: string, label: string): Promise<ModelDoc[]> {
  const Label = label.charAt(0).toUpperCase() + label.slice(1);
  const models: ModelDoc[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let generationId: string | undefined;
  let expectedTotal: number | undefined;
  for (let page = 0; page < 40; page++) {
    const url = new URL(base);
    if (cursor) url.searchParams.set("cursor", cursor);
    const envelope = await fetchCatalogPage<{
      models: ModelDoc[];
      total: number;
      nextCursor?: string;
    }>(url.toString(), SEARCH_FETCH_TIMEOUT_MS, generationId);
    if (!Array.isArray(envelope.data.models) || !Number.isSafeInteger(envelope.data.total)) {
      throw new Error(`Incomplete ${label} response`);
    }
    generationId = envelope.generationId;
    expectedTotal ??= envelope.data.total;
    if (envelope.data.total !== expectedTotal)
      throw new Error(`${Label} total changed during pagination`);
    models.push(...envelope.data.models);
    const nextCursor = envelope.data.nextCursor;
    if (!nextCursor) {
      if (
        models.length !== expectedTotal ||
        new Set(models.map((model) => model.modelId)).size !== models.length
      ) {
        throw new Error(`Incomplete ${label} snapshot`);
      }
      return models;
    }
    if (seenCursors.has(nextCursor)) throw new Error(`${Label} cursor repeated`);
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new Error(`${Label} exceeded the pagination limit`);
}

/**
 * Every active model the cloud models catalog knows, in as few pages as it allows.
 *
 * WHY A BULK READ RATHER THAN N QUERIES. The picker needs one editorial fact per
 * model — the description — for every row it can draw. The slim catalog
 * (`?catalog=slim`, the file behind `all-models.json`) deliberately carries none:
 * `model-catalog.ts:servedByVendor` says so in its own doc comment. Asking per
 * model, or per provider, is the fan-out this picker already measured at
 * 10 018 ms.
 *
 * A v3 read like every other query here: the contract `Accept` header, cursor
 * pages pinned to one generation (via {@link fetchPinnedModelDocs}). A bare
 * `fetch` with no `Accept` is refused outright — measured 2026-09-18, HTTP 426
 * `catalog_client_upgrade_required`. MEASURED 2026-09-23 against the live v3
 * endpoint with this exact query: the rich projection serves at most 200 rows a
 * page (`limit=1000` returned 200 of 1267, plus a `nextCursor`), so this is about
 * seven pages. The caller caches the projection it needs on disk under the
 * shared TTL, so this runs at most once a day and never blocks a first paint.
 */
export async function getAllModelDocs(pageSize = 200): Promise<ModelDoc[]> {
  const base = `${modelsBaseUrl()}?status=active&limit=${pageSize}`;
  return fetchPinnedModelDocs(base, "model catalog");
}

// ─── Model loaders for cli.ts --model flag validation ────────────────────────

/**
 * Load ModelMetadata keyed by model ID for the --model flag help text.
 * Backed by the same sync recommended-models doc.
 */
export function loadModelInfo(): Record<OpenRouterModel, ModelMetadata> {
  if (_cachedModelInfo) {
    return _cachedModelInfo as Record<OpenRouterModel, ModelMetadata>;
  }

  const data = getRecommendedModelsSync();
  const modelInfo: Record<string, ModelMetadata> = {};

  for (const model of data.models) {
    modelInfo[model.id] = {
      name: model.name,
      description: model.description,
      priority: model.priority,
      provider: model.provider,
    };
  }

  // Custom option for the interactive picker
  modelInfo.custom = {
    name: "Custom Model",
    description: "Enter any model ID manually",
    priority: 999,
    provider: "Custom",
  };

  _cachedModelInfo = modelInfo;
  return modelInfo as Record<OpenRouterModel, ModelMetadata>;
}

/**
 * Get list of available model IDs (sorted by priority) from the recommended doc.
 */
export function getAvailableModels(): OpenRouterModel[] {
  if (_cachedModelIds) {
    return _cachedModelIds as OpenRouterModel[];
  }

  const data = getRecommendedModelsSync();
  const modelIds = data.models.sort((a, b) => a.priority - b.priority).map((m) => m.id);

  const result = [...modelIds, "custom"];
  _cachedModelIds = result;
  return result as OpenRouterModel[];
}
