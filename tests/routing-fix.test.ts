/**
 * Tests for the @ prefix model routing fix.
 *
 * Bug: Models with explicit provider prefix (e.g., glm@glm-5, oc@glm-5)
 * were falling through to the native Anthropic handler when the direct API
 * key was missing, because the isNative heuristic only checked for "/".
 *
 * Fix: Also check for "@" in the target to prevent @ prefixed models
 * from being treated as native Anthropic models.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { createProxyServer } from "../src/proxy-server.js";
import type { ProxyServer } from "../src/types.js";
import { parseModelSpec } from "../src/providers/model-parser.js";
import { resolveModelProvider } from "../src/providers/provider-resolver.js";

// Save and clear API keys to test fallback behavior
const savedKeys: Record<string, string | undefined> = {};
function clearApiKey(key: string) {
  savedKeys[key] = process.env[key];
  delete process.env[key];
}
function restoreApiKeys() {
  for (const [key, value] of Object.entries(savedKeys)) {
    if (value !=== undefined) process.env[key] = value;
    else delete process.env[key];
  }
}

afterAll(() => restoreApiKeys());

describe("@ prefix model routing", () => {
  describe("parseModelSpec", () => {
    test("should parse glm@glm-5 correctly", () => {
      const result = parseModelSpec("glm@glm-5");
      expect(result.provider).toBe("glm");
      expect(result.model).toBe("glm-5");
    });

    test("should parse oc@glm-5 correctly", () => {
      const result = parseModelSpec("oc@glm-5");
      expect(result.provider).toBe("ollamacloud");
      expect(result.model).toBe("glm-5");
    });

    test("should parse oai@gpt-5.3-codex correctly", () => {
      const result = parseModelSpec("oai@gpt-5.3-codex");
      expect(result.provider).toBe("openai");
      expect(result.model).toBe("gpt-5.3-codex");
    });

    test("should parse openrouter@z-ai/glm-5 correctly", () => {
      const result = parseModelSpec("openrouter@z-ai/glm-5");
      expect(result.provider).toBe("openrouter");
      expect(result.model).toBe("z-ai/glm-5");
    });

    test("should parse zai@glm-5 correctly", () => {
      const result = parseModelSpec("zai@glm-5");
      expect(result.provider).toBe("zai");
      expect(result.model).toBe("glm-5");
    });
  });

  describe("resolveModelProvider", () => {
    test("glm@glm-5 without ZHIPU_API_KEY should NOT resolve to native-anthropic", () => {
      clearApiKey("ZHIPU_API_KEY");
      clearApiKey("GLM_API_KEY");
      const result = resolveModelProvider("glm@glm-5");
      expect(result.category).not.toBe("native-anthropic");
    });

    test("oc@glm-5 without OLLAMA_API_KEY should NOT resolve to native-anthropic", () => {
      clearApiKey("OLLAMA_API_KEY");
      const result = resolveModelProvider("oc@glm-5");
      expect(result.category).not.toBe("native-anthropic");
    });

    test("oai@gpt-5.3-codex without OPENAI_API_KEY should NOT resolve to native-anthropic", () => {
      clearApiKey("OPENAI_API_KEY");
      const result = resolveModelProvider("oai@gpt-5.3-codex");
      expect(result.category).not.toBe("native-anthropic");
    });

    test("plain claude model should resolve to native-anthropic", () => {
      const result = resolveModelProvider("claude-3-5-sonnet-20241022");
      expect(result.category).toBe("native-anthropic");
    });
  });

  describe("Proxy routing - @ models should not hit native handler", () => {
    let proxy: ProxyServer;

    afterAll(async () => {
      if (proxy) {
        await proxy.shutdown();
      }
    });

    test("glm@glm-5 should NOT route to Anthropic API (should get OpenRouter error, not auth error)", async () => {
      // Clear the direct API key to force fallback
      clearApiKey("ZHIPU_API_KEY");
      clearApiKey("GLM_API_KEY");

      // Set a dummy OpenRouter key so it doesn't fall to native
      const hadOrKey = !!process.env.OPENROUTER_API_KEY;
      if (!hadOrKey) process.env.OPENROUTER_API_KEY = "test-dummy-key";

      proxy = await createProxyServer(
        19876,
        process.env.OPENROUTER_API_KEY,
        "glm@glm-5"
      );

      const response = await fetch("http://localhost:19876/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4.5",
          max_tokens: 100,
          messages: [{ role: "user", content: "Hello" }],
        }),
      });

      const text = await response.text();

      // The key assertion: the error should NOT be an Anthropic auth error.
      // It should be an OpenRouter error (model not found, auth error, etc.)
      // Any error from OpenRouter is acceptable - what matters is it didn't go to Anthropic.
      expect(text).not.toContain('"type":"authentication_error"');
      // Also should not contain Anthropic request IDs
      expect(text).not.toMatch(/req_01[0-9A-Za-z]+/);

      await proxy.shutdown();
      if (!hadOrKey) delete process.env.OPENROUTER_API_KEY;
    });
  });
});
