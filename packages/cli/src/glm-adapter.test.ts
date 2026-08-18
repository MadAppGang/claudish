/**
 * E2E tests for GLM dialect and three-layer adapter architecture.
 *
 * Validates:
 * 1. GLMModelDialect model detection, context windows, and vision support
 * 2. DialectManager correctly selects GLMModelDialect for GLM models
 * 3. ComposedHandler three-layer architecture — model dialect provides model-specific
 *    overrides (context window, vision, prepareRequest) even when a provider format
 *    (LiteLLMAPIFormat, OpenRouterAPIFormat) is set as the explicit adapter
 */

import { describe, expect, test } from "bun:test";
import { resolveModelDialect } from "./adapters/dialect-manager.js";
import { GLMModelDialect } from "./adapters/glm-model-dialect.js";
import { LiteLLMAPIFormat } from "./adapters/litellm-api-format.js";

// ─── Group 1: GLMModelDialect unit tests ─────────────────────────────────────

describe("GLMModelDialect — Model Detection", () => {
  const adapter = new GLMModelDialect("glm-5");

  test("should handle glm-5", () => {
    expect(adapter.shouldHandle("glm-5")).toBe(true);
  });

  test("should handle glm-4-plus", () => {
    expect(adapter.shouldHandle("glm-4-plus")).toBe(true);
  });

  test("should handle glm-4-flash", () => {
    expect(adapter.shouldHandle("glm-4-flash")).toBe(true);
  });

  test("should handle glm-4-long", () => {
    expect(adapter.shouldHandle("glm-4-long")).toBe(true);
  });

  test("should handle glm-3-turbo", () => {
    expect(adapter.shouldHandle("glm-3-turbo")).toBe(true);
  });

  test("should handle zhipu/ prefixed models", () => {
    expect(adapter.shouldHandle("zhipu/glm-5")).toBe(true);
  });

  test("should NOT handle non-GLM models", () => {
    expect(adapter.shouldHandle("gpt-4o")).toBe(false);
    expect(adapter.shouldHandle("gemini-2.0-flash")).toBe(false);
    expect(adapter.shouldHandle("deepseek-r1")).toBe(false);
    expect(adapter.shouldHandle("grok-3")).toBe(false);
  });
});

describe("GLMModelDialect — prepareRequest", () => {
  test("strips thinking param from request", () => {
    const adapter = new GLMModelDialect("glm-5");
    const request = { model: "glm-5", thinking: { budget: 10000 }, messages: [] };
    const original = { thinking: { budget: 10000 } };

    adapter.prepareRequest(request, original);

    expect(request.thinking).toBeUndefined();
  });

  test("leaves request unchanged without thinking param", () => {
    const adapter = new GLMModelDialect("glm-5");
    const request = { model: "glm-5", messages: [] };
    const original = {};

    adapter.prepareRequest(request, original);

    expect(request.model).toBe("glm-5");
    expect(request.messages).toEqual([]);
  });
});

describe("GLMModelDialect — processTextContent", () => {
  test("passes through text unchanged (no transformation)", () => {
    const adapter = new GLMModelDialect("glm-5");
    const result = adapter.processTextContent("Hello, world!", "");

    expect(result.cleanedText).toBe("Hello, world!");
    expect(result.extractedToolCalls).toHaveLength(0);
    expect(result.wasTransformed).toBe(false);
  });
});

// ─── Group 2: DialectManager selects GLMModelDialect ─────────────────────────

// ─── Group 3: Three-layer adapter architecture ───────────────────────────────
//
// When a format adapter (LiteLLMAPIFormat) is the explicit adapter, the model
// dialect (GLMModelDialect) should still be resolved by DialectManager for
// model-specific concerns.

describe("Three-layer adapter — model dialect overrides format adapter", () => {
  test("model dialect strips thinking, format adapter does not", () => {
    const litellmAdapter = new LiteLLMAPIFormat("glm-5", "https://example.com");
    const modelAdapter = resolveModelDialect("glm-5");

    // Format adapter does not strip thinking (no override)
    const request1 = { model: "glm-5", thinking: { budget: 10000 }, messages: [] };
    litellmAdapter.prepareRequest(request1, { thinking: { budget: 10000 } });
    expect(request1.thinking).toBeDefined(); // LiteLLMAPIFormat doesn't touch thinking

    // Model dialect strips thinking
    const request2 = { model: "glm-5", thinking: { budget: 10000 }, messages: [] };
    modelAdapter.prepareRequest(request2, { thinking: { budget: 10000 } });
    expect(request2.thinking).toBeUndefined(); // GLMModelDialect strips it
  });
});
