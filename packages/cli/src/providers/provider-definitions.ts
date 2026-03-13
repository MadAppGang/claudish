/**
 * Provider Definitions: Single Source of Truth
 *
 * Every provider (builtin or user-defined) is described by a ProviderDefinition.
 * All other modules derive their constants from this array via lazy-cached accessors.
 *
 * To add a new builtin provider: add an entry to BUILTIN_PROVIDERS below.
 * To add a user-defined provider: add it to ~/.claudish/config.json under "providers".
 */

import type { ProviderCapabilities, TransportType } from "../handlers/shared/remote-provider-types.js";
import type { UserProviderConfig } from "../profile-config.js";

// Re-export TransportType so existing consumers don't break
export type { TransportType } from "../handlers/shared/remote-provider-types.js";

// ─── ProviderDefinition ──────────────────────────────────

export interface ProviderDefinition {
  /** Canonical name, the key used everywhere internally ("google", not "gemini") */
  name: string;
  /** Human-readable display name ("Gemini", "GitHub Models") */
  displayName: string;
  /** Which transport/handler to construct */
  transport: TransportType;
  /** Token counting strategy for ProviderHandler */
  tokenStrategy?: "delta-aware" | "accumulate-both";

  /** Base URL for the API */
  baseUrl: string;
  /** Env vars that override baseUrl (checked in order) */
  baseUrlEnvVars?: string[];
  /** API path template (may contain {model} placeholder) */
  apiPath: string;

  /** Primary env var for API key ("" = no key needed) */
  apiKeyEnvVar: string;
  /** Alternative env vars that also satisfy the key requirement */
  apiKeyAliases?: string[];
  /** Human-readable key description */
  apiKeyDescription?: string;
  /** URL where user can obtain the key */
  apiKeyUrl?: string;
  /** Auth header scheme */
  authScheme: "bearer" | "x-api-key" | "none";

  /** Shortcut names that expand to this provider in @ syntax (e.g., ["g", "gemini"]) */
  shortcuts: string[];
  /** Legacy prefix patterns (e.g., ["g/", "gemini/"]) */
  legacyPrefixes: string[];
  /** Auto-detect provider from bare model name (e.g., /^gemini-/i) */
  nativeModelPatterns?: RegExp[];

  /** Provider capabilities */
  capabilities: ProviderCapabilities;
  /** Extra HTTP headers to send with every request */
  headers?: Record<string, string>;

  /** When true, use "public" as API key when none is set (zen free tier) */
  publicKeyFallback?: boolean;
  /** OAuth credential file under ~/.claudish/ to check as auth fallback */
  oauthFallback?: string;

  /** Whether this provider was loaded from user config */
  isUserDefined?: boolean;
}

// ─── Builtin Providers ───────────────────────────────────

