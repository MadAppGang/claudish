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

import { describe, test, expect, afterEach } from "bun:test";
import { GLMModelDialect } from "./adapters/glm-model-dialect.js";
import { DialectManager } from "./adapters/dialect-manager.js";
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

  test("should return correct adapter name", () => {
    expect(adapter.getName()).toBe("GLMModelDialect");
  });
});

// ─── prepareRequest — thinking control (CLAUDISH_GLM_THINKING) ───────────────
//
// The bug these pin: the dialect used to delete `thinking` unconditionally on
// the claim that "GLM doesn't support thinking params" — a GLM-4.x-era
// artifact. Probed 2026-08-20 against the gc@ Coding Plan (glm-5.3):
// `{"type":"enabled"/"disabled"}` is accepted, disabled genuinely stops
// reasoning (out 37→3 tokens on a trivial prompt), and budget_tokens is
// tolerated but ignored (GLM is binary). Without this, no lever existed to
// stop GLM thinking during a budget crunch.

const ORIGINAL_GLM_THINKING = process.env.CLAUDISH_GLM_THINKING;

afterEach(() => {
  if (ORIGINAL_GLM_THINKING === undefined) delete process.env.CLAUDISH_GLM_THINKING;
  else process.env.CLAUDISH_GLM_THINKING = ORIGINAL_GLM_THINKING;
});

const ANTHROPIC = { wireFormat: "anthropic-sse" as const };
const OPENAI = { wireFormat: "openai-sse" as const };

describe("GLMModelDialect — prepareRequest (OpenAI wire, gc@ Coding Plan)", () => {
  test("passthrough (default): client ask becomes the documented shape, budget dropped", () => {
    delete process.env.CLAUDISH_GLM_THINKING;
    const request: any = {};
    new GLMModelDialect("glm-5.3").prepareRequest(
      request,
      { thinking: { type: "enabled", budget_tokens: 32000 } },
      OPENAI
    );
    // toEqual (not objectContaining): the budget key must be absent — it is
    // inert upstream and the documented shape is type-only.
    expect(request.thinking).toEqual({ type: "enabled" });
  });

  test("passthrough with no client ask sends no thinking field (GLM default: enabled)", () => {
    delete process.env.CLAUDISH_GLM_THINKING;
    const request: any = { model: "glm-5.3", messages: [] };
    new GLMModelDialect("glm-5.3").prepareRequest(request, {}, OPENAI);
    expect(request.thinking).toBeUndefined();
    expect(request.model).toBe("glm-5.3");
    expect(request.messages).toEqual([]);
  });

  test("disabled policy forces it off even when the client asked", () => {
    process.env.CLAUDISH_GLM_THINKING = "disabled";
    const request: any = { thinking: { type: "enabled", budget_tokens: 8000 } };
    new GLMModelDialect("glm-5.3").prepareRequest(
      request,
      { thinking: { type: "enabled", budget_tokens: 8000 } },
      OPENAI
    );
    expect(request.thinking).toEqual({ type: "disabled" });
  });

  test("scrubs a stale anthropic-shaped thinking on the payload when the client sent nothing", () => {
    delete process.env.CLAUDISH_GLM_THINKING;
    const request: any = { thinking: { type: "enabled", budget_tokens: 9000 } };
    new GLMModelDialect("glm-5.3").prepareRequest(request, {}, OPENAI);
    expect(request.thinking).toBeUndefined();
  });

  test("unrecognized policy value falls back to passthrough (today's behavior), not disabled", () => {
    // Unlike Qwen — whose unset default means "think at length" — GLM's safe
    // default is passthrough: an unrecognized value must not change traffic.
    process.env.CLAUDISH_GLM_THINKING = "yes-please";
    const request: any = {};
    new GLMModelDialect("glm-5.3").prepareRequest(
      request,
      { thinking: { type: "enabled", budget_tokens: 1000 } },
      OPENAI
    );
    expect(request.thinking).toEqual({ type: "enabled" });
  });

  test("with no wire hint at all, behaves like the OpenAI wire (historical default)", () => {
    // Callers that predate PrepareRequestContext must not change behavior.
    delete process.env.CLAUDISH_GLM_THINKING;
    const request: any = { thinking: { budget: 10000 } };
    new GLMModelDialect("glm-5.3").prepareRequest(request, { thinking: { budget: 10000 } });
    expect(request.thinking).toEqual({ type: "enabled" });
  });
});

