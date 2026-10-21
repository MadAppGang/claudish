/**
 * Antigravity project / tier / served-model resolution.
 *
 * Extracted from the retired `gemini-oauth.ts` when the Gemini Code Assist
 * provider was removed (Google retired the "Code Assist for individuals" tier
 * for gemini-cli's OAuth client — `UNSUPPORTED_CLIENT`). Only the Antigravity
 * half of that module survives, because only the Antigravity flow still reaches
 * this backend.
 *
 * Auth is NOT handled here: the access token comes from the shared `agy`
 * keychain store via `antigravity-token.ts`. This module answers the two
 * questions the transport asks once a token is in hand — which project/tier is
 * this account on, and which model ids does it actually serve.
 */

import { log } from "../logger.js";
import { getAgyClientVersion } from "./antigravity-client-version.js";
import { credentialHttpError } from "./credentials/credential-error.js";

/**
 * The Antigravity backend host.
 *
 * IT IS A DIFFERENT HOST FROM CODE ASSIST'S, and that is the whole point.
 *
 * `ag@` was built from the remains of the removed `gemini-codeassist` provider
 * (v7.36.0). The token was swapped to Antigravity's; the HOST was kept, under a
 * comment asserting "the split was never about the URL, it was about which
 * OAuth client minted the token." That assertion was wrong, and it cost a full
 * debugging session: presenting an Antigravity token to `cloudcode-pa` gets you
 * answered AS Code Assist — the product Google retired for individuals.
 *
 * Measured 2026-08-24, one Google AI Ultra account, same token, same project,
 * same model, only the host varying:
 *
 *     cloudcode-pa.googleapis.com        generate gemini-3.6-flash-high -> 429
 *     daily-cloudcode-pa.googleapis.com  generate gemini-3.6-flash-high -> 200
 *
 * On `cloudcode-pa` that account reads `currentTier: free-tier`, is served a
 * dynamic models catalog of `gemini-2.5-*` and editor-internal `chat_*`/`tab_*` ids, reports
 * every quota bucket at 100% forever (nothing is ever consumed), and can
 * generate with EXACTLY the two `tab_*` completion models — free Code Assist's
 * remaining entitlement — while all 28 chat models return a contentless
 * `RESOURCE_EXHAUSTED`. None of that is a rate limit; it is the wrong product.
 *
 * `agy` 1.1.18 has never called anything else: 2,822 requests across 73 log
 * files spanning a week, 100% to `daily-`, 0% to `cloudcode-pa`.
 *
 * `AICODE_ENDPOINT_URL` is the override `agy` itself reads, kept so a user on a
 * different release track can point claudish wherever their own CLI goes.
 */
const ANTIGRAVITY_DEFAULT_HOST = "https://daily-cloudcode-pa.googleapis.com";

/** Resolve the backend host at CALL time, so the override is honoured. */
export function antigravityHost(): string {
  const override = process.env.AICODE_ENDPOINT_URL?.trim();
  return override ? override.replace(/\/+$/, "") : ANTIGRAVITY_DEFAULT_HOST;
}

/** `<host>/v1internal` — the prefix every Antigravity call shares. */
function apiBase(): string {
  return `${antigravityHost()}/v1internal`;
}

/**
 * The account's dynamic models catalog changes on the daily-quota cadence, not
 * per request, and both lookups below are real network calls we don't want on
 * every refreshAuth.
 */
const SERVED_MODELS_TTL_MS = 10 * 60 * 1000;

/** The `metadata.ideType` sent by the Antigravity provider. */
const ANTIGRAVITY_IDE_TYPE = "ANTIGRAVITY";

/** `loadCodeAssist` response — only the fields we read. */
interface LoadCodeAssistResponse {
  currentTier?: string | { id?: string };
  paidTier?: { id?: string; name?: string };
  cloudaicompanionProject?: string;
}

