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
 * OPENAI_CODEX_API_KEY fallback internally.
 *
 * When OAuth is unavailable the authority FALLS THROUGH to that api-key half, which
 * returns an artifact of its own — an endpoint-less one, so getEndpoint()/getHeaders()
 * below land on the plain api-key path (api.openai.com + Bearer key) from the OpenAI
 * base transport. `cachedAuth` stays null ONLY when getRequestAuth throws, which
 * needs an AVAILABLE OAuth primary whose refresh was then rejected. An earlier
 * version of this comment ran the two together ("throws/falls through … cachedAuth
 * stays null") and a billing discriminator was built on it; see refreshAuth().
 *
 * IMPORTANT: OAuth tokens only work with chatgpt.com/backend-api, NOT api.openai.com.
 */

import { normalizeCodexModel } from "../../adapters/codex-api-format.js";
import { lookupModelForProvider } from "../../adapters/model-catalog.js";
import { CodexOAuth } from "../../auth/codex-oauth.js";
import { credentials } from "../../auth/credentials/authority.js";
import { recordSignedArm } from "../../auth/credentials/billing-probe.js";
import { CodexOAuthHalf } from "../../auth/credentials/codex-credential.js";
import type { RequestAuth } from "../../auth/credentials/types.js";
import { classifyConnectionError } from "../../handlers/shared/connection-error.js";
import { conversationKey } from "./conversation-key.js";
import { OpenAIProviderTransport } from "./openai.js";
import type { AuthBinding } from "./types.js";

export class OpenAICodexTransport extends OpenAIProviderTransport {
  /**
   * The last auth artifact refreshAuth() minted. Shared by every request on this
   * transport, so the request path never reads it: ComposedHandler passes the
   * request's own `AuthBinding` instead. Read only by callers that pass no
   * binding (probes, tests). Null when OAuth is unavailable — the transport then
   * falls back to the OpenAI base transport's api-key path.
   */
  private cachedAuth: RequestAuth | null = null;

  /**
   * Resolve OAuth (or fall through to api-key) via the credential authority and
   * cache the artifact. composed-handler calls this before getEndpoint/getHeaders.
   * The Codex credential ignores ctx.model, so "" is fine.
   */
  async refreshAuth(): Promise<AuthBinding> {
    try {
      this.cachedAuth = await credentials.getRequestAuth("openai-codex", { model: "" });
    } catch (err) {
      // A NETWORK failure is not a rejected refresh, and must not be treated as
      // one. Swallowing it fell through to the api-key path — the METERED
      // `api.openai.com` — for a user whose subscription was only unreachable,
      // not revoked. Rethrown, composed-handler's `refreshAuth` site classifies
      // it and holds the request (CLAUDE.md: a connection failure wearing an
      // auth status, the five sites; this catch was a sixth that swallowed).
      if (classifyConnectionError(err)) throw err;
      // The refresh was REJECTED (or no OAuth) → use the api-key path below.
      this.cachedAuth = null;
    }
    // ── DO NOT rewrite this as `this.cachedAuth ? "subscription" : "metered"` ──
    //
    // That was the shipped version and it was WRONG in the money-losing
    // direction. `cachedAuth` is non-null on BOTH arms:
    // CompositeCredentialProvider.getRequestAuth falls through to
    // `return this.fallback.getRequestAuth(ctx)` (composite-credential.ts) and the
    // api-key half ALWAYS returns an object (api-key-credential.ts) —
    // `{headers:{Authorization:"Bearer sk-…"}}` with a key, `{headers:{}}` without
    // one. It never returns null and never throws. So `cachedAuth` is null only
    // when getRequestAuth THREW, i.e. an available OAuth primary whose refresh was
    // rejected. Truthiness therefore labelled every plain api-key request — and
    // every credential-less one — `subscription`, reporting SUB and $0 accrued
    // while OpenAI metered the request at api.openai.com.
    //
    // Truthiness IS a valid selector for getEndpoint()/getHeaders() below, because
    // those treat null as "use the api-key path" and a metered artifact carries no
    // endpoint override, so both land on the same behaviour. It is not valid for
    // billing. Three reviewers read the old line as correct; that is why this
    // comment is this long.
    //
    // The artifact NAMES its arm (auth/credentials/types.ts, `RequestAuth.arm`).
    // Absent or null ⇒ metered: unknown must resolve to the paid answer, because
    // over-quoting a subscriber is cosmetic while under-reporting a metered user's
    // spend is the one error that costs them (remote-provider-types.ts).
    const signedWithOAuth = this.cachedAuth?.arm === "oauth";
    recordSignedArm("openai-codex", signedWithOAuth ? "subscription" : "metered");
    // The artifact just minted, bound to THIS request. ComposedHandler passes it
    // back to transformPayload/getEndpoint/getHeaders, so a concurrent request's
    // refresh (which replaces `cachedAuth`) cannot change what this one signs with.
    return { auth: this.cachedAuth };
  }

  /**
   * After a 401 on the subscription arm: rotate the Codex OAuth token and mint
   * a fresh artifact from the OAuth half ONLY.
   *
   * The api-key half is never consulted, so a 401 retry can never change arm:
   * an expired subscription token must not quietly re-sign the request with
   * OPENAI_CODEX_API_KEY on the metered `api.openai.com`. ComposedHandler calls
   * this only when the request's binding is the `"oauth"` arm.
   *
   * `refreshToken()` single-flights through CodexOAuth's refresh lock, so
   * concurrent 401s on one login spend the (single-use) refresh token once.
   * Every throw propagates unchanged: a connection failure reaches the
   * `forceRefreshAuth` site in composed-handler, which classifies it (one of
   * the five auth sites); swallowing it here would be a sixth site that hides
   * an outage.
   */
  async forceRefreshAuth(): Promise<AuthBinding> {
    await CodexOAuth.getInstance().refreshToken();
    const auth = await new CodexOAuthHalf().getRequestAuth({ model: "" });
    // Kept for callers that pass no binding; the request path uses the return.
    this.cachedAuth = auth;
    return { auth };
  }

  /**
   * The artifact a call reads: the request's binding when one is passed (its
   * `auth`, even when null), else `cachedAuth` for callers that pass none.
   * Null ⇒ the OpenAI base transport's api-key path.
   */
  private authFor(binding: AuthBinding | undefined): RequestAuth | null {
    return binding ? binding.auth : this.cachedAuth;
  }

  /**
   * OAuth tokens only work with chatgpt.com/backend-api (endpoint comes from the
   * auth artifact). API keys use the standard OpenAI endpoint (super).
   */
  override getEndpoint(_targetModel?: string, binding?: AuthBinding): string {
    return this.authFor(binding)?.endpoint ?? super.getEndpoint();
  }

  override async getHeaders(
    _claudeRequest?: unknown,
    binding?: AuthBinding
  ): Promise<Record<string, string>> {
    const auth = this.authFor(binding);
    if (auth) return { ...auth.headers };
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
  transformPayload(payload: any, claudeRequest?: any, binding?: AuthBinding): any {
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
      // The reasoning summary is what Claude Code shows as thinking. The
      // catalog wire does not publish it, so the wire shaper drops it with the
      // rest of `reasoning`; it is a Codex display field, restored here only
      // where reasoning was actually sent.
      const reasoning = normalizedPayload.reasoning;
      if (reasoning && typeof reasoning === "object" && reasoning.summary === undefined) {
        normalizedPayload = { ...normalizedPayload, reasoning: { ...reasoning, summary: "auto" } };
      }
    }
    // Auth-derived store:false / include reasoning bits, only under OAuth.
    return this.authFor(binding)?.transformPayload?.(normalizedPayload) ?? normalizedPayload;
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
   * The key itself — why session id, why hashed, the fallback — is
   * `conversationKey()`, shared with OpenCode Zen's `x-opencode-session`.
   *
   * Matters most against a third-party Codex-compatible backend reached via
   * `OPENAI_CODEX_BASE_URL`, where cache behaviour was measurably worse than
   * talking to Codex directly (#113).
   */
  private resolvePromptCacheKey(claudeRequest?: any): string {
    return conversationKey(claudeRequest);
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
