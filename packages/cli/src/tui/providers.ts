/**
 * Provider definitions for the claudish config TUI.
 * Derived from BUILTIN_PROVIDERS — single source of truth.
 */

import { credentials } from "../auth/credentials/authority.js";
import { hasOAuthCredentials } from "../auth/oauth-registry.js";
import { isLocalProviderEnabled } from "../profile-config.js";
import type { LocalLiveness } from "../providers/local-liveness.js";
import { getAllProviders, type ProviderDefinition } from "../providers/provider-definitions.js";

export interface ProviderDef {
  /** TUI-facing name (e.g. "gemini" for the renamed Google direct API). */
  name: string;
  /** Original catalog name — needed for OAuth credential lookups
   *  (hasOAuthCredentials uses catalog names like "google", not "gemini"). */
  catalogName: string;
  displayName: string;
  apiKeyEnvVar: string;
  description: string;
  keyUrl: string;
  endpointEnvVar?: string;
  endpointEnvVars?: string[];
  defaultEndpoint?: string;
  aliases?: string[];
  isLocal?: boolean;
  /**
   * If set, the provider is usable WITHOUT any user credential — it ships a
   * built-in public/free key (e.g. OpenCode Zen). Sourced from the catalog's
   * `publicKeyFallback`. Such a provider is "ready" even with no env/cfg key,
   * which is why the readiness/source logic must treat it specially (else it
   * lands under "not configured" yet probes green — the OpenCode Zen bug).
   */
  publicKeyFallback?: boolean;
  /**
   * If set, this provider supports OAuth login via `claudish login {slug}`.
   * Used by the Providers tab `l` keybinding.
   */
  oauthSlug?: "gemini" | "codex" | "kimi";
}

// Skip virtual providers that have no API key and no TUI presence
const SKIP = new Set(["qwen", "native-anthropic"]);

function toProviderDef(def: ProviderDefinition): ProviderDef {
  return {
    name: def.name === "google" ? "gemini" : def.name,
    catalogName: def.name,
    displayName: def.displayName,
    apiKeyEnvVar: def.apiKeyEnvVar,
    description: def.description || def.apiKeyDescription,
    keyUrl: def.apiKeyUrl,
    endpointEnvVar: def.baseUrlEnvVars?.[0],
    endpointEnvVars: def.baseUrlEnvVars,
    defaultEndpoint: def.baseUrl || undefined,
    aliases: def.apiKeyAliases,
    isLocal: def.isLocal,
    publicKeyFallback: !!def.publicKeyFallback,
    // Sourced from the catalog (provider-definitions.ts), not a duplicate
    // table here. If a provider supports `claudish login {slug}`, the
    // catalog entry declares which slug.
    oauthSlug: def.oauthLoginSlug,
  };
}

/**
 * Compute the authentication source for a provider: where the credentials
 * actually come from. Used for the AUTH column on the Providers tab and
 * for sorting "configured first".
 *
 * Priority depends on whether the provider has OAuth login support:
 *
 *   For OAuth-capable providers (gemini-codeassist, openai-codex,
 *   kimi-coding): OAuth wins over env/cfg. These products are designed
 *   around the OAuth flow as the canonical auth path; an env key is
 *   usually a stale leftover or sideband override and shouldn't be the
 *   advertised method in the UI.
 *
 *   Local providers are ready only when explicitly enabled in global
 *   ~/.claudish/config.json; for all other providers: env > cfg > (no OAuth path).
 *
 * Returns:
 *   "local"  - local provider explicitly enabled in global config
 *   "oauth"  - valid OAuth credentials on disk (OAuth-capable providers)
 *   "e+c"    - both env var AND config-file key present
 *   "env"    - env var only
 *   "cfg"    - config-file key only
 *   "public" - no user credential, but the provider ships a public/free key
 *              (publicKeyFallback) so it's usable as-is (e.g. OpenCode Zen)
 *   null     - no credentials of any kind
 *
 * "public" is checked LAST among the ready sources: a real env/cfg/oauth key
 * always takes precedence in the display, and the public-key affordance only
 * fills in when nothing else is set. Keeping it as a non-null source is what
 * makes the "configured first" sort, the "not configured" divider, the status
 * dot, and Test All all AGREE with providerIsReady (which already honors
 * publicKeyFallback via credentials.isAuthenticated).
 */
export type AuthSource = "e+c" | "env" | "cfg" | "oauth" | "local" | "public" | null;

export function providerAuthSource(
  p: ProviderDef,
  config: { apiKeys?: Record<string, string>; localProviders?: string[] }
): AuthSource {
  if (p.isLocal) return isLocalProviderEnabled(p.catalogName, config) ? "local" : null;
  // OAuth wins for OAuth-capable providers when credentials exist.
  if (p.oauthSlug && hasOAuthCredentials(p.catalogName)) return "oauth";
  const hasCfg = !!p.apiKeyEnvVar && !!config.apiKeys?.[p.apiKeyEnvVar];
  const hasEnv = !!p.apiKeyEnvVar && !!process.env[p.apiKeyEnvVar];
  if (hasEnv && hasCfg) return "e+c";
  if (hasEnv) return "env";
  if (hasCfg) return "cfg";
  // Keyless/free providers are usable without any user credential.
  if (p.publicKeyFallback) return "public";
  return null;
}

