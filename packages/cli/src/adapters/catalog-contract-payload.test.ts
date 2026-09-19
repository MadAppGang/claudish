import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CachedSubscriptionPlan,
  type DiskCacheV3,
  type ReasoningCapability,
  type SlimModelEntry,
  writeAllModelsCache,
} from "../providers/all-models-cache.js";
import { AnthropicAPIFormat } from "./anthropic-api-format.js";
import {
  ANSWER_TOKEN_RESERVE,
  type BaseAPIFormat,
  EFFORT_LEVELS,
  type EffortLevel,
  clampThinkingBudget,
  outputCeilingOf,
} from "./base-api-format.js";
import { resolveModelDialect } from "./dialect-manager.js";
import { lookupModelReasoning, lookupModelReasoningStatus } from "./model-catalog.js";

let tempDir = "";
let cachePath = "";

interface GeneratedPayload {
  model: string;
  max_tokens: number;
  thinking?: { type?: string; budget_tokens?: number };
  output_config?: { effort?: string };
  enable_thinking?: boolean;
  thinking_budget?: number;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "claudish-catalog-payload-"));
  cachePath = join(tempDir, "all-models.json");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
  cachePath = "";
});

function writeCatalog(entries: SlimModelEntry[], plans: CachedSubscriptionPlan[] = []): void {
  const cache: DiskCacheV3 = {
    catalogGenerationId: "test-generation",
    version: 3,
    lastUpdated: "2030-01-01T00:00:00.000Z",
    entries,
    models: [],
    plans,
  };
  writeAllModelsCache(cache, cachePath);
}

function entry(
  modelId: string,
  reasoningStatus: "known" | "unknown",
  reasoning?: ReasoningCapability,
  supportsThinking?: boolean
): SlimModelEntry {
  return {
    modelId,
    aliases: [],

    reasoningStatus,
    ...(reasoning ? { reasoning } : {}),
    ...(supportsThinking !== undefined ? { supportsThinking } : {}),
  };
}

/**
 * BaseAPIFormat has no cachePath constructor seam. Shadow only the resolved
 * instance's metadata readers so the production dialect logic reads this
 * test's temp cache without a process-wide module mock or real-cache write.
 */
function useTempCatalog(dialect: BaseAPIFormat, modelId: string): void {
  const withCatalogReaders = dialect as BaseAPIFormat & {
    lookupReasoningCapability(): ReasoningCapability | undefined;
    lookupReasoningStatus(): "known" | "unknown" | undefined;
  };
  withCatalogReaders.lookupReasoningCapability = () => lookupModelReasoning(modelId, cachePath);
  withCatalogReaders.lookupReasoningStatus = () => lookupModelReasoningStatus(modelId, cachePath);
}

/** Exact production sequence from ComposedHandler steps 4 and 5. */
function buildAnthropicPayload(
  modelId: string,
  effort: EffortLevel,
  maxTokens = 32_000
): GeneratedPayload {
  const claudeRequest = {
    model: "caller-model-is-replaced",
    messages: [],
    tools: [],
    max_tokens: maxTokens,
    output_config: { effort },
  };
  const converter = new AnthropicAPIFormat(modelId, "future-subscription-provider");
  const messages = converter.convertMessages(claudeRequest);
  const tools = converter.convertTools(claudeRequest);
  const payload = converter.buildPayload(claudeRequest, messages, tools);
  converter.prepareRequest(payload, claudeRequest);
  const dialect = resolveModelDialect(modelId, converter.getStreamFormat());
  useTempCatalog(dialect, modelId);
  dialect.prepareRequest(payload, claudeRequest);
  return payload;
}

