import { hasOAuthCredentials } from "../auth/oauth-registry.js";
import { loadConfig, loadLocalConfig } from "../profile-config.js";
import type { RoutingEntry, RoutingRules } from "../profile-config.js";
import { DISPLAY_NAMES, PROVIDER_TO_PREFIX } from "./auto-route.js";
import { DEFAULT_ROUTING_RULES } from "./default-routing-rules.js";
import { resolveModelNameSync } from "./model-catalog-resolver.js";
import { PROVIDER_SHORTCUTS } from "./model-parser.js";
import { parseModelSpec } from "./model-parser.js";
import {
  getProviderByName,
  isLocalTransport,
  isProviderAvailable,
} from "./provider-definitions.js";
import { buildCredentialHint } from "./routing-hints.js";
import { getRuntimeProviders } from "./runtime-providers.js";

/**
 * Pure merge — defaults < global < local. Exposed for testability so callers
 * can verify merge semantics without touching the disk.
 */
export function mergeRoutingRules(
  defaults: RoutingRules,
  global_: RoutingRules,
  local: RoutingRules
): RoutingRules {
  return { ...defaults, ...global_, ...local };
}

/**
 * Load effective routing rules. Layers:
 *   1. DEFAULT_ROUTING_RULES (built-in, see default-routing-rules.ts)
 *   2. Global config (~/.claudish/config.json)
 *   3. Local config (./.claudish.json)
 *
 * Local rules overwrite global rules overwrite defaults — same key wins.
 * User patterns OVERWRITE default patterns by exact key match (no glob-vs-glob
 * interleaving).
 *
 * Always returns a non-null `RoutingRules` because defaults are baked in.
 * To get strict no-fallback mode, set `routing["*"] = []` in user config.
 */
export function loadRoutingRules(): RoutingRules {
  const local = loadLocalConfig()?.routing ?? {};
  const global_ = loadConfig().routing ?? {};

  validateRoutingRules(local);
  validateRoutingRules(global_);

  return mergeRoutingRules(DEFAULT_ROUTING_RULES, global_, local);
}

/** Warn about config issues that would silently misbehave. */
function validateRoutingRules(rules: RoutingRules): void {
  for (const key of Object.keys(rules)) {
    // Multi-wildcard patterns only use the first *, rest become literals
    if (key !== "*" && (key.match(/\*/g) || []).length > 1) {
      console.error(
        `[claudish] Warning: routing pattern "${key}" has multiple wildcards — only single * is supported. This pattern may not match as expected.`
      );
    }
    // Empty chain is valid — explicit no-fallback mode (route() returns
    // no-route). No warning needed; user opted in.
  }
}

/**
 * Match a model name against routing rules.
 * Priority: exact → longest glob → "*" catch-all → null (use default chain).
 */
export function matchRoutingRule(modelName: string, rules: RoutingRules): RoutingEntry[] | null {
  // 1. Exact match
  if (rules[modelName]) return rules[modelName];

  // 2. Glob patterns (sorted longest-first = most specific)
  const globKeys = Object.keys(rules)
    .filter((k) => k !== "*" && k.includes("*"))
    .sort((a, b) => b.length - a.length);

  for (const pattern of globKeys) {
    if (globMatch(pattern, modelName)) return rules[pattern];
  }

  // 3. Catch-all (may be an empty array — caller treats that as "no route")
  if (rules["*"] !== undefined) return rules["*"];

  return null;
}

/**
 * Convert routing entries to Route objects.
 * Plain name "provider" uses originalModelName.
 * Explicit "provider@model" uses the specified model.
 */
export function buildRoutingChain(entries: RoutingEntry[], originalModelName: string): Route[] {
  const routes: Route[] = [];

  for (const entry of entries) {
    const atIdx = entry.indexOf("@");
    let providerRaw: string;
    let modelName: string;

    if (atIdx !== -1) {
      providerRaw = entry.slice(0, atIdx);
      modelName = entry.slice(atIdx + 1);
    } else {
      providerRaw = entry;
      modelName = originalModelName;
    }

    // Resolve shortcut
    const provider = PROVIDER_SHORTCUTS[providerRaw.toLowerCase()] ?? providerRaw.toLowerCase();

    // Build modelSpec
    let modelSpec: string;
    if (provider === "openrouter") {
      const resolution = resolveModelNameSync(modelName, "openrouter");
      modelSpec = resolution.resolvedId;
    } else {
      const prefix = PROVIDER_TO_PREFIX[provider] ?? provider;
      modelSpec = `${prefix}@${modelName}`;
    }

    const displayName = DISPLAY_NAMES[provider] ?? provider;
    routes.push({ provider, modelSpec, displayName });
  }

  return routes;
}

