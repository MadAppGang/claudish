/**
 * OpenAI Codex ProviderTransport
 *
 * Extends OpenAI transport with OAuth token support for ChatGPT Plus/Pro subscriptions.
 *
 * The transport no longer manages OAuth itself, and it no longer STORES the
 * result either. On each request composed-handler calls signRequest() (BEFORE
 * transformPayload/getEndpoint/getHeaders) and holds the returned artifact as a
 * `handle()`-scoped local, passing it back into each of those three. The
 * authority's Codex credential mints the OAuth artifact (chatgpt.com endpoint +
 * OAuth headers + store:false/include payload transform), and applies the
 * OPENAI_CODEX_API_KEY fallback internally.
 *
 * Request-scoped rather than cached on `this` because ONE transport instance
 * serves concurrent turns: a field written before an `await` is read back by
 * whichever request wrote it last, so under `serve` two conversations could sign
 * with each other's credentials and bill each other's accounts.
 *
 * When OAuth is unavailable the authority FALLS THROUGH to that api-key half, which
 * returns an artifact of its own — an endpoint-less one, so getEndpoint()/getHeaders()
 * below land on the plain api-key path (api.openai.com + Bearer key) from the OpenAI
 * base transport. getRequestAuth throws only with an AVAILABLE OAuth primary whose
 * refresh was then rejected, and signRequest does NOT catch that: an error here is
 * the handler's to surface — as an inline 400 with `upstream_status: 401` and the
 * `claudish login codex` hint (see signRequest), or, for a token host that could
 * not be reached at all, as a classified connection failure the recovery ladder
 * holds — never a silent downgrade to the metered host. An earlier
 * version of this comment ran the two together ("throws/falls through … cachedAuth
 * stays null") and a billing discriminator was built on it; see signRequest().
 *
 * IMPORTANT: OAuth tokens only work with chatgpt.com/backend-api, NOT api.openai.com.
 */

import { normalizeCodexModel } from "../../adapters/codex-api-format.js";
import { lookupModelForProvider } from "../../adapters/model-catalog.js";
import { MeteredEscapeError } from "../../auth/accounts/errors.js";
import { getAccountRegistry } from "../../auth/accounts/registry.js";
import { credentials } from "../../auth/credentials/authority.js";
import { recordSignedArm } from "../../auth/credentials/billing-probe.js";
import type { RequestAuth } from "../../auth/credentials/types.js";
import { accountsFaultArmed } from "../../test-upstream.js";
import { conversationKey } from "./conversation-key.js";
import { OpenAIProviderTransport } from "./openai.js";
import type { AuthBinding, ForceRefreshContext, SignRequestContext } from "./types.js";

export class OpenAICodexTransport extends OpenAIProviderTransport {
  /**
   * Resolve this request's credential and RETURN it. Nothing is stored on
   * `this`.
   *
   * NO try/catch, deliberately. The old `catch { this.cachedAuth = null }` meant
   * "fall to the api-key path", and that route is expressed by the credential
   * layer handing back an api-key artifact — never by an exception swallowed
   * here. An error escaping this method is an error the handler must surface;
   * turning it into a silently metered request is the failure mode this whole
   * seam exists to remove.
   *
   * What "surface" means for a failed OAuth refresh — initial sign or the 401
   * re-sign — is fixed by the error itself, not by a catch here: for a rejected
   * login CodexOAuth throws `CodexOAuthRefreshError` (`terminal: true`,
   * `upstreamStatus: 401`, a message naming `claudish login codex`), and
   * ComposedHandler turns that into an inline 400 carrying `upstream_status:
   * 401`. Not a bare 401 — Claude Code reads that as its own login failure —
   * and never a metered signature. A local fault (credential file, refresh
   * lock, save) is `CodexOAuthLocalError`, a transient 503 on the same hop.
   * The exception is a token host that cannot be REACHED: CodexOAuth throws a
   * plain error with `{ cause }` and `claudishEndpoint`, which ComposedHandler
   * classifies as a connection failure and holds in the recovery ladder. 401
   * there would advance a routing chain off the subscription for an outage.
   *
   * DELIBERATE, and user-visible: someone whose ChatGPT login has expired or been
   * revoked AND who has OPENAI_CODEX_API_KEY set used to be served, silently, on
   * that per-token key. They now get this error instead. A failed subscription
   * refresh fails visibly; it does not quietly start billing a metered key.
   * (Absent OAuth entirely — no login at all — still signs with the key: that is
   * the composite's fallback arm, which returns an artifact rather than throwing.)
   *
   * The Codex credential ignores ctx.model, so "" is fine.
   */
  poolConfigured(): boolean {
    return getAccountRegistry().mayHaveConfiguredAccounts("openai-codex");
  }

