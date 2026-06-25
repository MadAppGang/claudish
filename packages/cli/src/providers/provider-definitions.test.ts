/**
 * Tests for provider-definitions.ts — single source of truth for provider identity.
 *
 * Run: bun test packages/cli/src/providers/provider-definitions.test.ts
 */

import { describe, test, expect } from "bun:test";
import {
  BUILTIN_PROVIDERS,
  getShortcuts,
  getLegacyPrefixPatterns,
  getNativeModelPatterns,
  getProviderByName,
  getApiKeyInfo,
  getDisplayName,
  getEffectiveBaseUrl,
  isLocalTransport,
  isDirectApiProvider,
  toRemoteProvider,
  getAllProviders,
  getShortestPrefix,
  getApiKeyEnvVars,
  isProviderAvailable,
  type ProviderDefinition,
} from "./provider-definitions.js";

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

describe("BUILTIN_PROVIDERS structural integrity", () => {
  test("every provider has required fields", () => {
    for (const def of BUILTIN_PROVIDERS) {
      expect(def.name).toBeTruthy();
      expect(typeof def.name).toBe("string");
      expect(def.displayName).toBeTruthy();
      expect(typeof def.displayName).toBe("string");
      expect(def.transport).toBeTruthy();
      expect(typeof def.apiKeyEnvVar).toBe("string");
      expect(typeof def.apiKeyDescription).toBe("string");
      expect(typeof def.apiKeyUrl).toBe("string");
      expect(Array.isArray(def.shortcuts)).toBe(true);
      expect(Array.isArray(def.legacyPrefixes)).toBe(true);
    }
  });

  test("no duplicate provider names", () => {
    const names = BUILTIN_PROVIDERS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("no duplicate shortcuts across providers", () => {
    const allShortcuts: string[] = [];
    for (const def of BUILTIN_PROVIDERS) {
      for (const s of def.shortcuts) {
        expect(allShortcuts).not.toContain(s);
        allShortcuts.push(s);
      }
    }
  });

  test("no duplicate legacy prefixes across providers", () => {
    const allPrefixes: string[] = [];
    for (const def of BUILTIN_PROVIDERS) {
      for (const lp of def.legacyPrefixes) {
        expect(allPrefixes).not.toContain(lp.prefix);
        allPrefixes.push(lp.prefix);
      }
    }
  });

  test("local providers are marked isLocal", () => {
    const localProviders = BUILTIN_PROVIDERS.filter((d) => d.isLocal);
    const localNames = localProviders.map((d) => d.name);
    expect(localNames).toContain("ollama");
    expect(localNames).toContain("lmstudio");
    expect(localNames).toContain("vllm");
    expect(localNames).toContain("mlx");
  });

  test("direct API providers are marked isDirectApi", () => {
    const directProviders = BUILTIN_PROVIDERS.filter((d) => d.isDirectApi);
    const directNames = directProviders.map((d) => d.name);
    expect(directNames).toContain("google");
    expect(directNames).toContain("openai");
    expect(directNames).toContain("minimax");
    expect(directNames).toContain("kimi");
    expect(directNames).toContain("glm");
    expect(directNames).toContain("openrouter");
  });
});

// ---------------------------------------------------------------------------
// getShortcuts
// ---------------------------------------------------------------------------

describe("getShortcuts", () => {
  const shortcuts = getShortcuts();

  test("maps 'g' to 'google'", () => {
    expect(shortcuts["g"]).toBe("google");
  });

  test("maps 'gemini' to 'google'", () => {
    expect(shortcuts["gemini"]).toBe("google");
  });

  test("maps 'oai' to 'openai'", () => {
    expect(shortcuts["oai"]).toBe("openai");
  });

  test("maps 'or' to 'openrouter'", () => {
    expect(shortcuts["or"]).toBe("openrouter");
  });

  test("maps 'mm' to 'minimax'", () => {
    expect(shortcuts["mm"]).toBe("minimax");
  });

  test("maps 'kimi' to 'kimi'", () => {
    expect(shortcuts["kimi"]).toBe("kimi");
  });

  test("maps 'glm' to 'glm'", () => {
    expect(shortcuts["glm"]).toBe("glm");
  });

  test("maps local provider shortcuts", () => {
    expect(shortcuts["ollama"]).toBe("ollama");
    expect(shortcuts["lms"]).toBe("lmstudio");
    expect(shortcuts["vllm"]).toBe("vllm");
    expect(shortcuts["mlx"]).toBe("mlx");
  });

  test("maps 'poe' to 'poe'", () => {
    expect(shortcuts["poe"]).toBe("poe");
  });

  test("maps 'litellm' to 'litellm'", () => {
    expect(shortcuts["litellm"]).toBe("litellm");
    expect(shortcuts["ll"]).toBe("litellm");
  });
});

// ---------------------------------------------------------------------------
// getLegacyPrefixPatterns
// ---------------------------------------------------------------------------

describe("getLegacyPrefixPatterns", () => {
  const patterns = getLegacyPrefixPatterns();

  test("includes 'g/' for google", () => {
    const gPattern = patterns.find((p) => p.prefix === "g/");
    expect(gPattern).toBeDefined();
    expect(gPattern!.provider).toBe("google");
    expect(gPattern!.stripPrefix).toBe(true);
  });

  test("includes local provider prefixes", () => {
    const ollamaSlash = patterns.find((p) => p.prefix === "ollama/");
    expect(ollamaSlash).toBeDefined();
    expect(ollamaSlash!.provider).toBe("ollama");

    const ollamaColon = patterns.find((p) => p.prefix === "ollama:");
    expect(ollamaColon).toBeDefined();
    expect(ollamaColon!.provider).toBe("ollama");
  });

  test("has all legacy patterns from all providers", () => {
    expect(patterns.length).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// getNativeModelPatterns
// ---------------------------------------------------------------------------

describe("getNativeModelPatterns", () => {
  const patterns = getNativeModelPatterns();

  test("gemini-* matches google", () => {
    const match = patterns.find((p) => p.pattern.test("gemini-2.0-flash"));
    expect(match).toBeDefined();
    expect(match!.provider).toBe("google");
  });

  test("gpt-* matches openai", () => {
    const match = patterns.find((p) => p.pattern.test("gpt-4o"));
    expect(match).toBeDefined();
    expect(match!.provider).toBe("openai");
  });

  test("kimi-for-coding matches kimi-coding (before general kimi-*)", () => {
    const match = patterns.find((p) => p.pattern.test("kimi-for-coding"));
    expect(match).toBeDefined();
    expect(match!.provider).toBe("kimi-coding");
  });

  test("kimi-k2 matches kimi", () => {
    const match = patterns.find((p) => p.pattern.test("kimi-k2"));
    expect(match).toBeDefined();
    expect(match!.provider).toBe("kimi");
  });

  test("claude-3-opus matches native-anthropic", () => {
    const match = patterns.find((p) => p.pattern.test("claude-3-opus-20240229"));
    expect(match).toBeDefined();
    expect(match!.provider).toBe("native-anthropic");
  });

  test("qwen matches qwen", () => {
    const match = patterns.find((p) => p.pattern.test("qwen3-coder-next"));
    expect(match).toBeDefined();
    expect(match!.provider).toBe("qwen");
  });
});

// ---------------------------------------------------------------------------
// getProviderByName
// ---------------------------------------------------------------------------

describe("getProviderByName", () => {
  test("finds google", () => {
    const def = getProviderByName("google");
    expect(def).toBeDefined();
    expect(def!.displayName).toBe("Gemini");
  });

  test("returns undefined for unknown provider", () => {
    expect(getProviderByName("nonexistent")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getApiKeyInfo
// ---------------------------------------------------------------------------

describe("getApiKeyInfo", () => {
  test("returns correct info for google", () => {
    const info = getApiKeyInfo("google");
    expect(info).toBeDefined();
    expect(info!.envVar).toBe("GEMINI_API_KEY");
    expect(info!.url).toContain("aistudio.google.com");
  });

  test("returns aliases for kimi", () => {
    const info = getApiKeyInfo("kimi");
    expect(info).toBeDefined();
    expect(info!.aliases).toContain("KIMI_API_KEY");
  });

  test("returns oauthFallback for kimi-coding", () => {
    const info = getApiKeyInfo("kimi-coding");
    expect(info).toBeDefined();
    expect(info!.oauthFallback).toBe("kimi-oauth.json");
  });

  test("returns null for unknown provider", () => {
    expect(getApiKeyInfo("nonexistent")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getDisplayName
// ---------------------------------------------------------------------------

describe("getDisplayName", () => {
  test("returns proper display names", () => {
    expect(getDisplayName("google")).toBe("Gemini");
    expect(getDisplayName("openai")).toBe("OpenAI");
    expect(getDisplayName("minimax")).toBe("MiniMax");
    expect(getDisplayName("ollamacloud")).toBe("OllamaCloud");
    expect(getDisplayName("opencode-zen")).toBe("OpenCode Zen");
  });

  test("capitalizes unknown provider names", () => {
    expect(getDisplayName("unknown")).toBe("Unknown");
  });
});

// ---------------------------------------------------------------------------
// getEffectiveBaseUrl
// ---------------------------------------------------------------------------

describe("getEffectiveBaseUrl", () => {
  test("returns default base URL when no env override", () => {
    const def = getProviderByName("google")!;
    // Without GEMINI_BASE_URL set, should return the default
    const url = getEffectiveBaseUrl(def);
    expect(url).toBe(process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com");
  });

  test("returns base URL for provider without env overrides", () => {
    const def = getProviderByName("openrouter")!;
    expect(getEffectiveBaseUrl(def)).toBe("https://openrouter.ai");
  });

  test("minimax (mm@) default baseUrl is minimaxi.com, not minimax.io", () => {
    const def = getProviderByName("minimax")!;
    expect(def.baseUrl).toBe("https://api.minimaxi.com");
  });

  test("minimax-coding (mmc@) default baseUrl remains minimax.io", () => {
    const def = getProviderByName("minimax-coding")!;
    expect(def.baseUrl).toBe("https://api.minimax.io");
  });
});

// ---------------------------------------------------------------------------
// isLocalTransport / isDirectApiProvider
// ---------------------------------------------------------------------------

describe("isLocalTransport", () => {
  test("returns true for local providers", () => {
    expect(isLocalTransport("ollama")).toBe(true);
    expect(isLocalTransport("lmstudio")).toBe(true);
    expect(isLocalTransport("vllm")).toBe(true);
    expect(isLocalTransport("mlx")).toBe(true);
  });

  test("returns false for remote providers", () => {
    expect(isLocalTransport("google")).toBe(false);
    expect(isLocalTransport("openrouter")).toBe(false);
  });
});

describe("isDirectApiProvider", () => {
  test("returns true for direct API providers", () => {
    expect(isDirectApiProvider("google")).toBe(true);
    expect(isDirectApiProvider("openai")).toBe(true);
    expect(isDirectApiProvider("minimax")).toBe(true);
    expect(isDirectApiProvider("poe")).toBe(true);
    expect(isDirectApiProvider("litellm")).toBe(true);
  });

  test("returns false for non-direct providers", () => {
    expect(isDirectApiProvider("ollama")).toBe(false);
    expect(isDirectApiProvider("unknown")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toRemoteProvider
// ---------------------------------------------------------------------------

describe("toRemoteProvider", () => {
  test("produces valid RemoteProvider for each non-local provider", () => {
    for (const def of BUILTIN_PROVIDERS) {
      if (def.isLocal || def.name === "qwen" || def.name === "native-anthropic") continue;

      const rp = toRemoteProvider(def);
      expect(rp.name).toBeTruthy();
      expect(typeof rp.baseUrl).toBe("string");
      expect(typeof rp.apiPath).toBe("string");
      expect(typeof rp.apiKeyEnvVar).toBe("string");
      expect(Array.isArray(rp.prefixes)).toBe(true);
    }
  });

  test("google maps to 'gemini' for RemoteProvider.name (backwards compat)", () => {
    const def = getProviderByName("google")!;
    const rp = toRemoteProvider(def);
    expect(rp.name).toBe("gemini");
  });

  test("preserves custom headers", () => {
    const def = getProviderByName("openrouter")!;
    const rp = toRemoteProvider(def);
    expect(rp.headers).toBeDefined();
    expect(rp.headers!["HTTP-Referer"]).toBe("https://claudish.com");
  });

  test("preserves authScheme", () => {
    const def = getProviderByName("minimax")!;
    const rp = toRemoteProvider(def);
    expect(rp.authScheme).toBe("bearer");
  });
});

// ---------------------------------------------------------------------------
// getShortestPrefix / getApiKeyEnvVars
// ---------------------------------------------------------------------------

describe("getShortestPrefix", () => {
  test("returns shortest prefix for known providers", () => {
    expect(getShortestPrefix("google")).toBe("g");
    expect(getShortestPrefix("minimax")).toBe("mm");
    expect(getShortestPrefix("openrouter")).toBe("or");
  });

  test("falls back to provider name for unknown", () => {
    expect(getShortestPrefix("unknown")).toBe("unknown");
  });
});

describe("getApiKeyEnvVars", () => {
  test("returns env var info for known providers", () => {
    const info = getApiKeyEnvVars("google");
    expect(info).toBeDefined();
    expect(info!.envVar).toBe("GEMINI_API_KEY");
  });

  test("returns aliases when available", () => {
    const info = getApiKeyEnvVars("kimi");
    expect(info).toBeDefined();
    expect(info!.aliases).toContain("KIMI_API_KEY");
  });

  test("returns null for unknown provider", () => {
    expect(getApiKeyEnvVars("nonexistent")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isProviderAvailable
// ---------------------------------------------------------------------------

describe("isProviderAvailable", () => {
  test("local providers are always available", () => {
    const ollama = getProviderByName("ollama")!;
    expect(isProviderAvailable(ollama)).toBe(true);

    const lmstudio = getProviderByName("lmstudio")!;
    expect(isProviderAvailable(lmstudio)).toBe(true);
  });

  test("providers with publicKeyFallback are always available", () => {
    const zen = getProviderByName("opencode-zen")!;
    expect(isProviderAvailable(zen)).toBe(true);
  });

  test("provider with primary API key set is available", () => {
    const prev = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test-key";
    try {
      const google = getProviderByName("google")!;
      expect(isProviderAvailable(google)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prev;
    }
  });

  test("provider with alias API key set is available", () => {
    const prevPrimary = process.env.ZHIPU_API_KEY;
    const prevAlias = process.env.GLM_API_KEY;
    delete process.env.ZHIPU_API_KEY;
    process.env.GLM_API_KEY = "test-alias-key";
    try {
      const glm = getProviderByName("glm")!;
      expect(isProviderAvailable(glm)).toBe(true);
    } finally {
      if (prevPrimary === undefined) delete process.env.ZHIPU_API_KEY;
      else process.env.ZHIPU_API_KEY = prevPrimary;
      if (prevAlias === undefined) delete process.env.GLM_API_KEY;
      else process.env.GLM_API_KEY = prevAlias;
    }
  });

  test("provider without API key is unavailable", () => {
    const prev = process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    try {
      const oc = getProviderByName("ollamacloud")!;
      expect(isProviderAvailable(oc)).toBe(false);
    } finally {
      if (prev !== undefined) process.env.OLLAMA_API_KEY = prev;
    }
  });
});
