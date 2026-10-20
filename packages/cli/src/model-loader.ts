import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type CachedSubscriptionPlan,
  type SlimModelEntry,
  readAllModelsCache,
} from "./providers/all-models-cache.js";
import { PROVIDER_TO_PREFIX } from "./providers/auto-route.js";
import { FIREBASE_CACHE_TTL_HOURS } from "./providers/cache-ttl.js";
import { ensureCatalogReady } from "./providers/catalog-client.js";
import { providerForCatalogRoute } from "./providers/catalog-route-bindings.js";
import {
  CATALOG_V3_ACCEPT,
  type CatalogV3Envelope,
  parseCatalogV3Envelope,
} from "./providers/catalog-v3.js";
import type { ConnectionWire } from "./providers/connection-wire.js";
import { compareByReleaseDateDesc } from "./providers/model-ordering.js";
import type { OpenRouterModel } from "./types.js";

// ─── Firebase Model Catalog Types ────────────────────────────────────────────
// These mirror `firebase/functions/src/schema.ts` but are defined locally so we
// don't cross the monorepo tsconfig boundary.

// ─── Recommendation tiers ────────────────────────────────────────────────────

/** One known recommendation tier and how listings present it. */
export interface RecommendationSectionDef {
  /** The backend's `tier` value, verbatim. */
  readonly recommendationTier: string;
  readonly title: string;
  readonly description?: string;
  /** False keeps every model of this tier out of the Quick picks (R9: luxury is never automatic). */
  readonly quickPickEligible: boolean;
}

/**
 * The ONE ordered table of recommendation tiers this build knows. Section order,
 * headings, descriptions and quick-pick eligibility are all read from here; no
 * listing hardcodes a heading. The backend's tier set is OPEN: a `tier` value not
 * in this table is skipped silently wherever it is read, so a new backend tier
 * needs one row here and nothing else.
 */
export const RECOMMENDATION_SECTIONS = [
  { recommendationTier: "flagship", title: "Flagship", quickPickEligible: true },
  {
    recommendationTier: "cost_efficient",
    title: "Cost-efficient",
    description: "Best value: strong models at a much lower cost per task",
    quickPickEligible: true,
  },
  { recommendationTier: "lightweight", title: "Lightweight", quickPickEligible: true },
  {
    recommendationTier: "luxury",
    title: "Luxury",
    description: "Most capable, most expensive. Use for the hardest tasks",
    quickPickEligible: false,
  },
  { recommendationTier: "subscription", title: "Subscription", quickPickEligible: true },
] as const satisfies readonly RecommendationSectionDef[];

/** Exactly "flagship" | "cost_efficient" | "lightweight" | "luxury" | "subscription". */
export type RecommendationTier = (typeof RECOMMENDATION_SECTIONS)[number]["recommendationTier"];

const RECOMMENDATION_TIER_INDEX: ReadonlyMap<string, number> = new Map(
  RECOMMENDATION_SECTIONS.map((section, index) => [section.recommendationTier, index])
);

function isRecommendationTier(value: unknown): value is RecommendationTier {
  return typeof value === "string" && RECOMMENDATION_TIER_INDEX.has(value);
}

/**
 * One row of the projected recommended-models list: one `(recommendationTier,
 * model)` pair (subscription rows: one per route binding and plan). A model the
 * backend lists in two tiers is two rows.
 */
