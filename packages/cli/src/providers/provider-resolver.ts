/**
 * Provider Resolver - Centralized API Key Validation Architecture
 *
 * This module is THE single source of truth for:
 * 1. Determining which provider a model ID routes to
 * 2. What API key (if any) is required
 * 3. Whether that API key is available
 * 4. User-friendly error messages for missing keys
 *
 * New syntax: provider@model[:concurrency]
 * Examples:
 *   openrouter@google/gemini-3-pro  - Explicit OpenRouter routing
 *   google@gemini-3-pro             - Direct Google API
 *   g@gemini-3-pro                  - Direct Google API (shortcut)
 *   ollama@llama3.2:3               - Local Ollama with concurrency 3
 *
 * Provider Categories:
 * - local: ollama@, lmstudio@, vllm@, mlx@, http://... - No API key needed
 * - direct-api: google@, openai@, minimax@, kimi@, glm@, z-ai@, x-ai@, zen@ - Provider-specific key
 * - openrouter: openrouter@ or unspecified provider for models with "/" - OPENROUTER_API_KEY
 * - native-anthropic: a name Claude Code owns (claude-3-opus-20240229, opus) - Claude Code native auth
 * - auto-route: any other bare name with no "/" (o4-mini) - route() picks the provider per request
 *
 * Legacy syntax (deprecated but supported):
 * - g/, gemini/, oai/, mmax/, etc. prefixes still work with deprecation warnings
 */

import { credentials } from "../auth/credentials/authority.js";
import { type BundledProvenance, bundledProvenance } from "./bundled-list-data.js";
import { type Reachability, catalogReachability } from "./catalog-reachability.js";
import {
  AUTO_ROUTE_PROVIDER,
  type ParsedModel,
  getLegacySyntaxWarning,
  isLocalProviderName,
  parseModelSpec,
} from "./model-parser.js";
import { renderOpFailureNotice } from "./onepassword.js";
import { DROPPED_LABEL } from "./probe-runner.js";
import {
  getApiKeyInfo as getApiKeyInfoFromDefs,
  getDisplayName as getDisplayNameFromDefs,
} from "./provider-definitions.js";
import { parseUrlModel, resolveProvider } from "./provider-registry.js";
import { resolveRemoteProvider } from "./remote-provider-registry.js";
import { buildCredentialHint } from "./routing-hints.js";
// routing-rules does NOT import provider-resolver, so this stays acyclic.
import {
  type CandidateOutcome,
  type FallbackWithheld,
  type NoRouteCause,
  type RouteExplanation,
  type RoutePlan,
  routeExplained,
} from "./routing-rules.js";

/**
 * Provider category types
 */
export type ProviderCategory =
  | "local"
  | "direct-api"
  | "openrouter"
  | "native-anthropic"
  | "auto-route"
  | "unknown";

/**
 * Complete resolution result for a model ID
 */
export interface ProviderResolution {
  /** The category this model falls into */
  category: ProviderCategory;
  /** Human-readable provider name (e.g., "Gemini", "OpenRouter", "Ollama") */
  providerName: string;
  /**
   * The credential-authority catalog name for this provider (e.g. "minimax",
   * "openrouter", "google"), used to resolve availability through the single
   * authority. Null for categories with no authority provider (unknown).
   */
  catalogName: string | null;
  /** The model name after stripping the prefix */
  modelName: string;
  /** Full original model ID */
  fullModelId: string;
  /** Environment variable name for the required API key, or null if none needed */
  requiredApiKeyEnvVar: string | null;
  /** Whether the required API key is currently set in environment */
  apiKeyAvailable: boolean;
  /** Human-readable description of the API key (e.g., "OpenRouter API Key") */
  apiKeyDescription: string | null;
  /** URL where user can get the API key */
  apiKeyUrl: string | null;
  /** Concurrency limit for local providers (from model spec) */
  concurrency?: number;
  /** Whether legacy syntax was used (for deprecation warning) */
  isLegacySyntax?: boolean;
  /** Deprecation warning message (if legacy syntax used) */
  deprecationWarning?: string;
  /** Parsed model specification */
  parsed?: ParsedModel;
  /** Whether this resolution came from auto-routing (isExplicitProvider was false) */
  wasAutoRouted?: boolean;
  /** Human-readable auto-routing decision message */
  autoRouteMessage?: string;
  /** Set when the routing verdict, not a missing key, is why this model cannot start. */
  routeRefusal?: RouteRefusal;
}

