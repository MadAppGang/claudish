/**
 * Live, per-subscription model discovery.
 *
 * Some providers serve a model roster — and per-model context windows — that
 * the cloud catalog CANNOT know statically, because the answer depends on the
 * caller's subscription tier. Kimi Code is the motivating case: `k3` advertises
 * a 1M context window, but only on Allegretto or higher; a Moderato subscriber
 * sending 1M tokens gets a hard 400. The same shape exists for other coding
 * subscriptions.
 *
 * A provider opts in by declaring `modelDiscovery` in its ProviderDefinition.
 * We then call the provider's own authenticated model-listing endpoint, which
 * — because it is authenticated — answers for THIS user's subscription. That
 * is strictly better than modelling tiers locally: tiers get renamed, added,
 * and grandfathered, but the endpoint always reports what the key can do now.
 *
 * Design rules:
 * - **Fail-soft.** Every failure path returns an empty list. Discovery is an
 *   enhancement; it must never block a launch or a picker.
 * - **Nothing hardcoded.** The endpoint is derived from the provider's own
 *   baseUrl (+ env overrides); model ids and windows come from the response.
 * - **Cached.** One network call per provider per TTL, shared process-wide —
 *   the picker, the launcher, and the status line all read the same result.
 */

import { credentials } from "../auth/credentials/authority.js";
import { log } from "../logger.js";
import type { ModelOffer, RosterAxis, RosterEntry } from "./model-resolvers/types.js";
import { getProviderByName } from "./provider-definitions.js";

/** A model as reported by the provider's own live endpoint. */
export interface DiscoveredModel {
  /** Wire id — exactly what goes in the request body's `model` field. */
  id: string;
  /** Human label from the provider (e.g. "K2.7 Coding"), if reported. */
  displayName?: string;
  /** Real context window for THIS subscription, if reported. */
  contextWindow?: number;
  /**
   * ISO date (`YYYY-MM-DD`) derived from the endpoint's `created` timestamp,
   * when it reports a plausible one.
   *
   * NOT an authoritative release date — it is whenever the provider added the
   * model to this account's roster — but for a plan endpoint whose models the
   * public catalog may not list at all, it is the only freshness signal there
   * is, and it orders a roster correctly. The catalog's own `releaseDate` wins
   * wherever it exists; this covers the rest.
   */
  releaseDate?: string;
  /**
   * Variant metadata, for providers that encode knobs INTO their model ids.
   *
   * Most endpoints report a flat list where each id is already the thing a
   * human would choose, and leave all of this undefined. Devin does not: its
   * roster is ~33 models multiplied out by reasoning tier, speed premium, and
   * context window, and it publishes which is which. Carrying that here is what
   * lets `providers/model-resolvers/` fold 170 ids into 42 rows and unfold them
   * again at request time.
   */
  groupLabel?: string;
  family?: string;
  costFactor?: number;
  costTier?: number;
  isFamilyDefault?: boolean;
  isRecommended?: boolean;
  axes?: RosterAxis[];
  offer?: ModelOffer;
  /**
   * Whether the model can call tools, when the endpoint says so.
   *
   * Only Ollama reports it (via its own capability list / name heuristics), and
   * it genuinely varies there — a local embedding or vision-only pull cannot
   * drive Claude Code. Undefined means "not reported", which callers read as
   * yes, since every hosted roster in claudish is tool-capable.
   */
  supportsTools?: boolean;
}

/** A discovered model in the shape the model-resolver seam consumes. */
export function toRosterEntry(model: DiscoveredModel): RosterEntry {
  const { id, ...rest } = model;
  return { wireId: id, ...rest };
}

/**
 * Declares that a provider can list its own models at runtime.
 * `path` is appended to the provider's resolved baseUrl.
 */