describe("GLMModelDialect — prepareRequest (anthropic wire, zai@ direct)", () => {
  test("passthrough keeps the historical strip (wire unprobed, no fleet traffic)", () => {
    delete process.env.CLAUDISH_GLM_THINKING;
    const request: any = { thinking: { type: "enabled", budget_tokens: 4096 } };
    new GLMModelDialect("glm-5.3").prepareRequest(
      request,
      { thinking: { type: "enabled", budget_tokens: 4096 } },
      ANTHROPIC
    );
    expect(request.thinking).toBeUndefined();
  });

  test("disabled policy sets the native disable form", () => {
    process.env.CLAUDISH_GLM_THINKING = "disabled";
    const request: any = {};
    new GLMModelDialect("glm-5.3").prepareRequest(request, {}, ANTHROPIC);
    expect(request.thinking).toEqual({ type: "disabled" });
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

describe("DialectManager — GLM routing", () => {
  test("selects GLMModelDialect for glm-5", () => {
    const manager = new DialectManager("glm-5");
    const adapter = manager.getAdapter();

    expect(adapter.getName()).toBe("GLMModelDialect");
  });

  test("selects GLMModelDialect for glm-4-long", () => {
    const manager = new DialectManager("glm-4-long");
    const adapter = manager.getAdapter();

    expect(adapter.getName()).toBe("GLMModelDialect");
  });

  test("does NOT select GLMModelDialect for gpt-4o", () => {
    const manager = new DialectManager("gpt-4o");
    const adapter = manager.getAdapter();

    expect(adapter.getName()).not.toBe("GLMModelDialect");
  });

  test("needsTransformation returns true for GLM models", () => {
    const manager = new DialectManager("glm-5");
    expect(manager.needsTransformation()).toBe(true);
  });
});

// ─── Group 3: Three-layer adapter architecture ───────────────────────────────
//
// When a format adapter (LiteLLMAPIFormat) is the explicit adapter, the model
// dialect (GLMModelDialect) should still be resolved by DialectManager for
// model-specific concerns.

describe("Three-layer adapter — model dialect overrides format adapter", () => {
  test("DialectManager resolves GLMModelDialect even when LiteLLMAPIFormat would be used", () => {
    // Simulate what ComposedHandler does:
    // 1. Explicit adapter = LiteLLMAPIFormat (L1 wire format)
    // 2. DialectManager.getAdapter() = GLMModelDialect (L2 model quirks)
    const litellmAdapter = new LiteLLMAPIFormat("glm-5", "https://example.com");
    const adapterManager = new DialectManager("glm-5");
    const modelAdapter = adapterManager.getAdapter();

    // Format adapter handles wire format / transport
    expect(litellmAdapter.getName()).toBe("LiteLLMAPIFormat");

    // Model dialect handles model-specific concerns
    expect(modelAdapter.getName()).toBe("GLMModelDialect");
  });

  test("model dialect resolves GLMModelDialect for glm-4-long via LiteLLM", () => {
    const adapterManager = new DialectManager("glm-4-long");
    const modelAdapter = adapterManager.getAdapter();

    expect(modelAdapter.getName()).toBe("GLMModelDialect");
  });

  test("model dialect resolves GLMModelDialect for glm-4-flash via LiteLLM", () => {
    const adapterManager = new DialectManager("glm-4-flash");
    const modelAdapter = adapterManager.getAdapter();

    expect(modelAdapter.getName()).toBe("GLMModelDialect");
  });

  test("non-GLM model via LiteLLM falls back to DefaultAPIFormat", () => {
    const adapterManager = new DialectManager("some-unknown-model");
    const modelAdapter = adapterManager.getAdapter();

    // Should be DefaultAPIFormat, not GLMModelDialect
    expect(modelAdapter.getName()).toBe("DefaultAPIFormat");
  });

  test("model dialect translates thinking, format adapter does not", () => {
    const litellmAdapter = new LiteLLMAPIFormat("glm-5", "https://example.com");
    const adapterManager = new DialectManager("glm-5");
    const modelAdapter = adapterManager.getAdapter();

    // Format adapter does not touch thinking (no override)
    const request1 = { model: "glm-5", thinking: { budget: 10000 }, messages: [] };
    litellmAdapter.prepareRequest(request1, { thinking: { budget: 10000 } });
    expect(request1.thinking).toBeDefined(); // LiteLLMAPIFormat doesn't touch thinking

    // Model dialect translates it to the documented GLM shape (no ctx → OpenAI wire)
    const request2: any = { model: "glm-5", thinking: { budget: 10000 }, messages: [] };
    modelAdapter.prepareRequest(request2, { thinking: { budget: 10000 } });
    expect(request2.thinking).toEqual({ type: "enabled" }); // GLMModelDialect translates it
  });
});
