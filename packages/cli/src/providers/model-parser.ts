/**
 * Model Parser - Unified syntax for provider@model:concurrency
 *
 * New syntax: provider@model[:concurrency]
 * Examples:
 *   openrouter@google/gemini-3-pro-preview  - Explicit OpenRouter
 *   google@gemini-3-pro-preview             - Direct Google API
 *   g@gemini-3-pro-preview                  - Direct Google API (shortcut)
 *   ollama@llama3.2:3                       - Ollama with concurrency 3
 *   ollama@llama3.2:0                       - Ollama with no limits
 *   openai/gpt-5.3                          - Legacy syntax (auto-detected)
 *
 * Provider shortcuts (case-insensitive):
 *   g, gemini     -> google (direct Gemini API)
 *   oai           -> openai (direct OpenAI API)
 *   or            -> openrouter
 *   mm, mmax      -> minimax
 *   kimi, moon    -> kimi/moonshot
 *   glm, zhipu    -> glm/zhipu
 *   zai           -> z.ai
 *   oc            -> ollamacloud
 *   zen           -> opencode-zen
 *   v, vertex     -> vertex
 *   go            -> gemini-codeassist (OAuth)
 *
 * Local provider shortcuts:
 *   ollama        -> ollama (local)
 *   lms, lmstudio -> lmstudio (local)
 *   vllm          -> vllm (local)
 *   mlx           -> mlx (local)
 *
 * Native model detection (when no provider prefix):
 *   google/*, gemini-*     -> google (direct)
 *   openai/*, gpt-*, o1-*  -> openai (direct)
 *   minimax/*              -> minimax (direct)
 *   moonshot/*, kimi-*     -> kimi (direct)
 *   zhipu/*, glm-*         -> glm (direct)
 *   deepseek/*             -> openrouter (no direct API)
 *   x-ai/*, grok-*         -> openrouter (no direct API)
 *   qwen/*                 -> openrouter (no direct API)
 *   anthropic/*            -> native-anthropic
 *   (anything else with /) -> openrouter
 */

/**
 * Parsed model specification
 */
export interface ParsedModel {
  /** Normalized provider name (lowercase) */
  provider: string;
  /** Model name/ID (without provider prefix) */
  model: string;
  /** Original full model string */
  original: string;
  /** Concurrency limit for local providers (undefined = use default, 0 = no limit) */
  concurrency?: number;
  /** Whether this used legacy syntax (for deprecation warnings) */
  isLegacySyntax: boolean;
  /** Whether provider was explicitly specified (vs auto-detected) */
  isExplicitProvider: boolean;
}

/**
 * Provider shortcut mappings (lowercase)
 * Maps short names to canonical provider names
 */
export const PROVIDER_SHORTCUTS: Record<string, string> = {
  // Remote providers
  g: "google",
  gemini: "google",
  oai: "openai",
  or: "openrouter",
  mm: "minimax",
  mmax: "minimax",
  kimi: "kimi",
  moon: "kimi",
  moonshot: "kimi",
  kc: "kimi-coding",
  glm: "glm",
  zhipu: "glm",
  gc: "glm-coding",
  zai: "zai",
  oc: "ollamacloud",
  zen: "opencode-zen",
  v: "vertex",
  vertex: "vertex",
  go: "gemini-codeassist",
  llama: "ollamacloud",
  lc: "ollamacloud",
  meta: "ollamacloud",
  poe: "poe",
  litellm: "litellm",
  ll: "litellm",

  // Local providers
  ollama: "ollama",
  lms: "lmstudio",
  lmstudio: "lmstudio",
  mlstudio: "lmstudio", // Common typo
  vllm: "vllm",
  mlx: "mlx",
};

/**
 * Providers that support direct API access (not OpenRouter)
 * Maps canonical provider name to whether direct API is available
 */
export const DIRECT_API_PROVIDERS = new Set([
  "google",
  "openai",
  "minimax",
  "kimi",
  "kimi-coding",
  "glm",
  "glm-coding",
  "zai",
  "ollamacloud",
  "opencode-zen",
  "vertex",
  "gemini-codeassist",
  "poe",
  "litellm",
]);

/**
 * Local providers (no API key needed)
 */
export const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio", "vllm", "mlx"]);

/**
 * Native model prefixes - models that should route to their native provider
 * when no explicit provider is specified
 *
 * Order matters! More specific patterns should come before general ones.
 */
