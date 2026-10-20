/**
 * AntigravityProviderTransport — Antigravity's own backend via the SHARED
 * Antigravity OAuth token.
 *
 * Adapted from the since-removed providers/transport/gemini-codeassist.ts. It keeps ALL of that
 * transport's hardening — the 429 classification (RATE_LIMIT_EXCEEDED retry /
 * MODEL_CAPACITY_EXHAUSTED fallback / QUOTA_EXHAUSTED terminal), the live
 * discovery of the account's dynamic models catalog, the capacity fallback chain,
 * and the 404 rewrite that checks that catalog (F1–F7) — and differs only in
 * identity and model handling:
 *
 * - Auth token comes from getValidAntigravityAccessToken() (the shared agy
 *   keychain item, self-refreshed), NOT the gemini-cli login token.
 * - Identity is ALWAYS Antigravity: the antigravity UA + ideType ANTIGRAVITY,
 *   independent of CLAUDISH_GEMINI_ANTIGRAVITY.
 * - The requested model id is resolved to a LIVE-served id
 *   (resolveAntigravityModelId over getServedAntigravityModels) before the
 *   envelope is built.
 *
 * Transport concerns:
 * - OAuth access token via getValidAntigravityAccessToken()
 * - Project ID + tier via setupAntigravityUser()
 * - Endpoint: `antigravityHost()`/v1internal:streamGenerateContent?alt=sse —
 *   Antigravity's host, NOT Code Assist's `cloudcode-pa` (see antigravity-user.ts)
 * - Wraps payload in the CodeAssist envelope: {model, project, user_prompt_id, request}
 * - GeminiRequestQueue for rate limiting
 * - gemini-sse stream format (with response wrapper)
 */

import { randomUUID } from "node:crypto";
import { lookupFamilyDefaultVariant } from "../../adapters/model-catalog.js";
import {
  forceRefreshAntigravityToken,
  getValidAntigravityAccessToken,
} from "../../auth/antigravity-token.js";
import {
  antigravityHost,
  buildAntigravityUserAgent,
  getAntigravityTierDisplayName,
  getServedAntigravityModels,
  resetAntigravityUserCache,
  retrieveUserQuota,
  setupAntigravityUser,
} from "../../auth/antigravity-user.js";
import { credentials } from "../../auth/credentials/authority.js";
import type { RequestAuth } from "../../auth/credentials/types.js";
import { GeminiRequestQueue } from "../../handlers/shared/gemini-queue.js";
import { log, logStderr } from "../../logger.js";
import type { DiscoveryOutcome } from "./probe-discovery.js";
import { discoverProviderProbeModel } from "./provider-model-discovery.js";
import type { ProviderTransport, StreamFormat } from "./types.js";

// The backend host comes from `antigravityHost()` — ONE source, shared with the
// auth/discovery calls, resolved at call time so `AICODE_ENDPOINT_URL` works and
// so this can never drift from the host those calls use. See the long note on
// `ANTIGRAVITY_DEFAULT_HOST` in `auth/antigravity-user.ts` for why it is NOT
// `cloudcode-pa` (that is Code Assist's backend, and it answers accordingly).
function antigravityEndpoint(): string {
  return `${antigravityHost()}/v1internal:streamGenerateContent?alt=sse`;
}

/** Max retry attempts for retryable 429s (RATE_LIMIT_EXCEEDED) */
const MAX_RETRY_ATTEMPTS = 3;
/** Default retry delay for a 429 the server ATTRIBUTED but gave no RetryInfo for. */
const DEFAULT_RATE_LIMIT_DELAY_MS = 10_000;
/**
 * Retry delay for a 429 that named neither a reason nor a delay.
 *
 * 10s is the right wait for a per-minute throttle, which is what
 * `RATE_LIMIT_EXCEEDED` means. It is the WRONG wait for a body carrying no
 * `details` at all, because nothing in that response says a wait helps. Three
 * such refusals measured 2026-08-22 came back in 343ms, 456ms and 722ms — the
 * server was not busy, it was declining — so the 20s of backoff claudish spent
 * between them was invented, and it blew the config TUI's 15s probe ceiling
 * from the inside. One second still absorbs a genuine blip; it just stops
 * claudish betting twenty seconds of the user's time on no evidence.
 */
const UNATTRIBUTED_RETRY_DELAY_MS = 1_000;
/**
 * Budget for the quota reading that fact-checks an "out of quota" verdict.
 * `retrieveUserQuota` carries no timeout of its own, and this call sits on a
 * path that is ALREADY failing — a hung connection must not hold the user's
 * error response open. Timing out degrades to the honest "couldn't confirm"
 * wording, never to a wrong claim.
 */
