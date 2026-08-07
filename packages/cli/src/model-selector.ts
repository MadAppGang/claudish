/**
 * Model Selector with Fuzzy Search
 *
 * Two-step interactive picker over the Firebase-backed `CatalogClient`:
 *   1. Pick a provider (filtered by `isProviderAvailable()`).
 *   2. Pick a model — either:
 *      - cross-vendor `catalog.searchModels()` (when "All providers" is chosen),
 *      - vendor-scoped `catalog.modelsByVendor()` (when a specific provider is chosen),
 *      - or a free-text input (when the provider is local / user-deployed).
 *
 * Pure helpers (`pickerProviderToFirebaseSlug`, `isUserDeployedProvider`,
 * `buildExplicitModelSpec`) are exported for unit tests; the inquirer-driven
 * flow is exercised end-to-end via the headless tmux smoke run.
 */

import { confirm, input, search, select } from "@inquirer/prompts";
import { lookupModel, lookupModelCapabilities } from "./adapters/model-catalog.js";
import { credentials } from "./auth/credentials/authority.js";
import { isSubscriptionProvider } from "./handlers/shared/remote-provider-types.js";
import {
  type AggregatorEntry,
  type ModelDoc,
  type RecommendedModelEntry,
  getRecommendedModels,
  getTop100Models,
} from "./model-loader.js";
import {
  type CatalogClient,
  type CatalogModel,
  createCatalogClient,
} from "./providers/model-catalog.js";
import {
  type DiscoveredModel,
  discoverProviderModels,
  rankDiscoveredModels,
  toRosterEntry,
} from "./providers/model-discovery.js";
import { compareByReleaseDateDesc } from "./providers/model-ordering.js";
import { collapseRoster } from "./providers/model-resolvers/registry.js";
import { type ModelOffer, offerIsLive } from "./providers/model-resolvers/types.js";
import { getDisplayName, getProviderByName } from "./providers/provider-definitions.js";
import { isChatCapable } from "./providers/transport/probe-discovery.js";

/**
 * Model data structure
 */
export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  provider: string;
  providerSlug?: string;
  releaseDate?: string;
  pricing?: {
    input: string;
    output: string;
    average: string;
  };
  context?: string;
  contextLength?: number;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
  isFree?: boolean;
  source?: string; // Which platform the model is from
  /**
   * Per-provider routing index: which providers serve this model and under
   * what externalId (vendor-prefixed where the provider requires it, e.g.
   * `openai/gpt-5` for OpenRouter). Preserved so the picker can render each
   * row as the exact callable spec for the selected provider.
   */
  aggregators?: AggregatorEntry[];
}

/**
 * Picker provider value → Firebase aggregator/owner slug.
 *
 * Picker values come from `ALL_PROVIDER_CHOICES.value` (e.g. "zen", "openai-codex");
 * Firebase aggregator/owner slugs come from `VendorRecord.vendor` /
 * `aggregators[].provider` in the slim catalog (e.g. "opencode-zen", "openai").
 *
 * Subscription endpoints (codex, kimi-coding, glm-coding, antigravity) reuse
 * the underlying owner's catalog because they serve the same models.
 *
 * Picker-local glue, intentionally not exported as a global concept.
 * Exported for unit tests only.
 */
export const pickerProviderToFirebaseSlug: Record<string, string> = {
  openrouter: "openrouter",
  google: "google",
  openai: "openai",
  // NOTE: kept deliberately, unlike antigravity/kimi-coding which now use
  // their own slug. The catalog carries an `openai-codex` aggregator for just
  // ONE of the six Responses-API models (gpt-5.6-sol), and /probeModels
  // contradicts it by recommending gpt-5.6-luna. Using the real slug today
  // would collapse the picker from OpenAI's full list to a single model on the
  // strength of known-incomplete data. Remove this once coverage lands — see
  // models-index TASK_model_behavior_metadata_gaps.md.
  "openai-codex": "openai",
  "x-ai": "x-ai",
  deepseek: "deepseek",
  minimax: "minimax",
  "minimax-coding": "minimax",
  kimi: "moonshotai",
  glm: "z-ai",
  "glm-coding": "z-ai",
  "z-ai": "z-ai",
  sakana: "sakana",
  "sakana-subscription": "sakana",
  zen: "opencode-zen",
  "opencode-zen": "opencode-zen",
  "opencode-zen-go": "opencode-zen-go",
  ollamacloud: "ollamacloud",
  // NOTE: "qwen-cloud" is deliberately absent. `selectModelFromProvider` tries
  // `modelDiscovery` BEFORE this map, and the plan's /compatible-mode/v1/models
  // endpoint is authenticated — it answers with exactly what the subscription
  // is entitled to. The catalog's "qwen" vendor would be a bad fall-through
  // anyway: it lists hyphenated aggregator names (qwen3-coder-next) that the
  // plan host does not serve. Adding it would also poison
  // `firebaseSlugToProviderName`, whose reverse lookup takes the FIRST picker
  // value for a slug — with no canonical `qwen` entry above it, every plain
  // catalog Qwen model would render as "Qwen Plan". Discovery failure
  // already degrades to the free-text prompt below, which is the right answer.
};

/**
 * Providers whose catalogs aren't in Firebase by design — picker shows a
 * neutral free-text input instead of a model list. Anything else falls
 * through to the Firebase-backed catalog client.
 */
const LOCAL_OR_USER_DEPLOYED = new Set<string>(["litellm", "ollama", "lmstudio"]);

/**
 * Pure predicate — exported for unit tests.
 */
export function isUserDeployedProvider(value: string): boolean {
  return LOCAL_OR_USER_DEPLOYED.has(value);
}

/**
 * Friendly display name for a Firebase provider slug. Routes through
 * `provider-definitions.ts` `getDisplayName()` after mapping Firebase
 * vendor slugs (e.g. "moonshotai") to the canonical claudish provider
 * name (e.g. "kimi"). For genuinely unknown slugs (e.g. "perplexity")
 * the canonical-name path falls back to a capitalized rendering of the
 * slug. (Note: "x-ai"/"z-ai" now match the catalog slug 1:1.)
 */
function firebaseSlugToProviderName(slug: string): string {
  const lower = slug.toLowerCase();
  // Reverse-lookup: pick the FIRST picker-value that maps to this slug.
  // Order matters — the more "canonical" entries (e.g. "x-ai" before
  // "openai-codex") sit higher in pickerProviderToFirebaseSlug.
  for (const [pickerValue, firebaseSlug] of Object.entries(pickerProviderToFirebaseSlug)) {
    if (firebaseSlug === lower) return pickerValue;
  }
  return lower;
}

