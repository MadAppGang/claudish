import { catalogRouteMatchesProvider } from "./providers/catalog-route-bindings.js";
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
import { log } from "./logger.js";
import {
  type AggregatorEntry,
  type ModelDoc,
  type RecommendedModelEntry,
  type RecommendedModelsDoc,
  getRecommendedModels,
  getTop100Models,
  uniqueRecommendedModels,
} from "./model-loader.js";
import {
  type CatalogClient,
  type CatalogModel,
  createCatalogClient,
} from "./providers/model-catalog.js";
import {
  type DiscoveredModel,
  type DiscoveryFailure,
  type ModelsCatalogOutcome,
  describeDiscoveryFailure,
  discoverProviderModelsCatalog,
  getDiscoveryFailure,
  rankDiscoveredModels,
  toModelsCatalogEntry,
} from "./providers/model-discovery.js";
import { compareByReleaseDateDesc } from "./providers/model-ordering.js";
import { collapseModelsCatalog } from "./providers/model-resolvers/registry.js";
import { type ModelOffer, offerIsLive } from "./providers/model-resolvers/types.js";
import { PROVIDER_FILTER_ALIAS_EXTRA } from "./providers/picker-alias-extra.js";
import {
  type ProviderDefinition,
  getAllProviders,
  getDisplayName,
  getProviderByName,
} from "./providers/provider-definitions.js";
import { getRuntimeProviders } from "./providers/runtime-providers.js";
import { isChatCapable, isReportedChatCapable } from "./providers/transport/probe-discovery.js";
// STATIC, and safe: both are true leaves with ZERO imports of their own
// (`picker/import-direction.test.ts` asserts exactly that, by name). A static
// import of the picker ITSELF would pull a renderer into this module's graph and
// from there into the MCP stdio path — which is why `selectModelInteractive`
// reaches it by `await import()` instead.
import { canDrawTui } from "./tui/runtime/can-draw-tui.js";
import { NoTtyError, PickerCancelled } from "./tui/runtime/picker-cancelled.js";

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
 * Picker values are ProviderDefinition names (e.g. "opencode-zen", "openai-codex");
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
  meta: "meta",
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
  // NOTE: "qwen-token-plan" is deliberately absent. `selectModelFromProvider` tries
  // `modelDiscovery` BEFORE this map, and the plan's /compatible-mode/v1/models
  // endpoint is authenticated — it answers with exactly what the subscription
  // is entitled to. The catalog's "qwen" vendor would be a bad fall-through
  // anyway: it lists hyphenated aggregator names (qwen3-coder-next) that the
  // plan host does not serve. Adding it would also poison
  // `firebaseSlugToProviderName`, whose reverse lookup takes the FIRST picker
  // value for a slug — with no canonical `qwen` entry above it, every plain
  // catalog Qwen model would render as "Alibaba Token Plan". Discovery failure
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
 *
 * The hardcoded set above covers the BUILTINS with no Firebase catalog. Every
 * RUNTIME-registered provider — a user's `customEndpoints` entry, a bundled
 * catalog row — belongs in the same class and is recognised by derivation
 * rather than by being listed, because the whole point of those is that
 * claudish does not know their models.
 *
 * That is not just "no data": for a name that happens to match a models-index
 * VENDOR slug, `modelsByVendor` answers with ids from the CREATOR namespace,
 * and the picker would then emit `vendor@<models-index id>` — an id the
 * vendor's own endpoint is not guaranteed to accept. Failing after the user
 * commits is worse than asking them to type a model name, and R7 forbids
 * shipping a model list to check against.
 */
export function isUserDeployedProvider(value: string): boolean {
  return LOCAL_OR_USER_DEPLOYED.has(value) || getRuntimeProviders().has(value);
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
    return _recommendedFallbackRows(await getRecommendedModels({ forceRefresh }));
  } catch {
    return [];
  }
}

/**
 * The picker's recommended fallback list: one row per model id
 * (`uniqueRecommendedModels`; a model the backend lists in two recommendation
 * tiers is two doc rows but one picker row), then newest-first. Does not mutate
 * `doc`.
 */