const QUOTA_CHECK_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// Model-id resolution (dynamic models catalog — NO hardcoded model ids)
// ---------------------------------------------------------------------------

/**
 * Reasoning-tier RANK — a LAST-RESORT rule, used only when neither the backend
 * nor the catalog names a default.
 *
 * Two authorities come first: the Antigravity backend's own
 * `defaultAgentModelId` (per-account, from fetchAvailableModels), and the slim
 * catalog's `routeVariant.isDefault` (per-family, e.g. `gemini-3.6-flash-high`
 * for family `gemini-3.6-flash`). This ordering only matters when both are
 * silent — a genuinely cold path. Lower number = stronger tier.
 */
const REASONING_TIER_RANK: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
  "extra-low": 3,
  tiered: 4,
};

/** Rank a reasoning-tier suffix (the part after the family name). */
function rankReasoningSuffix(suffix: string): number {
  const rank = REASONING_TIER_RANK[suffix.toLowerCase()];
  return rank === undefined ? Number.MAX_SAFE_INTEGER : rank;
}

/**
 * Rank a FULL served id by its reasoning-tier suffix, for display ordering
 * (strongest tier first). A bare family id with no recognised suffix ranks
 * last. Same rule as `rankReasoningSuffix`, applied to a whole id — the caller
 * has served ids, not pre-split family/suffix pairs.
 */
export function rankAntigravityModel(modelId: string): number {
  const dash = modelId.lastIndexOf("-");
  if (dash === -1) return Number.MAX_SAFE_INTEGER;
  // "extra-low" is the one two-word suffix, so try the last TWO segments first.
  const parts = modelId.split("-");
  if (parts.length >= 2) {
    const twoWord = rankReasoningSuffix(`${parts[parts.length - 2]}-${parts[parts.length - 1]}`);
    if (twoWord !== Number.MAX_SAFE_INTEGER) return twoWord;
  }
  return rankReasoningSuffix(modelId.slice(dash + 1));
}

/**
 * Resolve a user-supplied model id to the id the Antigravity backend serves,
 * using ONLY the account's dynamic models catalog (from fetchAvailableModels). No
 * pinned model ids — the served ids and the default come from the account's own
 * subscription.
 *
 * Rules (pure, exported for testing):
 *  1. Exact hit — `servedIds` contains `requested` → return it.
 *  2. CATALOG — the slim catalog's `routeVariant.isDefault` names this family's
 *     default variant (e.g. `gemini-3.1-pro-high` for `gemini-3.1-pro-preview`).
 *     Taken when that id is actually served. This is the ONLY rule that can
 *     bridge a catalog id whose stem differs from the backend's — the served id
 *     `gemini-3.1-pro-high` does not extend `gemini-3.1-pro-preview-`, so the
 *     prefix rule below cannot see it, and the request 404s.
 *  3. Family variants — served ids that extend `requested-` (e.g.
 *     `gemini-3.6-flash-high` for `gemini-3.6-flash`). If any exist:
 *       - if the backend `defaultId` is one of them → return `defaultId`;
 *       - else the strongest reasoning tier by suffix RANK.
 *  4. Otherwise — return `requested` unchanged and let the backend 404, which
 *     the 404 rewrite (F1–F7) checks against the dynamic models catalog and
 *     turns into an actionable error.
 *
 * `catalogDefault` is injected rather than looked up inside, so the function
 * stays pure and testable.
 */
export function resolveAntigravityModelId(
  requested: string,
  servedIds: string[],
  defaultId: string | null,
  catalogDefault?: string | null
): string {
  const req = requested.trim();

  if (servedIds.includes(req)) return req;

  if (catalogDefault && servedIds.includes(catalogDefault)) return catalogDefault;

  const familyPrefix = `${req}-`;
  const variants = servedIds.filter((id) => id.startsWith(familyPrefix));
  if (variants.length > 0) {
    if (defaultId && variants.includes(defaultId)) return defaultId;
    let best = variants[0];
    let bestRank = rankReasoningSuffix(best.slice(familyPrefix.length));
    for (const variant of variants.slice(1)) {
      const rank = rankReasoningSuffix(variant.slice(familyPrefix.length));
      if (rank < bestRank) {
        best = variant;
        bestRank = rank;
      }
    }
    return best;
  }

  return req;
}

/** Generate a short random request ID (matches the Antigravity CLI activity logger) */
function createActivityRequestId(): string {
  return Math.random().toString(36).substring(7);
}