/**
 * Mark an error as a terminal CONFIGURATION verdict rather than a transient
 * fault. `composed-handler.ts` checks `err.terminal` and answers 400 inline, so
 * the explanation reaches the user immediately instead of being buried under
 * Claude Code's "API error · Retrying" banner for minutes of pointless backoff.
 */
function makeTerminalSetupError(message: string): Error {
  const err = new Error(message);
  (err as Error & { terminal?: boolean }).terminal = true;
  return err;
}

/** A floor for when agy cannot be read — not a pinned target; the version comes from agy. */
const AGY_FALLBACK_CLIENT_VERSION = "1.1.9";

/** Where the presented client version came from: agy's own, or the floor. */
export type AntigravityClientVersionSource = "agy" | "fallback";

/** The client version this process presents, and which source it came from. */
export interface AntigravityClientVersion {
  version: string;
  source: AntigravityClientVersionSource;
}

/**
 * The client version this process presents: agy's own, else the floor.
 *
 * `source: "fallback"` is not cosmetic: the 1.1.9 floor hides every
 * `gemini-4-argon-*` id from `fetchAvailableModels`, so a reader of that answer
 * must be told it was asked with the floor.
 */
export function resolveAntigravityClientVersion(): AntigravityClientVersion {
  const agy = getAgyClientVersion();
  return agy
    ? { version: agy, source: "agy" }
    : { version: AGY_FALLBACK_CLIENT_VERSION, source: "fallback" };
}

/** The client version this process presents: agy's own, else the floor. */
function antigravityClientVersion(): string {
  return resolveAntigravityClientVersion().version;
}

/** The Antigravity CLI's User-Agent for one given client version. */
function userAgentFor(version: string): string {
  return `antigravity/cli/${version} (aidev_client; os_type=${process.platform}; arch=${process.arch}; auth_method=consumer)`;
}

/**
 * Antigravity's own User-Agent — the Antigravity CLI's, with the version the
 * installed `agy` reports.
 *
 * `loadCodeAssist` gates the VISIBLE TIER on request identity (this UA plus
 * `metadata.ideType`), which is why it is reproduced verbatim. The VERSION in it
 * gates discovery and generation as well. Measured 2026-10-14, same token,
 * project and host, only the version varying: `fetchAvailableModels` at 1.1.9
 * lists 23 ids with no `gemini-4-argon-*`, and generating with
 * `gemini-4-argon-low` answers 404; at 1.3.5 it lists 29 ids and the same
 * request answers 200. A pinned version therefore hides every model newer than
 * the pin, so the version is read from agy once per auth session
 * (`antigravity-client-version.ts`). We present this identity because we are
 * carrying a real Antigravity token, not to impersonate one.
 */
export function buildAntigravityUserAgent(): string {
  return userAgentFor(antigravityClientVersion());
}

let cachedAgProjectId: string | null = null;
let cachedAgTierId: string | null = null;
let cachedAgTierName: string | null = null;

/** Clear the cached Antigravity project/tier (e.g. on account switch). */
export function resetAntigravityUserCache(): void {
  cachedAgProjectId = null;
  cachedAgTierId = null;
  cachedAgTierName = null;
  agServedCache = null;
  agServedCacheAt = 0;
  agServedCacheVersion = null;
}

/** loadCodeAssist with the Antigravity identity (minimal `{ ideType }` metadata). */
async function callLoadCodeAssistAntigravity(accessToken: string): Promise<LoadCodeAssistResponse> {
  const res = await fetch(`${apiBase()}:loadCodeAssist`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": buildAntigravityUserAgent(),
    },
    // ONLY ideType — the individuals tier returns the project inline without
    // pluginType/platform.
    body: JSON.stringify({ metadata: { ideType: ANTIGRAVITY_IDE_TYPE } }),
  });

  if (!res.ok) {
    // 429/5xx is transient (retry), a 4xx a terminal setup verdict (`credential-error.ts`).
    throw credentialHttpError(
      `loadCodeAssist (antigravity) failed: ${res.status} ${await res.text()}`,
      res.status
    );
  }

  return (await res.json()) as LoadCodeAssistResponse;
}

