/**
 * Probe-model catalog client.
 *
 * Fetches `{ providers: { <slug>: <modelId> } }` from the models-index
 * `/probeModels` endpoint and caches it at `~/.claudish/probe-models.json`.
 * The TUI's "Test Connections" feature uses this to ask the catalog
 * "what model should I send to provider X to verify the link?" instead of
 * carrying stale string literals in source.
 *
 * Selection logic (cheapest active model per provider, tiebreak by recency)
 * lives server-side in models-index — see
 * `models-index/TASK_probe_models_endpoint.md`.
 *
 * Lazy fetch: the first caller to need a probe model triggers a network
 * fetch. Subsequent reads hit the disk cache. On fetch failure the cache
 * stays empty and callers see `null` — the TUI surfaces this as
 * "could not reach model catalog" rather than running with stale data.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PROBE_MODELS_URL =
  "https://us-central1-claudish-6da10.cloudfunctions.net/probeModels";
// 1h TTL (matches the server's own instance cache). A 24h TTL meant a
// server-side catalog correction (e.g. fixing a probe model that 404s) took up
// to a day to reach users. 1h propagates fixes promptly without re-fetching on
// every probe; a stale-but-fresh wrong pick is additionally self-healed by the
// refresh-on-404 path in the TUI (forceRefreshProbeModels).
const CACHE_TTL_MS = 60 * 60 * 1000;
// Generous timeout — the endpoint typically responds in ~400ms, but the TUI
// fires this concurrently with proxy startup and N parallel probe handlers.
// Under load on a cold cache we've seen the network round-trip pushed past
// 5s. 15s matches the per-probe timeout, so the fetch budget is bounded by
// the same UX deadline the user already accepts for a single probe.
const FETCH_TIMEOUT_MS = 15000;

export const PROBE_MODELS_CACHE_PATH = join(
  homedir(),
  ".claudish",
  "probe-models.json"
);

export interface ProbeModelsResponse {
  version: number;
  generatedAt: string;
  providers: Record<string, string>;
}

export type FetchOutcome =
  | { kind: "ok"; data: ProbeModelsResponse }
  | { kind: "timeout" }
  | { kind: "network"; reason: string }
  | { kind: "http"; status: number }
  | { kind: "invalid"; reason: string };

let _inFlight: Promise<FetchOutcome> | null = null;

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
  if (!isValidResponse(raw)) return null;
  return raw;
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
  if (!data?.generatedAt) return false;
  const generatedMs = Date.parse(data.generatedAt);
  if (Number.isNaN(generatedMs)) return false;
  return Date.now() - generatedMs < ttlMs;
}

export async function fetchProbeModels(
  url: string = PROBE_MODELS_URL,
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<FetchOutcome> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e: unknown) {
    const name = (e as { name?: string } | null)?.name ?? "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { kind: "timeout" };
    }
    return {
      kind: "network",
      reason: e instanceof Error ? e.message : String(e),
    };
  }

  if (!response.ok) return { kind: "http", status: response.status };

  let body: unknown;
  try {
    body = await response.json();
  } catch (e: unknown) {
    return {
      kind: "invalid",
      reason: e instanceof Error ? e.message : "json parse error",
    };
  }
  if (!isValidResponse(body)) {
    return { kind: "invalid", reason: "missing providers map" };
  }
  return { kind: "ok", data: body };
}

/**
 * Ensure the probe-models cache is fresh. If the cached file is missing or
 * older than the TTL, fetch fresh data and write it.
 *
 * Concurrent calls share a single in-flight fetch via `_inFlight` so the
 * TUI's parallel "test all" loop only opens one network connection.
 *
 * Returns the outcome so callers can render an error state on failure.
 * Never throws.
 */
export async function ensureProbeModelsCached(): Promise<FetchOutcome> {
  const cached = readProbeModelsCache();
  if (isCacheFresh(cached)) return { kind: "ok", data: cached! };

  if (_inFlight) return _inFlight;

  _inFlight = (async () => {
    const outcome = await fetchProbeModels();
    if (outcome.kind === "ok") writeProbeModelsCache(outcome.data);
    return outcome;
  })();

  try {
    return await _inFlight;
  } finally {
    _inFlight = null;
  }
}

