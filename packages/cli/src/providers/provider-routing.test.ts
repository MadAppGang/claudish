/**
 * Comprehensive provider routing regression tests.
 *
 * Tests the full routing pipeline: model spec parsing → adapter selection → provider profiles.
 * Guards against false-positive adapter matching (e.g., "qwen-grok-hybrid" matching GrokAdapter).
 *
 * Run: bun test packages/cli/src/providers/provider-routing.test.ts
 */

import { describe, test, expect } from "bun:test";
import { parseModelSpec } from "./model-parser.js";
import { BUILTIN_PROVIDERS, getShortcuts } from "./provider-definitions.js";
import { AdapterManager } from "../adapters/adapter-manager.js";
import { GrokAdapter } from "../adapters/grok-adapter.js";
import { GeminiAdapter } from "../adapters/gemini-adapter.js";
import { QwenAdapter } from "../adapters/qwen-adapter.js";
import { DeepSeekAdapter } from "../adapters/deepseek-adapter.js";
import { GLMAdapter } from "../adapters/glm-adapter.js";
import { MiniMaxAdapter } from "../adapters/minimax-adapter.js";
import { XiaomiAdapter } from "../adapters/xiaomi-adapter.js";
import { CodexAdapter } from "../adapters/codex-adapter.js";
import { OpenAIAdapter } from "../adapters/openai-adapter.js";
import { DefaultAdapter } from "../adapters/base-adapter.js";
import { PROVIDER_PROFILES, createHandlerForProvider } from "./provider-profiles.js";

// ---------------------------------------------------------------------------
// Section 1: parseModelSpec resolution
// ---------------------------------------------------------------------------

describe("parseModelSpec — shortcut resolution", () => {
  const shortcuts = getShortcuts();

  test("every shortcut in BUILTIN_PROVIDERS resolves to the correct provider", () => {
    for (const def of BUILTIN_PROVIDERS) {
      for (const shortcut of def.shortcuts) {
        const parsed = parseModelSpec(`${shortcut}@test-model`);
        expect(parsed.provider).toBe(def.name);
        expect(parsed.model).toBe("test-model");
        expect(parsed.isExplicitProvider).toBe(true);
      }
    }
  });

  test("shortcuts are case-insensitive for the provider part", () => {
    const parsed = parseModelSpec("G@gemini-2.0-flash");
    expect(parsed.provider).toBe("google");

    const parsed2 = parseModelSpec("OR@some-model");
    expect(parsed2.provider).toBe("openrouter");
  });
});

describe("parseModelSpec — legacy prefix patterns", () => {
  test("g/gemini-2.0-flash resolves to google", () => {
    const parsed = parseModelSpec("g/gemini-2.0-flash");
    expect(parsed.provider).toBe("google");
    expect(parsed.model).toBe("gemini-2.0-flash");
    expect(parsed.isLegacySyntax).toBe(true);
  });

  test("oai/gpt-4o resolves to openai", () => {
    const parsed = parseModelSpec("oai/gpt-4o");
    expect(parsed.provider).toBe("openai");
    expect(parsed.model).toBe("gpt-4o");
  });

  test("mm/minimax-m2.5 resolves to minimax", () => {
    const parsed = parseModelSpec("mm/minimax-m2.5");
    expect(parsed.provider).toBe("minimax");
    expect(parsed.model).toBe("minimax-m2.5");
  });

  test("ollama/llama3.2 resolves to ollama", () => {
    const parsed = parseModelSpec("ollama/llama3.2");
    expect(parsed.provider).toBe("ollama");
    expect(parsed.model).toBe("llama3.2");
  });

  test("ollama:llama3.2 resolves to ollama (colon syntax)", () => {
    const parsed = parseModelSpec("ollama:llama3.2");
    expect(parsed.provider).toBe("ollama");
    expect(parsed.model).toBe("llama3.2");
  });
});

