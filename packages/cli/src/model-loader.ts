import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { OpenRouterModel } from "./types.js";

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
  maxOutputTokens?: number | null;
  modality?: string;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
  isModerated?: boolean;
  recommended?: boolean;
  subscription?: {
    prefix: string;
    plan: string;
    command: string;
  };
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
 * Full model document from Firebase `?search=...` or `?provider=...`.
 * Matches `ModelDoc` in firebase/functions/src/schema.ts.
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
const RECOMMENDED_CACHE_MAX_AGE_HOURS = 12;
const RECOMMENDED_FETCH_TIMEOUT_MS = 5000;
const SEARCH_FETCH_TIMEOUT_MS = 10000;

/**
 * Absolute path to the bundled recommended-models.json fallback.
 * Used as the last-resort source when Firebase and disk cache are unavailable.
 */
export function getBundledRecommendedModelsPath(): string {
  return join(__dirname, "../recommended-models.json");
}

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
  "x-ai": "xai",
  "z-ai": "zai",
  moonshotai: "kimi",
  minimax: "minimax",
  qwen: "qwen",
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
 */
export function groupRecommendedModels(
  entries: RecommendedModelEntry[]
): { flagship: RecommendedModelGroup[]; fast: RecommendedModelGroup[] } {
  const byId = new Map<string, RecommendedModelEntry[]>();
  for (const entry of entries) {
    const list = byId.get(entry.id);
    if (list) list.push(entry);
    else byId.set(entry.id, [entry]);
  }

  const flagship: RecommendedModelGroup[] = [];
  const fast: RecommendedModelGroup[] = [];

  for (const [id, members] of byId.entries()) {
    const primary =
      members.find((m) => m.category !== "subscription") ?? members[0];
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
  for (const sub of group.subscriptions) {
    const p = sub.subscription?.prefix;
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** Parse "$1.32/1M" → 1.32, "FREE" → 0, "N/A"/"varies"/undefined → Infinity */
export function parsePriceAvg(s?: string): number {
  if (!s || s === "N/A") return Infinity;
  if (s === "FREE") return 0;
  const m = s.match(/\$([\d.]+)/);
  return m ? parseFloat(m[1]) : Infinity;
}

/** Parse "196K" → 196000, "1M" → 1000000, "1048K" → 1048000 */
export function parseCtx(s?: string): number {
  if (!s || s === "N/A") return 0;
  const upper = s.toUpperCase();
  if (upper.includes("M")) return parseFloat(upper) * 1_000_000;
  if (upper.includes("K")) return parseFloat(upper) * 1_000;
  return parseInt(s, 10) || 0;
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
      return p > 0 && p !== Infinity;
    })
    .sort(
      (a, b) =>
        parsePriceAvg(a.pricing?.average) - parsePriceAvg(b.pricing?.average)
    );
  const budget = priced[0] ?? null;

  // Large context: max parseCtx
  const byCtx = [...primaries].sort(
    (a, b) => parseCtx(b.context) - parseCtx(a.context)
  );
  const largeContext = byCtx[0] ?? null;

  // Most capable: priciest
  const byPrice = [...primaries].sort(
    (a, b) =>
      parsePriceAvg(b.pricing?.average) - parsePriceAvg(a.pricing?.average)
  );
  const mostCapable = byPrice.find((m) => parsePriceAvg(m.pricing?.average) !== Infinity) ?? null;

  // Vision + code: first with vision, excluding budget/priciest
  const visionCoding =
    primaries.find(
      (m) =>
        m.supportsVision === true &&
        m.id !== budget?.id &&
        m.id !== mostCapable?.id
    ) ?? null;

  // Agentic: first with reasoning, excluding priciest
  const agentic =
    primaries.find(
      (m) => m.supportsReasoning === true && m.id !== mostCapable?.id
    ) ?? null;

  return { budget, largeContext, mostCapable, visionCoding, agentic };
}

// ─── Recommended models loader ───────────────────────────────────────────────

/**
 * Load the recommended models doc asynchronously, with Firebase as the primary source.
 *
 * Resolution order:
 *   1. In-memory cache (unless forceRefresh)
 *   2. Disk cache at RECOMMENDED_MODELS_CACHE_PATH if <12h old (unless forceRefresh)
 *   3. Firebase ?catalog=recommended (writes disk cache on success)
 *   4. Bundled recommended-models.json fallback
 *
 * Throws only when all four tiers fail.
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
    // Silent — fall through to bundled fallback
  }

  // Tier 4: bundled fallback
  return loadBundledRecommendedModels();
}

/**
 * Synchronous accessor for the recommended models doc.
 *
 * Tiers (no network):
 *   1. In-memory cache
 *   2. Disk cache (no freshness check — best-effort)
 *   3. Bundled recommended-models.json
 *
 * Throws only if every source fails.
 */
export function getRecommendedModelsSync(): RecommendedModelsDoc {
  if (_cachedRecommendedModels) return _cachedRecommendedModels;

  if (existsSync(RECOMMENDED_MODELS_CACHE_PATH)) {
    try {
      const cacheData = JSON.parse(
        readFileSync(RECOMMENDED_MODELS_CACHE_PATH, "utf-8")
      ) as RecommendedModelsDoc;
      if (cacheData.models && cacheData.models.length > 0) {
        _cachedRecommendedModels = cacheData;
        return cacheData;
      }
    } catch {
      // Fall through to bundled
    }
  }

  return loadBundledRecommendedModels();
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
  return ageHours <= RECOMMENDED_CACHE_MAX_AGE_HOURS;
}

function loadBundledRecommendedModels(): RecommendedModelsDoc {
  const jsonPath = getBundledRecommendedModelsPath();
  if (!existsSync(jsonPath)) {
    throw new Error(
      `recommended-models.json not found at ${jsonPath}. ` +
        `Run 'claudish --top-models --force-update' to refresh from Firebase.`
    );
  }
  try {
    const doc = JSON.parse(readFileSync(jsonPath, "utf-8")) as RecommendedModelsDoc;
    _cachedRecommendedModels = doc;
    return doc;
  } catch (error) {
    throw new Error(`Failed to parse bundled recommended-models.json: ${error}`);
  }
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
    throw new Error(
      `Firebase provider search returned ${response.status} ${response.statusText}`
    );
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
 * fresh on every `--list-models` call; response is small (~50KB) so no disk
 * cache is maintained.
 */
export async function getTop100Models(): Promise<Top100Response> {
  const url = `${FIREBASE_BASE_URL}?catalog=top100`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(SEARCH_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Firebase top100 fetch failed: ${response.status} ${response.statusText}`
    );
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
 * Powers the CLI `--list-providers` command.
 */
export async function getProviderList(): Promise<ProviderListEntry[]> {
  const url = `${FIREBASE_BASE_URL}?catalog=providers`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(SEARCH_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Firebase providers fetch failed: ${response.status} ${response.statusText}`,
    );
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

// ─── LiteLLM model fetch (unchanged — not OpenRouter) ────────────────────────

/**
 * LiteLLM model structure from /public/model_hub API
 */
interface LiteLLMModel {
  model_group: string;
  providers: string[];
  max_input_tokens?: number;
  max_output_tokens?: number;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  supports_vision?: boolean;
  supports_reasoning?: boolean;
  supports_function_calling?: boolean;
  mode?: string;
}

interface LiteLLMCache {
  timestamp: string;
  models: any[];
}

const LITELLM_CACHE_MAX_AGE_HOURS = 24;

/**
 * Fetch models from LiteLLM instance with caching.
 */
export async function fetchLiteLLMModels(
  baseUrl: string,
  apiKey: string,
  forceUpdate = false
): Promise<any[]> {
  const hash = createHash("sha256").update(baseUrl).digest("hex").substring(0, 16);
  const cacheDir = join(homedir(), ".claudish");
  const cachePath = join(cacheDir, `litellm-models-${hash}.json`);

  if (!forceUpdate && existsSync(cachePath)) {
    try {
      const cacheData: LiteLLMCache = JSON.parse(readFileSync(cachePath, "utf-8"));
      const timestamp = new Date(cacheData.timestamp);
      const now = new Date();
      const ageInHours = (now.getTime() - timestamp.getTime()) / (1000 * 60 * 60);

      if (ageInHours < LITELLM_CACHE_MAX_AGE_HOURS) {
        return cacheData.models;
      }
    } catch {
      // Cache read error, will fetch fresh data
    }
  }

  try {
    const url = `${baseUrl.replace(/\/$/, "")}/model_group/info`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      console.error(`Failed to fetch LiteLLM models: ${response.status} ${response.statusText}`);
      if (existsSync(cachePath)) {
        try {
          const cacheData: LiteLLMCache = JSON.parse(readFileSync(cachePath, "utf-8"));
          return cacheData.models;
        } catch {
          return [];
        }
      }
      return [];
    }

    const responseData = (await response.json()) as { data?: LiteLLMModel[] } | LiteLLMModel[];
    const rawModels: LiteLLMModel[] = Array.isArray(responseData)
      ? responseData
      : responseData.data || [];

    const transformedModels = rawModels
      .filter((m) => m.mode === "chat" && m.supports_function_calling)
      .map((m) => {
        const inputCostPerM = (m.input_cost_per_token || 0) * 1_000_000;
        const outputCostPerM = (m.output_cost_per_token || 0) * 1_000_000;
        const avgCost = (inputCostPerM + outputCostPerM) / 2;
        const isFree = inputCostPerM === 0 && outputCostPerM === 0;

        const contextLength = m.max_input_tokens || 128000;
        const contextStr =
          contextLength >= 1000000
            ? `${Math.round(contextLength / 1000000)}M`
            : `${Math.round(contextLength / 1000)}K`;

        return {
          id: `litellm@${m.model_group}`,
          name: m.model_group,
          description: `LiteLLM model (providers: ${m.providers.join(", ")})`,
          provider: "LiteLLM",
          pricing: {
            input: isFree ? "FREE" : `$${inputCostPerM.toFixed(2)}`,
            output: isFree ? "FREE" : `$${outputCostPerM.toFixed(2)}`,
            average: isFree ? "FREE" : `$${avgCost.toFixed(2)}/1M`,
          },
          context: contextStr,
          contextLength,
          supportsTools: m.supports_function_calling || false,
          supportsReasoning: m.supports_reasoning || false,
          supportsVision: m.supports_vision || false,
          isFree,
          source: "LiteLLM" as const,
        };
      });

    mkdirSync(cacheDir, { recursive: true });
    const cacheData: LiteLLMCache = {
      timestamp: new Date().toISOString(),
      models: transformedModels,
    };
    writeFileSync(cachePath, JSON.stringify(cacheData, null, 2), "utf-8");

    return transformedModels;
  } catch (error) {
    console.error(`Failed to fetch LiteLLM models: ${error}`);
    if (existsSync(cachePath)) {
      try {
        const cacheData: LiteLLMCache = JSON.parse(readFileSync(cachePath, "utf-8"));
        return cacheData.models;
      } catch {
        return [];
      }
    }
    return [];
  }
}
