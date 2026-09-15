/**
 * Unified reasoning-effort mapping across all model dialects.
 *
 * Claude Code conveys effort via `output_config.effort` (none/minimal/low/
 * medium/high/xhigh/max), with a legacy `thinking.budget_tokens` (number)
 * fallback. Each provider accepts a different — often very narrow — subset of
 * native values, so this suite pins the per-dialect clamping that prevents 400s
 * (and silent-ignore footguns).
 *
 * These are request-side payload-shape assertions (no SSE). Mapping table source:
 * ai-docs/sessions/dev-research-reasoning-effort-20260629-010035-c1b698d0/report.md §3.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  ALL_MODELS_CACHE_PATH,
  type DiskCacheV2,
  writeAllModelsCache,
} from "../providers/all-models-cache.js";
import { type AdapterResult, BaseAPIFormat, type EffortLevel } from "./base-api-format.js";
import { CodexAPIFormat } from "./codex-api-format.js";
import { DeepSeekModelDialect } from "./deepseek-model-dialect.js";
import { GeminiAPIFormat } from "./gemini-api-format.js";
import { GLMModelDialect } from "./glm-model-dialect.js";
import { GrokModelDialect } from "./grok-model-dialect.js";
import { MiniMaxModelDialect } from "./minimax-model-dialect.js";
import { OpenAIAPIFormat } from "./openai-api-format.js";
import { QwenModelDialect } from "./qwen-model-dialect.js";

const SYNTHETIC_FUGU_MODEL_ID = "fugu-acme-ultra";

function seedDefaultCatalog(entries: DiskCacheV2["entries"]): () => void {
  const cacheDir = dirname(ALL_MODELS_CACHE_PATH);
  const cacheDirExisted = existsSync(cacheDir);
  const previousContents = existsSync(ALL_MODELS_CACHE_PATH)
    ? readFileSync(ALL_MODELS_CACHE_PATH, "utf-8")
    : null;

  writeAllModelsCache(
    {
      version: 2,
      lastUpdated: new Date().toISOString(),
      entries,
      models: [],
    },
    ALL_MODELS_CACHE_PATH
  );

  return () => {
    if (previousContents === null) {
      rmSync(ALL_MODELS_CACHE_PATH, { force: true });
      if (!cacheDirExisted) {
        try {
          rmdirSync(cacheDir);
        } catch {
          // Another test may have created something in the shared cache dir.
        }
      }
      return;
    }
    writeFileSync(ALL_MODELS_CACHE_PATH, previousContents, "utf-8");
  };
}

// ─── Part 1: shared resolveEffortLevel ────────────────────────────────────

/** Tiny concrete subclass exposing the protected resolver for direct testing. */
class TestFormat extends BaseAPIFormat {
  processTextContent(textContent: string): AdapterResult {
    return { cleanedText: textContent, extractedToolCalls: [], wasTransformed: false };
  }
  shouldHandle(): boolean {
    return false;
  }
  getName(): string {
    return "TestFormat";
  }
  resolve(originalRequest: any): EffortLevel | undefined {
    return this.resolveEffortLevel(originalRequest);
  }
}