describe("parseModelSpec — native model auto-detection", () => {
  test("gemini-2.0-flash auto-detects as google", () => {
    const parsed = parseModelSpec("gemini-2.0-flash");
    expect(parsed.provider).toBe("google");
    expect(parsed.isExplicitProvider).toBe(false);
  });

  test("gpt-4o auto-detects as openai", () => {
    const parsed = parseModelSpec("gpt-4o");
    expect(parsed.provider).toBe("openai");
  });

  test("o3 auto-detects as openai", () => {
    const parsed = parseModelSpec("o3");
    expect(parsed.provider).toBe("openai");
  });

  test("o3-mini auto-detects as openai", () => {
    const parsed = parseModelSpec("o3-mini");
    expect(parsed.provider).toBe("openai");
  });

  test("minimax-m2.5 auto-detects as minimax", () => {
    const parsed = parseModelSpec("minimax-m2.5");
    expect(parsed.provider).toBe("minimax");
  });

  test("kimi-for-coding auto-detects as kimi-coding (not kimi)", () => {
    const parsed = parseModelSpec("kimi-for-coding");
    expect(parsed.provider).toBe("kimi-coding");
  });

  test("kimi-k2 auto-detects as kimi", () => {
    const parsed = parseModelSpec("kimi-k2");
    expect(parsed.provider).toBe("kimi");
  });

  test("glm-5 auto-detects as glm", () => {
    const parsed = parseModelSpec("glm-5");
    expect(parsed.provider).toBe("glm");
  });

  test("qwen3-coder auto-detects as qwen", () => {
    const parsed = parseModelSpec("qwen3-coder");
    expect(parsed.provider).toBe("qwen");
  });

  test("llama3 auto-detects as ollamacloud", () => {
    const parsed = parseModelSpec("llama3");
    expect(parsed.provider).toBe("ollamacloud");
  });

  test("claude-3-opus falls to native-anthropic", () => {
    const parsed = parseModelSpec("claude-3-opus-20240229");
    expect(parsed.provider).toBe("native-anthropic");
  });

  test("unknown-model without / falls to native-anthropic", () => {
    const parsed = parseModelSpec("unknown-model");
    expect(parsed.provider).toBe("native-anthropic");
  });

  test("vendor/model format with unknown vendor", () => {
    const parsed = parseModelSpec("some-vendor/some-model");
    expect(parsed.provider).toBe("unknown");
  });

  test("URL-style model detects as custom-url", () => {
    const parsed = parseModelSpec("http://localhost:8080/v1/model");
    expect(parsed.provider).toBe("custom-url");
  });
});

// ---------------------------------------------------------------------------
// Section 2: Adapter selection
// ---------------------------------------------------------------------------

describe("AdapterManager — correct adapter selection", () => {
  test("grok-beta → GrokAdapter", () => {
    const adapter = new AdapterManager("grok-beta").getAdapter();
    expect(adapter).toBeInstanceOf(GrokAdapter);
  });

  test("x-ai/grok-beta → GrokAdapter", () => {
    const adapter = new AdapterManager("x-ai/grok-beta").getAdapter();
    expect(adapter).toBeInstanceOf(GrokAdapter);
  });

  test("gemini-2.0-flash → GeminiAdapter", () => {
    const adapter = new AdapterManager("gemini-2.0-flash").getAdapter();
    expect(adapter).toBeInstanceOf(GeminiAdapter);
  });

  test("google/gemini-2.5-pro → GeminiAdapter", () => {
    const adapter = new AdapterManager("google/gemini-2.5-pro").getAdapter();
    expect(adapter).toBeInstanceOf(GeminiAdapter);
  });

  test("deepseek-r1 → DeepSeekAdapter", () => {
    const adapter = new AdapterManager("deepseek-r1").getAdapter();
    expect(adapter).toBeInstanceOf(DeepSeekAdapter);
  });

  test("glm-5 → GLMAdapter", () => {
    const adapter = new AdapterManager("glm-5").getAdapter();
    expect(adapter).toBeInstanceOf(GLMAdapter);
  });

  test("zhipu/glm-4 → GLMAdapter", () => {
    const adapter = new AdapterManager("zhipu/glm-4").getAdapter();
    expect(adapter).toBeInstanceOf(GLMAdapter);
  });

  test("minimax-m2.5 → MiniMaxAdapter", () => {
    const adapter = new AdapterManager("minimax-m2.5").getAdapter();
    expect(adapter).toBeInstanceOf(MiniMaxAdapter);
  });

  test("qwen3-coder → QwenAdapter", () => {
    const adapter = new AdapterManager("qwen3-coder").getAdapter();
    expect(adapter).toBeInstanceOf(QwenAdapter);
  });

  test("xiaomi/mimo-vl-2b → XiaomiAdapter", () => {
    const adapter = new AdapterManager("xiaomi/mimo-vl-2b").getAdapter();
    expect(adapter).toBeInstanceOf(XiaomiAdapter);
  });

  test("codex-mini → CodexAdapter", () => {
    const adapter = new AdapterManager("codex-mini").getAdapter();
    expect(adapter).toBeInstanceOf(CodexAdapter);
  });

  test("gpt-4o → DefaultAdapter (GPT models use default OpenAI format)", () => {
    const adapter = new AdapterManager("gpt-4o").getAdapter();
    expect(adapter).toBeInstanceOf(DefaultAdapter);
  });

  test("o3-mini → OpenAIAdapter (o-series needs reasoning_effort mapping)", () => {
    const adapter = new AdapterManager("o3-mini").getAdapter();
    expect(adapter).toBeInstanceOf(OpenAIAdapter);
  });

  test("unknown-model → DefaultAdapter", () => {
    const adapter = new AdapterManager("unknown-model").getAdapter();
    expect(adapter).toBeInstanceOf(DefaultAdapter);
  });
});

