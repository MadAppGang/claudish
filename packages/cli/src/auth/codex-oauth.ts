/**
 * OpenAI Codex OAuth Authentication Manager
 *
 * Handles OAuth2 PKCE flow for OpenAI Codex API access via ChatGPT Plus/Pro subscription.
 * Supports:
 * - Browser-based OAuth login with local callback server
 * - Secure credential storage with 0600 permissions
 * - Automatic token refresh with 5-minute buffer
 * - Singleton pattern for shared token management
 * - Account ID extraction from id_token JWT claims
 *
 * Credentials stored at: ~/.claudish/codex-oauth.json
 */

import { exec } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { markOwnTimeout } from "../handlers/shared/connection-error.js";
import { TOKEN_REFRESH_TIMEOUT_MS } from "../handlers/shared/transient-retry.js";
import { log } from "../logger.js";
import { credentialHttpError } from "./credentials/credential-error.js";

const execAsync = promisify(exec);

/**
 * OAuth credentials structure
 */
export interface CodexCredentials {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp (ms)
  account_id?: string; // Extracted from id_token JWT claims (chatgpt_account_id)
}

/**
 * OpenAI OAuth token response
 */
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  id_token?: string; // JWT containing chatgpt_account_id claim
}

/**
 * OAuth configuration for OpenAI Codex (public PKCE client — no client_secret needed)
 */
const OAUTH_CONFIG = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  scopes: ["openid", "profile", "email", "offline_access"],
};

/**
 * Manages OAuth authentication for OpenAI Codex API (ChatGPT Plus/Pro subscription)
 */
export class CodexOAuth {
  private static instance: CodexOAuth | null = null;
  private credentials: CodexCredentials | null = null;
  private refreshPromise: Promise<string> | null = null;
  private tokenRefreshMargin = 5 * 60 * 1000; // Refresh 5 minutes before expiry
  private oauthState: string | null = null; // CSRF protection

  /**
   * Get singleton instance
   */
  static getInstance(): CodexOAuth {
    if (!CodexOAuth.instance) {
      CodexOAuth.instance = new CodexOAuth();
    }
    return CodexOAuth.instance;
  }

  /**
   * Private constructor (singleton pattern)
   */
  private constructor() {
    // Try to load existing credentials on startup
    this.credentials = this.loadCredentials();
  }

  /**
   * Re-read the credential file from disk into the in-memory singleton.
   *
   * The singleton loads credentials ONCE in its constructor, so a login that
   * happens in a CHILD process (e.g. the config TUI spawns `claudish login
   * codex`) writes a fresh token file this long-lived parent never sees — its
   * request path keeps using the stale startup snapshot and fails until the
   * process is relaunched. Calling this after a login child returns picks up the
   * new token in-process, no restart needed.
   */
  reloadCredentials(): void {
    this.credentials = this.loadCredentials();
    this.refreshPromise = null;
  }

  /**
   * Check if credentials exist (without validating expiry)
   * Use this to determine if login is needed before making requests
   */
  hasCredentials(): boolean {
    return this.credentials !== null && !!this.credentials.refresh_token;
  }

  /**
   * Get credentials file path
   */
  private getCredentialsPath(): string {
    const claudishDir = join(homedir(), ".claudish");
    return join(claudishDir, "codex-oauth.json");
  }

  /**
   * Start OAuth login flow
   * Opens browser, starts local callback server, exchanges code for tokens
   */
  async login(): Promise<void> {
    log("[CodexOAuth] Starting OAuth login flow");

    // Generate PKCE verifier and challenge
    const codeVerifier = this.generateCodeVerifier();
    const codeChallenge = await this.generateCodeChallenge(codeVerifier);

    // Generate state for CSRF protection
    this.oauthState = randomBytes(32).toString("base64url");

    // Start local callback server (uses random port) and wait for auth code
    const { authCode, redirectUri } = await this.startCallbackServer(
      codeChallenge,
      this.oauthState
    );

    // Exchange auth code for tokens
    const tokens = await this.exchangeCodeForTokens(authCode, codeVerifier, redirectUri);

    // Extract account_id from id_token JWT (if present)
    const accountId = tokens.id_token ? this.extractAccountId(tokens.id_token) : undefined;

    // Save credentials
    const credentials: CodexCredentials = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token!,
      expires_at: Date.now() + tokens.expires_in * 1000,
      account_id: accountId,
    };

