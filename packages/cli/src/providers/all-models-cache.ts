import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AggregatorEntry } from "../model-loader.js";
import {
  type CachedRouteRegistry,
  WIRE_REGISTRY_VERSION,
  isConnectionWire,
  isRouteRegistry,
  registryVersionAtLeast,
  routeProfile,
} from "./connection-wire.js";

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
  /** What the model accepts, from the cloud models catalog. Absent, null or [] means unknown. */
  inputModalities?: string[] | null;
  /** What the model produces. Absent, null or [] means unknown; a list without "text" is not a chat model. */
  outputModalities?: string[] | null;
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
  /**
   * The route registry of the SAME generation (`catalog=routes&generationId=`).
   * Absent in a cache written before claudish read wires; the request path then
   * refreshes the catalog instead of building a request without one.
   */
  routeRegistry?: CachedRouteRegistry;
}

/**
 * The cloud models catalog cache: contract-3 data, in a file of its own.
 *
 * NOT `all-models.json`. That name belongs to older claudish builds, which read
 * it as a v2 catalog; a v3 cache written there crashed them on every bare-name
 * route (`TypeError … entry.sources["openrouter-api"]`, measured 2026-09-19),
 * and it was ALSO the file the MCP server overwrote with an OpenRouter model dump.
 * A contract change gets a new file, so no build ever reads a shape it cannot
 * parse. `all-models.json` is left untouched for the builds that still read it.
 */
export const ALL_MODELS_CACHE_PATH = join(homedir(), ".claudish", "cloud-models-catalog-v3.json");

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

/**
 * A cached registry must belong to the model list's generation, and from 3.7.0
 * every mapped connection must carry a `wire` whose route profile exists and,
 * when known, publishes a base URL for its `api`. One bad connection rejects the
 * whole cache: a partial wire table would send some requests from data and the
 * rest from nothing.
 */
export function wiresMatchRegistry(
  entries: SlimModelEntry[],
  routeRegistry: CachedRouteRegistry,
  catalogGenerationId: string
): boolean {
  if (routeRegistry.generationId !== catalogGenerationId) return false;
  const { registry } = routeRegistry;
  if (!registryVersionAtLeast(registry.registryVersion, WIRE_REGISTRY_VERSION)) return true;
  return entries.every((entry) =>
    (entry.aggregators ?? []).every((connection) => {
      if (connection.routeStatus !== "mapped") return true;
      if (!connection.route || !isConnectionWire(connection.wire)) return false;
      const profile = routeProfile(registry, connection.route);
      if (!profile) return false;
      return connection.wire.status !== "known" || !!profile.apis[connection.wire.api]?.baseUrl;
    })
  );
}

function parseAllModelsCache(raw: unknown): DiskCacheV3 | null {
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
  if (data.routeRegistry !== undefined) {
    const cached = data.routeRegistry as Record<string, unknown> | null;
    if (
      !cached ||
      typeof cached.generationId !== "string" ||
      !isRouteRegistry(cached.registry) ||
      !wiresMatchRegistry(
        data.entries as SlimModelEntry[],
        cached as unknown as CachedRouteRegistry,
        data.catalogGenerationId
      )
    ) {
      return null;
    }
  }
  return data as unknown as DiskCacheV3;
}

// The request path reads the cache on every request, and the file is several
// MB. Parsed results are memoized per path, keyed by mtime and size, so a write
// by `refreshCatalog` or an out-of-band edit is seen on the next read.
const _readMemo = new Map<string, { mtimeMs: number; size: number; cache: DiskCacheV3 | null }>();

export function _clearAllModelsCacheMemo(): void {
  _readMemo.clear();
}

export function readAllModelsCache(path: string = ALL_MODELS_CACHE_PATH): DiskCacheV3 | null {
  if (!existsSync(path)) return null;

  let stat: { mtimeMs: number; size: number };
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  const memo = _readMemo.get(path);
  if (memo && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) return memo.cache;

  let cache: DiskCacheV3 | null;
  try {
    cache = parseAllModelsCache(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    cache = null;
  }
  _readMemo.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, cache });
  return cache;
}

export function writeAllModelsCache(data: DiskCacheV3, path: string = ALL_MODELS_CACHE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data), "utf-8");
  _readMemo.delete(path);
}