/** Production path when Qwen's OpenAI-shaped dialect is also the converter. */
function buildNativeQwenPayload(effort: EffortLevel, maxTokens: number): GeneratedPayload {
  const modelId = "qwen4.2-nebula";
  const claudeRequest = {
    model: "caller-model-is-replaced",
    messages: [],
    tools: [],
    max_tokens: maxTokens,
    output_config: { effort },
  };
  const converter = resolveModelDialect(modelId);
  expect(converter.getStreamFormat()).toBe("openai-sse");
  const messages = converter.convertMessages(claudeRequest);
  const tools = converter.convertTools(claudeRequest);
  const payload = converter.buildPayload(claudeRequest, messages, tools);
  converter.prepareRequest(payload, claudeRequest);
  return payload;
}

function expectNoCompetingDepthKnobs(payload: GeneratedPayload): void {
  expect(
    payload.thinking?.budget_tokens !== undefined && payload.output_config?.effort !== undefined
  ).toBe(false);
}

describe("catalog-driven Anthropic request payloads", () => {
  test("unknown reasoning emits no knob at every effort, even with supportsThinking true", () => {
    writeCatalog(
      [entry("qwen3.8-max-preview", "unknown", undefined, true)],
      [
        {
          routeStatus: "supported",
          id: "future-plan",
          route: { routeId: "qwen", routeProfileId: "qwencloud-token-plan" },
          inclusions: [
            {
              kind: "provider_model",
              externalModelId: "qwen3.8-max",
              resolution: { status: "mapped", modelId: "qwen3.8-max-preview" },
            },
          ],
        },
      ]
    );

    for (const effort of EFFORT_LEVELS) {
      const payload = buildAnthropicPayload("qwen3.8-max", effort);
      expect(payload.model).toBe("qwen3.8-max");
      expect(payload.max_tokens).toBe(32_000);
      expect(payload.thinking).toBeUndefined();
      expect(payload.output_config?.effort).toBeUndefined();
      expectNoCompetingDepthKnobs(payload);
    }
  });

  test("uses canonical metadata without rewriting the inference wire id", () => {
    writeCatalog(
      [
        entry("qwen3.8-flash-canonical", "known", {
          supported: true,
          control: "effort",
          efforts: ["low", "high"],
        }),
      ],
      [
        {
          routeStatus: "supported",
          id: "future-plan",
          route: { routeId: "qwen", routeProfileId: "qwencloud-token-plan" },
          inclusions: [
            {
              kind: "provider_model",
              externalModelId: "qwen3.8-flash",
              resolution: { status: "mapped", modelId: "qwen3.8-flash-canonical" },
            },
          ],
        },
      ]
    );

    const payload = buildAnthropicPayload("qwen3.8-flash", "medium");

    expect(payload.model).toBe("qwen3.8-flash");
    expect(payload.thinking).toEqual({ type: "enabled" });
    expect(payload.output_config?.effort).toBe("high");
    expect(payload.thinking?.budget_tokens).toBeUndefined();
    expectNoCompetingDepthKnobs(payload);
  });

  test("effort control clamps into the advertised set and never emits a budget", () => {
    writeCatalog([
      entry("orion-effort-2030", "known", {
        supported: true,
        control: "effort",
        efforts: ["low", "high"],
      }),
    ]);

    const payload = buildAnthropicPayload("orion-effort-2030", "medium");

    expect(payload.thinking).toEqual({ type: "enabled" });
    expect(payload.output_config?.effort).toBe("high");
    expect(payload.thinking?.budget_tokens).toBeUndefined();
    expectNoCompetingDepthKnobs(payload);
  });

  test("effort control remains authoritative when budget tokens are also supported", () => {
    writeCatalog([
      entry("orion-hybrid-2030", "known", {
        supported: true,
        control: "effort",
        efforts: ["high", "max"],
        supportsBudgetTokens: true,
      }),
    ]);

    const payload = buildAnthropicPayload("orion-hybrid-2030", "xhigh");

    expect(payload.thinking).toEqual({ type: "enabled" });
    expect(payload.output_config?.effort).toBe("max");
    expect(payload.thinking?.budget_tokens).toBeUndefined();
    expectNoCompetingDepthKnobs(payload);
  });

  test("budget control never emits a budget at or above max_tokens", () => {
    writeCatalog([
      entry("orion-budget-2030", "known", {
        supported: true,
        control: "budget",
        supportsBudgetTokens: true,
      }),
    ]);

    for (const maxTokens of [4096, 8192, 32_000, 64_000]) {
      for (const effort of EFFORT_LEVELS) {
        const payload = buildAnthropicPayload("orion-budget-2030", effort, maxTokens);
        const budget = payload.thinking?.budget_tokens;

        expect(payload.max_tokens).toBe(maxTokens);
        expect(budget === undefined || budget < payload.max_tokens).toBe(true);
        expectNoCompetingDepthKnobs(payload);

        if (["low", "medium", "high", "xhigh"].includes(effort)) {
          expect(typeof budget).toBe("number");
          expect(budget).toBeLessThan(payload.max_tokens);
        } else {
          expect(budget).toBeUndefined();
        }
      }
    }
  });

  test("explicit unsupported reasoning disables thinking instead of behaving as unknown", () => {
    writeCatalog([
      entry("orion-no-reasoning-2030", "known", {
        supported: false,
        control: "none",
      }),
    ]);

    const payload = buildAnthropicPayload("orion-no-reasoning-2030", "max");

    expect(payload.thinking).toEqual({ type: "disabled" });
    expect(payload.output_config?.effort).toBeUndefined();
    expectNoCompetingDepthKnobs(payload);
  });
});