describe("resolveEffortLevel (shared)", () => {
  const fmt = new TestFormat("any-model");

  test("output_config.effort wins for every canonical level", () => {
    for (const lvl of ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(fmt.resolve({ output_config: { effort: lvl } })).toBe(lvl);
    }
  });

  test("output_config.effort is case-insensitive", () => {
    expect(fmt.resolve({ output_config: { effort: "HIGH" } })).toBe("high");
    expect(fmt.resolve({ output_config: { effort: "XHigh" } })).toBe("xhigh");
  });

  test("unknown string level → undefined (let provider default)", () => {
    expect(fmt.resolve({ output_config: { effort: "ultra" } })).toBeUndefined();
  });

  test("output_config.effort takes priority over legacy budget", () => {
    expect(
      fmt.resolve({ output_config: { effort: "low" }, thinking: { budget_tokens: 40000 } })
    ).toBe("low");
  });

  test("legacy thinking.budget_tokens buckets", () => {
    expect(fmt.resolve({ thinking: { budget_tokens: 0 } })).toBe("none");
    expect(fmt.resolve({ thinking: { budget_tokens: -5 } })).toBe("none");
    expect(fmt.resolve({ thinking: { budget_tokens: 1000 } })).toBe("low");
    expect(fmt.resolve({ thinking: { budget_tokens: 8000 } })).toBe("medium");
    expect(fmt.resolve({ thinking: { budget_tokens: 20000 } })).toBe("high");
    expect(fmt.resolve({ thinking: { budget_tokens: 40000 } })).toBe("xhigh");
  });

  test("no effort signal → undefined", () => {
    expect(fmt.resolve({})).toBeUndefined();
    expect(fmt.resolve(undefined)).toBeUndefined();
    expect(fmt.resolve({ max_tokens: 100 })).toBeUndefined();
  });
});

// ─── Part 2A: OpenAI per-model gates ──────────────────────────────────────

function openaiEffort(modelId: string, effort: string): string | undefined {
  const fmt = new OpenAIAPIFormat(modelId);
  const payload = (fmt as any).buildChatCompletionsPayload(
    { output_config: { effort }, max_tokens: 100 },
    [],
    []
  );
  return payload.reasoning_effort;
}

describe("OpenAI gates", () => {
  test("o1-mini STRIPS reasoning_effort entirely (no param exists)", () => {
    expect(openaiEffort("o1-mini", "high")).toBeUndefined();
    expect(openaiEffort("o1-mini", "low")).toBeUndefined();
  });

  test("o-series (o3-mini) caps at high — xhigh/max clamp to high", () => {
    expect(openaiEffort("o3-mini", "xhigh")).toBe("high");
    expect(openaiEffort("o3-mini", "max")).toBe("high");
    expect(openaiEffort("o3-mini", "high")).toBe("high");
    expect(openaiEffort("o3-mini", "medium")).toBe("medium");
  });

  test("o-series rejects none/minimal → low", () => {
    expect(openaiEffort("o3-mini", "none")).toBe("low");
    expect(openaiEffort("o3-mini", "minimal")).toBe("low");
  });

  test("original GPT-5 accepts minimal; none → minimal; max → high (no xhigh)", () => {
    expect(openaiEffort("gpt-5", "minimal")).toBe("minimal");
    expect(openaiEffort("gpt-5", "none")).toBe("minimal");
    expect(openaiEffort("gpt-5", "xhigh")).toBe("high");
    expect(openaiEffort("gpt-5", "max")).toBe("high");
  });

  test("gpt-5.5 (5.1+) unchanged — pinned by reasoning-effort.test.ts", () => {
    expect(openaiEffort("gpt-5.5", "minimal")).toBe("low");
    expect(openaiEffort("gpt-5.5", "none")).toBe("none");
    expect(openaiEffort("gpt-5.5", "xhigh")).toBe("xhigh");
    expect(openaiEffort("gpt-5.5", "max")).toBe("xhigh");
  });
});

// ─── Part 2A (Sakana/Fugu): clamp-up via the OpenAI path ──────────────────

describe("Sakana Fugu (OpenAI-compatible path) clamps UP to high", () => {
  let cleanupCatalog: (() => void) | undefined;

  beforeEach(() => {
    cleanupCatalog = seedDefaultCatalog([
      {
        modelId: SYNTHETIC_FUGU_MODEL_ID,
        aliases: [],
        sources: {},
        reasoning: {
          supported: true,
          control: "effort",
          efforts: ["max", "xhigh", "high"],
          defaultEffort: "high",
        },
      },
    ]);
  });

  afterEach(() => {
    cleanupCatalog?.();
    cleanupCatalog = undefined;
  });

  test.each([
    ["fugu", "none", "high"],
    ["fugu", "minimal", "high"],
    ["fugu", "low", "high"],
    ["fugu", "medium", "high"],
    ["fugu", "high", "high"],
    ["fugu", "xhigh", "xhigh"],
    ["fugu", "max", "xhigh"],
    ["fugu-ultra", "low", "high"],
    // The synthetic catalog entry advertises `max`, so the catalog-driven clamp
    // passes it through. Without the fixture (or without catalog lookup), the
    // Fugu name fallback would normalise `max` down to `xhigh` and this fails.
    [SYNTHETIC_FUGU_MODEL_ID, "max", "max"],
    ["sakana/fugu-ultra-20260615", "medium", "high"],
  ])("%s effort '%s' → reasoning_effort '%s'", (model, input, expected) => {
    expect(openaiEffort(model, input)).toBe(expected);
  });
});

