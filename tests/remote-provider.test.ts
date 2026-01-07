/**
 * Integration tests for remote provider support (Gemini, OpenAI direct APIs)
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { resolveRemoteProvider, validateRemoteProviderApiKey, getRemoteProviderType } from "../src/providers/remote-provider-registry";
import { getModelPricing, calculateCost } from "../src/handlers/shared/remote-provider-types";
import { createProxyServer } from "../src/proxy-server";
import type { ProxyServer } from "../src/types";

describe("Remote Provider Registry", () => {
  describe("resolveRemoteProvider", () => {
    test("should resolve g/ prefix to gemini", () => {
      const result = resolveRemoteProvider("g/gemini-2.5-flash");
      expect(result).not.toBeNull();
      expect(result?.provider.name).toBe("gemini");
      expect(result?.modelName).toBe("gemini-2.5-flash");
    });

    test("should resolve gemini/ prefix to gemini", () => {
      const result = resolveRemoteProvider("gemini/gemini-2.5-pro");
      expect(result).not.toBeNull();
      expect(result?.provider.name).toBe("gemini");
      expect(result?.modelName).toBe("gemini-2.5-pro");
    });

    test("should NOT resolve google/ prefix (routes to OpenRouter instead)", () => {
      // google/model should fall through to OpenRouter, not direct Gemini API
      const result = resolveRemoteProvider("google/gemini-3-pro");
      expect(result).toBeNull(); // null means use OpenRouter default
    });

    test("should resolve oai/ prefix to openai", () => {
      const result = resolveRemoteProvider("oai/gpt-4o");
      expect(result).not.toBeNull();
      expect(result?.provider.name).toBe("openai");
      expect(result?.modelName).toBe("gpt-4o");
    });

    test("should resolve openai/ prefix to openai", () => {
      const result = resolveRemoteProvider("openai/gpt-5");
      expect(result).not.toBeNull();
      expect(result?.provider.name).toBe("openai");
      expect(result?.modelName).toBe("gpt-5");
    });

    test("should resolve or/ prefix to openrouter", () => {
      const result = resolveRemoteProvider("or/google/gemini-2.5-flash");
      expect(result).not.toBeNull();
      expect(result?.provider.name).toBe("openrouter");
      expect(result?.modelName).toBe("google/gemini-2.5-flash");
    });

    test("should return null for models without known prefix", () => {
      const result = resolveRemoteProvider("anthropic/claude-3-opus");
      expect(result).toBeNull();
    });

    test("should return null for local provider prefixes", () => {
      const result = resolveRemoteProvider("ollama/llama3.2");
      expect(result).toBeNull();
    });
  });

  describe("getRemoteProviderType", () => {
    test("should return 'gemini' for g/ prefix", () => {
      expect(getRemoteProviderType("g/gemini-2.5-flash")).toBe("gemini");
    });

    test("should return 'openai' for oai/ prefix", () => {
      expect(getRemoteProviderType("oai/gpt-4o")).toBe("openai");
    });

    test("should return null for unknown prefix", () => {
      expect(getRemoteProviderType("anthropic/claude")).toBeNull();
    });
  });

  describe("validateRemoteProviderApiKey", () => {
    test("should return error message when API key is missing", () => {
      const resolved = resolveRemoteProvider("g/gemini-2.5-flash");
      expect(resolved).not.toBeNull();

      // Temporarily unset the env var
      const originalKey = process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_API_KEY;

      const error = validateRemoteProviderApiKey(resolved!.provider);
      expect(error).not.toBeNull();
      expect(error).toContain("Missing GEMINI_API_KEY");
      expect(error).toContain("aistudio.google.com");

      // Restore
      if (originalKey) process.env.GEMINI_API_KEY = originalKey;
    });

    test("should return null when API key is set", () => {
      const resolved = resolveRemoteProvider("g/gemini-2.5-flash");
      expect(resolved).not.toBeNull();

      // Temporarily set the env var
      const originalKey = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = "test-key";

      const error = validateRemoteProviderApiKey(resolved!.provider);
      expect(error).toBeNull();

      // Restore
      if (originalKey) process.env.GEMINI_API_KEY = originalKey;
      else delete process.env.GEMINI_API_KEY;
    });
  });
});

describe("Model Pricing", () => {
  describe("getModelPricing", () => {
    test("should return pricing for known Gemini model", () => {
      const pricing = getModelPricing("gemini", "gemini-2.5-flash");
      expect(pricing.inputCostPer1M).toBe(0.15);
      expect(pricing.outputCostPer1M).toBe(0.60);
    });

    test("should return pricing for known OpenAI model", () => {
      const pricing = getModelPricing("openai", "gpt-4o");
      expect(pricing.inputCostPer1M).toBe(2.50);
      expect(pricing.outputCostPer1M).toBe(10.00);
    });

    test("should return default pricing for unknown Gemini model", () => {
      const pricing = getModelPricing("gemini", "gemini-unknown-model");
      expect(pricing.inputCostPer1M).toBe(0.50); // default
      expect(pricing.outputCostPer1M).toBe(2.00); // default
    });

    test("should match partial model names", () => {
      // "gpt-4o-2024-08-06" should match "gpt-4o"
      const pricing = getModelPricing("openai", "gpt-4o-2024-08-06");
      expect(pricing.inputCostPer1M).toBe(2.50);
    });
  });

  describe("calculateCost", () => {
    test("should calculate cost correctly for Gemini", () => {
      // 1M input tokens at $0.15 + 500K output tokens at $0.60 = $0.15 + $0.30 = $0.45
      const cost = calculateCost("gemini", "gemini-2.5-flash", 1_000_000, 500_000);
      expect(cost).toBeCloseTo(0.45, 2);
    });

    test("should calculate cost correctly for OpenAI", () => {
      // 1M input tokens at $2.50 + 1M output tokens at $10.00 = $12.50
      const cost = calculateCost("openai", "gpt-4o", 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(12.50, 2);
    });

    test("should handle small token counts", () => {
      // 1000 input tokens + 500 output tokens for gemini-2.5-flash
      // (1000/1M) * $0.15 + (500/1M) * $0.60 = $0.00015 + $0.0003 = $0.00045
      const cost = calculateCost("gemini", "gemini-2.5-flash", 1000, 500);
      expect(cost).toBeCloseTo(0.00045, 5);
    });
  });
});

describe("Proxy Server Routing", () => {
  let proxy: ProxyServer;
  const testPort = 9876;

  beforeAll(async () => {
    // Create proxy server without API keys (we're testing routing, not actual API calls)
    proxy = await createProxyServer(testPort, undefined, undefined, false, undefined, undefined, {});
  });

  afterAll(async () => {
    await proxy.shutdown();
  });

  test("should return error for Gemini without API key", async () => {
    // Ensure GEMINI_API_KEY is not set
    const originalKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      const response = await fetch(`http://127.0.0.1:${testPort}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "g/gemini-2.5-flash",
          max_tokens: 100,
          messages: [{ role: "user", content: "Hello" }]
        })
      });

      // Should return an error about missing API key
      expect(response.status).toBe(500);
      const data = await response.json() as any;
      expect(data.error.message).toContain("GEMINI_API_KEY");
    } finally {
      // Restore
      if (originalKey) process.env.GEMINI_API_KEY = originalKey;
    }
  });

  test("should return error for OpenAI without API key", async () => {
    // Ensure OPENAI_API_KEY is not set
    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const response = await fetch(`http://127.0.0.1:${testPort}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "oai/gpt-4o",
          max_tokens: 100,
          messages: [{ role: "user", content: "Hello" }]
        })
      });

      // Should return an error about missing API key
      expect(response.status).toBe(500);
      const data = await response.json() as any;
      expect(data.error.message).toContain("OPENAI_API_KEY");
    } finally {
      // Restore
      if (originalKey) process.env.OPENAI_API_KEY = originalKey;
    }
  });

  test("should route to OpenRouter for models without known prefix", async () => {
    // This will fail with auth error from OpenRouter, but that proves routing works
    const response = await fetch(`http://127.0.0.1:${testPort}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/claude-3-opus",
        max_tokens: 100,
        messages: [{ role: "user", content: "Hello" }]
      })
    });

    // Should get an auth error from OpenRouter (not a routing error)
    expect(response.status).toBe(401);
  });

  test("health endpoint should work", async () => {
    const response = await fetch(`http://127.0.0.1:${testPort}/health`);
    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.status).toBe("ok");
  });
});