/** Why routing could not start a model, when the catalog's state is the reason to say so. */
export interface RouteRefusal {
  cause: NoRouteCause;
  reason: string;
  hint?: string;
  catalogSource: "disk" | "bundled" | "none";
  /** The verdict at the moment of the refusal. */
  reachability: Reachability;
  dropped: ReadonlyArray<{ displayName: string; outcome: Exclude<CandidateOutcome, "kept"> }>;
  fallbackWithheld?: FallbackWithheld;
}

/**
 * API Key metadata for each provider — derived from BUILTIN_PROVIDERS.
 */
interface ApiKeyInfo {
  envVar: string;
  description: string;
  url: string;
  aliases?: string[];
  oauthFallback?: string;
}

/**
 * Get API key info for a provider from the centralized definitions.
 * Falls back to a generic entry if the provider is unknown.
 */
function getApiKeyInfoForProvider(providerName: string): ApiKeyInfo {
  // Handle the google→gemini naming difference in provider-profiles.ts
  const lookupName = providerName === "gemini" ? "google" : providerName;
  const info = getApiKeyInfoFromDefs(lookupName);
  if (info) {
    return {
      envVar: info.envVar,
      description: info.description,
      url: info.url,
      aliases: info.aliases,
      oauthFallback: info.oauthFallback,
    };
  }
  return {
    envVar: "",
    description: `${providerName} API Key`,
    url: "",
  };
}

// Backwards-compatible record wrapper for code that accesses API_KEY_INFO[name]
const API_KEY_INFO = new Proxy<Record<string, ApiKeyInfo>>(
  {},
  {
    get(_target, prop: string) {
      return getApiKeyInfoForProvider(prop);
    },
    has() {
      return true; // All provider names have info via the fallback
    },
  }
);

/**
 * Display names for providers — derived from BUILTIN_PROVIDERS.
 */
const PROVIDER_DISPLAY_NAMES = new Proxy<Record<string, string>>(
  {},
  {
    get(_target, prop: string) {
      // Handle the google→gemini naming difference
      const lookupName = prop === "gemini" ? "google" : prop;
      return getDisplayNameFromDefs(lookupName);
    },
  }
);

/**
 * Resolve a model ID to its provider information
 *
 * This is THE single source of truth for provider resolution.
 * All code paths should call this function instead of implementing their own logic.
 *
 * New syntax: provider@model[:concurrency]
 * Legacy syntax: prefix/model (with deprecation warnings)
 *
 * Resolution order:
 * 1. Parse model spec using new unified parser; a bare name the parser left to
 *    routing (`auto-route`) is answered here, before any provider lookup
 * 2. Check for local providers (no API key needed)
 * 3. Check for native Anthropic models
 * 4. Check for explicit OpenRouter routing
 * 5. Auto-routing priority chain (LiteLLM -> OAuth -> API key -> OpenRouter fallback)
 * 6. Try to resolve as direct API provider
 * 7. Unknown provider fallback
 *
 * @param modelId - The model ID to resolve (can be undefined for default behavior)
 * @returns Complete provider resolution including API key requirements
 */