export function _recommendedFallbackRows(doc: RecommendedModelsDoc): ModelInfo[] {
  // Newest-first, like every other picker list. This list is DISPLAYED as the
  // picker's catalog when the top-100 fetch fails (see `selectModel`), so it
  // must not fall back to raw doc order there.
  return sortModelsNewestFirst(
    uniqueRecommendedModels(doc.models).map((model: RecommendedModelEntry) => ({
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
      releaseDate: model.releaseDate,
      source: formatFirebaseProviderLabel(model.provider),
    }))
  );
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
 * `~/.claudish/cloud-models-catalog-v3.json`, never a network call, so the picker never
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
 * it has an entry. The endpoint's date is a date-added timestamp, which is
 * the only signal available for the models the slim catalog never listed —
 * `qwen3.8-max-preview` is exactly that, and without the fallback one of the
 * newest models on the plan would sort to the very bottom as undated.
 */
function resolveDiscoveredReleaseDate(m: DiscoveredModel): string | undefined {
  // A dynamic models catalog of variants the cloud models catalog does not list
  // gets NO catalog date: the catalog would be dating a different (older, base)
  // model, and a partially dated dynamic models catalog sorts its undated —
  // newest — half to the bottom.
  if (m.ignoreCatalogReleaseDate) return m.releaseDate;
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
  const ownerOrFirstAggregator =
    model.provider || model.aggregators?.[0]?.sourceProviderId || "unknown";
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
 * Collapse rows that would render as the SAME `provider@model` spec.
 *
 * `dedupeModels` keys on the catalog's `modelId`, which cannot see this: two
 * DIFFERENT catalog documents can carry the same `aggregators[].externalId` for
 * one provider. Live example — Antigravity serves `gemini-3.6-flash-high` from
 * both a variant-specific document and the canonical `gemini-3.6-flash` one, so
 * the picker listed `ag@gemini-3.6-flash-high` twice (likewise 3.5-flash-low
 * and 3.1-pro-high).
 *
 * Two rows that produce byte-identical argv are the same choice, so showing
 * both is a rendering defect regardless of why the catalog has two documents.
 * This is presentation only — it does not paper over the upstream data, which
 * is written up for models-index separately.
 *
 * Runs AFTER the newest-first sort so the survivor is deterministic rather than
 * whichever document the backend happened to return first.
 */
function dedupeByProviderSpec(provider: string, models: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  const deduped: ModelInfo[] = [];
  for (const model of models) {
    const spec = buildExplicitModelSpec(provider, resolveProviderExternalId(provider, model));
    if (seen.has(spec)) continue;
    seen.add(spec);
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
 * Catalog models → picker rows: drop what cannot serve a chat completion, then
 * dedupe, then order newest-first.
 *
 * **A chokepoint, not a site fix.** Pressing Enter twice at launch selected
 * `gpt-image-2.5-flare`, an image-generation model: `isChatCapable` was applied
 * inside `buildDiscoveredModelOutcome` and nowhere else, so every catalog path —
 * `searchModels`, `modelsByVendor`, the top-100 default list — applied no
 * capability filter at all. The same class of leak has been patched
 * twice before at the site where it was noticed (`probe-discovery.ts:498`, then
 * `pplx-embed`, then `bge`), and recurred each time, because a list is made in
 * more than one place. Every list either UI can render now returns through here.
 *
 * The rule is evidence, never a name: a row is kept only when the cloud models
 * catalog publishes it as a chat model — text among its inputs AND among its
 * outputs, with any other modalities alongside. A row the catalog does not
 * describe is `unknown` and dropped. `gemini-3.5-transcribe` (`in: ["audio"]`)
 * is out by its input list. `gpt-realtime-2` (`in: [audio,image,text]`,
 * `out: [audio,text]`) is IN, by decision: the name patterns that used to hide
 * the realtime family went with the name-based fallback, and a model that
 * accepts text and writes text is a chat model.
 *
 * What is left to watch is the catalog being WRONG, so a row that survives but
 * whose name reads like a generator family (seedance, flux, veo, imagen) is
 * named ONCE per process in the debug log. It decides nothing. Measured on
 * 2026-09-23, 3 of the 53 such rows publish `in: ["text"]`, `out: ["text"]`
 * (`flux-dev-finetuner`, `flux-fill`, `seedance-2.5-el`) — models-index rows
 * that need correcting, which is what this line is for.
 */
export function toPickerRows(models: ModelInfo[]): ModelInfo[] {
  const kept = sortModelsNewestFirst(dedupeModels(models.filter((m) => isChatCapable(m.id))));
  logModalityGapOnce(kept);
  return kept;
}

/** Generator families whose rows, if the catalog calls them chat, are worth a second look. */
const UNINFERABLE_NON_CHAT = [/\bseedance\b/i, /\bflux\b/i, /\bveo\b/i, /\bimagen\b/i];

let _modalityGapLogged = false;

/**
 * Say in the log which rows the catalog kept as chat although their family
 * generates images or video — a catalog row to check, not a filter to add here.
 *
 * ONCE per process: `toPickerRows` is the chokepoint for every list either UI
 * renders, so a per-call line would be dozens of identical lines per picker open.
 * It never writes to a terminal — `log()` goes to the debug file — because the
 * renderer owns the terminal while the picker is up.
 */
function logModalityGapOnce(kept: ModelInfo[]): void {
  if (_modalityGapLogged) return;
  const suspect = kept.filter((m) => UNINFERABLE_NON_CHAT.some((re) => re.test(m.id)));
  if (suspect.length === 0) return;
  _modalityGapLogged = true;
  log(
    `[Models] ${suspect.length} row(s) the catalog publishes as chat, from a generator family: ` +
      `${suspect
        .slice(0, 8)
        .map((m) => m.id)
        .join(", ")}. If one is not a chat model, its models-index row is wrong.`
  );
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

// `PROVIDER_FILTER_ALIAS_EXTRA` moved to `providers/picker-alias-extra.ts` so the
// predefined-endpoint collision check can consult it at run time without
// importing this module's prompt/catalog graph. Semantics are unchanged.

// Deliberately NOT cached. An earlier version memoized this and justified it by
// "runtime providers register at startup, before the picker opens" — true today,
// but it is an assumption about call order that nothing enforces, and the payoff
// is rebuilding ~30 map entries per keystroke. A stale alias table would drop a
// custom endpoint out of `@filter` with no visible symptom, which is a poor
// trade for microseconds.

/**
 * Provider filter aliases for `@prefix` search syntax.
 * These map to picker provider values (ProviderDefinition names), not Firebase
 * model vendors.
 *
 * Derived, because the hand-written version was the same opt-in table the
 * provider list used to be: `devin` and `antigravity` were both missing from
 * it, so `@dv` silently matched nothing.
 *
 * Rebuilt per call — see the note above on why it is not memoized.
 */
export function getProviderFilterAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  // Insertion order is PICKER_ORDER, and that is load-bearing: an ambiguous
  // partial like `@op` resolves by first match, so it should land on whatever
  // the user sees FIRST in the provider list (OpenRouter) rather than on
  // whichever definition happens to sit higher in the definitions file.
  for (const def of pickableProvidersInPickerOrder()) {
    aliases[def.name.toLowerCase()] = def.name;
    for (const shortcut of def.shortcuts) {
      aliases[shortcut.toLowerCase()] = def.name;
    }
  }
  // Extras last so a picker convenience can override a derived spelling.
  return { ...aliases, ...PROVIDER_FILTER_ALIAS_EXTRA };
}

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

  const source = getProviderFilterAliases()[prefix.toLowerCase()];
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

  const partialMatch = Object.entries(getProviderFilterAliases()).find(([alias]) =>
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
    const infos = dedupeByProviderSpec(
      providerSlug,
      toPickerRows(vendorModels.map(catalogModelToModelInfo))
    );
    if (!searchTerm) return infos;
    const needle = searchTerm.toLowerCase();
    return infos.filter((m) => m.id.toLowerCase().includes(needle));
  }

  if (searchTerm) {
    const found = await catalog.searchModels(searchTerm, 100);
    return toPickerRows(found.map(catalogModelToModelInfo));
  }

  // The default list too, and this is the branch F1 actually observed: two
  // Enters at launch is "All providers" with no term, which lands here.
  return toPickerRows(defaultModels);
}

/**
 * The cross-vendor catalog load — the picker's A2, as one awaitable.
 *
 * Extracted from `selectModelClassic`'s body so the OpenTUI picker runs the SAME two
 * fetches in the same way rather than a second approximation of them. `allSettled`,
 * not `all`: a failed top-100 fetch degrades to the recommended list, and a failed
 * recommended fetch degrades to nothing — neither is allowed to take the picker down,
 * because the rail is derived from provider definitions and stays usable with no
 * catalog at all.
 */
export async function loadPickerCatalog(
  options: { recommended?: boolean; forceUpdate?: boolean } = {}
): Promise<{ top: ModelInfo[]; recommended: ModelInfo[] }> {
  const { recommended = true, forceUpdate = false } = options;
  const [top100Result, recommendedResult] = await Promise.allSettled([
    getTop100Models(),
    recommended ? loadRecommendedModels(forceUpdate) : Promise.resolve([]),
  ]);
  return {
    top:
      top100Result.status === "fulfilled"
        ? sortModelsNewestFirst(dedupeModels(top100Result.value.models.map(modelDocToModelInfo)))
        : [],
    recommended: recommendedResult.status === "fulfilled" ? recommendedResult.value : [],
  };
}

/**
 * The interactive model picker's public entry point — UNCHANGED SIGNATURE.
 *
 * Resolves to a model spec string exactly as it always has, through the same
 * `buildExplicitModelSpec` / `pickerModelPrefix` / `resolveProviderExternalId`
 * functions. What changed is the cancel path: declining to choose used to call
 * `process.exit(0)` from inside this library, and now throws `PickerCancelled`, which
 * the caller's already-attached `handlePromptExit` turns into the same blank line and
 * the same exit 0. Because that handler is attached at all three entry points
 * (`index.ts:428`, `:432`, `:804`), ZERO call sites change and the user-visible
 * result is byte-identical.
 */
export async function selectModel(options: ModelSelectorOptions = {}): Promise<string> {
  const outcome = await selectModelInteractive(options);
  if (outcome.model === null) throw new PickerCancelled();
  return outcome.model;
}

/** What the picker resolves to. `null` ⟺ the user declined to choose. */
export interface PickerOutcome {
  model: string | null;
}

/**
 * The picker, as a function that RETURNS the user's decision instead of exiting.
 *
 * Three gates, in this order, and the order is the design:
 *
 * 1. **No TTY → `NoTtyError`, never a fallback to inquirer.** Falling back would be
 *    falling back to a hang: inquirer in a non-TTY draws into a stream nothing is
 *    reading and then waits for a keypress that cannot arrive. `index.ts` cannot reach
 *    this branch (its own gate closed it), but `profile-commands.ts:559` can, and
 *    `grep isTTY profile-commands.ts` returns nothing. So `claudish profile edit` under
 *    a pipe now fails fast with four actionable pointers instead of hanging forever.
 *
 * 2. **`CLAUDISH_PICKER=classic` → the inquirer implementation.** Rollback is an env
 *    var rather than a revert, which matters because this screen is on every user's
 *    startup path and NO test drives the flow being replaced. The removal trigger is
 *    recorded in `ROADMAP.md`.
 *
 * 3. **`--free` keeps its current behaviour — the throw.** `getFreeModels()` is a
 *    documented stub returning `[]`, so `--free` has been unreachable since the Zen
 *    removal. Routing it to the classic path preserves the exact exception rather than
 *    inventing a UI nobody specified for a flag nobody can use.
 *
 * The picker itself is reached by DYNAMIC import, which is what keeps OpenTUI off the
 * cold-start path and out of the MCP stdio path (§9.2).
 */
export async function selectModelInteractive(
  options: ModelSelectorOptions = {}
): Promise<PickerOutcome> {
  if (!canDrawTui()) throw new NoTtyError();
  if (options.freeOnly || process.env.CLAUDISH_PICKER === "classic") {
    return { model: await selectModelClassic(options) };
  }
  const { runModelPicker } = await import("./picker/model-picker-run.js");
  return runModelPicker(options);
}

/**
 * The inquirer implementation, verbatim — still the picker under
 * `CLAUDISH_PICKER=classic`, and still the machine behind `selectModelsForProfile`,
 * which is not being ported in this change and calls `selectModelFromProvider`
 * directly. It is not dead code kept "just in case": it has a live caller.
 */
async function selectModelClassic(options: ModelSelectorOptions = {}): Promise<string> {
  const { freeOnly = false, recommended = true, message, forceUpdate = false } = options;
  const catalog = createCatalogClient();

  let models: ModelInfo[];
  let recommendedModels: ModelInfo[] = [];
  let pickerProviders: PickerProvider[] = [];
  // Resolved exactly ONCE per picker open, then shared by both consumers below
  // (the picker's provider rail and the "Select provider:" prompt).
  // getInteractiveProviderChoices awaits credentials.isAvailable for EVERY
  // pickable provider, which can read OAuth files, the macOS keychain, and — for
  // op:// backed keys — the 1Password SDK. Resolving it twice doubled
  // picker-open latency for a byte-identical answer.
  let interactiveProviderChoices: ProviderChoice[] = [];
  const remoteQueryCache = new Map<string, Promise<ModelInfo[]>>();

  if (freeOnly) {
    models = await getFreeModels();
    if (models.length === 0) {
      throw new Error("No free models available");
    }
  } else {
    // Shared with the OpenTUI picker through `loadPickerCatalog`, so the two UIs
    // cannot drift into fetching different things.
    const loaded = await loadPickerCatalog({ recommended, forceUpdate });
    recommendedModels = loaded.recommended;
    models = loaded.top.length > 0 ? loaded.top : recommendedModels;

    interactiveProviderChoices = await getInteractiveProviderChoices();
    pickerProviders = toPickerProviders(interactiveProviderChoices);
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

          return remoteModels.slice(0, 100).map((model) => {
            // Once the search is FILTERED to a provider (`@ag gemini`), the row
            // IS that provider's offer, so it must be both priced and IDENTIFIED
            // as that provider.
            //
            // The id matters as much as the price: `model.id` is the catalog's
            // own key, while the callable string is `aggregators[].externalId`.
            // They differ wherever a provider re-serves a model under its own
            // name — `or@x-ai/grok-4.20` vs the bare id, `ag@gemini-3.6-flash`
            // vs the `-high` variant Antigravity actually serves. Emitting
            // `model.id` here handed the user a spec their provider does not
            // recognise. The provider-scoped list (`pickModelFromList`) has
            // always used `resolveProviderExternalId`; this path had not.
            const spec = effectiveProvider
              ? buildExplicitModelSpec(
                  effectiveProvider,
                  resolveProviderExternalId(effectiveProvider, model)
                )
              : model.id;
            return {
              // Unfiltered rows have no single provider to price or name
              // against, so they keep the model-level figure and the bare id.
              name: effectiveProvider
                ? formatModelChoiceAsSpec(
                    model,
                    spec,
                    resolveProviderDisplayPrice(effectiveProvider, model)
                  )
                : formatModelChoice(model, true),
              value: spec,
              description: model.description?.slice(0, 160),
            };
          });
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
 * One row of the picker's provider list.
 *
 * EXPORTED because it is already the return type of the exported
 * `buildProviderChoices`, so the name was public in everything but spelling — and
 * the OpenTUI picker's data source needs to name it.
 */
export interface ProviderChoice {
  name: string;
  value: string;
  description: string;
  provider?: string; // ProviderDefinition.name — if set, availability is checked
}

/**
 * Editorial overlay for the picker's provider rows — NOT a membership list.
 *
 * The provider list itself is DERIVED from `getAllProviders()` (see
 * `buildProviderChoices`). This map only overrides copy where the picker's
 * wording beats the definition's `description`, which is written for the config
 * TUI's denser layout. A provider absent from this map still appears; it just
 * renders with `displayName` + `description` straight from its definition.
 *
 * Keyed by ProviderDefinition.name.
 */
const PICKER_COPY: Record<string, { name?: string; description?: string }> = {
  openrouter: { description: "580+ models via unified API" },
  "opencode-zen": { name: "OpenCode Zen", description: "OpenCode-hosted models" },
  google: { name: "Google Gemini", description: "Direct API" },
  openai: { description: "Direct API" },
  "openai-codex": { description: "ChatGPT Plus/Pro subscription (Responses API)" },
  "x-ai": { name: "xAI / Grok", description: "Direct API" },
  deepseek: { description: "Direct API" },
  meta: { description: "Direct API" },
  "meta-muse-code": { name: "Muse Code", description: "Meta subscription" },
  mistralai: { name: "Mistral", description: "Direct API" },
  sakana: { name: "Sakana Fugu", description: "Direct API" },
  "sakana-subscription": { name: "Sakana Fugu Subscription", description: "Subscription plan" },
  minimax: { description: "Direct API" },
  "minimax-coding": { name: "MiniMax Coding", description: "Coding subscription" },
  kimi: { name: "Kimi / Moonshot", description: "Direct API" },
  "kimi-coding": { name: "Kimi Coding", description: "Coding subscription" },
  "qwen-token-plan": {
    name: "Alibaba Token Plan",
    description: "Model Studio subscription credits",
  },
  "qwen-coding": { name: "Alibaba Coding Plan", description: "Model Studio subscription requests" },
  "qwen-payg": { name: "Alibaba PAYG", description: "Model Studio pay-as-you-go tokens" },
  glm: { name: "GLM / Zhipu", description: "Direct API" },
  "glm-coding": { name: "GLM Coding Plan", description: "Coding subscription" },
  "z-ai": { name: "Z.AI", description: "Direct API" },
  ollamacloud: { name: "OllamaCloud", description: "Cloud models" },
  litellm: { description: "Configured proxy" },
  ollama: { name: "Ollama (local)", description: "Local Ollama instance" },
  lmstudio: { name: "LM Studio (local)", description: "Local LM Studio instance" },
  vllm: { name: "vLLM (local)", description: "Local vLLM server" },
  mlx: { name: "MLX (local)", description: "Local MLX server" },
};

/**
 * Leading display order. Anything not listed is appended alphabetically by
 * displayName, so a NEW provider is visible by default — at the end of the
 * list rather than nowhere. Ordering is the only thing this table controls.
 */
const PICKER_ORDER = [
  "openrouter",
  "opencode-zen",
  "opencode-zen-go",
  "google",
  "antigravity",
  "openai",
  "openai-codex",
  "devin",
  "x-ai",
  "deepseek",
  "meta",
  "meta-muse-code",
  "mistralai",
  "sakana",
  "sakana-subscription",
  "minimax",
  "minimax-coding",
  "kimi",
  "kimi-coding",
  "qwen-token-plan",
  "qwen-coding",
  "qwen-payg",
  "glm",
  "glm-coding",
  "z-ai",
  "ollamacloud",
  "poe",
  "vertex",
  "litellm",
  "ollama",
  "lmstudio",
  "vllm",
  "mlx",
];

/**
 * Is this definition something a user can actually pick?
 *
 * The criterion is the ABSENCE OF SHORTCUTS, and nothing else. A definition with
 * no `shortcuts` has no user-typeable `@` prefix, so the spec the picker emits
 * could never be typed back or parsed to this provider — it exists only so
 * `nativeModelPatterns` can steer a BARE model name to a real provider. `qwen`
 * (→ OpenRouter) and `native-anthropic` (→ Claude Code's own auth) are the two.
 * Both also happen to carry an empty `baseUrl`/`apiPath`, which corroborates the
 * verdict for those specific definitions but is NOT the test: `vertex` and
 * `litellm` have an empty `baseUrl` too (they resolve their endpoint from env at
 * request time) and are both pickable. Everything else is offerable, and the
 * credential authority decides whether THIS user sees it.
 *
 * A rule, not a list — which is the point. The old hand-written
 * ALL_PROVIDER_CHOICES array made membership opt-in, so `devin` and
 * `antigravity` were both invisible here while working everywhere else
 * (the config TUI derives its list from the same definitions).
 *
 * Exported for the drift test.
 */
export function isPickableProvider(def: ProviderDefinition): boolean {
  return def.shortcuts.length > 0;
}

/** Pickable definitions in the order the picker renders them. */
function pickableProvidersInPickerOrder(): ProviderDefinition[] {
  const rank = new Map(PICKER_ORDER.map((name, i) => [name, i]));
  return getAllProviders()
    .filter(isPickableProvider)
    .sort((a, b) => {
      const ra = rank.get(a.name) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b.name) ?? Number.MAX_SAFE_INTEGER;
      return ra !== rb ? ra - rb : a.displayName.localeCompare(b.displayName);
    });
}

/**
 * Provider choices for the picker, derived from the provider definitions — the
 * single source of truth the config TUI already uses.
 *
 * `skip` and `custom` are NOT providers; they are picker affordances, so they
 * stay explicit here.
 *
 * Exported for the drift test: this is the list the user actually sees, minus
 * the credential filter, so a test can assert a provider is OFFERED rather than
 * assert some proxy for it.
 */
export function buildProviderChoices(): ProviderChoice[] {
  const derived: ProviderChoice[] = pickableProvidersInPickerOrder().map((def) => {
    const copy = PICKER_COPY[def.name] ?? {};
    return {
      name: copy.name ?? def.displayName,
      value: def.name,
      description: copy.description ?? def.description ?? "",
      provider: def.name,
    };
  });

  return [
    {
      name: "Skip (keep Claude default)",
      value: "skip",
      description: "Use native Claude model for this tier",
    },
    ...derived,
    {
      name: "Enter custom model",
      value: "custom",
      description: "Type a provider@model specification",
    },
  ];
}

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
  const all = buildProviderChoices();
  const checks = await Promise.all(
    all.map(async (choice) => {
      if (!choice.provider) return true; // skip, custom — always shown
      // The authority knows every catalog provider; isAvailable resolves the
      // full env/config/oauth/op:// readiness for that provider name.
      return credentials.isAvailable(choice.provider);
    })
  );
  return all.filter((_, i) => checks[i]);
}

/**
 * READABILITY overrides for the `provider@model` prefix the picker emits.
 *
 * The prefix is otherwise DERIVED from the definition's `shortestPrefix` (see
 * `pickerModelPrefix`), which is the only string guaranteed to parse back to
 * this provider. The four provider rows here are longer aliases that are
 * equally valid and read better on a command line the user may copy —
 * `google@gemini-3-pro` over
 * `g@gemini-3-pro`. `zen` is a legacy picker VALUE (the provider list now uses the
 * definition name `opencode-zen`); kept so an old caller still resolves.
 *
 * Do NOT add a row here just because a provider is new — the derived path
 * already covers it, and correctly.
 */
const PROVIDER_MODEL_PREFIX_OVERRIDE: Record<string, string> = {
  google: "google@",
  openrouter: "openrouter@",
  lmstudio: "lmstudio@",
  sakana: "sakana@",
  zen: "zen@",
};

/**
 * The `provider@` prefix for a picker value, or undefined when the provider is
 * unknown (the caller then hands back the bare model id).
 *
 * What is load-bearing here is that a prefix is emitted AT ALL. The old
 * `PROVIDER_MODEL_PREFIX[provider]` map returned undefined for any provider
 * nobody had added a row for, and `buildExplicitModelSpec` then hands back the
 * BARE id — for Devin that means `claude-opus-5-medium`, which matches
 * native-anthropic's `/^claude-/i` and is silently answered by a different
 * provider entirely. Deriving removes the opportunity to forget a row.
 *
 * `shortestPrefix` rather than `${provider}@` is a preference, not a
 * correctness fix: `parseModelSpec` passes an unrecognized prefix through
 * verbatim (model-parser.ts:160), so a canonical definition NAME also resolves.
 * The shortest prefix is the provider's own declared spelling and is shorter to
 * retype, which is what the user sees in the picker rows.
 */
function pickerModelPrefix(provider: string): string | undefined {
  const override = PROVIDER_MODEL_PREFIX_OVERRIDE[provider];
  if (override) return override;
  const def = getProviderByName(provider);
  if (!def || !isPickableProvider(def)) return undefined;
  // `shortestPrefix` is OPTIONAL on ProviderDefinition. Returning undefined for
  // a definition that omits it would reopen the exact hole described above — a
  // pickable provider whose rows emit a bare id — so fall back to the first
  // registered shortcut, which `isPickableProvider` guarantees exists and which
  // `getShortcuts()` guarantees parses back to this provider. Only a genuinely
  // unknown provider reaches undefined.
  const prefix = def.shortestPrefix || def.shortcuts[0];
  return prefix ? `${prefix}@` : undefined;
}

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
  const prefix = pickerModelPrefix(provider);
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
  if (match?.externalModelId) return match.externalModelId;
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
  if (!model.aggregators) return undefined;
  return model.aggregators.find(
    (a) => a.routeStatus === "mapped" && catalogRouteMatchesProvider(a.route, provider)
  );
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
  // A flat-rate plan has no per-token rate to show, and this check has to come
  // FIRST — ahead of both the aggregator rate and the model-level one.
  //
  // `buildDiscoveredModelRows` already asks this question, but only providers
  // that declare `modelDiscovery` reach it. Everything else lands here, which is
  // why Antigravity rendered "N/A" and why MiniMax Coding / GLM Coding rendered
  // their metered siblings' dollar rates: the catalog knows the OWNER's price,
  // and for a subscription that number is not what the user pays. Quoting it is
  // worse than saying nothing.
  if (isSubscriptionProvider(provider)) return "SUB";
  const entry = resolveProviderAggregatorEntry(provider, model);
  const entryPrice = formatAveragePricing(entry?.pricing);
  if (entryPrice?.average) return entryPrice.average;
  return model.pricing?.average || "N/A";
}

/**
 * Resolve the human-readable provider name used in picker prompt copy.
 */
function getPickerDisplayName(providerValue: string): string {
  const choice = buildProviderChoices().find((c) => c.value === providerValue);
  if (choice) return choice.name;
  // Fall back to provider-definitions for runtime providers / custom endpoints.
  return getDisplayName(providerValue);
}

/**
 * Load models for a specific picker provider value via the CatalogClient.
 */
export async function loadModelsForPickerProvider(
  providerValue: string,
  catalog: CatalogClient
): Promise<ModelInfo[]> {
  const firebaseSlug = pickerProviderToFirebaseSlug[providerValue] ?? providerValue;

  try {
    const vendorModels = await catalog.modelsByVendor(firebaseSlug);
    return dedupeByProviderSpec(
      providerValue,
      toPickerRows(vendorModels.map(catalogModelToModelInfo))
    );
  } catch {
    return [];
  }
}

/**
 * The models a picker provider SERVES, from the catalog's local served-by index.
 *
 * The synchronous twin of `loadModelsForPickerProvider`, and the source of the
 * OpenTUI picker's ONE flat cross-provider list. It answers the same question
 * through the same two chokepoints (`toPickerRows`, `dedupeByProviderSpec`) and
 * differs in exactly one way: it never leaves the machine. That matters because
 * the flat list asks about every provider at once, and 22 concurrent
 * `?provider=` queries were measured taking 10 s and returning zero rows —
 * "this provider has no models", which is the defect this whole feature exists
 * to remove, manufactured by the fix for it.
 *
 * `servedByVendor` records why the served-by index is not a second authority.
 */
export function servedModelsForProvider(
  providerValue: string,
  catalog: CatalogClient
): ModelInfo[] {
  const firebaseSlug = pickerProviderToFirebaseSlug[providerValue] ?? providerValue;
  return dedupeByProviderSpec(
    providerValue,
    toPickerRows(catalog.servedByVendor(firebaseSlug).map(catalogModelToModelInfo))
  );
}

/**
 * The `provider@` shortcut a picker row prints in its provider column — `or@`,
 * `cx@`, `kc@`, `gk@`.
 *
 * DERIVED FROM THE DEFINITION, never a table. It is the SHORTEST spelling that
 * parses back to this provider, which is what makes the column double as a
 * lesson in the `provider@model` syntax the CLI already takes on argv, and what
 * makes it collision-proof where the old provider rail was not (the rail
 * truncated two different providers to the same `opencod…`).
 *
 * DELIBERATELY NOT `pickerModelPrefix`. That one applies the readability
 * OVERRIDES (`google@`, `openrouter@`) because it builds the spec the user will
 * copy off their screen; a fixed-width column wants the short form, and the full
 * spec is on the detail line one row below. Both derive from the same definition,
 * so neither can name a provider the other cannot.
 */
export function providerShortcut(providerValue: string): string {
  const def = getProviderByName(providerValue);
  const prefix = def?.shortestPrefix || def?.shortcuts?.[0];
  return prefix ? `${prefix}@` : `${providerValue}@`;
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
 *    — evidence from the provider's own listing or the catalog's modalities,
 *    never a name rule or a model-id skip list. An all-non-chat dynamic models catalog
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
 * promos in the measured Devin dynamic models catalog expired within days of being observed,
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

/**
 * Which list the user is about to be shown instead of the dynamic models catalog.
 *
 * The caller that writes the notice is not always the caller that knows this.
 * `warnDiscoveryFailure` runs at the point discovery fails, BEFORE the
 * catalog/free-text decision is taken further down `selectModelFromProvider`,
 * so it can only state the default. A renderer that resolves both legs before
 * drawing anything knows the real answer and says it.
 *
 * `"unknown"` emits no provenance line at all, which is the honest output when
 * nothing has decided yet — better than naming a fallback that may not happen.
 */
export type FallbackTaken = "manual-entry" | "catalog" | "unknown";

/**
 * A discovery failure as the lines a presenter should show, newest line last.
 *
 * Pure: no I/O, no read of the module-global failure map. Split out of
 * `warnDiscoveryFailure` so the same words can go to stderr (the classic
 * inquirer path) and into render state (the OpenTUI picker, which must not
 * write to a terminal it is drawing on). The wording is deliberately unchanged —
 * it was measured against a real 401 and found to be complete; what was wrong
 * was its presentation, not its content.
 *
 * Each string carries its own newlines, so a presenter that writes them
 * verbatim reproduces today's stderr byte for byte.
 */
export function formatDiscoveryFailureNotice(
  displayName: string,
  failure: DiscoveryFailure,
  def: Pick<ProviderDefinition, "apiKeyEnvVar" | "apiKeyUrl">,
  fallback: FallbackTaken = "manual-entry"
): string[] {
  const lines = [
    `\n⚠ ${displayName} could not list its models: ${describeDiscoveryFailure(failure)}\n`,
  ];

  // A credential problem is the one case with a concrete next step, so name the
  // exact env var and where a key comes from. Naming the variable matters more
  // than it looks: a provider's key is frequently shadowed by a stale value in
  // the shell, and "check your API key" gives no clue which name to inspect.
  if (failure.kind === "unauthorized" || failure.kind === "no-credentials") {
    if (def.apiKeyEnvVar) {
      lines.push(
        `  Check ${def.apiKeyEnvVar} (a value in your shell overrides stored credentials).\n`
      );
    }
    if (def.apiKeyUrl) lines.push(`  Get a key: ${def.apiKeyUrl}\n`);
  }

  if (fallback === "manual-entry") lines.push("  Falling back to manual model entry.\n\n");
  else if (fallback === "catalog") {
    lines.push(
      `  Showing ${displayName}'s cloud-catalog entries below — not its live model list.\n\n`
    );
  }
  return lines;
}

/**
 * Tell the user why a discovery provider offered no list, on stderr, before the
 * picker degrades to the catalog / free-text path.
 *
 * stderr rather than stdout because the picker's own chrome is drawn by
 * inquirer on stdout, and a model spec is what this module ultimately RETURNS
 * — a notice must not be capturable as part of a piped answer.
 *
 * `empty-models-catalog` is deliberately silent: an endpoint that answers correctly
 * with nothing chat-capable is not an error, and the free-text prompt that
 * follows is the right affordance for it. Only actionable failures are named.
 * (That judgement is right for stderr, where a notice scrolls past; a rendered
 * panel can afford to say it in one dim row, and the picker does.)
 *
 * Reads the module-global failure map rather than taking a failure, because its
 * call site has already thrown the outcome away. New callers should prefer
 * `buildDiscoveredModelOutcome`, which carries the failure with it.
 *
 * Exported for unit tests.
 */
export function warnDiscoveryFailure(
  provider: string,
  displayName: string,
  def: Pick<ProviderDefinition, "apiKeyEnvVar" | "apiKeyUrl">
): void {
  const failure = getDiscoveryFailure(provider);
  if (!failure || failure.kind === "empty-models-catalog") return;

  // Default `fallback`, i.e. "Falling back to manual model entry." — which is
  // not always what happens next (the catalog usually answers), but this call
  // site runs before that is decided and cannot know. Correcting the string is
  // a follow-up with a named trigger: when `selectModelClassic` is deleted,
  // this function and the assertion on that sentence go with it.
  for (const line of formatDiscoveryFailureNotice(displayName, failure, def)) {
    process.stderr.write(line);
  }
}

/**
 * Dynamic models catalog → picker rows, as an injectable step.
 *
 * A seam, not a design: `collapseModelsCatalog` folding a non-empty dynamic models catalog to `[]` is
 * the one state behind `PickerDiscoveryOutcome.collapsed-empty`, and the single
 * shipped resolver cannot produce it (every entry lands in a group and every
 * group yields a choice), so the variant is otherwise untestable. The
 * alternative, `mock.module()` on the resolver registry, bleeds into sibling Bun
 * test files and is banned here. Replace the property in a test and restore it;
 * the same shape the discovery tests already use on `credentials.getRequestAuth`.
 */
export const _modelsCatalogCollapse = { collapse: collapseModelsCatalog };

/**
 * What one discovery provider's model list actually is — all five states that
 * used to be the same empty array, plus the one where nothing was attempted.
 *
 * `buildDiscoveredModelRows` returned `[]` for a rejected API key, an
 * unreachable endpoint, a genuinely empty dynamic models catalog, a dynamic models catalog where nothing was
 * chat-capable, and a dynamic models catalog that collapsed to nothing — and its caller fell
 * through to the cloud catalog for all of them, silently. The user's report was
 * *"it just shows fewer model names, like the provider does not have any
 * models"*: information destroyed at a return statement, which no amount of UI
 * can recover. Hence a discriminated union produced where the information still
 * exists.
 *
 * - `rows` is **non-empty by construction** — the type says so, and the three
 *   empty cases below exist precisely so it can.
 * - `servedCount` / `chatCount` make a PARTIAL filter visible too: today the
 *   difference between "served 40" and "40 of which 12 are chat models" is
 *   discarded.
 * - `fallbackRows` rides along on the four recoverable variants, resolved
 *   CONCURRENTLY with discovery rather than after it (§3.6 of the design): a
 *   serial second fetch would put the feature's worst latency on exactly the
 *   path the complaint is about. Empty when the catalog has nothing either, in
 *   which case the only remaining affordance is free-text entry.
 * - `unsupported` is not a failure. ~25 pickable providers declare no
 *   `modelDiscovery`; for them the catalog list is the normal, correct UI and a
 *   notice would be noise on the majority case.
 */
export type PickerDiscoveryOutcome =
  | { kind: "rows"; rows: [ModelInfo, ...ModelInfo[]]; servedCount: number; chatCount: number }
  | { kind: "all-filtered"; servedCount: number; sampleIds: string[]; fallbackRows: ModelInfo[] }
  | { kind: "collapsed-empty"; servedCount: number; chatCount: number; fallbackRows: ModelInfo[] }
  | { kind: "empty-models-catalog"; failure: DiscoveryFailure; fallbackRows: ModelInfo[] }
  | { kind: "failed"; failure: DiscoveryFailure; notice: string[]; fallbackRows: ModelInfo[] }
  | { kind: "unsupported"; reason: "no-descriptor" | "no-fetcher" };

/**
 * One discovery provider's list, with the reason when there isn't one.
 *
 * Starts both legs at once — the dynamic models catalog and the cloud-catalog fallback —
 * and returns one settled answer, so a view has one state and one affordance per
 * provider instead of two spinners to reconcile. The catalog leg costs a lookup
 * a healthy dynamic models catalog does not need; that is cheaper than doubling the wait on the
 * failure path, and `catalog.modelsByVendor` caches.
 */
export async function buildDiscoveredModelOutcome(
  provider: string,
  displayName: string,
  catalog: CatalogClient
): Promise<PickerDiscoveryOutcome> {
  const [modelsCatalogResult, fallbackResult] = await Promise.allSettled([
    discoverProviderModelsCatalog(provider),
    loadModelsForPickerProvider(provider, catalog),
  ]);

  const fallbackRows = fallbackResult.status === "fulfilled" ? fallbackResult.value : [];
  // `discoverProviderModelsCatalog` never rejects by contract, but a contract is not a
  // type: honour it rather than asserting it, so a future regression there shows
  // up as a named failure instead of an unhandled rejection behind a renderer.
  const modelsCatalog: ModelsCatalogOutcome =
    modelsCatalogResult.status === "fulfilled"
      ? modelsCatalogResult.value
      : {
          kind: "failed",
          failure: {
            kind: "unreachable",
            provider,
            detail: String(
              (modelsCatalogResult.reason as Error)?.message ?? modelsCatalogResult.reason
            ),
          },
        };

  if (modelsCatalog.kind === "unsupported")
    return { kind: "unsupported", reason: modelsCatalog.reason };

  if (modelsCatalog.kind === "failed") {
    const { failure } = modelsCatalog;
    // `empty-models-catalog` is its own variant rather than a `failed` with a kind to
    // switch on, because it is not an error: the endpoint answered. It renders
    // in the NOTICE tier, visibly distinct from a rejected key.
    if (failure.kind === "empty-models-catalog") {
      return { kind: "empty-models-catalog", failure, fallbackRows };
    }
    const def = getProviderByName(provider);
    const notice = formatDiscoveryFailureNotice(
      displayName,
      failure,
      // A runtime custom endpoint may not be in the definition table at all;
      // empty strings suppress the two guidance lines, which is right — there is
      // no env var or key URL to name.
      def ?? { apiKeyEnvVar: "", apiKeyUrl: "" },
      fallbackRows.length > 0 ? "catalog" : "manual-entry"
    );
    return { kind: "failed", failure, notice, fallbackRows };
  }

  const served = rankDiscoveredModels(modelsCatalog.models);
  const servedCount = served.length;
  // `m.reported` carries the provider's own chat/not-chat statement. Judging the
  // bare `m.id` alone discarded it, and once `unknown` stopped counting as chat
  // that emptied the picker for every provider whose ids the cloud catalog does
  // not list verbatim: Ollama 19 → 1, Devin 247 → 3, Antigravity 21 → 7.
  const discovered = served.filter((m) => isReportedChatCapable(m.id, m.reported));
  const chatCount = discovered.length;
  if (chatCount === 0) {
    // Served N, none of them chat-capable. Invisible today, and self-explaining
    // only if the ids come with it — they are usually embeddings or wildcard
    // routes, which a reader recognises at a glance.
    return {
      kind: "all-filtered",
      servedCount,
      sampleIds: served
        .filter((m) => !isReportedChatCapable(m.id, m.reported))
        .slice(0, 3)
        .map((m) => m.id),
      fallbackRows,
    };
  }

  const [head, ...tail] = buildRowsFromDiscovered(provider, displayName, discovered, fallbackRows);
  if (head === undefined) {
    // Unreachable through the one shipped resolver, and deliberately still
    // modelled: `{kind:"rows", rows: []}` would be an empty panel with no
    // explanation, which is the exact defect class this type removes. Destructured
    // rather than length-checked so the non-empty tuple needs no cast to assert.
    return { kind: "collapsed-empty", servedCount, chatCount, fallbackRows };
  }
  return { kind: "rows", rows: [head, ...tail], servedCount, chatCount };
}

/**
 * The picker rows for a provider's dynamic models catalog, or `[]` for any of the six
 * reasons there isn't one.
 *
 * A wrapper over {@link buildDiscoveredModelOutcome} since the outcome type
 * landed. The classic inquirer path keeps using it and keeps asking
 * `warnDiscoveryFailure` why the list was empty afterwards — which still works,
 * because every failure is still recorded in `model-discovery.ts`'s map.
 */
export async function buildDiscoveredModelRows(
  provider: string,
  displayName: string,
  catalog: CatalogClient
): Promise<ModelInfo[]> {
  const outcome = await buildDiscoveredModelOutcome(provider, displayName, catalog);
  return outcome.kind === "rows" ? outcome.rows : [];
}

/**
 * Chat-capable discovered models → picker rows. Pure; no I/O.
 *
 * `catalogRows` is the vendor catalog's list for this provider, already fetched
 * by the caller. A per-token discovery provider should show the real rate, and
 * neither the live endpoint nor the slim catalog reports one — so the price
 * comes from there. Flat-rate providers (every discovery provider today) ignore
 * it entirely.
 */
function buildRowsFromDiscovered(
  provider: string,
  displayName: string,
  discovered: DiscoveredModel[],
  catalogRows: ModelInfo[]
): ModelInfo[] {
  const subscription = isSubscriptionProvider(provider);
  const local = getProviderByName(provider)?.isLocal === true;
  // Neither a flat-rate plan nor a local daemon charges per token, and the
  // vendor catalog has nothing to say about either — Firebase does not list a
  // model someone pulled onto their own machine.
  const flatRate = subscription || local;
  const pricingById = flatRate
    ? new Map<string, ModelInfo["pricing"]>()
    : new Map(catalogRows.map((m) => [m.id.toLowerCase(), m.pricing]));

  // Fold variant explosions into the rows a human actually picks. Identity for
  // every provider without a resolver, so this is a no-op except for Devin,
  // where 167 served uids are ~39 real choices multiplied out by reasoning tier
  // and speed premium. The chosen id is always a real wire id, so it still
  // round-trips through buildExplicitModelSpec and argv unchanged.
  const choices = _modelsCatalogCollapse.collapse(provider, discovered.map(toModelsCatalogEntry));
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
    // ONE FORMATTER, ONE NUMBER. This line used to divide by 1024 while `context`
    // (three lines down, and what every list row prints) divides by 1000, so a single
    // frame showed the same model as `250K` in its row and `244K context` in its
    // description — measured in the picker's first capture, and reported before that
    // from the old picker's detail line. Neither number was wrong; having two was.
    if (contextLength) parts.push(`${formatContextLength(contextLength)} context`);
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
  // is meaningful for probe candidates, but for a plan whose entire dynamic models catalog is
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
  // `${provider}@` is the last resort for a runtime custom endpoint, whose NAME
  // is registered as its prefix; every builtin resolves through shortestPrefix.
  const prefix = pickerModelPrefix(provider) ?? `${provider}@`;
  const displayName = getPickerDisplayName(provider);

  // Subscription providers (e.g. Kimi Coding) serve a dynamic models catalog that only their
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
    } else {
      // Discovery unavailable / nothing chat-capable → fall through to the
      // cloud catalog rather than showing an empty list, but SAY WHY first.
      //
      // The fall-through itself is correct and deliberate; what was wrong was
      // doing it silently. A rejected API key and a provider that publishes no
      // dynamic models catalog both ended up as the same free-text prompt, so a credential
      // error was indistinguishable from normal behaviour.
      warnDiscoveryFailure(provider, displayName, def);
    }
  }

  // Ollama and LM Studio used to be handled here, each its own way — Ollama by
  // an inline `/api/tags` branch, LM Studio not at all (free-text only). Both
  // now declare `modelDiscovery`, so the block above lists them like every
  // other provider that knows its own dynamic models catalog. A local daemon is not a different
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

// `selectProfile` was DELETED here. It had zero importers anywhere in the repo,
// tests included — the profile commands build their own `select` — so it was an
// exported surface that nothing could regress and nothing could exercise. Removed
// with the picker rewrite rather than left for the next reader to re-litigate.

/**
 * Confirm action
 */
export async function confirmAction(message: string): Promise<boolean> {
  return confirm({ message, default: false });
}
