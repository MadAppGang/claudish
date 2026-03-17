import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

interface OAuthProviderDescriptor {
  credentialFile: string;
  validationMode: "file-exists" | "check-expiry";
  expiresAtField?: string;
  expiryBufferMs?: number;
}

/**
 * Providers with working OAuth device authorization flows.
 *
 * Providers NOT listed here use API keys only (no public OAuth device-auth endpoint):
 *   - openai        (OPENAI_API_KEY) - OpenAI does not offer public OAuth device auth
 *   - minimax       (MINIMAX_API_KEY) - API key only
 *   - minimax-coding (MINIMAX_CODING_API_KEY) - API key only
 *   - glm           (ZHIPU_API_KEY) - API key only
 *   - glm-coding    (GLM_CODING_API_KEY) - API key only
 *   - ollamacloud   (OLLAMA_API_KEY) - API key only
 *   - zai           (ZAI_API_KEY) - API key only
 *   - litellm       (LITELLM_API_KEY) - API key only
 *   - vertex        (VERTEX_API_KEY / VERTEX_PROJECT) - uses ADC / service account
 *
 * These providers are covered by the direct API-key step (Step 3) in the
 * auto-routing priority chain.  OAuth entries can be added here in future
 * phases if those providers implement a public device-auth grant.
 */
export const OAUTH_PROVIDERS: Record<string, OAuthProviderDescriptor> = {
  // Kimi / Moonshot AI - Device Authorization Grant (RFC 8628)
  // Login via: claudish --kimi-login
  "kimi-coding": {
    credentialFile: "kimi-oauth.json",
    validationMode: "check-expiry",
    expiresAtField: "expires_at",
    expiryBufferMs: 5 * 60 * 1000,
  },
  kimi: {
    credentialFile: "kimi-oauth.json",
    validationMode: "check-expiry",
    expiresAtField: "expires_at",
    expiryBufferMs: 5 * 60 * 1000,
  },
  // Google Gemini Code Assist - OAuth2 PKCE flow (browser-based)
  // Login via: claudish --gemini-login
  google: {
    credentialFile: "gemini-oauth.json",
    validationMode: "check-expiry",
    expiresAtField: "expires_at",
    expiryBufferMs: 5 * 60 * 1000,
  },
  "gemini-codeassist": {
    credentialFile: "gemini-oauth.json",
    validationMode: "check-expiry",
    expiresAtField: "expires_at",
    expiryBufferMs: 5 * 60 * 1000,
  },
};

function hasValidOAuthCredentials(descriptor: OAuthProviderDescriptor): boolean {
  const credPath = join(homedir(), ".claudish", descriptor.credentialFile);
  if (!existsSync(credPath)) return false;

  if (descriptor.validationMode === "file-exists") {
    return true;
  }

  try {
    const data = JSON.parse(readFileSync(credPath, "utf-8"));
    if (!data.access_token) return false;

    // If a refresh_token is present the handler can refresh at request time,
    // so the credential is usable regardless of whether the access token has expired.
    if (data.refresh_token) return true;

    // No refresh token - must verify the access token itself hasn't expired.
    if (descriptor.expiresAtField && data[descriptor.expiresAtField]) {
      const buffer = descriptor.expiryBufferMs ?? 0;
      return data[descriptor.expiresAtField] > Date.now() + buffer;
    }

    return true;
  } catch {
    return false;
  }
}

export function hasOAuthCredentials(providerName: string): boolean {
  const descriptor = OAUTH_PROVIDERS[providerName];
  if (!descriptor) return false;
  return hasValidOAuthCredentials(descriptor);
}
