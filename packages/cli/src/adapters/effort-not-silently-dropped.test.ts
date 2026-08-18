/**
 * Structural guard against model/version gates that silently discard Claude
 * Code's requested reasoning effort when a provider ships a new model.
 */

import { beforeEach, expect, test } from "bun:test";
import { readAllModelsCache } from "../providers/all-models-cache.js";
import { DeepSeekModelDialect } from "./deepseek-model-dialect.js";
import { resolveModelDialect } from "./dialect-manager.js";
import { resetReasoningEffortMemo } from "./grok-effort-support.js";
import { GrokModelDialect } from "./grok-model-dialect.js";

beforeEach(() => {
  resetReasoningEffortMemo();
});

const hostedCatalog = readAllModelsCache();
const hostedEntries = hostedCatalog?.entries ?? [];

interface EffortBearingRequest {
  reasoning_effort?: unknown;
  thinking?: unknown;
  enable_thinking?: unknown;
  thinking_budget?: unknown;
  effort?: unknown;
  reasoning?: { effort?: unknown };
  generationConfig?: {
    thinkingConfig?: {
      thinkingLevel?: unknown;
      thinkingBudget?: unknown;
    };
  };
}

function emitsNativeEffortSignal(result: EffortBearingRequest | null | undefined): boolean {
  return (
    result?.reasoning_effort !== undefined ||
    result?.thinking !== undefined ||
    result?.enable_thinking !== undefined ||
    result?.thinking_budget !== undefined ||
    result?.effort !== undefined ||
    result?.reasoning?.effort !== undefined ||
    result?.generationConfig?.thinkingConfig?.thinkingLevel !== undefined ||
    result?.generationConfig?.thinkingConfig?.thinkingBudget !== undefined
  );
}

if (hostedEntries.length === 0) {
  test.skip("hosted catalog effort guard — skipped because readAllModelsCache() returned no entries; warm the hosted model cache to run it", () => {});
} else {
  test("every effort-controlled catalog model's dialect emits an effort signal on the native wire", () => {
    const failures: string[] = [];
    const effortControlled = hostedEntries.filter(
      (entry) => entry.reasoning?.supported === true && entry.reasoning.control === "effort"
    );

    for (const entry of effortControlled) {
      const dialect = resolveModelDialect(entry.modelId);
      const dialectName = dialect.getName();

      // Layer-1 format converters own effort for models with no Layer-2 dialect.
      if (dialectName === "DefaultAPIFormat") continue;

      // Gemini and Codex emit their native knobs while building the payload;
      // model dialects emit theirs while preparing it. Exercise both stages and
      // inspect the final native-wire request so neither can mask the other.
      const originalRequest = { messages: [], output_config: { effort: "low" } };
      const nativeRequest = dialect.buildPayload(originalRequest, [], []);
      const result = dialect.prepareRequest(nativeRequest, originalRequest);

      if (!emitsNativeEffortSignal(result)) {
        failures.push(
          `Model "${entry.modelId}" resolves to dialect "${dialectName}" and advertises efforts ${JSON.stringify(
            entry.reasoning?.efforts ?? []
          )}, but the dialect is silently dropping the user's effort setting on the default (native) wire.`
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(`Catalog effort regression guard failed:\n${failures.join("\n")}`);
    }
  });
}

test("future Grok and DeepSeek model-name fallbacks are rules, not version pins", () => {
  const highEffort = { output_config: { effort: "high" } };

  const futureGrok = new GrokModelDialect("grok-9-experimental").prepareRequest(
    { messages: [] },
    highEffort
  );
  expect(futureGrok.reasoning_effort).toBeDefined();

  for (const modelId of ["deepseek-v5", "deepseek-v9-reasoner"]) {
    const result = new DeepSeekModelDialect(modelId).prepareRequest({ messages: [] }, highEffort);
    expect(result.reasoning_effort).toBeDefined();
  }

  for (const modelId of ["deepseek-v3.2", "deepseek-r1"]) {
    const result = new DeepSeekModelDialect(modelId).prepareRequest({ messages: [] }, highEffort);
    expect(result.reasoning_effort).toBeUndefined();
  }
});