export interface RecommendedModelEntry {
  id: string;
  name: string;
  description: string;
  provider: string;
  /** The backend's recommendation tier, verbatim. */
  recommendationTier: RecommendationTier;
  /** Rank within `recommendationTier`, from 1. */
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
 * The recommended-models list projected from `?catalog=recommended`: what
 * `--models-top --json` prints and what the disk cache holds.
 */
export interface RecommendedModelsDoc {
  contractVersion?: 3;
  generationId?: string;
  version: string;
  lastUpdated: string;
  generatedAt?: string;
  /**
   * The recommendation tiers this build knows, in table order. On disk it is the
   * WRITER's list: a reader that knows a tier missing from it refetches instead
   * of showing a listing silently missing that section, and a reader that keeps
   * the file replaces it with its own list (it drops rows of tiers it lacks).
   */
  recommendationTiers?: string[];
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
  /**
   * How to call this exact connection (catalog 3.7.0): API, output-limit field,
   * reasoning encoding, mode and speed. Present on every mapped connection of a
   * 3.7.0 generation; the only source of request decisions.
   */
  wire?: ConnectionWire;
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

const FIREBASE_BASE_URL = "https://us-central1-claudish-6da10.cloudfunctions.net/queryModels";
const FIREBASE_RECOMMENDED_URL = `${FIREBASE_BASE_URL}?catalog=recommended`;

/**
 * The projected recommended-models list, on disk.
 *
 * `-v2`, not `recommended-models-cache.json`: the row shape changed (`category`
 * removed, `recommendationTier` added). Older claudish builds sharing
 * `~/.claudish` check only `contractVersion` and `generationId`, so they would
 * accept a new-shape file under the old name and list every model as a fast
 * variant. A new ROW SHAPE gets a new file; a new TIER does not (see
 * `recommendationTiers`). This build never reads, writes or deletes the old file.
 */
export const RECOMMENDED_MODELS_CACHE_PATH = join(
  homedir(),
  ".claudish",
  "recommended-models-cache-v2.json"
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

/**
 * One element of `data.recommendations.entries`, as the backend sends it.
 * `tier` is a plain string on purpose: the backend's tier set is open, and a
 * value this build does not know is skipped, never rejected.
 */
export interface RecommendationWireEntry {
  modelId: string;
  tier: string;
  /** Backend: `route` and `planId` are both present or both absent. */
  route?: { routeId: string; routeProfileId: string };
  planId?: string;
}

/** `data.recommendations` of `?catalog=recommended`. */
export interface RecommendationsWire {
  contractVersion: number;
  generationId: string;
  /** Malformed elements are skipped; a non-array throws. */
  entries: unknown[];
}

/**
 * The cloud models catalog of ONE generation, as far as the projection reads it:
 * from each record `modelId`, `displayName`, `provider`, `contextWindow`,
 * `releaseDate` and `aggregators[].route` / `.externalModelId`; from each plan `id`.
 */
export interface RecommendationCatalogSnapshot {
  catalogGenerationId: string;
  entries: SlimModelEntry[];
  plans: CachedSubscriptionPlan[];
}

type KnownWireEntry = RecommendationWireEntry & { tier: RecommendationTier };

/** A usable wire entry, or null (not an object, no string modelId, or a tier this build does not know). */
function readWireEntry(value: unknown): KnownWireEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.modelId !== "string" || !isRecommendationTier(raw.tier)) return null;
  const rawRoute = raw.route as Record<string, unknown> | null | undefined;
  const route =
    rawRoute &&
    typeof rawRoute === "object" &&
    typeof rawRoute.routeId === "string" &&
    typeof rawRoute.routeProfileId === "string"
      ? { routeId: rawRoute.routeId, routeProfileId: rawRoute.routeProfileId }
      : undefined;
  return {
    modelId: raw.modelId,
    tier: raw.tier,
    ...(route ? { route } : {}),
    ...(typeof raw.planId === "string" ? { planId: raw.planId } : {}),
  };
}

/**
 * Dedupe key of one entry: within a tier only, so a model listed in two tiers
 * keeps a row in each. A subscription entry is one ROUTE BINDING under one PLAN,
 * so two entries for one model on different routes, or on one route under two
 * plans, are both kept.
 */
function recommendationDedupeKey(entry: KnownWireEntry): string {
  return entry.tier === "subscription"
    ? JSON.stringify([
        entry.tier,
        entry.modelId,
        entry.route?.routeId ?? null,
        entry.route?.routeProfileId ?? null,
        entry.planId ?? null,
      ])
    : JSON.stringify([entry.tier, entry.modelId]);
}

/**
 * Project `?catalog=recommended` onto the cloud models catalog of the same
 * generation. Pure: reads no file and no network.
 *
 * Per entry, in API order: skip a malformed entry or a tier not in
 * `RECOMMENDATION_SECTIONS` (silently: the tier set is open); skip a `modelId`
 * absent from `catalog.entries` (every tier: an id the catalog does not know
 * has no provider and no name); skip a repeated dedupe key; otherwise emit one
 * row whose `recommendationTier` is the entry's tier, verbatim, and whose
 * `priority` is its 1-based rank within that tier. Only a `subscription` entry
 * whose route resolves to a command carries `subscription`/`subscriptions`.
 *
 * Throws on envelope faults only: `contractVersion !== 3`, `entries` not an
 * array, or a catalog of a different generation.
 */
export function projectRecommendations(
  recommendations: RecommendationsWire,
  catalog: RecommendationCatalogSnapshot,
  richModels: ModelDoc[] = [],
  now: Date = new Date()
): RecommendedModelsDoc {
  if (recommendations.contractVersion !== 3 || !Array.isArray(recommendations.entries)) {
    throw new Error("Model catalog recommendations do not match v3");
  }
  // An empty catalog generation is the wrapper's "no slim cache" snapshot: never a match.
  if (
    !catalog.catalogGenerationId ||
    catalog.catalogGenerationId !== recommendations.generationId
  ) {
    throw new Error("Recommendation and model catalog generations differ");
  }
  const byId = new Map(catalog.entries.map((entry) => [entry.modelId, entry]));
  const richById = new Map<string, ModelDoc>();
  for (const model of richModels) {
    if (!richById.has(model.modelId)) richById.set(model.modelId, model);
  }
  const seenKeys = new Set<string>();
  const rankByTier = new Map<RecommendationTier, number>();
  const models: RecommendedModelEntry[] = [];

  for (const value of recommendations.entries) {
    const recommended = readWireEntry(value);
    if (!recommended) continue;
    const model = byId.get(recommended.modelId);
    if (!model) continue;
    const key = recommendationDedupeKey(recommended);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const priority = (rankByTier.get(recommended.tier) ?? 0) + 1;
    rankByTier.set(recommended.tier, priority);

    const rich = richById.get(recommended.modelId);
    const subscription =
      recommended.tier === "subscription"
        ? subscriptionRouteFor(recommended, model, catalog.plans)
        : undefined;
    models.push({
      id: recommended.modelId,
      name: rich?.displayName ?? model.displayName ?? recommended.modelId,
      description: rich?.description ?? "",
      provider: rich?.provider ?? model.provider ?? "",
      recommendationTier: recommended.tier,
      priority,
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
        : model.contextWindow
          ? String(model.contextWindow)
          : "N/A",
      releaseDate: model.releaseDate,
      // Capabilities come from the slim entry of the same generation. A field the
      // catalog does not publish stays absent: unknown is never written as false.
      ...(typeof model.supportsTools === "boolean" ? { supportsTools: model.supportsTools } : {}),
      ...(typeof model.reasoning?.supported === "boolean"
        ? { supportsReasoning: model.reasoning.supported }
        : {}),
      ...(typeof model.supportsVision === "boolean" ? { supportsVision: model.supportsVision } : {}),
      ...(subscription ? { subscription, subscriptions: [subscription] } : {}),
    });
  }

  const stamp = now.toISOString();
  return {
    contractVersion: 3,
    generationId: recommendations.generationId,
    version: recommendations.generationId,
    lastUpdated: stamp,
    generatedAt: stamp,
    recommendationTiers: RECOMMENDATION_SECTIONS.map((section) => section.recommendationTier),
    models,
  };
}

/**
 * The callable route of one subscription entry, or undefined when its route
 * binding names no claudish provider or the model has no connection on it with
 * a wire id. A subscription row without one is still a row.
 */
function subscriptionRouteFor(
  recommended: KnownWireEntry,
  model: SlimModelEntry,
  plans: CachedSubscriptionPlan[]
): RecommendedSubscriptionRoute | undefined {
  if (!recommended.route) return undefined;
  const provider = providerForCatalogRoute(recommended.route);
  if (!provider) return undefined;
  const connection = model.aggregators?.find(
    (candidate) =>
      candidate.route?.routeId === recommended.route?.routeId &&
      candidate.route?.routeProfileId === recommended.route?.routeProfileId
  );
  const prefix = PROVIDER_TO_PREFIX[provider] ?? provider;
  if (!connection?.externalModelId) return undefined;
  const command =
    provider === "native-anthropic"
      ? connection.externalModelId
      : `${prefix}@${connection.externalModelId}`;
  const plan = plans.find((candidate) => candidate.id === recommended.planId);
  return {
    ...(provider === "native-anthropic" ? {} : { prefix }),
    plan: plan?.id ?? recommended.planId ?? provider,
    command,
    planIds: recommended.planId ? [recommended.planId] : [],
    routingProvider: provider,
    tier: provider === "native-anthropic" ? "native" : "general",
  };
}

/**
 * The production wrapper: the slim cache, then the projection. The envelope and
 * generation checks live in `projectRecommendations` only; a missing cache is
 * passed as an empty snapshot with no generation, which fails its generation
 * check ("generations differ") after the envelope check, as before.
 */
function recommendationProjection(
  recommendations: RecommendationsWire,
  richModels: ModelDoc[] = []
): RecommendedModelsDoc {
  const cache = readAllModelsCache();
  return projectRecommendations(
    recommendations,
    cache
      ? {
          catalogGenerationId: cache.catalogGenerationId,
          entries: cache.entries,
          plans: cache.plans,
        }
      : { catalogGenerationId: "", entries: [], plans: [] },
    richModels
  );
}

// ─── Disk-cache reader ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRouteObject(value: unknown): value is RecommendedSubscriptionRoute {
  return (
    isRecord(value) &&
    typeof value.plan === "string" &&
    typeof value.command === "string" &&
    (value.prefix === undefined || typeof value.prefix === "string") &&
    (value.planIds === undefined || isStringArray(value.planIds))
  );
}