/**
 * True when a provider has any usable credentials (key OR OAuth).
 *
 * The "is this provider authenticated?" decision is routed through the unified
 * credential authority (auth/credentials/authority.js) — the same oracle routing
 * uses (hasCredentialsForProvider). The authority additionally honors the
 * catalog's publicKeyFallback / oauthFallback affordances and any OAuth alias
 * (e.g. the "google" catalog name resolves to the Gemini Code Assist OAuth
 * credential), so a provider the authority considers authenticated is ready here.
 *
 * We OR in the previous config-SNAPSHOT check (`providerAuthSource(p, config)`)
 * for one reason the authority cannot cover: the authority reads disk config via
 * loadConfig(), but the TUI passes an in-memory `config` snapshot that may hold a
 * key the user JUST typed and hasn't persisted yet. OR-ing preserves that
 * just-typed readiness signal. Because this is strictly additive, it never marks
 * a previously-ready provider un-ready.
 *
 * NOTE (deferred): providerAuthSource / providerAuthCapabilities still read
 * process.env / config directly for the SOURCE/capability breakdown they report
 * (env vs cfg vs oauth vs local) — the authority's isAuthenticated() only yields a
 * bool. Collapsing those onto a richer AuthStatus is out of scope for this step.
 */
export function providerIsReady(
  p: ProviderDef,
  config: { apiKeys?: Record<string, string>; localProviders?: string[] }
): boolean {
  // Guard against a catalogName that the authority aliases onto a DIFFERENT
  // product's credential. The direct-Gemini row has catalogName "google", but
  // the authority registers the Gemini Code Assist OAuth credential under the
  // "google" alias — so credentials.isAuthenticated("google") reflects Code
  // Assist OAuth, NOT the direct API's GEMINI_API_KEY. A user who ran
  // `claudish login gemini` (OAuth) but never set GEMINI_API_KEY would otherwise
  // see the direct-Gemini row falsely "ready", then 401 on probe (the API-key
  // transport has no key). The direct row is API-key-only (no oauthSlug), so for
  // a NON-OAuth-capable provider we trust ONLY the source classifier (env / cfg
  // / public), never the authority's OAuth-derived bool.
  if (!p.oauthSlug) {
    return providerAuthSource(p, config) !== null;
  }
  return credentials.isAuthenticated(p.catalogName) || providerAuthSource(p, config) !== null;
}

/**
 * Display-readiness for the Providers tab: providerIsReady PLUS live local-server
 * detection. A local provider that is RUNNING right now counts as ready for the
 * "configured first" sort, the "─ not configured ─" divider, and the status dot
 * — even if the user hasn't config-enabled it yet (e.g. a freshly-started
 * Ollama). Without this, a running-but-not-enabled local shows STATUS "running"
 * while sitting BELOW the not-configured divider with a hollow dot — the same
 * source-vs-readiness divergence the publicKeyFallback fix removed for keyless
 * providers.
 *
 * `localLiveness` is keyed by catalogName; pass {} when liveness is unknown
 * (collapses to plain providerIsReady).
 */
export function providerIsReadyForDisplay(
  p: ProviderDef,
  config: { apiKeys?: Record<string, string>; localProviders?: string[] },
  localLiveness: Record<string, LocalLiveness>
): boolean {
  if (p.isLocal && localLiveness[p.catalogName] === "running") return true;
  return providerIsReady(p, config);
}

/**
 * Per-provider auth capabilities, surfaced as a pair of (supported, set)
 * flags for the two methods. The AUTH column renders this pair as
 * `key ●/○` + `oauth ●/○`, with empty slot when not supported.
 *
 * Capability is intrinsic to the provider:
 *   - apiKey supported iff catalog declares apiKeyEnvVar
 *   - oauth  supported iff catalog declares oauthLoginSlug
 *
 * "Set" means a credential of that kind is present right now:
 *   - apiKey set: env var OR config.apiKeys has a value
 *   - oauth set:  hasOAuthCredentials(catalogName) returns true
 */
export interface AuthCapabilities {
  apiKey: { supported: boolean; set: boolean };
  oauth: { supported: boolean; set: boolean };
}

export function providerAuthCapabilities(
  p: ProviderDef,
  config: { apiKeys?: Record<string, string> }
): AuthCapabilities {
  const apiKeySupported = !!p.apiKeyEnvVar;
  const apiKeySet =
    apiKeySupported && (!!process.env[p.apiKeyEnvVar] || !!config.apiKeys?.[p.apiKeyEnvVar]);
  const oauthSupported = !!p.oauthSlug;
  const oauthSet = oauthSupported && hasOAuthCredentials(p.catalogName);
  return {
    apiKey: { supported: apiKeySupported, set: apiKeySet },
    oauth: { supported: oauthSupported, set: oauthSet },
  };
}

export const PROVIDERS: ProviderDef[] = getAllProviders()
  .filter((d) => !SKIP.has(d.name))
  .map(toProviderDef);

/**
 * Fixed 8-character visually dense key mask.
 */
export function maskKey(key: string | undefined): string {
  if (!key) return "────────";
  if (key.length < 8) return "****    ";
  return `${key.slice(0, 3)}••${key.slice(-3)}`;
}
