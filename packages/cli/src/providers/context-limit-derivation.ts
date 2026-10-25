/**
 * #651 — derive `contextLimit` from the endpoint's OWN `/v1/models`.
 *
 * Measured 2026-10-24 (hub): the declared window (262 144) agreed with the
 * engine — by coincidence. Nothing in the proxy had ever read `max_model_len`
 * (grep: it appeared in no production source), so the number backing the #441
 * dynamic clamp and the #565 admission census was a literal a human typed.
 * Swap the served model, add a second name with a different window, or rebuild
 * the engine with a smaller `--max-model-len`, and the declared value keeps
 * lying — silently, and in the dangerous direction (a declared window LARGER
 * than the real one admits requests that die upstream; a smaller one refuses
 * requests that would have been served).
 *
 * Opt-in per endpoint (`deriveContextLimit: true`, #651). Off by default: an
 * endpoint that says nothing keeps its config value and boots byte-identically
 * (zero probes, zero wire bytes).
 *
 * A probe that fails — non-2xx, network error, no `max_model_len` anywhere, or
 * two served models that disagree — reports "not derived" and leaves the
 * config value in place. It NEVER substitutes a default: an absent measurement
 * coerced into a number is invented evidence (same class as the missing-sample
 * rule that already governs the census).
 *
 * The derived limit lands in the runtime registry (`registerDeclaredContextLimit`)
 * — the single place the census reads and the handler builders look up — so one
 * startup probe moves the declared window everywhere it is used.
 */

import { CustomEndpointSchema, type CustomEndpoint } from "../config-schema.js";
import type { ClaudishProfileConfig } from "../profile-config.js";
import { log, logStderr } from "../logger.js";
import { registerDeclaredContextLimit, registerDerivedContextLimit } from "./runtime-providers.js";
import { resolveCustomEndpointApiKey, customEndpointCapKey } from "./custom-endpoints-loader.js";
import { forgetOverflowCapsForProvider } from "../handlers/shared/context-overflow.js";

/** One entry of a `/v1/models` answer, as far as this module cares. */
export interface CatalogModelEntry {
  id: string;
  /** vLLM publishes the engine's total window here (`--max-model-len`). */
  maxModelLen?: number;
}

/** Result for ONE opted-in endpoint. */
export interface ContextLimitOutcome {
  name: string;
  derived: boolean;
  /** Window now in effect (the config fallback when not derived). */
  limit?: number;
  /** Why it was not derived — never a default in disguise. */
  reason?: string;
  /**
   * The overflow-cap key a handler for this endpoint records under — the
   * transport's displayName, NOT the config key (#660 r2). The purge below
   * uses this, never `name`, so both sides of the seam stay one key apart
   * from zero drift.
   */
  capKey: string;
}

export interface DeriveContextLimitsOptions {
  fetchImpl?: typeof fetch;
  /** Per-endpoint probe budget. Startup must never hang on a dead engine. */
  timeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

/**
 * The `/v1/models` URL for an endpoint, derived from the path it already uses.
 *
 * Both endpoint shapes carry a CHAT path rather than a base-URL convention:
 * `.../v1` + `/chat/completions` (simple), or a full `/v1/chat/completions`
 * (complex). Replacing the terminal segment keeps the `/v1` prefix the operator
 * declared instead of appending a second one.
 */
export function modelsUrlFor(baseUrl: string, apiPath: string | undefined): string {
  const base = baseUrl.replace(/\/+$/, "");
  const path = (apiPath ?? "/chat/completions").replace(/\/+$/, "");
  for (const suffix of ["/chat/completions", "/messages"]) {
    if (path.endsWith(suffix)) return base + path.slice(0, -suffix.length) + "/models";
  }
  return base + "/v1/models";
}

/**
 * Parse a `/v1/models` body into entries. Accepts the OpenAI shape
 * (`{data:[…]}`, what vLLM serves), a bare array, and Ollama's `{models:[…]}`.
 * Unparseable input yields an empty list — the caller reports "not derived".
 */
export function parseCatalogModels(raw: unknown): CatalogModelEntry[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as any)?.data)
      ? (raw as any).data
      : Array.isArray((raw as any)?.models)
        ? (raw as any).models
        : [];
  const out: CatalogModelEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const id = typeof (item as any).id === "string" ? (item as any).id : undefined;
    if (!id) continue;
    // vLLM: `max_model_len` on the entry. Ollama-style catalogs publish nothing
    // comparable — absent, and reported as such.
    const rawLen = (item as any).max_model_len;
    const maxModelLen = typeof rawLen === "number" && Number.isFinite(rawLen) && rawLen > 0 ? rawLen : undefined;
    out.push({ id, maxModelLen });
  }
  return out;
}

/**
 * Choose ONE window from a catalog, or say why it cannot be chosen.
 *
 * Resolution order: the endpoint's declared `models` list (exact ids), then its
 * `modelPrefix`, then the whole served universe when every entry agrees. Two
 * entries that disagree with no selector is `ambiguous` — picking the largest
 * would over-admit, the smallest would refuse served requests; neither is a
 * measurement of the route the request will take.
 */