describe("AdapterManager — false positive prevention", () => {
  test("qwen-grok-hybrid → QwenAdapter (NOT GrokAdapter)", () => {
    const adapter = new AdapterManager("qwen-grok-hybrid").getAdapter();
    expect(adapter).toBeInstanceOf(QwenAdapter);
    expect(adapter).not.toBeInstanceOf(GrokAdapter);
  });

  test("deepseek-glm-test → DeepSeekAdapter (NOT GLMAdapter)", () => {
    const adapter = new AdapterManager("deepseek-glm-test").getAdapter();
    expect(adapter).toBeInstanceOf(DeepSeekAdapter);
    expect(adapter).not.toBeInstanceOf(GLMAdapter);
  });

  test("my-grok-clone → DefaultAdapter (not GrokAdapter — grok is mid-string)", () => {
    const adapter = new AdapterManager("my-grok-clone").getAdapter();
    expect(adapter).not.toBeInstanceOf(GrokAdapter);
    // Should fall to default since none of the specific families match
    expect(adapter).toBeInstanceOf(DefaultAdapter);
  });

  test("my-minimax-clone → DefaultAdapter (not MiniMaxAdapter)", () => {
    const adapter = new AdapterManager("my-minimax-clone").getAdapter();
    expect(adapter).not.toBeInstanceOf(MiniMaxAdapter);
    expect(adapter).toBeInstanceOf(DefaultAdapter);
  });

  test("test-deepseek-model → DefaultAdapter (not DeepSeekAdapter — deepseek is mid-string)", () => {
    const adapter = new AdapterManager("test-deepseek-model").getAdapter();
    expect(adapter).not.toBeInstanceOf(DeepSeekAdapter);
    expect(adapter).toBeInstanceOf(DefaultAdapter);
  });

  test("vendor/grok-beta uses GrokAdapter (vendor prefix is fine)", () => {
    const adapter = new AdapterManager("vendor/grok-beta").getAdapter();
    expect(adapter).toBeInstanceOf(GrokAdapter);
  });

  test("vendor/deepseek-r1 uses DeepSeekAdapter (vendor prefix)", () => {
    const adapter = new AdapterManager("vendor/deepseek-r1").getAdapter();
    expect(adapter).toBeInstanceOf(DeepSeekAdapter);
  });

  test("vendor/minimax-m2.5 uses MiniMaxAdapter (vendor prefix)", () => {
    const adapter = new AdapterManager("vendor/minimax-m2.5").getAdapter();
    expect(adapter).toBeInstanceOf(MiniMaxAdapter);
  });

  test("openrouter/x-ai/grok-beta uses GrokAdapter (double vendor prefix)", () => {
    const adapter = new AdapterManager("openrouter/x-ai/grok-beta").getAdapter();
    expect(adapter).toBeInstanceOf(GrokAdapter);
  });
});

