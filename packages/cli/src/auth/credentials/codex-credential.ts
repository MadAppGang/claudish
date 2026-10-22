/**
 * OpenAI Codex credential — OAuth (ChatGPT Plus/Pro) with API-key fallback.
 *
 * `makeCodexCredential()` returns a CompositeCredentialProvider whose primary is
 * the pool half ({@link CodexPoolHalf}) and whose fallback is an API-key
 * provider keyed on OPENAI_CODEX_API_KEY. The fallback has NO aliases — it must
 * NOT accept the generic OPENAI_API_KEY (that key is for the regular OpenAI
 * provider, not the Codex Responses endpoint).
 */

import { resolveUpstreamUrl } from "../../test-upstream.js";
import { MeteredEscapeError } from "../accounts/errors.js";
import { type AccountPool, getAccountPool } from "../accounts/pool.js";
import { type AccountRegistry, getAccountRegistry } from "../accounts/registry.js";
import { CodexOAuth } from "../codex-oauth.js";
import { ApiKeyCredentialProvider } from "./api-key-credential.js";
import { CompositeCredentialProvider } from "./composite-credential.js";
import type { CredentialProvider, RequestAuth, RequestAuthContext } from "./types.js";

/** ChatGPT Codex backend endpoint (OAuth tokens only work here, not api.openai.com). */
const CODEX_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

/**
 * Build the Codex OAuth headers (moved from providers/transport/openai-codex.ts).
 */
function buildOAuthHeaders(token: string, accountId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    accept: "text/event-stream",
  };
  if (accountId) {
    headers["chatgpt-account-id"] = accountId;
    // Add conversation/session headers for stateless operation
    headers["x-conversation-id"] = "claudish-session";
    headers["x-session-id"] = "claudish-session";
  }
  return headers;
}

function oauthPayload(p: any): any {
  return { ...p, store: false, include: ["reasoning.encrypted_content"] };
}

/**
 * The OAuth half of the Codex composite credential.
 */
export class CodexOAuthHalf implements CredentialProvider {
  readonly catalogName = "openai-codex";
  private oauth = CodexOAuth.getInstance();

  /**
   * Is an OAuth login CONFIGURED — the one fact that decides whether the
   * composite may fall through to the metered `OPENAI_CODEX_API_KEY` half.
   *
   * `hasCredentials()` answers true for a credential file that EXISTS but could
   * not be read (`EACCES`, `EIO`, `EMFILE`, truncated JSON). That is deliberate
   * and it is the whole fix for V16b: the composite commits to THIS half, and
   * `getRequestAuth` below then throws `CodexOAuthLocalError` naming the file
   * (503 with the transient verdict: a local fault, never a rejected login, so
   * a routing chain does not walk onto a metered hop). It used to read that
   * file as "never logged in", and the composite signed the request metered.
   * Only a file that does not exist (or names no refresh token) answers false.
   *
   * No `describeReadiness` on purpose: reporting `failed` here would let the
   * composite's projection turn it into `isAvailable() === false`, and an
   * explicit `cx@` would stop at "No credentials configured" instead of reaching
   * the error that names the unreadable file.
   *
   * This remains the legacy facade's predicate. Pool availability and the
   * unsigned billing probe instead share the registry's configuration fact.
   */
  async isAvailable(): Promise<boolean> {
    return this.oauth.hasCredentials();
  }

