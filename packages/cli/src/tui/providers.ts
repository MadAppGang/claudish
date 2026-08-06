/**
 * Provider definitions for the claudish config TUI.
 * Derived from BUILTIN_PROVIDERS — single source of truth.
 */

import { hasSharedAntigravityToken } from "../auth/antigravity-token.js";
import { type CredentialSource, describeSourceSync } from "../auth/credentials/source.js";
import { hasOAuthCredentials } from "../auth/oauth-registry.js";
import { hasDevinCredentials } from "../providers/devin/devin-credentials.js";
import type { LocalLiveness } from "../providers/local-liveness.js";
import { type ProviderDefinition, getAllProviders } from "../providers/provider-definitions.js";

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
  oauthSlug?: "gemini" | "codex" | "kimi" | "antigravity";
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

/** Re-exported from the credential layer, which owns the classification rules. */
export type AuthSource = CredentialSource;

/**
 * SYNC source classification for React render paths.
 *
 * This is a thin delegate — the rules live in auth/credentials/source.ts, which
 * is also what the async `describeSource` (used by `claudish providers --json`)
 * classifies with. Keeping one implementation is the point: this file used to
 * carry its own copy, and every credential rule then had to be written twice or
 * the TUI and the CLI would disagree about the same provider.
 *
 * Sync means no 1Password. A 1Password-only key reads as absent here until the
 * authority has resolved and write-through'd it — which is why anything that
 * CAN await should call `describeSource` instead.
 */
export function providerAuthSource(
  p: ProviderDef,
  config: { apiKeys?: Record<string, string>; localProviders?: string[] }
): AuthSource {
  return describeSourceSync(p, config);
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
 * The classification RULES now live in auth/credentials/source.ts and are shared
 * with the async `describeSource` that `claudish providers --json` uses, so this
 * sync path and the CLI can no longer drift. What remains inherent (not
 * duplication) is that this entry point does not await, and therefore cannot
 * consult 1Password — React render paths have no other option.
 */
export function providerIsReady(
  p: ProviderDef,
  config: { apiKeys?: Record<string, string>; localProviders?: string[] }
): boolean {
  // NOTE: the authority no longer aliases "google" onto the Code Assist OAuth
  // credential ("google"/"gemini" now resolve the direct API's GEMINI_API_KEY
  // credential), so the historical false-"ready" hazard for the direct-Gemini
  // row is gone at the source. This sync path still trusts only the source
  // classifier — React render paths cannot await the authority.
  // providerAuthSource is the SYNC readiness classifier (env / cfg / oauth-file /
  // public / local). It already returns "oauth" when hasOAuthCredentials() is
  // true for an OAuth-capable provider (covers codex/gemini/kimi), and reads
  // process.env — which the credential authority gap-fills with any resolved
  // op:// key. So the config TUI's display readiness is fully covered here
  // WITHOUT an async authority call (kept sync for React render paths). The
  // authority remains the source of truth for routing/sign-time (async).
  return providerAuthSource(p, config) !== null;
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
  // Devin has no claudish-side login (the token is minted by `devin login` and
  // read from that CLI's own file), so it declares no oauthLoginSlug — but it
  // IS token-authenticated, and gating the column on `oauthSlug` alone would
  // render the row as "not configurable" for a user who is signed in. Relaxing
  // the local expression is the narrow fix; adding a slug would advertise a
  // `claudish login devin` command that does not exist.
  const oauthSupported = !!p.oauthSlug || p.catalogName === "devin";
  // Antigravity's OAuth token is in the shared keychain, not an oauth-file — so
  // hasOAuthCredentials can't see it; check the keychain directly (memoized).
  const oauthSet =
    oauthSupported &&
    (hasOAuthCredentials(p.catalogName) ||
      (p.catalogName === "antigravity" && hasSharedAntigravityToken()) ||
      (p.catalogName === "devin" && hasDevinCredentials()));
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