// ─── Part 2B: Codex (Responses API) ───────────────────────────────────────

function codexReasoning(modelId: string, req: any): any {
  const fmt = new CodexAPIFormat(modelId);
  return (fmt as any).buildPayload(req, [], []).reasoning;
}

describe("Codex reasoning.effort", () => {
  test("flows effort into reasoning.effort (not hardcoded medium)", () => {
    expect(codexReasoning("gpt-5-codex", { output_config: { effort: "high" } }).effort).toBe(
      "high"
    );
    expect(codexReasoning("gpt-5-codex", { output_config: { effort: "low" } }).effort).toBe("low");
  });

  test("default stays 'medium' when no effort signal", () => {
    expect(codexReasoning("gpt-5-codex", { max_tokens: 100 }).effort).toBe("medium");
  });

  test("codex drops minimal → low; no max (→high); xhigh→high off codex-max", () => {
    expect(codexReasoning("gpt-5-codex", { output_config: { effort: "minimal" } }).effort).toBe(
      "low"
    );
    expect(codexReasoning("gpt-5-codex", { output_config: { effort: "max" } }).effort).toBe("high");
    expect(codexReasoning("gpt-5-codex", { output_config: { effort: "xhigh" } }).effort).toBe(
      "high"
    );
  });

  test("codex-max accepts xhigh", () => {
    expect(codexReasoning("gpt-5.1-codex-max", { output_config: { effort: "xhigh" } }).effort).toBe(
      "xhigh"
    );
    expect(codexReasoning("gpt-5.1-codex-max", { output_config: { effort: "max" } }).effort).toBe(
      "xhigh"
    );
  });

  test("none → 'none' on gpt-5.1-codex family, 'low' on older codex", () => {
    expect(codexReasoning("gpt-5.1-codex", { output_config: { effort: "none" } }).effort).toBe(
      "none"
    );
    expect(codexReasoning("gpt-5-codex", { output_config: { effort: "none" } }).effort).toBe("low");
  });
});

// ─── Part 2C: Gemini ──────────────────────────────────────────────────────

function geminiThinkingConfig(modelId: string, req: any): any {
  const fmt = new GeminiAPIFormat(modelId);
  return (fmt as any).buildPayload(req, [], []).generationConfig.thinkingConfig;
}

