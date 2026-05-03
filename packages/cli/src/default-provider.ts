/**
 * Pure resolver for the effective default provider used when a bare model name
 * is supplied without an explicit `provider@` prefix.
 *
 * No imports from cli.ts or proxy-server.ts (otherwise we get import cycles).
 * Reads from a passed-in config object, env vars, and an optional CLI flag.
 *
 * Phase 1 of the LiteLLM-demotion refactor: this file ships the resolver and
 * a one-shot stderr hint. Phase 2 will wire `resolveDefaultProvider()` into
 * `auto-route.ts` and the routing fallback chain.
 */

import type { ClaudishProfileConfig } from "./profile-config.js";
import { getShortcuts } from "./providers/provider-definitions.js";

export type DefaultProviderSource =
  | "cli-flag"
  | "env-var"
  | "config-file"
  | "legacy-litellm"
  | "openrouter-key"
  | "hardcoded";

export interface ResolvedDefaultProvider {
  /** Resolved provider name (builtin or custom-endpoint name). */
  provider: string;
  /** Where the value came from (for diagnostics + the legacy hint). */
  source: DefaultProviderSource;
  /** True when we fell back to legacy LITELLM auto-promotion — emit hint. */
  legacyAutoPromoted: boolean;
}

export interface ResolveOptions {
  cliFlag?: string;
  config: ClaudishProfileConfig;
  env?: NodeJS.ProcessEnv;
}

function normalizeProviderName(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return getShortcuts()[normalized] ?? normalized;
}

/**
 * Resolve the effective default provider using the precedence chain:
 *   1. --default-provider CLI flag
 *   2. CLAUDISH_DEFAULT_PROVIDER env var
 *   3. config.json defaultProvider
 *   4. legacy auto-promotion: LITELLM_BASE_URL + LITELLM_API_KEY env vars → "litellm"
 *      (deprecated; emits a one-shot stderr hint elsewhere)
 *   5. OPENROUTER_API_KEY present → "openrouter"
 *   6. hardcoded "openrouter"
 */
export function resolveDefaultProvider(opts: ResolveOptions): ResolvedDefaultProvider {
  const env = opts.env ?? process.env;

  if (opts.cliFlag && opts.cliFlag.length > 0) {
    return {
      provider: normalizeProviderName(opts.cliFlag),
      source: "cli-flag",
      legacyAutoPromoted: false,
    };
  }

  const envVal = env.CLAUDISH_DEFAULT_PROVIDER;
  if (envVal && envVal.length > 0) {
    return {
      provider: normalizeProviderName(envVal),
      source: "env-var",
      legacyAutoPromoted: false,
    };
  }

  if (opts.config.defaultProvider && opts.config.defaultProvider.length > 0) {
    return {
      provider: normalizeProviderName(opts.config.defaultProvider),
      source: "config-file",
      legacyAutoPromoted: false,
    };
  }

  // Legacy auto-promotion (preserves pre-refactor behavior for users with LITELLM env vars set)
  if (env.LITELLM_BASE_URL && env.LITELLM_API_KEY) {
    return { provider: "litellm", source: "legacy-litellm", legacyAutoPromoted: true };
  }

  if (env.OPENROUTER_API_KEY) {
    return { provider: "openrouter", source: "openrouter-key", legacyAutoPromoted: false };
  }

  return { provider: "openrouter", source: "hardcoded", legacyAutoPromoted: false };
}

/**
 * Build the one-shot stderr hint shown to users still relying on LITELLM_BASE_URL
 * env vars without an explicit defaultProvider. Returns null when no hint is needed.
 */
export function buildLegacyHint(resolved: ResolvedDefaultProvider): string | null {
  if (!resolved.legacyAutoPromoted) return null;
  return (
    "[claudish] Detected legacy LITELLM_BASE_URL with no defaultProvider set.\n" +
    "           Routing requests through LiteLLM as before.\n" +
    "           To make this explicit (and silence this hint), add to ~/.claudish/config.json:\n" +
    '             { "defaultProvider": "litellm" }\n' +
    "           Or set CLAUDISH_DEFAULT_PROVIDER=litellm in your environment.\n" +
    "           Auto-promotion will be removed in a future major version."
  );
}