export function resolveModelProvider(modelId: string | undefined): ProviderResolution {
  // Default case: no model specified = OpenRouter with undefined model (will use default)
  if (!modelId) {
    const info = API_KEY_INFO.openrouter;
    return {
      category: "openrouter",
      catalogName: "openrouter",
      providerName: "OpenRouter",
      modelName: "",
      fullModelId: "",
      requiredApiKeyEnvVar: info.envVar,
      apiKeyAvailable: false, // authoritatively set by validateApiKeysForModels (credentials.isAvailable)
      apiKeyDescription: info.description,
      apiKeyUrl: info.url,
    };
  }

  // Parse model spec using the unified parser
  const parsed = parseModelSpec(modelId);
  const deprecationWarning = getLegacySyntaxWarning(parsed);

  // Helper to add common fields to resolution
  const addCommonFields = (resolution: ProviderResolution): ProviderResolution => ({
    ...resolution,
    parsed,
    isLegacySyntax: parsed.isLegacySyntax,
    deprecationWarning: deprecationWarning || undefined,
    concurrency: parsed.concurrency,
  });

  // 0. A bare name the parser attributed to nobody. `route()` picks its provider
  // on the first request, so there is no provider here to name, look up or ask
  // for a key: AUTO_ROUTE_PROVIDER is not a provider name, and it is answered
  // before any lookup that takes one (a custom endpoint could carry the name).
  // A null `requiredApiKeyEnvVar` is what keeps it out of
  // getMissingKeyResolutions and away from the credential authority.
  if (parsed.provider === AUTO_ROUTE_PROVIDER) {
    return addCommonFields({
      category: "auto-route",
      catalogName: null,
      providerName: "unresolved (routed on the first request)",
      modelName: parsed.model,
      fullModelId: modelId,
      requiredApiKeyEnvVar: null,
      apiKeyAvailable: true,
      apiKeyDescription: null,
      apiKeyUrl: null,
    });
  }

  // 1. Check for local providers (no API key needed)
  if (isLocalProviderName(parsed.provider)) {
    const resolved = resolveProvider(modelId);
    const urlParsed = parseUrlModel(modelId);

    let providerName = "Local";
    let modelName = parsed.model;

    if (resolved) {
      providerName =
        resolved.provider.name.charAt(0).toUpperCase() + resolved.provider.name.slice(1);
      modelName = resolved.modelName;
    } else if (urlParsed) {
      providerName = "Custom URL";
      modelName = urlParsed.modelName;
    }

    return addCommonFields({
      category: "local",
      catalogName: parsed.provider,
      providerName,
      modelName,
      fullModelId: modelId,
      requiredApiKeyEnvVar: null,
      apiKeyAvailable: true,
      apiKeyDescription: null,
      apiKeyUrl: null,
    });
  }

  // 2. Check for custom URL providers
  if (parsed.provider === "custom-url") {
    const urlParsed = parseUrlModel(modelId);
    return addCommonFields({
      category: "local",
      catalogName: null,
      providerName: "Custom URL",
      modelName: urlParsed?.modelName || modelId,
      fullModelId: modelId,
      requiredApiKeyEnvVar: null,
      apiKeyAvailable: true,
      apiKeyDescription: null,
      apiKeyUrl: null,
    });
  }

  // 3. Check for native Anthropic models
  if (parsed.provider === "native-anthropic") {
    return addCommonFields({
      category: "native-anthropic",
      catalogName: "native-anthropic",
      providerName: "Anthropic (Native)",
      modelName: parsed.model,
      fullModelId: modelId,
      requiredApiKeyEnvVar: null, // Claude Code handles its own auth
      apiKeyAvailable: true,
      apiKeyDescription: null,
      apiKeyUrl: null,
    });
  }

  // 4. Check for explicit OpenRouter routing
  if (parsed.provider === "openrouter") {
    const info = API_KEY_INFO.openrouter;
    return addCommonFields({
      category: "openrouter",
      catalogName: "openrouter",
      providerName: "OpenRouter",
      modelName: parsed.model,
      fullModelId: modelId,
      requiredApiKeyEnvVar: info.envVar,
      apiKeyAvailable: false, // authoritatively set by validateApiKeysForModels (credentials.isAvailable)
      apiKeyDescription: info.description,
      apiKeyUrl: info.url,
    });
  }

  // 5. Auto-routing for bare model names is handled upstream in proxy-server.ts
  // by route() (see providers/routing-rules.ts). This resolver runs ahead of
  // request handling and only annotates `wasAutoRouted` for diagnostics; the
  // actual chain construction lives in route().

  // 6. Try to resolve as direct API provider
  const remoteResolved = resolveRemoteProvider(modelId);
  if (remoteResolved) {
    const provider = remoteResolved.provider;

    // Provider-specific prefix found - check if provider's API key is available
    const info = API_KEY_INFO[provider.name] || {
      envVar: provider.apiKeyEnvVar,
      description: `${provider.name} API Key`,
      url: "",
    };

    const providerDisplayName =
      PROVIDER_DISPLAY_NAMES[provider.name] ||
      provider.name.charAt(0).toUpperCase() + provider.name.slice(1);

    const wasAutoRouted = !parsed.isExplicitProvider;

    // Return direct-api resolution — report missing key instead of silent fallback
    return addCommonFields({
      category: "direct-api",
      catalogName: provider.name,
      providerName: providerDisplayName,
      modelName: remoteResolved.modelName,
      fullModelId: modelId,
      requiredApiKeyEnvVar: info.envVar || null,
      apiKeyAvailable: false, // authoritatively set by validateApiKeysForModels (credentials.isAvailable)
      apiKeyDescription: info.envVar ? info.description : null,
      apiKeyUrl: info.envVar ? info.url : null,
      wasAutoRouted,
      autoRouteMessage: wasAutoRouted
        ? `Auto-routed: ${parsed.model} -> ${providerDisplayName}`
        : undefined,
    });
  }

  // 7. Handle unknown providers (vendor/model format without known provider)
  // Require explicit provider specification: openrouter@vendor/model
  if (parsed.provider === "unknown") {
    return addCommonFields({
      category: "unknown",
      catalogName: null,
      providerName: "Unknown",
      modelName: parsed.model,
      fullModelId: modelId,
      requiredApiKeyEnvVar: null,
      apiKeyAvailable: false,
      apiKeyDescription: null,
      apiKeyUrl: null,
    });
  }

  // 8. Fallback for any remaining cases (shouldn't normally reach here)
  return addCommonFields({
    category: "unknown",
    catalogName: null,
    providerName: "Unknown",
    modelName: parsed.model,
    fullModelId: modelId,
    requiredApiKeyEnvVar: null,
    apiKeyAvailable: false,
    apiKeyDescription: null,
    apiKeyUrl: null,
  });
}

