import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { hasOAuthCredentials } from "../auth/oauth-registry.js";
import { resolveModelNameSync } from "./model-catalog-resolver.js";
import { getApiKeyEnvVars } from "./provider-definitions.js";

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
  /** CLI flag to trigger OAuth login, if the provider supports it (e.g., "--kimi-login") */
  loginFlag?: string;
  /** Primary API key environment variable name */
  apiKeyEnvVar?: string;
  /** OpenRouter model ID for fallback routing (e.g., "moonshot/kimi-for-coding") */
  openRouterModel?: string;
}

const PROVIDER_HINT_MAP: Record<string, ProviderHintInfo> = {
  "kimi-coding": {
    loginFlag: "--kimi-login",
    apiKeyEnvVar: "KIMI_CODING_API_KEY",
    openRouterModel: "moonshot/kimi-k2",
  },
  kimi: {
    loginFlag: "--kimi-login",
    apiKeyEnvVar: "MOONSHOT_API_KEY",
    openRouterModel: "moonshot/moonshot-v1-8k",
  },
  google: {
    loginFlag: "--gemini-login",
    apiKeyEnvVar: "GEMINI_API_KEY",
    openRouterModel: "google/gemini-2.0-flash",
  },
  "gemini-codeassist": {
    loginFlag: "--gemini-login",
    apiKeyEnvVar: "GEMINI_API_KEY",
    openRouterModel: "google/gemini-2.0-flash",
  },
  openai: {
    apiKeyEnvVar: "OPENAI_API_KEY",
    openRouterModel: "openai/gpt-4o",
  },
  minimax: {
    apiKeyEnvVar: "MINIMAX_API_KEY",
    openRouterModel: "minimax/minimax-01",
  },
  "minimax-coding": {
    apiKeyEnvVar: "MINIMAX_CODING_API_KEY",
  },
  glm: {
    apiKeyEnvVar: "ZHIPU_API_KEY",
    openRouterModel: "zhipuai/glm-4",
  },
  "glm-coding": {
    apiKeyEnvVar: "GLM_CODING_API_KEY",
  },
  ollamacloud: {
    apiKeyEnvVar: "OLLAMA_API_KEY",
  },
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

  if (hint?.openRouterModel) {
    lines.push(`  Use:  claudish --model or@${hint.openRouterModel}  (route via OpenRouter)`);
    hasOption = true;
  }

  if (!hasOption) {
    // No useful hint for this provider - the existing error message is sufficient
    return null;
  }

  lines.push(`  Or set OPENROUTER_API_KEY for automatic OpenRouter fallback`);

  return lines.join("\n");
}

export function autoRoute(modelName: string, nativeProvider: string): AutoRouteResult | null {
  // Step 1: LiteLLM cache check
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
  getShortestPrefix,
  getDisplayName as _getDisplayName,
  getAllProviders,
} from "./provider-definitions.js";

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
  const data = await resp.json() as any;
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

/** Check if credentials exist for a given provider (API key, aliases, or OAuth). */
function hasProviderCredentials(provider: string): boolean {
  const keyInfo = getApiKeyEnvVars(provider);
  if (keyInfo?.envVar && process.env[keyInfo.envVar]) return true;
  if (keyInfo?.aliases?.some((a) => process.env[a])) return true;
  return hasOAuthCredentials(provider);
}

/**
 * Generate an ordered list of provider fallback candidates for a bare model name.
 *
 * Priority: LiteLLM → Subscription (Zen Go) → Provider Subscription Plan → Native API → OpenRouter
 *
 * Only includes providers that have credentials configured.
 * Used for auto-routed models (no explicit provider@ prefix).
 */
export function getFallbackChain(modelName: string, nativeProvider: string): FallbackRoute[] {
  const routes: FallbackRoute[] = [];

  // 1. LiteLLM (always try if configured — cache may be stale or model may
  //    exist under a vendor-prefixed name that the proxy resolves dynamically)
  const litellmBaseUrl = process.env.LITELLM_BASE_URL;
  if (litellmBaseUrl && process.env.LITELLM_API_KEY) {
    routes.push({
      provider: "litellm",
      modelSpec: `litellm@${modelName}`,
      displayName: "LiteLLM",
    });
  }

  // 2. Subscription aggregator (OpenCode Zen Go — only for model families it actually serves)
  if (process.env.OPENCODE_API_KEY && isZenCompatibleModel(modelName)) {
    routes.push({
      provider: "opencode-zen-go",
      modelSpec: `zengo@${modelName}`,
      displayName: "OpenCode Zen Go",
    });
  }

  // 3. Provider-specific subscription/coding plan (tried before per-usage native API)
  const sub = SUBSCRIPTION_ALTERNATIVES[nativeProvider];
  if (sub && hasProviderCredentials(sub.subscriptionProvider)) {
    const subModelName = sub.modelName || modelName;
    routes.push({
      provider: sub.subscriptionProvider,
      modelSpec: `${sub.prefix}@${subModelName}`,
      displayName: sub.displayName,
    });
  }

  // 4. Native API (per-usage, provider-specific OAuth or API key)
  if (
    nativeProvider !== "unknown" &&
    nativeProvider !== "qwen" &&
    nativeProvider !== "native-anthropic"
  ) {
    if (hasProviderCredentials(nativeProvider)) {
      const prefix = PROVIDER_TO_PREFIX[nativeProvider] || nativeProvider;
      routes.push({
        provider: nativeProvider,
        modelSpec: `${prefix}@${modelName}`,
        displayName: DISPLAY_NAMES[nativeProvider] || nativeProvider,
      });
    }
  }

  // 5. OpenRouter (universal fallback)
  if (process.env.OPENROUTER_API_KEY) {
    const resolution = resolveModelNameSync(modelName, "openrouter");
    routes.push({
      provider: "openrouter",
      modelSpec: resolution.resolvedId, // vendor-prefixed (e.g., "minimax/minimax-m2.5")
      displayName: "OpenRouter",
    });
  }

  return routes;
}
