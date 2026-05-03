import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { hasOAuthCredentials } from "../auth/oauth-registry.js";
import { resolveModelNameSync } from "./model-catalog-resolver.js";
import { getApiKeyEnvVars } from "./provider-definitions.js";
import { resolveDefaultProvider } from "../default-provider.js";

export interface AutoRouteResult {
  provider: string;
  resolvedModelId: string;
  modelName: string;
  reason: AutoRouteReason;
  displayMessage: string;
}

export type AutoRouteReason =
  | "litellm-cache"
  | "oauth-credentials"
  | "api-key"
  | "openrouter-fallback"
  | "no-route";

function readLiteLLMCacheSync(baseUrl: string): Array<{ id: string; name: string }> | null {
  const hash = createHash("sha256").update(baseUrl).digest("hex").substring(0, 16);
  const cachePath = join(homedir(), ".claudish", `litellm-models-${hash}.json`);

  if (!existsSync(cachePath)) return null;

  try {
    const data = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (!Array.isArray(data.models)) return null;
    return data.models as Array<{ id: string; name: string }>;
  } catch {
    return null;
  }
}

function checkOAuthForProvider(nativeProvider: string, modelName: string): AutoRouteResult | null {
  if (!hasOAuthCredentials(nativeProvider)) return null;

  return {
    provider: nativeProvider,
    resolvedModelId: modelName,
    modelName,
    reason: "oauth-credentials",
    displayMessage: `Auto-routed: ${modelName} -> ${nativeProvider} (oauth)`,
  };
}

function checkApiKeyForProvider(nativeProvider: string, modelName: string): AutoRouteResult | null {
  const keyInfo = getApiKeyEnvVars(nativeProvider);
  if (!keyInfo) return null;

  if (keyInfo.envVar && process.env[keyInfo.envVar]) {
    return {
      provider: nativeProvider,
      resolvedModelId: modelName,
      modelName,
      reason: "api-key",
      displayMessage: `Auto-routed: ${modelName} -> ${nativeProvider} (api-key)`,
    };
  }

  if (keyInfo.aliases) {
    for (const alias of keyInfo.aliases) {
      if (process.env[alias]) {
        return {
          provider: nativeProvider,
          resolvedModelId: modelName,
          modelName,
          reason: "api-key",
          displayMessage: `Auto-routed: ${modelName} -> ${nativeProvider} (api-key)`,
        };
      }
    }
  }

  return null;
}

/**
 * Hint information for a provider - used to generate helpful "how to authenticate" messages.
 */
interface ProviderHintInfo {
  /** Subcommand args to trigger OAuth login, if the provider supports it (e.g., "login kimi") */
  loginFlag?: string;
  /** Primary API key environment variable name */
  apiKeyEnvVar?: string;
}

const PROVIDER_HINT_MAP: Record<string, ProviderHintInfo> = {
  "kimi-coding": { loginFlag: "login kimi", apiKeyEnvVar: "KIMI_CODING_API_KEY" },
  kimi: { loginFlag: "login kimi", apiKeyEnvVar: "MOONSHOT_API_KEY" },
  google: { loginFlag: "login gemini", apiKeyEnvVar: "GEMINI_API_KEY" },
  "gemini-codeassist": { loginFlag: "login gemini", apiKeyEnvVar: "GEMINI_API_KEY" },
  openai: { apiKeyEnvVar: "OPENAI_API_KEY" },
  "openai-codex": { loginFlag: "login codex", apiKeyEnvVar: "OPENAI_CODEX_API_KEY" },
  minimax: { apiKeyEnvVar: "MINIMAX_API_KEY" },
  "minimax-coding": { apiKeyEnvVar: "MINIMAX_CODING_API_KEY" },
  glm: { apiKeyEnvVar: "ZHIPU_API_KEY" },
  "glm-coding": { apiKeyEnvVar: "GLM_CODING_API_KEY" },
  deepseek: { apiKeyEnvVar: "DEEPSEEK_API_KEY" },
  ollamacloud: { apiKeyEnvVar: "OLLAMA_API_KEY" },
};