/**
 * Validate API keys for multiple models at once
 *
 * Useful for checking all model slots (model, modelOpus, modelSonnet, modelHaiku, modelSubagent)
 *
 * @param models - Array of model IDs to validate (undefined entries are skipped)
 * @returns Array of resolutions for models that are defined
 */
export async function validateApiKeysForModels(
  models: (string | undefined)[]
): Promise<ProviderResolution[]> {
  const resolutions = models
    .filter((m): m is string => m !== undefined)
    .map((m) => resolveModelProvider(m));

  // SINGLE ORACLE: availability is decided by the credential authority
  // (credentials.isAvailable → env → config → oauth-file → op://, lazy SDK) — the
  // one source of truth that also gap-fills process.env with any resolved op://
  // key (for downstream sign-time + spawned children). The sync apiKeyAvailable
  // hint from resolveModelProvider is overwritten here with the authority's
  // answer, so validation can never disagree with routing/sign-time.
  await Promise.all(
    resolutions.map(async (r) => {
      // No key required (local / native / OAuth-or-free) → already true.
      if (!r.requiredApiKeyEnvVar) return;
      if (!r.catalogName) return; // unknown provider — leave as resolved
      r.apiKeyAvailable = await credentials.isAvailable(r.catalogName);
    })
  );

  await rescueRoutableResolutions(resolutions);

  return resolutions;
}

/** The routing oracle `rescueRoutableResolutions` consults (test seam). */
export type RouteOracle = (spec: string) => Promise<RoutePlan>;

/** What `rescueRoutableResolutions` consults: a plan, and why it came out that way. */
export type RescueOracle = (
  spec: string
) => Promise<{ plan: RoutePlan; explanation?: RouteExplanation }>;

/**
 * The refusal for a bare name routing could not place because of the catalog: none
 * could be read, or the bundled list answered and left no hop. Only a chain the
 * catalog gathered is one. An explicit spec names its provider, so a missing key
 * is the true reason; a user rule's hops are the user's own, so the catalog's
 * state is not why they failed.
 */
