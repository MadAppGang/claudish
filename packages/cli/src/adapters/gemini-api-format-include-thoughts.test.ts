import { describe, expect, test } from "bun:test";
import { GeminiAPIFormat } from "./gemini-api-format.js";

interface ThinkingPayload {
  generationConfig: { thinkingConfig?: Record<string, unknown> };
}

function antigravityPayload(modelId: string, request: Record<string, unknown>): ThinkingPayload {
  return new GeminiAPIFormat(modelId, undefined, { thinkingFromModelName: true }).buildPayload(
    { max_tokens: 32000, ...request },
    [],
    []
  ) as ThinkingPayload;
}

function thinkingConfig(modelId: string, request: Record<string, unknown>) {
  return antigravityPayload(modelId, request).generationConfig.thinkingConfig;
}

// Without includeThoughts the Antigravity server sends no byte while the model
// thinks, so a think longer than the request deadline reads as an unreachable
// host. The model id that is sent decides whether the model thinks, and it can
// carry an effort the request never named, so every Antigravity body asks for
// thoughts. Each case in this block fails when buildPayload stops writing the
// flag.
describe("every Antigravity body asks for thought summaries", () => {
  test("a thinkingLevel model carries includeThoughts beside the level", () => {
    expect(thinkingConfig("gemini-3-pro", { output_config: { effort: "medium" } })).toEqual({
      thinkingLevel: "medium",
      includeThoughts: true,
    });
  });

  test("a thinkingBudget model carries includeThoughts beside the budget", () => {
    expect(thinkingConfig("gemini-4-carbon", { output_config: { effort: "medium" } })).toEqual({
      thinkingBudget: 8192,
      includeThoughts: true,
    });
  });

  test("a request with no effort carries includeThoughts alone", () => {
    expect(thinkingConfig("gemini-4-carbon", {})).toEqual({ includeThoughts: true });
    expect(thinkingConfig("gemini-3-pro", {})).toEqual({ includeThoughts: true });
  });

  test("thinking disabled carries includeThoughts and no level or budget", () => {
    expect(thinkingConfig("gemini-4-carbon", { thinking: { type: "disabled" } })).toEqual({
      includeThoughts: true,
    });
  });

  test("an effort with no thinking budget carries includeThoughts and no budget", () => {
    expect(thinkingConfig("gemini-2.5-flash", { output_config: { effort: "none" } })).toEqual({
      includeThoughts: true,
    });
    expect(thinkingConfig("gemini-4-carbon", { output_config: { effort: "minimal" } })).toEqual({
      includeThoughts: true,
    });
  });
});

describe("Gemini routes that are not Antigravity", () => {
  test("write no thinkingConfig in buildPayload", () => {
    const payload = new GeminiAPIFormat("gemini-4-carbon").buildPayload(
      { max_tokens: 32000, output_config: { effort: "medium" } },
      [],
      []
    ) as ThinkingPayload;
    expect(payload.generationConfig.thinkingConfig).toBeUndefined();
  });
});