/** A row every consumer can dereference without a TypeError, of a tier this build knows. */
function isUsableRow(value: unknown): value is RecommendedModelEntry {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  if (!isRecommendationTier(value.recommendationTier)) return false;
  if (typeof value.priority !== "number" || !Number.isFinite(value.priority)) return false;
  if (
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    typeof value.provider !== "string" ||
    typeof value.context !== "string"
  ) {
    return false;
  }
  const pricing = value.pricing;
  if (
    !isRecord(pricing) ||
    typeof pricing.input !== "string" ||
    typeof pricing.output !== "string" ||
    typeof pricing.average !== "string"
  ) {
    return false;
  }
  if (value.releaseDate !== undefined && typeof value.releaseDate !== "string") return false;
  if (value.subscription !== undefined && !isRouteObject(value.subscription)) return false;
  if (
    value.subscriptions !== undefined &&
    !(Array.isArray(value.subscriptions) && value.subscriptions.every(isRouteObject))
  ) {
    return false;
  }
  return true;
}

/**
 * Read a parsed disk-cache value. Returns a NEW doc holding only usable rows, or
 * null. Never throws; never mutates `value`.
 *
 * Doc level (failure → null, so the caller refetches): contract 3, string
 * `generationId`/`version`/`lastUpdated`/`generatedAt`, array `models`, and a
 * `recommendationTiers` that lists EVERY tier of this build's table. A file whose
 * writer did not know one of this build's tiers may have dropped that tier's rows.
 *
 * Row level (failure → that row skipped): a row of a tier a NEWER build knows is
 * skipped here, not fatal, and so is a row a consumer could not dereference.
 * Zero rows left → null. The returned `recommendationTiers` is this build's
 * table, so it names exactly the tiers its rows can carry.
 */