  async getRequestAuth(ctx: RequestAuthContext): Promise<RequestAuth> {
    if (ctx.requireOAuth && !this.oauth.hasCredentials()) {
      throw new MeteredEscapeError("Codex OAuth login disappeared during this request");
    }
    // The 401 path (`forceRefresh`). Upstream has just rejected the bearer we
    // signed with, so the cached token is worthless however fresh its
    // `expires_at` claims to be — `getAccessToken()` alone would hand back the
    // same dead string and the retry would 401 again.
    //
    // `forceRefresh()` is the ONE entry for that, and the order of what it does
    // is the whole fix: join this process's in-flight refresh, take the
    // cross-process gate shared with the account pool, re-read the file UNDER
    // the gate, adopt a token another process already rotated, and only
    // otherwise exchange the CURRENT on-disk refresh token exactly once.
    //
    // It used to be `reloadCredentials()` + `refreshToken()`. The reload cleared
    // the single flight and the refresh exchanged directly with no gate, so N
    // concurrent 401s (main turn, subagents, background calls) presented ONE
    // refresh token N times: `refresh_token_reused` for every presenter after the
    // first, and reuse detection can revoke the whole grant.
    //
    // A failure here is deliberately NOT caught: the composite rethrows it, and
    // the handler surfaces it. A rejected login is `CodexOAuthRefreshError`
    // (terminal, upstream 401, inline with the `claudish login codex` hint); a
    // local fault — an unreadable credential file, a refresh lock that could not
    // be taken, a token that could not be saved — is `CodexOAuthLocalError`
    // (transient 503, same hop). There is no metered fallback behind either:
    // `getAccessToken()` re-reads an unreadable file on every request and
    // reports it with that same error while it stays unreadable.
    const token = ctx.forceRefresh
      ? await this.oauth.forceRefresh()
      : await this.oauth.getAccessToken();
    const accountId = this.oauth.getAccountId();
    return {
      // Credential halves stamp their own arm. The transport records this as
      // SUB only after accepting the artifact; object truthiness proves nothing.
      arm: "oauth",
      headers: buildOAuthHeaders(token, accountId),
      // No-op unless CLAUDISH_TEST_UPSTREAM names a loopback target. The
      // metered canary listens on its OWN port registered for api.openai.com,
      // so a rewrite here can never be mistaken for a metered request.
      endpoint: resolveUpstreamUrl(CODEX_RESPONSES_ENDPOINT),
      transformPayload: oauthPayload,
    };
  }

  async login(): Promise<void> {
    await this.oauth.login();
  }

  async logout(): Promise<void> {
    await this.oauth.logout();
  }
}

/** Configuration-only pool primary; synthesized legacy signing stays on the facade. */
export class CodexPoolHalf implements CredentialProvider {
  readonly catalogName = "openai-codex";

  constructor(
    private readonly registry: AccountRegistry = getAccountRegistry(),
    private readonly pool: AccountPool = getAccountPool("openai-codex"),
    private readonly legacy: CredentialProvider = new CodexOAuthHalf()
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.registry.hasConfiguredAccounts("openai-codex");
  }

  async getRequestAuth(ctx: RequestAuthContext): Promise<RequestAuth> {
    // A pin must be validated by acquisition, even after the last row disappears.
    if (!ctx.pin && this.registry.isSynthesizedLegacyOnly()) {
      return this.legacy.getRequestAuth(ctx);
    }
    if (!ctx.pin && !this.registry.hasConfiguredAccounts("openai-codex") && ctx.requireOAuth) {
      throw new MeteredEscapeError("Codex account list disappeared during this request");
    }
    const rejected = Object.entries(ctx.rejected?.headers ?? {}).find(
      ([key]) => key.toLowerCase() === "authorization"
    )?.[1];
    const lease = await this.pool.acquire({
      exclude: ctx.exclude,
      pin: ctx.pin,
      forceRefresh: ctx.forceRefresh,
      rejectedAccessToken: rejected?.replace(/^Bearer\s+/i, ""),
      selectionContext: ctx.selectionContext,
    });
    return {
      arm: "oauth",
      account: lease.account,
      headers: buildOAuthHeaders(lease.accessToken, lease.accountId),
      endpoint: resolveUpstreamUrl(CODEX_RESPONSES_ENDPOINT),
      transformPayload: oauthPayload,
    };
  }

  /**
   * The legacy browser login. `CodexOAuth.login()` refuses before the browser
   * when Codex rows are configured, so pooled accounts are added with
   * `claudish account add codex`, never through this path.
   */
  async login(): Promise<void> {
    await this.legacy.login?.();
  }

  /**
   * The legacy logout. With rows configured `CodexOAuth.logout()` refuses before
   * anything is unlinked and names `claudish account remove codex <label>` (the
   * enrolled `legacy-codex-file` row's label when there is one); a legacy-only
   * config deletes the file as before. Without this method the composite's
   * `primary.logout?.()` was a silent no-op for every Codex user.
   */
  async logout(): Promise<void> {
    await this.legacy.logout?.();
  }
}

/**
 * Build the full Codex credential: OAuth primary + OPENAI_CODEX_API_KEY fallback.
 */
export function makeCodexCredential(): CompositeCredentialProvider {
  return new CompositeCredentialProvider(
    "openai-codex",
    new CodexPoolHalf(),
    new ApiKeyCredentialProvider({
      catalogName: "openai-codex",
      envVar: "OPENAI_CODEX_API_KEY",
    })
  );
}