describe("Gemini thinking config", () => {
  test("gemini-3 → thinkingLevel (string), NEVER a budget", () => {
    const cfg = geminiThinkingConfig("gemini-3-pro", { output_config: { effort: "high" } });
    expect(cfg.thinkingLevel).toBe("high");
    expect(cfg.thinkingBudget).toBeUndefined();
  });

  test("gemini-3 level mapping", () => {
    expect(
      geminiThinkingConfig("gemini-3-pro", { output_config: { effort: "none" } }).thinkingLevel
    ).toBe("minimal");
    expect(
      geminiThinkingConfig("gemini-3-pro", { output_config: { effort: "low" } }).thinkingLevel
    ).toBe("low");
    expect(
      geminiThinkingConfig("gemini-3-flash", { output_config: { effort: "medium" } }).thinkingLevel
    ).toBe("medium");
    expect(
      geminiThinkingConfig("gemini-3-pro", { output_config: { effort: "max" } }).thinkingLevel
    ).toBe("high");
  });

  test("gemini-2.5 → thinkingBudget (int), NEVER a level", () => {
    const cfg = geminiThinkingConfig("gemini-2.5-pro", { output_config: { effort: "high" } });
    expect(cfg.thinkingBudget).toBe(16384);
    expect(cfg.thinkingLevel).toBeUndefined();
  });

  test("gemini-2.5 budget tiers (capped at 24576)", () => {
    const b = (effort: string) =>
      geminiThinkingConfig("gemini-2.5-flash", { output_config: { effort } }).thinkingBudget;
    expect(b("none")).toBe(0);
    expect(b("minimal")).toBe(0);
    expect(b("low")).toBe(1024);
    expect(b("medium")).toBe(8192);
    expect(b("high")).toBe(16384);
    expect(b("xhigh")).toBe(24576);
    expect(b("max")).toBe(24576);
  });

  test("legacy thinking.budget_tokens still works (no output_config)", () => {
    const cfg = geminiThinkingConfig("gemini-2.5-pro", { thinking: { budget_tokens: 99999 } });
    expect(cfg.thinkingBudget).toBe(24576); // capped
  });
});

// ─── Part 2D: Grok ────────────────────────────────────────────────────────

function grokEffort(modelId: string, req: any): string | undefined {
  const fmt = new GrokModelDialect(modelId);
  (fmt as any).modelId = modelId;
  const out = (fmt as any).prepareRequest({}, req);
  return out.reasoning_effort;
}

describe("Grok reasoning_effort gates", () => {
  test("grok-3-mini: low|high only (no none/medium)", () => {
    expect(grokEffort("grok-3-mini", { output_config: { effort: "none" } })).toBe("low");
    expect(grokEffort("grok-3-mini", { output_config: { effort: "medium" } })).toBe("low");
    expect(grokEffort("grok-3-mini", { output_config: { effort: "low" } })).toBe("low");
    expect(grokEffort("grok-3-mini", { output_config: { effort: "high" } })).toBe("high");
    expect(grokEffort("grok-3-mini", { output_config: { effort: "xhigh" } })).toBe("high");
  });

  test("grok-4.3: none|low|medium|high", () => {
    expect(grokEffort("grok-4.3", { output_config: { effort: "none" } })).toBe("none");
    expect(grokEffort("grok-4.3", { output_config: { effort: "medium" } })).toBe("medium");
    expect(grokEffort("grok-4.3", { output_config: { effort: "max" } })).toBe("high");
  });

  test("grok-4-fast-reasoning is reasoning-capable", () => {
    expect(grokEffort("grok-4-fast-reasoning", { output_config: { effort: "medium" } })).toBe(
      "medium"
    );
  });

  test("grok-4 / grok-4-0709 STRIP (not on allowlist, param 400s)", () => {
    expect(grokEffort("grok-4", { output_config: { effort: "high" } })).toBeUndefined();
    expect(grokEffort("grok-4-0709", { output_config: { effort: "high" } })).toBeUndefined();
  });

  test("non-reasoning + grok-2 STRIP", () => {
    expect(
      grokEffort("grok-4-fast-non-reasoning", { output_config: { effort: "high" } })
    ).toBeUndefined();
    expect(grokEffort("grok-2", { output_config: { effort: "high" } })).toBeUndefined();
  });

  test("allowlist: grok-build-0.1 / grok-code-fast-1 STRIP (live-verified reject the param)", () => {
    // These matched no old deny pattern → wrongly got reasoning_effort → 400.
    // The allowlist flip strips them (they're not a known-accepting family).
    expect(grokEffort("grok-build-0.1", { output_config: { effort: "minimal" } })).toBeUndefined();
    expect(grokEffort("grok-code-fast-1", { output_config: { effort: "low" } })).toBeUndefined();
  });

  test("allowlist: grok-4.20 reasoning models STRIP despite grok-4.x shape (live-verified 400)", () => {
    // The decisive case for allowlist-over-denylist: grok-4.20 IS a reasoning
    // model and matches dot-decimal grok-4.x, yet the live API rejects the
    // param — only grok-4.3 accepts it. Naming can't gate this.
    expect(grokEffort("grok-4.20", { output_config: { effort: "high" } })).toBeUndefined();
    expect(
      grokEffort("grok-4.20-0309-reasoning", { output_config: { effort: "high" } })
    ).toBeUndefined();
  });

  test("an unknown/new grok model SENDS effort optimistically", () => {
    // Silently losing a supported capability is invisible; an unsupported
    // parameter produces a loud 400 that recoverFromRejection can repair once.
    expect(grokEffort("grok-9-experimental", { output_config: { effort: "high" } })).toBe("high");
  });

  test("raw thinking is always stripped", () => {
    const fmt = new GrokModelDialect("grok-4");
    const out = (fmt as any).prepareRequest({ thinking: { budget_tokens: 5 } }, {});
    expect(out.thinking).toBeUndefined();
  });
});

