/** Return-only Codex PKCE. Persistence belongs to the caller, never this flow. */
import { exec } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { log } from "../logger.js";
import { resolveUpstreamUrl } from "../test-upstream.js";
import type { AccountIdentity } from "./accounts/types.js";
import type { CodexCredentials } from "./codex-oauth.js";

export const CODEX_OAUTH_CONFIG = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  scopes: ["openid", "profile", "email", "offline_access"],
};

export interface CodexPkceResult {
  credentials: CodexCredentials;
  /** Only chatgpt_account_id is stable identity; the legacy user_id fallback is not. */
  identity: AccountIdentity;
}

export interface CodexCallbackResult {
  authCode: string;
  state: string | null;
  redirectUri: string;
}

export interface CodexCallbackOptions {
  port: number;
  timeoutMs: number;
  state: string;
  authorize: (redirectUri: string) => string;
  openBrowser: (url: string) => Promise<void>;
}

export interface CodexPkceDeps {
  browser?: (url: string) => Promise<void>;
  callback?: (options: CodexCallbackOptions) => Promise<CodexCallbackResult>;
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  id_token?: string;
}

function loginClaims(idToken?: string): { accountId?: string; identity: AccountIdentity } {
  try {
    if (!idToken || idToken.split(".").length !== 3) return { identity: {} };
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf-8"));
    const auth = payload["https://api.openai.com/auth"];
    const stable = auth?.chatgpt_account_id || payload.chatgpt_account_id;
    const text = (value: unknown) =>
      typeof value === "string" && value.trim() ? value : undefined;
    // The wire id keeps the legacy extractor's exact precedence and value.
    const wireId = stable || auth?.user_id;
    return {
      accountId: wireId ? wireId : undefined,
      identity: {
        chatgptAccountId: text(stable),
        email: text(payload.email),
        plan: text(auth?.chatgpt_plan_type),
      },
    };
  } catch {
    // Claims are optional for legacy login. Never print a JWT or its parse error.
    return { identity: {} };
  }
}

function buildAuthUrl(challenge: string, state: string, redirectUri: string): string {
  const params = [
    "response_type=code",
    `client_id=${encodeURIComponent(CODEX_OAUTH_CONFIG.clientId)}`,
    `redirect_uri=${encodeURIComponent(redirectUri)}`,
    `scope=${CODEX_OAUTH_CONFIG.scopes.join("+")}`,
    `code_challenge=${encodeURIComponent(challenge)}`,
    "code_challenge_method=S256",
    "id_token_add_organizations=true",
    "codex_cli_simplified_flow=true",
    `state=${encodeURIComponent(state)}`,
    "originator=opencode",
  ].join("&");
  return `${CODEX_OAUTH_CONFIG.authUrl}?${params}`;
}

async function openBrowser(url: string): Promise<void> {
  const execAsync = promisify(exec);
  try {
    if (process.platform === "darwin") await execAsync(`open "${url}"`);
    else if (process.platform === "win32") await execAsync(`start "${url}"`);
    else await execAsync(`xdg-open "${url}"`);
    console.log("\nOpening browser for OpenAI authentication...");
    console.log(`If the browser doesn't open, visit this URL:\n${url}\n`);
  } catch {
    console.log("\nPlease open this URL in your browser to authenticate:");
    console.log(url);
    console.log("");
  }
}

