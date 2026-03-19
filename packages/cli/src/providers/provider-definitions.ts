/**
 * Provider Definitions — Single Source of Truth
 *
 * Every provider's identity (name, shortcuts, prefixes, patterns, API key info,
 * display name, transport type, capabilities) lives here. All other files derive
 * from these definitions instead of maintaining their own copies.
 *
 * Adding a new provider: add one entry to BUILTIN_PROVIDERS. No other file changes needed
 * for identity/routing — only transport and adapter wiring in provider-profiles.ts.
 */

import type { RemoteProvider } from "../handlers/shared/remote-provider-types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransportType =
  | "openai"
  | "anthropic"
  | "gemini"
  | "gemini-oauth"
  | "openrouter"
  | "ollamacloud"
  | "kimi-coding"
  | "litellm"
  | "vertex"
  | "local"
  | "ollama"
  | "poe";

export type TokenStrategy = "delta-aware" | "accumulate-both" | undefined;

export interface ProviderCapabilities {
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsStreaming?: boolean;
  supportsJsonMode?: boolean;
  supportsReasoning?: boolean;
}

export interface ProviderDefinition {
  /** Canonical provider name (lowercase, unique key) */
  name: string;
  /** Human-readable display name (proper capitalization) */
  displayName: string;
  /** Transport type for handler construction */
  transport: TransportType;
  /** Token counting strategy */
  tokenStrategy?: TokenStrategy;
  /** Base URL for the API (may be overridden by env var) */
  baseUrl: string;
  /** Environment variables that can override the base URL */
  baseUrlEnvVars?: string[];
  /** API path template (e.g., "/v1/chat/completions") */
  apiPath: string;
  /** Primary API key environment variable */
  apiKeyEnvVar: string;
  /** Alternative env vars to check */
  apiKeyAliases?: string[];
  /** Human-readable API key description */
  apiKeyDescription: string;
  /** URL where user can obtain an API key */
  apiKeyUrl: string;
  /** Auth scheme for the API key header */
  authScheme?: "x-api-key" | "bearer";
  /** Provider shortcuts (e.g., ["g", "gemini"] → "google") */
  shortcuts: string[];
  /** Legacy prefix patterns for backwards compat (e.g., ["g/", "gemini/"]) */
  legacyPrefixes: Array<{ prefix: string; stripPrefix: boolean }>;
  /** Native model patterns for auto-detection (when no provider prefix) */
  nativeModelPatterns?: Array<{ pattern: RegExp }>;
  /** Provider capabilities */
  capabilities?: ProviderCapabilities;
  /** Custom HTTP headers to include with requests */
  headers?: Record<string, string>;
  /** Fallback API key value for auth-less access (e.g., "public" for free tiers) */
  publicKeyFallback?: string;
  /** OAuth credential file under ~/.claudish/ to check as fallback */
  oauthFallback?: string;
  /** Whether this is a local provider (no API key needed) */
  isLocal?: boolean;
  /** Whether this provider supports direct API access (not just via OpenRouter) */
  isDirectApi?: boolean;
  /** Shortest @ prefix for handler creation (reverse of shortcuts) */
  shortestPrefix?: string;
}

// ---------------------------------------------------------------------------
// Built-in provider definitions
// ---------------------------------------------------------------------------

