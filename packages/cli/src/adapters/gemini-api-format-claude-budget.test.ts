import { describe, expect, test } from "bun:test";
import { GeminiAPIFormat } from "./gemini-api-format.js";

interface ThinkingPayload {
  generationConfig: {
    thinkingConfig?: {
      thinkingBudget?: number;
    };
  };
}

function buildThinkingPayload(modelId: string, maxTokens: number, effort: string): ThinkingPayload {
  return new GeminiAPIFormat(modelId, undefined, { thinkingFromModelName: true }).buildPayload(
    { max_tokens: maxTokens, output_config: { effort } },
    [],
    []
  ) as ThinkingPayload;
}

describe("Claude thinking budget below max_tokens", () => {
  // Mutation target: gemini-api-format.ts:303-307. Returning the original
  // effort budget instead of the fitted value breaks the first, second and fourth cases.
  test.each([
    [16000, "high", 8000],
    [8000, "medium", 4000],
    [32000, "high", 16384],
  ])("fits Claude max_tokens=%d effort=%s to %d", (maxTokens, effort, expected) => {
    expect(
      buildThinkingPayload("claude-sonnet-4-6", maxTokens, effort).generationConfig.thinkingConfig
        ?.thinkingBudget
    ).toBe(expected);
  });

  test("omits thinking when half the Claude output cap is below its minimum", () => {
    expect(
      buildThinkingPayload("claude-sonnet-4-6", 1500, "high").generationConfig.thinkingConfig
    ).toBeUndefined();
  });

  test("does not apply the Claude cap rule to Gemini", () => {
    expect(
      buildThinkingPayload("gemini-2.5-flash", 8000, "medium").generationConfig.thinkingConfig
        ?.thinkingBudget
    ).toBe(8192);
  });
});