// ─── Part 2E: Qwen ────────────────────────────────────────────────────────

function qwenPrep(modelId: string, req: any): any {
  const fmt = new QwenModelDialect(modelId);
  return (fmt as any).prepareRequest({}, req);
}

describe("Qwen enable_thinking + thinking_budget", () => {
  test("none/minimal → enable_thinking false", () => {
    expect(qwenPrep("qwen3-max", { output_config: { effort: "none" } }).enable_thinking).toBe(
      false
    );
    expect(qwenPrep("qwen3-max", { output_config: { effort: "minimal" } }).enable_thinking).toBe(
      false
    );
  });

  test("high → enable_thinking true + budget 24576", () => {
    const out = qwenPrep("qwen3-max", { output_config: { effort: "high" } });
    expect(out.enable_thinking).toBe(true);
    expect(out.thinking_budget).toBe(24576);
  });

  test("budget tiers low/medium/xhigh", () => {
    expect(qwenPrep("qwen3-max", { output_config: { effort: "low" } }).thinking_budget).toBe(2048);
    expect(qwenPrep("qwen3-max", { output_config: { effort: "medium" } }).thinking_budget).toBe(
      8192
    );
    expect(qwenPrep("qwen3-max", { output_config: { effort: "xhigh" } }).thinking_budget).toBe(
      38912
    );
  });

  test("max omits the budget (model max)", () => {
    const out = qwenPrep("qwen3-max", { output_config: { effort: "max" } });
    expect(out.enable_thinking).toBe(true);
    expect(out.thinking_budget).toBeUndefined();
  });
});

// ─── Part 2F: GLM ─────────────────────────────────────────────────────────

function glmThinking(modelId: string, req: any): any {
  const fmt = new GLMModelDialect(modelId);
  return (fmt as any).prepareRequest({}, req).thinking;
}

class StubbedGLM extends GLMModelDialect {
  constructor(
    modelId: string,
    private readonly stub: any,
    wireFormat?: "anthropic-sse"
  ) {
    super(modelId, wireFormat);
  }

  protected override lookupReasoningCapability(): any {
    return this.stub;
  }
}

const CATALOG = {
  "glm-4.5-air": { supported: true, control: "toggle", mandatory: false },
  "glm-4.6": { supported: true, control: "toggle", mandatory: false },
  "glm-4.7": { supported: true, control: "toggle", mandatory: false },
  "glm-5": { supported: true, control: "toggle", mandatory: false },
  "glm-5.1": { supported: true, control: "toggle", mandatory: false },
  "glm-5.2": {
    supported: true,
    control: "effort",
    mandatory: false,
    efforts: ["max", "high"],
    defaultEffort: "max",
  },
  "glm-5.2-fast": {
    supported: true,
    control: "effort",
    efforts: ["max", "high"],
    defaultEffort: "max",
  },
  "glm-4-plus": undefined,
};