/**
 * Resolve the project + tier for the Antigravity flow.
 *
 * loadCodeAssist auto-provisions `cloudaicompanionProject` inline for the
 * individuals/Ultra tier, so there is NO onboardUser poll and NO
 * GOOGLE_CLOUD_PROJECT requirement. `paidTier.id` wins over `currentTier`.
 * Cached for the life of the process (env/account do not change mid-run).
 */
export async function setupAntigravityUser(
  accessToken: string
): Promise<{ projectId: string; tierId: string }> {
  if (cachedAgProjectId && cachedAgTierId) {
    return { projectId: cachedAgProjectId, tierId: cachedAgTierId };
  }

  const loadRes = await callLoadCodeAssistAntigravity(accessToken);
  log(`[Antigravity] loadCodeAssist response: ${JSON.stringify(loadRes)}`);

  const resolvedTier =
    loadRes.paidTier?.id ||
    (typeof loadRes.currentTier === "object" ? loadRes.currentTier?.id : loadRes.currentTier) ||
    "free-tier";

  const projectId = loadRes.cloudaicompanionProject;
  if (!projectId) {
    throw makeTerminalSetupError(
      "Antigravity did not return a project for this account. Sign in to Antigravity " +
        "(`claudish login antigravity`) and try again, or use g@<model> with GEMINI_API_KEY " +
        "(get one at https://aistudio.google.com/app/apikey)."
    );
  }

  cachedAgProjectId = projectId;
  cachedAgTierId = resolvedTier;
  cachedAgTierName = loadRes.paidTier?.name || null;
  log(`[Antigravity] User set up, project: ${projectId}, tier: ${resolvedTier}`);
  return { projectId, tierId: resolvedTier };
}

/** Short display name for the Antigravity tier (status line). */
export function getAntigravityTierDisplayName(): string {
  if (!cachedAgTierName && !cachedAgTierId) return "Antigravity";
  const id = cachedAgTierId || "";
  if (id.includes("ultra")) return "Antigravity Ultra";
  if (id.includes("pro")) return "Antigravity Pro";
  if (id === "free-tier") return "Antigravity Free";
  return cachedAgTierName || "Antigravity";
}

/** Full tier name for the quota header — falls back to the short name. */
export function getAntigravityTierFullName(): string {
  return cachedAgTierName || getAntigravityTierDisplayName();
}

/** Quota bucket from retrieveUserQuota. */
export interface QuotaBucket {
  modelId?: string;
  remainingFraction?: number;
  remainingAmount?: string;
  resetTime?: string;
  tokenType?: string;
}

/**
 * Retrieve per-model quota usage. Returns buckets with remaining capacity per
 * model. Call after `setupAntigravityUser` (needs its projectId).
 *
 * THE USER-AGENT SELECTS WHICH TIER'S BUCKETS COME BACK. This call used to
 * send the gemini-cli UA (`GeminiCLI/0.5.6/gemini-code-assist`) it was written
 * with. That was known to be a live behavioural question rather than a
 * cosmetic one, and the measurement has now been made — same token, same
 * project, same endpoint, only the UA varied, on a real Ultra account
 * (2026-08-18):
 *
 *   gemini-cli UA  ->  4 buckets: gemini-2.5-flash, -2.5-flash-lite,
 *                      -2.5-pro, -3.1-flash-lite
 *   antigravity UA -> 24 buckets: the 3.x families (3.6-flash-*, 3.5-flash-*,
 *                      3.1-pro-*), plus claude-* and gpt-oss-* uids
 *
 * Those 4 are precisely the membership of the RETIRED free Code Assist plan.
 * Identifying as gemini-cli therefore asked the backend for a product the user
 * is not on, and the quota UI rendered "Antigravity Ultra" — a correct tier
 * label from `loadCodeAssist`, which always identified correctly — directly
 * above four models an Ultra subscriber does not use, all pinned at 0%.
 *
 * So this MUST match `loadCodeAssist`'s identity. Both calls hit the same host
 * and the backend answers each according to who is asking.
 */
