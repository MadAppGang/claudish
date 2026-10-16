/**
 * Grok OAuth — claudish's OWN login, no Grok CLI required.
 *
 * This is the deliberate opposite of the Antigravity arrangement, and the
 * difference is structural rather than a matter of taste:
 *
 *   Antigravity — Google registered its client as CONFIDENTIAL. The
 *   `GOCSPX-…` secret rotates, cannot be shipped in an npm package, and is
 *   therefore extracted from the user's own local `agy` binary at runtime.
 *   Owning that flow would mean chasing a secret that changes under us.
 *
 *   Grok — xAI registered the Grok CLI as a PUBLIC client. `auth.x.ai`'s
 *   discovery document lists `"none"` in
 *   `token_endpoint_auth_methods_supported`, which is the correct registration
 *   for a CLI precisely because a widely-distributed secret is not a secret.
 *   There is nothing to rotate, so there is nothing to chase.
 *
 * So claudish drives the RFC 8628 Device Authorization Grant itself:
 * `POST /oauth2/device/code` → show the user a code + URL → poll
 * `POST /oauth2/token` until they approve. Device flow rather than
 * authorization-code + loopback because claudish frequently runs where a
 * localhost redirect cannot be received — an MCP child, a `team` fan-out, a
 * remote shell — and the device flow is the one grant that works in all of them.
 *
 * The result: `claudish login grok` works on a machine that has never had the
 * Grok CLI installed. Reading the CLI's own `~/.grok/auth.json` remains
 * supported as a FALLBACK (see `grok-credentials.ts`), so an existing
 * `grok login` is still picked up for free.
 */

import { log } from "../logger.js";
import { credentialHttpError, terminalCredentialError } from "./credentials/credential-error.js";
import { type BaseCredentials, OAuthManager } from "./oauth-manager.js";

/** OIDC issuer for the Grok CLI's identity provider. */
const GROK_ISSUER = "https://auth.x.ai";
const DEVICE_CODE_ENDPOINT = `${GROK_ISSUER}/oauth2/device/code`;
const TOKEN_ENDPOINT = `${GROK_ISSUER}/oauth2/token`;
const REVOKE_ENDPOINT = `${GROK_ISSUER}/oauth2/revoke`;

/**
 * The Grok CLI's public client id.
 *
 * NOT a secret and not reverse-engineered: xAI publishes it in their own
 * installer at https://x.ai/cli/install.sh, as
 * `OIDC_SCOPE="https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"`.
 * A public client has no accompanying secret to protect.
 *
 * `resolveClientId()` prefers the id recorded in a local `~/.grok/auth.json`
 * when one exists, so a future rotation is picked up without a claudish
 * release; this constant is the floor for machines with no CLI installed.
 */
export const GROK_PUBLIC_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

/**
 * Scopes requested at login — matched EXACTLY to the Grok CLI's own token.
 *
 * Taken from the `scope` claim of a working `grok login` token rather than
 * guessed from the issuer's `scopes_supported`, and that distinction cost a
 * round trip: an earlier version requested a sensible-looking subset
 * (`openid profile email offline_access grok-cli:access`) and login SUCCEEDED —
 * the IdP happily issued a token — but every inference request then failed
 *
 *   403 {"code":"permission-denied",
 *        "error":"OAuth2 token missing required scope: api:access"}
 *
 * So the authorization server and the resource server disagree about what a
 * usable token looks like, and only the resource server's opinion matters. A
 * scope set that logs in cleanly is NOT evidence of a working credential.
 *
 * `offline_access` is separately load-bearing: without it the IdP issues no
 * refresh token, and a 6-hour access token with no refresh means
 * re-authenticating three times a day.
 *
 * Note `team:read`, `org:read` and `grok-plugins:access` are advertised by the
 * issuer but are NOT in the CLI's token, so they are not requested here —
 * matching the CLI is the known-good configuration, and asking for authority we
 * do not need is the wrong default.
 */
const GROK_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "grok-cli:access",
  // Required by cli-chat-proxy for inference. Its absence is a 403 at request
  // time, never at login time.
  "api:access",
  "conversations:read",
  "conversations:write",
  "workspaces:read",
  "workspaces:write",
].join(" ");

/** RFC 8628 grant urn. */
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface GrokOAuthCredentials extends BaseCredentials {
  /** The client id the token was minted by — needed verbatim to refresh it. */
  client_id: string;
  /** Space-separated scopes actually granted, for diagnostics. */
  scope?: string;
}

interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

/** Poll interval floor, per RFC 8628 §3.5 when the server sends none. */
const DEFAULT_POLL_INTERVAL_S = 5;

export class GrokOAuth extends OAuthManager<GrokOAuthCredentials> {
  protected readonly credentialFile = "grok-oauth.json";
  protected readonly providerName = "GrokOAuth";
  protected readonly loginHint = "claudish login grok";

  private static instance: GrokOAuth | null = null;

  static getInstance(): GrokOAuth {
    if (!GrokOAuth.instance) {
      GrokOAuth.instance = new GrokOAuth();
    }
    return GrokOAuth.instance;
  }

  constructor() {
    super();
    this.credentials = this.loadCredentials();
  }

  protected validateCredentials(data: unknown): data is GrokOAuthCredentials {
    if (!data || typeof data !== "object") return false;
    const d = data as Record<string, unknown>;
    return (
      typeof d.access_token === "string" &&
      typeof d.refresh_token === "string" &&
      typeof d.expires_at === "number"
    );
  }

  /** The access token, refreshing when needed. Public entry for the credential provider. */
  async getToken(): Promise<string> {
    return this.getAccessToken();
  }

  /**
   * Exchange the refresh token. Public client: `client_id` in the body, no
   * secret. The IdP may ROTATE the refresh token, so whatever comes back is
   * persisted — dropping it would strand the next refresh on a dead token.
   */
  protected async doRefreshToken(): Promise<string> {
    const current = this.credentials;
    if (!current) {
      throw terminalCredentialError(
        `No Grok credentials found. Please run \`${this.loginHint}\` first.`
      );
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refresh_token,
      client_id: current.client_id || GROK_PUBLIC_CLIENT_ID,
    });

    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    // The body is read apart from its parse: a reset while it streams is a
    // network fault and keeps its cause and endpoint, so connection recovery
    // classifies it. Only a body that arrived and does not parse is treated as
    // an answer with no token (the same split as the Muse mint).
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw Object.assign(
        new Error(
          `Lost the connection to ${TOKEN_ENDPOINT} while reading the Grok token: ${(error as Error).message}`,
          { cause: error }
        ),
        { claudishEndpoint: TOKEN_ENDPOINT }
      );
    }
    let parsed: TokenResponse;
    try {
      parsed = JSON.parse(text) as TokenResponse;
    } catch {
      // A 2xx that is not JSON is a gateway answering for the token host, not
      // a verdict on the grant: retryable. A non-2xx falls to its status below.
      if (response.ok) {
        throw Object.assign(
          new Error(
            "Grok token refresh answered with a body that is not JSON; retrying will usually work."
          ),
          { transient: true as const, upstreamStatus: 503 }
        );
      }
      parsed = {};
    }
    if (!response.ok || !parsed.access_token) {
      const detail = parsed.error_description ?? parsed.error ?? `HTTP ${response.status}`;
      // `invalid_grant` means the refresh token is dead — only a new login
      // fixes it, so say that rather than leaving the user to guess. A 429 or
      // 5xx from the token host is NOT that: it is marked transient, so the
      // request retries instead of stopping on a login instruction.
      if (!response.ok) {
        throw credentialHttpError(
          `Grok token refresh failed: ${detail}. Run \`${this.loginHint}\` to sign in.`,
          response.status
        );
      }
      throw terminalCredentialError(
        `Grok token refresh failed: ${detail}. Run \`${this.loginHint}\` to sign in.`
      );
    }

    const next: GrokOAuthCredentials = {
      access_token: parsed.access_token,
      // Keep the existing refresh token when the server does not rotate it.
      refresh_token: parsed.refresh_token ?? current.refresh_token,
      expires_at: Date.now() + (parsed.expires_in ?? 6 * 60 * 60) * 1000,
      client_id: current.client_id || GROK_PUBLIC_CLIENT_ID,
      scope: parsed.scope ?? current.scope,
    };
    this.credentials = next;
    this.saveCredentials(next);
    return next.access_token;
  }

  /**
   * Full device-authorization login.
   *
   * `clientId` is injectable so the caller can pass an id discovered from a
   * local `~/.grok/auth.json`, which is how a rotation is absorbed without a
   * claudish release.
   */
  async login(clientId: string = GROK_PUBLIC_CLIENT_ID): Promise<void> {
    const auth = await this.requestDeviceCode(clientId);

    const url = auth.verification_uri_complete ?? auth.verification_uri;
    console.log("\nSign in to Grok (SuperGrok or X Premium+ subscription required).");
    console.log(`\n  Code: ${auth.user_code}`);
    // The code and URL are shown BEFORE the browser opens: if opening fails, or
    // the browser lands on a different profile, the user still has everything
    // they need on screen. `presentAuthUrl` also arms the copy-to-clipboard key.
    const disposeUrlPrompt = this.presentAuthUrl(url);
    await this.openBrowser(url, "Opening your browser… (approve the request there)");

    try {
      const credentials = await this.pollForToken(auth, clientId);
      this.credentials = credentials;
      this.saveCredentials(credentials);
    } finally {
      // Must run on the failure path too — a timed-out or declined login would
      // otherwise leave the terminal in raw mode with echo off.
      disposeUrlPrompt();
    }
    console.log('\nSigned in to Grok. Try it with: claudish --model gk@grok-4.6 "hello"\n');
  }

  private async requestDeviceCode(clientId: string): Promise<DeviceAuthorizationResponse> {
    const response = await fetch(DEVICE_CODE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, scope: GROK_SCOPES }),
    });

    const parsed = (await response.json().catch(() => ({}))) as DeviceAuthorizationResponse &
      TokenResponse;
    if (!response.ok || !parsed.device_code || !parsed.user_code) {
      const detail = parsed.error_description ?? parsed.error ?? `HTTP ${response.status}`;
      throw new Error(`Could not start Grok device authorization: ${detail}`);
    }
    return parsed;
  }

  /**
   * Poll the token endpoint until the user approves, declines, or the code
   * expires.
   *
   * RFC 8628 defines three NON-terminal responses that must not abort the loop:
   * `authorization_pending` (the user simply has not finished yet),
   * `slow_down` (back off — the interval must be increased permanently, not
   * just for one iteration), and a plain network blip. Everything else is
   * terminal and is surfaced as-is.
   */
  private async pollForToken(
    auth: DeviceAuthorizationResponse,
    clientId: string
  ): Promise<GrokOAuthCredentials> {
    let intervalMs = (auth.interval ?? DEFAULT_POLL_INTERVAL_S) * 1000;
    const deadline = Date.now() + auth.expires_in * 1000;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));

      let parsed: TokenResponse;
      try {
        const response = await fetch(TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: DEVICE_CODE_GRANT,
            device_code: auth.device_code,
            client_id: clientId,
          }),
        });
        parsed = (await response.json().catch(() => ({}))) as TokenResponse;
      } catch (error) {
        // A transient network failure must not throw away an authorization the
        // user may be in the middle of approving.
        log(`[${this.providerName}] Poll failed, retrying: ${(error as Error).message}`);
        continue;
      }

      if (parsed.access_token) {
        return {
          access_token: parsed.access_token,
          refresh_token: parsed.refresh_token ?? "",
          expires_at: Date.now() + (parsed.expires_in ?? 6 * 60 * 60) * 1000,
          client_id: clientId,
          scope: parsed.scope,
        };
      }

      if (parsed.error === "authorization_pending") continue;
      if (parsed.error === "slow_down") {
        // Permanent increase, per RFC 8628 §3.5 — a one-shot bump would be
        // rejected again on the very next iteration.
        intervalMs += 5000;
        continue;
      }

      throw new Error(
        `Grok sign-in failed: ${parsed.error_description ?? parsed.error ?? "unknown error"}`
      );
    }

    throw new Error("Grok sign-in timed out — the device code expired. Please try again.");
  }

  /**
   * Revoke at the IdP, then delete locally.
   *
   * Revocation is best-effort: if it fails the local credential is still
   * removed, because a logout that leaves a usable token on disk is the more
   * surprising outcome of the two.
   */
  async logout(): Promise<void> {
    const current = this.credentials;
    if (current?.refresh_token) {
      try {
        await fetch(REVOKE_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: current.refresh_token,
            token_type_hint: "refresh_token",
            client_id: current.client_id || GROK_PUBLIC_CLIENT_ID,
          }),
        });
      } catch (error) {
        log(`[${this.providerName}] Revocation failed (deleting locally anyway): ${error}`);
      }
    }
    await super.logout();
  }
}
