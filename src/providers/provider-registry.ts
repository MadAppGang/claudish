/**
 * Provider Registry for Local LLM Providers
 *
 * Supports Ollama and other OpenAI-compatible local providers.
 * Extensible via configuration - no code changes needed to add new providers.
 */

export interface ProviderCapabilities {
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  supportsJsonMode: boolean;
}

export interface LocalProvider {
  name: string;
  baseUrl: string;
  apiPath: string;
  envVar: string;
  prefixes: string[];
  capabilities: ProviderCapabilities;
}

export interface ResolvedProvider {
  provider: LocalProvider;
  modelName: string;
}

export interface UrlParsedModel {
  baseUrl: string;
  modelName: string;
}

// Built-in provider configurations
const getProviders = (): LocalProvider[] => [
  {
    name: "ollama",
    baseUrl: process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    apiPath: "/v1/chat/completions",
    envVar: "OLLAMA_BASE_URL",
    prefixes: ["ollama/", "ollama:"],
    capabilities: {
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
      supportsJsonMode: true,
    },
  },
  {
    name: "lmstudio",
    baseUrl: process.env.LMSTUDIO_BASE_URL || "http://localhost:1234",
    apiPath: "/v1/chat/completions",
    envVar: "LMSTUDIO_BASE_URL",
    prefixes: ["lmstudio/", "lmstudio:", "mlstudio/", "mlstudio:"],  // mlstudio alias for common typo
    capabilities: {
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
      supportsJsonMode: true,
    },
  },
  {
    name: "vllm",
    baseUrl: process.env.VLLM_BASE_URL || "http://localhost:8000",
    apiPath: "/v1/chat/completions",
    envVar: "VLLM_BASE_URL",
    prefixes: ["vllm/", "vllm:"],
    capabilities: {
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
      supportsJsonMode: true,
    },
  },
  {
    name: "mlx",
    baseUrl: process.env.MLX_BASE_URL || "http://127.0.0.1:8080",
    apiPath: "/v1/chat/completions",
    envVar: "MLX_BASE_URL",
    prefixes: ["mlx/", "mlx:"],
    capabilities: {
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
      supportsJsonMode: true,
    },
  },
];

/**
 * Get all registered providers (refreshes env vars on each call)
 */
export function getRegisteredProviders(): LocalProvider[] {
  return getProviders();
}

/**
 * Resolve a model ID to a local provider if it matches any prefix
 */
export function resolveProvider(modelId: string): ResolvedProvider | null {
  const providers = getProviders();

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
 * Check if a model ID matches any local provider pattern
 */
export function isLocalProvider(modelId: string): boolean {
  // Check prefix patterns
  if (resolveProvider(modelId) !== null) {
    return true;
  }

  // Check URL patterns
  if (parseUrlModel(modelId) !== null) {
    return true;
  }

  return false;
}

/**
 * Parse a URL-style model specification
 * Supports: http://localhost:11434/modelname or http://host:port/v1/modelname
 */
export function parseUrlModel(modelId: string): UrlParsedModel | null {
  // Check for http:// or https:// prefix
  if (!modelId.startsWith("http://") && !modelId.startsWith("https://")) {
    return null;
  }

  try {
    const url = new URL(modelId);
    const pathParts = url.pathname.split("/").filter(Boolean);

    if (pathParts.length === 0) {
      return null;
    }

    // Model name is the last path segment
    const modelName = pathParts[pathParts.length - 1];

    // Base URL is everything except the model name
    // Handle cases like /v1/modelname or just /modelname
    let basePath = "";
    if (pathParts.length > 1) {
      // Check if second-to-last is "v1" or similar API version
      const prefix = pathParts.slice(0, -1).join("/");
      if (prefix) basePath = "/" + prefix;
    }

    const baseUrl = `${url.protocol}//${url.host}${basePath}`;

    return {
      baseUrl,
      modelName,
    };
  } catch {
    return null;
  }
}

/**
 * Create an ad-hoc provider config for URL-based models
 */
export function createUrlProvider(parsed: UrlParsedModel): LocalProvider {
  return {
    name: "custom-url",
    baseUrl: parsed.baseUrl,
    apiPath: "/v1/chat/completions",
    envVar: "",
    prefixes: [],
    capabilities: {
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
      supportsJsonMode: true,
    },
  };
}