export async function retrieveUserQuota(
  accessToken: string,
  projectId: string
): Promise<{ buckets?: QuotaBucket[] } | null> {
  try {
    const res = await fetch(`${apiBase()}:retrieveUserQuota`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": buildAntigravityUserAgent(),
      },
      body: JSON.stringify({ project: projectId }),
    });
    if (!res.ok) {
      log(`[Antigravity] retrieveUserQuota failed: ${res.status}`);
      return null;
    }
    return (await res.json()) as { buckets?: QuotaBucket[] };
  } catch (err) {
    log(`[Antigravity] retrieveUserQuota error: ${err}`);
    return null;
  }
}

/** Per-model record inside `fetchAvailableModels` (only the fields we read). */
interface AntigravityModelRecord {
  /** Context window, in tokens, AS SERVED BY ANTIGRAVITY. */
  maxTokens?: number;
  maxOutputTokens?: number;
  displayName?: string;
}

/** The Antigravity `fetchAvailableModels` response (only the fields we read). */
interface FetchAvailableModelsResponse {
  /** The dynamic models catalog — the KEYS of this dict ARE the served model ids. */
  models?: Record<string, AntigravityModelRecord>;
  /** Backend-provided default model id (e.g. "gemini-3.6-flash-high"). */
  defaultAgentModelId?: string;
  /**
   * Ids bound to a SPECIAL PURPOSE inside the editor, not general chat.
   *
   * Despite the name, `tabModelIds` holds the `chat_*` ids on this account —
   * the backend's naming, not ours. Each of these is a list of ids reserved for
   * one editor feature, and none of them belongs in a model picker.
   */
  tabModelIds?: string[];
  imageGenerationModelIds?: string[];
  mqueryModelIds?: string[];
  webSearchModelIds?: string[];
  commitMessageModelIds?: string[];
  audioTranscriptionModelIds?: string[];
  /**
   * Retired ids, mapped to their replacement:
   * `{"gemini-3.1-pro-high": {"newModelId": "gemini-pro-agent"}}`.
   *
   * A MAP, not an array. This is load-bearing: `gemini-3.1-pro-high` is still
   * present in `models` and still looks like a normal id, but generating with it
   * returns `400 INVALID_ARGUMENT` — the deprecation is the only warning the
   * backend gives, and claudish was throwing it away.
   */
  deprecatedModelIds?: Record<string, { newModelId?: string }>;
  /**
   * The editor's model picker: sorts, each with groups of ids. `agy models`
   * prints exactly `agentModelSorts[*].groups[*].modelIds`, in this order —
   * a curated subset of `models`, which also carries older generations.
   */
  agentModelSorts?: Array<{ displayName?: string; groups?: Array<{ modelIds?: string[] }> }>;
}

/** What the backend reports about one served model. */
export interface AntigravityModelMeta {
  /** `maxTokens` — the window THIS subscription is served, not the model's spec. */
  contextWindow?: number;
  maxOutputTokens?: number;
  displayName?: string;
}