function waitForCallback(
  options: CodexCallbackOptions,
  deps: CodexPkceDeps
): Promise<CodexCallbackResult> {
  return new Promise((resolve, reject) => {
    let redirectUri = "";
    const schedule = deps.setTimeout ?? setTimeout;
    const cancel = deps.clearTimeout ?? clearTimeout;
    const finish = (error?: Error, result?: CodexCallbackResult) => {
      if (timer !== undefined) cancel(timer);
      server.close();
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const server = createServer((req, res) => {
      const url = new URL(req.url!, redirectUri.replace("/auth/callback", ""));
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      if (error || !state || state !== options.state || !code) {
        const detail = error
          ? "OAuth authorization was refused."
          : !state || state !== options.state
            ? "Invalid state parameter. Possible CSRF attack."
            : "No authorization code received.";
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          `<html><body><h1>Authentication Failed</h1><p>${detail}</p><p>You can close this window.</p></body></html>`
        );
        finish(
          new Error(
            error
              ? "OAuth authorization was refused"
              : !state || state !== options.state
                ? "Invalid OAuth state parameter (CSRF protection)"
                : "No authorization code received"
          )
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><body><h1>Authentication Successful!</h1><p>You can now close this window and return to your terminal.</p></body></html>"
      );
      finish(undefined, { authCode: code, state, redirectUri });
    });
    server.on("error", (err) =>
      finish(new Error(`Failed to start callback server: ${err.message}`))
    );
    // Port 1455 is part of the existing Codex redirect contract, not an ephemeral port.
    server.listen(options.port, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        finish(new Error("Failed to get server port"));
        return;
      }
      redirectUri = `http://localhost:${address.port}/auth/callback`;
      log(`[CodexOAuth] Callback server started on http://localhost:${address.port}`);
      void options
        .openBrowser(options.authorize(redirectUri))
        .catch(() => finish(new Error("Could not open OAuth browser")));
    });
    const timer = schedule(
      () => finish(new Error("OAuth login timed out after 5 minutes")),
      options.timeoutMs
    );
  });
}

/** Shares authorization parameters, callback validation and token exchange with legacy login. */
export async function loginCodexPkce(deps: CodexPkceDeps = {}): Promise<CodexPkceResult> {
  log("[CodexOAuth] Starting OAuth login flow");
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(32).toString("base64url");
  const options: CodexCallbackOptions = {
    port: 1455,
    timeoutMs: 5 * 60 * 1000,
    state,
    authorize: (redirectUri) => buildAuthUrl(challenge, state, redirectUri),
    openBrowser: deps.browser ?? openBrowser,
  };
  const callback = await (deps.callback ? deps.callback(options) : waitForCallback(options, deps));
  // The injected callback is not an authorization bypass.
  if (!callback.state || callback.state !== state)
    throw new Error("Invalid OAuth state parameter (CSRF protection)");
  if (!callback.authCode) throw new Error("No authorization code received");
  if (callback.redirectUri !== "http://localhost:1455/auth/callback")
    throw new Error("Invalid OAuth redirect URI");

  log("[CodexOAuth] Exchanging auth code for tokens");
  let tokens: TokenResponse;
  try {
    const response = await (deps.fetch ?? globalThis.fetch)(
      resolveUpstreamUrl(CODEX_OAUTH_CONFIG.tokenUrl),
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: callback.authCode,
          redirect_uri: callback.redirectUri,
          client_id: CODEX_OAUTH_CONFIG.clientId,
          code_verifier: verifier,
        }),
      }
    );
    if (!response.ok) {
      // No token response body, authorization code or verifier enters an error/log.
      throw new Error(`Token exchange failed: ${response.status}`);
    }
    try {
      tokens = (await response.json()) as TokenResponse;
    } catch {
      throw new Error("Invalid OAuth token response");
    }
    if (!tokens.access_token || !tokens.refresh_token)
      throw new Error("Token response missing access_token or refresh_token");
  } catch (error) {
    // A fetch implementation can include its submitted body in an error.
    const message = error instanceof Error ? error.message : "Token exchange failed";
    const safe = message
      .split(callback.authCode)
      .join("[redacted]")
      .split(verifier)
      .join("[redacted]");
    throw new Error(`Failed to authenticate with OpenAI OAuth: ${safe}`);
  }
  const claims = loginClaims(tokens.id_token);
  return {
    credentials: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token!,
      expires_at: (deps.now ?? Date.now)() + tokens.expires_in * 1000,
      account_id: claims.accountId,
    },
    identity: claims.identity,
  };
}