/**
 * Generate a helpful hint message when no credentials are found for a model.
 *
 * Returns a multi-line string with actionable options the user can take,
 * or null if no useful hint can be generated for this provider.
 *
 * @param modelName - The bare model name (e.g., "kimi-for-coding")
 * @param nativeProvider - The detected native provider (e.g., "kimi-coding", "unknown")
 */
export function getAutoRouteHint(modelName: string, nativeProvider: string): string | null {
  const hint = PROVIDER_HINT_MAP[nativeProvider];

  const lines: string[] = [`No credentials found for "${modelName}". Options:`];

  let hasOption = false;

  if (hint?.loginFlag) {
    lines.push(`  Run:  claudish ${hint.loginFlag}  (authenticate via OAuth)`);
    hasOption = true;
  }

  if (hint?.apiKeyEnvVar) {
    lines.push(`  Set:  export ${hint.apiKeyEnvVar}=your-key`);
    hasOption = true;
  }

  // Suggest routing the same model through OpenRouter
  lines.push(`  Use:  claudish --model or@${modelName}  (route via OpenRouter)`);
  hasOption = true;

  if (!hasOption) {
    // No useful hint for this provider - the existing error message is sufficient
    return null;
  }

  lines.push(`  Or set OPENROUTER_API_KEY for automatic OpenRouter fallback`);

  return lines.join("\n");
}

export function autoRoute(modelName: string, nativeProvider: string): AutoRouteResult | null {
  // Step 1: LiteLLM cache check (only when LiteLLM is the effective default provider)
  const effectiveDefault = resolveDefaultProvider({
    config: { version: "", defaultProfile: "", profiles: {} },
  }).provider;
  if (effectiveDefault === "litellm") {
    const litellmBaseUrl = process.env.LITELLM_BASE_URL;
    if (litellmBaseUrl) {
      const models = readLiteLLMCacheSync(litellmBaseUrl);
      if (models !== null) {
        const match = models.find((m) => m.name === modelName || m.id === `litellm@${modelName}`);
        if (match) {
          return {
            provider: "litellm",
            resolvedModelId: `litellm@${modelName}`,
            modelName,
            reason: "litellm-cache",
            displayMessage: `Auto-routed: ${modelName} -> litellm`,
          };
        }
      }
    }
  }

  // Step 2: OAuth credential check
  if (nativeProvider !== "unknown") {
    const oauthResult = checkOAuthForProvider(nativeProvider, modelName);
    if (oauthResult) return oauthResult;
  }

  // Step 3: Direct API key check
  if (nativeProvider !== "unknown") {
    const apiKeyResult = checkApiKeyForProvider(nativeProvider, modelName);
    if (apiKeyResult) return apiKeyResult;
  }

  // Step 4: OpenRouter fallback
  if (process.env.OPENROUTER_API_KEY) {
    const resolution = resolveModelNameSync(modelName, "openrouter");
    const orModelId = resolution.resolvedId;
    return {
      provider: "openrouter",
      resolvedModelId: orModelId,
      modelName,
      reason: "openrouter-fallback",
      displayMessage: `Auto-routed: ${modelName} -> openrouter`,
    };
  }

  return null;
}

/**
 * Fallback route candidate for provider failover.
 */
export interface FallbackRoute {
  /** Canonical provider name */
  provider: string;
  /** Model spec to pass to handler creation (e.g., "litellm@minimax-m2.5") */
  modelSpec: string;
  /** Human-readable provider name for logging */
  displayName: string;
}

import {
  getAllProviders,
  getDisplayName,
  getProviderByName,
  getShortestPrefix,
  getShortcuts,
} from "./provider-definitions.js";
import { getRuntimeProviders } from "./runtime-providers.js";

/** Reverse mapping: canonical provider name → shortest @ prefix for handler creation.
 *  Derived from BUILTIN_PROVIDERS. */
export const PROVIDER_TO_PREFIX: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const def of getAllProviders()) {
    if (def.shortestPrefix) {
      map[def.name] = def.shortestPrefix;
    }
  }
  return map;
})();

