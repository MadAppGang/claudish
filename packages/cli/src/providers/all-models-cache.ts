/**
 * Shared helpers for ~/.claudish/all-models.json
 *
 * This file is written and read by four independent consumers:
 *   - providers/catalog-resolvers/openrouter.ts (v2 authoritative — Firebase slim catalog)
 *   - cli.ts (fetchRemoteModels + printAllModels)
 *   - mcp-server.ts (loadAllModels)
 *   - model-selector.ts (fetchAllModels + shouldRefreshForFreeModels)
 *
 * Historically each consumer wrote its own v1-shape `{lastUpdated, models}` blob,
 * clobbering the v2 `entries` array that the OpenRouter catalog resolver relies on.
 *
 * This module provides a single normalized v2 read/write API:
 *   - `readAllModelsCache()` returns a v2 shape (normalizing v1 files on the fly)
 *   - `writeAllModelsCache(partial)` merges with the existing file so callers that
 *     only supply `models` do NOT destroy the Firebase `entries` catalog.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AggregatorEntry } from "../model-loader.js";

/**
 * Slim catalog entry from the Firebase queryModels?catalog=slim endpoint.
 * Contains model name resolution data plus optional model metadata.
 *
 * The slim catalog includes `aggregators` per entry — verified live against
 * `?catalog=slim` (see `models-index/functions/src/query-handler.ts:267-269`).
 * This is the multi-aggregator routing index used by `CatalogClient` to
 * answer "which vendors serve model X?" without a Firebase round-trip.
 */
/**
 * How a model exposes its reasoning depth, as reported by the slim catalog.
 *
 * - `toggle`   — reasoning is on/off only; there is no depth parameter.
 * - `effort`   — a discrete level from the model's own `efforts` list.
 * - `adaptive` — the model chooses; a level may optionally be suggested.
 * - `budget`   — a token budget (`budget_tokens`).
 *
 * Kept as a string union of what Firebase currently emits, but consumers must
 * treat an unrecognized value as "no information" rather than an error —
 * the catalog is external data and may grow new kinds.
 */
export type ReasoningControl = "toggle" | "effort" | "adaptive" | "budget";

/**
 * Per-model reasoning capability from the Firebase slim catalog.
 *
 * This is the ONLY sanctioned source for "does this model take an effort
 * level / a token budget / just an on-switch?". Hardcoding that per model is
 * exactly the data that goes stale (a `control: "toggle"` model handed a
 * `budget_tokens` is being sent a parameter it does not expose).
 */
export interface ReasoningCapability {
  /** Whether the model can reason at all. */
  supported: boolean;
  /** Which knob the model exposes. Absent = unknown. */
  control?: ReasoningControl;
  /** Whether reasoning cannot be turned off. */
  mandatory?: boolean;
  /** The discrete levels this model advertises (catalog vocabulary). */
  efforts?: string[];
  /** The level the provider applies when none is requested. */
  defaultEffort?: string;
  /** Whether an explicit `budget_tokens` is accepted. */
  supportsBudgetTokens?: boolean;
}

/**
 * How a provider-preset variant relates to its base model.
 *
 * The catalog lists a preset variant (e.g. `gemini-3.6-flash-high`) as its own
 * top-level model, and `routeVariant` is the back-pointer: which family it
 * belongs to, which base model it presets, and whether it is that family's
 * default. `isDefault` is the authoritative answer to "if the user names the
 * family, which variant should we send?" — a fact the client cannot derive,
 * because the variant suffix is provider vocabulary, not a version number.
 */
export interface RouteVariant {
  /** Discriminator, e.g. `provider-preset`. Treat unknown kinds as no info. */
  kind: string;
  /** The catalog model this variant presets (e.g. `gemini-3.6-flash`). */
  baseModelId?: string;
  /** The family a user would name (e.g. `gemini-3.1-pro`). */
  familyId?: string;
  /** The serving provider this variant exists on (e.g. `antigravity`). */
  provider?: string;
  /** Provider vocabulary for the preset (e.g. `reasoning-tier=high`). */
  preset?: string;
  /** Whether this variant is the family's default on that provider. */
  isDefault?: boolean;
}

/**
 * Which wire API a model is reachable on, keyed by transport family.
 *
 * `api` names the concrete endpoint shape (`chat-completions` / `responses` /
 * `anthropic-messages` / `gemini`), and `toolsWithReasoning` records whether
 * tools and reasoning can be combined on it — `requires-responses` means the
 * Chat Completions path cannot carry both.
 */
export interface ModelEndpoint {
  api?: string;
  toolsWithReasoning?: string;
}

