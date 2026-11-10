import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../fs-atomic.js";
import { log } from "../logger.js";
import type { AggregatorEntry } from "../model-loader.js";
import { _setBundledListRawForTest, bundledListRaw } from "./bundled-list.js";
import {
  bundledListEnabled,
  bundledListScopeActive,
  catalogReachability,
} from "./catalog-reachability.js";
import {
  type CachedRouteRegistry,
  type ConnectionWire,
  WIRE_REGISTRY_VERSION,
  type WireEvidenceRef,
  isConnectionWire,
  isRouteRegistry,
  isWireApi,
  registryVersionAtLeast,
  routeProfile,
  sanitizeRouteRegistry,
} from "./connection-wire.js";
import { splitOptInConnections } from "./content-use.js";

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
  /** Set on the bundled recommended list only; a catalog read from disk has none. */
  origin?: "bundled";
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

/** One mapped connection {@link reconcileWires} demoted to `wire.status: "unknown"`. */
export interface DemotedWire {
  modelId: string;
  routeId: string;
  routeProfileId: string;
  reason: "missing-wire" | "no-base-url" | "unknown-api";
}

/** One mapped connection {@link reconcileWires} removed because its route profile does not exist. */
export interface DroppedConnection {
  modelId: string;
  routeId: string;
  routeProfileId: string;
  reason: "missing-profile";
}

/** How many reconciled connections the debug log names, besides the counts. */
const RECONCILED_LOG_SAMPLE = 5;