function stubbedGlmPrep(
  modelId: keyof typeof CATALOG | string,
  stub: any,
  originalRequest: any,
  request: any = {},
  wireFormat?: "anthropic-sse"
): any {
  return new StubbedGLM(modelId, stub, wireFormat).prepareRequest(request, originalRequest);
}

describe("GLM thinking toggle (hybrid 4.5/4.6)", () => {
  test("glm-4.6: low → enabled, none → disabled", () => {
    expect(glmThinking("glm-4.6", { output_config: { effort: "low" } })).toEqual({
      type: "enabled",
    });
    expect(glmThinking("glm-4.6", { output_config: { effort: "none" } })).toEqual({
      type: "disabled",
    });
  });

  test("glm-4.5 family: minimal → disabled, high → enabled", () => {
    expect(glmThinking("glm-4.5-air", { output_config: { effort: "minimal" } })).toEqual({
      type: "disabled",
    });
    expect(glmThinking("glm-4.5", { output_config: { effort: "high" } })).toEqual({
      type: "enabled",
    });
  });

  test("non-hybrid glm-4-plus strips thinking (no toggle)", () => {
    const fmt = new GLMModelDialect("glm-4-plus");
    const out = (fmt as any).prepareRequest(
      { thinking: { budget_tokens: 5 } },
      {
        output_config: { effort: "high" },
      }
    );
    expect(out.thinking).toBeUndefined();
  });
});

describe("GLM catalog-driven thinking toggles newer than 4.6", () => {
  // These models previously produced a STRIPPED `thinking` at every effort level.
  test.each(["glm-4.7", "glm-5", "glm-5.1"] as const)(
    "%s enables thinking at high without inventing a depth knob",
    (modelId) => {
      const out = stubbedGlmPrep(modelId, CATALOG[modelId], {
        output_config: { effort: "high" },
      });
      expect(out.thinking).toEqual({ type: "enabled" });
      expect(out.reasoning_effort).toBeUndefined();
    }
  );

  test.each(["glm-4.7", "glm-5", "glm-5.1"] as const)(
    "%s disables thinking at none and minimal",
    (modelId) => {
      for (const effort of ["none", "minimal"] as const) {
        const out = stubbedGlmPrep(modelId, CATALOG[modelId], {
          output_config: { effort },
        });
        expect(out.thinking).toEqual({ type: "disabled" });
      }
    }
  );
});

describe("GLM-5.2 catalog-driven reasoning_effort", () => {
  test.each([
    ["none", { type: "disabled" }, undefined],
    ["minimal", { type: "disabled" }, undefined],
    ["low", { type: "enabled" }, "high"],
    ["medium", { type: "enabled" }, "high"],
    ["high", { type: "enabled" }, "high"],
    ["xhigh", { type: "enabled" }, "max"],
    ["max", { type: "enabled" }, "max"],
  ] as const)(
    "effort %s maps to thinking %o and reasoning_effort %s",
    (effort, thinking, level) => {
      const out = stubbedGlmPrep("glm-5.2", CATALOG["glm-5.2"], {
        output_config: { effort },
      });
      expect(out.thinking).toEqual(thinking);
      expect(out.reasoning_effort).toBe(level);
    }
  );

  test("xhigh clamps upward to max when equidistant from high and max", () => {
    const out = stubbedGlmPrep("glm-5.2", CATALOG["glm-5.2"], {
      output_config: { effort: "xhigh" },
    });
    expect(out.thinking).toEqual({ type: "enabled" });
    expect(out.reasoning_effort).toBe("max");
  });

  test("glm-5.2-fast has the same effort mapping as glm-5.2", () => {
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      const regular = stubbedGlmPrep("glm-5.2", CATALOG["glm-5.2"], {
        output_config: { effort },
      });
      const fast = stubbedGlmPrep("glm-5.2-fast", CATALOG["glm-5.2-fast"], {
        output_config: { effort },
      });
      expect({ thinking: fast.thinking, reasoning_effort: fast.reasoning_effort }).toEqual({
        thinking: regular.thinking,
        reasoning_effort: regular.reasoning_effort,
      });
    }
  });

  test("disabling thinking deletes an incoming contradictory reasoning_effort", () => {
    const out = stubbedGlmPrep(
      "glm-5.2",
      CATALOG["glm-5.2"],
      { output_config: { effort: "none" } },
      { reasoning_effort: "xhigh" }
    );
    expect(out.thinking).toEqual({ type: "disabled" });
    expect(out.reasoning_effort).toBeUndefined();
  });
});