/** Display names — derived from BUILTIN_PROVIDERS. */
export const DISPLAY_NAMES: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const def of getAllProviders()) {
    map[def.name] = def.displayName;
  }
  return map;
})();

/**
 * Subscription/coding-plan alternatives for native providers.
 *
 * Many providers offer both per-usage API access and a subscription/coding plan
 * with higher limits or different pricing. The subscription tier should be tried
 * before per-usage API in the fallback chain.
 *
 * modelName: null = use the same model name as the original request.
 *            string = use this specific model name on the subscription endpoint.
 */
interface SubscriptionAlternative {
  subscriptionProvider: string;
  modelName: string | null;
  prefix: string;
  displayName: string;
}

const SUBSCRIPTION_ALTERNATIVES: Record<string, SubscriptionAlternative> = {
  // OpenAI → OpenAI Codex (Responses API, ChatGPT Plus/Pro subscription)
  openai: {
    subscriptionProvider: "openai-codex",
    modelName: null,
    prefix: "cx",
    displayName: "OpenAI Codex",
  },
  // Kimi → Kimi Coding Plan (subscription endpoint only accepts "kimi-for-coding")
  kimi: {
    subscriptionProvider: "kimi-coding",
    modelName: "kimi-for-coding",
    prefix: "kc",
    displayName: "Kimi Coding",
  },
  // MiniMax → MiniMax Coding Plan (same model names, different endpoint/key)
  minimax: {
    subscriptionProvider: "minimax-coding",
    modelName: null,
    prefix: "mmc",
    displayName: "MiniMax Coding",
  },
  // GLM → GLM Coding Plan at Z.AI (same model names, different endpoint/key)
  glm: {
    subscriptionProvider: "glm-coding",
    modelName: null,
    prefix: "gc",
    displayName: "GLM Coding",
  },
  // Gemini → Gemini Code Assist (OAuth-based subscription, same model names)
  google: {
    subscriptionProvider: "gemini-codeassist",
    modelName: null,
    prefix: "go",
    displayName: "Gemini Code Assist",
  },
};

/**
 * Read the cached Zen model list from disk (written by warmZenModelCache).
 * Returns a Set of model IDs that Zen serves, or null if cache not available.
 */
function readZenModelCacheSync(): Set<string> | null {
  const cachePath = join(homedir(), ".claudish", "zen-models.json");
  if (!existsSync(cachePath)) return null;
  try {
    const data = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (!Array.isArray(data.models)) return null;
    return new Set(data.models.map((m: any) => m.id));
  } catch {
    return null;
  }
}

/**
 * Check if a model is served by OpenCode Zen.
 * Uses the cached model list from zen/v1/models. If cache is unavailable,
 * conservatively returns false (skip Zen rather than waste a request).
 */
function isZenCompatibleModel(modelName: string): boolean {
  const zenModels = readZenModelCacheSync();
  if (!zenModels) return false;
  return zenModels.has(modelName);
}

/**
 * Pre-warm the Zen model cache by fetching from the live API.
 * Called at proxy startup (non-blocking). Writes to ~/.claudish/zen-models.json.
 */