/** Classification of 429 responses from the Code Assist API */
interface QuotaClassification {
  /** Whether this 429 is terminal (don't retry) */
  terminal: boolean;
  /** Suggested retry delay in ms (from server RetryInfo or defaults) */
  retryDelayMs?: number;
  /** The specific reason from ErrorInfo */
  reason?: string;
  /**
   * The server named NEITHER a reason nor a retry delay — the whole body was
   *
   *     {"error":{"code":429,"message":"Resource has been exhausted (e.g. check
   *      quota).","status":"RESOURCE_EXHAUSTED"}}
   *
   * with no `details` array at all. Retrying such a response is a guess, and
   * the 10s per-minute-throttle delay is a guess on top of a guess: measured
   * 2026-08-22, three of these came back in 343-722ms each, so the ~20s claudish
   * then spent asleep was pure invention. `UNATTRIBUTED_RETRY_DELAY_MS` keeps
   * the retry — a real transient blip deserves one — at a cost proportional to
   * the evidence, which is none.
   */
  unattributed?: boolean;
}

/**
 * Classify a 429 response to determine retry behavior.
 * - RATE_LIMIT_EXCEEDED → retryable (short-window per-minute limit)
 * - QUOTA_EXHAUSTED → terminal (daily limit hit)
 * - MODEL_CAPACITY_EXHAUSTED → terminal (triggers model fallback instead)
 */
function classify429(responseBody: string): QuotaClassification | null {
  try {
    const raw = JSON.parse(responseBody);
    const error = Array.isArray(raw) ? raw[0]?.error : raw?.error;
    const details = Array.isArray(error?.details) ? error.details : [];

    const retryInfo = details.find(
      (d: any) => d["@type"] === "type.googleapis.com/google.rpc.RetryInfo"
    );
    let retryDelayMs = parseRetryDelay(retryInfo?.retryDelay);

    if (retryDelayMs === undefined && typeof error?.message === "string") {
      const match = error.message.match(/retry in ([\d.]+)(ms|s)/i);
      if (match) {
        const val = Number.parseFloat(match[1]);
        retryDelayMs = match[2] === "ms" ? Math.round(val) : Math.round(val * 1000);
      }
    }

    const errorInfo = details.find(
      (d: any) => d["@type"] === "type.googleapis.com/google.rpc.ErrorInfo"
    );
    const reason = errorInfo?.reason;

    if (reason === "QUOTA_EXHAUSTED") {
      return { terminal: true, retryDelayMs, reason };
    }
    if (reason === "RATE_LIMIT_EXCEEDED") {
      return { terminal: false, retryDelayMs: retryDelayMs ?? DEFAULT_RATE_LIMIT_DELAY_MS, reason };
    }
    if (reason === "MODEL_CAPACITY_EXHAUSTED") {
      return { terminal: true, retryDelayMs, reason };
    }

    const quotaFailure = details.find(
      (d: any) => d["@type"] === "type.googleapis.com/google.rpc.QuotaFailure"
    );
    if (quotaFailure?.violations?.length) {
      const text = quotaFailure.violations
        .map((v: any) => `${v.quotaId || ""} ${v.description || ""}`)
        .join(" ")
        .toLowerCase();
      if (text.includes("perday") || text.includes("daily") || text.includes("per day")) {
        return { terminal: true, retryDelayMs, reason };
      }
      if (text.includes("perminute") || text.includes("per minute")) {
        return { terminal: false, retryDelayMs: retryDelayMs ?? 60_000, reason };
      }
    }

    // Nothing in the body attributed this 429 to anything. Say so, rather than
    // letting the caller's `?? DEFAULT_RATE_LIMIT_DELAY_MS` silently dress a
    // contentless refusal up as a known per-minute throttle.
    return {
      terminal: false,
      retryDelayMs,
      reason,
      unattributed: reason === undefined && retryDelayMs === undefined,
    };
  } catch {
    return null;
  }
}

/** Parse RetryInfo.retryDelay which can be string ("2.5s") or object ({seconds, nanos}) */
function parseRetryDelay(value: any): number | undefined {
  if (!value) return undefined;
  if (typeof value === "string") {
    const match = value.match(/([\d.]+)s/);
    return match ? Math.round(Number.parseFloat(match[1]) * 1000) : undefined;
  }
  if (typeof value === "object") {
    const seconds = typeof value.seconds === "number" ? value.seconds : 0;
    const nanos = typeof value.nanos === "number" ? value.nanos : 0;
    const ms = Math.round(seconds * 1000 + nanos / 1e6);
    return ms > 0 ? ms : undefined;
  }
  return undefined;
}

export class AntigravityProviderTransport implements ProviderTransport {
  readonly name = "antigravity";
  private _displayName = "Antigravity";
  get displayName(): string {
    return this._displayName;
  }
  readonly streamFormat: StreamFormat = "gemini-sse";