export const BUILTIN_PROVIDERS: ProviderDefinition[] = [
  // ── Google Gemini (direct API) ─────────────────────────────────────
  {
    name: "google",
    displayName: "Gemini",
    transport: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    baseUrlEnvVars: ["GEMINI_BASE_URL"],
    apiPath: "/v1beta/models/{model}:streamGenerateContent?alt=sse",
    apiKeyEnvVar: "GEMINI_API_KEY",
    apiKeyDescription: "Google Gemini API Key",
    apiKeyUrl: "https://aistudio.google.com/app/apikey",
    shortcuts: ["g", "gemini"],
    shortestPrefix: "g",
    legacyPrefixes: [
      { prefix: "g/", stripPrefix: true },
      { prefix: "gemini/", stripPrefix: true },
    ],
    nativeModelPatterns: [{ pattern: /^google\//i }, { pattern: /^gemini-/i }],
    isDirectApi: true,
  },

  // ── Gemini Code Assist (OAuth) ─────────────────────────────────────
  {
    name: "gemini-codeassist",
    displayName: "Gemini Code Assist",
    transport: "gemini-oauth",
    baseUrl: "https://cloudcode-pa.googleapis.com",
    apiPath: "/v1internal:streamGenerateContent?alt=sse",
    apiKeyEnvVar: "",
    apiKeyDescription: "Gemini Code Assist (OAuth)",
    apiKeyUrl: "https://cloud.google.com/code-assist",
    shortcuts: ["go"],
    shortestPrefix: "go",
    legacyPrefixes: [{ prefix: "go/", stripPrefix: true }],
    isDirectApi: true,
  },

  // ── OpenAI (direct API) ────────────────────────────────────────────
  {
    name: "openai",
    displayName: "OpenAI",
    transport: "openai",
    tokenStrategy: "delta-aware",
    baseUrl: "https://api.openai.com",
    baseUrlEnvVars: ["OPENAI_BASE_URL"],
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "OPENAI_API_KEY",
    apiKeyDescription: "OpenAI API Key",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    shortcuts: ["oai"],
    shortestPrefix: "oai",
    legacyPrefixes: [{ prefix: "oai/", stripPrefix: true }],
    nativeModelPatterns: [
      { pattern: /^openai\//i },
      { pattern: /^gpt-/i },
      { pattern: /^o1(-|$)/i },
      { pattern: /^o3(-|$)/i },
      { pattern: /^chatgpt-/i },
    ],
    isDirectApi: true,
  },

  // ── OpenRouter ─────────────────────────────────────────────────────
  {
    name: "openrouter",
    displayName: "OpenRouter",
    transport: "openrouter",
    baseUrl: "https://openrouter.ai",
    apiPath: "/api/v1/chat/completions",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
    apiKeyDescription: "OpenRouter API Key",
    apiKeyUrl: "https://openrouter.ai/keys",
    shortcuts: ["or"],
    shortestPrefix: "or",
    legacyPrefixes: [{ prefix: "or/", stripPrefix: true }],
    nativeModelPatterns: [{ pattern: /^openrouter\//i }],
    headers: {
      "HTTP-Referer": "https://claudish.com",
      "X-Title": "Claudish - OpenRouter Proxy",
    },
    isDirectApi: true,
  },

  // ── MiniMax (Anthropic-compatible) ─────────────────────────────────
  {
    name: "minimax",
    displayName: "MiniMax",
    transport: "anthropic",
    baseUrl: "https://api.minimax.io",
    baseUrlEnvVars: ["MINIMAX_BASE_URL"],
    apiPath: "/anthropic/v1/messages",
    apiKeyEnvVar: "MINIMAX_API_KEY",
    apiKeyDescription: "MiniMax API Key",
    apiKeyUrl: "https://www.minimaxi.com/",
    authScheme: "bearer",
    shortcuts: ["mm", "mmax"],
    shortestPrefix: "mm",
    legacyPrefixes: [
      { prefix: "mmax/", stripPrefix: true },
      { prefix: "mm/", stripPrefix: true },
    ],
    nativeModelPatterns: [
      { pattern: /^minimax\//i },
      { pattern: /^minimax-/i },
      { pattern: /^abab-/i },
    ],
    isDirectApi: true,
  },

  // ── MiniMax Coding Plan ────────────────────────────────────────────
  {
    name: "minimax-coding",
    displayName: "MiniMax Coding",
    transport: "anthropic",
    baseUrl: "https://api.minimax.io",
    baseUrlEnvVars: ["MINIMAX_CODING_BASE_URL"],
    apiPath: "/anthropic/v1/messages",
    apiKeyEnvVar: "MINIMAX_CODING_API_KEY",
    apiKeyDescription: "MiniMax Coding Plan API Key",
    apiKeyUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
    authScheme: "bearer",
    shortcuts: ["mmc"],
    shortestPrefix: "mmc",
    legacyPrefixes: [{ prefix: "mmc/", stripPrefix: true }],
    isDirectApi: true,
  },

  // ── Kimi Coding Plan (must be before Kimi — kimi-for-coding$ is more specific than kimi-*)
  {
    name: "kimi-coding",
    displayName: "Kimi Coding",
    transport: "kimi-coding",
    baseUrl: "https://api.kimi.com/coding/v1",
    apiPath: "/messages",
    apiKeyEnvVar: "KIMI_CODING_API_KEY",
    apiKeyDescription: "Kimi Coding API Key",
    apiKeyUrl: "https://kimi.com/code (get key from membership page, or run: claudish --kimi-login)",
    oauthFallback: "kimi-oauth.json",
    shortcuts: ["kc"],
    shortestPrefix: "kc",
    legacyPrefixes: [{ prefix: "kc/", stripPrefix: true }],
    nativeModelPatterns: [{ pattern: /^kimi-for-coding$/i }],
    isDirectApi: true,
  },

  // ── Kimi / Moonshot (Anthropic-compatible) ─────────────────────────
  {
    name: "kimi",
    displayName: "Kimi",
    transport: "anthropic",
    baseUrl: "https://api.moonshot.ai",
    baseUrlEnvVars: ["MOONSHOT_BASE_URL", "KIMI_BASE_URL"],
    apiPath: "/anthropic/v1/messages",
    apiKeyEnvVar: "MOONSHOT_API_KEY",
    apiKeyAliases: ["KIMI_API_KEY"],
    apiKeyDescription: "Kimi/Moonshot API Key",
    apiKeyUrl: "https://platform.moonshot.cn/",
    shortcuts: ["kimi", "moon", "moonshot"],
    shortestPrefix: "kimi",
    legacyPrefixes: [
      { prefix: "kimi/", stripPrefix: true },
      { prefix: "moonshot/", stripPrefix: true },
    ],
    nativeModelPatterns: [
      { pattern: /^moonshot(ai)?\//i },
      { pattern: /^moonshot-/i },
      { pattern: /^kimi-/i },
    ],
    isDirectApi: true,
  },

  // ── GLM / Zhipu (OpenAI-compatible) ────────────────────────────────
  {
    name: "glm",
    displayName: "GLM",
    transport: "openai",
    tokenStrategy: "delta-aware",
    baseUrl: "https://open.bigmodel.cn",
    baseUrlEnvVars: ["ZHIPU_BASE_URL", "GLM_BASE_URL"],
    apiPath: "/api/paas/v4/chat/completions",
    apiKeyEnvVar: "ZHIPU_API_KEY",
    apiKeyAliases: ["GLM_API_KEY"],
    apiKeyDescription: "GLM/Zhipu API Key",
    apiKeyUrl: "https://open.bigmodel.cn/",
    shortcuts: ["glm", "zhipu"],
    shortestPrefix: "glm",
    legacyPrefixes: [
      { prefix: "glm/", stripPrefix: true },
      { prefix: "zhipu/", stripPrefix: true },
    ],
    nativeModelPatterns: [
      { pattern: /^zhipu\//i },
      { pattern: /^glm-/i },
      { pattern: /^chatglm-/i },
    ],
    isDirectApi: true,
  },

  // ── GLM Coding Plan ────────────────────────────────────────────────
  {
    name: "glm-coding",
    displayName: "GLM Coding",
    transport: "openai",
    tokenStrategy: "delta-aware",
    baseUrl: "https://api.z.ai",
    apiPath: "/api/coding/paas/v4/chat/completions",
    apiKeyEnvVar: "GLM_CODING_API_KEY",
    apiKeyAliases: ["ZAI_CODING_API_KEY"],
    apiKeyDescription: "GLM Coding Plan API Key",
    apiKeyUrl: "https://z.ai/subscribe",
    shortcuts: ["gc"],
    shortestPrefix: "gc",
    legacyPrefixes: [{ prefix: "gc/", stripPrefix: true }],
    isDirectApi: true,
  },

  // ── Z.AI (Anthropic-compatible GLM API) ────────────────────────────
  {
    name: "zai",
    displayName: "Z.AI",
    transport: "anthropic",
    baseUrl: "https://api.z.ai",
    baseUrlEnvVars: ["ZAI_BASE_URL"],
    apiPath: "/api/anthropic/v1/messages",
    apiKeyEnvVar: "ZAI_API_KEY",
    apiKeyDescription: "Z.AI API Key",
    apiKeyUrl: "https://z.ai/",
    shortcuts: ["zai"],
    shortestPrefix: "zai",
    legacyPrefixes: [{ prefix: "zai/", stripPrefix: true }],
    nativeModelPatterns: [{ pattern: /^z-ai\//i }, { pattern: /^zai\//i }],
    isDirectApi: true,
  },

  // ── OllamaCloud ────────────────────────────────────────────────────
  {
    name: "ollamacloud",
    displayName: "OllamaCloud",
    transport: "ollamacloud",
    tokenStrategy: "accumulate-both",
    baseUrl: "https://ollama.com",
    baseUrlEnvVars: ["OLLAMACLOUD_BASE_URL"],
    apiPath: "/api/chat",
    apiKeyEnvVar: "OLLAMA_API_KEY",
    apiKeyDescription: "OllamaCloud API Key",
    apiKeyUrl: "https://ollama.com/account",
    shortcuts: ["oc", "llama", "lc", "meta"],
    shortestPrefix: "oc",
    legacyPrefixes: [{ prefix: "oc/", stripPrefix: true }],
    nativeModelPatterns: [
      { pattern: /^ollamacloud\//i },
      { pattern: /^meta-llama\//i },
      { pattern: /^llama-/i },
      { pattern: /^llama3/i },
    ],
    isDirectApi: true,
  },

  // ── OpenCode Zen (free anonymous + paid) ───────────────────────────
  {
    name: "opencode-zen",
    displayName: "OpenCode Zen",
    transport: "openai",
    tokenStrategy: "delta-aware",
    baseUrl: "https://opencode.ai/zen",
    baseUrlEnvVars: ["OPENCODE_BASE_URL"],
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "OPENCODE_API_KEY",
    apiKeyDescription: "OpenCode Zen (Free)",
    apiKeyUrl: "https://opencode.ai/",
    publicKeyFallback: "public",
    shortcuts: ["zen"],
    shortestPrefix: "zen",
    legacyPrefixes: [{ prefix: "zen/", stripPrefix: true }],
    isDirectApi: true,
  },

  // ── OpenCode Zen Go (lite plan) ────────────────────────────────────
  {
    name: "opencode-zen-go",
    displayName: "OpenCode Zen Go",
    transport: "openai",
    tokenStrategy: "delta-aware",
    baseUrl: "https://opencode.ai/zen/go",
    baseUrlEnvVars: ["OPENCODE_BASE_URL"],
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "OPENCODE_API_KEY",
    apiKeyDescription: "OpenCode Zen Go (Lite Plan)",
    apiKeyUrl: "https://opencode.ai/",
    shortcuts: ["zengo", "zgo"],
    shortestPrefix: "zengo",
    legacyPrefixes: [
      { prefix: "zengo/", stripPrefix: true },
      { prefix: "zgo/", stripPrefix: true },
    ],
    isDirectApi: true,
  },

  // ── Vertex AI ──────────────────────────────────────────────────────
  {
    name: "vertex",
    displayName: "Vertex AI",
    transport: "vertex",
    baseUrl: "",
    apiPath: "",
    apiKeyEnvVar: "VERTEX_PROJECT",
    apiKeyAliases: ["VERTEX_API_KEY"],
    apiKeyDescription: "Vertex AI API Key",
    apiKeyUrl: "https://console.cloud.google.com/vertex-ai",
    shortcuts: ["v", "vertex"],
    shortestPrefix: "v",
    legacyPrefixes: [
      { prefix: "v/", stripPrefix: true },
      { prefix: "vertex/", stripPrefix: true },
    ],
    isDirectApi: true,
  },

  // ── LiteLLM ────────────────────────────────────────────────────────
  {
    name: "litellm",
    displayName: "LiteLLM",
    transport: "litellm",
    baseUrl: "",
    baseUrlEnvVars: ["LITELLM_BASE_URL"],
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "LITELLM_API_KEY",
    apiKeyDescription: "LiteLLM API Key",
    apiKeyUrl: "https://docs.litellm.ai/",
    shortcuts: ["litellm", "ll"],
    shortestPrefix: "ll",
    legacyPrefixes: [
      { prefix: "litellm/", stripPrefix: true },
      { prefix: "ll/", stripPrefix: true },
    ],
    isDirectApi: true,
  },

  // ── Poe ────────────────────────────────────────────────────────────
  {
    name: "poe",
    displayName: "Poe",
    transport: "poe",
    baseUrl: "https://api.poe.com",
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "POE_API_KEY",
    apiKeyDescription: "Poe API Key",
    apiKeyUrl: "https://poe.com/api_key",
    shortcuts: ["poe"],
    shortestPrefix: "poe",
    legacyPrefixes: [],
    nativeModelPatterns: [{ pattern: /^poe:/i }],
    isDirectApi: true,
  },

  // ── Ollama (local) ─────────────────────────────────────────────────
  {
    name: "ollama",
    displayName: "Ollama",
    transport: "local",
    baseUrl: "http://localhost:11434",
    apiPath: "/api/chat",
    apiKeyEnvVar: "",
    apiKeyDescription: "Ollama (Local)",
    apiKeyUrl: "",
    shortcuts: ["ollama"],
    shortestPrefix: "ollama",
    legacyPrefixes: [
      { prefix: "ollama/", stripPrefix: true },
      { prefix: "ollama:", stripPrefix: true },
    ],
    isLocal: true,
  },

  // ── LM Studio (local) ──────────────────────────────────────────────
  {
    name: "lmstudio",
    displayName: "LM Studio",
    transport: "local",
    baseUrl: "http://localhost:1234",
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "",
    apiKeyDescription: "LM Studio (Local)",
    apiKeyUrl: "",
    shortcuts: ["lms", "lmstudio", "mlstudio"],
    shortestPrefix: "lms",
    legacyPrefixes: [
      { prefix: "lmstudio/", stripPrefix: true },
      { prefix: "lmstudio:", stripPrefix: true },
      { prefix: "mlstudio/", stripPrefix: true },
      { prefix: "mlstudio:", stripPrefix: true },
    ],
    isLocal: true,
  },

  // ── vLLM (local) ───────────────────────────────────────────────────
  {
    name: "vllm",
    displayName: "vLLM",
    transport: "local",
    baseUrl: "http://localhost:8000",
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "",
    apiKeyDescription: "vLLM (Local)",
    apiKeyUrl: "",
    shortcuts: ["vllm"],
    shortestPrefix: "vllm",
    legacyPrefixes: [
      { prefix: "vllm/", stripPrefix: true },
      { prefix: "vllm:", stripPrefix: true },
    ],
    isLocal: true,
  },

  // ── MLX (local) ────────────────────────────────────────────────────
  {
    name: "mlx",
    displayName: "MLX",
    transport: "local",
    baseUrl: "http://localhost:8080",
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "",
    apiKeyDescription: "MLX (Local)",
    apiKeyUrl: "",
    shortcuts: ["mlx"],
    shortestPrefix: "mlx",
    legacyPrefixes: [
      { prefix: "mlx/", stripPrefix: true },
      { prefix: "mlx:", stripPrefix: true },
    ],
    isLocal: true,
  },

  // ── Qwen (auto-routed, no direct API) ──────────────────────────────
  {
    name: "qwen",
    displayName: "Qwen",
    transport: "openai",
    baseUrl: "",
    apiPath: "",
    apiKeyEnvVar: "",
    apiKeyDescription: "Qwen (auto-routed via OpenRouter)",
    apiKeyUrl: "",
    shortcuts: [],
    shortestPrefix: "qwen",
    legacyPrefixes: [],
    nativeModelPatterns: [{ pattern: /^qwen/i }],
  },

  // ── Native Anthropic (Claude Code auth) ────────────────────────────
  {
    name: "native-anthropic",
    displayName: "Anthropic (Native)",
    transport: "anthropic",
    baseUrl: "",
    apiPath: "",
    apiKeyEnvVar: "",
    apiKeyDescription: "Anthropic (Native Claude Code auth)",
    apiKeyUrl: "",
    shortcuts: [],
    shortestPrefix: "",
    legacyPrefixes: [],
    nativeModelPatterns: [{ pattern: /^anthropic\//i }, { pattern: /^claude-/i }],
  },
];

// ---------------------------------------------------------------------------
// Lazy-cached derived accessors
// ---------------------------------------------------------------------------

let _shortcutsCache: Record<string, string> | null = null;
let _legacyPrefixCache: Array<{
  prefix: string;
  provider: string;
  stripPrefix: boolean;
}> | null = null;
let _nativeModelPatternsCache: Array<{ pattern: RegExp; provider: string }> | null = null;
let _providerByNameCache: Map<string, ProviderDefinition> | null = null;
let _directApiProvidersCache: Set<string> | null = null;
let _localProvidersCache: Set<string> | null = null;

function ensureProviderByNameCache(): Map<string, ProviderDefinition> {
  if (!_providerByNameCache) {
    _providerByNameCache = new Map();
    for (const def of BUILTIN_PROVIDERS) {
      _providerByNameCache.set(def.name, def);
    }
  }
  return _providerByNameCache;
}

/**
 * Get the shortcuts → canonical provider name mapping.
 * Replaces PROVIDER_SHORTCUTS in model-parser.ts.
 */
export function getShortcuts(): Record<string, string> {
  if (!_shortcutsCache) {
    _shortcutsCache = {};
    for (const def of BUILTIN_PROVIDERS) {
      for (const shortcut of def.shortcuts) {
        _shortcutsCache[shortcut] = def.name;
      }
    }
  }
  return _shortcutsCache;
}

/**
 * Get legacy prefix patterns for backwards compatibility.
 * Replaces LEGACY_PREFIX_PATTERNS in model-parser.ts.
 */
export function getLegacyPrefixPatterns(): Array<{
  prefix: string;
  provider: string;
  stripPrefix: boolean;
}> {
  if (!_legacyPrefixCache) {
    _legacyPrefixCache = [];
    for (const def of BUILTIN_PROVIDERS) {
      for (const lp of def.legacyPrefixes) {
        _legacyPrefixCache.push({
          prefix: lp.prefix,
          provider: def.name,
          stripPrefix: lp.stripPrefix,
        });
      }
    }
  }
  return _legacyPrefixCache;
}

/**
 * Get native model patterns for auto-detection.
 * Replaces NATIVE_MODEL_PATTERNS in model-parser.ts.
 *
 * Order follows the definition order in BUILTIN_PROVIDERS.
 * kimi-coding's pattern (kimi-for-coding$) comes before kimi's (kimi-*) because
 * kimi-coding is defined earlier in BUILTIN_PROVIDERS.
 */
export function getNativeModelPatterns(): Array<{ pattern: RegExp; provider: string }> {
  if (!_nativeModelPatternsCache) {
    _nativeModelPatternsCache = [];
    for (const def of BUILTIN_PROVIDERS) {
      if (def.nativeModelPatterns) {
        for (const np of def.nativeModelPatterns) {
          _nativeModelPatternsCache.push({
            pattern: np.pattern,
            provider: def.name,
          });
        }
      }
    }
  }
  return _nativeModelPatternsCache;
}

/**
 * Get a provider definition by canonical name.
 */
export function getProviderByName(name: string): ProviderDefinition | undefined {
  return ensureProviderByNameCache().get(name);
}

/**
 * Get API key info for a provider.
 * Replaces API_KEY_INFO in provider-resolver.ts.
 */
export function getApiKeyInfo(
  providerName: string
): {
  envVar: string;
  description: string;
  url: string;
  aliases?: string[];
  oauthFallback?: string;
} | null {
  const def = getProviderByName(providerName);
  if (!def) return null;
  return {
    envVar: def.apiKeyEnvVar,
    description: def.apiKeyDescription,
    url: def.apiKeyUrl,
    aliases: def.apiKeyAliases,
    oauthFallback: def.oauthFallback,
  };
}

/**
 * Get display name for a provider.
 * Replaces PROVIDER_DISPLAY_NAMES in provider-resolver.ts.
 */
export function getDisplayName(providerName: string): string {
  const def = getProviderByName(providerName);
  return def?.displayName || providerName.charAt(0).toUpperCase() + providerName.slice(1);
}

/**
 * Get the effective base URL for a provider, respecting env var overrides.
 */
export function getEffectiveBaseUrl(def: ProviderDefinition): string {
  if (def.baseUrlEnvVars) {
    for (const envVar of def.baseUrlEnvVars) {
      const value = process.env[envVar];
      if (value) return value;
    }
  }
  return def.baseUrl;
}

/**
 * Check if a provider name is a local provider (no API key needed).
 * Replaces LOCAL_PROVIDERS set in model-parser.ts.
 */
export function isLocalTransport(providerName: string): boolean {
  if (!_localProvidersCache) {
    _localProvidersCache = new Set();
    for (const def of BUILTIN_PROVIDERS) {
      if (def.isLocal) {
        _localProvidersCache.add(def.name);
      }
    }
  }
  return _localProvidersCache.has(providerName.toLowerCase());
}

/**
 * Check if a provider supports direct API access.
 * Replaces DIRECT_API_PROVIDERS set in model-parser.ts.
 */
export function isDirectApiProvider(providerName: string): boolean {
  if (!_directApiProvidersCache) {
    _directApiProvidersCache = new Set();
    for (const def of BUILTIN_PROVIDERS) {
      if (def.isDirectApi) {
        _directApiProvidersCache.add(def.name);
      }
    }
  }
  return _directApiProvidersCache.has(providerName.toLowerCase());
}

/**
 * Convert a ProviderDefinition to the RemoteProvider shape used by existing consumers.
 */
export function toRemoteProvider(def: ProviderDefinition): RemoteProvider {
  const baseUrl = getEffectiveBaseUrl(def);

  // Handle opencode-zen-go special case: transform base URL
  let effectiveBaseUrl = baseUrl;
  if (def.name === "opencode-zen-go" && def.baseUrlEnvVars) {
    const envOverride = process.env[def.baseUrlEnvVars[0]];
    if (envOverride) {
      effectiveBaseUrl = envOverride.replace("/zen", "/zen/go");
    }
  }

  return {
    name: def.name === "google" ? "gemini" : def.name,
    baseUrl: effectiveBaseUrl,
    apiPath: def.apiPath,
    apiKeyEnvVar: def.apiKeyEnvVar,
    prefixes: def.legacyPrefixes.map((lp) => lp.prefix),
    headers: def.headers,
    authScheme: def.authScheme,
  };
}

/**
 * Get all provider definitions.
 */
export function getAllProviders(): ProviderDefinition[] {
  return BUILTIN_PROVIDERS;
}

/**
 * Get the shortest prefix for a provider (for @ syntax handler creation).
 * Replaces PROVIDER_TO_PREFIX in auto-route.ts.
 */
export function getShortestPrefix(providerName: string): string {
  const def = getProviderByName(providerName);
  return def?.shortestPrefix || providerName;
}

/**
 * Get API key env var info for a provider (for auto-route).
 * Replaces API_KEY_ENV_VARS in auto-route.ts.
 */
export function getApiKeyEnvVars(
  providerName: string
): { envVar: string; aliases?: string[] } | null {
  const def = getProviderByName(providerName);
  if (!def) return null;
  return {
    envVar: def.apiKeyEnvVar,
    aliases: def.apiKeyAliases,
  };
}