    this.saveCredentials(credentials);
    this.credentials = credentials;

    // Clear state after successful login
    this.oauthState = null;

    log("[CodexOAuth] Login successful");
    if (accountId) {
      log(`[CodexOAuth] Account ID: ${accountId}`);
    }
  }

  /**
   * Logout - delete stored credentials
   */
  async logout(): Promise<void> {
    const credPath = this.getCredentialsPath();

    if (existsSync(credPath)) {
      unlinkSync(credPath);
      log("[CodexOAuth] Credentials deleted");
    }

    this.credentials = null;
  }

  /**
   * Get valid access token, refreshing if needed
   */
  async getAccessToken(): Promise<string> {
    // If refresh already in progress, wait for it
    if (this.refreshPromise) {
      log("[CodexOAuth] Waiting for in-progress refresh");
      return this.refreshPromise;
    }

    // Check if we have credentials
    if (!this.credentials) {
      throw new Error(
        "No OpenAI Codex OAuth credentials found. Please run `claudish login codex` first."
      );
    }

    // Check if token is still valid
    if (this.isTokenValid()) {
      return this.credentials.access_token;
    }

    // Start refresh (lock to prevent duplicate refreshes)
    this.refreshPromise = this.doRefreshToken().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  /**
   * Get the stored account ID (ChatGPT-Account-ID header value)
   */
  getAccountId(): string | undefined {
    return this.credentials?.account_id;
  }

  /**
   * Force refresh the access token.
   *
   * Single-flighted through the same `refreshPromise` lock as `getAccessToken`:
   * a rotated refresh token is single-use, so two concurrent forced refreshes
   * (two requests answered 401 at once) that each spent it would leave the
   * second holding a token the server already invalidated. A refresh already
   * in flight is joined, never duplicated.
   */
  async refreshToken(): Promise<void> {
    if (this.refreshPromise) {
      log("[CodexOAuth] Joining in-progress refresh");
      await this.refreshPromise;
      return;
    }
    if (!this.credentials) {
      throw new Error(
        "No OpenAI Codex OAuth credentials found. Please run `claudish login codex` first."
      );
    }

    this.refreshPromise = this.doRefreshToken().finally(() => {
      this.refreshPromise = null;
    });
    await this.refreshPromise;
  }

  /**
   * Check if cached token is still valid
   */
  private isTokenValid(): boolean {
    if (!this.credentials) return false;
    return Date.now() < this.credentials.expires_at - this.tokenRefreshMargin;
  }

  /**
   * Perform the actual token refresh.
   * OpenAI uses a PUBLIC PKCE client — no client_secret needed in refresh requests.
   */
  private async doRefreshToken(): Promise<string> {
    if (!this.credentials) {
      throw new Error(
        "No OpenAI Codex OAuth credentials found. Please run `claudish login codex` first."
      );
    }

    log("[CodexOAuth] Refreshing access token");

    // THE FETCH ITSELF THROWING MEANS THE NETWORK, NOT THE CREDENTIAL. This used
    // to share one `catch` with the HTTP-rejection path below, which rewrapped
    // every failure as "OAuth credentials invalid. Please run `claudish login
    // codex` again" with no `cause` — so an `auth.openai.com` outage told the
    // user to log in again, and named no host. It still classified, but only by
    // `classifyConnectionError`'s MESSAGE fallback matching Bun's text embedded
    // after "Details:" — a wording match that covers Bun's refused and DNS
    // phrasings and nothing else. (The billing defect was the other half:
    // `openai-codex.ts` swallowed this throw and sent the request to the
    // METERED `api.openai.com` path mid-outage.)
    //
    // `{ cause }` makes classification structural: the classifier walks the
    // cause chain for the code, whatever the message says. `claudishEndpoint`
    // names the host that actually failed; without it the handler reports the
    // model host. The same shape as `grok-credentials.ts` and `vertex-oauth.ts`.
    let response: Response;
    try {
      response = await fetch(OAUTH_CONFIG.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: this.credentials.refresh_token,
          client_id: OAUTH_CONFIG.clientId,
        }),
        // Bounds `refreshPromise`'s single-flight latch — see
        // TOKEN_REFRESH_TIMEOUT_MS.
        signal: AbortSignal.timeout(TOKEN_REFRESH_TIMEOUT_MS),
      });
    } catch (e) {
      log(`[CodexOAuth] Could not reach ${OAUTH_CONFIG.tokenUrl}: ${(e as Error).message}`);
      // `markOwnTimeout`: the ceiling above is ours, so its `TimeoutError` is a
      // reachability fact. Untagged it would go unclassified, and
      // `openai-codex.ts` would read it as a rejected refresh and fall back to
      // the METERED api-key path — the bug this function was just fixed for.
      throw Object.assign(
        new Error(
          `Could not reach ${OAUTH_CONFIG.tokenUrl} to refresh the Codex token: ${(e as Error).message}`,
          { cause: markOwnTimeout(e) }
        ),
        { claudishEndpoint: OAUTH_CONFIG.tokenUrl }
      );
    }

    // The body is read apart from its parse (the grok-oauth.ts split). `fetch`
    // resolves on the HEADERS and the request's timeout signal is still armed
    // while the body streams, so a stalled or reset body is a network fault:
    // it keeps its cause, its own-timeout mark and the endpoint, and connection
    // recovery classifies it. It is never "log in again".
    let text: string;
    try {
      text = await response.text();
    } catch (e) {
      log(
        `[CodexOAuth] Lost ${OAUTH_CONFIG.tokenUrl} while reading the token: ${(e as Error).message}`
      );
      throw Object.assign(
        new Error(
          `Lost the connection to ${OAUTH_CONFIG.tokenUrl} while reading the Codex token: ${(e as Error).message}`,
          { cause: markOwnTimeout(e) }
        ),
        { claudishEndpoint: OAUTH_CONFIG.tokenUrl }
      );
    }

    // A non-2xx: 429/5xx is transient, a rejected grant (400/401/403) terminal.
    // Only the terminal answer tells the user to log in again: a busy or down
    // token host says nothing about the login, and a new login does not help.
    if (!response.ok) {
      log(`[CodexOAuth] Refresh failed: HTTP ${response.status}`);
      const busy = response.status === 429 || (response.status >= 500 && response.status <= 599);
      throw credentialHttpError(
        busy
          ? `The Codex token host is busy or unavailable (HTTP ${response.status}); retrying will usually work.\n\nDetails: ${text}`
          : `OAuth credentials invalid. Please run \`claudish login codex\` again.\n\nDetails: Token refresh failed: ${response.status} - ${text}`,
        response.status
      );
    }

    // A 2xx that is not JSON is a gateway answering for the token host:
    // retryable. A 2xx JSON with no access token does not show the login is
    // dead either: retryable (503), and nothing is persisted from it (the old
    // code saved `access_token: undefined`).
    let tokens: Partial<TokenResponse>;
    try {
      tokens = JSON.parse(text) as Partial<TokenResponse>;
    } catch {
      throw Object.assign(
        new Error(
          "Codex token refresh answered with a body that is not JSON; retrying will usually work."
        ),
        { transient: true as const, upstreamStatus: 503 }
      );
    }
    if (typeof tokens?.access_token !== "string" || tokens.access_token.length === 0) {
      throw Object.assign(
        new Error(
          "The Codex token host answered without an access token; nothing was saved. Retrying will usually work; run `claudish login codex` if this persists."
        ),
        { transient: true as const, upstreamStatus: 503 }
      );
    }

    // Extract account_id from refreshed id_token if present
    const accountId = tokens.id_token
      ? this.extractAccountId(tokens.id_token)
      : this.credentials.account_id;

    // Update credentials (keep existing refresh token if new one not provided)
    const expiresIn = typeof tokens.expires_in === "number" ? tokens.expires_in : 3600;
    const updatedCredentials: CodexCredentials = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || this.credentials.refresh_token,
      expires_at: Date.now() + expiresIn * 1000,
      account_id: accountId,
    };

    this.saveCredentials(updatedCredentials);
    this.credentials = updatedCredentials;

    log(
      `[CodexOAuth] Token refreshed, valid until ${new Date(updatedCredentials.expires_at).toISOString()}`
    );

    return updatedCredentials.access_token;
  }

  /**
   * Load credentials from file
   */
  private loadCredentials(): CodexCredentials | null {
    const credPath = this.getCredentialsPath();

    if (!existsSync(credPath)) {
      return null;
    }

    try {
      const data = readFileSync(credPath, "utf-8");
      const credentials = JSON.parse(data) as CodexCredentials;

      // Validate structure
      if (!credentials.access_token || !credentials.refresh_token || !credentials.expires_at) {
        log("[CodexOAuth] Invalid credentials file structure");
        return null;
      }

      log("[CodexOAuth] Loaded credentials from file");
      return credentials;
    } catch (e: any) {
      log(`[CodexOAuth] Failed to load credentials: ${e.message}`);
      return null;
    }
  }

  /**
   * Save credentials to file with 0600 permissions
   */
  private saveCredentials(credentials: CodexCredentials): void {
    const credPath = this.getCredentialsPath();
    const claudishDir = join(homedir(), ".claudish");

    // Ensure directory exists
    if (!existsSync(claudishDir)) {
      const { mkdirSync } = require("node:fs");
      mkdirSync(claudishDir, { recursive: true });
    }

    // Atomically create file with secure permissions (0600) to prevent race condition
    const fd = openSync(credPath, "w", 0o600);
    try {
      const data = JSON.stringify(credentials, null, 2);
      writeSync(fd, data, 0, "utf-8");
    } finally {
      closeSync(fd);
    }

    log(`[CodexOAuth] Credentials saved to ${credPath}`);
  }

  /**
   * Generate PKCE code verifier (random 128-character string)
   */
  private generateCodeVerifier(): string {
    return randomBytes(64).toString("base64url");
  }

  /**
   * Generate PKCE code challenge (SHA256 hash of verifier)
   */
  private async generateCodeChallenge(verifier: string): Promise<string> {
    const hash = createHash("sha256").update(verifier).digest("base64url");
    return hash;
  }

  /**
   * Extract chatgpt_account_id from id_token JWT payload.
   * Simple base64 decode of the payload section — no signature validation needed
   * (the token was just received over HTTPS from the auth server).
   */
  private extractAccountId(idToken: string): string | undefined {
    try {
      const parts = idToken.split(".");
      if (parts.length !== 3) return undefined;

      // Decode the payload (second part)
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
      const authClaim = payload["https://api.openai.com/auth"];
      const accountId =
        authClaim?.chatgpt_account_id || payload.chatgpt_account_id || authClaim?.user_id;

      if (accountId) {
        log(`[CodexOAuth] Extracted account ID from id_token: ${accountId}`);
        return accountId;
      }

      return undefined;
    } catch (e: any) {
      log(`[CodexOAuth] Failed to extract account ID from id_token: ${e.message}`);
      return undefined;
    }
  }

  /**
   * Build OAuth authorization URL.
   * OpenAI PKCE flow — no access_type or prompt params (unlike Google OAuth).
   */
  private buildAuthUrl(codeChallenge: string, state: string, redirectUri: string): string {
    // Use + for scope separators (matching working opencode implementation)
    const scope = OAUTH_CONFIG.scopes.join("+");
    const params = [
      "response_type=code",
      `client_id=${encodeURIComponent(OAUTH_CONFIG.clientId)}`,
      `redirect_uri=${encodeURIComponent(redirectUri)}`,
      `scope=${scope}`,
      `code_challenge=${encodeURIComponent(codeChallenge)}`,
      "code_challenge_method=S256",
      "id_token_add_organizations=true",
      "codex_cli_simplified_flow=true",
      `state=${encodeURIComponent(state)}`,
      "originator=opencode",
    ].join("&");

    return `${OAUTH_CONFIG.authUrl}?${params}`;
  }

  /**
   * Start local callback server and wait for authorization code
   * Uses random available port (port 0) to avoid conflicts
   */
  private async startCallbackServer(
    codeChallenge: string,
    state: string
  ): Promise<{ authCode: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      let redirectUri = "";

      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url!, redirectUri.replace("/auth/callback", ""));

        if (url.pathname === "/auth/callback") {
          const code = url.searchParams.get("code");
          const callbackState = url.searchParams.get("state");
          const error = url.searchParams.get("error");

          if (error) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(`
              <html>
                <body>
                  <h1>Authentication Failed</h1>
                  <p>Error: ${error}</p>
                  <p>You can close this window.</p>
                </body>
              </html>
            `);
            server.close();
            reject(new Error(`OAuth error: ${error}`));
            return;
          }

          // Validate state parameter (CSRF protection)
          if (!callbackState || callbackState !== this.oauthState) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(`
              <html>
                <body>
                  <h1>Authentication Failed</h1>
                  <p>Invalid state parameter. Possible CSRF attack.</p>
                  <p>You can close this window.</p>
                </body>
              </html>
            `);
            server.close();
            reject(new Error("Invalid OAuth state parameter (CSRF protection)"));
            return;
          }

          if (!code) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(`
              <html>
                <body>
                  <h1>Authentication Failed</h1>
                  <p>No authorization code received.</p>
                  <p>You can close this window.</p>
                </body>
              </html>
            `);
            server.close();
            reject(new Error("No authorization code received"));
            return;
          }

          // Success
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`
            <html>
              <body>
                <h1>Authentication Successful!</h1>
                <p>You can now close this window and return to your terminal.</p>
              </body>
            </html>
          `);

          server.close();
          resolve({ authCode: code, redirectUri });
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
        }
      });

      // Use port 1455 (matching working opencode implementation)
      server.listen(1455, () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to get server port"));
          return;
        }

        const port = address.port;
        redirectUri = `http://localhost:${port}/auth/callback`;
        log(`[CodexOAuth] Callback server started on http://localhost:${port}`);

        // Build auth URL with the actual port and open browser
        const authUrl = this.buildAuthUrl(codeChallenge, state, redirectUri);
        this.openBrowser(authUrl);
      });

      server.on("error", (err) => {
        reject(new Error(`Failed to start callback server: ${err.message}`));
      });

      // Timeout after 5 minutes
      setTimeout(
        () => {
          server.close();
          reject(new Error("OAuth login timed out after 5 minutes"));
        },
        5 * 60 * 1000
      );
    });
  }

  /**
   * Exchange authorization code for access/refresh tokens.
   * OpenAI uses a PUBLIC PKCE client — no client_secret in the exchange request.
   */
  private async exchangeCodeForTokens(
    code: string,
    verifier: string,
    redirectUri: string
  ): Promise<TokenResponse> {
    log("[CodexOAuth] Exchanging auth code for tokens");

    try {
      const response = await fetch(OAUTH_CONFIG.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: OAUTH_CONFIG.clientId,
          code_verifier: verifier,
          // No client_secret — PKCE public client
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Token exchange failed: ${response.status} - ${errorText}`);
      }

      const tokens = (await response.json()) as TokenResponse;

      if (!tokens.access_token || !tokens.refresh_token) {
        throw new Error("Token response missing access_token or refresh_token");
      }

      return tokens;
    } catch (e: any) {
      throw new Error(`Failed to authenticate with OpenAI OAuth: ${e.message}`);
    }
  }

  /**
   * Open URL in default browser
   */
  private async openBrowser(url: string): Promise<void> {
    const platform = process.platform;

    try {
      if (platform === "darwin") {
        await execAsync(`open "${url}"`);
      } else if (platform === "win32") {
        await execAsync(`start "${url}"`);
      } else {
        // Linux/Unix
        await execAsync(`xdg-open "${url}"`);
      }

      console.log("\nOpening browser for OpenAI authentication...");
      console.log(`If the browser doesn't open, visit this URL:\n${url}\n`);
    } catch (e: any) {
      console.log("\nPlease open this URL in your browser to authenticate:");
      console.log(url);
      console.log("");
    }
  }
}

/**
 * Get the shared CodexOAuth instance
 */
export function getCodexOAuth(): CodexOAuth {
  return CodexOAuth.getInstance();
}

/**
 * Get a valid access token (refreshing if needed)
 * Helper function for handlers to use
 */
export async function getValidCodexAccessToken(): Promise<string> {
  const oauth = CodexOAuth.getInstance();
  return oauth.getAccessToken();
}