export function readProjectedRecommendationsDoc(value: unknown): RecommendedModelsDoc | null {
  if (!isRecord(value)) return null;
  if (value.contractVersion !== 3) return null;
  if (
    typeof value.generationId !== "string" ||
    typeof value.version !== "string" ||
    typeof value.lastUpdated !== "string" ||
    typeof value.generatedAt !== "string" ||
    !Array.isArray(value.models)
  ) {
    return null;
  }
  const writerTiers = value.recommendationTiers;
  if (!isStringArray(writerTiers)) return null;
  if (!RECOMMENDATION_SECTIONS.every((section) => writerTiers.includes(section.recommendationTier)))
    return null;
  const models = value.models.filter(isUsableRow);
  if (models.length === 0) return null;
  // Report the tiers THIS build kept, not the writer's: a newer writer's extra
  // tier had its rows dropped above, so its list would no longer match `models`.
  return {
    ...(value as unknown as RecommendedModelsDoc),
    recommendationTiers: RECOMMENDATION_SECTIONS.map((section) => section.recommendationTier),
    models,
  };
}

/**
 * Steps 2-4 of the disk-cache read, shared by both read paths: absent file,
 * unparsable file or unusable doc → null. The empty doc of
 * `getRecommendedModelsSync` never reaches the reader: it is a return value,
 * never written to disk.
 */
function readRecommendedModelsCacheFile(): RecommendedModelsDoc | null {
  if (!existsSync(RECOMMENDED_MODELS_CACHE_PATH)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(RECOMMENDED_MODELS_CACHE_PATH, "utf-8"));
  } catch {
    return null;
  }
  return readProjectedRecommendationsDoc(parsed);
}

// ─── Recommended models grouping + formatting helpers ───────────────────────