export interface SlimModelEntry {
  modelId: string;
  aliases: string[];
  sources: Record<string, { externalId: string }>;
  /** Official/curated release date in ISO date format, when Firebase has one */
  releaseDate?: string;
  /** Context window in tokens (present when Firebase has it) */
  contextWindow?: number;
  /**
   * Reasoning capability (present when Firebase has it). Already carried by the
   * on-disk `?catalog=slim` payload; the type previously dropped it, so every
   * consumer had to guess a model's reasoning knob instead of reading it.
   */
  reasoning?: ReasoningCapability;
  /** Whether model supports vision/image input (present when Firebase has it) */
  supportsVision?: boolean;
  /**
   * Multi-aggregator routing index. Each entry is `{provider, externalId, confidence}`.
   * Populated by Firebase ingest from per-source data. Optional — older cache
   * files may not include this field.
   */
  aggregators?: AggregatorEntry[];
  /**
   * Subscription plan ids that include this model (e.g. `["kimi-code"]`).
   * Populated by Firebase ingest. Used by routing to decide whether a
   * subscription endpoint can serve a given model at all — a plan that doesn't
   * list the model would reject it, so the candidate is dropped rather than
   * silently substituted. Optional — older cache files may not include it.
   */
  subscriptionPlans?: string[];
  /**
   * Whether the model accepts tool/function definitions. Shipped by the catalog
   * for ~97% of models.
   */
  supportsTools?: boolean;
  /**
   * Whether the model can produce thinking/reasoning content at all. Coarser
   * than {@link ReasoningCapability} (which describes the KNOB); this is the
   * plain yes/no.
   */
  supportsThinking?: boolean;
  /**
   * The name of the output-token parameter this model's API expects —
   * `max_tokens`, `max_completion_tokens`, or `max_output_tokens`.
   *
   * This exists because the correct parameter is NOT derivable from the model
   * name. Guessing it from a version substring (`gpt-5` → max_completion_tokens)
   * is wrong for the gpt-5.6-* family, which takes `max_output_tokens`, and
   * breaks silently for every model released after the guess was written.
   */
  tokenParam?: string;
  /** Preset-variant back-pointer — see {@link RouteVariant}. */
  routeVariant?: RouteVariant;
  /** Wire APIs this model is reachable on, keyed by transport family. */
  endpoints?: Record<string, ModelEndpoint>;
}

export type SubscriptionModelDiscovery = "catalog" | "client" | "hybrid";

/** Minimal queryPlans projection needed by the synchronous routing engine. */
export interface CachedSubscriptionPlan {
  /** Canonical commercial plan ID referenced by SlimModelEntry.subscriptionPlans. */
  id: string;
  /**
   * The VENDOR selling the plan (`alibaba`, `z-ai`, `moonshotai`) — not a
   * routing identity. Several plans can share one vendor while only some carry a
   * `routing` block, which is exactly what `resolveSubscriptionRouting` needs it
   * for: to notice that its view of a vendor's plans is incomplete and withhold
   * a `not-served` verdict. Do not use it to route; use `routing.providerUid`.
   */
  provider?: string;
  /** Where the exact callable roster comes from. */
  modelDiscovery?: SubscriptionModelDiscovery;
  /** Consumer routing identity; absent when the catalog has no supported route. */
  routing?: {
    providerUid: string;
    prefix?: string;
    nativeModelProviders?: string[];
  };
}

/**
 * Disk cache format (version 2).
 * Contains both the slim Firebase data (for resolver) and a backward-compatible
 * models array (for existing consumers in cli.ts/mcp-server.ts that expect {id: string}).
 */
export interface DiskCacheV2 {
  version: 2;
  lastUpdated: string;
  entries: SlimModelEntry[];
  /** Backward-compatible: [{id: "vendor/model"}] for legacy consumers */
  models: Array<{ id: string }>;
  /** Additive queryPlans cache. Absent on legacy v2 files. */
  plans?: CachedSubscriptionPlan[];
}

export const ALL_MODELS_CACHE_PATH = join(homedir(), ".claudish", "all-models.json");

/**
 * Read the cache from disk, normalizing legacy v1 files to a v2 shape.
 *
 * Returns null if the file doesn't exist or is unparseable.
 * A legacy v1 file `{lastUpdated, models}` is normalized to
 * `{version: 2, lastUpdated, entries: [], models}` so callers can treat both
 * the same way.
 *
 * @param path Override the cache path. Defaults to `ALL_MODELS_CACHE_PATH`.
 *             Only tests should pass this.
 */
export function readAllModelsCache(path: string = ALL_MODELS_CACHE_PATH): DiskCacheV2 | null {
  if (!existsSync(path)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }

  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;

  const lastUpdated =
    typeof data.lastUpdated === "string" ? data.lastUpdated : new Date(0).toISOString();
  const models = Array.isArray(data.models) ? (data.models as Array<{ id: string }>) : [];
  const entries = Array.isArray(data.entries) ? (data.entries as SlimModelEntry[]) : [];
  const plans = Array.isArray(data.plans) ? (data.plans as CachedSubscriptionPlan[]) : undefined;

  return {
    version: 2,
    lastUpdated,
    entries,
    models,
    ...(plans !== undefined ? { plans } : {}),
  };
}

/**
 * Write the cache to disk in v2 format, preserving any existing `entries`
 * or `models` the caller did not explicitly supply.
 *
 * This is the critical anti-clobber behavior: legacy writers that only know
 * about `models` will merge on top of the existing v2 `entries`, leaving the
 * OpenRouter Firebase catalog intact.
 *
 * @param data Partial DiskCacheV2. Any omitted fields are filled from the
 *             existing file (if present) rather than reset to defaults.
 * @param path Override the cache path. Defaults to `ALL_MODELS_CACHE_PATH`.
 *             Only tests should pass this.
 */
export function writeAllModelsCache(
  data: Partial<DiskCacheV2>,
  path: string = ALL_MODELS_CACHE_PATH
): void {
  const existing = readAllModelsCache(path);

  const merged: DiskCacheV2 = {
    version: 2,
    lastUpdated: data.lastUpdated ?? new Date().toISOString(),
    entries: data.entries ?? existing?.entries ?? [],
    models: data.models ?? existing?.models ?? [],
    ...(data.plans !== undefined || existing?.plans !== undefined
      ? { plans: data.plans ?? existing?.plans ?? [] }
      : {}),
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged), "utf-8");
}
