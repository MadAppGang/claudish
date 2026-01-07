/**
 * Remote Provider Registry
 *
 * Handles resolution of remote cloud API providers (Gemini, OpenAI, MiniMax, Kimi, GLM)
 * based on model ID prefixes.
 *
 * Prefix patterns:
 * - g/, gemini/ -> Google Gemini API (direct)
 * - oai/, openai/ -> OpenAI API
 * - mmax/, mm/ -> MiniMax API (Anthropic-compatible)
 * - kimi/, moonshot/ -> Kimi/Moonshot API (Anthropic-compatible)
 * - glm/, zhipu/ -> GLM/Zhipu API (OpenAI-compatible)
 * - or/, no prefix with "/" -> OpenRouter (existing handler)
 */

import type {
  RemoteProvider,
  ResolvedRemoteProvider,
} from "../handlers/shared/remote-provider-types.js";

/**
 * Remote provider configurations
 */
const getRemoteProviders = (): RemoteProvider[] => [
  {
    name: "gemini",
    baseUrl: process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com",
    apiPath: "/v1beta/models/{model}:streamGenerateContent?alt=sse",
    apiKeyEnvVar: "GEMINI_API_KEY",
    prefixes: ["g/", "gemini/"],
    capabilities: {
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      supportsJsonMode: false,
      supportsReasoning: true,
    },
  },
  {
    name: "openai",
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com",
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "OPENAI_API_KEY",
    prefixes: ["oai/"], // Removed openai/ to prevent collision with OpenRouter models
    capabilities: {
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      supportsJsonMode: true,
      supportsReasoning: true,
    },
  },
  {
    name: "openrouter",
    baseUrl: "https://openrouter.ai",
    apiPath: "/api/v1/chat/completions",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
    prefixes: ["or/"],
    headers: {
      "HTTP-Referer": "https://claudish.com",
      "X-Title": "Claudish - OpenRouter Proxy",
    },
    capabilities: {
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      supportsJsonMode: true,
      supportsReasoning: true,
    },
  },
  {
    name: "minimax",
    baseUrl: process.env.MINIMAX_BASE_URL || "https://api.minimax.io",
    apiPath: "/anthropic/v1/messages",
    apiKeyEnvVar: "MINIMAX_API_KEY",
    prefixes: ["mmax/", "mm/"],
    capabilities: {
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      supportsJsonMode: false,
      supportsReasoning: false,
    },
  },
  {
    name: "kimi",
    baseUrl:
      process.env.MOONSHOT_BASE_URL || process.env.KIMI_BASE_URL || "https://api.moonshot.ai",
    apiPath: "/anthropic/v1/messages",
    apiKeyEnvVar: "MOONSHOT_API_KEY",
    prefixes: ["kimi/", "moonshot/"],
    capabilities: {
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      supportsJsonMode: false,
      supportsReasoning: true,
    },
  },
  {
    name: "glm",
    baseUrl: process.env.ZHIPU_BASE_URL || process.env.GLM_BASE_URL || "https://open.bigmodel.cn",
    apiPath: "/api/paas/v4/chat/completions",
    apiKeyEnvVar: "ZHIPU_API_KEY",
    prefixes: ["glm/", "zhipu/"],
    capabilities: {
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      supportsJsonMode: true,
      supportsReasoning: false,
    },
  },
];

/**
 * Resolve a model ID to a remote provider if it matches any prefix
 * Returns null if no prefix matches (falls through to OpenRouter default)
 */
export function resolveRemoteProvider(modelId: string): ResolvedRemoteProvider | null {
  const providers = getRemoteProviders();

  for (const provider of providers) {
    for (const prefix of provider.prefixes) {
      if (modelId.startsWith(prefix)) {
        return {
          provider,
          modelName: modelId.slice(prefix.length),
        };
      }
    }
  }

  return null;
}

/**
 * Check if a model ID explicitly routes to a remote provider (has a known prefix)
 */
export function hasRemoteProviderPrefix(modelId: string): boolean {
  return resolveRemoteProvider(modelId) !== null;
}

/**
 * Get the provider type for a model ID
 * Returns "gemini", "openai", "openrouter", or null
 */
export function getRemoteProviderType(modelId: string): string | null {
  const resolved = resolveRemoteProvider(modelId);
  return resolved?.provider.name || null;
}

/**
 * Validate that the required API key is set for a provider
 * Returns error message if validation fails, null if OK
 */
export function validateRemoteProviderApiKey(provider: RemoteProvider): string | null {
  const apiKey = process.env[provider.apiKeyEnvVar];

  if (!apiKey) {
    const examples: Record<string, string> = {
      GEMINI_API_KEY:
        "export GEMINI_API_KEY='your-key' (get from https://aistudio.google.com/app/apikey)",
      OPENAI_API_KEY:
        "export OPENAI_API_KEY='sk-...' (get from https://platform.openai.com/api-keys)",
      OPENROUTER_API_KEY:
        "export OPENROUTER_API_KEY='sk-or-...' (get from https://openrouter.ai/keys)",
      MINIMAX_API_KEY: "export MINIMAX_API_KEY='your-key' (get from https://www.minimaxi.com/)",
      MOONSHOT_API_KEY:
        "export MOONSHOT_API_KEY='your-key' (get from https://platform.moonshot.cn/)",
      ZHIPU_API_KEY: "export ZHIPU_API_KEY='your-key' (get from https://open.bigmodel.cn/)",
    };

    const example = examples[provider.apiKeyEnvVar] || `export ${provider.apiKeyEnvVar}='your-key'`;
    return `Missing ${provider.apiKeyEnvVar} environment variable.\n\nSet it with:\n  ${example}`;
  }

  return null;
}

/**
 * Get all registered remote providers
 */
export function getRegisteredRemoteProviders(): RemoteProvider[] {
  return getRemoteProviders();
}