export const BUILTIN_PROVIDERS: ProviderDefinition[] = [
  // ── Google Gemini (API key) ──
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
    authScheme: "bearer",
    shortcuts: ["g", "gemini"],
    legacyPrefixes: ["g/", "gemini/"],
    nativeModelPatterns: [/^google\//i, /^gemini-/i],
    capabilities: {
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      supportsJsonMode: false,
      supportsReasoning: true,
    },
  },

  // ── Gemini Code Assist (OAuth) ──
  {
    name: "gemini-codeassist",
    displayName: "Gemini Code Assist",
    transport: "gemini-oauth",
    baseUrl: "https://cloudcode-pa.googleapis.com",
    apiPath: "/v1internal:streamGenerateContent?alt=sse",
    apiKeyEnvVar: "",
    apiKeyDescription: "Gemini Code Assist (OAuth)",
    apiKeyUrl: "https://cloud.google.com/code-assist",
    authScheme: "none",
    shortcuts: ["go"],
    legacyPrefixes: ["go/"],
    capabilities: {
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      supportsJsonMode: false,
      supportsReasoning: true,
    },
  },

  // ── OpenAI ──
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
    authScheme: "bearer",
    shortcuts: ["oai"],
    legacyPrefixes: ["oai/"],
    nativeModelPatterns: [/^openai\//i, /^gpt-/i, /^o1(-|$)/i, /^o3(-|$)/i, /^chatgpt-/i],
    capabilities: {
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      supportsJsonMode: true,
      supportsReasoning: true,
    },
  },

  // ── OpenRouter ──
  {
    name: "openrouter",
    displayName: "OpenRouter",
    transport: "openrouter",
    baseUrl: "https://openrouter.ai",
    apiPath: "/api/v1/chat/completions",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
    apiKeyDescription: "OpenRouter API Key",
    apiKeyUrl: "https://openrouter.ai/keys",
    authScheme: "bearer",
    shortcuts: ["or"],
    legacyPrefixes: ["or/"],
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

  // ── MiniMax ──
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
    legacyPrefixes: ["mmax/", "mm/"],
    nativeModelPatterns: [/^minimax\//i, /^minimax-/i, /^abab-/i],
    capabilities: {
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      supportsJsonMode: false,
      supportsReasoning: false,
    },
  },

  // ── MiniMax Coding ──
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
    legacyPrefixes: ["mmc/"],
    capabilities: {
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      supportsJsonMode: false,
      supportsReasoning: false,
    },
  },

  // ── Kimi / Moonshot ──
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
    authScheme: "bearer",
    shortcuts: ["kimi", "moon", "moonshot"],
    legacyPrefixes: ["kimi/", "moonshot/"],
    nativeModelPatterns: [/^moonshot(ai)?\//i, /^moonshot-/i, /^kimi-/i],
    capabilities: {
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      supportsJsonMode: false,
      supportsReasoning: true,
    },
  },

  // ── Kimi Coding ──
  {
    name: "kimi-coding",
    displayName: "Kimi Coding",
    transport: "anthropic",
    baseUrl: "https://api.kimi.com/coding/v1",
    apiPath: "/messages",
    apiKeyEnvVar: "KIMI_CODING_API_KEY",
    apiKeyDescription: "Kimi Coding API Key",
    apiKeyUrl: "https://kimi.com/code (get key from membership page, or run: claudish --kimi-login)",
    authScheme: "bearer",
    oauthFallback: "kimi-oauth.json",
    shortcuts: ["kc"],
    legacyPrefixes: ["kc/"],
    nativeModelPatterns: [/^kimi-for-coding$/i],
    capabilities: {
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      supportsJsonMode: false,
      supportsReasoning: true,
    },
  },

  // ── GLM / Zhipu ──
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
    authScheme: "bearer",
    shortcuts: ["glm", "zhipu"],
    legacyPrefixes: ["glm/", "zhipu/"],
    nativeModelPatterns: [/^zhipu\//i, /^glm-/i, /^chatglm-/i],
    capabilities: {
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      supportsJsonMode: true,
      supportsReasoning: true,
    },
  },

  // ── GLM Coding Plan ──
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
    authScheme: "bearer",
    shortcuts: ["gc"],
    legacyPrefixes: ["gc/"],
    capabilities: {
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
      supportsJsonMode: true,
      supportsReasoning: true,
    },
  },

  // ── Z.AI ──
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
    authScheme: "bearer",
    shortcuts: ["zai"],
    legacyPrefixes: ["zai/"],
    nativeModelPatterns: [/^z-ai\//i, /^zai\//i],
    capabilities: {
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      supportsJsonMode: true,
      supportsReasoning: true,
    },
  },

  // ── OllamaCloud ──
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
    authScheme: "bearer",
    shortcuts: ["oc", "llama", "lc", "meta"],
    legacyPrefixes: ["oc/"],
    nativeModelPatterns: [/^ollamacloud\//i, /^meta-llama\//i, /^llama-/i, /^llama3/i],
    capabilities: {
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
      supportsJsonMode: false,
      supportsReasoning: false,
    },
  },

  // ── OpenCode Zen ──
  {
    name: "opencode-zen",
    displayName: "OpenCode Zen",
    transport: "zen",
    baseUrl: "https://opencode.ai/zen",
    baseUrlEnvVars: ["OPENCODE_BASE_URL"],
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "OPENCODE_API_KEY",
    apiKeyDescription: "OpenCode Zen (Free)",
    apiKeyUrl: "https://opencode.ai/",
    authScheme: "bearer",
    publicKeyFallback: true,
    shortcuts: ["zen"],
    legacyPrefixes: ["zen/"],
    capabilities: {
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
      supportsJsonMode: true,
      supportsReasoning: false,
    },
  },

  // ── OpenCode Zen Go ──
  {
    name: "opencode-zen-go",
    displayName: "OpenCode Zen Go",
    transport: "zen",
    baseUrl: "https://opencode.ai/zen/go",
    baseUrlEnvVars: ["OPENCODE_BASE_URL"],
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "OPENCODE_API_KEY",
    apiKeyDescription: "OpenCode Zen Go",
    apiKeyUrl: "https://opencode.ai/",
    authScheme: "bearer",
    publicKeyFallback: true,
    shortcuts: ["zengo", "zgo"],
    legacyPrefixes: ["zengo/", "zgo/"],
    capabilities: {
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
      supportsJsonMode: true,
      supportsReasoning: true,
    },
  },

  // ── Vertex AI ──
  {
    name: "vertex",
    displayName: "Vertex AI",
    transport: "vertex",
    baseUrl: "",
    apiPath: "",
    apiKeyEnvVar: "VERTEX_API_KEY",
    apiKeyAliases: ["VERTEX_PROJECT"],
    apiKeyDescription: "Vertex AI API Key",
    apiKeyUrl: "https://console.cloud.google.com/vertex-ai",
    authScheme: "bearer",
    shortcuts: ["v", "vertex"],
    legacyPrefixes: ["v/", "vertex/"],
    capabilities: {
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      supportsJsonMode: false,
      supportsReasoning: true,
    },
  },

  // ── LiteLLM ──
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
    authScheme: "bearer",
    shortcuts: ["litellm", "ll"],
    legacyPrefixes: ["litellm/", "ll/"],
    capabilities: {
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      supportsJsonMode: true,
      supportsReasoning: true,
    },
  },

  // ── Poe ──
  {
    name: "poe",
    displayName: "Poe",
    transport: "openai",
    baseUrl: "https://api.poe.com",
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "POE_API_KEY",
    apiKeyDescription: "Poe API Key",
    apiKeyUrl: "https://poe.com/api_key",
    authScheme: "bearer",
    shortcuts: ["poe"],
    legacyPrefixes: [],
    nativeModelPatterns: [/^poe:/i],
    capabilities: {
      supportsTools: true,
      supportsVision: true,
      supportsStreaming: true,
      supportsJsonMode: false,
      supportsReasoning: false,
    },
  },

  // ── Local: Ollama ──
  {
    name: "ollama",
    displayName: "Ollama",
    transport: "ollama",
    baseUrl: "http://localhost:11434",
    baseUrlEnvVars: ["OLLAMA_HOST", "OLLAMA_BASE_URL"],
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "",
    authScheme: "none",
    shortcuts: ["ollama"],
    legacyPrefixes: ["ollama/", "ollama:"],
    capabilities: {
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
      supportsJsonMode: true,
      supportsReasoning: false,
    },
  },

  // ── Local: LM Studio ──
  {
    name: "lmstudio",
    displayName: "LM Studio",
    transport: "local",
    baseUrl: "http://localhost:1234",
    baseUrlEnvVars: ["LMSTUDIO_BASE_URL"],
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "",
    authScheme: "none",
    shortcuts: ["lms", "lmstudio", "mlstudio"],
    legacyPrefixes: ["lmstudio/", "lmstudio:", "mlstudio/", "mlstudio:"],
    capabilities: {
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
      supportsJsonMode: true,
      supportsReasoning: false,
    },
  },

  // ── Local: vLLM ──
  {
    name: "vllm",
    displayName: "vLLM",
    transport: "local",
    baseUrl: "http://localhost:8000",
    baseUrlEnvVars: ["VLLM_BASE_URL"],
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "",
    authScheme: "none",
    shortcuts: ["vllm"],
    legacyPrefixes: ["vllm/", "vllm:"],
    capabilities: {
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
      supportsJsonMode: true,
      supportsReasoning: false,
    },
  },

  // ── Local: MLX ──
  {
    name: "mlx",
    displayName: "MLX",
    transport: "local",
    baseUrl: "http://127.0.0.1:8080",
    baseUrlEnvVars: ["MLX_BASE_URL"],
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "",
    authScheme: "none",
    shortcuts: ["mlx"],
    legacyPrefixes: ["mlx/", "mlx:"],
    capabilities: {
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
      supportsJsonMode: true,
      supportsReasoning: false,
    },
  },
];

