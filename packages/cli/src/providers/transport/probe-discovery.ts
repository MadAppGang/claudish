/**
 * Probe-model discovery helpers for self-hosted / user-deployed providers.
 *
 * For providers like LiteLLM, Ollama, LM Studio, vLLM, MLX, and OllamaCloud,
 * the cloud catalog at /probeModels cannot know what's available — each
 * deployment has its own model list. These transports query the endpoint
 * directly and pick a probe-friendly model.
 *
 * Selection ranks: prefer "small" model names (mini/nano/flash/lite/haiku/
 * 1b/3b/7b match), tiebreak by alphabetical ordering for determinism.
 * Currently-loaded models (when the endpoint exposes that signal) are
 * preferred over unloaded ones — probing a loaded model is faster.
 */

import { log } from "../../logger.js";
import { readAllModelsCache } from "../all-models-cache.js";
import { isOptInWireId } from "../content-use.js";

/**
 * In-memory cache. Stores the FULL ranked list of candidates so the probe
 * loop can fall through on per-model failures (e.g. LM Studio returning
 * "model loading error" 400 for a not-loaded model — the next candidate
 * from the same cache entry might be loaded and succeed).
 */
const _cache = new Map<string, { ranked: string[]; reason?: string; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

/** Heuristic regex matching model names indicating a small/cheap variant. */
const SMALL_MODEL_PATTERNS = [
  /\bmini\b/i,
  /\bnano\b/i,
  /\bflash\b/i,
  /\blite\b/i,
  /\bhaiku\b/i,
  /\bsmall\b/i,
  /\btiny\b/i,
  /\b[12345]b\b/i, // 1b, 2b, 3b, 5b
  /\b[78]b\b/i, // 7b, 8b
];

/**
 * What a provider's OWN listing said about a model, when it said anything.
 *
 * This is evidence, not a guess. Ollama publishes a `capabilities` array per
 * model in `GET /api/tags` — `["completion","tools","vision"]` for a chat model,
 * `["embedding"]` for an embedding one — and LM Studio publishes a `type`. It
 * describes THIS deployment rather than the canonical model, which is why it
 * outranks the catalog below: a local embedding build of a name the catalog
 * knows as a chat model is an embedding model here.
 *
 * `undefined` means the provider's listing carried no capability field. That is
 * a silence, and it stays a silence — see {@link classifyChatCapability}.
 */
export type ReportedCapability = "chat" | "not-chat" | undefined;

/**
 * Ollama's `/api/tags` and `/api/ps` rows carry `capabilities`. `completion`
 * means it answers chat turns; `embedding` means it does not. An empty or
 * missing array is a silence, never a denial — older daemons omit the field.
 */
export function ollamaReported(row: { capabilities?: unknown }): ReportedCapability {
  const caps = Array.isArray(row.capabilities) ? (row.capabilities as string[]) : [];
  if (caps.includes("completion")) return "chat";
  if (caps.includes("embedding")) return "not-chat";
  return undefined;
}

/** LM Studio's `/api/v0/models` rows carry `type`: `llm`/`vlm` chat, `embeddings` not. */
function lmStudioReported(row: { type?: unknown }): ReportedCapability {
  if (row.type === "llm" || row.type === "vlm") return "chat";
  if (row.type === "embeddings" || row.type === "embedding") return "not-chat";
  return undefined;
}

function isSmallName(name: string): boolean {
  return SMALL_MODEL_PATTERNS.some((re) => re.test(name));
}

/**
 * What is known about whether a model can answer a chat turn.
 *
 * Two sources of evidence, and no guesses: the provider's own published
 * capability for THIS deployment, and the cloud models catalog's published
 * input and output modalities for the canonical model — text must be among
 * both.
 *
 * - `"not-chat"` — a provider or catalog statement that it produces no text, or
 *   takes no text in, or a LiteLLM wildcard route. Never offered.
 * - `"chat"` — a provider or catalog statement that it answers chat turns.
 * - `"unknown"` — NOBODY said. Not offered either, and that is the point: an
 *   unknown used to be treated as chat, so an embedding model nothing described
 *   was offered as one. A model is now shown when it is known to work, and its
 *   absence is counted and attributed rather than guessed around — see
 *   {@link unavailableForMissingCapability}.
 */
export type ChatCapability = "chat" | "not-chat" | "unknown";

/**
 * Memoized projection of the cloud models catalog, rebuilt at most once per TTL:
 * a per-id lookup would re-read the cache file once per model when filtering a
 * 300-model LiteLLM list.
 */
const CATALOG_CHAT_INDEX_TTL_MS = 60_000;
interface CatalogCapabilityIndex {
  /** Ids the catalog declares chat-shaped. */
  chat: Set<string>;
  /** Ids whose published output modalities INCLUDE `"text"`: chat models, by catalog evidence. */
  textOutput: Set<string>;
  /** Ids whose published output modalities EXCLUDE `"text"`: they produce something else only. */
  nonTextOutput: Set<string>;
  /** Ids whose published input modalities EXCLUDE `"text"`: nothing typed reaches them. */
  nonTextInput: Set<string>;
  /** Ids the catalog declares video GENERATORS (`videoOutput: true`). */
  videoOutput: Set<string>;
  /** Ids with ANY published `videoOutput`, `false` included: a statement, not a silence. */
  videoOutputKnown: Set<string>;
  /**
   * Every id the catalog has a row for, whatever it says about it.
   *
   * Membership separates the two silences {@link unavailableForMissingCapability}
   * has to tell apart: a model the backend publishes but has not described, and a
   * name the backend has never heard of.
   */
  known: Set<string>;
}
const _catalogChatIndex = new Map<string, { index: CatalogCapabilityIndex; expiresAt: number }>();

/** Drop the memoized catalog projection — tests, and after a catalog refresh. */
export function _clearChatCapabilityIndex(): void {
  _catalogChatIndex.clear();
}

/**
 * The catalog path {@link classifyChatCapability} reads when its caller passes none.
 * Tests only: a caller several layers up (`servedModelsForProvider`, the picker) has
 * no `cachePath` to forward, and Bun keeps `homedir()` on the real `~/.claudish`.
 */
let _defaultChatCapabilityCachePath: string | undefined;

/** Point the chat filter at a test-owned catalog; `undefined` restores the real one. */
export function _setChatCapabilityCachePathForTest(path: string | undefined): void {
  _defaultChatCapabilityCachePath = path;
  _catalogChatIndex.clear();
}

/** The catalog key for an id: lowercased, vendor prefix dropped (`openai/x` is `x`). */
function catalogKey(name: string): string {
  const lower = name.toLowerCase();
  return lower.includes("/") ? lower.slice(lower.lastIndexOf("/") + 1) : lower;
}

/**
 * File a catalog row's keys under its published OUTPUT modality.
 *
 * Unknown arrives as an absent field; `null` and `[]` read as unknown too, because
 * no model produces nothing — such a row joins neither set and is left to the
 * `videoOutput` boolean; with neither, it stays unknown. The test is "includes text", never
 * "equals text": `["audio", "text"]` speaks AND writes, so it can answer a chat turn.
 */
function indexOutputModality(
  index: CatalogCapabilityIndex,
  keys: string[],
  modalities: string[] | null | undefined
): void {
  if (!Array.isArray(modalities) || modalities.length === 0) return;
  const target = modalities.includes("text") ? index.textOutput : index.nonTextOutput;
  for (const k of keys) target.add(k);
}

/**
 * File a catalog row's keys when its published INPUT modalities leave out text.
 *
 * A chat model takes text in and gives text out; other modalities on either side
 * never exclude one, so `["file","image","text"]` and `["image","text"]` (two of
 * the lists Claude rows publish) are chat models. What this catches is the other case: `gemini-3.5-transcribe` publishes
 * `in: ["audio"]`, `out: ["text"]` — it writes text, but nothing typed reaches it.
 * Measured on the live catalog: 13 rows publish text output with no text input,
 * all ASR, captioning or live-translation models.
 *
 * Only a PUBLISHED list denies. An absent, `null` or `[]` input list is a silence
 * (models-index contract: null is unknown, never "not a chat model"), and it
 * leaves the output evidence standing — `inkling`, `mistral-medium-2604` and
 * `o3-mini-high` are the three rows it keeps.
 */
function indexInputModality(
  index: CatalogCapabilityIndex,
  keys: string[],
  modalities: string[] | null | undefined
): void {
  if (!Array.isArray(modalities) || modalities.length === 0) return;
  if (modalities.includes("text")) return;
  for (const k of keys) index.nonTextInput.add(k);
}

function catalogCapabilityIndex(cachePath?: string): CatalogCapabilityIndex {
  const key = cachePath ?? "";
  const hit = _catalogChatIndex.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.index;

  const index: CatalogCapabilityIndex = {
    chat: new Set(),
    textOutput: new Set(),
    nonTextOutput: new Set(),
    nonTextInput: new Set(),
    videoOutput: new Set(),
    videoOutputKnown: new Set(),
    known: new Set(),
  };
  for (const entry of readAllModelsCache(cachePath)?.entries ?? []) {
    const keys = [catalogKey(entry.modelId), ...(entry.aliases ?? []).map(catalogKey)];
    for (const k of keys) index.known.add(k);
    // Filed BEFORE the `videoOutput: true` `continue` below, so a video generator
    // still contributes its published output modality — and where the two disagree
    // the modality list wins, being the more specific statement.
    indexOutputModality(index, keys, entry.outputModalities);
    indexInputModality(index, keys, entry.inputModalities);
    // `videoOutput` is read in both directions; `videoInput` is never read as a
    // denial, because a model that reads video is still a chat model.
    if (entry.videoOutput !== undefined) {
      for (const k of keys) index.videoOutputKnown.add(k);
    }
    if (entry.videoOutput === true) {
      for (const k of keys) index.videoOutput.add(k);
      continue;
    }
    // Positive flags only: `undefined` means no opinion and must stay `unknown`.
    //
    // `supportsVision` is NOT among them, and used to be. Vision is an INPUT
    // capability, and reading it as evidence of TEXT OUTPUT is the same kind of
    // guess as the deleted name regexes — it just wore a catalog field. Measured
    // on generation `g-20260922053223487-99e80e4b`: 19 rows had no published
    // output modality and `supportsVision` as their only chat signal, and 17 of
    // them were image, video, audio or moderation models — `sora-2`,
    // `gpt-image-2.5-*`, `chatgpt-image-latest`, `seedream-4.5`, `lyria-3.5`,
    // `omni-moderation-latest`, `hailuo-02`. `sora-2-pro` publishes
    // `outputModalities: ["video"]` and was excluded correctly; `sora-2` is the
    // same model family with the field missing, so the flag was all that spoke.
    //
    // `supportsTools` and `supportsThinking` stay: tool calling and reasoning are
    // behaviours of a model that emits text, so they are evidence ABOUT output.
    // 207 rows rely on `supportsTools` alone, and none on `supportsThinking`.
    const chatShaped = entry.supportsTools === true || entry.supportsThinking === true;
    if (chatShaped) for (const k of keys) index.chat.add(k);
  }
  _catalogChatIndex.set(key, { index, expiresAt: Date.now() + CATALOG_CHAT_INDEX_TTL_MS });
  return index;
}

/**
 * Classify whether a model can answer a chat turn — see {@link ChatCapability}.
 *
 * NO NAME RULES. There used to be two lists of regexes — `/\bembed/`, `/\btts\b/`,
 * `/\bwhisper\b/`, `/\bvideo\b/`, `/\bsora\b/` and so on — consulted whenever the
 * catalog published no output modality. They are deleted. A regex over a model id
 * is a guess, it silently miscategorises every name that does not follow the
 * convention it encodes, and it produced a filter nobody could reason about: a
 * model was hidden because of how it was spelled.
 *
 * What replaced them is evidence the providers were already publishing and
 * claudish was not reading. Ollama returns `capabilities` per model in
 * `GET /api/tags` (`["embedding"]` for `nomic-embed-text`), LM Studio returns a
 * `type`. Callers that hold such a listing pass it as `reported`.
 *
 * `reported` outranks the catalog because it is the more specific statement: the
 * catalog describes a canonical model, the provider describes the build it will
 * actually serve.
 *
 * Order: wildcard route, the provider's own statement, non-text output, an input
 * list without text, text output, `videoOutput: true`, the chat-shaped capability
 * flags, then `"unknown"` — which is now a refusal, not a pass.
 *
 * @param cachePath Override the catalog cache path. Tests only.
 * @param reported  The provider's own capability for this model, when its
 *                  listing published one.
 */
export function classifyChatCapability(
  name: string,
  cachePath?: string,
  reported?: ReportedCapability
): ChatCapability {
  // Wildcard entries ("gemini/*") are LiteLLM route patterns, not models.
  if (name.includes("*")) return "not-chat";

  if (reported) return reported;

  const index = catalogCapabilityIndex(cachePath ?? _defaultChatCapabilityCachePath);
  const key = catalogKey(name);

  if (index.nonTextOutput.has(key)) return "not-chat";
  if (index.nonTextInput.has(key)) return "not-chat";
  if (index.textOutput.has(key)) return "chat";
  if (index.videoOutput.has(key)) return "not-chat";
  if (index.chat.has(key)) return "chat";
  return "unknown";
}

/**
 * Whether a model may be offered as a chat model: ONLY a known `"chat"`.
 *
 * This used to be `!== "not-chat"`, which offered every `"unknown"` as well.
 * That is the wrong default in the only case that matters: nothing had
 * established the model answers chat turns, so the list included whatever the
 * filter failed to recognise — the reason a name-regex fallback had to exist at
 * all, and the reason embedding models kept reappearing whenever a name did not
 * match one. Requiring positive evidence removes the need to guess.
 *
 * The cost is visible rather than silent: {@link unavailableForMissingCapability}
 * counts what this excludes and says whose data is missing.
 *
 * A projection of {@link classifyChatCapability}, so every caller shares one rule.
 */
export function isChatCapable(name: string): boolean {
  return classifyChatCapability(name) === "chat";
}

/**
 * The same rule for a caller that holds the provider's own listing.
 *
 * Separate from {@link isChatCapable} rather than an optional second parameter,
 * because every caller filters with `.filter(isChatCapable)` and `Array.filter`
 * passes `(value, index, array)` — an optional second parameter would silently
 * receive the array index as the provider's capability.
 */
export function isReportedChatCapable(name: string, reported: ReportedCapability): boolean {
  return classifyChatCapability(name, undefined, reported) === "chat";
}

/** Why a model could not be offered, when the reason is absent data. */
export interface MissingCapabilityReport {
  /** Ids the catalog publishes but leaves without an output modality. */
  catalogSilent: string[];
  /** Ids no catalog row describes and whose provider listing published no capability. */
  providerSilent: string[];
}

/**
 * Split the models this filter excluded for LACK OF DATA from the ones it
 * excluded on evidence, and say which source was silent.
 *
 * The two buckets are different people's work. `catalogSilent` is a models-index
 * crawler gap: the backend publishes the model but not its
 * `outputModalities` — 52 rows on generation `g-20260922053223487-99e80e4b`,
 * almost all of them genuinely not chat (`imagen-4.0-*`, `flux.1-kontext-*`,
 * `gemini-3.5-transcribe`). `providerSilent` is an endpoint gap: a plain
 * OpenAI-compatible `/v1/models` returns `{id, object, created, owned_by}` and
 * nothing about capability, so nobody has ever described those models.
 *
 * Reported rather than guessed around. A count with names attached is something
 * a backend engineer can act on; a regex that hides the row is not.
 */
export function unavailableForMissingCapability(
  names: readonly string[],
  reportedFor?: (name: string) => ReportedCapability,
  cachePath?: string
): MissingCapabilityReport {
  const catalogSilent: string[] = [];
  const providerSilent: string[] = [];
  for (const name of names) {
    const reported = reportedFor?.(name);
    if (classifyChatCapability(name, cachePath, reported) !== "unknown") continue;
    const index = catalogCapabilityIndex(cachePath);
    if (index.known.has(catalogKey(name))) catalogSilent.push(name);
    else providerSilent.push(name);
  }
  return { catalogSilent, providerSilent };
}

/**
 * Say WHY a listing produced no probe candidate, and whose data is missing.
 *
 * The old message was `no chat-capable model among N listed`, which is now
 * ambiguous in a way that matters. Two different endpoints produce it:
 *
 *   - one serving nothing but image and embedding models, which is working
 *     correctly and has nothing to fix;
 *   - one whose models nobody has ever described, which is a data gap — and
 *     since claudish stopped guessing from names, this is the case that grew.
 *
 * Naming the silent party is the whole point. `catalogSilent` is a models-index
 * row published without `outputModalities`, which a backend engineer can fix
 * from this list. `providerSilent` is an endpoint that publishes no capability
 * field at all — a plain OpenAI-compatible `/v1/models` returns
 * `{id, object, created, owned_by}` — which no amount of backend work reaches.
 *
 * Names are included, capped, because "3 models" sends nobody anywhere and
 * `text-embedding-3-small, tts-1, whisper-1` answers the question on sight.
 */
function describeNoCandidates(
  ids: readonly string[],
  reportedFor?: (name: string) => ReportedCapability,
  cachePath?: string
): string {
  const { catalogSilent, providerSilent } = unavailableForMissingCapability(
    ids,
    reportedFor,
    cachePath
  );
  const undescribed = catalogSilent.length + providerSilent.length;
  if (undescribed === 0) {
    return `all ${ids.length} listed models are described as non-chat (image, embedding, audio)`;
  }
  const sample = [...catalogSilent, ...providerSilent].slice(0, 3).join(", ");
  const more = undescribed > 3 ? `, +${undescribed - 3} more` : "";
  const whose =
    providerSilent.length === 0
      ? "the models catalog publishes them without modalities"
      : catalogSilent.length === 0
        ? "this endpoint publishes no capability field"
        : "neither the models catalog nor this endpoint describes them";
  return `no capability data for ${undescribed} of ${ids.length} listed models — ${whose} (${sample}${more})`;
}

/**
 * Standard vendor prefixes that indicate a well-formed model alias rather
 * than a deployment-specific routing slug. Names without any `/` (bare
 * canonical IDs) and names with these recognized prefixes are preferred
 * over things like `gem-mad/...` or `oai-10x/...` which are LiteLLM-
 * specific aliases more likely to be stale or non-routable.
 */
const STANDARD_VENDOR_PREFIXES = [
  "openai/",
  "anthropic/",
  "google/",
  "gemini/",
  "meta/",
  "meta-llama/",
  "mistralai/",
  "mistral/",
  "x-ai/",
  "deepseek/",
  "qwen/",
  "moonshot/",
  "moonshotai/",
  "zhipuai/",
  "z-ai/",
];

function isStandardName(name: string): boolean {
  // No slash = canonical bare ID (e.g. "gpt-4o-mini", "claude-haiku-4")
  if (!name.includes("/")) return true;
  return STANDARD_VENDOR_PREFIXES.some((p) => name.toLowerCase().startsWith(p));
}

/**
 * ORDER models for probe selection. It no longer filters — see below.
 *
 *   1. Standard names: prefer bare or recognized-vendor-prefixed IDs
 *      over deployment-specific aliases (e.g. `gem-mad/...`).
 *   2. Small variants: prefer mini/nano/flash/lite/haiku/Nb.
 *   3. Tiebreak: alphabetical for determinism.
 *
 * It used to open with `.filter(isChatCapable)`, which was harmless while that
 * predicate judged names and became destructive the moment capability came from
 * the provider instead. Its callers filter FIRST, holding the provider's listing
 * — Ollama's `capabilities`, LM Studio's `type` — and then passed bare strings
 * in here, where a second pass re-judged them with the evidence stripped off and
 * discarded every one. Measured: LM Studio rows carrying `type: "llm"` survived
 * their own filter and then vanished here, and the endpoint reported no probe
 * model at all.
 *
 * Ranking and admission are now separate jobs, and only the caller holding the
 * evidence decides admission.
 */
export function rankProbeCandidates(names: string[]): string[] {
  // One exclusion survives here, and it is not a capability judgement: a name
  // containing `*` is a LiteLLM ROUTE PATTERN (`gemini/*`), not a model id, so
  // there is nothing to send it. Dropping it is rejecting a non-identifier, not
  // guessing what it can do — which is why it stays after the name rules went.
  //
  // The other is not a capability judgement either: a content-use opt-in wire
  // id is never a probe pick, because a probe is a request claudish chose to
  // send (`content-use.ts`). Every endpoint probe pick is ranked here.
  return names
    .filter((name) => !name.includes("*") && !isOptInWireId(name))
    .sort((a, b) => {
      const aStd = isStandardName(a);
      const bStd = isStandardName(b);
      if (aStd !== bStd) return aStd ? -1 : 1;
      const aSmall = isSmallName(a);
      const bSmall = isSmallName(b);
      if (aSmall !== bSmall) return aSmall ? -1 : 1;
      return a.localeCompare(b);
    });
}

interface CacheKey {
  /** Stable identifier for the provider+endpoint combination */
  key: string;
}

export interface DiscoveryOutcome {
  model: string | null;
  /** Diagnostic on failure (connection refused, no models, etc.). */
  reason?: string;
}

/**
 * Read the cache. If `exclude` contains models, return the first ranked
 * candidate not in the exclude set — lets the probe loop walk past models
 * that already failed.
 */
function cacheGet(
  key: string,
  exclude: ReadonlySet<string> = new Set()
): DiscoveryOutcome | undefined {
  const hit = _cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    _cache.delete(key);
    return undefined;
  }
  if (hit.ranked.length === 0) {
    return { model: null, reason: hit.reason };
  }
  const pick = hit.ranked.find((m) => !exclude.has(m));
  if (!pick) {
    return {
      model: null,
      reason: `all ${hit.ranked.length} candidate model(s) already tried`,
    };
  }
  return { model: pick };
}