export interface ModelDiscoveryDescriptor {
  /** Path appended to the resolved baseUrl (e.g. "/models"). Unused by `devin-connect`. */
  path: string;
  /**
   * Response shape.
   * - `openai-models-list`: `{ data: [{ id, context_length?, display_name?,
   *   created? }] }`. Also accepts `context_window` / `max_context_length`
   *   spellings, since OpenAI-compatible endpoints disagree on the field name.
   *   `created` is unix seconds and feeds `DiscoveredModel.releaseDate`.
   * - `devin-connect`: not an HTTP GET at all — two protobuf rpcs whose
   *   intersection is capability ∩ entitlement. Owned by
   *   `providers/devin/devin-models.ts`; `path` is ignored.
   * - `ollama-tags`: Ollama's `{ models: [{ name, details, … }] }`. Owned by
   *   `providers/ollama-discovery.ts`, which also derives tool support.
   */
  format: "openai-models-list" | "devin-connect" | "ollama-tags";
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

const _cache = new Map<string, { models: DiscoveredModel[]; expiresAt: number }>();

/** Drop cached discovery (after a credential change / TUI hydrate-on-add). */
export function invalidateModelDiscovery(provider?: string): void {
  if (provider) _cache.delete(provider);
  else _cache.clear();
}

/**
 * Resolve a provider's base URL: env override (in catalog order), else the
 * catalog default. Mirrors localBaseUrl() but works for remote providers too.
 */
function resolveBaseUrl(catalogName: string): string | null {
  const def = getProviderByName(catalogName);
  if (!def) return null;
  for (const envVar of def.baseUrlEnvVars ?? []) {
    const v = process.env[envVar];
    if (v) return v.replace(/\/+$/, "");
  }
  return (def.baseUrl || "").replace(/\/+$/, "") || null;
}

/** Pull the context window out of a model row, tolerating field-name drift. */
function readContextWindow(row: Record<string, unknown>): number | undefined {
  for (const field of ["context_length", "context_window", "max_context_length"]) {
    const v = row[field];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

/**
 * Earliest/latest `created` values we will believe, as unix SECONDS:
 * 2000-01-01 .. 2100-01-01. Anything outside is not a seconds-scale timestamp
 * we can use — notably millisecond values (~1.7e12) land far past the ceiling
 * and are rejected rather than silently read as the year 55000.
 */
const MIN_CREATED_SECONDS = 946_684_800;
const MAX_CREATED_SECONDS = 4_102_444_800;

/**
 * Pull an ISO date out of a model row's `created` field (unix seconds).
 *
 * Deliberately strict-but-silent: absent, zero, non-numeric, or implausible
 * values yield undefined rather than a bogus date. A wrong date would sort the
 * picker wrongly and look authoritative doing it, whereas a missing one just
 * falls back to the catalog / id ordering.
 */
function readCreatedDate(row: Record<string, unknown>): string | undefined {
  const raw = row.created;
  const seconds =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(seconds)) return undefined;
  if (seconds < MIN_CREATED_SECONDS || seconds > MAX_CREATED_SECONDS) return undefined;
  const iso = new Date(seconds * 1000).toISOString();
  return iso.slice(0, 10);
}

/** Parse an OpenAI-style `{ data: [...] }` model list. */
function parseOpenAIModelsList(body: unknown): DiscoveredModel[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];

  const models: DiscoveredModel[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const id = row.id;
    if (typeof id !== "string" || id.trim().length === 0) continue;

    const displayName = typeof row.display_name === "string" ? row.display_name : undefined;
    models.push({
      id,
      displayName,
      contextWindow: readContextWindow(row),
      releaseDate: readCreatedDate(row),
    });
  }
  return models;
}

/**
 * List the models this provider serves for the CURRENT credentials.
 *
 * Returns [] when the provider declares no `modelDiscovery`, has no usable
 * credentials, or the endpoint is unreachable/malformed — callers fall back to
 * the cloud catalog.
 */
export async function discoverProviderModels(providerName: string): Promise<DiscoveredModel[]> {
  const cached = _cache.get(providerName);
  if (cached && cached.expiresAt > Date.now()) return cached.models;

  const def = getProviderByName(providerName);
  const descriptor = def?.modelDiscovery;
  if (!def || !descriptor) return [];

  // Devin's roster is not a GET — it is two protobuf rpcs (capability ∩
  // entitlement), owned by the module that speaks that wire. The import is
  // DYNAMIC to keep the codec off the cold-start path and out of a static
  // cycle. (If a third such provider ever appears, replace this branch with a
  // `registerModelDiscoveryFetcher(name, fn)` seam — not worth it for one.)
  if (descriptor.format === "devin-connect") {
    const { getServedDevinModels } = await import("./devin/devin-models.js");
    const served = await getServedDevinModels();
    if (served.length === 0) {
      log(`[model-discovery:${providerName}] no models for this subscription`);
      return [];
    }
    // Carry the full variant metadata, not just id/name/window: the picker
    // folds these 170 uids into ~42 rows and needs the group label, the cost
    // multiplier, the promo, and the vendor's own default flag to do it.
    const { devinRosterEntry } = await import("./model-resolvers/devin.js");
    const models: DiscoveredModel[] = served.map((model) => {
      const { wireId, ...rest } = devinRosterEntry(model);
      return { id: wireId, ...rest };
    });
    log(`[model-discovery:${providerName}] discovered ${models.length} models`);
    _cache.set(providerName, { models, expiresAt: Date.now() + CACHE_TTL_MS });
    return models;
  }

  // Ollama's daemon speaks its own listing shape and carries capability data no
  // OpenAI-compatible list has. Dynamic import keeps it off the cold-start path.
  if (descriptor.format === "ollama-tags") {
    const { fetchOllamaModels } = await import("./ollama-discovery.js");
    const installed = await fetchOllamaModels({ enrichCapabilities: false });
    if (installed.length === 0) return [];
    const models: DiscoveredModel[] = installed.map((model) => ({
      id: model.name,
      displayName: model.name,
      supportsTools: model.supportsTools,
    }));
    log(`[model-discovery:${providerName}] discovered ${models.length} local models`);
    _cache.set(providerName, { models, expiresAt: Date.now() + CACHE_TTL_MS });
    return models;
  }

  const baseUrl = resolveBaseUrl(providerName);
  if (!baseUrl) return [];
  const endpoint = `${baseUrl}${descriptor.path}`;

  // Auth via the credential authority — it owns OAuth-vs-API-key precedence
  // (Kimi Coding prefers an OAuth token over a stale KIMI_CODING_API_KEY) and
  // mints any provider-specific platform headers.
  //
  // A LOCAL provider deliberately does NOT go through it. LM Studio and a
  // localhost Ollama serve unauthenticated; a key is the exception, wanted only
  // when the user has exposed the daemon on their network. Asking the authority
  // would send it hunting through the op:// chain for a key that usually does
  // not exist — measured: listing LM Studio models opened a 1Password handshake
  // and, on a locked Mac, a 30-second unlock wait, to discover nothing. Reading
  // the env var directly is both correct and free.
  let headers: Record<string, string> = {};
  if (def.isLocal) {
    const key = def.apiKeyEnvVar ? process.env[def.apiKeyEnvVar] : undefined;
    if (key) headers = { Authorization: `Bearer ${key}` };
  } else {
    try {
      const auth = await credentials.getRequestAuth(providerName, { model: "" });
      headers = { ...auth.headers };
    } catch (e: unknown) {
      log(`[model-discovery:${providerName}] no credentials, skipping: ${(e as Error)?.message}`);
      return [];
    }
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e: unknown) {
    log(`[model-discovery:${providerName}] fetch failed: ${(e as Error)?.message}`);
    return [];
  }

  if (!response.ok) {
    log(`[model-discovery:${providerName}] HTTP ${response.status} from ${endpoint}`);
    return [];
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    log(`[model-discovery:${providerName}] response was not JSON`);
    return [];
  }

  const models = parseOpenAIModelsList(body);
  if (models.length === 0) {
    log(`[model-discovery:${providerName}] endpoint reachable but listed no models`);
    return [];
  }

  log(
    `[model-discovery:${providerName}] discovered ${models.length} models: ` +
      models.map((m) => `${m.id}(${m.contextWindow ?? "?"})`).join(", ")
  );
  _cache.set(providerName, { models, expiresAt: Date.now() + CACHE_TTL_MS });
  return models;
}

/**
 * Real context window for one model on one provider, from live discovery.
 * Returns undefined when discovery is unavailable or the model isn't listed —
 * callers fall back to the cloud catalog.
 */
export async function discoverContextWindow(
  providerName: string,
  modelId: string
): Promise<number | undefined> {
  const models = await discoverProviderModels(providerName);
  const match = models.find((m) => m.id.toLowerCase() === modelId.toLowerCase());
  return match?.contextWindow;
}

/**
 * Rank a discovered roster for presentation, largest context window first
 * (ties broken alphabetically for determinism). The head of this list is the
 * picker's default.
 *
 * Deliberately a RULE rather than a pinned model id: pinning "k3" today would
 * rot into exactly the `fixedModel: "kimi-for-coding"` bug this replaces —
 * stale the moment the provider ships its next model. A capability-ordered
 * list upgrades itself.
 *
 * This is the PROBE-candidate ordering (`discoverProbeModel`), where widest
 * window first is the point. The model PICKER does not use it for presentation
 * — a plan whose whole roster is 1M collapses to alphabetical — and sorts its
 * rows by release date instead; see `buildDiscoveredModelRows`.
 */
export function rankDiscoveredModels(models: DiscoveredModel[]): DiscoveredModel[] {
  return [...models].sort((a, b) => {
    const diff = (b.contextWindow ?? 0) - (a.contextWindow ?? 0);
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });
}