export async function warmZenModelCache(): Promise<void> {
  const apiKey = process.env.OPENCODE_API_KEY || "public";
  const baseUrl = process.env.OPENCODE_BASE_URL || "https://opencode.ai/zen";
  const resp = await fetch(`${baseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) return;
  const data = (await resp.json()) as any;
  const models = (data.data ?? []).map((m: any) => ({ id: m.id }));
  if (models.length === 0) return;

  const cacheDir = join(homedir(), ".claudish");
  const { mkdirSync, writeFileSync: writeSync } = await import("node:fs");
  mkdirSync(cacheDir, { recursive: true });
  writeSync(
    join(cacheDir, "zen-models.json"),
    JSON.stringify({ models, fetchedAt: new Date().toISOString() })
  );
}

/**
 * Read the cached Zen Go model list from disk (written by warmZenGoModelCache).
 * Returns a Set of model IDs that Zen Go serves, or null if cache not available.
 * Zen Go only serves a small set of models (GLM-5, Kimi K2.5, MiniMax M2.5, MiniMax M2.7).
 */
function readZenGoModelCacheSync(): Set<string> | null {
  const cachePath = join(homedir(), ".claudish", "zen-go-models.json");
  if (!existsSync(cachePath)) return null;
  try {
    const data = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (!Array.isArray(data.models)) return null;
    return new Set(data.models.map((m: any) => m.id));
  } catch {
    return null;
  }
}

/**
 * Check if a model is served by OpenCode Zen Go.
 * Uses the separate zen-go-models.json cache (fetched from zen/go/v1/models).
 * If cache is unavailable, conservatively returns false.
 */
function isZenGoCompatibleModel(modelName: string): boolean {
  const zenGoModels = readZenGoModelCacheSync();
  if (!zenGoModels) return false;
  return zenGoModels.has(modelName);
}

/**
 * Pre-warm the Zen Go model cache by fetching from the live API.
 * Called at proxy startup (non-blocking). Writes to ~/.claudish/zen-go-models.json.
 * Zen Go uses a /go sub-path under the base Zen URL.
 */
export async function warmZenGoModelCache(): Promise<void> {
  const apiKey = process.env.OPENCODE_API_KEY || "public";
  const baseUrl = process.env.OPENCODE_BASE_URL || "https://opencode.ai/zen";
  const resp = await fetch(`${baseUrl}/go/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) return;
  const data = (await resp.json()) as any;
  const models = (data.data ?? []).map((m: any) => ({ id: m.id }));
  if (models.length === 0) return;

  const cacheDir = join(homedir(), ".claudish");
  const { mkdirSync, writeFileSync: writeSync } = await import("node:fs");
  mkdirSync(cacheDir, { recursive: true });
  writeSync(
    join(cacheDir, "zen-go-models.json"),
    JSON.stringify({ models, fetchedAt: new Date().toISOString() })
  );
}

/** Check if credentials exist for a given provider (API key, aliases, or OAuth). */
function hasProviderCredentials(provider: string): boolean {
  const keyInfo = getApiKeyEnvVars(provider);
  if (keyInfo?.envVar && process.env[keyInfo.envVar]) return true;
  if (keyInfo?.aliases?.some((a) => process.env[a])) return true;
  return hasOAuthCredentials(provider);
}

/**
 * Build the FallbackRoute for the user's effective default provider, if any.
 * Returns null when no default provider has credentials configured, or when
 * the default provider is one whose route is handled by a downstream step
 * (e.g., native-API providers — openai/anthropic/google — have their own
 * native-API step in {@link getFallbackChain} that handles them).
 *
 * Supports builtin defaults plus runtime custom endpoint defaults.
 */
export function getDefaultProviderRoute(
  modelName: string,
  defaultProvider: string
): FallbackRoute | null {
  const normalizedProvider =
    getShortcuts()[defaultProvider.toLowerCase()] ?? defaultProvider.toLowerCase();

  switch (normalizedProvider) {
    case "litellm": {
      // Preserves the current implicit behavior — only emits a route when
      // both LITELLM env vars are set.
      if (process.env.LITELLM_BASE_URL && process.env.LITELLM_API_KEY) {
        return {
          provider: "litellm",
          modelSpec: `litellm@${modelName}`,
          displayName: "LiteLLM",
        };
      }
      return null;
    }
    case "openrouter": {
      if (process.env.OPENROUTER_API_KEY) {
        const resolution = resolveModelNameSync(modelName, "openrouter");
        return {
          provider: "openrouter",
          modelSpec: resolution.resolvedId,
          displayName: "OpenRouter",
        };
      }
      return null;
    }
    case "openai":
    case "anthropic":
    case "google": {
      // Native-API providers — the downstream native-API step in
      // getFallbackChain will surface them when credentials are present.
      // Don't double-add here.
      return null;
    }
    default:
      break;
  }

  const def = getProviderByName(normalizedProvider);
  if (!def || !def.isDirectApi || !def.baseUrl) {
    return null;
  }

  const isRuntimeProvider = getRuntimeProviders().has(def.name);
  if (!isRuntimeProvider && !hasProviderCredentials(def.name)) {
    return null;
  }

  const prefix = getShortestPrefix(def.name);
  return {
    provider: def.name,
    modelSpec: `${prefix}@${modelName}`,
    displayName: getDisplayName(def.name),
  };
}

