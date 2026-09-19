import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { providerForCatalogRoute } from "./catalog-route-bindings.js";
import { CATALOG_V3_ACCEPT, parseCatalogV3Envelope } from "./catalog-v3.js";

const PROBE_MODELS_URL = "https://us-central1-claudish-6da10.cloudfunctions.net/probeModels";
const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;

export const PROBE_MODELS_CACHE_PATH = join(homedir(), ".claudish", "probe-models.json");

export interface ProbeModelsResponse {
  version: 3;
  generationId: string;
  generatedAt: string;
  providers: Record<string, string>;
  unavailable: Record<string, string>;
}

interface ProbeRoute {
  modelId: string;
  externalModelId: string;
  route: { routeId: string; routeProfileId: string };
}

interface ProbeData {
  routes: Record<string, ProbeRoute>;
  unavailableRoutes: Record<
    string,
    { route: { routeId: string; routeProfileId: string }; reason: string }
  >;
}

export type FetchOutcome =
  | { kind: "ok"; data: ProbeModelsResponse }
  | { kind: "timeout" }
  | { kind: "network"; reason: string }
  | { kind: "http"; status: number }
  | { kind: "invalid"; reason: string }
  | { kind: "incompatible"; serverContractVersion: number | null };

let _inFlight: Promise<FetchOutcome> | null = null;

export function describeProbeCatalogFailure(
  outcome: Exclude<FetchOutcome, { kind: "ok" }>
): string {
  switch (outcome.kind) {
    case "incompatible":
      return outcome.serverContractVersion === null
        ? "model catalog contract is not supported by this build"
        : `model catalog contract v${outcome.serverContractVersion} is not supported by this build`;
    case "http":
      return `model catalog returned HTTP ${outcome.status}`;
    case "timeout":
      return "could not reach model catalog (timeout)";
    case "network":
      return `could not reach model catalog (${outcome.reason})`;
    case "invalid":
      return `model catalog response unreadable (${outcome.reason})`;
  }
}

export function readProbeModelsCache(
  path: string = PROBE_MODELS_CACHE_PATH
): ProbeModelsResponse | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
  return isValidResponse(raw) ? raw : null;
}

export function writeProbeModelsCache(
  data: ProbeModelsResponse,
  path: string = PROBE_MODELS_CACHE_PATH
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data), "utf-8");
}

export function isCacheFresh(
  data: ProbeModelsResponse | null,
  ttlMs: number = CACHE_TTL_MS
): boolean {
  if (!data) return false;
  const generatedMs = Date.parse(data.generatedAt);
  return !Number.isNaN(generatedMs) && Date.now() - generatedMs < ttlMs;
}

export async function fetchProbeModels(
  url: string = PROBE_MODELS_URL,
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<FetchOutcome> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: CATALOG_V3_ACCEPT },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") return { kind: "timeout" };
    return { kind: "network", reason: error instanceof Error ? error.message : String(error) };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.status === 426) {
      return { kind: "incompatible", serverContractVersion: null };
    }
    return response.ok
      ? { kind: "invalid", reason: "json parse error" }
      : { kind: "http", status: response.status };
  }

  const statedVersion =
    body &&
    typeof body === "object" &&
    typeof (body as { contractVersion?: unknown }).contractVersion === "number"
      ? (body as { contractVersion: number }).contractVersion
      : null;
  if (response.status === 426 || (statedVersion !== null && statedVersion !== 3)) {
    return { kind: "incompatible", serverContractVersion: statedVersion };
  }
  if (!response.ok) return { kind: "http", status: response.status };

  const envelope = parseCatalogV3Envelope<ProbeData>(body);
  if (
    !envelope ||
    !envelope.data.routes ||
    typeof envelope.data.routes !== "object" ||
    !envelope.data.unavailableRoutes ||
    typeof envelope.data.unavailableRoutes !== "object"
  ) {
    return { kind: "invalid", reason: "missing route maps" };
  }

  const providers: Record<string, string> = {};
  for (const route of Object.values(envelope.data.routes)) {
    if (!route || typeof route !== "object" || typeof route.externalModelId !== "string") continue;
    const provider = providerForCatalogRoute(route.route);
    if (provider) providers[provider] = route.externalModelId;
  }
  const unavailable: Record<string, string> = {};
  for (const route of Object.values(envelope.data.unavailableRoutes)) {
    if (!route || typeof route !== "object" || typeof route.reason !== "string") continue;
    const provider = providerForCatalogRoute(route.route);
    if (provider) unavailable[provider] = route.reason;
  }
  if (Object.keys(providers).length + Object.keys(unavailable).length === 0) {
    return { kind: "invalid", reason: "no supported probe routes" };
  }

  return {
    kind: "ok",
    data: {
      version: 3,
      generationId: envelope.generationId,
      generatedAt: envelope.generatedAt,
      providers,
      unavailable,
    },
  };
}

export async function ensureProbeModelsCached(): Promise<FetchOutcome> {
  const cached = readProbeModelsCache();
  if (isCacheFresh(cached)) return { kind: "ok", data: cached! };
  if (_inFlight) return _inFlight;
  _inFlight = fetchAndCacheProbeModels();
  try {
    return await _inFlight;
  } finally {
    _inFlight = null;
  }
}

export async function forceRefreshProbeModels(): Promise<FetchOutcome> {
  if (_inFlight) return _inFlight;
  _inFlight = fetchAndCacheProbeModels();
  try {
    return await _inFlight;
  } finally {
    _inFlight = null;
  }
}

async function fetchAndCacheProbeModels(): Promise<FetchOutcome> {
  const outcome = await fetchProbeModels();
  if (outcome.kind === "ok") writeProbeModelsCache(outcome.data);
  return outcome;
}

export function getProbeModel(claudishSlug: string): string | null {
  const value = readProbeModelsCache()?.providers[claudishSlug];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function getProbeUnavailability(claudishSlug: string): string | null {
  return readProbeModelsCache()?.unavailable[claudishSlug] ?? null;
}

export interface DiscoveryResult {
  model: string | null;
  reason?: string;
}

export async function discoverProbeModelFromEndpoint(
  proxyUrl: string,
  providerSlug: string,
  exclude?: ReadonlySet<string>
): Promise<DiscoveryResult> {
  let response: Response;
  const excludeParam =
    exclude && exclude.size > 0 ? `&exclude=${encodeURIComponent([...exclude].join(","))}` : "";
  try {
    response = await fetch(
      `${proxyUrl}/v1/probe-discover?provider=${encodeURIComponent(providerSlug)}${excludeParam}`,
      { signal: AbortSignal.timeout(8000) }
    );
  } catch (error) {
    return { model: null, reason: error instanceof Error ? error.message : "fetch failed" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { model: null, reason: `proxy ${response.status} (unparseable body)` };
  }
  const model = (body as { model?: unknown })?.model;
  const reason = (body as { reason?: unknown })?.reason;
  if (typeof model === "string" && model.length > 0) return { model };
  return { model: null, reason: typeof reason === "string" ? reason : `proxy ${response.status}` };
}

function isValidResponse(raw: unknown): raw is ProbeModelsResponse {
  if (!raw || typeof raw !== "object") return false;
  const data = raw as Record<string, unknown>;
  return (
    data.version === 3 &&
    typeof data.generationId === "string" &&
    data.generationId.length > 0 &&
    typeof data.generatedAt === "string" &&
    !!data.providers &&
    typeof data.providers === "object" &&
    !!data.unavailable &&
    typeof data.unavailable === "object"
  );
}