/** Single-wildcard glob: "kimi-*" matches "kimi-k2.5" */
function globMatch(pattern: string, value: string): boolean {
  const star = pattern.indexOf("*");
  if (star === -1) return pattern === value;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return (
    value.startsWith(prefix) &&
    value.endsWith(suffix) &&
    value.length >= prefix.length + suffix.length
  );
}

// ---------------------------------------------------------------------------
// route() — single routing entry point (plan §B.3)
// ---------------------------------------------------------------------------

/** A single resolved route candidate. */
export interface Route {
  /** Canonical provider name (e.g. "openai", "openrouter"). */
  provider: string;
  /** Ready-to-handle "provider@model" string for downstream handler creation. */
  modelSpec: string;
  /** Human-readable provider label. */
  displayName: string;
}

/**
 * Result of resolving a model spec.
 *
 *   - `kind: "ok"`        — at least one credentialed provider was found.
 *                           `primary` is the first; `fallbacks` follow in order.
 *   - `kind: "no-route"`  — either the explicit prefix had no credentials
 *                           configured, or the chain was empty after credential
 *                           filtering. `hint` is a multi-line message with
 *                           actionable suggestions.
 */
export type RoutePlan =
  | { kind: "ok"; primary: Route; fallbacks: Route[] }
  | { kind: "no-route"; reason: string; hint?: string };

/**
 * Check whether the user has credentials for a given canonical provider.
 *
 * Special-cases beyond `isProviderAvailable()`:
 *   - `native-anthropic` declares an empty `apiKeyEnvVar`, which would make
 *     `isProviderAvailable()` return true unconditionally. We require an
 *     explicit `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) before
 *     considering it routable.
 *   - `openai-codex` declares `OPENAI_API_KEY` as an alias, but the codex
 *     `/v1/responses` endpoint requires the codex subscription — sending a
 *     plain OpenAI key produces "instructions are required" 400 errors. For
 *     routing we require the codex-specific env var or the OAuth file.
 *   - Local transports (ollama, lmstudio, vllm, mlx) are always usable.
 *   - OAuth-backed providers (kimi, gemini-codeassist) are considered
 *     credentialed if either an OAuth file or env var is present.
 */
function hasCredentialsForProvider(provider: string): boolean {
  if (isLocalTransport(provider)) return true;

  // Custom endpoints registered at runtime always have credentials —
  // the loader validates apiKey presence before registration.
  if (getRuntimeProviders().has(provider)) return true;

  if (provider === "native-anthropic") {
    return !!process.env.ANTHROPIC_API_KEY || !!process.env.ANTHROPIC_AUTH_TOKEN;
  }

  // openai-codex requires its own subscription credential. The OPENAI_API_KEY
  // alias defined in provider-definitions.ts is for the proxy's auth header
  // when the codex sub IS active — it is NOT a signal that the user has the
  // codex sub. Without this guard, users with only OPENAI_API_KEY route
  // through codex's /v1/responses endpoint and hit "instructions required"
  // 400 errors before reaching the direct openai fallback.
  if (provider === "openai-codex") {
    if (process.env.OPENAI_CODEX_API_KEY) return true;
    if (hasOAuthCredentials(provider)) return true;
    return false;
  }

  if (hasOAuthCredentials(provider)) return true;

  const def = getProviderByName(provider);
  if (!def) return false;

  // Reject providers with no apiKeyEnvVar AND no public/local affordance.
  // `isProviderAvailable` returns true for these, but routing-wise they are
  // unreachable without explicit credentials wired elsewhere.
  if (!def.apiKeyEnvVar && !def.publicKeyFallback && !def.isLocal) return false;

  return isProviderAvailable(def);
}

/**
 * Path 1: an explicit "provider@model" spec. Probe ONLY that provider's
 * credentials; never fall back silently.
 */