/** Cache miss outcome (no ranked list, only a failure reason). */
function cacheSetFailure(key: string, reason: string): void {
  _cache.set(key, { ranked: [], reason, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Cache hit outcome (one or more candidates in priority order). */
function cacheSetRanked(key: string, ranked: string[]): void {
  _cache.set(key, { ranked, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Discover via OpenAI-compatible `GET /v1/models`.
 *
 * Used by LiteLLM, OllamaCloud, vLLM, LM Studio, MLX — anything that
 * exposes the standard OpenAI /v1/models endpoint.
 *
 * @param endpoint  Full URL to /v1/models (or equivalent)
 * @param headers   Auth + content headers from transport.getHeaders()
 * @param cacheKey  Unique per provider+endpoint
 */
export async function discoverViaOpenAIModels(
  endpoint: string,
  headers: Record<string, string>,
  cacheKey: CacheKey & {
    displayName?: string;
    exclude?: ReadonlySet<string>;
    /**
     * Whether a key is configured for this provider, for the 401/403 message.
     *
     * A local server that wants a key and a local server that rejects the key
     * are different problems with different fixes, and "HTTP 401 from
     * http://localhost:8000/v1/models" told the reader neither. Measured
     * 2026-09-19: an oMLX server on vLLM's default port answers
     * `401 {"error":{"message":"API key required"}}` to an unauthenticated list.
     */
    hasApiKey?: boolean;
  }
): Promise<DiscoveryOutcome> {
  const cached = cacheGet(cacheKey.key, cacheKey.exclude);
  if (cached !== undefined) return cached;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e: unknown) {
    const reason = classifyFetchError(e, endpoint);
    log(
      `[probe-discovery${cacheKey.displayName ? `:${cacheKey.displayName}` : ""}] fetch failed: ${reason}`
    );
    cacheSetFailure(cacheKey.key, reason);
    return { model: null, reason };
  }

  if (!response.ok) {
    const who = cacheKey.displayName ?? "this provider";
    const authFailure =
      response.status === 401 || response.status === 403
        ? cacheKey.hasApiKey === false
          ? `the server requires an API key and none is configured for ${who}`
          : `the server rejected the configured API key for ${who}`
        : "";
    const reason = authFailure
      ? `HTTP ${response.status} from ${endpoint} — ${authFailure}`
      : `HTTP ${response.status} from ${endpoint}`;
    log(`[probe-discovery${cacheKey.displayName ? `:${cacheKey.displayName}` : ""}] ${reason}`);
    cacheSetFailure(cacheKey.key, reason);
    return { model: null, reason };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    const reason = "invalid /v1/models response (not JSON)";
    cacheSetFailure(cacheKey.key, reason);
    return { model: null, reason };
  }

  const ids = extractModelIds(body);
  if (ids.length === 0) {
    const url = tryParseUrl(endpoint);
    const host = url?.host ?? endpoint;
    const reason = `${host} reachable but no models loaded — load a model in the server UI`;
    cacheSetFailure(cacheKey.key, reason);
    return { model: null, reason };
  }

  // A plain OpenAI-compatible `/v1/models` row is `{id, object, created,
  // owned_by}` — there is no capability field to read, so admission here rests
  // on the catalog alone.
  const ranked = rankProbeCandidates(ids.filter(isChatCapable));
  if (ranked.length === 0) {
    // "No chat-capable model" is now two different facts and the reader has to
    // be told which. Every model DESCRIBED as non-chat is a working endpoint
    // full of image or embedding models. Every model described by NOBODY is a
    // data gap, and naming whose gap it is turns a dead end into a fixable
    // one — a models-index row missing its modalities, or an endpoint that
    // publishes no capability field at all.
    const reason = describeNoCandidates(ids);
    cacheSetFailure(cacheKey.key, reason);
    return { model: null, reason };
  }
  cacheSetRanked(cacheKey.key, ranked);
  const pick = ranked.find((m) => !cacheKey.exclude?.has(m));
  if (!pick) {
    return {
      model: null,
      reason: `all ${ranked.length} candidate model(s) already tried`,
    };
  }
  return { model: pick };
}

/**
 * Translate fetch-level failures into actionable user-facing messages.
 *
 * Localhost URLs distinguish from remote: a localhost failure almost always
 * means "the local service isn't running" (the user can start it). A remote
 * failure is more ambiguous — could be wrong URL, firewall, VPN, server down.
 *
 * Bun's fetch returns "Unable to connect. Is the computer able to access the
 * url?" with no `cause.code` field for refused/unreachable connections, so we
 * match on the message text as well as the standard Node-style error codes.
 */
function classifyFetchError(e: unknown, endpoint: string): string {
  const name = (e as { name?: string } | null)?.name ?? "";
  const code = (e as { cause?: { code?: string } } | null)?.cause?.code ?? "";
  const msg = e instanceof Error ? e.message : String(e);

  // Extract just the host:port for compact display.
  const url = tryParseUrl(endpoint);
  const host = url?.host ?? endpoint;
  const isLocal = !!url && /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/i.test(url.hostname);

  if (name === "TimeoutError" || name === "AbortError" || /timeout/i.test(msg)) {
    return `${host} unresponsive (>${FETCH_TIMEOUT_MS / 1000}s) — check if the server is overloaded`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `cannot resolve host ${url?.hostname ?? endpoint} — check the URL`;
  }
  // Connection refused / unreachable. Bun's message form doesn't set cause.code.
  const isConnRefused =
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    /unable to connect|connection refused|fetch failed/i.test(msg);
  if (isConnRefused) {
    if (isLocal) {
      return `${host} not reachable — is the server running? Press u to change URL.`;
    }
    return `${host} not reachable — check the URL or network. Press u to change.`;
  }

  // Fall back to the raw message but tag the host so it's not anonymous.
  return `${host}: ${msg}`;
}

function tryParseUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

/** Pull model IDs from a /v1/models response body. */
function extractModelIds(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const data = body as Record<string, unknown>;
  // OpenAI shape: { data: [{ id: "..." }, ...] }
  if (Array.isArray(data.data)) {
    return data.data
      .map((m: unknown) => (m && typeof m === "object" ? (m as { id?: unknown }).id : null))
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  // LiteLLM model-groups shape: { data: [{ model_name: "..." }] }
  if (Array.isArray((data as { models?: unknown }).models)) {
    return (data as { models: unknown[] }).models
      .map((m: unknown) =>
        m && typeof m === "object"
          ? ((m as { id?: unknown; model_name?: unknown }).id ??
            (m as { model_name?: unknown }).model_name)
          : null
      )
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  return [];
}

interface OllamaModel {
  name: string;
  size?: number;
  /**
   * The daemon's own statement of what this model does: `["completion","tools",
   * "vision"]` for a chat model, `["embedding"]` for an embedding one. Optional
   * because daemons older than the field omit it, and an omission is a silence
   * rather than a denial — see {@link ollamaReported}.
   */
  capabilities?: string[];
}

/**
 * Order one tier of Ollama models cheapest-first.
 *
 * Both /api/ps and /api/tags report a byte size (VRAM and disk respectively),
 * and in both cases smaller means a faster probe. Models the endpoint didn't
 * size are appended via the shared name heuristic rather than dropped — an
 * unsized model is still a usable probe candidate, and discarding it shrinks
 * the fall-through list the probe loop depends on.
 */
function orderByCost(models: OllamaModel[]): string[] {
  // The opt-in exclusion `rankProbeCandidates` applies, for the sized half that
  // does not pass through it.
  const sized = models.filter((m) => typeof m.size === "number" && !isOptInWireId(m.name));
  const unsized = models.filter((m) => typeof m.size !== "number");
  const bySize = [...sized]
    .sort((a, b) => (a.size ?? Number.POSITIVE_INFINITY) - (b.size ?? Number.POSITIVE_INFINITY))
    .map((m) => m.name);
  return [...bySize, ...rankProbeCandidates(unsized.map((m) => m.name))];
}

/**
 * Discover via Ollama-native API: rank currently-loaded models from /api/ps
 * ahead of everything on disk from /api/tags.
 *
 * @param baseUrl   Ollama base URL (no trailing slash, no path)
 * @param cacheKey  Unique per endpoint
 */
export async function discoverViaOllama(
  baseUrl: string,
  cacheKey: CacheKey & { displayName?: string; exclude?: ReadonlySet<string> }
): Promise<DiscoveryOutcome> {
  const cached = cacheGet(cacheKey.key, cacheKey.exclude);
  if (cached !== undefined) return cached;

  // Fetch BOTH lists. /api/ps is what's loaded in VRAM (fastest to probe),
  // /api/tags is everything on disk. Connection-level errors are captured so
  // we can surface a useful reason if both come back empty — otherwise
  // "ollama isn't running" would render as "no models".
  //
  // The /api/tags fetch used to be gated on `loaded.length === 0` — the RAW
  // count, taken BEFORE the chat-capability filter. A box whose only loaded
  // model was an embedder (nomic-embed-text pinned by a background indexer, a
  // common setup) therefore reported "only embedding/non-chat models" while
  // dozens of chat models sat unlisted on disk. Both lists also feed the ranked
  // candidate array that the probe loop falls through on, so one broken model
  // no longer fails the whole row.
  // Issued in PARALLEL — they're independent reads of the same daemon, so
  // serializing them would bill their latencies additively for nothing.
  const [psResult, tagsResult] = await Promise.allSettled([
    fetchOllamaModels(`${baseUrl}/api/ps`),
    fetchOllamaModels(`${baseUrl}/api/tags`),
  ]);

  const loadedRaw = psResult.status === "fulfilled" ? psResult.value : [];
  const tagsRaw = tagsResult.status === "fulfilled" ? tagsResult.value : [];
  // /api/ps's error wins when both fail: same daemon, same cause, and it's the
  // first URL we'd have tried. Only consulted if we end up with no candidates.
  const connectionError =
    psResult.status === "rejected"
      ? classifyFetchError(psResult.reason, `${baseUrl}/api/ps`)
      : tagsResult.status === "rejected"
        ? classifyFetchError(tagsResult.reason, `${baseUrl}/api/tags`)
        : undefined;

  // Filter out embedding/image/TTS models — they're listed in /api/tags
  // alongside chat models but will 404 on /v1/chat/completions.
  //
  // Ollama says which is which itself: each row carries `capabilities`,
  // `["completion","tools","vision"]` against `["embedding"]`. Passing it as
  // `reported` is what let the name regexes go — `nomic-embed-text` is excluded
  // because the daemon called it an embedding model, not because of how it is
  // spelled. A row from an older daemon that carries no array stays unstated.
  const loaded = loadedRaw.filter((m) => isReportedChatCapable(m.name, ollamaReported(m)));
  const loadedNames = new Set(loaded.map((m) => m.name));
  const rest = tagsRaw.filter(
    (m) => isReportedChatCapable(m.name, ollamaReported(m)) && !loadedNames.has(m.name)
  );

  if (loaded.length === 0 && rest.length === 0) {
    // A daemon old enough to omit `capabilities` lands here with a full model
    // list and no way to tell chat from embedding, which is a different problem
    // from a daemon that genuinely only holds embedders. `describeNoCandidates`
    // separates them and names the fix; `ollama pull` is not it.
    const listed = [...loadedRaw, ...tagsRaw];
    const reportedFor = (name: string): ReportedCapability => {
      const row = listed.find((m) => m.name === name);
      return row ? ollamaReported(row) : undefined;
    };
    const reason =
      connectionError ??
      (listed.length === 0
        ? `no models on ${baseUrl} (pull one: ollama pull llama3.2)`
        : `${describeNoCandidates(
            listed.map((m) => m.name),
            reportedFor
          )} on ${baseUrl}`);
    cacheSetFailure(cacheKey.key, reason);
    return { model: null, reason };
  }

  // Loaded models first (already in VRAM → fastest probe), then the rest.
  // This becomes the cached candidate sequence — the probe loop can fall
  // through by exclude'ing failed models.
  const ranked = [...orderByCost(loaded), ...orderByCost(rest)];
  if (ranked.length === 0) {
    const reason = "no chat-capable model on Ollama endpoint";
    cacheSetFailure(cacheKey.key, reason);
    return { model: null, reason };
  }
  cacheSetRanked(cacheKey.key, ranked);
  const pick = ranked.find((m) => !cacheKey.exclude?.has(m));
  if (!pick) {
    return {
      model: null,
      reason: `all ${ranked.length} candidate model(s) already tried`,
    };
  }
  return { model: pick };
}

interface LMStudioModel {
  id: string;
  state?: string; // "loaded" | "not-loaded"
  type?: string; // "llm" | "vlm" | "embeddings" | ...
}

/**
 * Discover via LM Studio's native `/api/v0/models` endpoint, which returns
 * per-model `state: "loaded" | "not-loaded"`. Probing a loaded model is
 * safe; probing a not-loaded one might 400 with "model loading error" if
 * LM Studio fails to JIT-load it.
 *
 * Falls back to standard `/v1/models` discovery if `/api/v0/models` is
 * unavailable (older LM Studio versions, or a different OpenAI-compat
 * server pretending to be LM Studio).
 */
export async function discoverViaLMStudio(
  baseUrl: string,
  headers: Record<string, string>,
  cacheKey: CacheKey & { displayName?: string; exclude?: ReadonlySet<string> }
): Promise<DiscoveryOutcome> {
  const cached = cacheGet(cacheKey.key, cacheKey.exclude);
  if (cached !== undefined) return cached;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/v0/models`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e: unknown) {
    // Fallback to /v1/models for older LM Studio or non-LM-Studio servers.
    return discoverViaOpenAIModels(`${baseUrl}/v1/models`, headers, cacheKey);
  }

  if (!response.ok) {
    // /api/v0/models not supported on this version — try /v1/models.
    return discoverViaOpenAIModels(`${baseUrl}/v1/models`, headers, cacheKey);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    const reason = "invalid /api/v0/models response (not JSON)";
    cacheSetFailure(cacheKey.key, reason);
    return { model: null, reason };
  }

  const models = extractLMStudioModels(body);
  if (models.length === 0) {
    const url = tryParseUrl(baseUrl);
    const host = url?.host ?? baseUrl;
    const reason = `${host} reachable but no models present — download one in the LM Studio UI`;
    cacheSetFailure(cacheKey.key, reason);
    return { model: null, reason };
  }

  // Filter out non-chat models (embeddings, etc) and rank: loaded first,
  // then by the standard small-name heuristic among each tier.
  // LM Studio publishes `type` per model, so its own word decides here too and
  // the separate `type !== "embeddings"` test folds into the shared rule.
  const chatModels = models.filter((m) => isReportedChatCapable(m.id, lmStudioReported(m)));
  const loaded = chatModels.filter((m) => m.state === "loaded");
  const notLoaded = chatModels.filter((m) => m.state !== "loaded");

  const ranked = [
    ...rankProbeCandidates(loaded.map((m) => m.id)),
    ...rankProbeCandidates(notLoaded.map((m) => m.id)),
  ];

  if (ranked.length === 0) {
    const url = tryParseUrl(baseUrl);
    const host = url?.host ?? baseUrl;
    const reason = `${host} has ${models.length} model(s) but none are chat-capable`;
    cacheSetFailure(cacheKey.key, reason);
    return { model: null, reason };
  }
  cacheSetRanked(cacheKey.key, ranked);
  const pick = ranked.find((m) => !cacheKey.exclude?.has(m));
  if (!pick) {
    return {
      model: null,
      reason: `all ${ranked.length} candidate model(s) already tried`,
    };
  }
  return { model: pick };
}

function extractLMStudioModels(body: unknown): LMStudioModel[] {
  if (!body || typeof body !== "object") return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const out: LMStudioModel[] = [];
  for (const m of data) {
    if (!m || typeof m !== "object") continue;
    const r = m as { id?: unknown; state?: unknown; type?: unknown };
    if (typeof r.id !== "string" || !r.id) continue;
    out.push({
      id: r.id,
      state: typeof r.state === "string" ? r.state : undefined,
      type: typeof r.type === "string" ? r.type : undefined,
    });
  }
  return out;
}

async function fetchOllamaModels(url: string): Promise<OllamaModel[]> {
  const response = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return [];
  const body = (await response.json().catch(() => null)) as {
    models?: Array<{ name?: unknown; size?: unknown; capabilities?: unknown }>;
  } | null;
  if (!body?.models) return [];
  return body.models
    .map((m) => ({
      name: typeof m.name === "string" ? m.name : "",
      size: typeof m.size === "number" ? m.size : undefined,
      // Carried through, not projected away. This mapping previously kept only
      // name and size, so the daemon's own `capabilities` array was discarded
      // here and every caller downstream had nothing but the name to go on.
      capabilities: Array.isArray(m.capabilities)
        ? m.capabilities.filter((c): c is string => typeof c === "string")
        : undefined,
    }))
    .filter((m) => m.name.length > 0);
}

/** Test-only: clear the in-memory cache between runs. */
export function _clearProbeDiscoveryCache(): void {
  _cache.clear();
}

/**
 * Invalidate any cached discovery result whose key contains the given
 * provider slug. Called from the TUI when the user changes a URL or key —
 * the next probe should re-fetch instead of returning the stale model.
 */
export function invalidateProbeDiscovery(providerSlug: string): void {
  for (const key of _cache.keys()) {
    if (key.startsWith(`${providerSlug}:`)) {
      _cache.delete(key);
    }
  }
}