/**
 * Generate an ordered list of provider fallback candidates for a bare model name.
 *
 * Priority: Default Provider → Subscription (Zen Go) → Provider Subscription Plan → Native API → OpenRouter
 *
 * The "default provider" slot replaces the old hardcoded LiteLLM-first priority.
 * Callers may pass an explicit `defaultProvider` (typically resolved via
 * {@link resolveDefaultProvider} from ~/.claudish/config.json); when omitted,
 * this function resolves it itself via env vars as a fallback.
 *
 * Only includes providers that have credentials configured.
 * Used for auto-routed models (no explicit provider@ prefix).
 */
export function getFallbackChain(
  modelName: string,
  nativeProvider: string,
  defaultProvider?: string
): FallbackRoute[] {
  const routes: FallbackRoute[] = [];
  const seenProviders = new Set<string>();

  // Compute effective default provider (caller-supplied or env-resolved)
  const effectiveDefault =
    defaultProvider ??
    resolveDefaultProvider({
      config: { version: "", defaultProfile: "", profiles: {} },
    }).provider;

  // 1. Default provider (replaces the old hardcoded LiteLLM step)
  const defaultRoute = getDefaultProviderRoute(modelName, effectiveDefault);
  if (defaultRoute) {
    routes.push(defaultRoute);
    seenProviders.add(defaultRoute.provider);
  }

  // 2. Subscription aggregator (OpenCode Zen Go — only for model families it actually serves)
  if (
    process.env.OPENCODE_API_KEY &&
    isZenGoCompatibleModel(modelName) &&
    !seenProviders.has("opencode-zen-go")
  ) {
    routes.push({
      provider: "opencode-zen-go",
      modelSpec: `zengo@${modelName}`,
      displayName: "OpenCode Zen Go",
    });
    seenProviders.add("opencode-zen-go");
  }

  // 3. Provider-specific subscription/coding plan (tried before per-usage native API)
  const sub = SUBSCRIPTION_ALTERNATIVES[nativeProvider];
  if (
    sub &&
    hasProviderCredentials(sub.subscriptionProvider) &&
    !seenProviders.has(sub.subscriptionProvider)
  ) {
    const subModelName = sub.modelName || modelName;
    routes.push({
      provider: sub.subscriptionProvider,
      modelSpec: `${sub.prefix}@${subModelName}`,
      displayName: sub.displayName,
    });
    seenProviders.add(sub.subscriptionProvider);
  }

  // 4. Native API (per-usage, provider-specific OAuth or API key)
  if (
    nativeProvider !== "unknown" &&
    nativeProvider !== "qwen" &&
    nativeProvider !== "native-anthropic" &&
    !seenProviders.has(nativeProvider)
  ) {
    if (hasProviderCredentials(nativeProvider)) {
      const prefix = PROVIDER_TO_PREFIX[nativeProvider] || nativeProvider;
      routes.push({
        provider: nativeProvider,
        modelSpec: `${prefix}@${modelName}`,
        displayName: DISPLAY_NAMES[nativeProvider] || nativeProvider,
      });
      seenProviders.add(nativeProvider);
    }
  }

  // 5. OpenRouter (universal fallback — skipped if already seeded by default provider)
  if (process.env.OPENROUTER_API_KEY && !seenProviders.has("openrouter")) {
    const resolution = resolveModelNameSync(modelName, "openrouter");
    routes.push({
      provider: "openrouter",
      modelSpec: resolution.resolvedId, // vendor-prefixed (e.g., "minimax/minimax-m2.5")
      displayName: "OpenRouter",
    });
    seenProviders.add("openrouter");
  }

  return routes;
}