/**
 * One model in one section. `primary` is that model's row of the section's
 * tier; `subscriptions` is every `recommendationTier: "subscription"` row with
 * the same id anywhere in the doc, in doc order, so the model's subscription
 * routes show on its via/Access line in whichever section it appears.
 */
export interface RecommendedModelGroup {
  id: string;
  primary: RecommendedModelEntry;
  subscriptions: RecommendedModelEntry[];
}

/** One non-empty recommendation tier, ready to render. */
export interface RecommendedSection {
  recommendationTier: RecommendationTier;
  title: string;
  description?: string;
  /** Never empty; sorted by `primary.priority`. */
  groups: RecommendedModelGroup[];
}

function sectionDefFor(tier: string): RecommendationSectionDef | undefined {
  const index = RECOMMENDATION_TIER_INDEX.get(tier);
  return index === undefined ? undefined : RECOMMENDATION_SECTIONS[index];
}

/**
 * Sections in `RECOMMENDATION_SECTIONS` order, empty ones omitted. Does not
 * mutate `entries`.
 *
 * **Ordering.** The backend's curated ranking stays PRIMARY; freshness is only
 * the tiebreak (the repo-wide model-ordering rule). Within a section groups sort
 * by `priority`, which is the rank within that tier, then
 * `compareByReleaseDateDesc` on a genuine tie (never between rows of one
 * projection, whose priorities are distinct per tier). A model listed in two
 * tiers is a group in each of the two sections. Rows of a tier not in the table
 * are ignored.
 */
export function groupRecommendedModels(
  entries: readonly RecommendedModelEntry[]
): RecommendedSection[] {
  const subscriptionRowsById = new Map<string, RecommendedModelEntry[]>();
  for (const entry of entries) {
    if (entry.recommendationTier !== "subscription") continue;
    const list = subscriptionRowsById.get(entry.id);
    if (list) list.push(entry);
    else subscriptionRowsById.set(entry.id, [entry]);
  }

  const sections: RecommendedSection[] = [];
  for (const def of RECOMMENDATION_SECTIONS) {
    const primaryById = new Map<string, RecommendedModelEntry>();
    for (const entry of entries) {
      if (entry.recommendationTier !== def.recommendationTier) continue;
      const current = primaryById.get(entry.id);
      if (!current || entry.priority < current.priority) primaryById.set(entry.id, entry);
    }
    if (primaryById.size === 0) continue;
    const groups: RecommendedModelGroup[] = [...primaryById.values()].map((primary) => ({
      id: primary.id,
      primary,
      subscriptions: subscriptionRowsById.get(primary.id) ?? [],
    }));
    groups.sort(
      (a, b) =>
        a.primary.priority - b.primary.priority || compareByReleaseDateDesc(a.primary, b.primary)
    );
    const description: string | undefined = "description" in def ? def.description : undefined;
    sections.push({
      recommendationTier: def.recommendationTier,
      title: def.title,
      ...(description ? { description } : {}),
      groups,
    });
  }
  return sections;
}

/**
 * The Quick picks input: primaries of `quickPickEligible` sections, in section
 * order then group order, unique by id (first kept), minus EVERY id that also
 * appears in a non-eligible section. "Most capable" is the priciest candidate,
 * so a luxury model let in through another section would be picked by
 * construction. `computeQuickPicks` sorts stably, so a tie goes to the earlier
 * candidate.
 */
export function quickPickCandidates(
  sections: readonly RecommendedSection[]
): RecommendedModelEntry[] {
  const excluded = new Set<string>();
  for (const section of sections) {
    if (sectionDefFor(section.recommendationTier)?.quickPickEligible === false) {
      for (const group of section.groups) excluded.add(group.id);
    }
  }
  const seen = new Set<string>();
  const candidates: RecommendedModelEntry[] = [];
  for (const section of sections) {
    if (sectionDefFor(section.recommendationTier)?.quickPickEligible !== true) continue;
    for (const group of section.groups) {
      if (excluded.has(group.id) || seen.has(group.id)) continue;
      seen.add(group.id);
      candidates.push(group.primary);
    }
  }
  return candidates;
}

/**
 * One row per model id, in section order then priority, first row winning.
 * For surfaces that list MODELS rather than sections (`--model` help, the
 * picker's fallback list). Does not mutate `entries`.
 */