type Verdict =
  | { action: "keep" }
  | { action: "drop"; reason: DroppedConnection["reason"] }
  | { action: "demote"; reason: DemotedWire["reason"] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Fit a model list to its route registry. The registry must belong to the
 * model list's generation, else `null`: a registry of another generation
 * describes other connections. From 3.7.0 each mapped connection is judged on
 * its own, so one connection never keeps the rest of the generation out:
 *
 * - its route profile does not exist: the connection is DROPPED from its entry
 *   (there is no endpoint and no credential silo to send it to); the entry stays;
 * - its `wire` is missing or malformed, its `api` is one claudish does not
 *   implement, or its profile publishes no base URL for that `api`: the wire is
 *   DEMOTED to `{ status: "unknown", evidence }`, which the request path
 *   answers by trying each API in turn.
 *
 * Below 3.7.0 the entries come back unchanged. An entry with nothing changed
 * is returned as the same object.
 */
export function reconcileWires(
  entries: SlimModelEntry[],
  routeRegistry: CachedRouteRegistry,
  catalogGenerationId: string
): { entries: SlimModelEntry[]; demoted: DemotedWire[]; dropped: DroppedConnection[] } | null {
  if (routeRegistry.generationId !== catalogGenerationId) return null;
  const { registry } = routeRegistry;
  if (!registryVersionAtLeast(registry.registryVersion, WIRE_REGISTRY_VERSION)) {
    return { entries, demoted: [], dropped: [] };
  }
  const demoted: DemotedWire[] = [];
  const dropped: DroppedConnection[] = [];
  const judge = (connection: AggregatorEntry): Verdict => {
    if (connection.routeStatus !== "mapped") return { action: "keep" };
    const profile = connection.route ? routeProfile(registry, connection.route) : undefined;
    if (!profile) return { action: "drop", reason: "missing-profile" };
    const wire: unknown = connection.wire;
    if (!isConnectionWire(wire)) {
      const unknownApi =
        isRecord(wire) &&
        wire.status === "known" &&
        typeof wire.api === "string" &&
        !isWireApi(wire.api);
      return { action: "demote", reason: unknownApi ? "unknown-api" : "missing-wire" };
    }
    if (wire.status === "known" && !profile.apis[wire.api]?.baseUrl) {
      return { action: "demote", reason: "no-base-url" };
    }
    return { action: "keep" };
  };
  const reconcileList = <T extends AggregatorEntry[] | null | undefined>(
    modelId: string,
    connections: T
  ): T => {
    if (!Array.isArray(connections)) return connections;
    let changed = false;
    const next: AggregatorEntry[] = [];
    for (const connection of connections) {
      const verdict = judge(connection);
      if (verdict.action === "keep") {
        next.push(connection);
        continue;
      }
      changed = true;
      const ref = {
        modelId,
        routeId: connection.route?.routeId ?? "",
        routeProfileId: connection.route?.routeProfileId ?? "",
      };
      if (verdict.action === "drop") {
        dropped.push({ ...ref, reason: verdict.reason });
        continue;
      }
      demoted.push({ ...ref, reason: verdict.reason });
      const evidence = (connection.wire as { evidence?: unknown } | undefined)?.evidence;
      const wire: ConnectionWire = {
        status: "unknown",
        evidence: Array.isArray(evidence) ? (evidence as WireEvidenceRef[]) : [],
      };
      next.push({ ...connection, wire });
    }
    return (changed ? next : connections) as T;
  };

  // Every row, opt-in included: an explicit contributor request builds from its
  // own connection's wire, so that wire is reconciled like any other.
  const reconciled = entries.map((entry) => {
    const aggregators = reconcileList(entry.modelId, entry.aggregators);
    const optInConnections = reconcileList(entry.modelId, entry.optInConnections);
    if (aggregators === entry.aggregators && optInConnections === entry.optInConnections) {
      return entry;
    }
    return {
      ...entry,
      ...(aggregators !== undefined ? { aggregators } : {}),
      ...(optInConnections !== undefined ? { optInConnections } : {}),
    };
  });

  if (demoted.length > 0 || dropped.length > 0) {
    const changes = [...dropped, ...demoted];
    const sample = changes
      .slice(0, RECONCILED_LOG_SAMPLE)
      .map((d) => `${d.modelId}@${d.routeId}/${d.routeProfileId} (${d.reason})`)
      .join(", ");
    const more = changes.length > RECONCILED_LOG_SAMPLE ? ", ..." : "";
    log(
      `[catalog] reconciled ${catalogGenerationId}: dropped ${dropped.length} connection(s), ` +
        `demoted ${demoted.length} wire(s) to unknown: ${sample}${more}`
    );
  }
  return { entries: reconciled, demoted, dropped };
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
    if (!cached || typeof cached.generationId !== "string" || !isRouteRegistry(cached.registry)) {
      return null;
    }
    const reconciled = reconcileWires(
      data.entries as SlimModelEntry[],
      cached as unknown as CachedRouteRegistry,
      data.catalogGenerationId
    );
    if (!reconciled) return null;
    return { ...(data as unknown as DiskCacheV3), entries: reconciled.entries };
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
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      log(
        `[catalog] unreadable route registry for ${path}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return null;
  }
}

/** The cache with its sidecar registry attached, when that registry fits its generation. */
function withSidecarRegistry(cache: DiskCacheV3, path: string): DiskCacheV3 {
  const registry = readSidecarRegistry(path);
  if (!registry) return cache;
  const reconciled = reconcileWires(cache.entries, registry, cache.catalogGenerationId);
  if (!reconciled) return cache;
  return { ...cache, entries: reconciled.entries, routeRegistry: registry };
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

/**
 * The catalog on disk at `path`, and nothing else. For a reader asking whether a
 * catalog exists or how fresh it is: readiness waits, refresh compare, the memo
 * and the recommended generation checks. The bundled list must not answer those.
 */
export function readDiskCatalog(path: string = ALL_MODELS_CACHE_PATH): DiskCacheV3 | null {
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
  } catch (err) {
    // Memoized under this mtime and size, so logged once per version of the file.
    log(`[catalog] unreadable ${path}: ${err instanceof Error ? err.message : String(err)}`);
    cache = null;
  }
  if (cache && !cache.routeRegistry && side) {
    cache = withSidecarRegistry(cache, path);
  }
  // Validated RAW above (the parse and the sidecar attach both see every row),
  // then split here, before any reader can see it. This is the choke point that
  // keeps a content-use opt-in wire id from being chosen for a user
  // (`content-use.ts`).
  if (cache) cache = { ...cache, entries: cache.entries.map(splitOptInConnections) };
  _readMemo.set(path, { key, cache });
  return cache;
}

/** The parsed bundled list. `undefined`: not read yet. */
let _bundledListMemo: DiskCacheV3 | null | undefined;
let _bundledListLogged = false;

/** Install raw bundled-list JSON for the process; `undefined` restores the shipped file. */
export function _setBundledListForTest(raw: unknown | null | undefined): void {
  _setBundledListRawForTest(raw);
  _bundledListMemo = undefined;
  _bundledListLogged = false;
}

function readBundledList(): DiskCacheV3 | null {
  if (_bundledListMemo !== undefined) return _bundledListMemo;
  const parsed = parseAllModelsCache(bundledListRaw());
  _bundledListMemo = parsed
    ? { ...parsed, entries: parsed.entries.map(splitOptInConnections), origin: "bundled" }
    : null;
  return _bundledListMemo;
}

/**
 * The catalog routing and request building read: the disk catalog of any age, and
 * only when no readable one exists, the bundled recommended list.
 *
 * The bundled list answers the DEFAULT path only (a caller's `path` is its own
 * file), and only once the backend is settled as unreachable, or inside
 * `withBundledListScope`. `CLAUDISH_DISABLE_BUNDLED_LIST=1` turns it off in both.
 * It is never memoized with a disk catalog: nothing outlives the condition.
 */
export function readAllModelsCache(path: string = ALL_MODELS_CACHE_PATH): DiskCacheV3 | null {
  const disk = readDiskCatalog(path);
  if (disk || path !== ALL_MODELS_CACHE_PATH) return disk;
  if (!bundledListEnabled()) return null;
  if (catalogReachability().state !== "unreachable" && !bundledListScopeActive()) return null;
  const bundled = readBundledList();
  if (bundled && !_bundledListLogged) {
    _bundledListLogged = true;
    log(`[catalog] reading the bundled recommended list (${bundled.catalogGenerationId})`);
  }
  return bundled;
}

/**
 * The registry as written to disk: without the API keys claudish does not
 * implement, which an older build's reader rejects outright.
 */
function forDisk(routeRegistry: CachedRouteRegistry): CachedRouteRegistry {
  return { ...routeRegistry, registry: sanitizeRouteRegistry(routeRegistry.registry) };
}

/** Write the registry sidecar for the cache at `path`. */
export function writeRouteRegistry(
  routeRegistry: CachedRouteRegistry,
  path: string = ALL_MODELS_CACHE_PATH
): void {
  writeFileAtomic(routeRegistryPathFor(path), JSON.stringify(forDisk(routeRegistry)));
  _readMemo.delete(path);
}

export function writeAllModelsCache(data: DiskCacheV3, path: string = ALL_MODELS_CACHE_PATH): void {
  if (data.origin === "bundled") throw new Error("the bundled recommended list is never written");
  const routeRegistry = data.routeRegistry ? forDisk(data.routeRegistry) : undefined;
  writeFileAtomic(path, JSON.stringify(routeRegistry ? { ...data, routeRegistry } : data));
  if (routeRegistry) {
    writeFileAtomic(routeRegistryPathFor(path), JSON.stringify(routeRegistry));
  }
  _readMemo.delete(path);
}
