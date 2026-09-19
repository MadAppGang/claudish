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
import { VERSION } from "../version.js";
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
   * Ignore the CATALOG's release date for this row, ordering it by the version
   * encoded in its id instead.
   *
   * For a roster of tuned VARIANTS the catalog does not list, a catalog date is
   * not a fresher signal — it is a date for a DIFFERENT model. Antigravity is
   * the case: measured 2026-08-24, 6 of its 19 served ids had a catalog date and
   * every one of those six was an OLD base model, while every new variant had
   * none:
   *
   *     dated    gemini-2.5-flash          2025-04-17
   *     dated    gemini-3-flash            2025-12-17
   *     UNDATED  gemini-3.6-flash-high            —
   *     UNDATED  gemini-3.7-flash-tiered          —
   *
   * `compareByReleaseDateDesc` puts undated rows after dated ones, so a 2025
   * model sat at the top of the picker and the newest model on the plan sat at
   * the bottom — the exact complaint that prompted this. With the catalog date
   * suppressed the whole roster falls through to the version-parts rule and
   * orders 3.7 > 3.6 > 3.5 > 3.1 > 3 > 2.5, which is what the user meant by
   * "newest first".
   */
  ignoreCatalogReleaseDate?: boolean;
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
   * - `antigravity`: an OAuth POST to `v1internal:fetchAvailableModels`, not a
   *   GET, so `path` is ignored. Owned by `auth/antigravity-user.ts`. Exists
   *   because the response carries a per-subscription `maxTokens` that the
   *   shared catalog contradicts — see the branch below.
   */
  format: "openai-models-list" | "devin-connect" | "ollama-tags" | "antigravity";
}

/**
 * A roster fetcher for a format this module does not know how to speak.
 *
 * Returning `[]` means "asked, got nothing" — the caller records an
 * `empty-roster` failure. Throwing is also fine; the caller converts it.
 */
export type ModelDiscoveryFetcher = (providerName: string) => Promise<DiscoveredModel[]>;

const _fetchers = new Map<string, ModelDiscoveryFetcher>();

/**
 * Register a fetcher for a non-GET discovery format.
 *
 * This is the seam the devin branch predicted: "If a third such provider ever
 * appears, replace this branch with a `registerModelDiscoveryFetcher(name, fn)`
 * seam — not worth it for one." Antigravity was the third, so it exists now.
 *
 * The inversion is the point. Before, this generic module had to KNOW about
 * Devin's protobuf rpcs, Antigravity's OAuth POST and Ollama's daemon shape,
 * and adding provider #4 meant editing a file that has nothing to do with
 * provider #4. Now each owner declares itself and this module knows none of
 * them — the same dependency direction the merged provider table just took, and
 * for the same reason: a registration cannot be forgotten in a second place,
 * because there is no second place.
 *
 * Registration is idempotent by name; the last writer wins, so a test can
 * substitute a fetcher without unregistering first.
 */
export function registerModelDiscoveryFetcher(
  format: string,
  fetcher: ModelDiscoveryFetcher
): void {
  _fetchers.set(format, fetcher);
}