describe("GLM legacy stripping behavior", () => {
  test("glm-4-plus strips incoming thinking even with a high effort signal", () => {
    const out = stubbedGlmPrep(
      "glm-4-plus",
      CATALOG["glm-4-plus"],
      { output_config: { effort: "high" } },
      { thinking: { budget_tokens: 5 } }
    );
    expect(out.thinking).toBeUndefined();
  });

  test("glm-5.2 strips incoming thinking when there is no effort signal", () => {
    const out = stubbedGlmPrep(
      "glm-5.2",
      CATALOG["glm-5.2"],
      {},
      { thinking: { budget_tokens: 5 } }
    );
    expect(out.thinking).toBeUndefined();
  });
});

describe("GLM cold-cache version fallback", () => {
  test.each(["glm-6", "glm-6.2", "glm-5.9-turbo"])(
    "%s enables thinking for future GLM versions",
    (modelId) => {
      const out = stubbedGlmPrep(modelId, undefined, { output_config: { effort: "high" } });
      expect(out.thinking).toEqual({ type: "enabled" });
    }
  );

  test.each(["glm-4.4", "glm-4", "glm-4v-plus", "chatglm-3"])(
    "%s strips thinking for a pre-4.5 or non-versioned model",
    (modelId) => {
      const out = stubbedGlmPrep(
        modelId,
        undefined,
        { output_config: { effort: "high" } },
        { thinking: { budget_tokens: 5 } }
      );
      expect(out.thinking).toBeUndefined();
    }
  );

  test.each(["zhipu/glm-4.6", "z-ai/glm-4.7"])(
    "%s strips the vendor prefix before accepting the version",
    (modelId) => {
      const out = stubbedGlmPrep(modelId, undefined, { output_config: { effort: "high" } });
      expect(out.thinking).toEqual({ type: "enabled" });
    }
  );

  test("vendor-prefixed glm-4-plus is still stripped", () => {
    const out = stubbedGlmPrep(
      "zhipu/glm-4-plus",
      undefined,
      { output_config: { effort: "high" } },
      { thinking: { budget_tokens: 5 } }
    );
    expect(out.thinking).toBeUndefined();
  });
});

describe("GLM Anthropic wire reasoning stays separate", () => {
  test("glm-5.2 uses thinking plus output_config.effort, not reasoning_effort", () => {
    const out = stubbedGlmPrep(
      "glm-5.2",
      CATALOG["glm-5.2"],
      { output_config: { effort: "max" } },
      {},
      "anthropic-sse"
    );
    expect(out.thinking).toEqual({ type: "enabled" });
    expect(out.output_config).toEqual({ effort: "max" });
    expect(out.reasoning_effort).toBeUndefined();
  });
});

// ─── Part 2G: DeepSeek ────────────────────────────────────────────────────

function dsPrep(modelId: string, req: any): any {
  const fmt = new DeepSeekModelDialect(modelId);
  return (fmt as any).prepareRequest({}, req);
}

