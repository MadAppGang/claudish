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
import {
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
  getDisplayName,
  getProviderByName,
  isProviderAvailable,
} from "./providers/provider-definitions.js";
import { compareVersionPartsDesc, extractVersionParts } from "./model-version.js";

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
}

/**
 * Picker provider value → Firebase aggregator/owner slug.
 *
 * Picker values come from `ALL_PROVIDER_CHOICES.value` (e.g. "zen", "openai-codex");
 * Firebase aggregator/owner slugs come from `VendorRecord.vendor` /
 * `aggregators[].provider` in the slim catalog (e.g. "opencode-zen", "openai").
 *
 * Subscription endpoints (codex, kimi-coding, glm-coding, gemini-codeassist) reuse
 * the underlying owner's catalog because they serve the same models.
 *
 * Picker-local glue, intentionally not exported as a global concept.
 * Exported for unit tests only.
 */
export const pickerProviderToFirebaseSlug: Record<string, string> = {
  openrouter: "openrouter",
  google: "google",
  "gemini-codeassist": "google",
  openai: "openai",
  "openai-codex": "openai",
  xai: "x-ai",
  deepseek: "deepseek",
  minimax: "minimax",
  "minimax-coding": "minimax",
  kimi: "moonshotai",
  "kimi-coding": "moonshotai",
  glm: "z-ai",
  "glm-coding": "z-ai",
  zai: "z-ai",
  zen: "opencode-zen",
  "opencode-zen": "opencode-zen",
  "opencode-zen-go": "opencode-zen-go",
  ollamacloud: "ollamacloud",
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
 * vendor slugs (e.g. "x-ai", "moonshotai") to the canonical claudish
 * provider name (e.g. "xai", "kimi"). For genuinely unknown slugs
 * (e.g. "perplexity") the canonical-name path falls back to a
 * capitalized rendering of the slug.
 */
function firebaseSlugToProviderName(slug: string): string {
  const lower = slug.toLowerCase();
  // Reverse-lookup: pick the FIRST picker-value that maps to this slug.
  // Order matters — the more "canonical" entries (e.g. "xai" before
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
    return doc.models.map((model: RecommendedModelEntry) => ({
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
    }));
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
 * Compare two records by `releaseDate` (desc), then by version-parts in id
 * (desc), then by id (asc). Records without a `releaseDate` sort BEFORE
 * dated records — they default to epoch 0. Used by every list/picker that
 * shows models so the newest is always at the top.
 *
 * Exported so cli.ts can apply the same ordering to ModelDoc-shaped lists
 * (`--list-models`, `--top-models`, etc.) without duplicating the logic.
 */
export function compareByReleaseDateDesc(
  a: { releaseDate?: string; id?: string; modelId?: string },
  b: { releaseDate?: string; id?: string; modelId?: string }
): number {
  const aReleaseRaw = a.releaseDate ? Date.parse(a.releaseDate) : 0;
  const bReleaseRaw = b.releaseDate ? Date.parse(b.releaseDate) : 0;
  const aRelease = Number.isNaN(aReleaseRaw) ? 0 : aReleaseRaw;
  const bRelease = Number.isNaN(bReleaseRaw) ? 0 : bReleaseRaw;
  if (aRelease !== bRelease) {
    return bRelease - aRelease;
  }

  const aId = a.id ?? a.modelId ?? "";
  const bId = b.id ?? b.modelId ?? "";
  const versionCompare = compareVersionPartsDesc(
    extractVersionParts(aId),
    extractVersionParts(bId)
  );
  if (versionCompare !== 0) {
    return versionCompare;
  }
  return aId.localeCompare(bId);
}

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
  xai: "xai",
  grok: "xai",
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
  zai: "zai",
  zen: "zen",
  ollamacloud: "ollamacloud",
  oc: "ollamacloud",
  litellm: "litellm",
  ll: "litellm",
  deepseek: "deepseek",
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
    const firebaseSlug = pickerProviderToFirebaseSlug[providerSlug];
    if (!firebaseSlug) return [];
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

    pickerProviders = toPickerProviders(getInteractiveProviderChoices());
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
      const interactiveProviderChoices = getInteractiveProviderChoices();
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
  { name: "xAI / Grok", value: "xai", description: "Direct API", provider: "xai" },
  { name: "DeepSeek", value: "deepseek", description: "Direct API", provider: "deepseek" },
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
  { name: "GLM / Zhipu", value: "glm", description: "Direct API", provider: "glm" },
  {
    name: "GLM Coding Plan",
    value: "glm-coding",
    description: "Coding subscription",
    provider: "glm-coding",
  },
  { name: "Z.AI", value: "zai", description: "Direct API", provider: "zai" },
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
 * Uses isProviderAvailable() from ProviderDefinition — each provider validates
 * itself (API keys, OAuth credentials, local service, public fallback).
 */
function getProviderChoices() {
  return ALL_PROVIDER_CHOICES.filter((choice) => {
    if (!choice.provider) return true; // skip, custom — always shown
    const def = getProviderByName(choice.provider);
    return def ? isProviderAvailable(def) : true;
  });
}

/**
 * Model ID prefix for each provider. This is the prefix that gets prepended to
 * the user-selected model name to produce the final `provider@model` spec
 * handed back to claudish — a separate concern from the Firebase slug map
 * above.
 */
const PROVIDER_MODEL_PREFIX: Record<string, string> = {
  google: "google@",
  openai: "oai@",
  "openai-codex": "cx@",
  xai: "xai@",
  deepseek: "ds@",
  minimax: "mm@",
  kimi: "kimi@",
  "minimax-coding": "mmc@",
  "kimi-coding": "kc@",
  glm: "glm@",
  "glm-coding": "gc@",
  zai: "zai@",
  ollamacloud: "oc@",
  ollama: "ollama@",
  lmstudio: "lmstudio@",
  zen: "zen@",
  openrouter: "openrouter@",
};

function getInteractiveProviderChoices() {
  return getProviderChoices().filter((choice) => choice.value !== "skip");
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
  const firebaseSlug = pickerProviderToFirebaseSlug[providerValue];
  if (!firebaseSlug) return [];

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

      const choices = filtered.map((m) => ({
        name: formatModelChoice(m, true),
        value: buildExplicitModelSpec(provider, m.id),
        description: m.description?.slice(0, 80),
      }));

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
  fable?: string;
  subagent?: string;
}> {
  console.log("\nLoading available models...");
  const catalog = createCatalogClient();
  const recommendedModels = await loadRecommendedModels();

  const tiers = [
    { key: "opus" as const, name: "Opus", description: "Most capable, used for complex reasoning" },
    { key: "sonnet" as const, name: "Sonnet", description: "Balanced, used for general tasks" },
    { key: "haiku" as const, name: "Haiku", description: "Fast & cheap, used for simple tasks" },
    { key: "fable" as const, name: "Fable", description: "Fast frontier model for focused tasks" },
    { key: "subagent" as const, name: "Subagent", description: "Used for spawned sub-agents" },
  ];

  const result: {
    opus?: string;
    sonnet?: string;
    haiku?: string;
    fable?: string;
    subagent?: string;
  } = {};
  let lastProvider: string | undefined;

  console.log("\nConfigure models for each Claude tier:");

  for (const tier of tiers) {
    console.log(""); // Spacing between tiers

    // Step 1: Select provider
    const provider = await select({
      message: `Select provider for ${tier.name} tier (${tier.description}):`,
      choices: getProviderChoices(),
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