function routeRefusalFrom(explanation: RouteExplanation): RouteRefusal | undefined {
  const { outcome } = explanation;
  if (outcome.kind !== "no-route" || explanation.source !== "catalog") return undefined;
  if (outcome.cause !== "catalog-unreadable" && explanation.catalogSource !== "bundled") {
    return undefined;
  }
  return {
    cause: outcome.cause,
    reason: outcome.reason,
    ...(outcome.hint !== undefined ? { hint: outcome.hint } : {}),
    catalogSource: explanation.catalogSource ?? "none",
    reachability: catalogReachability(),
    dropped: explanation.candidates.flatMap(({ displayName, outcome: candidateOutcome }) =>
      candidateOutcome === "kept" ? [] : [{ displayName, outcome: candidateOutcome }]
    ),
    ...(explanation.fallbackWithheld !== undefined
      ? { fallbackWithheld: explanation.fallbackWithheld }
      : {}),
  };
}

/**
 * Let the routing chain overturn a "missing API key" verdict.
 *
 * The credential authority answers "is THIS provider credentialed", but it is
 * asked about whichever provider `resolveModelProvider` picked — and for a BARE
 * model name that is not necessarily the provider that will serve the request.
 * `route()` owns that decision, and the two resolvers genuinely disagree: bare
 * `glm-5-turbo` resolves to `glm` (needs ZHIPU_API_KEY) while `route()` serves it
 * from `glm-coding` with an `openrouter` fallback. With only an OpenRouter key
 * configured, startup died demanding a key for a provider it was never going to
 * call.
 *
 * `route()` returns `kind: "ok"` only when at least one provider in the chain is
 * credentialed — exactly the question being asked here — so it gets the last word.
 *
 * Deliberately a RESCUE, not a replacement: it only ever CLEARS a missing-key
 * verdict, never creates one. So every path `resolveModelProvider` already gets
 * right (local transports, native Anthropic, custom endpoints, unknown providers)
 * is untouched, and explicit `provider@model` specs stay strict for free —
 * `route()`'s explicit path probes only the pinned provider and never falls back, so a
 * pinned provider without credentials still returns `no-route` and still fails.
 *
 * Mutates the resolutions in place, mirroring the authority pass above.
 */
export async function rescueRoutableResolutions(
  resolutions: ProviderResolution[],
  router: RescueOracle = routeExplained
): Promise<void> {
  await Promise.all(
    resolutions.map(async (r) => {
      if (!r.requiredApiKeyEnvVar || r.apiKeyAvailable) return;
      try {
        const { plan, explanation } = await router(r.fullModelId);
        if (plan.kind === "ok") r.apiKeyAvailable = true;
        else if (explanation) r.routeRefusal = routeRefusalFrom(explanation);
      } catch {
        // Routing is best-effort here — a hiccup must not turn a servable model
        // into a hard startup failure, and must not mask a genuine missing key.
      }
    })
  );
}

/** Whether this refusal ends once the running catalog refresh lands or fails. */
export function awaitsCatalogBody(resolution: ProviderResolution): boolean {
  return (
    resolution.routeRefusal?.cause === "catalog-unreadable" &&
    resolution.routeRefusal.reachability.state === "contacted"
  );
}

/**
 * Get models with missing API keys from a list of resolutions
 *
 * @param resolutions - Array of provider resolutions
 * @returns Array of resolutions that have missing API keys
 */
export function getMissingKeyResolutions(resolutions: ProviderResolution[]): ProviderResolution[] {
  return resolutions.filter((r) => r.requiredApiKeyEnvVar && !r.apiKeyAvailable);
}

/**
 * Generate a user-friendly error message for a missing API key
 *
 * @param resolution - The provider resolution with missing key
 * @returns Formatted error message
 */