// ─── Lazy-Cached Derived Accessors ───────────────────────

let _shortcutsCache: Record<string, string> | null = null;
let _legacyPrefixCache: Array<{ prefix: string; provider: string; stripPrefix: boolean }> | null = null;
let _nativeModelCache: Array<{ pattern: RegExp; provider: string }> | null = null;
let _byNameCache: Map<string, ProviderDefinition> | null = null;
let _allProviders: ProviderDefinition[] | null = null;

/**
 * All providers (builtin + user-defined). User providers loaded lazily.
 */
export function getAllProviders(): ProviderDefinition[] {
  if (_allProviders) return _allProviders;
  _allProviders = [...BUILTIN_PROVIDERS, ...loadUserProviders()];
  return _allProviders;
}

/** Provider shortcut map: short name -> canonical provider name. */
export function getShortcuts(): Record<string, string> {
  if (_shortcutsCache) return _shortcutsCache;
  const map: Record<string, string> = {};
  for (const def of getAllProviders()) {
    for (const s of def.shortcuts) {
      map[s] = def.name;
    }
  }
  _shortcutsCache = map;
  return map;
}

/** Legacy prefix patterns derived from all provider definitions. */
export function getLegacyPrefixPatterns(): Array<{ prefix: string; provider: string; stripPrefix: boolean }> {
  if (_legacyPrefixCache) return _legacyPrefixCache;
  const patterns: Array<{ prefix: string; provider: string; stripPrefix: boolean }> = [];
  for (const def of getAllProviders()) {
    for (const prefix of def.legacyPrefixes) {
      patterns.push({ prefix, provider: def.name, stripPrefix: true });
    }
  }
  _legacyPrefixCache = patterns;
  return patterns;
}