/** The fetcher for a format, or undefined when nothing claims it. */
export function getModelDiscoveryFetcher(format: string): ModelDiscoveryFetcher | undefined {
  return _fetchers.get(format);
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

const _cache = new Map<string, { models: DiscoveredModel[]; expiresAt: number }>();

/**
 * Why a discovery attempt produced nothing.
 *
 * `discoverProviderModels` is fail-soft by contract — it must never block a
 * launch or a picker — but for a long time "fail-soft" also meant "fail
 * SILENT": all five failure modes below collapsed into the same empty array
 * behind a `--debug`-only log line. Callers could not tell "your API key was
 * rejected" from "this provider genuinely publishes no roster", so the picker
 * rendered a rejected credential as a free-text prompt, which reads as a
 * feature rather than an error. (Measured on qwen-token-plan: a 401 from Alibaba's
 * plan host was indistinguishable in the UI from a provider with no list.)
 *
 * The kinds are ordered by what the user should do about them, not by HTTP
 * status: `unauthorized` and `no-credentials` are setup problems the user can
 * fix, `unreachable` and `http-error` are usually transient, and
 * `empty-roster` means the endpoint answered correctly with nothing to offer —
 * the only kind where falling through to a catalog or free-text entry is the
 * genuinely right response.
 */
export type DiscoveryFailureKind =
  | "no-credentials"
  | "unauthorized"
  | "http-error"
  | "unreachable"
  | "malformed"
  | "empty-roster";

export interface DiscoveryFailure {
  kind: DiscoveryFailureKind;
  provider: string;
  /** Full URL that was attempted, when discovery got as far as building one. */
  endpoint?: string;
  /** HTTP status, for `unauthorized` / `http-error`. */
  status?: number;
  /** Upstream message or exception text, already truncated for display. */
  detail?: string;
}

/**
 * Last failure per provider.
 *
 * Deliberately NOT part of the `_cache` entry: successes are cached for a TTL
 * while failures are re-attempted on every call, so the two have different
 * lifetimes. Recorded on every failing path and CLEARED on success, so a stale
 * reason can never outlive the condition that produced it — the same
 * run-scoped, in-memory rationale as `recordOpFailure` in `onepassword.ts`.
 */
const _failures = new Map<string, DiscoveryFailure>();

function recordFailure(failure: DiscoveryFailure): DiscoveredModel[] {
  _failures.set(failure.provider, failure);
  log(`[model-discovery:${failure.provider}] ${describeDiscoveryFailure(failure)}`);
  return [];
}

/**
 * Why the last `discoverProviderModels(provider)` call returned nothing, or
 * undefined if it succeeded (or was never called).
 */
export function getDiscoveryFailure(provider: string): DiscoveryFailure | undefined {
  return _failures.get(provider);
}

/**
 * Whether a header set actually carries a credential.
 *
 * Case-insensitive because the header name is chosen by each transport —
 * `authorization` lowercase on some, `Authorization` on others, `x-api-key` on
 * the Anthropic-shaped ones. A non-empty VALUE is required: an empty string is
 * what an unresolved credential looks like, and it authenticates nothing.
 */
function hasAuthHeader(headers: Record<string, string>): boolean {
  return Object.entries(headers).some(
    ([name, value]) =>
      /^(authorization|x-api-key|api-key)$/i.test(name) && (value ?? "").trim().length > 0
  );
}

/** Truncate upstream error text to one readable line. */
function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * A discovery failure as a single human-readable sentence.
 *
 * Names the endpoint for anything network-shaped, because "check your API key"
 * without saying WHICH host rejected it is exactly the advice that sent this
 * bug's investigation to the wrong provider for hours — Alibaba serves several
 * mutually-isolated plan hosts, and a key valid for one is rejected by all the
 * others with an identical message.
 */
export function describeDiscoveryFailure(failure: DiscoveryFailure): string {
  const { kind, endpoint, status, detail } = failure;
  const at = endpoint ? ` at ${endpoint}` : "";
  const because = detail ? ` — ${detail}` : "";
  switch (kind) {
    case "no-credentials":
      return `no usable credentials${because}`;
    case "unauthorized":
      return `the API key was rejected (HTTP ${status})${at}${because}`;
    case "http-error":
      return `the model list returned HTTP ${status}${at}${because}`;
    case "unreachable":
      return `the model list was unreachable${at}${because}`;
    case "malformed":
      return `the model list was not valid JSON${at}`;
    case "empty-roster":
      return `the endpoint answered${at} but listed no models`;
  }
}

/** Drop cached discovery (after a credential change / TUI hydrate-on-add). */
export function invalidateModelDiscovery(provider?: string): void {
  if (provider) {
    _cache.delete(provider);
    _failures.delete(provider);
  } else {
    _cache.clear();
    _failures.clear();
  }
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
  // Formats this module cannot speak itself are served by registered fetchers.
  // It deliberately knows NONE of them by name: the builtin bundle is imported
  // on first miss, which both inverts the dependency and keeps the protobuf
  // codec and the Antigravity OAuth path off the cold-start path.
  if (descriptor.format !== "openai-models-list") {
    let fetcher = getModelDiscoveryFetcher(descriptor.format);
    if (!fetcher) {
      await import("./model-discovery-builtins.js");
      fetcher = getModelDiscoveryFetcher(descriptor.format);
    }
    if (!fetcher) {
      // A declared format nothing claims. Report it as a roster miss rather
      // than falling through to the GET path, which would hit a bogus URL.
      return recordFailure({ kind: "empty-roster", provider: providerName });
    }
    const models = await fetcher(providerName);
    if (models.length === 0) {
      return recordFailure({ kind: "empty-roster", provider: providerName });
    }
    _failures.delete(providerName);
    log(`[model-discovery:${providerName}] discovered ${models.length} models`);
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
      return recordFailure({
        kind: "no-credentials",
        provider: providerName,
        endpoint,
        detail: oneLine((e as Error)?.message ?? ""),
      });
    }
    // The authority does not always THROW for a missing key — for several
    // providers it returns headers with no auth on them, which upstream then
    // answers with the same 401 a wrong key produces. Distinguishing the two
    // matters: "you have not set a key" and "your key was rejected" have
    // different fixes, and reporting the latter for the former sends the user
    // hunting for a typo in a variable they never defined. Checking here also
    // skips a round-trip that cannot succeed.
    if (!hasAuthHeader(headers)) {
      return recordFailure({ kind: "no-credentials", provider: providerName, endpoint });
    }
  }

  // Identify ourselves, and honour the definition's own headers.
  //
  // `getRequestAuth` mints AUTH headers only, so a roster request went out with
  // whatever User-Agent the runtime defaults to. Measured 2026-08-18: OpenCode
  // Zen Go answers such a request with `403 error code: 1010` — Cloudflare's
  // browser-integrity block, not an auth failure — while the identical request
  // carrying a User-Agent returns 200 with 26 models. Without this, adding a
  // `modelDiscovery` entry for that provider would look like a broken endpoint
  // and be classified `unauthorized`, sending the user to check a working key.
  //
  // `def.headers` is applied AFTER, so a provider that needs a specific value
  // still wins; auth headers are applied last so nothing can displace them.
  headers = {
    "User-Agent": `claudish/${VERSION}`,
    ...(def.headers ?? {}),
    ...headers,
  };

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e: unknown) {
    return recordFailure({
      kind: "unreachable",
      provider: providerName,
      endpoint,
      detail: oneLine((e as Error)?.message ?? ""),
    });
  }

  if (!response.ok) {
    // 401/403 is split out because it is the only status the USER can act on,
    // and the action is specific: fix the credential. Everything else is
    // infrastructure and usually transient.
    const unauthorized = response.status === 401 || response.status === 403;
    // Body is read best-effort — the upstream message is often the only thing
    // that distinguishes "key rejected" from "key valid, plan expired", and
    // Alibaba's plan hosts do exactly that.
    let detail = "";
    try {
      detail = oneLine(await response.text());
    } catch {
      /* body unavailable — the status alone is still actionable */
    }
    return recordFailure({
      kind: unauthorized ? "unauthorized" : "http-error",
      provider: providerName,
      endpoint,
      status: response.status,
      detail,
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return recordFailure({ kind: "malformed", provider: providerName, endpoint });
  }

  const models = parseOpenAIModelsList(body);
  if (models.length === 0) {
    return recordFailure({ kind: "empty-roster", provider: providerName, endpoint });
  }

  _failures.delete(providerName);
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
