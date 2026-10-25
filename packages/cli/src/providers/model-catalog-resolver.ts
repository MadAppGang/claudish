/**
 * ModelCatalogResolver — universal vendor prefix resolution for API aggregators.
 *
 * API aggregators like OpenRouter and LiteLLM require vendor-prefixed model names
 * that differ from what users type. This module resolves bare names to the correct
 * fully-qualified API ID before the handler is constructed.
 *
 * Resolution is synchronous (uses in-memory caches + readFileSync only).
 * Warming is async and called once at proxy startup (fire-and-forget).
 *
 * All failures degrade to passthrough — never crash, return userInput unchanged.
 */

/**
 * Result of an explicit `refreshCatalog()` call.
 *
 * Unlike `warmCache()` (which is fire-and-forget and silent on failure),
 * `refreshCatalog()` returns ground truth so the launcher can make a policy
 * decision (proceed / warn / hard-fail) based on whether the fetch worked.
 *
 *  - `refreshed` — HTTP fetch returned ≥1 entries; in-memory cache replaced.
 *  - `fetch_failed` — Caches left untouched. `reason` distinguishes:
 *      - `timeout` — AbortSignal fired before response arrived.
 *      - `network` — fetch threw (DNS, connection refused, TLS, etc.).
 *      - `http_error` — response.ok was false (non-2xx status).
 *      - `empty` — body parsed but contained 0 entries.
 */
export type RefreshOutcome =
  | {
      kind: "refreshed";
      modelCount: number;
      /**
       * How much of the server catalog this refresh actually walked (#635 AC4).
       * Optional on the type — a resolver that fetches a single fixed resource
       * (LiteLLM) has nothing to page and no coverage to report.
       */
      coverage?: {
        pages: number;
        fetched: number;
        serverTotal: number | null;
        complete: boolean;
      };
    }
  | { kind: "fetch_failed"; reason: "timeout" | "network" | "http_error" | "empty" };

/**
 * Contract that every per-provider resolver implements.
 *
 * resolveSync() is called from getHandlerForRequest() which must stay synchronous.
 * It uses only in-memory caches or readFileSync — never await/fetch.
 *
 * warmCache() is async and is called once at proxy startup (or lazily).
 */
export interface ModelCatalogResolver {
  /**
   * The canonical provider name this resolver handles.
   * Must match the names in PROVIDER_SHORTCUTS / API_KEY_INFO.
   */
  readonly provider: string;

  /**
   * Synchronous resolution from in-memory cache.
   *
   * @param userInput - Bare name typed by user (e.g., "qwen3-coder-next", "gpt4")
   * @returns Resolved model ID ready to send to the API, or null if no match.
   *          For OpenRouter: returns "vendor/model".
   *          For LiteLLM: returns the resolved model_group name.
   */
  resolveSync(userInput: string): string | null;

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

  /**
   * Wait for the cache to become ready (warm), with a timeout.
   * If the cache is already warm, resolves immediately.
   * If warming fails or times out, resolves without error (graceful degradation).
   */
  ensureReady(timeoutMs: number): Promise<void>;

  /**
   * One-shot catalog fetch with explicit success/failure return.
   *
   * Differs from `warmCache()` in that the caller learns whether the fetch
   * actually worked. Used by the launcher catalog warm step to make a policy
   * decision (proceed / warn / hard-fail).
   *
   * Does NOT consult the disk cache — caller is responsible for fallback policy.
   * Mutates the in-memory cache and disk cache atomically only on success.
   * On failure, leaves caches untouched.
   *
   * Must not throw — all failures are surfaced via the returned outcome.
   */
  refreshCatalog(timeoutMs: number): Promise<RefreshOutcome>;
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
 * Main synchronous entry point.
 *
 * Called from proxy-server.ts BEFORE constructing ComposedHandler. If the resolver
 * for this provider has no warm cache and no disk fallback, userInput is returned
 * unchanged (graceful passthrough).
 *
 * @param userInput - The model name without provider prefix.
 * @param targetProvider - The canonical provider name (e.g., "openrouter").
 * @returns Resolved name (may equal userInput if no match found).
 */
export function resolveModelNameSync(
  userInput: string,
  targetProvider: string
): ModelResolutionResult {
  // Already a fully-qualified name (e.g., "qwen/qwen3-coder-next") — no resolution needed.
  // Exception: OpenRouter always needs resolution because the vendor part may be wrong/missing.
  if (targetProvider !== "openrouter" && userInput.includes("/")) {
    return { resolvedId: userInput, wasResolved: false, sourceLabel: "passthrough" };
  }

  const resolver = getResolver(targetProvider);
  if (!resolver) {
    return { resolvedId: userInput, wasResolved: false, sourceLabel: "passthrough" };
  }

  const resolved = resolver.resolveSync(userInput);
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
 * Emit a resolution notice to stderr (called after resolveModelNameSync returns wasResolved=true).
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
 * Ensure a specific provider's catalog is ready for synchronous resolution.
 * If already warm, resolves immediately. Otherwise waits up to timeoutMs.
 * Gracefully degrades on timeout — never throws.
 *
 * Call this before resolveModelNameSync() to guarantee the cache is populated.
 */
export async function ensureCatalogReady(provider: string, timeoutMs = 5000): Promise<void> {
  const resolver = getResolver(provider);
  if (!resolver || resolver.isCacheWarm()) return;
  await resolver.ensureReady(timeoutMs);
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

[
  new OpenRouterCatalogResolver(),
  // Future: OllamaCloudCatalogResolver, VertexCatalogResolver, etc.
].forEach(registerResolver);
