/**
 * Tests for native Anthropic model detection used in claude-runner.ts.
 * When model mappings include native claude-* models, claudish must preserve
 * real subscription credentials instead of setting placeholder tokens.
 */

import { describe, test, expect } from "bun:test";
import { parseModelSpec } from "./providers/model-parser.js";

// Replicate the hasNativeAnthropicMapping logic from claude-runner.ts
const hasNative = (models: (string | undefined)[]) =>
  models.some((m) => m && parseModelSpec(m).provider === "native-anthropic");

describe("Native Anthropic mapping detection", () => {
  describe("parseModelSpec identifies native claude models", () => {
    // Current model names
    test("claude-opus-4-6", () => {
      expect(parseModelSpec("claude-opus-4-6").provider).toBe("native-anthropic");
    });

    test("claude-sonnet-4-6", () => {
      expect(parseModelSpec("claude-sonnet-4-6").provider).toBe("native-anthropic");
    });

    test("claude-haiku-4-5-20251001", () => {
      expect(parseModelSpec("claude-haiku-4-5-20251001").provider).toBe("native-anthropic");
    });

    test("claude-fable-5-1", () => {
      expect(parseModelSpec("claude-fable-5-1").provider).toBe("native-anthropic");
    });

    // Legacy model names
    test("claude-3-opus-20240229", () => {
      expect(parseModelSpec("claude-3-opus-20240229").provider).toBe("native-anthropic");
    });

    test("claude-3-5-sonnet-20241022", () => {
      expect(parseModelSpec("claude-3-5-sonnet-20241022").provider).toBe("native-anthropic");
    });

    // Explicit anthropic/ prefix
    test("anthropic/claude-sonnet-4-6", () => {
      expect(parseModelSpec("anthropic/claude-sonnet-4-6").provider).toBe("native-anthropic");
    });
  });

  describe("non-native models are NOT native-anthropic", () => {
    test("grok via slash prefix", () => {
      expect(parseModelSpec("x-ai/grok-code-fast-1").provider).not.toBe("native-anthropic");
    });

    test("gemini via @ syntax", () => {
      expect(parseModelSpec("google@gemini-2.5-pro").provider).not.toBe("native-anthropic");
    });

    test("openrouter@ claude routes to openrouter, not native", () => {
      expect(parseModelSpec("openrouter@anthropic/claude-3.5-sonnet").provider).toBe("openrouter");
    });
  });

  describe("hasNativeAnthropicMapping logic", () => {
    test("mixed mappings with one claude model = has native", () => {
      expect(hasNative(["claude-opus-4-6", "x-ai/grok-code-fast-1", "google@gemini-2.5-pro"])).toBe(
        true
      );
    });

    test("all alternative models = no native", () => {
      expect(
        hasNative(["x-ai/grok-code-fast-1", "google@gemini-2.5-pro", "minimax/minimax-m2"])
      ).toBe(false);
    });

    test("undefined/missing models are skipped", () => {
      expect(hasNative([undefined, undefined, "x-ai/grok-code-fast-1"])).toBe(false);
    });

    test("all undefined = no native", () => {
      expect(hasNative([undefined, undefined, undefined])).toBe(false);
    });

    test("single native among undefined = has native", () => {
      expect(hasNative([undefined, "claude-opus-4-6", undefined])).toBe(true);
    });
  });
});
