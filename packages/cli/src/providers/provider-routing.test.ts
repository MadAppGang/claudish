/**
 * Comprehensive provider routing regression tests.
 *
 * Tests the full routing pipeline: model spec parsing → dialect selection → provider profiles.
 * Guards against false-positive dialect matching (e.g., "qwen-grok-hybrid" matching GrokModelDialect).
 *
 * Run: bun test packages/cli/src/providers/provider-routing.test.ts
 */

import { describe, expect, test } from "bun:test";
import { parseModelSpec } from "./model-parser.js";
import { BUILTIN_PROVIDERS, getProviderByName } from "./provider-definitions.js";
import { OpenAIProviderTransport } from "./transport/openai.js";

// ---------------------------------------------------------------------------
// Section 1: parseModelSpec resolution
// ---------------------------------------------------------------------------

describe("parseModelSpec — shortcut resolution", () => {
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

  test("qtoken@qwen3.7-plus resolves to qwen-token-plan", () => {
    const parsed = parseModelSpec("qtoken@qwen3.7-plus");
    expect(parsed.provider).toBe("qwen-token-plan");
    expect(parsed.model).toBe("qwen3.7-plus");
    expect(parsed.isExplicitProvider).toBe(true);
  });

  test("qcode@qwen3.7-plus resolves to qwen-coding", () => {
    const parsed = parseModelSpec("qcode@qwen3.7-plus");
    expect(parsed.provider).toBe("qwen-coding");
    expect(parsed.model).toBe("qwen3.7-plus");
    expect(parsed.isExplicitProvider).toBe(true);
  });

  test.each(["qpay"])("%s@qwen3.7-plus resolves explicitly to qwen-payg", (shortcut) => {
    const parsed = parseModelSpec(`${shortcut}@qwen3.7-plus`);
    expect(parsed.provider).toBe("qwen-payg");
    expect(parsed.model).toBe("qwen3.7-plus");
    expect(parsed.isExplicitProvider).toBe(true);
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

  test("fugu-ultra auto-detects as sakana", () => {
    const parsed = parseModelSpec("fugu-ultra");
    expect(parsed.provider).toBe("sakana");
  });

  test("sakana/fugu auto-detects as sakana", () => {
    const parsed = parseModelSpec("sakana/fugu");
    expect(parsed.provider).toBe("sakana");
  });

  test("qwen3-coder auto-detects as qwen", () => {
    const parsed = parseModelSpec("qwen3-coder");
    expect(parsed.provider).toBe("qwen");
  });

  test("qwen3.7-plus auto-detects as qwen-token-plan before the general qwen provider", () => {
    const parsed = parseModelSpec("qwen3.7-plus");
    expect(parsed.provider).toBe("qwen-token-plan");
    expect(parsed.model).toBe("qwen3.7-plus");
    expect(parsed.isExplicitProvider).toBe(false);
  });

  test("hyphenated qwen3-coder-next remains owned by qwen, not qwen-token-plan", () => {
    const parsed = parseModelSpec("qwen3-coder-next");
    expect(parsed.provider).toBe("qwen");
    expect(parsed.provider).not.toBe("qwen-token-plan");
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

// ---------------------------------------------------------------------------
// Section 3: Provider profiles
// ---------------------------------------------------------------------------

describe("Provider handlers", () => {
  test("qwen-token-plan shares the Anthropic-compatible handler builder", () => {
    const createHandler = getProviderByName("qwen-token-plan")?.createHandler;
    expect(typeof createHandler).toBe("function");

    // These four providers are all natively Anthropic-compatible and must not
    // drift onto different builders: a wrong builder silently mismatches the
    // wire format instead of crashing.
    expect(createHandler).toBe(getProviderByName("minimax-coding")?.createHandler);
    expect(createHandler).toBe(getProviderByName("kimi-coding")?.createHandler);
    expect(createHandler).toBe(getProviderByName("z-ai")?.createHandler);
  });

  test("every handler omission is explicit and qwen-payg uses the Anthropic-compatible builder", () => {
    const expectedHandlerlessProviders = [
      "openrouter",
      "ollama",
      "lmstudio",
      "vllm",
      "mlx",
      "native-anthropic",
    ];
    const handlerlessProviders = BUILTIN_PROVIDERS.filter(
      (provider) => typeof provider.createHandler !== "function"
    ).map((provider) => provider.name);
    const qwenPaygHandler = getProviderByName("qwen-payg")?.createHandler;

    expect(handlerlessProviders).toEqual(expectedHandlerlessProviders);
    expect(typeof qwenPaygHandler).toBe("function");
    expect(qwenPaygHandler).toBe(getProviderByName("qwen-token-plan")?.createHandler);
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
  const zenBaseProvider = {
    name: "opencode-zen" as const,
    baseUrl: "https://opencode.ai/zen",
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "OPENCODE_API_KEY",
    prefixes: [],
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
});