function routeExplicit(modelSpec: string, model: string, provider: string): RoutePlan {
  if (!hasCredentialsForProvider(provider)) {
    return {
      kind: "no-route",
      reason: `No credentials configured for "${provider}".`,
      hint: buildCredentialHint(model, [provider]) ?? undefined,
    };
  }

  const built = buildRoutingChain([modelSpec], model)[0];
  if (!built) {
    return {
      kind: "no-route",
      reason: `Could not build a route for "${modelSpec}".`,
    };
  }
  return { kind: "ok", primary: built, fallbacks: [] };
}

/**
 * Path 2: a bare model name. Consult rules, build candidates, filter to those
 * with credentials, and return ok/no-route accordingly.
 *
 * If `defaultProvider` is set and not already present in the matched chain, it
 * is appended as a final entry — a safety net that catches models whose chain
 * has no credentialed providers. Deduped: if the chain already lists the
 * default provider, no second copy is added.
 */
function routeBare(
  model: string,
  nativeProvider: string,
  rules: RoutingRules,
  defaultProvider?: string
): RoutePlan {
  const matched = matchRoutingRule(model, rules) ?? [];
  const entries = [...matched];

  if (defaultProvider && defaultProvider.length > 0) {
    const canonicalDefault =
      PROVIDER_SHORTCUTS[defaultProvider.toLowerCase()] ?? defaultProvider.toLowerCase();
    const alreadyPresent = entries.some((e) => {
      const atIdx = e.indexOf("@");
      const providerRaw = atIdx === -1 ? e : e.slice(0, atIdx);
      const canonical = PROVIDER_SHORTCUTS[providerRaw.toLowerCase()] ?? providerRaw.toLowerCase();
      return canonical === canonicalDefault;
    });
    if (!alreadyPresent) entries.push(defaultProvider);
  }

  if (entries.length === 0) {
    return {
      kind: "no-route",
      reason: `No routing rule matched "${model}".`,
      hint: buildCredentialHint(model, [nativeProvider]) ?? undefined,
    };
  }

  const candidates = buildRoutingChain(entries, model);
  const credentialed: Route[] = [];
  const skipped: string[] = [];

  for (const candidate of candidates) {
    if (hasCredentialsForProvider(candidate.provider)) {
      credentialed.push(candidate);
    } else {
      skipped.push(candidate.provider);
    }
  }

  if (credentialed.length === 0) {
    return {
      kind: "no-route",
      reason:
        skipped.length > 0
          ? `No credentialed providers in chain for "${model}" (tried: ${skipped.join(", ")}).`
          : `No providers available for "${model}".`,
      hint: buildCredentialHint(model, skipped) ?? undefined,
    };
  }

  const [primary, ...fallbacks] = credentialed;
  return { kind: "ok", primary, fallbacks };
}

/**
 * Resolve a model name to a provider chain.
 *
 * Two paths:
 *   1. Explicit prefix (`provider@model`): the caller named the vendor. We
 *      probe ONLY that vendor's credentials; missing credentials → no-route
 *      with a credential hint. **No silent fallback** — `defaultProvider` is
 *      not consulted because the user named a specific vendor.
 *   2. Bare name: consult routing rules (defaults + user overrides), append
 *      `defaultProvider` as a final fallback if set and not already present,
 *      build the candidate chain, filter to credentialed entries, return the
 *      filtered chain. Empty filtered chain → no-route with hints.
 *
 * Rules and the default provider are loaded fresh each call (via `loadRoutingRules()`
 * and `loadConfig()`) unless overrides are supplied. Tests should pass overrides
 * to avoid disk lookups.
 */
export function route(
  modelSpec: string,
  rulesOverride?: RoutingRules,
  defaultProviderOverride?: string
): RoutePlan {
  const parsed = parseModelSpec(modelSpec);

  if (parsed.isExplicitProvider) {
    return routeExplicit(modelSpec, parsed.model, parsed.provider);
  }

  const rules = rulesOverride ?? loadRoutingRules();
  // When tests pass an explicit `rulesOverride`, treat the rule set as the
  // authoritative source of truth and do not read `loadConfig().defaultProvider`
  // off disk — that would leak the host machine's config into unit tests.
  // Production callers (via `loadRoutingRules()`) get the disk-loaded default.
  const defaultProvider =
    defaultProviderOverride !== undefined
      ? defaultProviderOverride
      : rulesOverride !== undefined
        ? undefined
        : loadConfig().defaultProvider;
  return routeBare(parsed.model, parsed.provider, rules, defaultProvider);
}