  async signRequest(ctx: SignRequestContext = {}): Promise<RequestAuth> {
    const signed = await credentials.getRequestAuth("openai-codex", {
      model: "",
      ...ctx,
    });
    // Guarded loopback-only fault reaches the SAME check at every signing site.
    const auth: RequestAuth =
      signed.account?.provider === "openai-codex" && accountsFaultArmed("non-oauth-artifact")
        ? { arm: "api-key", endpoint: super.getEndpoint(), headers: {} }
        : signed;
    if (
      (ctx.requireOAuth || this.poolConfigured() || signed.account !== undefined) &&
      (auth.arm !== "oauth" ||
        (auth.account !== undefined && auth.account.provider !== "openai-codex"))
    ) {
      throw new MeteredEscapeError("Codex signing returned a non-OAuth artifact");
    }
    // Both composite arms return objects (even {headers:{}} with no key).
    // Truthiness once labelled every metered request SUB and accrued $0.
    // Only the accepted artifact's arm is billing evidence; absent means metered.
    recordSignedArm("openai-codex", auth.arm === "oauth" ? "subscription" : "metered");
    return auth;
  }

  /**
   * The request's binding, for a caller that holds no signing context (the
   * leg issuer's no-context path, probes). It is {@link signRequest} with an
   * empty context; ComposedHandler signs through `signRequest` itself.
   *
   * It carries NO `requireOAuth` latch. Never call it for a request that has
   * already signed: with no account pool configured, a legacy login removed
   * mid-request would sign the next call with OPENAI_CODEX_API_KEY. Pass the
   * request's latch through `signRequest`, as ComposedHandler's legs do.
   */
  async refreshAuth(): Promise<AuthBinding> {
    return { auth: await this.signRequest({}) };
  }

  /**
   * After a 401 on the subscription arm: the ONE re-sign path, a forced
   * {@link signRequest} carrying the request's signing state.
   *
   * Through `signRequest`, not a direct `CodexOAuth` refresh: with an account
   * pool the login to refresh is the pooled account that signed (`ctx.pin`),
   * and the legacy singleton is a different credential. `forceRefresh` makes
   * the credential half exchange its refresh token once, single-flighted and
   * gated across processes (`CodexOAuth.forceRefresh`, the pool's token
   * manager). `requireOAuth` comes from the request's latch, so a 401 retry can
   * never change arm onto OPENAI_CODEX_API_KEY and the metered host:
   * `signRequest` throws `MeteredEscapeError` instead. ComposedHandler calls this
   * only when the request's binding is the `"oauth"` arm, and the arm it
   * records is recorded by `signRequest`, as every other sign's is.
   *
   * Every throw propagates unchanged: a connection failure reaches the
   * `forceRefreshAuth` site in composed-handler, which classifies it (one of
   * the five auth sites); swallowing it here would be a sixth site that hides
   * an outage.
   */
  async forceRefreshAuth(ctx: ForceRefreshContext = {}): Promise<AuthBinding> {
    const { rejectedHeaders: _rejectedHeaders, ...signing } = ctx;
    return { auth: await this.signRequest({ ...signing, forceRefresh: true }) };
  }

  /**
   * OAuth tokens only work with chatgpt.com/backend-api (the endpoint comes from
   * THIS REQUEST's auth artifact). API keys use the standard OpenAI endpoint
   * (super).
   *
   * `binding` is the request's binding ComposedHandler holds as a
   * `handle()`-scoped local. No transport field can supply an artifact when the
   * caller omits it.
   */
  override getEndpoint(_targetModel?: string, binding?: AuthBinding): string {
    return binding?.auth?.endpoint ?? super.getEndpoint();
  }

  override async getHeaders(
    _claudeRequest?: unknown,
    binding?: AuthBinding
  ): Promise<Record<string, string>> {
    const auth = binding?.auth;
    if (auth) return { ...auth.headers };
    // Fall back to API key auth (Bearer <OPENAI_CODEX_API_KEY>).
    return super.getHeaders();
  }

  /**
   * Normalize the model name for the ChatGPT backend (a pure, non-auth transform —
   * the ChatGPT backend only knows ChatGPT-specific model names like "gpt-5.1"),
   * and attach the conversation-scoped `prompt_cache_key` (see
   * resolvePromptCacheKey). An explicit key already on the payload always wins.
   * The auth-derived bits (store:false / include reasoning) come from THIS
   * REQUEST's auth artifact's transformPayload, applied only when OAuth is
   * active.
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
    return binding?.auth?.transformPayload?.(normalizedPayload) ?? normalizedPayload;
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