export function pickMaxModelLen(
  entries: readonly CatalogModelEntry[],
  ep: Pick<CustomEndpoint, "models" | "modelPrefix">
): { limit?: number; reason?: string } {
  if (entries.length === 0) return { reason: "/v1/models returned no recognisable model entries" };
  const withLen = entries.filter(
    (e) => e.maxModelLen !== undefined && Number.isFinite(e.maxModelLen) && e.maxModelLen > 0
  );
  if (withLen.length === 0) {
    return { reason: `/v1/models lists ${entries.length} model(s), none carries max_model_len` };
  }

  const agree = (subset: readonly CatalogModelEntry[], selector: string): { limit?: number; reason?: string } => {
    const values = Array.from(new Set(subset.map((e) => e.maxModelLen!))).sort((a, b) => a - b);
    if (values.length === 1) return { limit: values[0] };
    return { reason: `${selector} disagree(s) on max_model_len (${values.join(", ")}) — no single window to declare` };
  };

  const declared = ep.models ?? [];
  if (declared.length > 0) {
    const hit = withLen.filter((e) => declared.includes(e.id));
    if (hit.length > 0) return agree(hit, `declared model(s) ${hit.map((e) => e.id).join(", ")}`);
  }
  if (ep.modelPrefix) {
    const hit = withLen.filter((e) => e.id.startsWith(ep.modelPrefix!));
    if (hit.length > 0) return agree(hit, `models matching prefix '${ep.modelPrefix}'`);
  }
  return agree(withLen, `${withLen.length} served model(s)`);
}

function catalogHeaders(ep: CustomEndpoint, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (ep.kind === "complex" && ep.authScheme === "x-api-key") headers["x-api-key"] = apiKey;
  else if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (ep.kind === "complex" && ep.headers) Object.assign(headers, ep.headers);
  return headers;
}

function endpointBaseUrl(ep: CustomEndpoint): string {
  return ep.kind === "simple" ? ep.url : ep.baseUrl;
}

function endpointApiPath(ep: CustomEndpoint): string {
  // Mirrors `buildProviderDefinition`: the simple shape appends
  // `/chat/completions` to a URL that already carries `/v1`, the complex shape
  // defaults to the full `/v1/chat/completions` path.
  return ep.kind === "simple" ? "/chat/completions" : (ep.apiPath ?? "/v1/chat/completions");
}

/**
 * Probe every endpoint that opted in (`deriveContextLimit: true`) and register
 * the window it reports. Never throws, never blocks startup for longer than the
 * per-endpoint timeout, and touches nothing when no endpoint opted in.
 */
export async function deriveContextLimits(
  config: ClaudishProfileConfig,
  opts: DeriveContextLimitsOptions = {}
): Promise<ContextLimitOutcome[]> {
  const raw = (config as { customEndpoints?: unknown }).customEndpoints;
  if (!raw || typeof raw !== "object") return [];
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const outcomes: ContextLimitOutcome[] = [];

  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    let ep: CustomEndpoint;
    try {
      ep = CustomEndpointSchema.parse(entry);
    } catch {
      continue; // the loader already reported the validation failure
    }
    if (!(ep as { deriveContextLimit?: boolean }).deriveContextLimit) continue;

    const base = endpointBaseUrl(ep);
    const url = modelsUrlFor(base, endpointApiPath(ep));
    const fallback = ep.contextLimit;
    // #660 r2 — computed once per endpoint, pure. Attached to EVERY outcome
    // (derived or not) so consumers never re-derive the key from `name`.
    const capKey = customEndpointCapKey(name, ep);
    try {
      const response = await doFetch(url, {
        method: "GET",
        headers: catalogHeaders(ep, resolveCustomEndpointApiKey(ep)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const reason = `/v1/models answered HTTP ${response.status}`;
        logStderr(`[ContextLimit] not derived provider=${name} reason="${reason}"${fallback ? ` — keeping declared ${fallback}` : ""}`);
        outcomes.push({ name, derived: false, limit: fallback, reason, capKey });
        continue;
      }
      const entries = parseCatalogModels(await response.json());
      const picked = pickMaxModelLen(entries, ep);
      if (picked.limit === undefined) {
        const reason = picked.reason ?? "no window could be chosen";
        logStderr(`[ContextLimit] not derived provider=${name} reason="${reason}"${fallback ? ` — keeping declared ${fallback}` : ""}`);
        outcomes.push({ name, derived: false, limit: fallback, reason, capKey });
        continue;
      }
      registerDeclaredContextLimit(name, picked.limit);
      // #651 — the MEASURED window, registered apart from the claim: only this
      // one is allowed to pre-seed the learned cap / refuse locally on its own
      // authority (see runtime-providers.registerDerivedContextLimit).
      registerDerivedContextLimit(name, picked.limit);
      log(
        `[ContextLimit] derived provider=${name} limit=${picked.limit} source=${url} max_model_len` +
          (fallback !== undefined ? ` (config said ${fallback})` : "")
      );
      outcomes.push({ name, derived: true, limit: picked.limit, capKey });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logStderr(`[ContextLimit] not derived provider=${name} reason="${reason}"${fallback ? ` — keeping declared ${fallback}` : ""}`);
      outcomes.push({ name, derived: false, limit: fallback, reason, capKey });
    }
  }

  return outcomes;
}

/**
 * #660 r1/r2 — drop the restored learned caps a SUCCEEDED derivation replaces.
 *
 * The purge key is `outcome.capKey` (the transport displayName a handler
 * records under), never `outcome.name`: for a lowercase custom endpoint the
 * two differ ("vllm-myia" vs "Vllm-myia"), and r2 measured that mismatch
 * purging exactly nothing. Extracted from createProxyServer so the startup
 * path and the test pin run the same loop, byte for byte.
 *
 * @returns the number of caps dropped (memory + persisted file), for the log line.
 */
export function purgeCapsReplacedByDerivation(outcomes: readonly ContextLimitOutcome[]): number {
  let capsPurged = 0;
  for (const outcome of outcomes) {
    if (!outcome.derived) continue;
    capsPurged += forgetOverflowCapsForProvider(outcome.capKey);
  }
  return capsPurged;
}