describe("reasoning budget ceiling helpers", () => {
  test("outputCeilingOf prefers the original request and supports every payload spelling", () => {
    expect(outputCeilingOf({ max_tokens: 4096 }, { max_completion_tokens: 8192 })).toBe(4096);
    expect(outputCeilingOf({}, { max_tokens: 8192 })).toBe(8192);
    expect(outputCeilingOf({}, { max_completion_tokens: 32_000 })).toBe(32_000);
    expect(outputCeilingOf({}, { max_output_tokens: 64_000 })).toBe(64_000);
    expect(outputCeilingOf({ max_tokens: 0 }, { max_tokens: Number.NaN })).toBeUndefined();
  });

  test("clampThinkingBudget preserves valid values, clamps oversized ones, and reports no-room", () => {
    expect(clampThinkingBudget(undefined, 4096)).toBeUndefined();
    expect(clampThinkingBudget(2048, undefined)).toBe(2048);
    expect(clampThinkingBudget(2048, 4096)).toBe(2048);
    expect(clampThinkingBudget(38_912, 32_000)).toBe(32_000 - ANSWER_TOKEN_RESERVE);
    expect(clampThinkingBudget(2048, 2047)).toBe("no-room");
    expect(clampThinkingBudget(2048, 2048)).toBe(1024);
  });
});

describe("Qwen native OpenAI-wire request payloads", () => {
  test("thinking_budget always stays below the request output ceiling", () => {
    for (const maxTokens of [4096, 8192, 32_000, 64_000]) {
      for (const effort of EFFORT_LEVELS) {
        const payload = buildNativeQwenPayload(effort, maxTokens);
        const budget = payload.thinking_budget;

        expect(payload.max_tokens).toBe(maxTokens);
        expect(budget === undefined || budget < payload.max_tokens).toBe(true);
      }
    }
  });

  test("cannot reproduce the rejected 32000 ceiling with a 38912 thinking budget", () => {
    const payload = buildNativeQwenPayload("xhigh", 32_000);

    expect(payload.max_tokens).toBe(32_000);
    expect(payload.enable_thinking).toBe(true);
    expect(payload.thinking_budget).toBe(32_000 - ANSWER_TOKEN_RESERVE);
    expect(payload.thinking_budget).toBeLessThan(payload.max_tokens);
    expect(payload.thinking_budget).not.toBe(38_912);
  });
});