export function getMissingKeyError(resolution: ProviderResolution): string {
  if (resolution.routeRefusal) return describeRouteRefusal(resolution, resolution.routeRefusal);

  // Handle unknown provider
  if (resolution.category === "unknown") {
    return [
      `Error: Unknown provider for model "${resolution.fullModelId}"`,
      "",
      "Claudish doesn't recognize this model format. You have two options:",
      "",
      "1. Route through OpenRouter (requires OPENROUTER_API_KEY):",
      `   claudish --model openrouter@${resolution.fullModelId} "task"`,
      `   claudish --model or@${resolution.fullModelId} "task"`,
      "",
      "2. Use a provider with direct API support:",
      "   google@gemini-2.0-flash, oai@gpt-4o, etc.",
      "",
      "See 'claudish --help' for full list of supported providers.",
    ].join("\n");
  }

  if (!resolution.requiredApiKeyEnvVar || resolution.apiKeyAvailable) {
    return ""; // No error needed
  }

  const lines: string[] = [];

  // Main error
  lines.push(
    `Error: ${resolution.apiKeyDescription} is required for model "${resolution.fullModelId}"`
  );
  lines.push("");

  // 1Password context FIRST when it applies. Every op-source failure is
  // non-fatal by design (warn + skip, so a broken import can't lock the user
  // out), which meant a denied desktop authorization surfaced here as a plain
  // "missing key" and sent the user off to export a credential they already
  // store in 1Password. Empty for everyone who doesn't use 1Password.
  const opNotice = renderOpFailureNotice(resolution.requiredApiKeyEnvVar);
  if (opNotice.length > 0) {
    lines.push(...opNotice);
    lines.push("");
  }

  // How to fix
  lines.push(opNotice.length > 0 ? "Or set the key directly:" : "Set it with:");
  lines.push(`  export ${resolution.requiredApiKeyEnvVar}='your-key-here'`);

  // Where to get it
  if (resolution.apiKeyUrl) {
    lines.push("");
    lines.push(`Get your API key from: ${resolution.apiKeyUrl}`);
  }

  // Auto-route hint: show actionable options when no credentials were found
  // and the model was not explicitly prefixed by the user (auto-detected provider).
  // This helps users understand how to authenticate when auto-routing found no route.
  {
    const parsed = resolution.parsed;
    if (
      parsed &&
      !parsed.isExplicitProvider &&
      parsed.provider !== "unknown" &&
      parsed.provider !== "native-anthropic" &&
      parsed.provider !== AUTO_ROUTE_PROVIDER
    ) {
      const hint = buildCredentialHint(parsed.model, [parsed.provider]);
      if (hint) {
        lines.push("");
        lines.push(hint);
      }
    }
  }

  // Helpful tips based on category
  if (resolution.category === "openrouter") {
    const provider = resolution.fullModelId.split("/")[0];
    lines.push("");
    lines.push(`Tip: "${resolution.fullModelId}" is an OpenRouter model.`);
    lines.push(`     OpenRouter routes to ${provider}'s API through their unified interface.`);

    // Suggest direct API if available
    if (provider === "google") {
      lines.push("");
      lines.push("     For direct Gemini API (no OpenRouter), use prefix 'g/' or 'gemini/':");
      lines.push('       claudish --model g/gemini-2.0-flash "task"');
    } else if (provider === "openai") {
      lines.push("");
      lines.push("     For direct OpenAI API (no OpenRouter), use prefix 'oai/':");
      lines.push('       claudish --model oai/gpt-4o "task"');
    }
  }

  return lines.join("\n");
}

/** Why no catalog is available, for a sentence starting "no catalog is on disk and". */
function whyNoCatalog(reachability: Reachability): string {
  if (reachability.state !== "unreachable") return "no catalog could be read";
  const detail = reachability.detail ? ` (${reachability.detail})` : "";
  return reachability.reason === "disabled"
    ? `catalog refresh is turned off${detail}`
    : `the models-index backend is unreachable${detail}`;
}

const REFUSAL_REMEDY =
  "  Run `claudish --models-refresh` once online, or name the provider explicitly (provider@model).";

