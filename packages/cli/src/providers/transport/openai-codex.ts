/**
 * OpenAI Codex ProviderTransport
 *
 * Extends OpenAI transport with OAuth token support for ChatGPT Plus/Pro subscriptions.
 *
 * The transport no longer manages OAuth itself. On each request, composed-handler
 * calls refreshAuth() (BEFORE transformPayload/getEndpoint/getHeaders), which
 * delegates to the credential authority's getRequestAuth("openai-codex"). The
 * authority's Codex credential mints the OAuth artifact (chatgpt.com endpoint +
 * OAuth headers + store:false/include payload transform), and applies the
 * OPENAI_CODEX_API_KEY fallback internally. When OAuth is unavailable the authority
 * throws/falls through, cachedAuth stays null, and the transport uses the plain
 * api-key path (api.openai.com + Bearer key) from the OpenAI base transport.
 *
 * IMPORTANT: OAuth tokens only work with chatgpt.com/backend-api, NOT api.openai.com.
 */

import { createHash, randomBytes } from "node:crypto";
import { normalizeCodexModel } from "../../adapters/codex-api-format.js";
import { lookupModelForProvider } from "../../adapters/model-catalog.js";
import { credentials } from "../../auth/credentials/authority.js";
import type { RequestAuth } from "../../auth/credentials/types.js";
import { extractSessionId } from "../../behavior/harness.js";
import { OpenAIProviderTransport } from "./openai.js";

/**
 * Fallback conversation key, minted once per process.
 *
 * Only reached when the inbound request carries no Claude Code session id —
 * an older client, or a direct API consumer. Process-scoped rather than
 * derived from `cwd`, because two claudish processes in the same directory are
 * two different conversations and must not share a key; a single process
 * serving several conversations (the `serve` gateway) is the residual overlap,
 * and the cost there is a routing hint that is merely less precise.
 */
const FALLBACK_CONVERSATION_KEY = randomBytes(16).toString("hex");

export class OpenAICodexTransport extends OpenAIProviderTransport {
  /**
   * The per-request auth artifact, populated by refreshAuth() (called before
   * getEndpoint/getHeaders/transformPayload). Null when OAuth is unavailable —
   * the transport then falls back to the OpenAI base transport's api-key path.
   */
  private cachedAuth: RequestAuth | null = null;

  /** Memo for resolvePromptCacheKey: the session id the digest was built from. */
  private cachedCacheKeyFor: string | undefined;
  /** Memo for resolvePromptCacheKey: the digest itself. */
  private cachedCacheKey = "";

  /**
   * Resolve OAuth (or fall through to api-key) via the credential authority and
   * cache the artifact. composed-handler calls this before getEndpoint/getHeaders.
   * The Codex credential ignores ctx.model, so "" is fine.
   */
  async refreshAuth(): Promise<void> {
    try {
      this.cachedAuth = await credentials.getRequestAuth("openai-codex", { model: "" });
    } catch {
      // No OAuth (or refresh failed) → use the api-key path below.
      this.cachedAuth = null;
    }
  }

  /**
   * OAuth tokens only work with chatgpt.com/backend-api (endpoint comes from the
   * cached auth artifact). API keys use the standard OpenAI endpoint (super).
   */
  override getEndpoint(_targetModel?: string): string {
    return this.cachedAuth?.endpoint ?? super.getEndpoint();
  }

  override async getHeaders(): Promise<Record<string, string>> {
    if (this.cachedAuth) return { ...this.cachedAuth.headers };
    // Fall back to API key auth (Bearer <OPENAI_CODEX_API_KEY>).
    return super.getHeaders();
  }

  /**
   * Normalize the model name for the ChatGPT backend (a pure, non-auth transform —
   * the ChatGPT backend only knows ChatGPT-specific model names like "gpt-5.1"),
   * and attach the conversation-scoped `prompt_cache_key` (see
   * resolvePromptCacheKey). An explicit key already on the payload always wins.
   * The auth-derived bits (store:false / include reasoning) come from the cached
   * auth artifact's transformPayload, applied only when OAuth is active.
   */
  transformPayload(payload: any, claudeRequest?: any): any {
    let normalizedPayload = payload;
    if (payload?.model) {
      const normalized = normalizeCodexModel(payload.model);
      if (normalized !== payload.model) {
        normalizedPayload = { ...payload, model: normalized };
      }
    }
    if (normalizedPayload && typeof normalizedPayload === "object") {
      normalizedPayload = {
        ...normalizedPayload,
        prompt_cache_key:
          normalizedPayload.prompt_cache_key ?? this.resolvePromptCacheKey(claudeRequest),
      };
    }
    // Auth-derived store:false / include reasoning bits, only under OAuth.
    return this.cachedAuth?.transformPayload?.(normalizedPayload) ?? normalizedPayload;
  }

  /**
   * A stable, opaque `prompt_cache_key` for the Responses API, scoped to ONE
   * conversation.
   *
   * The Responses API uses this purely as a cache-routing hint: requests
   * sharing a key are steered to the same cache-affinity target, which is what
   * lets a long conversation's growing common prefix keep hitting. It is
   * advisory — a collision costs hit rate, never correctness — but the
   * granularity still matters, and CONVERSATION is the granularity that matches
   * what actually shares a prefix.
   *
   * Keyed on Claude Code's own session id (`metadata.user_id` → `session_id`),
   * which is stable for every turn of a session, survives a claudish restart
   * mid-conversation, and cannot collide between two concurrent conversations.
   * Contrast a `cwd`-derived key, which is the same value for two unrelated
   * sessions in one repo and outlives them both.
   *
   * The id is HASHED rather than sent raw. It is not a secret, but it is a
   * local correlation handle that also appears in transcripts and in the
   * behavior journal, and a stable one-way digest serves the routing hint
   * exactly as well. `device_id` and `account_uuid` from that same blob are
   * never read at all — see `extractSessionId`.
   *
   * Matters most against a third-party Codex-compatible backend reached via
   * `OPENAI_CODEX_BASE_URL`, where cache behaviour was measurably worse than
   * talking to Codex directly (#113).
   */
  private resolvePromptCacheKey(claudeRequest?: any): string {
    const sessionId = extractSessionId(claudeRequest);
    if (!sessionId) return `claudish_${FALLBACK_CONVERSATION_KEY}`;
    if (this.cachedCacheKeyFor !== sessionId) {
      this.cachedCacheKeyFor = sessionId;
      this.cachedCacheKey = `claudish_${createHash("sha256")
        .update(sessionId)
        .digest("hex")
        .slice(0, 32)}`;
    }
    return this.cachedCacheKey;
  }

  /**
   * The ChatGPT Codex OAuth backend enforces a SMALLER context window than the
   * model's headline spec (e.g. gpt-5.6-sol: ~372K on codex vs 1.05M on the
   * OpenAI API), and OpenAI keeps shrinking it. Return the codex-specific window
   * from the slim catalog's per-provider (`openai-codex`) aggregator entry — so
   * the status line reflects the true ceiling instead of the 1.05M API spec.
   * Falls back to the model's top-level window, or 0 (unknown) when the model
   * isn't in the catalog — matching the pre-existing TokenTracker seed, so a
   * catalog miss is a no-op. Flows through composed-handler's transport override.
   * NOTE: display/telemetry only — it does not change the request sent upstream.
   */
  getContextWindow(): number {
    return lookupModelForProvider(this.modelName, this.name) ?? 0;
  }
}
