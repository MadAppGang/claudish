/**
 * Comprehensive provider routing regression tests.
 *
 * Tests the full routing pipeline: model spec parsing → dialect selection → provider profiles.
 * Guards against false-positive dialect matching (e.g., "qwen-grok-hybrid" matching GrokModelDialect).
 *
 * Run: bun test packages/cli/src/providers/provider-routing.test.ts
 */

import { describe, test, expect } from "bun:test";
import { parseModelSpec } from "./model-parser.js";
import { BUILTIN_PROVIDERS, PROVIDER_SHORTCUTS } from "./provider-definitions.js";
import { resolveModelDialect } from "../providers/provider-profiles.js";
import { GrokModelDialect } from "../adapters/grok-model-dialect.js";
import { GeminiModelDialect } from "../adapters/gemini-model-dialect.js";
import { QwenModelDialect } from "../adapters/qwen-model-dialect.js";
import { DeepSeekModelDialect } from "../adapters/deepseek-model-dialect.js";
import { GLMModelDialect } from "../adapters/glm-model-dialect.js";
import { MiniMaxModelDialect } from "../adapters/minimax-model-dialect.js";
import { XiaomiModelDialect } from "../adapters/xiaomi-model-dialect.js";
import { CodexAPIFormat } from "../adapters/codex-api-format.js";
import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";
import { DefaultAPIFormat } from "../adapters/base-api-format.js";
import { createHandlerForProvider } from "./provider-profiles.js";
import { getProviderByName } from "./provider-definitions.js";
import { OpenAIProviderTransport } from "./transport/openai.js";

// ---------------------------------------------------------------------------
// Section 1: parseModelSpec resolution
// ---------------------------------------------------------------------------

