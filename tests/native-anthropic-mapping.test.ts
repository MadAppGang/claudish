/**
 * Tests for native Anthropic model detection (hasNativeAnthropicMapping).
 *
 * When model mappings include native Anthropic models (claude-*) alongside
 * alternative providers, Claudish must use real Claude Code subscription
 * credentials instead of placeholder tokens.
 */

import { describe, test, expect } from "bun:test";
import { parseModelSpec } from "../src/providers/model-parser.js";

describe("Native Anthropic mapping detection", () => {
  describe("native anthropic model identification", () => {
    test("claude-3-opus-20240229 is native-anthropic", () => {
      expect(parseModelSpec("claude-3-opus-20240229").provider).toBe("native-anthropic");
    });

    test("claude-sonnet-4-5-20250929 is native-anthropic", () => {
      expect(parseModelSpec("claude-sonnet-4-5-20250929").provider).toBe("native-anthropic");
    });

    test("claude-3-5-sonnet-20241022 is native-anthropic", () => {
      expect(parseModelSpec("claude-3-5-sonnet-20241022").provider).toBe("native-anthropic");
    });

    test("claude-opus-4-20250514 is native-anthropic", () => {
      expect(parseModelSpec("claude-opus-4-20250514").provider).toBe("native-anthropic");
    });
  });

  describe("alternative models are NOT native-anthropic", () => {
    test("x-ai/grok-code-fast-1", () => {
      expect(parseModelSpec("x-ai/grok-code-fast-1").provider).not.toBe("native-anthropic");
    });

    test("google@gemini-2.5-pro", () => {
      expect(parseModelSpec("google@gemini-2.5-pro").provider).not.toBe("native-anthropic");
    });

    test("minimax/minimax-m2", () => {
      expect(parseModelSpec("minimax/minimax-m2").provider).not.toBe("native-anthropic");
    });

    test("openrouter@anthropic/claude-3.5-sonnet routes to openrouter, not native", () => {
      expect(parseModelSpec("openrouter@anthropic/claude-3.5-sonnet").provider).toBe("openrouter");
    });
  });

  describe("hasNativeAnthropicMapping logic", () => {
    // Replicate the hasNativeAnthropicMapping logic to test it
    const hasNative = (models: (string | undefined)[]) =>
      models.some(m => m && parseModelSpec(m).provider === "native-anthropic");

    test("mixed mappings with one claude model = has native", () => {
      expect(hasNative([
        "claude-3-opus-20240229",
        "x-ai/grok-code-fast-1",
        "minimax/minimax-m2",
      ])).toBe(true);
    });

    test("all alternative models = no native", () => {
      expect(hasNative([
        "x-ai/grok-code-fast-1",
        "google@gemini-2.5-pro",
        "minimax/minimax-m2",
      ])).toBe(false);
    });

    test("all native models = has native", () => {
      expect(hasNative([
        "claude-3-opus-20240229",
        "claude-sonnet-4-5-20250929",
      ])).toBe(true);
    });

    test("undefined/missing models are skipped", () => {
      expect(hasNative([undefined, undefined, "x-ai/grok-code-fast-1"])).toBe(false);
    });

    test("all undefined = no native", () => {
      expect(hasNative([undefined, undefined, undefined])).toBe(false);
    });

    test("single native model among undefined = has native", () => {
      expect(hasNative([undefined, "claude-3-opus-20240229", undefined])).toBe(true);
    });
  });
});
