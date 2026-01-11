import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { exec } from "node:child_process";
import { log } from "../logger.js";

// Constants from gemini-cli (these are public OAuth credentials for CLI usage)
// Default values are from the official gemini-cli - they're public by design for CLI tools
const OAUTH_CLIENT_ID = process.env.GEMINI_OAUTH_CLIENT_ID ?? "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const OAUTH_CLIENT_SECRET = process.env.GEMINI_OAUTH_CLIENT_SECRET ?? "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";
const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];
const REDIRECT_URI_PATH = "/oauth2callback";
const CONFIG_DIR = join(homedir(), ".claudish");
const CREDENTIALS_FILE = join(CONFIG_DIR, "gemini-oauth.json");
const CODE_ASSIST_API_BASE = "https://cloudcode-pa.googleapis.com/v1internal";

interface OAuthCredentials {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  id_token?: string;
  expiry_date: number;
}

interface ClientMetadata {
  ideType?: string;
  ideVersion?: string;
  pluginVersion?: string;
  platform?: string;
  updateChannel?: string;
  duetProject?: string;
  pluginType?: string;
  ideName?: string;
}

interface LoadCodeAssistResponse {
  currentTier?: { id: string };
  allowedTiers?: { id: string }[];
  cloudaicompanionProject?: string;
}

interface OnboardUserResponse {
  cloudaicompanionProject?: { id: string };
}

interface LRO {
  name: string;
  done?: boolean;
  response?: OnboardUserResponse;
  error?: any;
}

/**
 * Generate PKCE code verifier
 */
function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(32));
}

/**
 * Generate PKCE code challenge from verifier
 */
function generateCodeChallenge(verifier: string): string {
  const hash = createHash("sha256").update(verifier).digest();
  return base64UrlEncode(hash);
}

/**
 * Base64 URL encode
 */
function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Open URL in browser
 */
function openUrl(url: string) {
  const start =
    process.platform == "darwin"
      ? "open"
      : process.platform == "win32"
      ? "start"
      : "xdg-open";
  exec(`${start} "${url}"`);
}

/**
 * Perform OAuth login flow
 */
export async function performGeminiOAuthLogin(): Promise<void> {
  return new Promise(async (resolve, reject) => {
    try {
      // 1. Setup PKCE
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = base64UrlEncode(randomBytes(16));

      // 2. Start local server
      const server = createServer(async (req, res) => {
        try {
          if (!req.url?.startsWith(REDIRECT_URI_PATH)) {
            res.writeHead(404);
            res.end("Not found");
            return;
          }

          const address = server.address() as any;
          const url = new URL(req.url, `http://localhost:${address.port}`);
          const code = url.searchParams.get("code");
          const returnedState = url.searchParams.get("state");
          const error = url.searchParams.get("error");

          if (error) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(`<h1>Login Failed</h1><p>${error}</p>`);
            server.close();
            reject(new Error(`OAuth error: ${error}`));
            return;
          }

          if (returnedState !== state) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(`<h1>Login Failed</h1><p>State mismatch</p>`);
            server.close();
            reject(new Error("State mismatch"));
            return;
          }

          if (code) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(`<h1>Login Successful</h1><p>You can close this window and return to the terminal.</p>`);
            
            // Exchange code for tokens
            try {
              const tokens = await exchangeCodeForTokens(code, codeVerifier, `http://localhost:${address.port}${REDIRECT_URI_PATH}`);
              await saveOAuthCredentials(tokens);
              console.log("Successfully logged in to Gemini!");
              server.close();
              resolve();
            } catch (err) {
              console.error("Error exchanging code for tokens:", err);
              server.close();
              reject(err);
            }
          }
        } catch (err) {
          console.error("Server error:", err);
          res.writeHead(500);
          res.end("Internal Server Error");
          server.close();
          reject(err);
        }
      });

      // Listen on random port
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as any;
        const redirectUri = `http://localhost:${address.port}${REDIRECT_URI_PATH}`;
        
        // 3. Build Auth URL
        const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        authUrl.searchParams.set("client_id", OAUTH_CLIENT_ID);
        authUrl.searchParams.set("redirect_uri", redirectUri);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("scope", OAUTH_SCOPES.join(" "));
        authUrl.searchParams.set("code_challenge", codeChallenge);
        authUrl.searchParams.set("code_challenge_method", "S256");
        authUrl.searchParams.set("state", state);
        authUrl.searchParams.set("access_type", "offline"); // Crucial for refresh token
        authUrl.searchParams.set("prompt", "consent"); // Ensure we get refresh token

        console.log("Opening browser for Gemini login...");
        console.log(`If it doesn't open automatically, visit:\n${authUrl.toString()}`);
        
        openUrl(authUrl.toString());
      });

    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Exchange auth code for tokens
 */
