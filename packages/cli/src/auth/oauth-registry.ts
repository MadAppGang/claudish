import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
 *   - openai        (OPENAI_API_KEY) - OpenAI direct API uses API keys only
 *   - minimax       (MINIMAX_API_KEY) - API key only
 *   - minimax-coding (MINIMAX_CODING_API_KEY) - API key only
 *   - glm           (ZHIPU_API_KEY) - API key only
 *   - glm-coding    (GLM_CODING_API_KEY) - API key only
 *   - ollamacloud   (OLLAMA_API_KEY) - API key only
 *   - z-ai          (ZAI_API_KEY) - API key only
 *   - litellm       (LITELLM_API_KEY) - API key only
 *   - vertex        (VERTEX_API_KEY / VERTEX_PROJECT) - uses ADC / service account
 *
 * These providers are covered by the direct API-key step (Step 3) in the
 * auto-routing priority chain.  OAuth entries can be added here in future
 * phases if those providers implement a public device-auth grant.
 */
export const OAUTH_PROVIDERS: Record<string, OAuthProviderDescriptor> = {
  // Kimi / Moonshot AI - Device Authorization Grant (RFC 8628)
  // Login via: claudish login kimi
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
  // OpenAI Codex - OAuth2 PKCE flow (browser-based, ChatGPT Plus/Pro subscription)
  // Login via: claudish login codex
  "openai-codex": {
    credentialFile: "codex-oauth.json",
    validationMode: "check-expiry",
    expiresAtField: "expires_at",
    expiryBufferMs: 5 * 60 * 1000,
  },
  // Grok Build - Device Authorization Grant (RFC 8628), public client
  // Login via: claudish login grok
  //
  // Registered here so a stale credential reads as "logged out" rather than as
  // a live one. Note this file is only ONE of two sources: the credential layer
  // also falls back to the Grok CLI's own ~/.grok/auth.json, which lives
  // outside ~/.claudish and so cannot be represented in this registry.
  "grok-subscription": {
    credentialFile: "grok-oauth.json",
    validationMode: "check-expiry",
    expiresAtField: "expires_at",
    expiryBufferMs: 5 * 60 * 1000,
  },
  // NOTE: there is deliberately no `google` / `gemini-codeassist` entry here.
  // Both used to point at ~/.claudish/gemini-oauth.json, the Gemini Code Assist
  // token. That product was retired by Google for individuals and the provider
  // has been removed; `google` is now purely the direct Gemini API, keyed by
  // GEMINI_API_KEY, and the Gemini subscription flow is `antigravity` (whose
  // token lives in the shared agy keychain, not in a file here).
  //
  // Leaving them registered meant a leftover gemini-oauth.json still read as a
  // live credential — which is how a dead provider kept its place in the config
  // TUI's provider list and failed every Test All run.
};

/**
 * This registry's rule for "is a PARSED credential object usable", with no file
 * access of any kind.
 *
 * Split out of `hasValidOAuthCredentials` below so the rule can be exercised
 * against a credential object directly. The rule and the file lookup used to be
 * one function, and that made the rule untestable anywhere except on a machine
 * that happened to have the right file in `~/.claudish` — which the developer
 * machine has and hermetic CI never does. A test whose discriminating power is a
 * property of the home directory is not a test; see
 * `auth/credentials/billing-probe.test.ts`, "THE TRAP".
 */
function credentialSatisfies(descriptor: OAuthProviderDescriptor, data: any): boolean {
  if (!data?.access_token) return false;

  // If a refresh_token is present the handler can refresh at request time,
  // so the credential is usable regardless of whether the access token has expired.
  if (data.refresh_token) return true;

  // No refresh token - must verify the access token itself hasn't expired.
  if (descriptor.expiresAtField && data[descriptor.expiresAtField]) {
    const buffer = descriptor.expiryBufferMs ?? 0;
    return data[descriptor.expiresAtField] > Date.now() + buffer;
  }

  return true;
}

/**
 * Would THIS credential object satisfy `hasOAuthCredentials(providerName)`?
 *
 * Exported for one purpose: letting a test ask what this oracle WOULD answer for
 * a given credential state without putting a file under `$HOME`. It shares
 * `credentialSatisfies` with the real lookup, so the two cannot drift on the rule
 * — which is the only part a caller can get wrong.
 *
 * NOT a production entry point. Production asks `hasOAuthCredentials`, and the
 * credential layer deliberately does NOT use either of them to decide billing:
 * this rule accepts an unexpired `access_token` with no `refresh_token`, a state
 * where `CodexOAuth.hasCredentials()` is false and the API key is what actually
 * signs (see `auth/credentials/billing-probe.ts`).
 */
export function oauthCredentialWouldQualify(providerName: string, data: unknown): boolean {
  const descriptor = OAUTH_PROVIDERS[providerName];
  if (!descriptor) return false;
  if (descriptor.validationMode === "file-exists") return true;
  return credentialSatisfies(descriptor, data);
}

function hasValidOAuthCredentials(descriptor: OAuthProviderDescriptor): boolean {
  const credPath = join(homedir(), ".claudish", descriptor.credentialFile);
  if (!existsSync(credPath)) return false;

  if (descriptor.validationMode === "file-exists") {
    return true;
  }

  try {
    return credentialSatisfies(descriptor, JSON.parse(readFileSync(credPath, "utf-8")));
  } catch {
    return false;
  }
}

export function hasOAuthCredentials(providerName: string): boolean {
  const descriptor = OAUTH_PROVIDERS[providerName];
  if (!descriptor) return false;
  return hasValidOAuthCredentials(descriptor);
}
