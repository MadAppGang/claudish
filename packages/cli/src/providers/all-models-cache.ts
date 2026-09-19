import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AggregatorEntry } from "../model-loader.js";

export type ReasoningControl = "toggle" | "effort" | "adaptive" | "budget" | "none";

export interface ReasoningCapability {
  supported: boolean;
  control?: ReasoningControl;
  mandatory?: boolean;
  efforts?: string[];
  defaultEffort?: string;
  supportsBudgetTokens?: boolean;
}

export interface RouteVariant {
  kind: string;
  baseModelId?: string;
  familyId?: string;
  provider?: string;
  preset?: string;
  isDefault?: boolean;
}

export interface ModelEndpoint {
  api?: string;
  toolsWithReasoning?: string;
}

export interface SlimModelEntry {
  contractVersion?: 3;
  modelId: string;
  displayName?: string;
  provider?: string;
  aliases: string[];
  status?: string;
  releaseDate?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningStatus?: "known" | "unknown";
  reasoning?: ReasoningCapability;
  supportsVision?: boolean;
  supportsTools?: boolean;
  supportsThinking?: boolean;
  videoInput?: boolean;
  videoOutput?: boolean;
  aggregators?: AggregatorEntry[];
  subscriptionPlanIds?: string[];
  tokenParam?: string;
  routeVariant?: RouteVariant;
  endpoints?: Record<string, ModelEndpoint>;
}

export function reasoningStatusOf(entry: SlimModelEntry): "known" | "unknown" {
  if (entry.reasoningStatus === "known" || entry.reasoningStatus === "unknown") {
    return entry.reasoningStatus;
  }
  return entry.reasoning !== undefined ? "known" : "unknown";
}

export type SubscriptionModelDiscovery = "catalog" | "client" | "hybrid";

export interface CachedPlanInclusion {
  kind: string;
  sourceText?: string;
  provider?: string;
  externalModelId?: string;
  resolution?: { status: "mapped"; modelId: string } | { status: "missing" | "ambiguous" };
}

export interface CachedSubscriptionPlan {
  contractVersion?: 3;
  id: string;
  provider?: string;
  modelDiscovery?: SubscriptionModelDiscovery;
  routeStatus: "supported" | "unsupported" | "unknown";
  route?: { routeId: string; routeProfileId: string };
  routeReason?: string;
  inclusions?: CachedPlanInclusion[];
}

export interface DiskCacheV3 {
  version: 3;
  lastUpdated: string;
  entries: SlimModelEntry[];
  models: Array<{ id: string }>;
  plans: CachedSubscriptionPlan[];
  catalogGenerationId: string;
}

export const ALL_MODELS_CACHE_PATH = join(homedir(), ".claudish", "all-models.json");

function hasRoute(value: unknown): value is { routeId: string; routeProfileId: string } {
  if (!value || typeof value !== "object") return false;
  const route = value as Record<string, unknown>;
  return typeof route.routeId === "string" && typeof route.routeProfileId === "string";
}

export function isSlimModelEntry(value: unknown): value is SlimModelEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.modelId !== "string" ||
    !Array.isArray(entry.aliases) ||
    !entry.aliases.every((alias) => typeof alias === "string")
  )
    return false;
  if (
    entry.subscriptionPlanIds !== undefined &&
    (!Array.isArray(entry.subscriptionPlanIds) ||
      !entry.subscriptionPlanIds.every((id) => typeof id === "string"))
  )
    return false;
  if (entry.aggregators === undefined) return true;
  if (!Array.isArray(entry.aggregators)) return false;
  return entry.aggregators.every((candidate: unknown) => {
    if (!candidate || typeof candidate !== "object") return false;
    const connection = candidate as Record<string, unknown>;
    return connection.routeStatus === "mapped"
      ? hasRoute(connection.route) &&
          typeof connection.externalModelId === "string" &&
          connection.externalModelId.length > 0
      : connection.routeStatus === "unknown" || connection.routeStatus === "unsupported";
  });
}

export function isCachedSubscriptionPlan(value: unknown): value is CachedSubscriptionPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Record<string, unknown>;
  return (
    typeof plan.id === "string" &&
    plan.id.length > 0 &&
    (plan.routeStatus === "supported"
      ? hasRoute(plan.route)
      : plan.routeStatus === "unsupported" || plan.routeStatus === "unknown") &&
    (plan.modelDiscovery === undefined ||
      ["catalog", "client", "hybrid"].includes(String(plan.modelDiscovery)))
  );
}

export function readAllModelsCache(path: string = ALL_MODELS_CACHE_PATH): DiskCacheV3 | null {
  if (!existsSync(path)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }

  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (
    data.version !== 3 ||
    typeof data.lastUpdated !== "string" ||
    typeof data.catalogGenerationId !== "string" ||
    data.catalogGenerationId.length === 0 ||
    !Array.isArray(data.entries) ||
    !data.entries.every(isSlimModelEntry) ||
    !Array.isArray(data.models) ||
    !Array.isArray(data.plans) ||
    !data.plans.every(isCachedSubscriptionPlan)
  ) {
    return null;
  }

  return data as unknown as DiskCacheV3;
}

export function writeAllModelsCache(data: DiskCacheV3, path: string = ALL_MODELS_CACHE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data), "utf-8");
}
