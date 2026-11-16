import { spyOn } from "bun:test";
import type { EffortLevel } from "../../adapters/base-api-format.js";
import type { AggregatorEntry, ModelIdEffort } from "../../model-loader.js";
export type { ModelIdEffort } from "../../model-loader.js";
import type { SlimModelEntry } from "../all-models-cache.js";
import { catalogRouteForProvider } from "../catalog-route-bindings.js";
import type { DevinModelConfig } from "../devin/devin-models.js";
import * as effortRecommendations from "../effort-recommendations.js";
import type { EffortTable } from "../effort-recommendations.js";

// No-effort selection uses lookupModelEfforts / bundledEffortRecommendations.
// Stub the disk-catalog path and guard lower-level sidecar reads too.
export function stubEffortRecommendations(
  table: () => EffortTable | null = () => null
): () => void {
  const current = spyOn(effortRecommendations, "currentEffortRecommendations").mockImplementation(
    table
  );
  const read = spyOn(effortRecommendations, "readEffortRecommendations").mockImplementation(() => {
    const value = table();
    return value
      ? {
          contractVersion: 3,
          format: 2,
          generations: { [value.generationId]: { writtenAt: 0, efforts: value.efforts } },
        }
      : null;
  });
  const lookup = spyOn(effortRecommendations, "lookupModelEfforts").mockImplementation(
    (modelId, generationId) => {
      const value = table();
      const byTaskType = value?.generationId === generationId ? value.efforts[modelId] : undefined;
      return byTaskType
        ? { ok: true, byTaskType }
        : { ok: false, reason: "model", detail: "No recommendation in test data" };
    }
  );
  return () => {
    lookup.mockRestore();
    read.mockRestore();
    current.mockRestore();
  };
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
