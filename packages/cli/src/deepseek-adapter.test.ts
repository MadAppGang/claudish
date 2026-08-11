/**
 * Tests for DeepSeekModelDialect.
 *
 * Validates:
 * 1. Model detection for the deepseek family (incl. cluster bare names)
 * 2. prepareRequest strips the unsupported `thinking` param (DeepSeek thinks automatically)
 * 3. preserveThinkingInHistory()=true — the regression guard for the HTTP 400
 *    "reasoning_content must be passed back" bug (po-2025, 2026-08-11)
 * 4. DialectManager resolves DeepSeekModelDialect, and the capability is opt-in
 *    (GLM/default return false) — proving the history-strip gate is selective
 */

import { describe, test, expect } from "bun:test";
import { DeepSeekModelDialect } from "./adapters/deepseek-model-dialect.js";
import { GLMModelDialect } from "./adapters/glm-model-dialect.js";
import { DialectManager } from "./adapters/dialect-manager.js";

// ─── Group 1: DeepSeekModelDialect model detection ──────────────────────────

describe("DeepSeekModelDialect — Model Detection", () => {
  const adapter = new DeepSeekModelDialect("deepseek-v4-flash");

  test("should handle deepseek-v4-flash", () => {
    expect(adapter.shouldHandle("deepseek-v4-flash")).toBe(true);
  });

  test("should handle deepseek-v4-pro", () => {
    expect(adapter.shouldHandle("deepseek-v4-pro")).toBe(true);
  });

  test("should handle deepseek-r1", () => {
    expect(adapter.shouldHandle("deepseek-r1")).toBe(true);
  });

  test("should handle deepseek/ prefixed models", () => {
    expect(adapter.shouldHandle("deepseek/deepseek-v4-flash")).toBe(true);
  });

  test("should NOT handle non-deepseek models", () => {
    expect(adapter.shouldHandle("glm-5")).toBe(false);
    expect(adapter.shouldHandle("qwen3.8-max")).toBe(false);
    expect(adapter.shouldHandle("gpt-4o")).toBe(false);
    expect(adapter.shouldHandle("kimi-k2.5")).toBe(false);
  });

  test("should return correct adapter name", () => {
    expect(adapter.getName()).toBe("DeepSeekModelDialect");
  });
});

// ─── Group 2: prepareRequest strips unsupported thinking param ──────────────

describe("DeepSeekModelDialect — prepareRequest", () => {
  test("strips thinking param from request (DeepSeek thinks automatically)", () => {
    const adapter = new DeepSeekModelDialect("deepseek-v4-flash");
    const request = { model: "deepseek-v4-flash", thinking: { budget: 10000 }, messages: [] };
    const original = { thinking: { budget: 10000 } };

    adapter.prepareRequest(request, original);

    expect(request.thinking).toBeUndefined();
  });

  test("leaves request unchanged without thinking param", () => {
    const adapter = new DeepSeekModelDialect("deepseek-v4-flash");
    const request = { model: "deepseek-v4-flash", messages: [] };
    const original = {};

    adapter.prepareRequest(request, original);

    expect(request.model).toBe("deepseek-v4-flash");
    expect(request.messages).toEqual([]);
  });
});

// ─── Group 3: preserveThinkingInHistory — the 400 regression guard ─────────
//
// ComposedHandler strips thinking blocks from message history by default to
// protect anthropic-transport providers (GLM/MiniMax) from Anthropic thinking
// signatures. DeepSeek REQUIRES its reasoning echoed back as reasoning_content
// on every assistant turn; stripping the block makes the OpenAI-format converter
// omit reasoning_content → HTTP 400. So DeepSeek opts OUT of the strip.

describe("DeepSeekModelDialect — preserveThinkingInHistory (400 regression)", () => {
  test("DeepSeek opts out of the history thinking-strip", () => {
    const adapter = new DeepSeekModelDialect("deepseek-v4-flash");
    expect(adapter.preserveThinkingInHistory()).toBe(true);
  });

  test("GLM keeps the default strip (capability is opt-in, not blanket)", () => {
    const adapter = new GLMModelDialect("glm-5");
    expect(adapter.preserveThinkingInHistory()).toBe(false);
  });
});

// ─── Group 4: DialectManager resolution ─────────────────────────────────────

describe("DialectManager — DeepSeek routing", () => {
  test("selects DeepSeekModelDialect for deepseek-v4-flash", () => {
    const manager = new DialectManager("deepseek-v4-flash");
    const adapter = manager.getAdapter();
    expect(adapter.getName()).toBe("DeepSeekModelDialect");
    // The capability must survive DialectManager resolution — ComposedHandler
    // reads it off this resolved adapter via this.modelAdapter.
    expect(adapter.preserveThinkingInHistory()).toBe(true);
  });

  test("GLM via DialectManager still strips (false)", () => {
    const manager = new DialectManager("glm-5");
    const adapter = manager.getAdapter();
    expect(adapter.preserveThinkingInHistory()).toBe(false);
  });
});
