/**
 * Remote Provider Registry
 *
 * Handles resolution of remote cloud API providers (Gemini, OpenAI, MiniMax, Kimi, GLM, GLM Coding, OllamaCloud, OpenCode Zen)
 * based on model ID specifications.
 *
 * New syntax: provider@model
 * Examples:
 *   google@gemini-3-pro-preview          - Direct Google API
 *   openrouter@google/gemini-3-pro       - Explicit OpenRouter
 *   oai@gpt-5.3                          - Direct OpenAI API (shortcut)
 *
 * Legacy prefix patterns (deprecated, still supported):
 * - g/, gemini/ -> Google Gemini API (direct)
 * - go/ -> Google Gemini Code Assist (OAuth)
 * - oai/ -> OpenAI API (openai/ routes to OpenRouter)
 * - mmax/, mm/ -> MiniMax API (Anthropic-compatible)
 * - kimi/, moonshot/ -> Kimi/Moonshot API (Anthropic-compatible)
 * - glm/, zhipu/ -> GLM/Zhipu API (OpenAI-compatible)
 * - gc/ -> GLM Coding Plan API (OpenAI-compatible)
 * - zai/ -> Z.AI API (Anthropic-compatible)
 * - oc/ -> OllamaCloud API (OpenAI-compatible)
 * - zen/ -> OpenCode Zen API (OpenAI-compatible + Anthropic for MiniMax)
 * - or/, no prefix with "/" -> OpenRouter (existing handler)
 */

import type {
  RemoteProvider,
  ResolvedRemoteProvider,
} from "../handlers/shared/remote-provider-types.js";
import { parseModelSpec, isLocalProviderName } from "./model-parser.js";

/**
 * Remote provider configurations
 */
const getRemoteProviders = (): RemoteProvider[] => [
  {
    name: "gemini",
    baseUrl: process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com",
    apiPath: "/v1beta/models/{model}:streamGenerateContent?alt=sse",
    apiKeyEnvVar: "GEMINI_API_KEY",
    prefixes: ["g/", "gemini/"], // google/ routes to OpenRouter to avoid breaking existing workflows
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
    prefixes: ["oai/"], // openai/ routes to OpenRouter to avoid breaking existing workflows
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
    name: "kimi-coding",
    baseUrl: "https://api.kimi.com/coding/v1",
    apiPath: "/messages",
    apiKeyEnvVar: "KIMI_CODING_API_KEY",
    prefixes: ["kc/"],
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
      supportsReasoning: true,
    },
  },
  {
    name: "glm-coding",
    baseUrl: "https://api.z.ai",
    apiPath: "/api/coding/paas/v4/chat/completions",
    apiKeyEnvVar: "GLM_CODING_API_KEY",
    prefixes: ["gc/"],
    capabilities: {
      supportsTools: true,
      supportsVision: false, // Z.AI coding plan endpoint doesn't support image_url content
      supportsStreaming: true,
      supportsJsonMode: true,
      supportsReasoning: true,
    },
  },
  {
    name: "zai",
    baseUrl: process.env.ZAI_BASE_URL || "https://api.z.ai",
    apiPath: "/api/anthropic/v1/messages",
    apiKeyEnvVar: "ZAI_API_KEY",
    prefixes: ["zai/"],
    capabilities: {
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      supportsJsonMode: true,
      supportsReasoning: true,
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
  {
    name: "vertex",
    baseUrl: "", // Vertex uses regional endpoints, constructed dynamically
    apiPath: "", // Constructed dynamically based on project/location
    apiKeyEnvVar: "VERTEX_PROJECT", // OAuth-based, uses project ID as indicator
    prefixes: ["v/", "vertex/"],
    capabilities: {
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      supportsJsonMode: false,
      supportsReasoning: true,
    },
  },
  {
    name: "litellm",
    baseUrl: process.env.LITELLM_BASE_URL || "",
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "LITELLM_API_KEY",
    prefixes: ["litellm/", "ll/"],
    capabilities: {
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      supportsJsonMode: true,
      supportsReasoning: true,
    },
  },
];

/**
 * Resolve a model ID to a remote provider
 *
 * Supports both new syntax (provider@model) and legacy syntax (prefix/model)
 * Returns null if no provider matches (falls through to OpenRouter default)
 */
export function resolveRemoteProvider(modelId: string): ResolvedRemoteProvider | null {
  const providers = getRemoteProviders();

  // Try new model parser first
  const parsed = parseModelSpec(modelId);

  // Skip local providers - they're handled by provider-registry.ts
  if (isLocalProviderName(parsed.provider)) {
    return null;
  }

  // Skip custom URL providers
  if (parsed.provider === "custom-url") {
    return null;
  }

  // Map parsed provider name to remote provider config
  const providerNameMap: Record<string, string> = {
    google: "gemini",
    openai: "openai",
    openrouter: "openrouter",
    minimax: "minimax",
    kimi: "kimi",
    "kimi-coding": "kimi-coding",
    glm: "glm",
    "glm-coding": "glm-coding",
    zai: "zai",
    ollamacloud: "ollamacloud",
    "opencode-zen": "opencode-zen",
    vertex: "vertex", // Note: vertex might need special handling
    "gemini-codeassist": "gemini-codeassist",
    litellm: "litellm",
  };

  const mappedProviderName = providerNameMap[parsed.provider];
  if (mappedProviderName) {
    const provider = providers.find((p) => p.name === mappedProviderName);
    if (provider) {
      return {
        provider,
        modelName: parsed.model,
        isLegacySyntax: parsed.isLegacySyntax,
      };
    }
  }

  // Legacy: check prefix patterns for backwards compatibility
  for (const provider of providers) {
    for (const prefix of provider.prefixes) {
      if (modelId.startsWith(prefix)) {
        return {
          provider,
          modelName: modelId.slice(prefix.length),
          isLegacySyntax: true,
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
      KIMI_CODING_API_KEY:
        "export KIMI_CODING_API_KEY='sk-kimi-...' (get from https://kimi.com/code membership page, or run: claudish --kimi-login)",
      ZHIPU_API_KEY: "export ZHIPU_API_KEY='your-key' (get from https://open.bigmodel.cn/)",
      GLM_CODING_API_KEY: "export GLM_CODING_API_KEY='your-key' (get from https://z.ai/subscribe)",
      OLLAMA_API_KEY: "export OLLAMA_API_KEY='your-key' (get from https://ollama.com/account)",
      OPENCODE_API_KEY: "export OPENCODE_API_KEY='your-key' (get from https://opencode.ai/)",
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
