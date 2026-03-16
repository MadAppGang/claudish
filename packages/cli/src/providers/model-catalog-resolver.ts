/**
 * ModelCatalogResolver — universal vendor prefix resolution for API aggregators.
 *
 * API aggregators like OpenRouter and LiteLLM require vendor-prefixed model names
 * that differ from what users type. This module resolves bare names to the correct
 * fully-qualified API ID before the handler is constructed.
 *
 * Resolution uses in-memory caches with async disk fallback.
 * Warming is async and called once at proxy startup (fire-and-forget).
 *
 * All failures degrade to passthrough — never crash, return userInput unchanged.
 */

/**
 * Contract that every per-provider resolver implements.
 *
 * resolve() checks in-memory cache first, falls back to async disk read.
 * warmCache() is async and is called once at proxy startup (or lazily).
 */
export interface ModelCatalogResolver {
  /**
   * The canonical provider name this resolver handles.
   * Must match the names in PROVIDER_SHORTCUTS / API_KEY_INFO.
   */
  readonly provider: string;

  /**
   * Resolve a user-typed model name to a fully-qualified API ID.
   *
   * Checks in-memory cache first; falls back to async disk read if needed.
   *
   * @param userInput - Bare name typed by user (e.g., "qwen3-coder-next", "gpt4")
   * @returns Resolved model ID ready to send to the API, or null if no match.
   *          For OpenRouter: returns "vendor/model".
   *          For LiteLLM: returns the resolved model_group name.
   */
  resolve(userInput: string): Promise<string | null>;

  /**
   * Async warm-up: fetch the provider's catalog and store in module-level memory.
   * Safe to call multiple times (idempotent if already warm).
   * Must not throw — failures are silent and fall through to passthrough.
   */
  warmCache(): Promise<void>;

  /**
   * True if the in-memory cache is currently populated.
   * Used by the warmup strategy to decide whether to skip or refresh.
   */
  isCacheWarm(): boolean;
}

/**
 * Resolution result passed back to caller.
 */
export interface ModelResolutionResult {
  /** The resolved model ID (e.g., "qwen/qwen3-coder-next", "openai/gpt-4o") */
  resolvedId: string;
  /** Whether resolution changed the input (false = passthrough unchanged) */
  wasResolved: boolean;
  /** Human-readable label for the source (e.g., "openrouter catalog", "litellm catalog") */
  sourceLabel: string;
}

/**
 * Registry: maps canonical provider name → resolver instance.
 * Populated at module load time (no dynamic imports needed).
 */
const RESOLVER_REGISTRY = new Map<string, ModelCatalogResolver>();

export function registerResolver(resolver: ModelCatalogResolver): void {
  RESOLVER_REGISTRY.set(resolver.provider, resolver);
}

export function getResolver(provider: string): ModelCatalogResolver | null {
  return RESOLVER_REGISTRY.get(provider) ?? null;
}

/**
 * Resolve a model name to its fully-qualified API ID.
 *
 * Called from proxy-server.ts BEFORE constructing ProviderHandler. If the resolver
 * for this provider has no warm cache and no disk fallback, userInput is returned
 * unchanged (graceful passthrough).
 *
 * @param userInput - The model name without provider prefix.
 * @param targetProvider - The canonical provider name (e.g., "openrouter").
 * @returns Resolved name (may equal userInput if no match found).
 */
export async function resolveModelName(
  userInput: string,
  targetProvider: string
): Promise<ModelResolutionResult> {
  // Already a fully-qualified name (e.g., "qwen/qwen3-coder-next") — no resolution needed.
  // Exception: OpenRouter always needs resolution because the vendor part may be wrong/missing.
  if (targetProvider !== "openrouter" && userInput.includes("/")) {
    return { resolvedId: userInput, wasResolved: false, sourceLabel: "passthrough" };
  }

  const resolver = getResolver(targetProvider);
  if (!resolver) {
    return { resolvedId: userInput, wasResolved: false, sourceLabel: "passthrough" };
  }

  const resolved = await resolver.resolve(userInput);
  if (!resolved || resolved === userInput) {
    return { resolvedId: userInput, wasResolved: false, sourceLabel: "passthrough" };
  }

  return {
    resolvedId: resolved,
    wasResolved: true,
    sourceLabel: `${targetProvider} catalog`,
  };
}

/**
 * Synchronous variant of resolveModelName. Uses only in-memory caches
 * (no async fetch). Safe to call from synchronous code paths like routing
 * rules construction. Returns the best-effort resolved name.
 */
export function resolveModelNameSync(
  userInput: string,
  targetProvider: string
): ModelResolutionResult {
  // Already a fully-qualified name, pass through
  if (targetProvider !== "openrouter" && userInput.includes("/")) {
    return { resolvedId: userInput, wasResolved: false, sourceLabel: "passthrough" };
  }

  const resolver = getResolver(targetProvider);
  if (!resolver) {
    return { resolvedId: userInput, wasResolved: false, sourceLabel: "passthrough" };
  }

  // Try sync resolution if the resolver has a sync method, otherwise pass through.
  // The resolvers use in-memory caches populated by warmAllCatalogs(), so
  // if the cache is warm this will resolve correctly.
  if (typeof (resolver as any).resolveSync === "function") {
    const resolved = (resolver as any).resolveSync(userInput);
    if (resolved && resolved !== userInput) {
      return { resolvedId: resolved, wasResolved: true, sourceLabel: `${targetProvider} catalog (sync)` };
    }
  }

  // Fallback: for openrouter, try the static vendor map
  if (targetProvider === "openrouter") {
    // Just pass through the userInput, the async resolver will handle it at request time
    return { resolvedId: userInput, wasResolved: false, sourceLabel: "passthrough" };
  }

  return { resolvedId: userInput, wasResolved: false, sourceLabel: "passthrough" };
}

/**
 * Emit a resolution notice to stderr (called after resolveModelName returns wasResolved=true).
 */
export function logResolution(
  userInput: string,
  result: ModelResolutionResult,
  quiet = false
): void {
  if (result.wasResolved && !quiet) {
    process.stderr.write(
      `[Model] Resolved "${userInput}" → "${result.resolvedId}" (${result.sourceLabel})\n`
    );
  }
}

/**
 * Warm all registered resolvers concurrently.
 * Called once at proxy startup (non-blocking — proxy continues while warming).
 *
 * @param providers - Limit warming to these provider names (undefined = all).
 */
export async function warmAllCatalogs(providers?: string[]): Promise<void> {
  const targets = providers
    ? [...RESOLVER_REGISTRY.entries()].filter(([k]) => providers.includes(k))
    : [...RESOLVER_REGISTRY.entries()];

  await Promise.allSettled(targets.map(([, r]) => r.warmCache()));
}

// ---------------------------------------------------------------------------
// Auto-register all resolvers at import time
// ---------------------------------------------------------------------------
import { OpenRouterCatalogResolver } from "./catalog-resolvers/openrouter.js";
import { LiteLLMCatalogResolver } from "./catalog-resolvers/litellm.js";

[
  new OpenRouterCatalogResolver(),
  new LiteLLMCatalogResolver(),
  // Future: OllamaCloudCatalogResolver, VertexCatalogResolver, etc.
].forEach(registerResolver);