/** The dynamic models catalog + default id for the Antigravity account. */
export interface AntigravityServedModels {
  servedIds: string[];
  defaultId: string | null;
  /**
   * Per-model metadata, keyed by served id.
   *
   * Kept because the window Antigravity serves is NOT the model's published
   * spec, and the two disagree by a factor of four on at least one model:
   * measured 2026-08-18, the backend reports `claude-sonnet-4-6` at 250,000
   * tokens while the Firebase catalog lists 1,000,000. A session that trusts
   * the catalog plans against a window it does not have and compacts far too
   * late — the same class of failure the context-window work in v7.24.0 fixed
   * from the other direction.
   *
   * Every gemini id happens to agree (1,048,576 both ways), which is exactly
   * why the disagreement went unnoticed: the models people look at are fine.
   */
  meta: Record<string, AntigravityModelMeta>;
  /**
   * Ids the backend DECLARES are not user-selectable chat models — the union of
   * `isInternal: true`, every special-purpose role list, and every deprecated id.
   *
   * Declared, not guessed. Before this existed claudish filtered on an
   * `id.startsWith("chat_")` naming hunch, which is both fragile (the ids carry
   * build numbers) and incomplete: it could never have known that
   * `gemini-3.1-pro-high` — an ordinary-looking id, present in `models`, with
   * full capability flags — is retired and answers `400 INVALID_ARGUMENT`.
   */
  excludedIds?: Set<string>;
  /** Retired id → its replacement, so a request for one can name the other. */
  deprecatedReplacements?: Record<string, string>;
  /**
   * The ids agy itself offers for selection — `agentModelSorts` flattened over
   * every sort and group, order kept, duplicates dropped. This is the list
   * `agy models` prints, and the one the picker shows.
   *
   * PICKER ONLY. Routing keeps `servedIds`, so a typed `ag@gemini-2.5-pro`
   * still resolves. `undefined` when the backend sent no such field (or an
   * empty one): absent means unknown, not "none".
   */
  agentModelIds?: string[];
}

let agServedCache: AntigravityServedModels | null = null;
let agServedCacheAt = 0;
/**
 * The client version the cache was fetched with. The backend's answer depends
 * on it (1.1.9 omits every `gemini-4-argon-*` id), so a cache fetched under one
 * version is not an answer for another.
 */
let agServedCacheVersion: string | null = null;

/** Flatten `agentModelSorts` into one ordered, deduplicated id list; undefined when empty. */
function flattenAgentModelSorts(
  sorts: FetchAvailableModelsResponse["agentModelSorts"]
): string[] | undefined {
  if (!Array.isArray(sorts)) return undefined;
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const sort of sorts) {
    for (const group of sort?.groups ?? []) {
      for (const id of group?.modelIds ?? []) {
        if (typeof id !== "string" || id === "" || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids.length > 0 ? ids : undefined;
}

/** What every raw `fetchAvailableModels` result records about the request it sent. */
interface FetchAvailableModelsRawBase {
  /** The URL called: `<host>/v1internal:fetchAvailableModels`. */
  url: string;
  /** The client version in the User-Agent this request presented. */
  clientVersion: string;
  clientVersionSource: AntigravityClientVersionSource;
}

/**
 * One `fetchAvailableModels` call, BEFORE any processing.
 *
 * `answered` means the backend sent a status. Its body is:
 * - `json`: a 2xx body that parsed. `text` is the response text exactly as
 *   read (byte for byte, untrimmed); `value` is its parse, untouched.
 * - `not-json`: a 2xx body that did not parse.
 * - `read-failed`: a 2xx body that could not be read.
 * - `unread`: any non-2xx answer. That body is never read.
 *
 * `unreachable` means `fetch` itself threw, so no status exists.
 */
export type FetchAvailableModelsRaw =
  | (FetchAvailableModelsRawBase & {
      kind: "answered";
      status: number;
      /** ISO-8601 UTC, taken when the response arrived. */
      fetchedAt: string;
      body:
        | { kind: "json"; text: string; value: unknown }
        | { kind: "not-json" }
        | { kind: "unread" }
        | { kind: "read-failed" };
    })
  | (FetchAvailableModelsRawBase & { kind: "unreachable"; error: unknown });

/**
 * Call `fetchAvailableModels` once and hand back what the backend sent,
 * verbatim. There is no cache, no exclusion, no displayName handling and no
 * `agentModelSorts` flattening; `getServedAntigravityModels` does all of that on
 * top of this call.
 *
 * The URL, the version and the User-Agent are computed in ONE synchronous step
 * before `fetch`. The result therefore names the version the request actually
 * presented, and a caller that keys a cache to it stamps the right one.
 *
 * Never throws: every outcome is a variant of the result.
 */
export async function fetchAntigravityAvailableModelsRaw(
  accessToken: string,
  projectId: string,
  opts?: { signal?: AbortSignal; now?: () => number }
): Promise<FetchAvailableModelsRaw> {
  const url = `${apiBase()}:fetchAvailableModels`;
  const { version, source } = resolveAntigravityClientVersion();
  const base: FetchAvailableModelsRawBase = {
    url,
    clientVersion: version,
    clientVersionSource: source,
  };
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": userAgentFor(version),
      },
      // NOTE: the body is `{ project }` — NOT `{ metadata }` (that 400s here).
      body: JSON.stringify({ project: projectId }),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  } catch (error) {
    return { ...base, kind: "unreachable", error };
  }
  const fetchedAt = new Date((opts?.now ?? Date.now)()).toISOString();
  const answered = { ...base, kind: "answered" as const, status: res.status, fetchedAt };
  if (!res.ok) return { ...answered, body: { kind: "unread" } };
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { ...answered, body: { kind: "read-failed" } };
  }
  try {
    return { ...answered, body: { kind: "json", text, value: JSON.parse(text) } };
  } catch {
    // `JSON.parse` throws SyntaxError on invalid text (Phase 0, M4).
    return { ...answered, body: { kind: "not-json" } };
  }
}