/**
 * Native model patterns for auto-detection. Order preserved from BUILTIN_PROVIDERS.
 * Includes hardcoded patterns for qwen (auto-routed) and anthropic (native).
 */
export function getNativeModelPatterns(): Array<{ pattern: RegExp; provider: string }> {
  if (_nativeModelCache) return _nativeModelCache;
  const patterns: Array<{ pattern: RegExp; provider: string }> = [];
  for (const def of getAllProviders()) {
    if (def.nativeModelPatterns) {
      for (const pattern of def.nativeModelPatterns) {
        patterns.push({ pattern, provider: def.name });
      }
    }
  }
  // Non-provider-backed patterns (no ProviderDefinition for these)
  patterns.push({ pattern: /^qwen/i, provider: "qwen" });
  patterns.push({ pattern: /^anthropic\//i, provider: "native-anthropic" });
  patterns.push({ pattern: /^claude-/i, provider: "native-anthropic" });
  _nativeModelCache = patterns;
  return patterns;
}

/** Check if a provider name maps to a local transport. */
export function isLocalTransport(providerName: string): boolean {
  const def = getProviderByName(providerName);
  return def?.transport === "local" || def?.transport === "ollama";
}

/** Look up a provider definition by canonical name. */
export function getProviderByName(name: string): ProviderDefinition | undefined {
  if (!_byNameCache) {
    _byNameCache = new Map();
    for (const def of getAllProviders()) {
      _byNameCache.set(def.name, def);
    }
  }
  return _byNameCache.get(name);
}

/** API key info for a provider. Returns undefined for unknown providers. */
export function getApiKeyInfo(providerName: string): {
  envVar: string;
  description: string;
  url: string;
  aliases?: string[];
  oauthFallback?: string;
} | undefined {
  const def = getProviderByName(providerName);
  if (!def) return undefined;
  return {
    envVar: def.apiKeyEnvVar,
    description: def.apiKeyDescription || `${def.displayName} API Key`,
    url: def.apiKeyUrl || "",
    aliases: def.apiKeyAliases,
    oauthFallback: def.oauthFallback,
  };
}

/** Display name for a provider. Falls back to capitalized provider name. */
export function getDisplayName(providerName: string): string {
  const def = getProviderByName(providerName);
  if (def) return def.displayName;
  return providerName.charAt(0).toUpperCase() + providerName.slice(1);
}

/** Resolve the effective base URL for a provider (checking env var overrides). */
export function getEffectiveBaseUrl(def: ProviderDefinition): string {
  if (def.baseUrlEnvVars) {
    for (const envVar of def.baseUrlEnvVars) {
      const val = process.env[envVar];
      if (val) return val;
    }
  }
  return def.baseUrl;
}

/**
 * Build a RemoteProvider-shaped object from a ProviderDefinition.
 * Existing transport constructors accept this shape.
 */
export function toRemoteProvider(def: ProviderDefinition): {
  name: string;
  baseUrl: string;
  apiPath: string;
  apiKeyEnvVar: string;
  prefixes: string[];
  capabilities: ProviderCapabilities;
  headers?: Record<string, string>;
  authScheme?: "x-api-key" | "bearer";
} {
  return {
    name: def.name,
    baseUrl: getEffectiveBaseUrl(def),
    apiPath: def.apiPath,
    apiKeyEnvVar: def.apiKeyEnvVar,
    prefixes: def.legacyPrefixes,
    capabilities: def.capabilities,
    headers: def.headers,
    authScheme: def.authScheme === "none" ? undefined : def.authScheme as "x-api-key" | "bearer",
  };
}

// ─── User-Defined Providers ──────────────────────────────

let _userProvidersLoaded = false;
let _userProviders: ProviderDefinition[] = [];

/**
 * Load user-defined providers from ~/.claudish/config.json.
 * Returns empty array if none defined or file doesn't exist.
 */
export function loadUserProviders(): ProviderDefinition[] {
  if (_userProvidersLoaded) return _userProviders;
  _userProvidersLoaded = true;

  try {
    const { existsSync, readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const { homedir } = require("node:os");

    const configPath = join(homedir(), ".claudish", "config.json");
    if (!existsSync(configPath)) return _userProviders;

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!config.providers || typeof config.providers !== "object") return _userProviders;

    for (const [name, rawCfg] of Object.entries(config.providers)) {
      const cfg = rawCfg as UserProviderConfig;
      const def: ProviderDefinition = {
        name,
        displayName: cfg.displayName || name.charAt(0).toUpperCase() + name.slice(1),
        transport: cfg.transport || "openai",
        tokenStrategy: cfg.tokenStrategy,
        baseUrl: cfg.baseUrl || "",
        apiPath: cfg.apiPath || "/v1/chat/completions",
        apiKeyEnvVar: cfg.apiKeyEnvVar || "",
        apiKeyAliases: cfg.apiKeyAliases,
        apiKeyDescription: cfg.apiKeyDescription || `${cfg.displayName || name} API Key`,
        apiKeyUrl: cfg.apiKeyUrl || "",
        authScheme: cfg.authScheme || "bearer",
        shortcuts: cfg.shortcuts || [name],
        legacyPrefixes: cfg.legacyPrefixes || [],
        nativeModelPatterns: cfg.nativeModelPatterns
          ? cfg.nativeModelPatterns.map((p) => new RegExp(p, "i"))
          : undefined,
        headers: cfg.headers,
        publicKeyFallback: cfg.publicKeyFallback,
        capabilities: {
          supportsTools: cfg.capabilities?.supportsTools ?? true,
          supportsVision: cfg.capabilities?.supportsVision ?? true,
          supportsStreaming: cfg.capabilities?.supportsStreaming ?? true,
          supportsJsonMode: cfg.capabilities?.supportsJsonMode ?? true,
          supportsReasoning: cfg.capabilities?.supportsReasoning ?? true,
        },
        isUserDefined: true,
      };
      _userProviders.push(def);
    }
  } catch {
    // Silently ignore config load errors
  }

  return _userProviders;
}

