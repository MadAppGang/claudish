/**
 * Remote Provider Registry
 *
 * Handles resolution of remote cloud API providers (Gemini, OpenAI, MiniMax, Kimi, GLM, OllamaCloud, OpenCode Zen)
 * based on model ID prefixes.
 *
 * Prefix patterns:
 * - g/, gemini/ -> Google Gemini API (direct)
 * - go/ -> Google Gemini Code Assist (OAuth)
 * - oai/, openai/ -> OpenAI API
 * - mmax/, mm/ -> MiniMax API (Anthropic-compatible)
 * - kimi/, moonshot/ -> Kimi/Moonshot API (Anthropic-compatible)
 * - glm/, zhipu/ -> GLM/Zhipu API (OpenAI-compatible)
 * - oc/ -> OllamaCloud API (OpenAI-compatible)
 * - zen/ -> OpenCode Zen API (OpenAI-compatible + Anthropic for MiniMax)
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
    prefixes: ["g/", "gemini/", "google/"], // Per README: google/ routes to Gemini if GEMINI_API_KEY available
    capabilities: {
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      supportsJsonMode: false,
      supportsReasoning: true,
    },
  },
  {
    name: "gemini-codeassist",
    baseUrl: "https://cloudcode-pa.googleapis.com",
    apiPath: "/v1internal:streamGenerateContent?alt=sse",
    apiKeyEnvVar: "", // Empty - OAuth handles auth
    prefixes: ["go/"],
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
    prefixes: ["oai/", "openai/"], // Per README: openai/ routes to OpenAI if OPENAI_API_KEY available
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
  {
    name: "ollamacloud",
    baseUrl: process.env.OLLAMACLOUD_BASE_URL || "https://ollama.com",
    apiPath: "/api/chat",
    apiKeyEnvVar: "OLLAMA_API_KEY",
    prefixes: ["oc/"],
    capabilities: {
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
      supportsJsonMode: false,
      supportsReasoning: false,
    },
  },
  {
    name: "opencode-zen",
    baseUrl: process.env.OPENCODE_BASE_URL || "https://opencode.ai/zen",
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "", // Empty - free models don't require API key
    prefixes: ["zen/"],
    capabilities: {
      supportsTools: true,
      supportsVision: false,
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
  // Skip validation for OAuth-based providers (empty apiKeyEnvVar)
  if (provider.apiKeyEnvVar === "") {
    return null;
  }

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
      OLLAMA_API_KEY:
        "export OLLAMA_API_KEY='your-key' (get from https://ollama.com/account)",
      OPENCODE_API_KEY:
        "export OPENCODE_API_KEY='your-key' (get from https://opencode.ai/)",
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
