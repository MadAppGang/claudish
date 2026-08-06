/**
 * Credential SOURCE classification — the single implementation of the rules.
 *
 * WHY THIS FILE EXISTS
 *
 * There used to be two independent answers to "does this provider have a
 * credential, and where did it come from":
 *
 *   1. `CredentialProvider.isAvailable()` — the authority. ASYNC, so it can
 *      consult 1Password, but it returns a bare boolean: no source.
 *   2. `providerAuthSource()` in tui/providers.ts — SYNC, so the config TUI's
 *      React render paths can call it, but it reads `process.env` and config
 *      directly and therefore cannot see a 1Password-only key.
 *
 * Two implementations of one decision means a rule fixed in one place is
 * silently missed in the other. That is not hypothetical: the unexpanded
 * `${VAR}` guard had to be written into BOTH, and `claudish providers --json`
 * spent a release reporting `ready: false` for every 1Password-only provider
 * because it asked #2, which structurally cannot know.
 *
 * THE SPLIT THAT IS ACTUALLY INHERENT
 *
 * React cannot await. That is a real constraint, and it is the ONLY thing that
 * justifies a sync entry point. So the rules live here once, exposed twice:
 *
 *   - `describeSourceSync` — the rules, minus 1Password. For render paths.
 *   - `describeSource`     — readiness decided by the AUTHORITY (its return
 *                            value, not a side effect), labelled by the same
 *                            rules. For every caller that can await.
 *
 * The two differ in whether 1Password is consulted. They do not differ in what
 * counts as a credential — that is the property the old split kept losing.
 *
 * WIRE CONTRACT: the returned strings are consumed by the external
 * claude-desktop-profiles app via `claudish providers --json`. They are
 * deliberately byte-identical to what that command has always emitted. A
 * 1Password-resolved key reports "env", which is literally true — the authority
 * write-throughs it into `process.env` before this classifies. Naming 1Password
 * explicitly would mean adding a union member the profiles app has never seen,
 * so it waits for a coordinated change.
 */

import { isLocalProviderEnabled } from "../../profile-config.js";
import { hasDevinCredentials } from "../../providers/devin/devin-credentials.js";
import { hasSharedAntigravityToken } from "../antigravity-token.js";
import { hasOAuthCredentials } from "../oauth-registry.js";
import { realValue } from "./api-key-credential.js";
import { credentials } from "./authority.js";

/** Where a provider's credential resolves from. `null` = nowhere. */
export type CredentialSource = "e+c" | "env" | "cfg" | "oauth" | "local" | "public" | null;

/** The subset of a provider definition the classification rules read. */
export interface SourceClassifiable {
  catalogName: string;
  apiKeyEnvVar: string;
  isLocal?: boolean;
  publicKeyFallback?: boolean;
  oauthSlug?: string;
}

/** The config snapshot to classify against (the TUI passes an unsaved one). */
export interface SourceConfig {
  apiKeys?: Record<string, string>;
  localProviders?: string[];
}

/**
 * THE RULES. Sync, so React render paths can call it — which also means it
 * cannot consult 1Password. A key that lives only in 1Password reads as absent
 * here UNTIL the authority has resolved it and write-through'd it into
 * `process.env`; `describeSource` below guarantees that ordering for callers
 * that can await.
 *
 * Priority depends on whether the provider has OAuth login support:
 *
 *   For OAuth-capable providers (gemini-codeassist, openai-codex, kimi-coding):
 *   OAuth wins over env/cfg. These products are designed around the OAuth flow
 *   as the canonical auth path; an env key is usually a stale leftover or
 *   sideband override and shouldn't be the advertised method in the UI.
 *
 *   Local providers are ready only when explicitly enabled in global
 *   ~/.claudish/config.json; for all others: env > cfg > (no OAuth path).
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
 * dot, and Test All all AGREE with providerIsReady.
 */
export function describeSourceSync(p: SourceClassifiable, config: SourceConfig): CredentialSource {
  if (p.isLocal) return isLocalProviderEnabled(p.catalogName, config) ? "local" : null;
  // OAuth wins for OAuth-capable providers when credentials exist.
  if (p.oauthSlug && hasOAuthCredentials(p.catalogName)) return "oauth";
  // Antigravity's OAuth token lives in the SHARED keychain store (populated by
  // the `agy` CLI), not a ~/.claudish/*-oauth.json file — so hasOAuthCredentials
  // (file-based) can't see it. Check the keychain directly so the config TUI
  // shows it ready when a token is present. Memoized; safe on the render path.
  if (p.catalogName === "antigravity" && hasSharedAntigravityToken()) return "oauth";
  // Devin's credential is `apiKeyEnvVar: ""` (its artifact is `Basic <k>-<k>`,
  // which the generic key path cannot express), so the env/cfg checks below are
  // structurally blind to it. `"oauth"` is reused deliberately rather than
  // widening CredentialSource: the value is literally `devin-session-token$<JWT>`,
  // minted by a login in the `devin` CLI and stored in a file — which is what
  // "oauth" means in this union. A new member would ripple through every TUI
  // label map and the `claudish providers --json` wire contract for no
  // user-visible gain.
  if (p.catalogName === "devin") {
    if (realValue(process.env.WINDSURF_API_KEY)) return "env";
    if (hasDevinCredentials()) return "oauth";
  }
  // realValue() drops an unexpanded `${VAR}` placeholder — the literal string a
  // host passes through when the referenced shell variable is unset. Sign-time
  // refuses to use one, so it must not count as a credential here either.
  const hasCfg = !!p.apiKeyEnvVar && !!realValue(config.apiKeys?.[p.apiKeyEnvVar]);
  const hasEnv = !!p.apiKeyEnvVar && !!realValue(process.env[p.apiKeyEnvVar]);
  if (hasEnv && hasCfg) return "e+c";
  if (hasEnv) return "env";
  if (hasCfg) return "cfg";
  // Keyless/free providers are usable without any user credential.
  if (p.publicKeyFallback) return "public";
  return null;
}

/**
 * Readiness from the AUTHORITY, label from the same rules above.
 *
 * `credentials.isAvailable()` is the single oracle — env → aliases → config →
 * oauth-file → 1Password — and this uses its RETURN VALUE, not the side effect
 * of it happening to populate `process.env`. If the authority says a provider
 * has no credential, the answer is `null` no matter what the sync rules think.
 *
 * The `?? "env"` floor covers the one legitimate disagreement: the authority
 * can resolve through a path the sync rules do not model (an alias env var, an
 * `oauthFallback` file on a provider with no `oauthSlug`). Reporting "env"
 * there is better than contradicting the oracle with `null` — and it can never
 * fire in the other direction, because a `null` from the authority short-
 * circuits above.
 *
 * Never throws: `isAvailable` swallows its own failures by contract, so a
 * 1Password outage degrades to "not ready" rather than an exception.
 */
export async function describeSource(
  p: SourceClassifiable,
  config: SourceConfig
): Promise<CredentialSource> {
  const ready = await credentials.isAvailable(p.catalogName);
  if (!ready) return null;
  return describeSourceSync(p, config) ?? "env";
}
