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
import { allConnections, splitOptInConnections } from "./content-use.js";

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
  /**
   * Connections whose wire id opts content into the vendor's product
   * improvement, moved out of `aggregators` when the catalog is read into memory
   * (`splitOptInConnections`, `content-use.ts`). Never written to disk. Only an
   * exact-id reader looks here (`allConnections`); nothing chooses one for a user.
   */
  optInConnections?: AggregatorEntry[];
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
  // Every row, opt-in included: an explicit contributor request builds from its
  // own connection's wire, so that wire is validated like any other.
  return entries.every((entry) =>
    allConnections(entry).every((connection) => {
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

/**
 * Where the route registry for the cache at `path` is kept: a SIDECAR file
 * next to it (`cloud-models-catalog-v3.routes.json`).
 *
 * Its own file because claudish releases before 10.5.0 rewrite the models
 * cache on every refresh and know nothing of the registry: measured
 * 2026-10-14, an installed 10.4.1 in another session replaced the cache with
 * a newer generation and no `routeRegistry`, so the new reader refreshed
 * everything (9.3 s) and the old one erased it again. A sidecar survives them;
 * when its generation no longer matches, only the routes of the cache's
 * generation are fetched (`ensureRouteRegistryReady`).
 */
export function routeRegistryPathFor(path: string): string {
  return path.endsWith(".json") ? `${path.slice(0, -5)}.routes.json` : `${path}.routes.json`;
}

function readSidecarRegistry(path: string): CachedRouteRegistry | null {
  try {
    const raw = JSON.parse(readFileSync(routeRegistryPathFor(path), "utf-8")) as Record<
      string,
      unknown
    >;
    return typeof raw.generationId === "string" && isRouteRegistry(raw.registry)
      ? (raw as unknown as CachedRouteRegistry)
      : null;
  } catch {
    return null;
  }
}

function statOrNull(path: string): { mtimeMs: number; size: number } | null {
  try {
    const { mtimeMs, size } = statSync(path);
    return { mtimeMs, size };
  } catch {
    return null;
  }
}

// The request path reads the cache on every request, and the file is several
// MB. Parsed results are memoized per path, keyed by the mtime and size of the
// cache AND its registry sidecar, so a write to either is seen on the next read.
const _readMemo = new Map<string, { key: string; cache: DiskCacheV3 | null }>();

export function _clearAllModelsCacheMemo(): void {
  _readMemo.clear();
}

export function readAllModelsCache(path: string = ALL_MODELS_CACHE_PATH): DiskCacheV3 | null {
  if (!existsSync(path)) return null;
  const main = statOrNull(path);
  if (!main) return null;
  const side = statOrNull(routeRegistryPathFor(path));
  const key = `${main.mtimeMs}:${main.size}|${side ? `${side.mtimeMs}:${side.size}` : "-"}`;
  const memo = _readMemo.get(path);
  if (memo && memo.key === key) return memo.cache;

  let cache: DiskCacheV3 | null;
  try {
    cache = parseAllModelsCache(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    cache = null;
  }
  if (cache && !cache.routeRegistry && side) {
    const registry = readSidecarRegistry(path);
    if (registry && wiresMatchRegistry(cache.entries, registry, cache.catalogGenerationId)) {
      cache = { ...cache, routeRegistry: registry };
    }
  }
  // Validated RAW above (the parse and the sidecar attach both see every row),
  // then split here, before any reader can see it. This is the choke point that
  // keeps a content-use opt-in wire id from being chosen for a user
  // (`content-use.ts`).
  if (cache) cache = { ...cache, entries: cache.entries.map(splitOptInConnections) };
  _readMemo.set(path, { key, cache });
  return cache;
}

/** Write the registry sidecar for the cache at `path`. */
export function writeRouteRegistry(
  routeRegistry: CachedRouteRegistry,
  path: string = ALL_MODELS_CACHE_PATH
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(routeRegistryPathFor(path), JSON.stringify(routeRegistry), "utf-8");
  _readMemo.delete(path);
}

export function writeAllModelsCache(data: DiskCacheV3, path: string = ALL_MODELS_CACHE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data), "utf-8");
  if (data.routeRegistry) {
    writeFileSync(routeRegistryPathFor(path), JSON.stringify(data.routeRegistry), "utf-8");
  }
  _readMemo.delete(path);
}
