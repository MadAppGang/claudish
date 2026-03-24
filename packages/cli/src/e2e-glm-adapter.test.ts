/**
 * E2E tests for GLM dialect and three-layer adapter architecture.
 *
 * Validates:
 * 1. GLMModelDialect model detection, context windows, and vision support
 * 2. resolveModelDialect correctly selects GLMModelDialect for GLM models
 * 3. ComposedHandler three-layer architecture — model dialect provides model-specific
 *    overrides (context window, vision, prepareRequest) even when a provider format
 *    (LiteLLMAPIFormat, OpenRouterAPIFormat) is set as the explicit adapter
 */

import { describe, test, expect } from "bun:test";
import { GLMModelDialect } from "./adapters/glm-model-dialect.js";
import { resolveModelDialect } from "./adapters/dialect-manager.js";
import { LiteLLMAPIFormat } from "./adapters/litellm-api-format.js";
import { DefaultAPIFormat } from "./adapters/base-api-format.js";

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

  test("should return correct adapter name", () => {
    expect(adapter.getName()).toBe("GLMModelDialect");
  });
});

describe("GLMModelDialect — Context Windows", () => {
  test("glm-5 → 80K", () => {
    expect(new GLMModelDialect("glm-5").getContextWindow()).toBe(80_000);
  });

  test("glm-4-plus → 128K", () => {
    expect(new GLMModelDialect("glm-4-plus").getContextWindow()).toBe(128_000);
  });

  test("glm-4-long → 1M", () => {
    expect(new GLMModelDialect("glm-4-long").getContextWindow()).toBe(1_000_000);
  });

  test("glm-4-flash → 128K", () => {
    expect(new GLMModelDialect("glm-4-flash").getContextWindow()).toBe(128_000);
  });

  test("unknown glm variant → 131K default (glm- catch-all)", () => {
    expect(new GLMModelDialect("glm-99").getContextWindow()).toBe(131_072);
  });
});

describe("GLMModelDialect — Vision Support", () => {
  test("glm-5 supports vision", () => {
    expect(new GLMModelDialect("glm-5").supportsVision()).toBe(true);
  });

  test("glm-4v supports vision", () => {
    expect(new GLMModelDialect("glm-4v").supportsVision()).toBe(true);
  });

  test("glm-4v-plus supports vision", () => {
    expect(new GLMModelDialect("glm-4v-plus").supportsVision()).toBe(true);
  });

  test("glm-4-flash does NOT support vision", () => {
    expect(new GLMModelDialect("glm-4-flash").supportsVision()).toBe(false);
  });

  test("glm-3-turbo does NOT support vision", () => {
    expect(new GLMModelDialect("glm-3-turbo").supportsVision()).toBe(false);
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

// ─── Group 2: resolveModelDialect selects GLMModelDialect ─────────────────────

describe("resolveModelDialect — GLM routing", () => {
  test("selects GLMModelDialect for glm-5", () => {
    const adapter = resolveModelDialect("glm-5");

    expect(adapter.getName()).toBe("GLMModelDialect");
  });

  test("selects GLMModelDialect for glm-4-long", () => {
    const adapter = resolveModelDialect("glm-4-long");

    expect(adapter.getName()).toBe("GLMModelDialect");
  });

  test("does NOT select GLMModelDialect for gpt-4o", () => {
    const adapter = resolveModelDialect("gpt-4o");

    expect(adapter.getName()).not.toBe("GLMModelDialect");
  });

  test("needsTransformation returns true for GLM models", () => {
    const adapter = resolveModelDialect("glm-5");
    expect(adapter.getName() !== "DefaultAPIFormat").toBe(true);
  });
});

// ─── Group 3: Three-layer adapter architecture ───────────────────────────────
//
// When a format adapter (LiteLLMAPIFormat) is the explicit adapter, the model
// dialect (GLMModelDialect) should still be resolved by resolveModelDialect for
// model-specific concerns.

describe("Three-layer adapter — model dialect overrides format adapter", () => {
  test("resolveModelDialect resolves GLMModelDialect even when LiteLLMAPIFormat would be used", () => {
    // Simulate what ComposedHandler does:
    // 1. Explicit adapter = LiteLLMAPIFormat (L1 wire format)
    // 2. resolveModelDialect() = GLMModelDialect (L2 model quirks)
    const litellmAdapter = new LiteLLMAPIFormat("glm-5", "https://example.com");
    const modelAdapter = resolveModelDialect("glm-5");

    // Format adapter handles wire format / transport
    expect(litellmAdapter.getName()).toBe("LiteLLMAPIFormat");

    // Model dialect handles model-specific concerns
    expect(modelAdapter.getName()).toBe("GLMModelDialect");
    expect(modelAdapter.getContextWindow()).toBe(80_000);
    expect(modelAdapter.supportsVision()).toBe(true);
  });

  test("LiteLLMAPIFormat returns generic defaults (model adapter should override)", () => {
    const litellmAdapter = new LiteLLMAPIFormat("glm-5", "https://example.com");

    // LiteLLMAPIFormat returns generic 200K — model adapter should win
    expect(litellmAdapter.getContextWindow()).toBe(200_000);
  });

  test("model dialect provides correct context window for glm-4-long via LiteLLM", () => {
    const modelAdapter = resolveModelDialect("glm-4-long");

    expect(modelAdapter.getName()).toBe("GLMModelDialect");
    expect(modelAdapter.getContextWindow()).toBe(1_000_000);
  });

  test("model dialect correctly reports no vision for glm-4-flash via LiteLLM", () => {
    const modelAdapter = resolveModelDialect("glm-4-flash");

    expect(modelAdapter.getName()).toBe("GLMModelDialect");
    expect(modelAdapter.supportsVision()).toBe(false);
  });

  test("non-GLM model via LiteLLM falls back to DefaultAPIFormat", () => {
    const modelAdapter = resolveModelDialect("some-unknown-model");

    // Should be DefaultAPIFormat, not GLMModelDialect
    expect(modelAdapter.getName()).toBe("DefaultAPIFormat");
  });

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
