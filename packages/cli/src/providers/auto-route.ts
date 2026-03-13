import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { hasOAuthCredentials } from "../auth/oauth-registry.js";
import { resolveModelName } from "./model-catalog-resolver.js";

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

/**
 * Local copy of API key env var mapping to avoid circular imports with provider-resolver.ts
 */
const API_KEY_ENV_VARS: Record<string, { envVar: string; aliases?: string[] }> = {
  google: { envVar: "GEMINI_API_KEY" },
  "gemini-codeassist": { envVar: "GEMINI_API_KEY" }, // uses OAuth not API key, but included for completeness
  openai: { envVar: "OPENAI_API_KEY" },
  minimax: { envVar: "MINIMAX_API_KEY" },
  "minimax-coding": { envVar: "MINIMAX_CODING_API_KEY" },
  kimi: { envVar: "MOONSHOT_API_KEY", aliases: ["KIMI_API_KEY"] },
  "kimi-coding": { envVar: "KIMI_CODING_API_KEY" },
  glm: { envVar: "ZHIPU_API_KEY", aliases: ["GLM_API_KEY"] },
  "glm-coding": { envVar: "GLM_CODING_API_KEY", aliases: ["ZAI_CODING_API_KEY"] },
  zai: { envVar: "ZAI_API_KEY" },
  ollamacloud: { envVar: "OLLAMA_API_KEY" },
  litellm: { envVar: "LITELLM_API_KEY" },
  openrouter: { envVar: "OPENROUTER_API_KEY" },
  vertex: { envVar: "VERTEX_API_KEY", aliases: ["VERTEX_PROJECT"] },
  poe: { envVar: "POE_API_KEY" },
};

async function readLiteLLMCache(baseUrl: string): Promise<Array<{ id: string; name: string }> | null> {
  const hash = createHash("sha256").update(baseUrl).digest("hex").substring(0, 16);
  const cachePath = join(homedir(), ".claudish", `litellm-models-${hash}.json`);

  try {
    const data = JSON.parse(await readFile(cachePath, "utf-8"));
    if (!Array.isArray(data.models)) return null;
    return data.models as Array<{ id: string; name: string }>;
  } catch {
    return null;
  }
}

async function checkOAuthForProvider(
  nativeProvider: string,
  modelName: string
): Promise<AutoRouteResult | null> {
  if (!(await hasOAuthCredentials(nativeProvider))) return null;

  return {
    provider: nativeProvider,
    resolvedModelId: modelName,
    modelName,
    reason: "oauth-credentials",
    displayMessage: `Auto-routed: ${modelName} -> ${nativeProvider} (oauth)`,
  };
}

function checkApiKeyForProvider(
  nativeProvider: string,
  modelName: string
): AutoRouteResult | null {
  const keyInfo = API_KEY_ENV_VARS[nativeProvider];
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
  "kimi": {
    loginFlag: "--kimi-login",
    apiKeyEnvVar: "MOONSHOT_API_KEY",
    openRouterModel: "moonshot/moonshot-v1-8k",
  },
  "google": {
    loginFlag: "--gemini-login",
    apiKeyEnvVar: "GEMINI_API_KEY",
    openRouterModel: "google/gemini-2.0-flash",
  },
  "gemini-codeassist": {
    loginFlag: "--gemini-login",
    apiKeyEnvVar: "GEMINI_API_KEY",
    openRouterModel: "google/gemini-2.0-flash",
  },
  "openai": {
    apiKeyEnvVar: "OPENAI_API_KEY",
    openRouterModel: "openai/gpt-4o",
  },
  "minimax": {
    apiKeyEnvVar: "MINIMAX_API_KEY",
    openRouterModel: "minimax/minimax-01",
  },
  "minimax-coding": {
    apiKeyEnvVar: "MINIMAX_CODING_API_KEY",
  },
  "glm": {
    apiKeyEnvVar: "ZHIPU_API_KEY",
    openRouterModel: "zhipuai/glm-4",
  },
  "glm-coding": {
    apiKeyEnvVar: "GLM_CODING_API_KEY",
  },
  "ollamacloud": {
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

  const lines: string[] = [
    `No credentials found for "${modelName}". Options:`,
  ];

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

export async function autoRoute(modelName: string, nativeProvider: string): Promise<AutoRouteResult | null> {
  // Step 1: LiteLLM cache check
  const litellmBaseUrl = process.env.LITELLM_BASE_URL;
  if (litellmBaseUrl) {
    const models = await readLiteLLMCache(litellmBaseUrl);
    if (models !== null) {
      const match = models.find(
        (m) => m.name === modelName || m.id === `litellm@${modelName}`
      );
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
    const oauthResult = await checkOAuthForProvider(nativeProvider, modelName);
    if (oauthResult) return oauthResult;
  }

  // Step 3: Direct API key check
  if (nativeProvider !== "unknown") {
    const apiKeyResult = checkApiKeyForProvider(nativeProvider, modelName);
    if (apiKeyResult) return apiKeyResult;
  }

  // Step 4: OpenRouter fallback
  if (process.env.OPENROUTER_API_KEY) {
    const resolution = await resolveModelName(modelName, "openrouter");
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
