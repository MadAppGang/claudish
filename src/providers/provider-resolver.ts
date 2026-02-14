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
 * - direct-api: google@, openai@, minimax@, kimi@, glm@, zai@, zen@ - Provider-specific key
 * - openrouter: openrouter@ or unspecified provider for models with "/" - OPENROUTER_API_KEY
 * - native-anthropic: No "/" in model ID (e.g., claude-3-opus-20240229) - Claude Code native auth
 *
 * Legacy syntax (deprecated but supported):
 * - g/, gemini/, oai/, mmax/, etc. prefixes still work with deprecation warnings
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveProvider, parseUrlModel } from "./provider-registry.js";
import { resolveRemoteProvider } from "./remote-provider-registry.js";
import {
  parseModelSpec,
  isLocalProviderName,
  isDirectApiProvider,
  getLegacySyntaxWarning,
  type ParsedModel,
} from "./model-parser.js";

/**
 * Provider category types
 */
export type ProviderCategory = "local" | "direct-api" | "openrouter" | "native-anthropic" | "unknown";

/**
 * Complete resolution result for a model ID
 */
export interface ProviderResolution {
  /** The category this model falls into */
  category: ProviderCategory;
  /** Human-readable provider name (e.g., "Gemini", "OpenRouter", "Ollama") */
  providerName: string;
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
}

/**
 * API Key metadata for each provider
 */
interface ApiKeyInfo {
  envVar: string;
  description: string;
  url: string;
  /** Alternative env vars to check (aliases) */
  aliases?: string[];
  /** OAuth credential file under ~/.claudish/ to check as fallback */
  oauthFallback?: string;
}

/**
 * API key information for all providers
 */
const API_KEY_INFO: Record<string, ApiKeyInfo> = {
  openrouter: {
    envVar: "OPENROUTER_API_KEY",
    description: "OpenRouter API Key",
    url: "https://openrouter.ai/keys",
  },
  gemini: {
    envVar: "GEMINI_API_KEY",
    description: "Google Gemini API Key",
    url: "https://aistudio.google.com/app/apikey",
  },
  "gemini-codeassist": {
    envVar: "", // OAuth-based, no env var
    description: "Gemini Code Assist (OAuth)",
    url: "https://cloud.google.com/code-assist",
  },
  vertex: {
    envVar: "VERTEX_API_KEY",
    description: "Vertex AI API Key",
    url: "https://console.cloud.google.com/vertex-ai",
    aliases: ["VERTEX_PROJECT"], // OAuth mode alternative
  },
  openai: {
    envVar: "OPENAI_API_KEY",
    description: "OpenAI API Key",
    url: "https://platform.openai.com/api-keys",
  },
  xai: {
    envVar: "XAI_API_KEY",
    description: "xAI API Key",
    url: "https://x.ai/api",
  },
  minimax: {
    envVar: "MINIMAX_API_KEY",
    description: "MiniMax API Key",
    url: "https://www.minimaxi.com/",
  },
  kimi: {
    envVar: "MOONSHOT_API_KEY",
    description: "Kimi/Moonshot API Key",
    url: "https://platform.moonshot.cn/",
    aliases: ["KIMI_API_KEY"],
  },
  "kimi-coding": {
    envVar: "KIMI_CODING_API_KEY",
    description: "Kimi Coding API Key",
    url: "https://kimi.com/code (get key from membership page, or run: claudish --kimi-login)",
    oauthFallback: "kimi-oauth.json",
  },
  glm: {
    envVar: "ZHIPU_API_KEY",
    description: "GLM/Zhipu API Key",
    url: "https://open.bigmodel.cn/",
    aliases: ["GLM_API_KEY"],
  },
  "glm-coding": {
    envVar: "GLM_CODING_API_KEY",
    description: "GLM Coding Plan API Key",
    url: "https://z.ai/subscribe",
    aliases: ["ZAI_CODING_API_KEY"],
  },
  ollamacloud: {
    envVar: "OLLAMA_API_KEY",
    description: "OllamaCloud API Key",
    url: "https://ollama.com/account",
  },
  "opencode-zen": {
    envVar: "", // Free models don't require API key
    description: "OpenCode Zen (Free)",
    url: "https://opencode.ai/",
  },
  zai: {
    envVar: "ZAI_API_KEY",
    description: "Z.AI API Key",
    url: "https://z.ai/",
  },
  litellm: {
    envVar: "LITELLM_API_KEY",
    description: "LiteLLM API Key",
    url: "https://docs.litellm.ai/",
  },
};

/**
 * Local provider prefixes that never require an API key
 */
const LOCAL_PREFIXES = [
  "ollama/",
  "ollama:",
  "lmstudio/",
  "lmstudio:",
  "mlstudio/", // common typo
  "mlstudio:",
  "vllm/",
  "vllm:",
  "mlx/",
  "mlx:",
  "http://",
  "https://localhost",
];