// ---------------------------------------------------------------------------
// Section 3: Provider profiles
// ---------------------------------------------------------------------------

describe("PROVIDER_PROFILES — coverage", () => {
  test("every entry in PROVIDER_PROFILES has a matching BUILTIN_PROVIDER", () => {
    for (const profileName of Object.keys(PROVIDER_PROFILES)) {
      // Profile names match RemoteProvider.name which maps google→gemini
      const builtinName = profileName === "gemini" ? "google" : profileName;
      const def = BUILTIN_PROVIDERS.find(
        (d) => d.name === builtinName || d.name === profileName
      );
      expect(def).toBeDefined();
    }
  });

  test("all remote BUILTIN_PROVIDERS have a profile (except openrouter, poe, qwen, native-anthropic)", () => {
    // openrouter has its own dedicated handler (not ComposedHandler), poe has transport but no profile yet
    const skipProviders = new Set(["qwen", "native-anthropic", "poe", "openrouter", "ollama", "lmstudio", "vllm", "mlx"]);
    for (const def of BUILTIN_PROVIDERS) {
      if (skipProviders.has(def.name)) continue;
      const profileName = def.name === "google" ? "gemini" : def.name;
      const profile = PROVIDER_PROFILES[profileName];
      expect(profile).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Section 4: Edge cases
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  test("empty model string doesn't crash parseModelSpec", () => {
    expect(() => parseModelSpec("")).not.toThrow();
    const parsed = parseModelSpec("");
    expect(parsed.provider).toBe("native-anthropic");
  });

  test("@ with empty model parses without crashing", () => {
    expect(() => parseModelSpec("google@")).not.toThrow();
  });

  test("@ with empty provider falls through to native detection", () => {
    // "@model" doesn't match provider@model regex (requires non-empty provider)
    // Falls through to native detection, then to native-anthropic
    const parsed = parseModelSpec("@model");
    expect(parsed.provider).toBe("native-anthropic");
  });

  test("concurrency suffix on local provider", () => {
    const parsed = parseModelSpec("ollama@llama3.2:3");
    expect(parsed.provider).toBe("ollama");
    expect(parsed.model).toBe("llama3.2");
    expect(parsed.concurrency).toBe(3);
  });

  test("concurrency zero means no limit", () => {
    const parsed = parseModelSpec("ollama@llama3.2:0");
    expect(parsed.concurrency).toBe(0);
  });

  test("model with multiple slashes", () => {
    const parsed = parseModelSpec("or@openrouter/x-ai/grok-beta");
    expect(parsed.provider).toBe("openrouter");
    expect(parsed.model).toBe("openrouter/x-ai/grok-beta");
  });
});

// ---------------------------------------------------------------------------
// Section 5: matchesModelFamily correctness
// ---------------------------------------------------------------------------

describe("matchesModelFamily", () => {
  // Import directly to test
  const { matchesModelFamily } = require("../adapters/base-adapter.js");

  test("prefix match: 'grok-beta' starts with 'grok'", () => {
    expect(matchesModelFamily("grok-beta", "grok")).toBe(true);
  });

  test("vendor prefix match: 'x-ai/grok-beta' contains '/grok'", () => {
    expect(matchesModelFamily("x-ai/grok-beta", "grok")).toBe(true);
  });

  test("double vendor prefix: 'openrouter/x-ai/grok-beta'", () => {
    expect(matchesModelFamily("openrouter/x-ai/grok-beta", "grok")).toBe(true);
  });

  test("mid-string NO match: 'qwen-grok-hybrid' does NOT start with 'grok' and no '/grok'", () => {
    expect(matchesModelFamily("qwen-grok-hybrid", "grok")).toBe(false);
  });

  test("case insensitive: 'GROK-BETA' matches 'grok'", () => {
    expect(matchesModelFamily("GROK-BETA", "grok")).toBe(true);
  });

  test("exact match: 'deepseek' matches 'deepseek'", () => {
    expect(matchesModelFamily("deepseek", "deepseek")).toBe(true);
  });

  test("suffix NO match: 'my-deepseek' does NOT match 'deepseek'", () => {
    expect(matchesModelFamily("my-deepseek", "deepseek")).toBe(false);
  });
});