export function uniqueRecommendedModels(
  entries: readonly RecommendedModelEntry[]
): RecommendedModelEntry[] {
  const sectionIndex = (entry: RecommendedModelEntry): number =>
    RECOMMENDATION_TIER_INDEX.get(entry.recommendationTier) ?? Number.MAX_SAFE_INTEGER;
  const ordered = [...entries].sort(
    (a, b) => sectionIndex(a) - sectionIndex(b) || a.priority - b.priority
  );
  const seen = new Set<string>();
  const unique: RecommendedModelEntry[] = [];
  for (const entry of ordered) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    unique.push(entry);
  }
  return unique;
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
 *   2. Disk cache at RECOMMENDED_MODELS_CACHE_PATH, read through
 *      `readProjectedRecommendationsDoc` (24h TTL via FIREBASE_CACHE_TTL_HOURS:
 *      claudish's own refetch interval, not the backend's evidence lifetime)
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
  // An absent, unparsable or unusable file falls through to Firebase.
  if (!forceRefresh) {
    const cacheData = readRecommendedModelsCacheFile();
    if (
      cacheData &&
      cacheData.generationId === readAllModelsCache()?.catalogGenerationId &&
      isFreshEnough(cacheData)
    ) {
      _cachedRecommendedModels = cacheData;
      return cacheData;
    }
  }

  // Tier 3: Firebase fetch
  let fetchFailure: unknown;
  try {
    await ensureCatalogReady(20000);
    const generationId = readAllModelsCache()?.catalogGenerationId;
    if (!generationId) throw new Error("No complete v3 model and plan snapshot");
    const response = await fetchCatalogData<{
      mode: "recommended";
      recommendations: Parameters<typeof recommendationProjection>[0];
    }>(FIREBASE_RECOMMENDED_URL, RECOMMENDED_FETCH_TIMEOUT_MS, generationId);
    if (response.mode !== "recommended") throw new Error("Unexpected recommendation mode");
    if (response.recommendations.generationId !== generationId) {
      throw new Error("Recommendation and model catalog generations differ");
    }
    const top100 = await fetchCatalogData<{ mode: "top100"; models: ModelDoc[] }>(
      `${FIREBASE_BASE_URL}?catalog=top100`,
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
 *   2. Disk cache, read through `readProjectedRecommendationsDoc`, same
 *      generation and freshness checks as the async path
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

  // An absent, unparsable or unusable file gives the empty doc. The empty doc is
  // a RETURN value only: it is never written to disk, so it is never read back.
  const cacheData = readRecommendedModelsCacheFile();
  if (cacheData && cacheData.generationId === generationId && isFreshEnough(cacheData)) {
    _cachedRecommendedModels = cacheData;
    return cacheData;
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
  const url = `${FIREBASE_BASE_URL}?search=${encodeURIComponent(
    query
  )}&limit=${limit}&status=active`;
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
  const url = `${FIREBASE_BASE_URL}?provider=${encodeURIComponent(
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
  const url = `${FIREBASE_BASE_URL}?modelId=${encodeURIComponent(modelId)}`;
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
  const url = `${FIREBASE_BASE_URL}?catalog=top100`;
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
  const url = `${FIREBASE_BASE_URL}?catalog=providers`;
  const data = await fetchCatalogData<{ providers?: ProviderListEntry[] }>(
    url,
    SEARCH_FETCH_TIMEOUT_MS
  );
  return data.providers ?? [];
}

/** Fetch every active model for a provider from one pinned generation. */
export async function getModelsByProvider(provider: string, pageSize = 200): Promise<ModelDoc[]> {
  const base = `${FIREBASE_BASE_URL}?provider=${encodeURIComponent(provider)}&status=active&limit=${pageSize}`;
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
  const base = `${FIREBASE_BASE_URL}?status=active&limit=${pageSize}`;
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

  // One key per model: a model in two recommendation tiers keeps the metadata of
  // its first-listed row.
  for (const model of uniqueRecommendedModels(data.models)) {
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
 * Get list of available model IDs from the recommended doc: one per model, in
 * section order then priority (`uniqueRecommendedModels`), then "custom".
 * Never sorts the shared cached doc in place: `--models-top --json` prints it.
 */
export function getAvailableModels(): OpenRouterModel[] {
  if (_cachedModelIds) {
    return _cachedModelIds as OpenRouterModel[];
  }

  const data = getRecommendedModelsSync();
  const modelIds = uniqueRecommendedModels(data.models).map((m) => m.id);

  const result = [...modelIds, "custom"];
  _cachedModelIds = result;
  return result as OpenRouterModel[];
}