/** The bundled recommended list, with the release and generation it came from when known. */
function bundledListNameFor(provenance: BundledProvenance | null): string {
  if (!provenance) return "the bundled recommended list";
  return `the bundled recommended list (claudish ${provenance.version}, generation ${provenance.generationId})`;
}

/**
 * The launch error for a bare name the catalog's state keeps from routing. A vendor
 * key is not the cause here, so the error does not ask for one.
 */
function describeRouteRefusal(resolution: ProviderResolution, refusal: RouteRefusal): string {
  const name = resolution.fullModelId;
  const head = `Error: "${name}" cannot be routed: no cloud models catalog is on disk and ${whyNoCatalog(refusal.reachability)}`;

  const provenance = refusal.catalogSource === "bundled" ? bundledProvenance() : null;
  const listName = bundledListNameFor(provenance);

  if (refusal.catalogSource === "bundled" && refusal.cause !== "catalog-unreadable") {
    const lines = [
      `${head}, and`,
      `  no configured provider can serve "${name}" from ${listName}.`,
      ...refusal.dropped.map(
        ({ displayName, outcome }) => `    ${displayName}: ${DROPPED_LABEL[outcome]}`
      ),
      REFUSAL_REMEDY,
    ];
    if (refusal.hint && refusal.fallbackWithheld !== "bundled-no-default-provider") {
      lines.push("", refusal.hint);
    }
    return lines.join("\n");
  }

  if (provenance) {
    return [`${head}, and "${name}" is`, `  not in ${listName}.`, REFUSAL_REMEDY].join("\n");
  }
  return [`${head}.`, REFUSAL_REMEDY].join("\n");
}

/**
 * Generate combined error message for multiple missing keys
 *
 * @param resolutions - Array of resolutions with missing keys
 * @returns Formatted error message
 */
export function getMissingKeysError(resolutions: ProviderResolution[]): string {
  const missing = getMissingKeyResolutions(resolutions);

  if (missing.length === 0) {
    return "";
  }

  if (missing.length === 1) {
    return getMissingKeyError(missing[0]);
  }

  const refused = missing.filter((r) => r.routeRefusal);
  if (refused.length > 0) {
    const others = missing.filter((r) => !r.routeRefusal);
    return [
      ...refused.map(getMissingKeyError),
      ...(others.length === 1 ? [getMissingKeyError(others[0])] : []),
      ...(others.length > 1 ? [multipleMissingKeysText(others)] : []),
    ].join("\n\n");
  }

  return multipleMissingKeysText(missing);
}

/** The "Multiple API keys" grouping, one block per environment variable. */
function multipleMissingKeysText(missing: ProviderResolution[]): string {
  const lines: string[] = [];
  lines.push("Error: Multiple API keys are required for the configured models:");
  lines.push("");

  // Group by provider to avoid duplication
  const byEnvVar = new Map<string, ProviderResolution>();
  for (const r of missing) {
    if (r.requiredApiKeyEnvVar && !byEnvVar.has(r.requiredApiKeyEnvVar)) {
      byEnvVar.set(r.requiredApiKeyEnvVar, r);
    }
  }

  for (const [envVar, resolution] of byEnvVar) {
    lines.push(`  ${resolution.apiKeyDescription}:`);
    lines.push(`    export ${envVar}='your-key-here'`);
    if (resolution.apiKeyUrl) {
      lines.push(`    Get from: ${resolution.apiKeyUrl}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Check if any of the given models requires OpenRouter API key
 *
 * This is a convenience function for backwards compatibility.
 * New code should use resolveModelProvider() directly.
 *
 * @param modelId - Model ID to check
 * @returns true if OpenRouter API key is required
 */
export function requiresOpenRouterKey(modelId: string | undefined): boolean {
  const resolution = resolveModelProvider(modelId);
  return resolution.category === "openrouter";
}

/**
 * Check if a model is a local provider (no API key needed)
 *
 * This is a convenience function for backwards compatibility.
 * New code should use resolveModelProvider() directly.
 *
 * @param modelId - Model ID to check
 * @returns true if model is a local provider
 */
export function isLocalModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const resolution = resolveModelProvider(modelId);
  return resolution.category === "local";
}