/**
 * Force a re-fetch of the probe catalog, IGNORING the TTL, and overwrite the
 * cache on success. Used as a self-heal when the cached probe model for a
 * provider fails with model-not-found/404 — the catalog may have been corrected
 * server-side while the local cache is still "fresh" by its generatedAt clock.
 *
 * Shares the same in-flight dedupe as ensureProbeModelsCached so a parallel
 * "test all" only triggers ONE forced refetch. Returns the outcome; never throws.
 * On success the in-memory + on-disk cache is updated, so a subsequent
 * getProbeModel() returns the fresh pick.
 */
export async function forceRefreshProbeModels(): Promise<FetchOutcome> {
  if (_inFlight) return _inFlight;

  _inFlight = (async () => {
    const outcome = await fetchProbeModels();
    if (outcome.kind === "ok") writeProbeModelsCache(outcome.data);
    return outcome;
  })();

  try {
    return await _inFlight;
  } finally {
    _inFlight = null;
  }
}

/**
 * Sync lookup of the probe model for a claudish provider slug.
 *
 * The backend `/probeModels` endpoint is the single source of truth and emits
 * one entry per claudish provider name. Direct lookup, no shortcut walking,
 * no fallback heuristics. A missing entry means the catalog doesn't yet have
 * coverage for that slug — that's a backend gap, not a client problem.
 *
 * Returns `null` if no cache, no entry, or invalid entry. Callers must call
 * `ensureProbeModelsCached()` first if they need a fresh fetch.
 */
export function getProbeModel(claudishSlug: string): string | null {
  const cache = readProbeModelsCache();
  if (!cache) return null;
  const entry = cache.providers[claudishSlug];
  return typeof entry === "string" && entry.length > 0 ? entry : null;
}

export interface DiscoveryResult {
  model: string | null;
  /** Why discovery failed (only set when model is null). */
  reason?: string;
}

/**
 * Discover a probe model by asking the provider's endpoint directly.
 *
 * For self-hosted / user-deployed providers (LiteLLM, Ollama, LM Studio,
 * vLLM, MLX, OllamaCloud) the cloud catalog can't enumerate models — each
 * deployment has its own list. The proxy exposes `/v1/probe-discover` which
 * delegates to the provider's transport.discoverProbeModel() method.
 *
 * Returns `{ model, reason? }`. When discovery fails, `reason` carries the
 * proxy's explanation (e.g. "transport does not support discovery", "no
 * model available") so the TUI can surface why.
 */
export async function discoverProbeModelFromEndpoint(
  proxyUrl: string,
  providerSlug: string,
  exclude?: ReadonlySet<string>
): Promise<DiscoveryResult> {
  let response: Response;
  const excludeParam =
    exclude && exclude.size > 0
      ? `&exclude=${encodeURIComponent([...exclude].join(","))}`
      : "";
  try {
    response = await fetch(
      `${proxyUrl}/v1/probe-discover?provider=${encodeURIComponent(providerSlug)}${excludeParam}`,
      { signal: AbortSignal.timeout(8000) }
    );
  } catch (e: unknown) {
    return { model: null, reason: e instanceof Error ? e.message : "fetch failed" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { model: null, reason: `proxy ${response.status} (unparseable body)` };
  }
  const model = (body as { model?: unknown })?.model;
  const reason = (body as { reason?: unknown })?.reason;
  if (typeof model === "string" && model.length > 0) {
    return { model };
  }
  return {
    model: null,
    reason: typeof reason === "string" ? reason : `proxy ${response.status}`,
  };
}

function isValidResponse(raw: unknown): raw is ProbeModelsResponse {
  if (!raw || typeof raw !== "object") return false;
  const data = raw as Record<string, unknown>;
  if (typeof data.version !== "number") return false;
  if (typeof data.generatedAt !== "string") return false;
  if (!data.providers || typeof data.providers !== "object") return false;
  return true;
}