export const NATIVE_MODEL_PATTERNS: Array<{
  pattern: RegExp;
  provider: string;
}> = [
  // Google Gemini models
  { pattern: /^google\//i, provider: "google" },
  { pattern: /^gemini-/i, provider: "google" },

  // OpenAI models
  { pattern: /^openai\//i, provider: "openai" },
  { pattern: /^gpt-/i, provider: "openai" },
  { pattern: /^o1(-|$)/i, provider: "openai" },
  { pattern: /^o3(-|$)/i, provider: "openai" },
  { pattern: /^chatgpt-/i, provider: "openai" },

  // MiniMax models
  { pattern: /^minimax\//i, provider: "minimax" },
  { pattern: /^minimax-/i, provider: "minimax" },
  { pattern: /^abab-/i, provider: "minimax" },

  // Kimi Coding models (must be before general kimi-* pattern)
  { pattern: /^kimi-for-coding$/i, provider: "kimi-coding" },

  // Kimi/Moonshot models
  { pattern: /^moonshot(ai)?\//i, provider: "kimi" },
  { pattern: /^moonshot-/i, provider: "kimi" },
  { pattern: /^kimi-/i, provider: "kimi" },

  // GLM/Zhipu models (direct Zhipu API)
  { pattern: /^zhipu\//i, provider: "glm" },
  { pattern: /^glm-/i, provider: "glm" },
  { pattern: /^chatglm-/i, provider: "glm" },

  // Z.AI models (Anthropic-compatible GLM API)
  { pattern: /^z-ai\//i, provider: "zai" },
  { pattern: /^zai\//i, provider: "zai" },

  // OllamaCloud models (native to all Llama models)
  { pattern: /^ollamacloud\//i, provider: "ollamacloud" },
  { pattern: /^meta-llama\//i, provider: "ollamacloud" },
  { pattern: /^llama-/i, provider: "ollamacloud" },
  { pattern: /^llama3/i, provider: "ollamacloud" },

  // Poe models (poe: prefix)
  { pattern: /^poe:/i, provider: "poe" },

  // Anthropic models (native Claude Code auth)
  { pattern: /^anthropic\//i, provider: "native-anthropic" },
  { pattern: /^claude-/i, provider: "native-anthropic" },
];

/**
 * Legacy prefix patterns for backwards compatibility
 * Maps old prefix -> [canonical provider, strip prefix?]
 */
export const LEGACY_PREFIX_PATTERNS: Array<{
  prefix: string;
  provider: string;
  stripPrefix: boolean;
}> = [
  // Remote providers (strip prefix)
  { prefix: "g/", provider: "google", stripPrefix: true },
  { prefix: "gemini/", provider: "google", stripPrefix: true },
  { prefix: "oai/", provider: "openai", stripPrefix: true },
  { prefix: "or/", provider: "openrouter", stripPrefix: true },
  { prefix: "mmax/", provider: "minimax", stripPrefix: true },
  { prefix: "mm/", provider: "minimax", stripPrefix: true },
  { prefix: "kimi/", provider: "kimi", stripPrefix: true },
  { prefix: "moonshot/", provider: "kimi", stripPrefix: true },
  { prefix: "kc/", provider: "kimi-coding", stripPrefix: true },
  { prefix: "glm/", provider: "glm", stripPrefix: true },
  { prefix: "zhipu/", provider: "glm", stripPrefix: true },
  { prefix: "gc/", provider: "glm-coding", stripPrefix: true },
  { prefix: "zai/", provider: "zai", stripPrefix: true },
  { prefix: "oc/", provider: "ollamacloud", stripPrefix: true },
  { prefix: "zen/", provider: "opencode-zen", stripPrefix: true },
  { prefix: "v/", provider: "vertex", stripPrefix: true },
  { prefix: "vertex/", provider: "vertex", stripPrefix: true },
  { prefix: "go/", provider: "gemini-codeassist", stripPrefix: true },

  // Local providers (strip prefix)
  { prefix: "ollama/", provider: "ollama", stripPrefix: true },
  { prefix: "ollama:", provider: "ollama", stripPrefix: true },
  { prefix: "lmstudio/", provider: "lmstudio", stripPrefix: true },
  { prefix: "lmstudio:", provider: "lmstudio", stripPrefix: true },
  { prefix: "mlstudio/", provider: "lmstudio", stripPrefix: true },
  { prefix: "mlstudio:", provider: "lmstudio", stripPrefix: true },
  { prefix: "vllm/", provider: "vllm", stripPrefix: true },
  { prefix: "vllm:", provider: "vllm", stripPrefix: true },
  { prefix: "mlx/", provider: "mlx", stripPrefix: true },
  { prefix: "mlx:", provider: "mlx", stripPrefix: true },
];

/**
 * Parse a model specification string
 *
 * Supports both new and legacy syntax:
 * - New: provider@model[:concurrency]
 * - Legacy: prefix/model or prefix:model
 *
 * @param modelSpec - The model specification string
 * @returns Parsed model information
 */
export function parseModelSpec(modelSpec: string): ParsedModel {
  const original = modelSpec;

  // Check for URL-style model (http:// or https://)
  if (modelSpec.startsWith("http://") || modelSpec.startsWith("https://")) {
    return {
      provider: "custom-url",
      model: modelSpec,
      original,
      isLegacySyntax: false,
      isExplicitProvider: true,
    };
  }

  // Check for new @ syntax: provider@model[:concurrency]
  const atMatch = modelSpec.match(/^([^@]+)@(.+)$/);
  if (atMatch) {
    const providerPart = atMatch[1].toLowerCase();
    let modelPart = atMatch[2];
    let concurrency: number | undefined;

    // Check for concurrency suffix on local providers
    const concurrencyMatch = modelPart.match(/^(.+):(\d+)$/);
    if (concurrencyMatch) {
      modelPart = concurrencyMatch[1];
      concurrency = parseInt(concurrencyMatch[2], 10);
    }

    // Resolve provider shortcut
    const provider = PROVIDER_SHORTCUTS[providerPart] || providerPart;

    return {
      provider,
      model: modelPart,
      original,
      concurrency,
      isLegacySyntax: false,
      isExplicitProvider: true,
    };
  }

  // Check for legacy prefix patterns
  const lowerSpec = modelSpec.toLowerCase();
  for (const { prefix, provider, stripPrefix } of LEGACY_PREFIX_PATTERNS) {
    if (lowerSpec.startsWith(prefix)) {
      const model = stripPrefix ? modelSpec.slice(prefix.length) : modelSpec;

      // Check for concurrency suffix on local providers
      let concurrency: number | undefined;
      let modelName = model;
      if (LOCAL_PROVIDERS.has(provider)) {
        const concurrencyMatch = model.match(/^(.+):(\d+)$/);
        if (concurrencyMatch) {
          modelName = concurrencyMatch[1];
          concurrency = parseInt(concurrencyMatch[2], 10);
        }
      }

      return {
        provider,
        model: modelName,
        original,
        concurrency,
        isLegacySyntax: true,
        isExplicitProvider: true,
      };
    }
  }

  // No explicit provider - try to detect native provider from model name
  for (const { pattern, provider } of NATIVE_MODEL_PATTERNS) {
    if (pattern.test(modelSpec)) {
      // For patterns that match "provider/model", strip the provider prefix
      const slashIndex = modelSpec.indexOf("/");
      const model = slashIndex > 0 ? modelSpec.slice(slashIndex + 1) : modelSpec;

      return {
        provider,
        model,
        original,
        isLegacySyntax: false,
        isExplicitProvider: false,
      };
    }
  }

  // Unknown vendor/model format - require explicit provider
  // Use openrouter@vendor/model if you want OpenRouter
  if (modelSpec.includes("/")) {
    return {
      provider: "unknown",
      model: modelSpec,
      original,
      isLegacySyntax: false,
      isExplicitProvider: false,
    };
  }

  // No "/" - treat as native Anthropic model
  return {
    provider: "native-anthropic",
    model: modelSpec,
    original,
    isLegacySyntax: false,
    isExplicitProvider: false,
  };
}

/**
 * Check if a provider is a local provider
 */
export function isLocalProviderName(provider: string): boolean {
  return LOCAL_PROVIDERS.has(provider.toLowerCase());
}

/**
 * Check if a provider supports direct API access
 */
export function isDirectApiProvider(provider: string): boolean {
  return DIRECT_API_PROVIDERS.has(provider.toLowerCase());
}

/**
 * Get deprecation warning for legacy syntax
 */
export function getLegacySyntaxWarning(parsed: ParsedModel): string | null {
  if (!parsed.isLegacySyntax) {
    return null;
  }

  const newSyntax = `${parsed.provider}@${parsed.model}`;
  return (
    `Deprecation warning: "${parsed.original}" uses legacy prefix syntax.\n` +
    `  Consider using: ${newSyntax}`
  );
}

/**
 * Format a model spec in the new syntax
 */
export function formatModelSpec(provider: string, model: string, concurrency?: number): string {
  let spec = `${provider}@${model}`;
  if (concurrency !== undefined) {
    spec += `:${concurrency}`;
  }
  return spec;
}