describe("DeepSeek V4 reasoning_effort + thinking", () => {
  // Seed the catalog because the dialect consults it before its name rule.
  let cleanupCatalog: (() => void) | undefined;

  beforeEach(() => {
    cleanupCatalog = seedDefaultCatalog([
      {
        modelId: SYNTHETIC_FUGU_MODEL_ID,
        aliases: [],
        sources: {},
      },
    ]);
  });

  afterEach(() => {
    cleanupCatalog?.();
    cleanupCatalog = undefined;
  });

  test("V4: low → high, medium → high, high → high", () => {
    expect(dsPrep("deepseek-v4-flash", { output_config: { effort: "low" } }).reasoning_effort).toBe(
      "high"
    );
    expect(
      dsPrep("deepseek-v4-flash", { output_config: { effort: "medium" } }).reasoning_effort
    ).toBe("high");
    expect(
      dsPrep("deepseek-v4-flash", { output_config: { effort: "high" } }).reasoning_effort
    ).toBe("high");
  });

  test("V4: xhigh → max, max → max", () => {
    expect(dsPrep("deepseek-v4", { output_config: { effort: "xhigh" } }).reasoning_effort).toBe(
      "max"
    );
    expect(dsPrep("deepseek-v4", { output_config: { effort: "max" } }).reasoning_effort).toBe(
      "max"
    );
  });

  test("V4: none/minimal → thinking disabled (no reasoning_effort)", () => {
    const none = dsPrep("deepseek-v4", { output_config: { effort: "none" } });
    expect(none.thinking).toEqual({ type: "disabled" });
    expect(none.reasoning_effort).toBeUndefined();
    const min = dsPrep("deepseek-chat", { output_config: { effort: "minimal" } });
    expect(min.thinking).toEqual({ type: "disabled" });
  });

  test("deepseek-chat / deepseek-reasoner are V4 aliases", () => {
    expect(dsPrep("deepseek-chat", { output_config: { effort: "low" } }).reasoning_effort).toBe(
      "high"
    );
    expect(dsPrep("deepseek-reasoner", { output_config: { effort: "max" } }).reasoning_effort).toBe(
      "max"
    );
  });

  test("legacy (deepseek-r1) strips, no reasoning_effort", () => {
    const out = dsPrep("deepseek-r1", {
      output_config: { effort: "high" },
      thinking: { budget_tokens: 5 },
    });
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.thinking).toBeUndefined();
  });

  test("catalog reasoning opinion overrides the V4 alias name rule", () => {
    // Mirrors the live catalog shape measured 2026-09-14: deepseek-chat
    // advertises supported:false, control:"none".
    const cleanupOpinionCatalog = seedDefaultCatalog([
      {
        modelId: "deepseek-chat",
        aliases: [],
        sources: {},
        reasoning: { supported: false, control: "none" },
      },
    ]);

    try {
      expect(
        dsPrep("deepseek-chat", { output_config: { effort: "low" } }).reasoning_effort
      ).toBeUndefined();
      expect(dsPrep("deepseek-chat", { thinking: { budget_tokens: 5 } }).thinking).toBeUndefined();
    } finally {
      cleanupOpinionCatalog();
    }
  });
});

// ─── Part 2H: MiniMax ─────────────────────────────────────────────────────

function minimaxThinking(modelId: string, req: any): any {
  const fmt = new MiniMaxModelDialect(modelId);
  return (fmt as any).prepareRequest({}, req).thinking;
}

describe("MiniMax thinking toggle (adaptive, not enabled)", () => {
  test("low → adaptive", () => {
    expect(minimaxThinking("minimax-m3", { output_config: { effort: "low" } })).toEqual({
      type: "adaptive",
    });
  });

  test("none → disabled", () => {
    expect(minimaxThinking("minimax-m3", { output_config: { effort: "none" } })).toEqual({
      type: "disabled",
    });
  });

  test("minimal/medium/high/max → adaptive (enable value is 'adaptive')", () => {
    for (const lvl of ["minimal", "medium", "high", "max"]) {
      expect(minimaxThinking("minimax-m2.5", { output_config: { effort: lvl } })).toEqual({
        type: "adaptive",
      });
    }
  });

  test("temperature clamp is preserved alongside effort mapping", () => {
    const fmt = new MiniMaxModelDialect("minimax-m3");
    const out = (fmt as any).prepareRequest(
      { temperature: 0 },
      { output_config: { effort: "low" } }
    );
    expect(out.temperature).toBe(0.01);
    expect(out.thinking).toEqual({ type: "adaptive" });
  });
});