  /** The user-supplied model id (for messages + the credential ctx). */
  private modelName: string;
  /** The served id actually sent to the backend (mapped from modelName). */
  private servedModelName: string;
  private accessToken: string | null = null;
  private projectId: string | null = null;
  private tierId: string | null = null;

  /**
   * The delegated per-request auth artifact (headers + CodeAssist-envelope
   * transform) from the credential authority, populated by refreshAuth(). The
   * PRIMARY request's headers + envelope come from here. The local
   * accessToken/projectId/tierId below are kept in lockstep purely for the 429
   * fallback chain and quota logic (request-routing concerns, not auth).
   */
  private cachedAuth: RequestAuth | null = null;

  /** The last envelope built by transformPayload, stored for fallback retries */
  private lastEnvelope: any = null;

  /** Set when a fallback model is used instead of the requested one */
  private _activeModelName: string | undefined;

  /**
   * Model ids this account's Antigravity subscription currently serves,
   * discovered LIVE in refreshAuth() via getServedAntigravityModels()
   * (fetchAvailableModels). Used for model-id resolution, the capacity-fallback
   * chain, and the model-not-found hint.
   */
  private servedModels: string[] = [];

  /** The backend-provided default served model id (from fetchAvailableModels). */
  private defaultServedModel: string | null = null;

  constructor(modelName: string) {
    this.modelName = modelName;
    // Resolved against the account's dynamic models catalog in refreshAuth();
    // until then the raw name is a safe placeholder (composed-handler always
    // awaits refreshAuth before any request).
    this.servedModelName = modelName;
  }

  getActiveModelName(): string | undefined {
    return this._activeModelName;
  }

  /**
   * Pick a probe model from this account's own model list (fetchAvailableModels).
   *
   * The cloud catalog marks Antigravity `client_model_selection_required`: the
   * dynamic models catalog is per account, so no hosted pick can be right for everyone.
   * Without this method Test All had no candidate at all and reported "no probe
   * model: transport does not support discovery" for a working subscription.
   */
  async discoverProbeModel(exclude?: ReadonlySet<string>): Promise<DiscoveryOutcome> {
    return discoverProviderProbeModel(this.name, this.displayName, exclude);
  }

  getEndpoint(): string {
    return antigravityEndpoint();
  }

  async getHeaders(): Promise<Record<string, string>> {
    // PRIMARY request: headers come from the delegated auth artifact. If
    // refreshAuth() hasn't run yet (or delegation failed), fall back to a
    // locally-built header set so the fallback chain's per-attempt getHeaders()
    // still mints fresh credentials.
    if (this.cachedAuth) return { ...this.cachedAuth.headers };
    return this.buildLocalHeaders();
  }

  /**
   * The access token `buildLocalHeaders` signs the capacity-fallback fetches
   * with, for exact-value redaction. Those fetches never pass through
   * ComposedHandler's `fetchHeaders`, and the token mirrored here is not always
   * the delegated artifact's, so it is registered on its own.
   */
  redactionSecrets(): string[] {
    return this.accessToken ? [this.accessToken] : [];
  }

