/**
 * Provider definitions for the claudish config TUI.
 * Derived from BUILTIN_PROVIDERS — single source of truth.
 */

import { hasSharedAntigravityToken } from "../auth/antigravity-token.js";
import { type CredentialSource, describeSourceSync } from "../auth/credentials/source.js";
import { hasOAuthCredentials } from "../auth/oauth-registry.js";
import {
  VERTEX_SET_PROJECT_REMEDY,
  describeVertexProjectSource,
  hasVertexAdcCredentials,
  peekVertexProjectOrigin,
} from "../auth/vertex-auth.js";
import { hasDevinCredentials } from "../providers/devin/devin-credentials.js";
import type { LocalLiveness } from "../providers/local-liveness.js";
import {
  type MuseCredentialStatus,
  isMuseCredentialConfigured,
  museCredentialStatus,
} from "../providers/meta-muse/muse-credentials.js";
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
   * If set, this provider supports OAuth login via `claudish login {slug}`.
   * Used by the Providers tab `l` keybinding.
   *
   * DERIVED from the catalog rather than restated. This was a hand-written
   * union, and it had already drifted: it still listed `"gemini"` — the Code
   * Assist provider Google retired and claudish removed — while omitting every
   * slug added since. Aliasing the catalog's own type means a new
   * `oauthLoginSlug` cannot be accepted here and silently ignored there.
   */
  oauthSlug?: ProviderDefinition["oauthLoginSlug"];
}

export type ProviderLoginAction =
  | { kind: "claudish"; slug: NonNullable<ProviderDef["oauthSlug"]> }
  | { kind: "gcloud-adc" };

/** The login offered by both the Providers-tab footer and its `l` handler. */
export function providerLoginAction(p: ProviderDef): ProviderLoginAction | undefined {
  if (p.oauthSlug) return { kind: "claudish", slug: p.oauthSlug };
  if (p.catalogName === "vertex") return { kind: "gcloud-adc" };
  return undefined;
}

export function providerSetLabel(p: ProviderDef): "project" | "key" {
  return p.catalogName === "vertex" ? "project" : "key";
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
 * catalog's oauthFallback affordance, `authScheme: "none"`, and any OAuth alias
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
 * source-vs-readiness divergence that the (since-removed) publicKeyFallback
 * affordance was once introduced to fix for keyless providers.
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
  // Vertex joins Devin here for the same reason: it is token-authenticated
  // (Application Default Credentials, or a service-account file) with no
  // claudish-side login, so it declares no oauthLoginSlug — but a row rendering
  // "no auth method available" for a machine that holds a live `ya29…` token is
  // the wrong statement, and the `l` keybinding stays gated on `oauthSlug` so no
  // `claudish login vertex` is advertised.
  // Muse Code: statically supported, so the login guidance shows before the
  // first login; its presence drives only "set" (architecture §6).
  const oauthSupported =
    !!p.oauthSlug ||
    p.catalogName === "devin" ||
    p.catalogName === "vertex" ||
    p.catalogName === "meta-muse-code";
  // Antigravity's OAuth token is in the shared keychain, not an oauth-file — so
  // hasOAuthCredentials can't see it; check the keychain directly (memoized).
  const oauthSet =
    oauthSupported &&
    (hasOAuthCredentials(p.catalogName) ||
      (p.catalogName === "antigravity" && hasSharedAntigravityToken()) ||
      (p.catalogName === "devin" && hasDevinCredentials()) ||
      (p.catalogName === "vertex" && hasVertexAdcCredentials()) ||
      (p.catalogName === "meta-muse-code" && isMuseCredentialConfigured(museCredentialStatus())));
  return {
    apiKey: { supported: apiKeySupported, set: apiKeySet },
    oauth: { supported: oauthSupported, set: oauthSet },
  };
}

/**
 * One line naming WHERE this provider's credential came from, for providers the
 * generic `Env: <VAR>` / `From: env|config` row cannot describe.
 *
 * Returns undefined for every env-var provider, so the detail pane is unchanged
 * for them. Vertex is the case it exists for: its `apiKeyEnvVar` is a Google
 * Cloud PROJECT id, resolvable from the ADC file or `gcloud config`, and there
 * is NO API key to go and find — the Express mode was deleted on 2026-09-21, so
 * "Env: VERTEX_PROJECT" plus "Get Key" sent the reader after a credential that
 * does not exist.
 *
 * Sync and free of subprocesses (see `peekVertexProjectOrigin`), so it is safe
 * on a render path.
 */
/** What the Muse Code row says about its login, by the one cached status. */
const MUSE_STATUS_NOTE: Record<MuseCredentialStatus, string> = {
  "own-login": "Signed in with claudish's own Muse Code login",
  "borrowed-copy": "Using claudish's copy of the Muse Code CLI login",
  keychain: "Muse Code CLI login found in the Keychain — first use asks for access",
  absent: "No Muse Code login — run `claudish login muse`, or `muse login`",
  failed: "The Keychain could not be asked about the Muse Code login",
  unknown: "Checking for a Muse Code login…",
};

export function providerCredentialNote(p: ProviderDef): string | undefined {
  if (p.catalogName === "meta-muse-code") return MUSE_STATUS_NOTE[museCredentialStatus()];
  if (p.catalogName !== "vertex") return undefined;
  const origin = peekVertexProjectOrigin();
  if (!origin) {
    // The two failures are different and so are their fixes: a credential that
    // signs nothing, versus a signed credential with nowhere to send it. Neither
    // sentence mentions an API key, because there is none to find.
    return hasVertexAdcCredentials()
      ? `ADC present, no project — ${VERTEX_SET_PROJECT_REMEDY}`
      : `No credential — run \`gcloud auth application-default login\` (press l), then ${VERTEX_SET_PROJECT_REMEDY}`;
  }
  return `Project ${origin.projectId} from ${describeVertexProjectSource(origin)}`;
}

/**
 * The provider list, built LIVE from the catalog on every call.
 *
 * It used to be a module-load-time `const`, and that made it a snapshot taken
 * before `ensureEndpointsRegistered()` had run — so a runtime provider (a
 * bundled catalog row, or the user's own `customEndpoints`) could never appear
 * in it no matter when the caller asked. Same defect as #192, one surface over:
 * a list that enumerates providers has to be built after registration, and the
 * only way to guarantee that without auditing every import chain is to not
 * cache it.
 *
 * Cheap enough to call per render: a filter and a map over ~40 plain objects,
 * no I/O, no credential resolution. Readiness is decided separately by
 * `describeSource`, which is where the cost actually is.
 */
export function getProviderDefs(): ProviderDef[] {
  return getAllProviders()
    .filter((d) => !SKIP.has(d.name))
    .map(toProviderDef);
}

// There is deliberately NO `export const PROVIDERS` here anymore. It existed,
// every consumer has been moved to `getProviderDefs()`, and re-adding it would
// silently reintroduce the module-load snapshot this function exists to avoid.

/**
 * Fixed 8-character visually dense key mask.
 */
export function maskKey(key: string | undefined): string {
  if (!key) return "────────";
  if (key.length < 8) return "****    ";
  return `${key.slice(0, 3)}••${key.slice(-3)}`;
}