/**
 * Discover which model ids this account's Antigravity subscription serves — LIVE.
 *
 * `fetchAvailableModels` is the authoritative discovery endpoint for this
 * account's dynamic models catalog: the KEYS of its `models` dict ARE the served
 * ids (already carrying their reasoning-tier suffix, e.g.
 * `gemini-3.6-flash-high`), and `defaultAgentModelId` is the backend's own
 * default. `agentModelSorts` is the subset agy offers for selection, returned as
 * `agentModelIds` for the picker.
 *
 * The answer depends on the client version in the User-Agent, so the cache is
 * keyed to it as well as to time.
 *
 * Degrades to `{ servedIds: [], defaultId: null }` on any error, so the
 * transport's 404 handling still functions.
 */
export async function getServedAntigravityModels(
  accessToken: string,
  projectId: string,
  opts?: { force?: boolean }
): Promise<AntigravityServedModels> {
  const now = Date.now();
  const version = antigravityClientVersion();
  if (agServedCache && agServedCacheVersion !== version) {
    // Fetched under another client version — dropped outright rather than kept
    // as the degraded-path answer below, which would serve the old version's
    // dynamic models catalog after a failed refetch.
    log(
      `[Antigravity] Client version changed (${agServedCacheVersion} -> ${version}); ` +
        "refetching the dynamic models catalog."
    );
    agServedCache = null;
    agServedCacheAt = 0;
  }
  if (!opts?.force && agServedCache && now - agServedCacheAt < SERVED_MODELS_TTL_MS) {
    return agServedCache;
  }
  try {
    const raw = await fetchAntigravityAvailableModelsRaw(accessToken, projectId);
    if (raw.kind === "unreachable") {
      log(`[Antigravity] fetchAvailableModels error: ${raw.error}`);
    } else if (raw.status < 200 || raw.status >= 300) {
      log(`[Antigravity] fetchAvailableModels failed: ${raw.status}`);
    } else if (raw.body.kind !== "json") {
      log(
        `[Antigravity] fetchAvailableModels error: ${
          raw.body.kind === "not-json" ? "the body is not JSON" : "the body could not be read"
        }`
      );
    } else {
      // Still inside the `try`: a 2xx `null` body parses fine and then throws
      // here, which must degrade exactly as before.
      const data = raw.body.value as FetchAvailableModelsResponse;
      const servedIds = data.models ? Object.keys(data.models) : [];
      const defaultId =
        typeof data.defaultAgentModelId === "string" ? data.defaultAgentModelId : null;
      if (servedIds.length > 0) {
        const meta: Record<string, AntigravityModelMeta> = {};
        for (const [id, record] of Object.entries(data.models ?? {})) {
          // Only record fields the backend actually sent. An absent maxTokens
          // (gemini-3.1-flash-image reports none) must stay absent so callers
          // fall back to the catalog rather than reading a fabricated 0.
          const entry: AntigravityModelMeta = {};
          if (typeof record?.maxTokens === "number" && record.maxTokens > 0) {
            entry.contextWindow = record.maxTokens;
          }
          if (typeof record?.maxOutputTokens === "number" && record.maxOutputTokens > 0) {
            entry.maxOutputTokens = record.maxOutputTokens;
          }
          if (typeof record?.displayName === "string" && record.displayName) {
            entry.displayName = record.displayName;
          }
          meta[id] = entry;
        }

        // WHAT THE BACKEND DECLARES UNSELECTABLE — three independent signals,
        // all of them stated outright rather than inferred from the id.
        const excludedIds = new Set<string>();
        for (const [id, record] of Object.entries(data.models ?? {})) {
          if ((record as { isInternal?: boolean })?.isInternal === true) excludedIds.add(id);
        }
        // MODALITY lists only. `imageGenerationModelIds` and
        // `audioTranscriptionModelIds` name models that do not produce chat text
        // at all (`gemini-3.1-flash-image` reports no `maxOutputTokens`), and
        // `tabModelIds` names the inline-completion pair.
        //
        // Deliberately NOT excluded: `mqueryModelIds`, `webSearchModelIds`,
        // `commitMessageModelIds`. Those are ROLE ASSIGNMENTS of an ordinary
        // model — all three name `gemini-3.1-flash-lite` on this account, which
        // generates chat perfectly well. Treating a role as a disqualification
        // dropped a real model from the picker.
        for (const list of [
          data.tabModelIds,
          data.imageGenerationModelIds,
          data.audioTranscriptionModelIds,
        ]) {
          for (const id of list ?? []) excludedIds.add(id);
        }
        const deprecatedReplacements: Record<string, string> = {};
        for (const [oldId, info] of Object.entries(data.deprecatedModelIds ?? {})) {
          excludedIds.add(oldId);
          if (info?.newModelId) deprecatedReplacements[oldId] = info.newModelId;
        }

        const agentModelIds = flattenAgentModelSorts(data.agentModelSorts);
        agServedCache = {
          servedIds,
          defaultId,
          meta,
          excludedIds,
          deprecatedReplacements,
          ...(agentModelIds ? { agentModelIds } : {}),
        };
        agServedCacheAt = now;
        // The version the request actually presented, read in the same
        // synchronous step as its User-Agent (it equals `version` above).
        agServedCacheVersion = raw.clientVersion;
        return agServedCache;
      }
    }
  } catch (err) {
    log(`[Antigravity] fetchAvailableModels error: ${err}`);
  }
  if (agServedCache) return agServedCache;
  // The degraded path knows NOTHING about exclusions — it never saw a response.
  // Returning empty collections would assert "there are none", which is a claim
  // we cannot make; the fields are optional and consumers default them.
  return { servedIds: [], defaultId: null, meta: {} };
}

/**
 * The `servedIds` and `defaultId` the last fetch cached under this process's client version,
 * without fetching; null when there is none. For the routing availability
 * check (`providerServesModel`), which runs right after discovery fetched this
 * set and must resolve against the same `servedIds` and `defaultId` the
 * transport resolves against (`resolveAntigravityServedModel`). The discovery
 * list it also reads has the backend's unselectable ids removed, so it cannot
 * stand in for them.
 */
export function peekServedAntigravityModels(): AntigravityServedModels | null {
  if (!agServedCache || agServedCacheVersion !== antigravityClientVersion()) return null;
  return agServedCache;
}

/** Test seam: clear the Antigravity served-models cache between tests. */
export function _resetAntigravityServedModelsCache(): void {
  agServedCache = null;
  agServedCacheAt = 0;
  agServedCacheVersion = null;
}
