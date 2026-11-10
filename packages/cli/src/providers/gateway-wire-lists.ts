/**
 * The wire ids a gateway serves, asked from the gateway itself.
 *
 * Used only with the bundled recommended list as the catalog source: that list
 * keeps no gateway connections, so a gateway hop has no published wire id. A
 * successful list is held in memory for an hour and refreshed in the background
 * after that. A failure is never held, so a later decision asks again: a
 * transient gateway outage must not read as "this gateway has no such model" for
 * the rest of the session.
 *
 * Matching is exact string equality on the gateway's own `id` values, so this
 * covers OpenRouter-shaped ids (`<vendor>/<canonical model id>`). A gateway that
 * spells the model another way has no match and its hop is withheld, visibly.
 */
import { credentials } from "../auth/credentials/authority.js";
import { log } from "../logger.js";
import { isMovingPointer } from "./catalog-client.js";
import { CATALOG_ROUTE_BINDINGS } from "./catalog-route-bindings.js";
import { type RouteRegistry, routeProfile } from "./connection-wire.js";
import { ensureEndpointsRegistered } from "./endpoint-registration.js";
import { OPENROUTER_MODELS_URL, fetchGatewayModelIds } from "./gateway-models-list.js";
import type { AvailabilityNetwork } from "./model-availability.js";
import { discoverProviderServedIds } from "./model-discovery.js";
import { getProviderByName } from "./provider-definitions.js";

/**
 * One routing decision's view: each gateway's ids, that its list could not be
 * read, or that claudish has no models list to ask for it (`no-list`).
 */
export type GatewayWireLists = ReadonlyMap<string, ReadonlySet<string> | "unreadable" | "no-list">;

/** Whether claudish has a models list it can ask `provider` for. */
function hasModelsList(provider: string): boolean {
  return provider === "openrouter" || Boolean(getProviderByName(provider)?.modelDiscovery);
}

const HELD_LIST_FRESH_MS = 60 * 60 * 1000;
/** Long enough for any one routing decision, which waits at most its own deadline. */
const GATEWAY_LIST_FETCH_TIMEOUT_MS = 5_000;

const heldLists = new Map<string, { ids: ReadonlySet<string>; fetchedAt: number }>();
const runningFetches = new Map<string, Promise<ReadonlySet<string> | null>>();

/**
 * A claudish provider whose catalog route binding is a gateway route, by data:
 * the bound profile's `kind`. A user's custom endpoint has no route binding and
 * is never one, whatever its tier.
 */
export function isGatewayBound(provider: string, registry: RouteRegistry): boolean {
  const binding = CATALOG_ROUTE_BINDINGS[provider];
  return binding !== undefined && routeProfile(registry, binding)?.kind === "gateway";
}

/** The id `ids` publishes for the model, or undefined. Never a moving pointer. */
export function gatewayWireIdFor(
  modelId: string,
  vendor: string | undefined,
  ids: ReadonlySet<string>
): string | undefined {
  const spellings = vendor ? [`${vendor}/${modelId}`, modelId] : [modelId];
  return spellings.find((id) => !isMovingPointer(id) && ids.has(id));
}

async function fetchIdsFor(provider: string): Promise<ReadonlySet<string> | null> {
  if (provider === "openrouter") {
    return fetchGatewayModelIds(OPENROUTER_MODELS_URL, {
      signal: AbortSignal.timeout(GATEWAY_LIST_FETCH_TIMEOUT_MS),
    });
  }
  if (!getProviderByName(provider)?.modelDiscovery) return null;
  const { readiness } = await credentials.describeReadiness(provider, { allowOpPrompt: false });
  if (readiness !== "present") return null;
  const { served, optIn } = await discoverProviderServedIds(provider);
  return new Set([...served, ...optIn].map((model) => model.id));
}

/** The running fetch for `provider`, started when none is. Resolves null on any failure. */
function fetchGatewayList(provider: string): Promise<ReadonlySet<string> | null> {
  const running = runningFetches.get(provider);
  if (running) return running;
  const started = fetchIdsFor(provider)
    .then((ids) => {
      if (!ids || ids.size === 0) return null;
      heldLists.set(provider, { ids, fetchedAt: Date.now() });
      return ids;
    })
    .catch((err: unknown) => {
      log(
        `[routing] ${provider} models list failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    })
    .finally(() => runningFetches.delete(provider));
  runningFetches.set(provider, started);
  return started;
}

/**
 * Each gateway's list for one routing decision. What is held in memory answers at
 * once. With none held, `await` waits for the fetch up to `deadline` and
 * `background` starts it and answers `"unreadable"` without waiting.
 */
export async function loadGatewayWireLists(
  providers: readonly string[],
  network: AvailabilityNetwork,
  deadline: Promise<"deadline">
): Promise<GatewayWireLists> {
  if (providers.length === 0) return new Map();
  ensureEndpointsRegistered();
  const listFor = async (
    provider: string
  ): Promise<ReadonlySet<string> | "unreadable" | "no-list"> => {
    if (!hasModelsList(provider)) return "no-list";
    const held = heldLists.get(provider);
    if (held) {
      if (Date.now() - held.fetchedAt >= HELD_LIST_FRESH_MS) void fetchGatewayList(provider);
      return held.ids;
    }
    const fetching = fetchGatewayList(provider);
    if (network === "background") return "unreadable";
    const result = await Promise.race([fetching, deadline]);
    return result === "deadline" || result === null ? "unreadable" : result;
  };
  const answers = await Promise.all(
    providers.map(async (provider) => [provider, await listFor(provider)] as const)
  );
  return new Map(answers);
}

export function _resetGatewayWireListsForTest(): void {
  heldLists.clear();
  runningFetches.clear();
}