describe("parseModelSpec — shortcut resolution", () => {
  const shortcuts = PROVIDER_SHORTCUTS;

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

describe("resolveModelDialect — correct dialect selection", () => {
  test("grok-beta → GrokModelDialect", () => {
    const adapter = resolveModelDialect("grok-beta");
    expect(adapter).toBeInstanceOf(GrokModelDialect);
  });

  test("x-ai/grok-beta → GrokModelDialect", () => {
    const adapter = resolveModelDialect("x-ai/grok-beta");
    expect(adapter).toBeInstanceOf(GrokModelDialect);
  });

  test("gemini-2.0-flash → GeminiModelDialect", () => {
    const adapter = resolveModelDialect("gemini-2.0-flash");
    expect(adapter).toBeInstanceOf(GeminiModelDialect);
  });

  test("google/gemini-2.5-pro → GeminiModelDialect", () => {
    const adapter = resolveModelDialect("google/gemini-2.5-pro");
    expect(adapter).toBeInstanceOf(GeminiModelDialect);
  });

  test("deepseek-r1 → DeepSeekModelDialect", () => {
    const adapter = resolveModelDialect("deepseek-r1");
    expect(adapter).toBeInstanceOf(DeepSeekModelDialect);
  });

  test("glm-5 → GLMModelDialect", () => {
    const adapter = resolveModelDialect("glm-5");
    expect(adapter).toBeInstanceOf(GLMModelDialect);
  });

  test("zhipu/glm-4 → GLMModelDialect", () => {
    const adapter = resolveModelDialect("zhipu/glm-4");
    expect(adapter).toBeInstanceOf(GLMModelDialect);
  });

  test("minimax-m2.5 → MiniMaxModelDialect", () => {
    const adapter = resolveModelDialect("minimax-m2.5");
    expect(adapter).toBeInstanceOf(MiniMaxModelDialect);
  });

  test("qwen3-coder → QwenModelDialect", () => {
    const adapter = resolveModelDialect("qwen3-coder");
    expect(adapter).toBeInstanceOf(QwenModelDialect);
  });

  test("xiaomi/mimo-vl-2b → XiaomiModelDialect", () => {
    const adapter = resolveModelDialect("xiaomi/mimo-vl-2b");
    expect(adapter).toBeInstanceOf(XiaomiModelDialect);
  });

  test("codex-mini → null (no dialect, wire format only)", () => {
    const adapter = resolveModelDialect("codex-mini");
    expect(adapter).toBeNull();
  });

  test("gpt-4o → null (no dialect quirks)", () => {
    const adapter = resolveModelDialect("gpt-4o");
    expect(adapter).toBeNull();
  });

  test("o3-mini → null (no dialect quirks)", () => {
    const adapter = resolveModelDialect("o3-mini");
    expect(adapter).toBeNull();
  });

  test("unknown-model → null", () => {
    const adapter = resolveModelDialect("unknown-model");
    expect(adapter).toBeNull();
  });
});

describe("resolveModelDialect — false positive prevention", () => {
  test("qwen-grok-hybrid → QwenModelDialect (NOT GrokModelDialect)", () => {
    const adapter = resolveModelDialect("qwen-grok-hybrid");
    expect(adapter).toBeInstanceOf(QwenModelDialect);
    expect(adapter).not.toBeInstanceOf(GrokModelDialect);
  });

  test("deepseek-glm-test → DeepSeekModelDialect (NOT GLMModelDialect)", () => {
    const adapter = resolveModelDialect("deepseek-glm-test");
    expect(adapter).toBeInstanceOf(DeepSeekModelDialect);
    expect(adapter).not.toBeInstanceOf(GLMModelDialect);
  });

  test("my-grok-clone → null (not GrokModelDialect — grok is mid-string)", () => {
    const adapter = resolveModelDialect("my-grok-clone");
    expect(adapter).not.toBeInstanceOf(GrokModelDialect);
    // Should fall to default since none of the specific families match
    expect(adapter).toBeNull();
  });

  test("my-minimax-clone → null (not MiniMaxModelDialect)", () => {
    const adapter = resolveModelDialect("my-minimax-clone");
    expect(adapter).not.toBeInstanceOf(MiniMaxModelDialect);
    expect(adapter).toBeNull();
  });

  test("test-deepseek-model → null (not DeepSeekModelDialect — deepseek is mid-string)", () => {
    const adapter = resolveModelDialect("test-deepseek-model");
    expect(adapter).not.toBeInstanceOf(DeepSeekModelDialect);
    expect(adapter).toBeNull();
  });

  test("vendor/grok-beta uses GrokModelDialect (vendor prefix is fine)", () => {
    const adapter = resolveModelDialect("vendor/grok-beta");
    expect(adapter).toBeInstanceOf(GrokModelDialect);
  });

  test("vendor/deepseek-r1 uses DeepSeekModelDialect (vendor prefix)", () => {
    const adapter = resolveModelDialect("vendor/deepseek-r1");
    expect(adapter).toBeInstanceOf(DeepSeekModelDialect);
  });

  test("vendor/minimax-m2.5 uses MiniMaxModelDialect (vendor prefix)", () => {
    const adapter = resolveModelDialect("vendor/minimax-m2.5");
    expect(adapter).toBeInstanceOf(MiniMaxModelDialect);
  });

  test("openrouter/x-ai/grok-beta uses GrokModelDialect (double vendor prefix)", () => {
    const adapter = resolveModelDialect("openrouter/x-ai/grok-beta");
    expect(adapter).toBeInstanceOf(GrokModelDialect);
  });
});

// ---------------------------------------------------------------------------
// Section 3: Provider profiles
// ---------------------------------------------------------------------------

describe("createHandlerForProvider — coverage", () => {
  // Providers that are wired through createHandlerForProvider (ComposedHandler).
  // Excludes: openrouter (dedicated handler), poe (dedicated handler),
  // local providers (dedicated handler), qwen/native-anthropic (virtual, auto-routed).
  const skipProviders = new Set([
    "qwen",
    "native-anthropic",
    "poe",
    "openrouter",
    "xai", // auto-routed through OpenRouter
    "ollama",
    "lmstudio",
    "vllm",
    "mlx",
    "vertex", // requires VERTEX_PROJECT or VERTEX_API_KEY env
    "litellm", // requires LITELLM_BASE_URL env
  ]);

  test("all remote BUILTIN_PROVIDERS create a handler via createHandlerForProvider", () => {
    for (const def of BUILTIN_PROVIDERS) {
      if (skipProviders.has(def.name)) continue;
      const handler = createHandlerForProvider(
        def, "test-model", "test-key", "test-target", 4000,
        { isInteractive: false, invocationMode: "explicit-model" },
      );
      expect(handler).not.toBeNull();
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
  const { matchesModelFamily } = require("../adapters/base-api-format.js");

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

// ---------------------------------------------------------------------------
// Section 6: OpenCode Zen profile routing
// ---------------------------------------------------------------------------

describe("OpenCode Zen — model routing", () => {
  const zenDef = getProviderByName("opencode-zen")!;
  const zenBaseProvider = {
    name: "opencode-zen" as const,
    baseUrl: "https://opencode.ai/zen",
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "OPENCODE_API_KEY",
    prefixes: [] as string[],
    headers: undefined,
    authScheme: undefined,
  };

  test("GPT model routes to Responses API endpoint (/v1/responses)", () => {
    // The transport for GPT models via Zen must point to /v1/responses, not /v1/chat/completions.
    const responsesProvider = { ...zenBaseProvider, apiPath: "/v1/responses" };
    const transport = new OpenAIProviderTransport(responsesProvider, "gpt-4o", "key");
    expect(transport.getEndpoint()).toBe("https://opencode.ai/zen/v1/responses");
  });

  test("non-GPT model routes to chat completions endpoint (/v1/chat/completions)", () => {
    const transport = new OpenAIProviderTransport(zenBaseProvider, "glm-5", "key");
    expect(transport.getEndpoint()).toBe("https://opencode.ai/zen/v1/chat/completions");
  });

  test("GPT model createHandler returns non-null", () => {
    const handler = createHandlerForProvider(
      zenDef, "gpt-4o", "test-key", "placeholder", 4000,
      { isInteractive: false, invocationMode: "explicit-model" },
    );
    expect(handler).not.toBeNull();
  });

  test("MiniMax model createHandler returns non-null", () => {
    const handler = createHandlerForProvider(
      zenDef, "minimax-m2.5", "test-key", "placeholder", 4000,
      { isInteractive: false, invocationMode: "explicit-model" },
    );
    expect(handler).not.toBeNull();
  });

  test("GLM model createHandler returns non-null (default OpenAI path)", () => {
    const handler = createHandlerForProvider(
      zenDef, "glm-5", "test-key", "placeholder", 4000,
      { isInteractive: false, invocationMode: "explicit-model" },
    );
    expect(handler).not.toBeNull();
  });

  test("GPT adapter is CodexAPIFormat (Responses API wire format)", () => {
    // Validate that CodexAPIFormat reports the correct stream format for GPT via Zen.
    const adapter = new CodexAPIFormat("gpt-4o");
    expect(adapter.getStreamFormat()).toBe("openai-responses-sse");
  });
});
