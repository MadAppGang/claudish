/**
 * Resolve the ONE catalog connection a request goes to, with its `wire` and its
 * route profile from the registry of the same generation.
 *
 * A connection is the claudish provider's exact route binding plus the exact
 * wire id. Nothing is matched by family, sibling id or model-level field: when
 * the catalog does not publish this provider for this model, the answer says so
 * and the caller decides, rather than borrowing another connection's wire.
 */
import type { AggregatorEntry } from "../model-loader.js";
import {
  ALL_MODELS_CACHE_PATH,
  type SlimModelEntry,
  readAllModelsCache,
} from "./all-models-cache.js";
import { isMovingPointer } from "./catalog-client.js";
import { type CatalogRouteBinding, catalogRouteForProvider } from "./catalog-route-bindings.js";
import {
  type ConnectionWire,
  type KnownWire,
  type RouteProfile,
  type RouteRegistry,
  type WireApi,
  routeProfile,
  wireRequestUrl,
} from "./connection-wire.js";

export interface ResolvedConnection {
  /** The claudish provider the request is for. */
  provider: string;
  /** The catalog record's canonical model id. */
  modelId: string;
  route: CatalogRouteBinding;
  /** The exact id sent to the provider. */
  externalModelId: string;
  wire: ConnectionWire;
  profile: RouteProfile;
  generationId: string;
  /**
   * The known wire of the model OWNER's own direct connection (the `direct`
   * profile whose `nativeModelProviders` names the model's vendor), when the
   * catalog publishes one and it is not this connection. Used only to TRY a
   * sub-field this connection publishes as `unknown`, on the same API.
   */
  ownerWire?: KnownWire;
}

export type ConnectionResolution =
  | { ok: true; connection: ResolvedConnection }
  | {
      ok: false;
      /**
       * - `not-catalog-routed`: the provider has no route binding (local, custom
       *   endpoint, LiteLLM); its requests are not built from catalog wires.
       * - `no-catalog`: no readable cache.
       * - `no-registry`: a cache written before wires were read; refresh it.
       * - `no-connection`: the catalog does not map this model to this provider.
       */
      reason: "not-catalog-routed" | "no-catalog" | "no-registry" | "no-connection";
    };

function lower(value: string): string {
  return value.toLowerCase();
}

function stripVendorPrefix(id: string): string {
  return id.includes("/") ? id.substring(id.lastIndexOf("/") + 1) : id;
}

function mappedOnRoute(entry: SlimModelEntry, route: CatalogRouteBinding): AggregatorEntry[] {
  return (entry.aggregators ?? []).filter(
    (connection) =>
      connection.routeStatus === "mapped" &&
      connection.route?.routeId === route.routeId &&
      connection.route?.routeProfileId === route.routeProfileId &&
      typeof connection.externalModelId === "string"
  );
}

/**
 * The connection for `modelName` on `route`.
 *
 * 1. A connection whose wire id IS the name: an explicit spec is rewritten to
 *    the provider's wire id before it gets here (`kc@k3`, `or@openai/gpt-6.1-sol`).
 * 2. The record whose canonical id or alias is the name (vendor prefix
 *    dropped), then its exact wire id on that route — never a moving pointer
 *    unless the model's own id is one (same rule as `externalIdFor`).
 */
function findConnection(
  entries: SlimModelEntry[],
  route: CatalogRouteBinding,
  modelName: string
): { entry: SlimModelEntry; connection: AggregatorEntry } | undefined {
  for (const entry of entries) {
    const connection = mappedOnRoute(entry, route).find((c) => c.externalModelId === modelName);
    if (connection) return { entry, connection };
  }

  const name = lower(modelName);
  const bare = stripVendorPrefix(name);
  const entry = entries.find(
    (candidate) =>
      lower(candidate.modelId) === name ||
      lower(candidate.modelId) === bare ||
      candidate.aliases.some((alias) => lower(alias) === name || lower(alias) === bare)
  );
  if (!entry) return undefined;
  const connections = mappedOnRoute(entry, route);
  const connection = isMovingPointer(entry.modelId)
    ? connections[0]
    : connections.find((c) => !isMovingPointer(c.externalModelId as string));
  return connection ? { entry, connection } : undefined;
}

export function resolveConnection(
  provider: string,
  modelName: string,
  cachePath: string = ALL_MODELS_CACHE_PATH
): ConnectionResolution {
  const route = catalogRouteForProvider(provider);
  if (!route) return { ok: false, reason: "not-catalog-routed" };

  const cache = readAllModelsCache(cachePath);
  if (!cache || cache.entries.length === 0) return { ok: false, reason: "no-catalog" };
  if (!cache.routeRegistry) return { ok: false, reason: "no-registry" };

  const found = findConnection(cache.entries, route, modelName);
  if (!found?.connection.wire) return { ok: false, reason: "no-connection" };
  const profile = routeProfile(cache.routeRegistry.registry, route);
  if (!profile) return { ok: false, reason: "no-connection" };

  const ownerWire = findOwnerWire(found.entry, cache.routeRegistry.registry, found.connection);
  return {
    ok: true,
    connection: {
      provider,
      modelId: found.entry.modelId,
      route,
      externalModelId: found.connection.externalModelId as string,
      wire: found.connection.wire,
      profile,
      generationId: cache.routeRegistry.generationId,
      ...(ownerWire ? { ownerWire } : {}),
    },
  };
}

function findOwnerWire(
  entry: SlimModelEntry,
  registry: RouteRegistry,
  self: AggregatorEntry
): KnownWire | undefined {
  const vendor = entry.provider;
  if (!vendor) return undefined;
  const owner = (entry.aggregators ?? []).find((connection) => {
    if (connection === self || connection.routeStatus !== "mapped" || !connection.route)
      return false;
    const profile = routeProfile(registry, connection.route);
    return profile?.kind === "direct" && (profile.nativeModelProviders ?? []).includes(vendor);
  });
  return owner?.wire?.status === "known" ? owner.wire : undefined;
}

/**
 * The route profile a provider is bound to, for a model the catalog does not
 * publish on it: which APIs the host serves, so they can be tried in turn.
 */
export function resolveRouteProfile(
  provider: string,
  cachePath: string = ALL_MODELS_CACHE_PATH
): { route: CatalogRouteBinding; profile: RouteProfile; generationId: string } | undefined {
  const route = catalogRouteForProvider(provider);
  if (!route) return undefined;
  const cache = readAllModelsCache(cachePath);
  if (!cache?.routeRegistry) return undefined;
  const profile = routeProfile(cache.routeRegistry.registry, route);
  return profile ? { route, profile, generationId: cache.routeRegistry.generationId } : undefined;
}

/** The registry base URL for `api` on this connection's profile, if published. */
export function connectionBaseUrl(
  connection: ResolvedConnection,
  api: WireApi
): string | undefined {
  return connection.profile.apis[api]?.baseUrl;
}

/** The full request URL for `api` on this connection, if its profile publishes a base URL. */
export function connectionRequestUrl(
  connection: ResolvedConnection,
  api: WireApi,
  stream = true
): string | undefined {
  const baseUrl = connectionBaseUrl(connection, api);
  return baseUrl ? wireRequestUrl(baseUrl, api, connection.externalModelId, stream) : undefined;
}
