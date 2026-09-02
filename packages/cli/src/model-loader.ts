import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FIREBASE_CACHE_TTL_HOURS } from "./providers/cache-ttl.js";
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
   * Every plan that serves this model, in the order the backend sent them.
   * `subscription` above MIRRORS element 0 — measured across all 18 subscription
   * rows of the live payload: mirrors=18, diverges=0 (research.md R1). It is not
   * a curated primary, so the plural is the complete answer and the singular is
   * the compatibility fallback, never an addition.
   *
   * `prefix` is OPTIONAL and genuinely absent: the four native Claude rows carry
   * `{plan, command}` with no prefix, because their command is the bare model id
   * (research.md R2). The singular above still declares it required; that type
   * is already lying and is left alone here — see risk R-6.
   */
  subscriptions?: RecommendedSubscriptionRoute[];
}

export type RecommendedRouteTier = "native" | "general" | "metered" | "aggregator";

/** Backend-declared callable route. New fields stay optional for old disk caches. */
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
  provider: string;
  externalId: string;
  confidence: ConfidenceTier;
  /**
   * True per-aggregator price for this (provider, externalId), as served by the
   * `?catalog=slim` endpoint. Present when the catalog knows this vendor's rate,
   * omitted otherwise (so consumers show N/A rather than a wrong price). This is
   * the gateway's actual rate, NOT the owner list price — an aggregator like
   * OpenRouter/OpenCode Zen can charge differently from the model owner.
   */
  pricing?: {
    input?: number;
    output?: number;
    cachedRead?: number;
    cachedWrite?: number;
    imageInput?: number;
    audioInput?: number;
    batchDiscountPct?: number;
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
   * NAME MATTERS: the backend sends `subscriptionPlans`. This field was declared
   * as `availableInPlans` and read by nothing, so claudish was blind to it —
   * which is how a subscription-only model with no published per-token rate came
   * out as a bare "N/A" that reads as "unknown / not provisioned".
   */
  subscriptionPlans?: string[];
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

// ─── Legacy ModelMetadata (used by --model flag resolution) ──────────────────

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

const FIREBASE_BASE_URL = "https://us-central1-claudish-6da10.cloudfunctions.net/queryModels";
const FIREBASE_RECOMMENDED_URL = `${FIREBASE_BASE_URL}?catalog=recommended`;

export const RECOMMENDED_MODELS_CACHE_PATH = join(
  homedir(),
  ".claudish",
  "recommended-models-cache.json"
);
const RECOMMENDED_FETCH_TIMEOUT_MS = 5000;
const SEARCH_FETCH_TIMEOUT_MS = 10000;

// ─── Recommended models grouping + formatting helpers ───────────────────────

/**
 * Map from Firebase provider slug (as it appears in `RecommendedModelEntry.provider`
 * after the recommender capitalizes it, e.g. "Openai", "X-ai", "Moonshotai") to
 * the canonical `name` used in `providers/provider-definitions.ts`. This lets
 * both the CLI and MCP renderers look up the native routing prefix from the
 * provider shortcuts.
 *
 * The lookup key is the lower-cased provider field from the Firebase entry,
 * which matches the slug the recommender started from (see
 * `firebase/functions/src/recommender.ts` PROVIDERS table).
 */
export const FIREBASE_SLUG_TO_PROVIDER_NAME: Record<string, string> = {
  openai: "openai",
  google: "google",
  "x-ai": "x-ai",
  "z-ai": "z-ai",
  moonshotai: "kimi",
  minimax: "minimax",
  qwen: "qwen",
  deepseek: "deepseek",
  mistralai: "mistralai",
  sakana: "sakana",
};

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

/**
 * Convert the live recommended contract into exact routing rules. Each route
 * uses routingProvider (not the commercial plan ID) and the backend-confirmed
 * command wire ID. Tier is the ordering authority; array position is only the
 * stable tiebreak within one tier or for a legacy cached document.
 */
export function buildCatalogRoutingRules(doc: RecommendedModelsDoc): Record<string, string[]> {
  const routesByModel = new Map<
    string,
    Array<{ route: RecommendedSubscriptionRoute; sourceIndex: number }>
  >();
  let sourceIndex = 0;

  for (const entry of doc.models) {
    const routes =
      entry.subscriptions && entry.subscriptions.length > 0
        ? entry.subscriptions
        : entry.subscription
          ? [entry.subscription]
          : [];
    for (const route of routes) {
      routesByModel.set(entry.id, [...(routesByModel.get(entry.id) ?? []), { route, sourceIndex }]);
      sourceIndex += 1;
    }
  }

  const rules: Record<string, string[]> = {};
  for (const [modelId, candidates] of routesByModel) {
    const seen = new Set<string>();
    const entries = candidates
      .filter(
        ({ route }) =>
          typeof route?.routingProvider === "string" &&
          route.routingProvider.length > 0 &&
          typeof route.command === "string" &&
          route.command.length > 0
      )
      .sort(
        (left, right) =>
          compareRecommendedRoutes(left.route, right.route) || left.sourceIndex - right.sourceIndex
      )
      .map(({ route }) => {
        const at = route.command.indexOf("@");
        const wireId = at >= 0 ? route.command.slice(at + 1) : route.command;
        return `${route.routingProvider}@${wireId}`;
      })
      .filter((entry) => {
        if (seen.has(entry)) return false;
        seen.add(entry);
        return true;
      });
    if (entries.length > 0) rules[modelId] = entries;
  }

  return rules;
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

  // Tier 1: in-memory cache
  if (!forceRefresh && _cachedRecommendedModels) {
    return _cachedRecommendedModels;
  }

  // Tier 2: disk cache (if fresh)
  // Firebase-derived data — OK to cache locally per the catalog policy.
  // TTL shared with all other Firebase caches via FIREBASE_CACHE_TTL_HOURS.
  if (!forceRefresh && existsSync(RECOMMENDED_MODELS_CACHE_PATH)) {
    try {
      const cacheData = JSON.parse(
        readFileSync(RECOMMENDED_MODELS_CACHE_PATH, "utf-8")
      ) as RecommendedModelsDoc;
      if (cacheData.models && cacheData.models.length > 0 && isFreshEnough(cacheData)) {
        _cachedRecommendedModels = cacheData;
        return cacheData;
      }
    } catch {
      // Corrupt disk cache — fall through to Firebase
    }
  }

  // Tier 3: Firebase fetch
  try {
    const response = await fetch(FIREBASE_RECOMMENDED_URL, {
      signal: AbortSignal.timeout(RECOMMENDED_FETCH_TIMEOUT_MS),
    });
    if (response.ok) {
      const data = (await response.json()) as RecommendedModelsDoc;
      if (data.models && data.models.length > 0) {
        _cachedRecommendedModels = data;
        // Write disk cache (best-effort)
        try {
          const cacheDir = join(homedir(), ".claudish");
          mkdirSync(cacheDir, { recursive: true });
          writeFileSync(RECOMMENDED_MODELS_CACHE_PATH, JSON.stringify(data), "utf-8");
        } catch {
          // Don't fail the call if we can't write the cache
        }
        return data;
      }
    }
  } catch {
    // Silent — fall through to the explicit error below
  }

  throw new Error(
    "Unable to load recommended models: Firebase unreachable and no local cache. " +
      "Check connectivity."
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
  if (_cachedRecommendedModels) return _cachedRecommendedModels;

  if (existsSync(RECOMMENDED_MODELS_CACHE_PATH)) {
    try {
      const cacheData = JSON.parse(
        readFileSync(RECOMMENDED_MODELS_CACHE_PATH, "utf-8")
      ) as RecommendedModelsDoc;
      if (cacheData.models && cacheData.models.length > 0 && isFreshEnough(cacheData)) {
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
 * Thin backward-compatible wrapper — fetches the Firebase catalog and warms caches.
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
  if (!generatedAt) return true; // No timestamp — treat as usable
  const ageHours = (Date.now() - new Date(generatedAt).getTime()) / (1000 * 60 * 60);
  return ageHours <= FIREBASE_CACHE_TTL_HOURS;
}

// ─── On-demand Firebase search API ───────────────────────────────────────────

/**
 * Substring search across Firebase's model catalog (modelId, displayName, aliases).
 * Network-only — no local caching. Callers handle error UX.
 */
export async function searchModels(query: string, limit = 50): Promise<ModelDoc[]> {
  const url = `${FIREBASE_BASE_URL}?search=${encodeURIComponent(
    query
  )}&limit=${limit}&status=active`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(SEARCH_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Firebase search returned ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as { models?: ModelDoc[]; total?: number };
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
  const url = `${FIREBASE_BASE_URL}?provider=${encodeURIComponent(
    provider
  )}&search=${encodeURIComponent(query)}&limit=${limit}&status=active`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(SEARCH_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Firebase provider search returned ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as { models?: ModelDoc[]; total?: number };
  return data.models ?? [];
}

/**
 * Look up a single model by its canonical ID (or alias) via Firebase search.
 * Returns null if not found, throws on network error.
 */
export async function getModelByIdFromFirebase(modelId: string): Promise<ModelDoc | null> {
  const url = `${FIREBASE_BASE_URL}?search=${encodeURIComponent(modelId)}&limit=5`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(SEARCH_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Firebase lookup returned ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as { models?: ModelDoc[] };
  const models = data.models ?? [];
  // Exact match on modelId or aliases
  for (const m of models) {
    if (m.modelId === modelId) return m;
    if (m.aliases?.includes(modelId)) return m;
  }
  return null;
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
  const url = `${FIREBASE_BASE_URL}?catalog=top100`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(SEARCH_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Firebase top100 fetch failed: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as Top100Response;
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
  const url = `${FIREBASE_BASE_URL}?catalog=providers`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(SEARCH_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Firebase providers fetch failed: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as { providers?: ProviderListEntry[] };
  return data.providers ?? [];
}

/**
 * Fetch active models for a given provider.
 */
export async function getModelsByProvider(provider: string, limit = 200): Promise<ModelDoc[]> {
  const url = `${FIREBASE_BASE_URL}?provider=${encodeURIComponent(
    provider
  )}&status=active&limit=${limit}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(SEARCH_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Firebase provider query returned ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as ModelDoc[] | { models?: ModelDoc[] };
  if (Array.isArray(data)) return data;
  return data.models ?? [];
}

// ─── Legacy loaders retained for cli.ts --model flag validation ──────────────

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