  /**
   * Build the Antigravity headers from local OAuth state. Used by the 429
   * fallback chain (handleCapacityExhausted), which needs a fresh
   * x-activity-request-id per attempt. The PRIMARY request uses the delegated
   * artifact's headers instead (see getHeaders()).
   */
  private buildLocalHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      "User-Agent": buildAntigravityUserAgent(),
      "x-activity-request-id": createActivityRequestId(),
    };
  }

  /**
   * Refresh auth before each request. The transport delegates the request
   * artifact (headers + CodeAssist envelope) to the credential authority. It
   * still mirrors accessToken/projectId/tierId locally (cache-hit reads) so the
   * 429 fallback chain and quota logic keep working.
   */
  async refreshAuth(): Promise<void> {
    this.cachedAuth = await credentials.getRequestAuth("antigravity", {
      model: this.modelName,
    });
    // Mirror local state for the fallback chain + quota (cache-hit reads).
    this.accessToken = await getValidAntigravityAccessToken();
    const { projectId, tierId } = await setupAntigravityUser(this.accessToken);
    this.projectId = projectId;
    this.tierId = tierId;
    this._displayName = getAntigravityTierDisplayName();
    // Discover the live served-model set (cache-hit after the first request) so
    // model-id resolution + the capacity fallback + the model-not-found hint all
    // reflect what THIS subscription actually serves today.
    const served = await getServedAntigravityModels(this.accessToken, this.projectId);
    this.servedModels = served.servedIds;
    this.defaultServedModel = served.defaultId;
    // Resolve the requested id to a served id against the live set (mirrors the
    // credential provider, which builds the primary envelope).
    this.servedModelName = resolveAntigravityModelId(
      this.modelName,
      this.servedModels,
      this.defaultServedModel,
      lookupFamilyDefaultVariant(this.modelName, "antigravity")
    );
    log(
      `[Antigravity] Auth refreshed, project: ${this.projectId}, tier: ${this._displayName}, ` +
        `model: ${this.modelName} -> ${this.servedModelName}, served: ${this.servedModels.join(",") || "(none)"}`
    );
  }

  /**
   * Re-mint the shared token after the backend REJECTED the one we presented,
   * then rebuild every piece of per-account state derived from it.
   *
   * ComposedHandler already owns the "401 → forceRefreshAuth() → retry once"
   * loop for any transport that implements this hook (the same one Vertex uses).
   * Antigravity simply never opted in, which is why a stale session had no
   * recovery path at all: `getValidAntigravityAccessToken()` refreshes on the
   * LOCAL clock only, so a server-invalidated token with a future `expiry` was
   * re-presented on every attempt, forever.
   *
   * `resetAntigravityUserCache()` is not incidental. `setupAntigravityUser()`
   * memoizes project + tier for the life of the PROCESS with no expiry, and
   * `getServedAntigravityModels()` caches the dynamic models catalog for 10 minutes — both
   * keyed to the identity that was just invalidated. A re-established session
   * can land on a different project, so keeping them would pin the fresh token
   * to the dead session's project. (Until now that reset function had no callers
   * at all.)
   */
  async forceRefreshAuth(): Promise<void> {
    await forceRefreshAntigravityToken();
    resetAntigravityUserCache();
    // Drop the delegated artifact too — its headers carry the rejected bearer
    // token, and getHeaders() prefers it over the locally-built set.
    this.cachedAuth = null;
    await this.refreshAuth();
  }

  /**
   * This transport's own verdict on 429 terminality, overriding the shared
   * substring heuristics (see `ProviderTransport.classifyTerminalError`).
   *
   * `classify429` reads `google.rpc.ErrorInfo` / `QuotaFailure` and already
   * distinguishes a spent daily allowance from a per-minute throttle. The
   * generic classifier cannot: Google stamps "Resource has been exhausted (e.g.
   * check quota)." on EVERY RESOURCE_EXHAUSTED reply, the shared exhaustion list
   * matches the bare word "quota", and so a transient throttle reached the user
   * as "Out of quota — ... This won't recover on retry." — sending them to a
   * billing dashboard that shows nothing wrong, for a fault that clears on its
   * own.
   *
   * MODEL_CAPACITY_EXHAUSTED is reported as NON-terminal here on purpose, and
   * that is a deliberate behaviour change. It is terminal for ONE MODEL — which
   * is why `enqueueRequest` answers it with a fallback chain drawn from the
   * dynamic models catalog rather than a retry — but it says nothing about the
   * account. Google has no capacity right now; capacity returns on the order of
   * seconds, so retrying is the actual remedy rather than theatre, and a bare
   * name whose chain continues (antigravity → google → openrouter) gets served
   * instead of hard-failing.
   * Reporting it terminal also handed it the quota message, which is how a
   * capacity fault ended up telling users to check their billing.
   *
   * Pure: derived from `bodyText` alone, never from per-request instance state.
   */
  classifyTerminalError(status: number, bodyText: string): boolean | undefined {
    if (status !== 429) return undefined;
    const classification = classify429(bodyText);
    // Unparseable body → no opinion; the generic rules are as good a guess.
    if (!classification) return undefined;
    if (classification.reason === "MODEL_CAPACITY_EXHAUSTED") return false;
    return classification.terminal;
  }

  /**
   * Wrap the standard Gemini payload in the CodeAssist envelope.
   *
   * Stores the envelope for potential fallback retries in enqueueRequest.
   */
  transformPayload(payload: any): any {
    // PRIMARY request: the CodeAssist envelope comes from the delegated auth
    // artifact (which maps the model id). Fall back to the local builder if
    // delegation hasn't run.
    const envelope = this.cachedAuth?.transformPayload
      ? this.cachedAuth.transformPayload(payload)
      : this.buildEnvelope(payload, this.servedModelName);
    this.lastEnvelope = envelope;
    return envelope;
  }

  /**
   * Build the CodeAssist envelope for a given (already-served) model name.
   */
  private buildEnvelope(innerPayload: any, model: string): any {
    const envelope: any = {
      model,
      project: this.projectId,
      user_prompt_id: randomUUID(),
      request: innerPayload,
    };
    // Paid tiers: enable Google One AI credits for capacity routing.
    if (this.tierId && this.tierId !== "free-tier") {
      envelope.enabled_credit_types = ["GOOGLE_ONE_AI"];
    }
    return envelope;
  }

  /**
   * Rate-limited request via GeminiRequestQueue singleton.
   *
   * 429 classification:
   * - RATE_LIMIT_EXCEEDED → retry with backoff (up to 3 attempts)
   * - MODEL_CAPACITY_EXHAUSTED → model fallback chain
   * - QUOTA_EXHAUSTED → terminal, return error (daily limit)
   * - Unknown 429 → retry with backoff
   */
  async enqueueRequest(fetchFn: () => Promise<Response>): Promise<Response> {
    const queue = GeminiRequestQueue.getInstance();

    let lastResponse: Response | null = null;
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      const response = attempt === 1 ? await queue.enqueue(fetchFn) : await queue.enqueue(fetchFn);

      if (response.status !== 429) {
        // A 404 usually means this model is not served by the tier we are on.
        // Only rewrite when the account's dynamic models catalog CONFIRMS that.
        if (response.status === 404) {
          return this.rewriteModelNotFound(response);
        }
        return response;
      }

      const bodyText = await response.clone().text();
      const classification = classify429(bodyText);
      lastResponse = response;

      if (!classification) {
        log("[Antigravity] 429 response could not be classified, returning to caller");
        return response;
      }

      log(
        `[Antigravity] 429 classified: reason=${classification.reason}, terminal=${classification.terminal}, delay=${classification.retryDelayMs}ms`
      );

      if (classification.reason === "MODEL_CAPACITY_EXHAUSTED") {
        return this.handleCapacityExhausted(response, queue);
      }

      if (classification.terminal) {
        return await this.explainTerminalQuota(response, bodyText, classification.reason);
      }

      if (attempt < MAX_RETRY_ATTEMPTS) {
        const delay =
          classification.retryDelayMs ??
          (classification.unattributed ? UNATTRIBUTED_RETRY_DELAY_MS : DEFAULT_RATE_LIMIT_DELAY_MS);
        logStderr(
          `[Antigravity] Rate limited (${classification.reason || "unattributed — server gave no reason or retry delay"}), retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt}/${MAX_RETRY_ATTEMPTS})`
        );
        if (attempt === 1) {
          await this.logQuotaInfo();
        }
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    logStderr(`[Antigravity] Rate limit persisted after ${MAX_RETRY_ATTEMPTS} retries`);
    return lastResponse!;
  }

  /**
   * Handle MODEL_CAPACITY_EXHAUSTED by trying the other LIVE-served models.
   *
   * Candidates come from `this.servedModels` (discovered in refreshAuth),
   * ordered by rank, excluding the model that just exhausted. A candidate that
   * 404s (briefly unserved mid-tier-roll) or rate-limits is skipped.
   */
  private async handleCapacityExhausted(
    originalResponse: Response,
    queue: GeminiRequestQueue
  ): Promise<Response> {
    const candidates = this.servedModels.filter((m) => m !== this.servedModelName);

    if (candidates.length === 0) {
      log(`[Antigravity] ${this.servedModelName} capacity exhausted, no fallback models available`);
      return originalResponse;
    }

    if (!this.lastEnvelope) {
      log(
        `[Antigravity] ${this.servedModelName} capacity exhausted but no stored envelope for retry`
      );
      return originalResponse;
    }

    log(`[Antigravity] Model ${this.servedModelName} capacity exhausted, starting fallback chain`);
    logStderr(
      `[Antigravity] ${this.servedModelName} capacity exhausted, trying fallback models...`
    );

    let lastResponse = originalResponse;
    const innerPayload = this.lastEnvelope.request;
    const endpoint = this.getEndpoint();
    const tried: string[] = [this.servedModelName];

    for (const fallbackModel of candidates) {
      log(`[Antigravity] Trying fallback model: ${fallbackModel}`);
      tried.push(fallbackModel);

      const fallbackEnvelope = this.buildEnvelope(innerPayload, fallbackModel);
      const headers = this.buildLocalHeaders();
      headers["Content-Type"] = "application/json";

      const fallbackResponse = await queue.enqueue(() =>
        fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(fallbackEnvelope),
        })
      );

      if (fallbackResponse.status === 200) {
        this._activeModelName = fallbackModel;
        logStderr(
          `[Antigravity] Using fallback model: ${fallbackModel} (${this.servedModelName} had no capacity)`
        );
        return fallbackResponse;
      }

      if (fallbackResponse.status === 404) {
        log(`[Antigravity] ${fallbackModel} returned 404, skipping to next fallback`);
        lastResponse = fallbackResponse;
        continue;
      }

      if (fallbackResponse.status === 429) {
        const fallbackBodyText = await fallbackResponse.clone().text();
        const classification = classify429(fallbackBodyText);
        if (classification?.reason === "MODEL_CAPACITY_EXHAUSTED") {
          log(`[Antigravity] ${fallbackModel} also capacity exhausted, trying next...`);
          lastResponse = fallbackResponse;
          continue;
        }
        return fallbackResponse;
      }

      return fallbackResponse;
    }

    log("[Antigravity] All fallback models exhausted");
    logStderr(`[Antigravity] All models capacity exhausted (tried: ${tried.join(" -> ")})`);
    if (lastResponse.status === 404) {
      return this.rewriteModelNotFound(lastResponse, true);
    }
    return lastResponse;
  }

  /**
   * Rewrite a 404 into an actionable error naming what this tier actually
   * serves and how to reach the model anyway. Status stays 404 (terminal), so
   * composed-handler remaps it to a 400 surfaced verbatim.
   *
   * Returns the response UNTOUCHED when the account's dynamic models catalog
   * contains the model.
   */
  private rewriteModelNotFound(response: Response, capacityFallbacksExhausted = false): Response {
    // The dynamic models catalog is the LIVE fetchAvailableModels result — no hardcoded seed.
    const served = this.servedModels;

    if (!capacityFallbacksExhausted && served.includes(this.servedModelName)) {
      log(
        `[Antigravity] 404 for ${this.servedModelName}, which IS in the dynamic models catalog — passing through unmodified`
      );
      return response;
    }

    // Drain the original so the connection body isn't left hanging.
    response.text().catch(() => {});
    // Only name the dynamic models catalog when we actually have one (the live fetch may
    // have failed); otherwise stay honest about not knowing.
    const servesClause =
      served.length > 0 ? `That tier currently serves: ${served.join(", ")}. ` : "";
    const tier = this._displayName || "Antigravity";
    const reason = capacityFallbacksExhausted
      ? `${this.modelName} could not be served after every Antigravity capacity fallback failed (${tier}, via ag@). ` +
        servesClause
      : `${this.modelName} is not served by your Antigravity tier (${tier}, via ag@). ` +
        servesClause;
    const message =
      reason +
      `To use ${this.modelName}, go through the direct Gemini API instead — ` +
      "set GEMINI_API_KEY (get one at https://aistudio.google.com/app/apikey) and run " +
      `google@${this.modelName}.`;
    const list = served.join(", ");
    const body = JSON.stringify({
      error: { code: 404, status: "NOT_FOUND", message },
    });
    if (capacityFallbacksExhausted) {
      logStderr(
        `[Antigravity] ${this.modelName} capacity fallbacks exhausted (404). Reported models: ${list}`
      );
    } else {
      logStderr(`[Antigravity] ${this.modelName} not served by ${tier} (404). Serves: ${list}`);
    }
    return new Response(body, {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Remaining allowance fraction for the model that just 429'd, or `undefined`
   * when the reading could not be taken (no token/project, endpoint down, or —
   * tellingly — the credential itself is no longer accepted).
   */
  private async quotaRemainingForServedModel(): Promise<number | undefined> {
    if (!this.accessToken || !this.projectId) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const data = await Promise.race([
      retrieveUserQuota(this.accessToken, this.projectId).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), QUOTA_CHECK_TIMEOUT_MS);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    const buckets = data?.buckets;
    if (!buckets?.length) return undefined;
    const bucket =
      buckets.find((b) => b.modelId === this.servedModelName) ??
      buckets.find((b) => b.modelId === this.modelName);
    return typeof bucket?.remainingFraction === "number" ? bucket.remainingFraction : undefined;
  }

  /**
   * Answer a terminal-quota 429 with a claim claudish has actually CHECKED.
   *
   * "Out of quota — check your plan & billing details" is an assertion about the
   * ACCOUNT, and it was being made purely from the shape of an error body. When
   * it is wrong it is expensively wrong: it sends the user to a billing
   * dashboard showing nothing amiss, while the bare-name chain
   * (antigravity → google → openrouter) quietly moves them onto a METERED hop
   * for a model their subscription already covers. The reported case was exactly
   * this — a plan with allowance left, restored by re-running `agy`.
   *
   * `retrieveUserQuota` is the same per-model bucket endpoint the status line
   * reads, so the claim can be tested against the account itself. Three
   * outcomes, and the middle one is why this exists at all:
   *   - allowance remains  → the 429 is not what it says; name the stale session.
   *   - reading failed     → say we could not confirm, rather than asserting.
   *   - allowance is zero  → the message was right; keep it, drop the hedging.
   *
   * The response is REBUILT rather than replaced: `details` (and therefore
   * `ErrorInfo.reason`) are preserved verbatim, because `classifyTerminalError`
   * re-parses this body upstream and must reach the same verdict. Only
   * `error.message` gains text. An unparseable body is passed through untouched.
   */
  private async explainTerminalQuota(
    response: Response,
    bodyText: string,
    reason: string | undefined
  ): Promise<Response> {
    const remaining = await this.quotaRemainingForServedModel();
    const model = this.servedModelName;

    let advice: string;
    if (remaining !== undefined && remaining > 0) {
      advice =
        `your Antigravity plan still reports ${(remaining * 100).toFixed(1)}% of the ${model} ` +
        "allowance available, so this is probably NOT an exhausted plan. The usual cause is an " +
        "Antigravity session Google invalidated server-side; run `claudish login antigravity`.";
    } else if (remaining === undefined) {
      advice =
        "claudish could not read your Antigravity quota to confirm this. If your plan is not " +
        "actually spent, the session may be stale — run `claudish login antigravity`.";
    } else {
      advice = `your Antigravity plan reports no remaining ${model} allowance; it refills on Google's own schedule.`;
    }

    logStderr(`[Antigravity] Terminal 429 (${reason || "daily limit"}) — ${advice}`);

    let parsed: any;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return response;
    }
    const target = Array.isArray(parsed) ? parsed[0]?.error : parsed?.error;
    if (!target || typeof target !== "object") return response;
    const upstream =
      typeof target.message === "string" && target.message.length > 0
        ? target.message
        : "Resource has been exhausted";
    target.message = `${upstream} — ${advice}`;

    return new Response(JSON.stringify(parsed), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Fetch and display per-model quota info from the Code Assist API.
   * Called on first rate limit so the user can see their actual usage.
   *
   * The table MUST say something about the model that was actually throttled.
   * It used to print the buckets verbatim, and the backend returns buckets only
   * for models it meters — so a 429 on `gemini-3.7-flash` was reported beside
   * four unrelated models all showing "100.0% remaining", which reads as "you
   * have plenty of quota" and makes the rate limit look inexplicable. The
   * absence of a bucket is itself the answer, so name it.
   */
  private async logQuotaInfo(): Promise<void> {
    if (!this.accessToken || !this.projectId) return;
    try {
      const data = await retrieveUserQuota(this.accessToken, this.projectId);
      if (!data?.buckets?.length) return;

      const lines: string[] = [];
      let sawThrottledModel = false;
      for (const bucket of data.buckets) {
        if (!bucket.modelId) continue;
        const pct =
          typeof bucket.remainingFraction === "number"
            ? `${(bucket.remainingFraction * 100).toFixed(1)}%`
            : "?";
        const reset = bucket.resetTime
          ? new Date(bucket.resetTime).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })
          : "?";
        // Mark the row for the model we are actually being throttled on, so the
        // relevant line is findable in a list of similar-looking ones.
        const mine = this.isThrottledModel(bucket.modelId);
        if (mine) sawThrottledModel = true;
        lines.push(`  ${mine ? "> " : "  "}${bucket.modelId}: ${pct} remaining (resets ${reset})`);
      }
      if (lines.length === 0) return;

      const requested =
        this.servedModelName && this.servedModelName !== this.modelName
          ? `${this.modelName} (served as ${this.servedModelName})`
          : this.modelName;
      const header = sawThrottledModel
        ? `[Antigravity] Quota status (> = ${requested}):`
        : `[Antigravity] Quota status — NOTE: ${requested} has no quota bucket below, ` +
          "so these figures do not explain its rate limit:";
      logStderr(`${header}\n${lines.join("\n")}`);
    } catch {
      // Non-fatal: quota check is informational only
    }
  }

  /** Does this quota bucket describe the model this transport is serving? */
  private isThrottledModel(bucketModelId: string): boolean {
    const id = bucketModelId.toLowerCase();
    return id === this.modelName.toLowerCase() || id === this.servedModelName.toLowerCase();
  }

  /**
   * Get quota remaining for a specific model from the Code Assist API.
   */
  async getQuotaRemaining(modelName: string): Promise<number | undefined> {
    if (!this.accessToken || !this.projectId) return undefined;
    try {
      const data = await retrieveUserQuota(this.accessToken, this.projectId);
      if (!data?.buckets?.length) return undefined;
      const bucket = data.buckets.find((b: any) => b.modelId === modelName);
      return typeof bucket?.remainingFraction === "number" ? bucket.remainingFraction : undefined;
    } catch {
      return undefined;
    }
  }
}