/**
 * Display names for providers (for proper capitalization)
 */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  gemini: "Gemini",
  "gemini-codeassist": "Gemini Code Assist",
  vertex: "Vertex AI",
  openai: "OpenAI",
  xai: "xAI",
  openrouter: "OpenRouter",
  minimax: "MiniMax",
  kimi: "Kimi",
  "kimi-coding": "Kimi Coding",
  glm: "GLM",
  "glm-coding": "GLM Coding",
  zai: "Z.AI",
  ollamacloud: "OllamaCloud",
  "opencode-zen": "OpenCode Zen",
  litellm: "LiteLLM",
};

/**
 * Check if any of the API keys (including aliases) are available
 */
function isApiKeyAvailable(info: ApiKeyInfo): boolean {
  if (!info.envVar) {
    return true; // No key required (OAuth or free tier)
  }

  if (process.env[info.envVar]) {
    return true;
  }

  // Check aliases
  if (info.aliases) {
    for (const alias of info.aliases) {
      if (process.env[alias]) {
        return true;
      }
    }
  }

  // Check for OAuth credential file as fallback
  if (info.oauthFallback) {
    try {
      const credPath = join(homedir(), ".claudish", info.oauthFallback);
      if (existsSync(credPath)) {
        return true;
      }
    } catch {
      // Ignore filesystem errors
    }
  }

  return false;
}

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
 * 1. Parse model spec using new unified parser
 * 2. Check for local providers (no API key needed)
 * 3. Check for explicit provider routing
 * 4. Try native provider detection for models without explicit provider
 * 5. Fall back chain: provider API -> OpenRouter -> Vertex
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
      providerName: "OpenRouter",
      modelName: "",
      fullModelId: "",
      requiredApiKeyEnvVar: info.envVar,
      apiKeyAvailable: isApiKeyAvailable(info),
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

  // 1. Check for local providers (no API key needed)
  if (isLocalProviderName(parsed.provider)) {
    const resolved = resolveProvider(modelId);
    const urlParsed = parseUrlModel(modelId);

    let providerName = "Local";
    let modelName = parsed.model;

    if (resolved) {
      providerName = resolved.provider.name.charAt(0).toUpperCase() + resolved.provider.name.slice(1);
      modelName = resolved.modelName;
    } else if (urlParsed) {
      providerName = "Custom URL";
      modelName = urlParsed.modelName;
    }

    return addCommonFields({
      category: "local",
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
      providerName: "OpenRouter",
      modelName: parsed.model,
      fullModelId: modelId,
      requiredApiKeyEnvVar: info.envVar,
      apiKeyAvailable: isApiKeyAvailable(info),
      apiKeyDescription: info.description,
      apiKeyUrl: info.url,
    });
  }

  // 5. Try to resolve as direct API provider
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

    // Return direct-api resolution — report missing key instead of silent fallback
    return addCommonFields({
      category: "direct-api",
      providerName: providerDisplayName,
      modelName: remoteResolved.modelName,
      fullModelId: modelId,
      requiredApiKeyEnvVar: info.envVar || null,
      apiKeyAvailable: isApiKeyAvailable(info),
      apiKeyDescription: info.envVar ? info.description : null,
      apiKeyUrl: info.envVar ? info.url : null,
    });
  }

  // 6. Handle unknown providers (vendor/model format without known provider)
  // Require explicit provider specification: openrouter@vendor/model
  if (parsed.provider === "unknown") {
    return addCommonFields({
      category: "unknown",
      providerName: "Unknown",
      modelName: parsed.model,
      fullModelId: modelId,
      requiredApiKeyEnvVar: null,
      apiKeyAvailable: false,
      apiKeyDescription: null,
      apiKeyUrl: null,
    });
  }

  // 7. Fallback for any remaining cases (shouldn't normally reach here)
  return addCommonFields({
    category: "unknown",
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
export function validateApiKeysForModels(models: (string | undefined)[]): ProviderResolution[] {
  return models
    .filter((m): m is string => m !== undefined)
    .map((m) => resolveModelProvider(m));
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
  // Handle unknown provider
  if (resolution.category === "unknown") {
    const vendor = resolution.fullModelId.split("/")[0];
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
  lines.push(`Error: ${resolution.apiKeyDescription} is required for model "${resolution.fullModelId}"`);
  lines.push("");

  // How to fix
  lines.push("Set it with:");
  lines.push(`  export ${resolution.requiredApiKeyEnvVar}='your-key-here'`);

  // Where to get it
  if (resolution.apiKeyUrl) {
    lines.push("");
    lines.push(`Get your API key from: ${resolution.apiKeyUrl}`);
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
      lines.push("       claudish --model g/gemini-2.0-flash \"task\"");
    } else if (provider === "openai") {
      lines.push("");
      lines.push("     For direct OpenAI API (no OpenRouter), use prefix 'oai/':");
      lines.push("       claudish --model oai/gpt-4o \"task\"");
    }
  }

  return lines.join("\n");
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

  // Multiple missing keys
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