async function exchangeCodeForTokens(code: string, codeVerifier: string, redirectUri: string): Promise<OAuthCredentials> {
  const params = new URLSearchParams();
  params.set("client_id", OAUTH_CLIENT_ID);
  params.set("client_secret", OAUTH_CLIENT_SECRET);
  params.set("code", code);
  params.set("code_verifier", codeVerifier);
  params.set("grant_type", "authorization_code");
  params.set("redirect_uri", redirectUri);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    scope: data.scope,
    token_type: data.token_type,
    id_token: data.id_token,
    expiry_date: Date.now() + (data.expires_in * 1000),
  };
}

/**
 * Refresh access token
 */
async function refreshAccessToken(refreshToken: string): Promise<OAuthCredentials> {
  const params = new URLSearchParams();
  params.set("client_id", OAUTH_CLIENT_ID);
  params.set("client_secret", OAUTH_CLIENT_SECRET);
  params.set("refresh_token", refreshToken);
  params.set("grant_type", "refresh_token");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    scope: data.scope,
    token_type: data.token_type,
    id_token: data.id_token,
    expiry_date: Date.now() + (data.expires_in * 1000),
  };
}

/**
 * Save credentials to disk
 */
async function saveOAuthCredentials(creds: OAuthCredentials): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

/**
 * Load credentials from disk
 */
export async function loadCachedOAuthCredentials(): Promise<OAuthCredentials> {
  try {
    const data = await readFile(CREDENTIALS_FILE, "utf-8");
    return JSON.parse(data);
  } catch (error) {
    throw new Error("No OAuth credentials found. Please run `claudish --gemini-login`.");
  }
}

/**
 * Get a valid access token (refreshing if necessary)
 */
export async function getValidAccessToken(): Promise<string> {
  let creds = await loadCachedOAuthCredentials();
  
  // Check if expired (with 5 minute buffer)
  if (Date.now() > creds.expiry_date - 5 * 60 * 1000) {
    log("[GeminiOAuth] Token expired, refreshing...");
    try {
      creds = await refreshAccessToken(creds.refresh_token);
      await saveOAuthCredentials(creds);
    } catch (e) {
      log(`[GeminiOAuth] Refresh failed: ${e}`);
      throw new Error("Failed to refresh Gemini token. Please run `claudish --gemini-login` again.");
    }
  }

  return creds.access_token;
}

/**
 * Check if we have valid-ish credentials (files exist)
 */
export async function hasOAuthCredentials(): Promise<boolean> {
  try {
    await readFile(CREDENTIALS_FILE, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Setup the Gemini user (loadCodeAssist + onboardUser flow)
 * Returns the projectId to use for requests.
 */
export async function setupGeminiUser(accessToken: string): Promise<{ projectId: string }> {
  const envProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
  
  // 1. loadCodeAssist
  const loadRes = await callLoadCodeAssist(accessToken, envProject);
  
  if (loadRes.currentTier || loadRes.cloudaicompanionProject) {
    if (envProject) return { projectId: envProject }; 
    if (loadRes.cloudaicompanionProject) return { projectId: loadRes.cloudaicompanionProject };
  }

  // 2. onboardUser
  const tierId = "free-tier";
  
  log("[GeminiOAuth] Onboarding user to free-tier...");
  let lro = await callOnboardUser(accessToken, tierId, envProject);
  
  // Poll LRO
  while (!lro.done) {
    await new Promise(r => setTimeout(r, 2000));
    // Re-call onboardUser to poll (as gemini-cli does)
    lro = await callOnboardUser(accessToken, tierId, envProject);
  }

  if (lro.error) {
    throw new Error(`Gemini onboarding failed: ${JSON.stringify(lro.error)}`);
  }

  const projectId = lro.response?.cloudaicompanionProject?.id;
  if (!projectId) {
    if (envProject) return { projectId: envProject };
    throw new Error("Gemini onboarding completed but no project ID returned.");
  }

  return { projectId };
}

async function callLoadCodeAssist(accessToken: string, projectId?: string): Promise<LoadCodeAssistResponse> {
  const metadata: ClientMetadata = {
    pluginType: "GEMINI",
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    duetProject: projectId
  };

  const res = await fetch(`${CODE_ASSIST_API_BASE}:loadCodeAssist`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ metadata, cloudaicompanionProject: projectId })
  });

  if (!res.ok) {
    throw new Error(`loadCodeAssist failed: ${res.status} ${await res.text()}`);
  }

  return await res.json();
}

async function callOnboardUser(accessToken: string, tierId: string, projectId?: string): Promise<LRO> {
  const metadata: ClientMetadata = {
    pluginType: "GEMINI",
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    duetProject: projectId
  };

  const res = await fetch(`${CODE_ASSIST_API_BASE}:onboardUser`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      tierId,
      metadata,
      cloudaicompanionProject: projectId 
    })
  });

  if (!res.ok) {
    throw new Error(`onboardUser failed: ${res.status} ${await res.text()}`);
  }

  return await res.json();
}
