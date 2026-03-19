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
 * - mmc/ -> MiniMax Coding Plan API (Anthropic-compatible)
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
import { getAllProviders, toRemoteProvider } from "./provider-definitions.js";

/**
 * Remote provider configurations — derived from BUILTIN_PROVIDERS.
 * Filters out local-only and virtual providers (qwen, native-anthropic).
 */
const getRemoteProviders = (): RemoteProvider[] => {
  return getAllProviders()
    .filter((def) => !def.isLocal && def.baseUrl !== "" && def.name !== "qwen" && def.name !== "native-anthropic")
    .map(toRemoteProvider);
};

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

  // Look up provider by canonical name (toRemoteProvider maps "google" → "gemini" for compat)
  // Try both the parsed provider name and the RemoteProvider name (which may differ, e.g. google→gemini)
  const mappedName = parsed.provider === "google" ? "gemini" : parsed.provider;
  const provider = providers.find((p) => p.name === mappedName || p.name === parsed.provider);
  if (provider) {
    return {
      provider,
      modelName: parsed.model,
      isLegacySyntax: parsed.isLegacySyntax,
    };
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
      MINIMAX_CODING_API_KEY:
        "export MINIMAX_CODING_API_KEY='your-key' (get from https://platform.minimax.io/user-center/basic-information/interface-key)",
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
