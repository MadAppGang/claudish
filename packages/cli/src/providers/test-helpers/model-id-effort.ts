import type { EffortLevel } from "../../adapters/base-api-format.js";
import type { AggregatorEntry } from "../../model-loader.js";
import type { SlimModelEntry } from "../all-models-cache.js";
import { catalogRouteForProvider } from "../catalog-route-bindings.js";
import type { DevinModelConfig } from "../devin/devin-models.js";

// The connection field is not typed yet. Keep the backend contract in test data,
// without augmenting production types or implementing any selection logic here.
export interface ModelIdEffort {
  via: "model_id";
  values: Partial<Record<Exclude<EffortLevel, "none">, string>>;
  default: { status: "unknown" };
  off?: string;
  baseServed: boolean;
}

export function effortMap(
  values: ModelIdEffort["values"],
  extra: Partial<Omit<ModelIdEffort, "via" | "values">> = {}
): ModelIdEffort {
  return { via: "model_id", values, default: { status: "unknown" }, baseServed: false, ...extra };
}

export function connection(
  provider: "devin" | "antigravity" | "google",
  externalModelId: string,
  modelIdEffort?: ModelIdEffort
): AggregatorEntry & { modelIdEffort?: ModelIdEffort } {
  return {
    sourceProviderId: provider,
    sourceCollectorId: "subscription-models-test-data",
    confidence: "api_official",
    routeStatus: "mapped",
    route: catalogRouteForProvider(provider),
    externalModelId,
    ...(modelIdEffort ? { modelIdEffort } : {}),
  };
}

export function catalogEntry(
  modelId: string,
  aggregators: AggregatorEntry[],
  aliases: string[] = []
): SlimModelEntry {
  return {
    modelId,
    provider: "google",
    aliases,
    inputModalities: ["text"],
    outputModalities: ["text"],
    contextWindow: 200_000,
    aggregators,
  };
}

// Shape copied from the existing Devin resolver tests and GetCliModelConfigs
// decoder: axes, family default and credit multiplier are provider-reported.
export function devinModel(
  uid: string,
  effort: EffortLevel,
  options: {
    family?: string;
    groupLabel?: string;
    isDefault?: boolean;
    cost?: number;
    contextWindow?: number;
    premium?: boolean;
  } = {}
): DevinModelConfig {
  return {
    uid,
    family: options.family ?? "gemini-4-carbon",
    groupLabel: options.groupLabel ?? "Gemini 4 Carbon",
    displayName: uid,
    contextWindow: options.contextWindow ?? 200_000,
    maxOutput: 32_768,
    axes: [
      { key: "Reasoning Effort", label: effort === "none" ? "No Thinking" : effort, enabled: true },
      { key: "Fast Mode", enabled: options.premium ?? false },
    ],
    isFamilyDefault: options.isDefault ?? false,
    isRecommended: false,
    creditMultiplier: options.cost ?? 1,
    costTier: 1,
  };
}