function formatFirebaseProviderLabel(slug: string): string {
  if (!slug || slug === "unknown") return "Unknown";
  const canonical = firebaseSlugToProviderName(slug);
  // getDisplayName falls back to capitalized provider name when the slug isn't
  // a known builtin — that's acceptable polish for fringe vendors.
  const displayName = getDisplayName(canonical);
  // Prettify a few multi-segment slugs that aren't in provider-definitions.
  if (displayName === canonical && canonical.includes("-")) {
    return canonical
      .split("-")
      .map((part) => {
        if (part === "ai") return "AI";
        if (part.length <= 3) return part.toUpperCase();
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join(" ");
  }
  return displayName;
}

/**
 * Load recommended models from Firebase for the interactive picker.
 * Use the async loader so cold-start runs fetch the live catalog instead of
 * falling straight to the tiny bundled fallback.
 */
async function loadRecommendedModels(forceRefresh = false): Promise<ModelInfo[]> {
  try {
    const doc = await getRecommendedModels({ forceRefresh });
    // Newest-first, like every other picker list. This list is DISPLAYED as the
    // picker's catalog when the top-100 fetch fails (see `selectModel`), so it
    // must not fall back to raw doc order there.
    return sortModelsNewestFirst(
      doc.models.map((model: RecommendedModelEntry) => ({
        id: model.id,
        name: model.name,
        description: model.description,
        provider: formatFirebaseProviderLabel(model.provider),
        providerSlug: model.provider.toLowerCase(),
        pricing: model.pricing,
        context: model.context,
        contextLength: parseContextString(model.context),
        supportsTools: model.supportsTools,
        supportsReasoning: model.supportsReasoning,
        supportsVision: model.supportsVision,
        source: formatFirebaseProviderLabel(model.provider),
      }))
    );
  } catch {
    return [];
  }
}

/** Parse "196K" → 196000, "1M" → 1000000. */
function parseContextString(ctx?: string): number {
  if (!ctx || ctx === "N/A") return 0;
  const upper = ctx.toUpperCase();
  if (upper.endsWith("M")) return Number.parseFloat(upper) * 1_000_000;
  if (upper.endsWith("K")) return Number.parseFloat(upper) * 1000;
  const n = Number.parseInt(upper, 10);
  return Number.isNaN(n) ? 0 : n;
}

interface PickerProvider {
  slug: string;
  label: string;
  count: number;
}

function formatContextLength(ctx?: number): string {
  if (!ctx || ctx <= 0) return "N/A";
  if (ctx >= 1_000_000) return `${Math.round(ctx / 1_000_000)}M`;
  return `${Math.round(ctx / 1000)}K`;
}

function formatAveragePricing(pricing?: ModelDoc["pricing"]): ModelInfo["pricing"] | undefined {
  if (!pricing) return undefined;

  const input = pricing.input;
  const output = pricing.output;
  const inputStr =
    typeof input === "number" ? (input === 0 ? "FREE" : `$${input.toFixed(2)}`) : "N/A";
  const outputStr =
    typeof output === "number" ? (output === 0 ? "FREE" : `$${output.toFixed(2)}`) : "N/A";

  if (typeof input !== "number" && typeof output !== "number") {
    return {
      input: inputStr,
      output: outputStr,
      average: "N/A",
    };
  }

  const avg = ((input || 0) + (output || 0)) / 2;
  return {
    input: inputStr,
    output: outputStr,
    average: avg === 0 ? "FREE" : `$${avg.toFixed(2)}/1M`,
  };
}

/**
 * Flat-rate plans have no per-token rate to show. `SUB` is the label the rest
 * of the codebase already uses for that (see `getModelPricing`'s
 * `isSubscription` branch), so the picker reuses it verbatim.
 */
const SUBSCRIPTION_PRICING: ModelInfo["pricing"] = {
  input: "SUB",
  output: "SUB",
  average: "SUB",
};

/**
 * Context window for a live-discovered model row, from the two OFFLINE sources.
 *
 * The endpoint's own number wins whenever it reports one: it is answered for
 * THIS subscription, so it beats any catalog (Kimi Coding reports it; Qwen
 * Plan does not). On a miss, fall back to the Firebase slim catalog, which
 * already knows most of these models — that is a read of the local
 * `~/.claudish/all-models.json`, never a network call, so the picker never
 * blocks on it. Still-unknown stays 0 and renders as "N/A": there is no
 * per-model cloud lookup, because a window the slim catalog lacks is a
 * models-index gap, not something N extra round-trips can discover.
 */
function resolveDiscoveredContextLength(m: DiscoveredModel): number {
  if (typeof m.contextWindow === "number" && m.contextWindow > 0) return m.contextWindow;
  try {
    return lookupModel(m.id)?.contextWindow ?? 0;
  } catch {
    // lookupModel refuses provider-routed ids ("prov@model"). A discovered
    // wire id should never be one, but an unknown window is not worth throwing.
    return 0;
  }
}

/**
 * Release date for a live-discovered model row, catalog first.
 *
 * The Firebase slim catalog carries curated RELEASE dates, so it wins wherever
 * it has an entry. The endpoint's date is a roster-added timestamp, which is
 * the only signal available for the models the slim catalog never listed —
 * `qwen3.8-max-preview` is exactly that, and without the fallback one of the
 * newest models on the plan would sort to the very bottom as undated.
 */
function resolveDiscoveredReleaseDate(m: DiscoveredModel): string | undefined {
  try {
    const catalogDate = lookupModel(m.id)?.releaseDate;
    if (catalogDate) return catalogDate;
  } catch {
    // lookupModel refuses provider-routed ids; an unknown date is not fatal.
  }
  return m.releaseDate;
}

function modelDocToModelInfo(model: ModelDoc): ModelInfo {
  const providerLabel = formatFirebaseProviderLabel(model.provider || "unknown");
  const contextLength = model.contextWindow || 0;

  return {
    id: model.modelId,
    name: model.displayName || model.modelId,
    description: model.description || `${providerLabel} model`,
    provider: providerLabel,
    providerSlug: model.provider,
    releaseDate: model.releaseDate,
    pricing: formatAveragePricing(model.pricing),
    context: formatContextLength(contextLength),
    contextLength,
    supportsTools: model.capabilities?.tools,
    supportsReasoning: model.capabilities?.thinking,
    supportsVision: model.capabilities?.vision,
    source: providerLabel,
  };
}

function catalogModelToModelInfo(model: CatalogModel): ModelInfo {
  // Catalog models from the slim cache don't carry the owner provider — fall
  // back to the first aggregator's name so the picker still shows something
  // useful in the column.
  const ownerOrFirstAggregator = model.provider || model.aggregators?.[0]?.provider || "unknown";
  const providerLabel = formatFirebaseProviderLabel(ownerOrFirstAggregator);
  const contextLength = model.contextWindow || 0;

  return {
    id: model.modelId,
    name: model.displayName || model.modelId,
    description: model.description || `${providerLabel} model`,
    provider: providerLabel,
    providerSlug: ownerOrFirstAggregator,
    releaseDate: model.releaseDate,
    pricing: formatAveragePricing(model.pricing),
    context: formatContextLength(contextLength),
    contextLength,
    supportsTools: model.capabilities?.tools,
    supportsReasoning: model.capabilities?.thinking,
    supportsVision: model.capabilities?.vision,
    source: providerLabel,
    aggregators: model.aggregators,
  };
}

function dedupeModels(models: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  const deduped: ModelInfo[] = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    deduped.push(model);
  }
  return deduped;
}

/**
 * Re-exported from `providers/model-ordering.ts` so existing importers
 * (cli.ts) keep working. The comparator itself had to move out of this module:
 * `model-loader.ts` and `mcp-server.ts` both need it, and importing it from
 * here would create a `model-loader -> model-selector -> model-loader` cycle
 * (and drag the inquirer picker into the MCP stdio path).
 */
export { compareByReleaseDateDesc };

function sortModelsNewestFirst(models: ModelInfo[]): ModelInfo[] {
  return [...models].sort(compareByReleaseDateDesc);
}

/**
 * Get free models. Free model discovery used to come from OpenCode Zen
 * (via models.dev), which has been removed. Free models now live in the
 * Firebase recommended catalog; this stub returns [] so `selectModel` can
 * surface the "no free models available" UX when `--free` is used.
 */
async function getFreeModels(): Promise<ModelInfo[]> {
  return [];
}

/**
 * Format model for display in selector
 */
function formatModelChoice(model: ModelInfo, showSource = false): string {
  const caps = [
    model.supportsTools ? "T" : "",
    model.supportsReasoning ? "R" : "",
    model.supportsVision ? "V" : "",
  ]
    .filter(Boolean)
    .join("");

  const capsStr = caps ? ` [${caps}]` : "";
  const priceStr = model.pricing?.average || "N/A";
  const ctxStr = model.context || "N/A";
  // Show release date as a short year-month suffix when present so the
  // newest-first sort is visible to the user. Slim catalog dates are
  // ISO date strings (`2026-05-07`); take just the YYYY-MM prefix.
  const dateStr = model.releaseDate ? `, ${model.releaseDate.slice(0, 7)}` : "";

  if (showSource && model.source) {
    const sourceTagMap: Record<string, string> = {
      Zen: "Zen",
      OpenRouter: "OR",
      xAI: "xAI",
      Gemini: "Gem",
      OpenAI: "OAI",
      "OpenAI Codex": "CX",
      GLM: "GLM",
      "GLM Coding": "GC",
      MiniMax: "MM",
      "MiniMax Coding": "MMC",
      Kimi: "Kimi",
      "Kimi Coding": "KC",
      "Z.AI": "ZAI",
      OllamaCloud: "OC",
      LiteLLM: "LL",
    };
    const sourceTag = sourceTagMap[model.source] || model.source;
    return `${sourceTag} ${model.id} (${priceStr}, ${ctxStr}${capsStr}${dateStr})`;
  }

  return `${model.id} (${model.provider}, ${priceStr}, ${ctxStr}${capsStr}${dateStr})`;
}

/**
 * Format a per-provider picker row as the EXACT callable spec for the selected
 * provider, e.g. `zen@gpt-5` or `or@openai/gpt-5`. The spec shown is precisely
 * what the user could type as `--model`, using the provider's own externalId
 * (vendor-prefixed where that provider requires it).
 */
function formatModelChoiceAsSpec(model: ModelInfo, spec: string, priceStr: string): string {
  const caps = [
    model.supportsTools ? "T" : "",
    model.supportsReasoning ? "R" : "",
    model.supportsVision ? "V" : "",
  ]
    .filter(Boolean)
    .join("");
  const capsStr = caps ? ` [${caps}]` : "";
  const ctxStr = model.context || "N/A";
  const dateStr = model.releaseDate ? `, ${model.releaseDate.slice(0, 7)}` : "";
  return `${spec} (${priceStr}, ${ctxStr}${capsStr}${dateStr})`;
}

/**
 * Provider filter aliases for @prefix search syntax.
 * These map to actual configured runtime providers, not Firebase model vendors.
 */
const PROVIDER_FILTER_ALIASES: Record<string, string> = {
  openrouter: "openrouter",
  or: "openrouter",
  google: "google",
  gemini: "google",
  gem: "google",
  openai: "openai",
  oai: "openai",
  codex: "openai-codex",
  cx: "openai-codex",
  "x-ai": "x-ai",
  xai: "x-ai",
  grok: "x-ai",
  minimax: "minimax",
  mm: "minimax",
  "minimax-coding": "minimax-coding",
  mmc: "minimax-coding",
  kimi: "kimi",
  moon: "kimi",
  moonshot: "kimi",
  "kimi-coding": "kimi-coding",
  kc: "kimi-coding",
  glm: "glm",
  "glm-coding": "glm-coding",
  gc: "glm-coding",
  "z-ai": "z-ai",
  zai: "z-ai",
  zen: "zen",
  ollamacloud: "ollamacloud",
  oc: "ollamacloud",
  litellm: "litellm",
  ll: "litellm",
  deepseek: "deepseek",
  mistralai: "mistralai",
  mistral: "mistralai",
  sakana: "sakana",
  fugu: "sakana",
  "sakana-subscription": "sakana-subscription",
  sc: "sakana-subscription",
  "qwen-cloud": "qwen-cloud",
  qc: "qwen-cloud",
};

/**
 * Parse search term for @provider filter prefix
 * Returns { provider: source string or null, searchTerm: remaining text }
 */
function parseProviderFilter(
  term: string,
  providers: PickerProvider[] = []
): { provider: string | null; searchTerm: string } {
  if (!term.startsWith("@")) {
    return { provider: null, searchTerm: term };
  }

  const withoutAt = term.slice(1);
  const spaceIdx = withoutAt.indexOf(" ");

  let prefix: string;
  let rest: string;
  if (spaceIdx === -1) {
    prefix = withoutAt;
    rest = "";
  } else {
    prefix = withoutAt.slice(0, spaceIdx);
    rest = withoutAt.slice(spaceIdx + 1).trim();
  }

  const source = PROVIDER_FILTER_ALIASES[prefix.toLowerCase()];
  if (source) {
    return { provider: source, searchTerm: rest };
  }

  const exactMatch = providers.find(
    (provider) =>
      provider.slug === prefix.toLowerCase() ||
      provider.label.toLowerCase() === prefix.toLowerCase()
  );
  if (exactMatch) {
    return { provider: exactMatch.slug, searchTerm: rest };
  }

  const partialMatch = Object.entries(PROVIDER_FILTER_ALIASES).find(([alias]) =>
    alias.startsWith(prefix.toLowerCase())
  );
  if (partialMatch) {
    return { provider: partialMatch[1], searchTerm: rest };
  }

  const partialProvider = providers.find(
    (provider) =>
      provider.slug.startsWith(prefix.toLowerCase()) ||
      provider.label.toLowerCase().startsWith(prefix.toLowerCase())
  );
  if (partialProvider) {
    return { provider: partialProvider.slug, searchTerm: rest };
  }

  return { provider: null, searchTerm: term };
}

export interface ModelSelectorOptions {
  freeOnly?: boolean;
  recommended?: boolean;
  message?: string;
  forceUpdate?: boolean;
}

/**
 * Resolve the picker's model list for a given provider/search-term combination.
 * Pulled out of `selectModel` to keep that function below the cognitive-complexity
 * limit; the three branches map directly to the picker's three flows.
 */
async function fetchPickerModels(
  providerSlug: string | null,
  searchTerm: string,
  defaultModels: ModelInfo[],
  catalog: CatalogClient
): Promise<ModelInfo[]> {
  if (providerSlug) {
    // Fall back to the provider's OWN slug. `modelsByVendor` derives its
    // aggregator set from the catalog, so any provider the backend serves
    // resolves without needing an entry in the map below.
    const firebaseSlug = pickerProviderToFirebaseSlug[providerSlug] ?? providerSlug;
    const vendorModels = await catalog.modelsByVendor(firebaseSlug);
    const infos = sortModelsNewestFirst(dedupeModels(vendorModels.map(catalogModelToModelInfo)));
    if (!searchTerm) return infos;
    const needle = searchTerm.toLowerCase();
    return infos.filter((m) => m.id.toLowerCase().includes(needle));
  }

  if (searchTerm) {
    const found = await catalog.searchModels(searchTerm, 100);
    return sortModelsNewestFirst(dedupeModels(found.map(catalogModelToModelInfo)));
  }

  return defaultModels;
}

/**
 * Select a model interactively with fuzzy search
 */
export async function selectModel(options: ModelSelectorOptions = {}): Promise<string> {
  const { freeOnly = false, recommended = true, message, forceUpdate = false } = options;
  const catalog = createCatalogClient();

  let models: ModelInfo[];
  let recommendedModels: ModelInfo[] = [];
  let pickerProviders: PickerProvider[] = [];
  const remoteQueryCache = new Map<string, Promise<ModelInfo[]>>();

  if (freeOnly) {
    models = await getFreeModels();
    if (models.length === 0) {
      throw new Error("No free models available");
    }
  } else {
    const [top100Result, recommendedResult] = await Promise.allSettled([
      getTop100Models(),
      recommended ? loadRecommendedModels(forceUpdate) : Promise.resolve([]),
    ]);

    const topModels =
      top100Result.status === "fulfilled"
        ? sortModelsNewestFirst(dedupeModels(top100Result.value.models.map(modelDocToModelInfo)))
        : [];
    recommendedModels = recommendedResult.status === "fulfilled" ? recommendedResult.value : [];

    models = topModels.length > 0 ? topModels : recommendedModels;

    pickerProviders = toPickerProviders(await getInteractiveProviderChoices());
  }

  const loadRemoteModels = async (
    providerSlug: string | null,
    searchTerm: string
  ): Promise<ModelInfo[]> => {
    const cacheKey = `${providerSlug || "__all__"}::${searchTerm}`;
    const cached = remoteQueryCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const request = (async () => {
      if (freeOnly) return [];
      try {
        return await fetchPickerModels(providerSlug, searchTerm, models, catalog);
      } catch {
        return [];
      }
    })();

    remoteQueryCache.set(cacheKey, request);
    return request;
  };

  const ac = new AbortController();
  const onData = (data: Buffer) => {
    if (data.length === 1 && data[0] === 0x1b) ac.abort();
  };
  process.stdin.on("data", onData);
  const cleanupKeypress = () => process.stdin.removeListener("data", onData);

  try {
    if (!freeOnly && !message && pickerProviders.length > 1) {
      const interactiveProviderChoices = await getInteractiveProviderChoices();
      const providerChoices = [
        {
          name: "All providers",
          value: "__all__",
          description: "Search across all configured providers",
        },
        ...interactiveProviderChoices,
      ];

      const selectedProvider = await select(
        {
          message: "Select provider:",
          choices: providerChoices,
        },
        { signal: ac.signal }
      );

      if (selectedProvider === "custom") {
        const customModel = await input({
          message: "Enter model (e.g., provider@model):",
          validate: (v) => (v.trim() ? true : "Model cannot be empty"),
        });
        return customModel.trim();
      }

      if (selectedProvider !== "__all__") {
        return await selectModelFromProvider(
          selectedProvider,
          "interactive session",
          recommendedModels,
          forceUpdate,
          catalog
        );
      }
    }

    const promptMessage =
      message || (freeOnly ? "Select a FREE model:" : "Select a model (live search):");

    const selected = await search<string>(
      {
        message: promptMessage,
        pageSize: 20,
        source: async (term) => {
          const normalizedTerm = term?.trim() || "";
          const { provider: filterProvider, searchTerm } = parseProviderFilter(
            normalizedTerm,
            pickerProviders
          );
          const effectiveProvider = filterProvider;
          const remoteModels = await loadRemoteModels(effectiveProvider, searchTerm);

          return remoteModels.slice(0, 100).map((model) => ({
            name: formatModelChoice(model, true),
            value: effectiveProvider
              ? buildExplicitModelSpec(effectiveProvider, model.id)
              : model.id,
            description: model.description?.slice(0, 160),
          }));
        },
      },
      { signal: ac.signal }
    );

    return selected;
  } catch (err: unknown) {
    if (
      ac.signal.aborted ||
      (err && typeof err === "object" && "name" in err && err.name === "AbortError")
    ) {
      console.log("");
      process.exit(0);
    }
    throw err;
  } finally {
    cleanupKeypress();
  }
}

/**
 * Provider choices for profile model configuration.
 *
 * Each entry maps to a ProviderDefinition via `provider` field.
 * Availability is checked via isProviderAvailable() — no more ad-hoc envVar checks.
 */
const ALL_PROVIDER_CHOICES: Array<{
  name: string;
  value: string;
  description: string;
  provider?: string; // ProviderDefinition.name — if set, availability is checked
}> = [
  {
    name: "Skip (keep Claude default)",
    value: "skip",
    description: "Use native Claude model for this tier",
  },
  {
    name: "OpenRouter",
    value: "openrouter",
    description: "580+ models via unified API",
    provider: "openrouter",
  },
  {
    name: "OpenCode Zen",
    value: "zen",
    description: "Free models, no API key needed",
    provider: "opencode-zen",
  },
  { name: "Google Gemini", value: "google", description: "Direct API", provider: "google" },
  { name: "OpenAI", value: "openai", description: "Direct API", provider: "openai" },
  {
    name: "OpenAI Codex",
    value: "openai-codex",
    description: "ChatGPT Plus/Pro subscription (Responses API)",
    provider: "openai-codex",
  },
  { name: "xAI / Grok", value: "x-ai", description: "Direct API", provider: "x-ai" },
  { name: "DeepSeek", value: "deepseek", description: "Direct API", provider: "deepseek" },
  { name: "Mistral", value: "mistralai", description: "Direct API", provider: "mistralai" },
  { name: "Sakana Fugu", value: "sakana", description: "Direct API", provider: "sakana" },
  {
    name: "Sakana Fugu Subscription",
    value: "sakana-subscription",
    description: "Subscription plan",
    provider: "sakana-subscription",
  },
  { name: "MiniMax", value: "minimax", description: "Direct API", provider: "minimax" },
  {
    name: "MiniMax Coding",
    value: "minimax-coding",
    description: "Coding subscription",
    provider: "minimax-coding",
  },
  { name: "Kimi / Moonshot", value: "kimi", description: "Direct API", provider: "kimi" },
  {
    name: "Kimi Coding",
    value: "kimi-coding",
    description: "Coding subscription",
    provider: "kimi-coding",
  },
  {
    name: "Qwen Plan",
    value: "qwen-cloud",
    description: "Alibaba Model Studio subscription",
    provider: "qwen-cloud",
  },
  { name: "GLM / Zhipu", value: "glm", description: "Direct API", provider: "glm" },
  {
    name: "GLM Coding Plan",
    value: "glm-coding",
    description: "Coding subscription",
    provider: "glm-coding",
  },
  { name: "Z.AI", value: "z-ai", description: "Direct API", provider: "z-ai" },
  {
    name: "OllamaCloud",
    value: "ollamacloud",
    description: "Cloud models",
    provider: "ollamacloud",
  },
  { name: "LiteLLM", value: "litellm", description: "Configured proxy", provider: "litellm" },
  {
    name: "Ollama (local)",
    value: "ollama",
    description: "Local Ollama instance",
    provider: "ollama",
  },
  {
    name: "LM Studio (local)",
    value: "lmstudio",
    description: "Local LM Studio instance",
    provider: "lmstudio",
  },
  {
    name: "Enter custom model",
    value: "custom",
    description: "Type a provider@model specification",
  },
];

/**
 * Get provider choices filtered by provider availability.
 *
 * Availability is resolved ON DEMAND through the credential authority — the
 * single source of truth. Because the authority resolves env → config →
 * oauth-file → 1Password (lazy SDK) per provider, op:// glob-backed providers
 * show up here WITHOUT any pre-hydration step: there is no longer a "before/after
 * hydration" window that hid them. Resolution is concurrent (each call funnels
 * through the SDK serialization queue internally).
 */
async function getProviderChoices() {
  const checks = await Promise.all(
    ALL_PROVIDER_CHOICES.map(async (choice) => {
      if (!choice.provider) return true; // skip, custom — always shown
      // The authority knows every catalog provider; isAvailable resolves the
      // full env/config/oauth/op:// readiness for that provider name.
      return credentials.isAvailable(choice.provider);
    })
  );
  return ALL_PROVIDER_CHOICES.filter((_, i) => checks[i]);
}

/**
 * Model ID prefix for each provider. This is the prefix that gets prepended to
 * the user-selected model name to produce the final `provider@model` spec
 * handed back to claudish — a separate concern from the Firebase slug map
 * above.
 */
const PROVIDER_MODEL_PREFIX: Record<string, string> = {
  google: "google@",
  // Antigravity maps to the google owner catalog, so the picker renders model
  // rows for it — it needs its own prefix or rows would emit a bare id that
  // doesn't route to the Antigravity backend.
  antigravity: "ag@",
  openai: "oai@",
  "openai-codex": "cx@",
  "x-ai": "x-ai@",
  deepseek: "ds@",
  mistralai: "mistral@",
  sakana: "sakana@",
  "sakana-subscription": "sc@",
  minimax: "mm@",
  kimi: "kimi@",
  "minimax-coding": "mmc@",
  "kimi-coding": "kc@",
  "qwen-cloud": "qc@",
  glm: "glm@",
  "glm-coding": "gc@",
  "z-ai": "z-ai@",
  ollamacloud: "oc@",
  ollama: "ollama@",
  lmstudio: "lmstudio@",
  zen: "zen@",
  openrouter: "openrouter@",
};

async function getInteractiveProviderChoices() {
  return (await getProviderChoices()).filter((choice) => choice.value !== "skip");
}

function toPickerProviders(choices: Array<{ name: string; value: string }>): PickerProvider[] {
  return choices.map((choice) => ({
    slug: choice.value,
    label: choice.name,
    count: 0,
  }));
}

/**
 * Build the final model spec returned to claudish, e.g. "zen@gpt-5".
 * Pure function — exported for unit tests.
 */
export function buildExplicitModelSpec(provider: string, modelId: string): string {
  const prefix = PROVIDER_MODEL_PREFIX[provider];
  if (!prefix) {
    return modelId;
  }
  return modelId.startsWith(prefix) ? modelId : `${prefix}${modelId}`;
}

/**
 * The external/vendor id a model is called by under the SELECTED provider.
 *
 * Aggregators carry a per-provider `externalId` in `aggregators[]` — e.g.
 * gpt-5 is `gpt-5` under OpenAI but `openai/gpt-5` under OpenRouter. We render
 * each picker row as the exact spec the user could type for the chosen
 * provider, so we pick the externalId whose `provider` matches the selected
 * provider's Firebase slug, falling back to the bare model id when there's no
 * aggregator entry (owner-path providers, or a model that lists no aggregator
 * for this provider — its bare id is already the callable id).
 *
 * Exported for unit tests.
 */
export function resolveProviderExternalId(provider: string, model: ModelInfo): string {
  const match = resolveProviderAggregatorEntry(provider, model);
  if (match?.externalId) return match.externalId;
  return model.id;
}

/**
 * The aggregators[] entry that serves this model under the SELECTED provider
 * (matched by the provider's Firebase slug), or undefined when none matches.
 * Shared by externalId resolution and per-aggregator price resolution.
 */
function resolveProviderAggregatorEntry(
  provider: string,
  model: ModelInfo
): AggregatorEntry | undefined {
  // Same fallback as the two modelsByVendor call sites: a provider absent from
  // the alias map uses its OWN slug, which is what `aggregators[].provider`
  // actually holds. Without this, removing an alias silently degrades the row
  // to the catalog id — `kc@kimi-k2.7-code` instead of the wire id
  // `kc@kimi-for-coding` — and drops the per-aggregator price with it.
  const firebaseSlug = pickerProviderToFirebaseSlug[provider] ?? provider;
  if (!model.aggregators) return undefined;
  return model.aggregators.find((a) => a.provider.toLowerCase() === firebaseSlug.toLowerCase());
}

/**
 * Display price for a picker row under the SELECTED provider.
 *
 * Prefers the TRUE per-aggregator rate (the matched aggregators[] entry's
 * `pricing`, the gateway's actual rate) over the owner/model-level price — an
 * aggregator like OpenRouter/OpenCode Zen can charge differently from the model
 * owner. Falls back to the model-level price (owner providers already carry it)
 * and finally "N/A". Exported for unit tests.
 */
export function resolveProviderDisplayPrice(provider: string, model: ModelInfo): string {
  const entry = resolveProviderAggregatorEntry(provider, model);
  const entryPrice = formatAveragePricing(entry?.pricing);
  if (entryPrice?.average) return entryPrice.average;
  return model.pricing?.average || "N/A";
}

/**
 * Resolve the human-readable provider name used in picker prompt copy.
 */
function getPickerDisplayName(providerValue: string): string {
  const choice = ALL_PROVIDER_CHOICES.find((c) => c.value === providerValue);
  if (choice) return choice.name;
  // Fall back to provider-definitions for runtime providers / custom endpoints.
  return getDisplayName(providerValue);
}

/**
 * Load models for a specific picker provider value via the CatalogClient.
 */
async function loadModelsForPickerProvider(
  providerValue: string,
  catalog: CatalogClient
): Promise<ModelInfo[]> {
  const firebaseSlug = pickerProviderToFirebaseSlug[providerValue] ?? providerValue;

  try {
    const vendorModels = await catalog.modelsByVendor(firebaseSlug);
    return sortModelsNewestFirst(dedupeModels(vendorModels.map(catalogModelToModelInfo)));
  } catch {
    return [];
  }
}

async function searchModelsForPickerProvider(
  providerValue: string,
  searchTerm: string,
  catalog: CatalogClient
): Promise<ModelInfo[]> {
  const all = await loadModelsForPickerProvider(providerValue, catalog);
  if (!searchTerm) return all;
  const needle = searchTerm.toLowerCase();
  return all.filter((m) => m.id.toLowerCase().includes(needle));
}

/**
 * Render a filterable picker over a STATIC in-memory model list (no catalog
 * client) and return the built model spec. Used for providers whose model list
 * comes from a local API rather than Firebase (e.g. Ollama's /api/tags).
 *
 * Returns `null` when the user picks the "Enter custom model ID" escape hatch,
 * so the caller can fall through to its free-text prompt.
 */
async function pickModelFromList(
  provider: string,
  displayName: string,
  tierName: string,
  models: ModelInfo[]
): Promise<string | null> {
  const CUSTOM_VALUE = "__custom_model__";

  const selected = await search<string>({
    message:
      tierName === "interactive session"
        ? `Select ${displayName} model (type to filter):`
        : `Select model for ${tierName} (type to filter):`,
    pageSize: 15,
    source: async (term) => {
      const needle = term?.toLowerCase() ?? "";
      const filtered = needle
        ? models.filter((m) => m.id.toLowerCase().includes(needle))
        : models.slice(0, 25);

      const choices = filtered.map((m) => {
        const externalId = resolveProviderExternalId(provider, m);
        const spec = buildExplicitModelSpec(provider, externalId);
        const priceStr = resolveProviderDisplayPrice(provider, m);
        return {
          name: formatModelChoiceAsSpec(m, spec, priceStr),
          value: spec,
          description: m.description?.slice(0, 80),
        };
      });

      choices.push({
        name: ">> Enter custom model ID",
        value: CUSTOM_VALUE,
        description: `Type a custom ${displayName} model name`,
      });

      return choices;
    },
  });

  return selected === CUSTOM_VALUE ? null : selected;
}

/**
 * Picker rows for a provider that lists its own models at runtime
 * (`modelDiscovery`), largest context window first.
 *
 * Two things the raw discovery result can't be rendered without:
 *
 *  - **Not everything served is chat.** Alibaba's plan host answers with image
 *    and TTS models alongside chat ones. Filtered with the SAME predicate the
 *    probe path uses, so the picker and `--probe` agree on what is chat-capable
 *    — a name-based rule, never a model-id skip list. An all-non-chat roster
 *    returns [] so the caller falls through to the catalog / free-text path
 *    instead of showing an empty list.
 *  - **Neither price nor (always) context is reported.** Context comes from the
 *    endpoint when it reports one, else the local slim catalog, else — only for
 *    the ids both missed, concurrently and on a short budget — the full cloud
 *    catalog. Price is `SUB` for a flat-rate plan; a per-token figure there
 *    would be misleading.
 *
 * Exported for unit tests.
 */
/**
 * A live offer as a short badge, or undefined when there is nothing to say.
 *
 * Evaluated against the clock on every render, never cached: two of the four
 * promos on the measured Devin roster expired within days of being observed,
 * and a stale "FREE" badge is a wrong-price bug — strictly worse than no badge.
 */
function describeOffer(offer: ModelOffer | undefined): string | undefined {
  if (!offerIsLive(offer) || offer?.kind !== "promo") return undefined;
  if (offer.expiresAt === undefined) return "FREE";
  const until = new Date(offer.expiresAt * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  return `FREE until ${until}`;
}

export async function buildDiscoveredModelRows(
  provider: string,
  displayName: string,
  catalog: CatalogClient
): Promise<ModelInfo[]> {
  const discovered = rankDiscoveredModels(await discoverProviderModels(provider)).filter((m) =>
    isChatCapable(m.id)
  );
  if (discovered.length === 0) return [];

  const subscription = isSubscriptionProvider(provider);
  const local = getProviderByName(provider)?.isLocal === true;
  // Neither a flat-rate plan nor a local daemon charges per token, and the
  // vendor catalog has nothing to say about either — Firebase does not list a
  // model someone pulled onto their own machine.
  const flatRate = subscription || local;
  // A per-token discovery provider should show the real rate; the live endpoint
  // doesn't report one and the slim catalog carries no prices, so ask the
  // vendor catalog. Skipped for flat-rate providers, which is every discovery
  // provider today, so nothing pays for this lookup.
  const pricingById = flatRate
    ? new Map<string, ModelInfo["pricing"]>()
    : new Map(
        (await loadModelsForPickerProvider(provider, catalog)).map((m) => [
          m.id.toLowerCase(),
          m.pricing,
        ])
      );

  // Fold variant explosions into the rows a human actually picks. Identity for
  // every provider without a resolver, so this is a no-op except for Devin,
  // where 167 served uids are ~39 real choices multiplied out by reasoning tier
  // and speed premium. The chosen id is always a real wire id, so it still
  // round-trips through buildExplicitModelSpec and argv unchanged.
  const choices = collapseRoster(provider, discovered.map(toRosterEntry));
  const discoveredById = new Map(discovered.map((m) => [m.id, m]));

  // The live endpoint decides WHICH models appear (entitlement) and overrides
  // the context window for THIS tier. Everything else — capabilities, release
  // date — comes from the catalog, which is the same for every user.
  //
  // There is deliberately no per-model cloud lookup for a missing window.
  // Re-querying the same cloud one id at a time returns the same answer N
  // round-trips later; a window the catalog lacks renders as unknown, which
  // keeps the gap visible as a models-index issue rather than hiding it.
  const rows = choices.map((c) => {
    const source = discoveredById.get(c.id);
    const contextLength = source ? resolveDiscoveredContextLength(source) : (c.contextWindow ?? 0);

    // Order: what it is · how big · what it costs · whether it is on offer.
    const parts = [c.displayName];
    if (contextLength) parts.push(`${Math.round(contextLength / 1024)}K context`);
    // A relative multiplier is only meaningful on a plan that bills in credits;
    // for a per-token provider the real rate is already in `pricing`.
    if (subscription && c.costFactor !== undefined) parts.push(`×${c.costFactor}`);
    const promo = describeOffer(c.offer);
    if (promo) parts.push(promo);

    return {
      id: c.id, // wire id — buildExplicitModelSpec adds the provider prefix
      name: c.displayName,
      description: parts.join(" · "),
      provider: displayName,
      releaseDate: source ? resolveDiscoveredReleaseDate(source) : undefined,
      pricing: subscription ? SUBSCRIPTION_PRICING : pricingById.get(c.id.toLowerCase()),
      context: formatContextLength(contextLength),
      contextLength,
      // Catalog-first, then whatever the endpoint reported, then `true`. The
      // endpoint step matters only for Ollama, whose locally-pulled models are
      // absent from the catalog and where tool support genuinely varies — an
      // embedding or vision-only pull cannot drive Claude Code. For everything
      // else the catalog answers and `true` remains the safer miss than hiding
      // a capable model.
      supportsTools: lookupModelCapabilities(c.id)?.supportsTools ?? source?.supportsTools ?? true,
      isFree: flatRate, // subscription or local — no per-token charge either way
      source: displayName,
    };
  });

  // Present newest-first, with the SAME comparator the catalog path uses, so
  // every picker in claudish orders identically. `rankDiscoveredModels` above
  // is only a stable, deterministic input order — its widest-window-first rule
  // is meaningful for probe candidates, but for a plan whose entire roster is
  // 1M it collapses to alphabetical, which is what made the picker look unsorted.
  return sortModelsNewestFirst(rows);
}

/**
 * Select a model from a specific provider with filterable search.
 * Rely on Firebase for model data via CatalogClient — no per-provider branching.
 */
async function selectModelFromProvider(
  provider: string,
  tierName: string,
  recommendedModels: ModelInfo[],
  _forceUpdate: boolean,
  catalog: CatalogClient
): Promise<string> {
  const prefix = PROVIDER_MODEL_PREFIX[provider] || `${provider}@`;
  const displayName = getPickerDisplayName(provider);

  // Subscription providers (e.g. Kimi Coding) serve a roster that only their
  // own authenticated endpoint knows — the owner's public catalog lists models
  // the subscription can't serve, and the per-tier context windows aren't in it
  // at all. Ask the endpoint, and offer exactly what this user's plan allows.
  const def = getProviderByName(provider);
  if (def?.modelDiscovery) {
    const discoveredModels = await buildDiscoveredModelRows(provider, displayName, catalog);
    if (discoveredModels.length > 0) {
      const picked = await pickModelFromList(provider, displayName, tierName, discoveredModels);
      if (picked) return picked;
      // picked === null → user chose the custom-entry hatch; fall through.
    }
    // Discovery unavailable / nothing chat-capable in the roster → fall through
    // to the cloud catalog rather than showing an empty list.
  }

  // Ollama and LM Studio used to be handled here, each its own way — Ollama by
  // an inline `/api/tags` branch, LM Studio not at all (free-text only). Both
  // now declare `modelDiscovery`, so the block above lists them like every
  // other provider that knows its own roster. A local daemon is not a different
  // KIND of thing; it is a provider whose endpoint happens to be on localhost.

  // Local / user-deployed providers: Firebase has no catalog, free-text only.
  // No prefix advertising — buildExplicitModelSpec adds it silently.
  if (isUserDeployedProvider(provider)) {
    const modelName = await input({
      message:
        tierName === "interactive session"
          ? `Enter ${displayName} model name:`
          : `Enter ${displayName} model name for ${tierName}:`,
      validate: (v) => (v.trim() ? true : "Model name cannot be empty"),
    });
    return `${prefix}${modelName.trim()}`;
  }

  const providerModels = await loadModelsForPickerProvider(provider, catalog);

  // No catalog data: graceful fall-through to text input (e.g. ollamacloud
  // when Firebase ingest hasn't covered it yet).
  if (providerModels.length === 0) {
    const modelName = await input({
      message:
        tierName === "interactive session"
          ? `Enter ${displayName} model name:`
          : `Enter ${displayName} model name for ${tierName}:`,
      validate: (v) => (v.trim() ? true : "Model name cannot be empty"),
    });
    return `${prefix}${modelName.trim()}`;
  }

  // Filterable list with a custom-entry escape hatch.
  const CUSTOM_VALUE = "__custom_model__";

  const selected = await search<string>({
    message:
      tierName === "interactive session"
        ? `Select ${displayName} model (type to filter):`
        : `Select model for ${tierName} (type to filter):`,
    pageSize: 15,
    source: async (term) => {
      let filtered: ModelInfo[];

      if (term) {
        try {
          filtered = await searchModelsForPickerProvider(provider, term, catalog);
        } catch {
          filtered = [];
        }
      } else {
        filtered = providerModels.slice(0, 25);
      }

      const choices = filtered.map((m) => {
        // Show + return the exact callable spec for the SELECTED provider,
        // using that provider's own externalId (vendor-prefixed where needed,
        // e.g. `or@openai/gpt-5`; bare for owner/aggregator providers that
        // accept bare ids, e.g. `zen@gpt-5`).
        const externalId = resolveProviderExternalId(provider, m);
        const spec = buildExplicitModelSpec(provider, externalId);
        const priceStr = resolveProviderDisplayPrice(provider, m);
        return {
          name: formatModelChoiceAsSpec(m, spec, priceStr),
          value: spec,
          description: m.description?.slice(0, 80),
        };
      });

      // Always show the custom-entry escape hatch.
      choices.push({
        name: ">> Enter custom model ID",
        value: CUSTOM_VALUE,
        description: `Type a custom ${displayName} model name`,
      });

      return choices;
    },
  });

  if (selected === CUSTOM_VALUE) {
    const modelName = await input({
      message: `Enter ${displayName} model name:`,
      validate: (v) => (v.trim() ? true : "Model name cannot be empty"),
    });
    return `${prefix}${modelName.trim()}`;
  }

  // recommendedModels currently unused at this stage (kept on the public flow
  // for future "highlight recommended models" UI); avoid an unused warning.
  void recommendedModels;
  return buildExplicitModelSpec(provider, selected);
}

/**
 * Select multiple models for profile setup
 * Interactive flow: provider selection -> filterable model list for each tier
 */
export async function selectModelsForProfile(): Promise<{
  opus?: string;
  sonnet?: string;
  haiku?: string;
  subagent?: string;
}> {
  console.log("\nLoading available models...");
  const catalog = createCatalogClient();
  const recommendedModels = await loadRecommendedModels();

  const tiers = [
    { key: "opus" as const, name: "Opus", description: "Most capable, used for complex reasoning" },
    { key: "sonnet" as const, name: "Sonnet", description: "Balanced, used for general tasks" },
    { key: "haiku" as const, name: "Haiku", description: "Fast & cheap, used for simple tasks" },
    { key: "subagent" as const, name: "Subagent", description: "Used for spawned sub-agents" },
  ];

  const result: { opus?: string; sonnet?: string; haiku?: string; subagent?: string } = {};
  let lastProvider: string | undefined;

  console.log("\nConfigure models for each Claude tier:");

  for (const tier of tiers) {
    console.log(""); // Spacing between tiers

    // Step 1: Select provider
    const provider = await select({
      message: `Select provider for ${tier.name} tier (${tier.description}):`,
      choices: await getProviderChoices(),
      default: lastProvider,
    });

    if (provider === "skip") {
      result[tier.key] = undefined;
      continue;
    }

    lastProvider = provider;

    if (provider === "custom") {
      const customModel = await input({
        message: `Enter custom model for ${tier.name} (e.g., provider@model):`,
        validate: (v) => (v.trim() ? true : "Model cannot be empty"),
      });
      result[tier.key] = customModel.trim();
      continue;
    }

    // Step 2: Select model from the chosen provider
    result[tier.key] = await selectModelFromProvider(
      provider,
      tier.name,
      recommendedModels,
      false,
      catalog
    );
  }

  return result;
}

/**
 * Prompt for API key
 */
export async function promptForApiKey(): Promise<string> {
  console.log("\nOpenRouter API Key Required");
  console.log("Get your free API key from: https://openrouter.ai/keys\n");

  const apiKey = await input({
    message: "Enter your OpenRouter API key:",
    validate: (value) => {
      if (!value.trim()) {
        return "API key cannot be empty";
      }
      if (!value.startsWith("sk-or-")) {
        return 'API key should start with "sk-or-"';
      }
      return true;
    },
  });

  return apiKey;
}

/**
 * Prompt for profile name
 */
export async function promptForProfileName(existing: string[] = []): Promise<string> {
  const name = await input({
    message: "Enter profile name:",
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return "Profile name cannot be empty";
      }
      if (!/^[a-z0-9-_]+$/i.test(trimmed)) {
        return "Profile name can only contain letters, numbers, hyphens, and underscores";
      }
      if (existing.includes(trimmed)) {
        return `Profile "${trimmed}" already exists`;
      }
      return true;
    },
  });

  return name.trim();
}

/**
 * Prompt for profile description
 */
export async function promptForProfileDescription(): Promise<string> {
  const description = await input({
    message: "Enter profile description (optional):",
  });

  return description.trim();
}

/**
 * Select from existing profiles
 */
export async function selectProfile(
  profiles: { name: string; description?: string; isDefault?: boolean }[]
): Promise<string> {
  const selected = await select({
    message: "Select a profile:",
    choices: profiles.map((p) => ({
      name: p.isDefault ? `${p.name} (default)` : p.name,
      value: p.name,
      description: p.description,
    })),
  });

  return selected;
}

/**
 * Confirm action
 */
export async function confirmAction(message: string): Promise<boolean> {
  return confirm({ message, default: false });
}
