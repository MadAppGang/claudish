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

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DiskCacheV3, writeAllModelsCache } from "../providers/all-models-cache.js";
import { type AdapterResult, BaseAPIFormat, type EffortLevel } from "./base-api-format.js";
import { DeepSeekModelDialect } from "./deepseek-model-dialect.js";
import { GeminiAPIFormat } from "./gemini-api-format.js";
import { GLMModelDialect } from "./glm-model-dialect.js";
import { GrokModelDialect } from "./grok-model-dialect.js";
import { MiniMaxModelDialect } from "./minimax-model-dialect.js";
import { lookupModelReasoning, lookupModelReasoningStatus } from "./model-catalog.js";
import { QwenModelDialect } from "./qwen-model-dialect.js";

const SYNTHETIC_FUGU_MODEL_ID = "fugu-acme-ultra";

const cacheDir = mkdtempSync(join(tmpdir(), "effort-mapping-"));
const cachePath = join(cacheDir, "catalog.json");
afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));
function seedDefaultCatalog(entries: DiskCacheV3["entries"]): () => void {
  writeAllModelsCache(
    {
      version: 3,
      catalogGenerationId: "test-generation",
      lastUpdated: new Date().toISOString(),
      entries,
      models: [],
      plans: [],
    },
    cachePath
  );
  return () => rmSync(cachePath, { force: true });
}
class CatalogDeepSeek extends DeepSeekModelDialect {
  protected override lookupReasoningCapability() {
    return lookupModelReasoning(this.getModelId(), cachePath);
  }
  protected override lookupReasoningStatus() {
    return lookupModelReasoningStatus(this.getModelId(), cachePath);
  }
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
  let cleanupCatalog: (() => void) | undefined;

  beforeEach(() => {
    cleanupCatalog = seedDefaultCatalog([
      {
        modelId: "grok-4.3",
        aliases: [],
        reasoning: {
          supported: true,
          mandatory: false,
          control: "effort",
          efforts: ["none", "low", "medium", "high", "xhigh"],
          defaultEffort: "low",
        },
      },
    ]);
  });

  afterEach(() => {
    cleanupCatalog?.();
    cleanupCatalog = undefined;
  });

  test("grok-3-mini: low|high only (no none/medium)", () => {
    expect(grokEffort("grok-3-mini", { output_config: { effort: "none" } })).toBe("low");
    expect(grokEffort("grok-3-mini", { output_config: { effort: "medium" } })).toBe("low");
    expect(grokEffort("grok-3-mini", { output_config: { effort: "low" } })).toBe("low");
    expect(grokEffort("grok-3-mini", { output_config: { effort: "high" } })).toBe("high");
    expect(grokEffort("grok-3-mini", { output_config: { effort: "xhigh" } })).toBe("high");
  });

  test("grok-4.3: clamps into the catalog's none..xhigh ladder", () => {
    expect(grokEffort("grok-4.3", { output_config: { effort: "none" } })).toBe("none");
    expect(grokEffort("grok-4.3", { output_config: { effort: "medium" } })).toBe("medium");
    expect(grokEffort("grok-4.3", { output_config: { effort: "max" } })).toBe("xhigh");
  });

  test("grok-4-fast-reasoning is reasoning-capable", () => {
    expect(grokEffort("grok-4-fast-reasoning", { output_config: { effort: "medium" } })).toBe(
      "medium"
    );
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

class StubbedQwen extends QwenModelDialect {
  constructor(
    modelId: string,
    private readonly stub: any
  ) {
    super(modelId);
  }

  protected override lookupReasoningCapability(): any {
    return this.stub;
  }
}

function stubbedQwenPrep(modelId: string, stub: any, originalRequest: any): any {
  return new StubbedQwen(modelId, stub).prepareRequest({}, originalRequest);
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

  test("a laddered optional model maps minimal to the 1024-token floor below low", () => {
    const minimal = stubbedQwenPrep("qwen3-laddered", OPTIONAL_REASONING_LADDER, {
      output_config: { effort: "minimal" },
    });
    const low = stubbedQwenPrep("qwen3-laddered", OPTIONAL_REASONING_LADDER, {
      output_config: { effort: "low" },
    });

    expect(minimal.enable_thinking).toBe(true);
    expect(minimal.thinking_budget).toBe(1024);
    expect(low.thinking_budget).toBe(2048);
    expect(minimal.thinking_budget).toBeLessThan(low.thinking_budget);
  });

  test("max omits the budget (model max)", () => {
    const out = qwenPrep("qwen3-max", { output_config: { effort: "max" } });
    expect(out.enable_thinking).toBe(true);
    expect(out.thinking_budget).toBeUndefined();
  });

  test("mandatory ladder never sets enable_thinking false", () => {
    for (const effort of ["none", "minimal"] as const) {
      const out = stubbedQwenPrep("qwen3-mandatory", MANDATORY_REASONING_LADDER, {
        output_config: { effort },
      });
      expect(out.enable_thinking).toBe(true);
    }
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

  /**
   * The stub stands in for the WHOLE catalog answer, status included.
   *
   * Overriding only `lookupReasoningCapability` used to be enough, because the
   * dispatch read nothing else. It now reads the status FIRST and emits no
   * reasoning parameter at all when the control is not known — so a stub that
   * leaves the status unstubbed falls through to the real cache on disk, and
   * the test's answer depends on whether the developer's machine happens to
   * have a warm catalog. That is green locally and red in CI, which is exactly
   * how this surfaced.
   *
   * A supplied stub means "the catalog describes this model"; `undefined` means
   * "the catalog has no entry", which the two no-entry callers below rely on.
   */
  protected override lookupReasoningStatus(): "known" | "unknown" | undefined {
    return this.stub ? "known" : undefined;
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

const MANDATORY_REASONING_LADDER = {
  supported: true,
  control: "effort",
  mandatory: true,
  efforts: ["max", "high", "low"],
  defaultEffort: "max",
};

const OPTIONAL_REASONING_LADDER = {
  ...MANDATORY_REASONING_LADDER,
  mandatory: false,
};

const OPTIONAL_THINKING_TOGGLE = {
  supported: true,
  control: "toggle",
  mandatory: false,
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
    ["minimal", { type: "enabled" }, "high"], // A ladder makes minimal the floor, unlike none.
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

  test("a pinned minimal is clamped to GLM-5.2's advertised high floor", () => {
    const format = new StubbedGLM("glm-5.2", CATALOG["glm-5.2"]);
    format.setEffortOverride("minimal");

    const out = format.prepareRequest({}, { output_config: { effort: "max" } });

    expect(out.thinking).toEqual({ type: "enabled" });
    expect(out.reasoning_effort).toBe("high");
    expect(out.reasoning_effort).not.toBe("minimal");
  });

  test("a pinned depth level remains a verbatim escape hatch", () => {
    const format = new StubbedGLM("glm-5.2", CATALOG["glm-5.2"]);
    format.setEffortOverride("xhigh");

    const out = format.prepareRequest({}, { output_config: { effort: "minimal" } });

    expect(out.thinking).toEqual({ type: "enabled" });
    expect(out.reasoning_effort).toBe("xhigh");
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

describe("shared reasoning-off rule on the GLM wire", () => {
  test("mandatory ladder maps none and minimal to enabled low", () => {
    for (const effort of ["none", "minimal"] as const) {
      const out = stubbedGlmPrep("glm-5.3", MANDATORY_REASONING_LADDER, {
        output_config: { effort },
      });
      expect(out.thinking).toEqual({ type: "enabled" });
      expect(out.reasoning_effort).toBe("low");
    }
  });

  test("optional ladder keeps none off but maps minimal to its lowest rung", () => {
    const none = stubbedGlmPrep("glm-optional-ladder", OPTIONAL_REASONING_LADDER, {
      output_config: { effort: "none" },
    });
    const minimal = stubbedGlmPrep("glm-optional-ladder", OPTIONAL_REASONING_LADDER, {
      output_config: { effort: "minimal" },
    });

    expect(none.thinking).toEqual({ type: "disabled" });
    expect(none.reasoning_effort).toBeUndefined();
    expect(minimal.thinking).toEqual({ type: "enabled" });
    expect(minimal.reasoning_effort).toBe("low");
    expect(minimal.thinking).not.toEqual(none.thinking);
  });

  test("toggle-only keeps none and minimal off", () => {
    const none = stubbedGlmPrep("glm-4.7", OPTIONAL_THINKING_TOGGLE, {
      output_config: { effort: "none" },
    });
    const minimal = stubbedGlmPrep("glm-4.7", OPTIONAL_THINKING_TOGGLE, {
      output_config: { effort: "minimal" },
    });
    const ladderMinimal = stubbedGlmPrep("glm-optional-ladder", OPTIONAL_REASONING_LADDER, {
      output_config: { effort: "minimal" },
    });

    expect(none.thinking).toEqual({ type: "disabled" });
    expect(minimal.thinking).toEqual({ type: "disabled" });
    // The matching toggle results are deliberate, not a collapse of minimal into none.
    expect(minimal.thinking).not.toEqual(ladderMinimal.thinking);
  });

  test("an Anthropic toggle whose lowest advertised rung is none turns minimal off", () => {
    const out = stubbedGlmPrep(
      "sakana-namazu",
      {
        supported: true,
        control: "toggle",
        mandatory: false,
        efforts: ["high", "none"],
      },
      { output_config: { effort: "minimal" } },
      {},
      "anthropic-sse"
    );

    expect(out.thinking).toEqual({ type: "disabled" });
  });

  test("an Anthropic mandatory ladder never emits the off switch for none or minimal", () => {
    for (const effort of ["none", "minimal"] as const) {
      const out = stubbedGlmPrep(
        "glm-5.3",
        MANDATORY_REASONING_LADDER,
        { output_config: { effort } },
        {},
        "anthropic-sse"
      );

      expect(out.thinking).toEqual({ type: "enabled" });
      expect(out.thinking).not.toEqual({ type: "disabled" });
      expect(out.output_config?.effort).toBe("low");
    }
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
  const fmt = new CatalogDeepSeek(modelId);
  return (fmt as any).prepareRequest({}, req);
}

class StubbedDeepSeek extends DeepSeekModelDialect {
  constructor(
    modelId: string,
    private readonly stub: any
  ) {
    super(modelId);
  }

  protected override lookupReasoningCapability(): any {
    return this.stub;
  }
}

function stubbedDsPrep(modelId: string, stub: any, originalRequest: any): any {
  return new StubbedDeepSeek(modelId, stub).prepareRequest({}, originalRequest);
}

describe("DeepSeek V4 reasoning_effort + thinking", () => {
  // Seed the catalog because the dialect consults it before its name rule.
  let cleanupCatalog: (() => void) | undefined;

  beforeEach(() => {
    cleanupCatalog = seedDefaultCatalog([
      {
        modelId: SYNTHETIC_FUGU_MODEL_ID,
        aliases: [],
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

  test("mandatory ladder never sends thinking disabled", () => {
    for (const effort of ["none", "minimal"] as const) {
      const out = stubbedDsPrep("deepseek-v4-mandatory", MANDATORY_REASONING_LADDER, {
        output_config: { effort },
      });
      expect(out.thinking).not.toEqual({ type: "disabled" });
      expect(out.reasoning_effort).toBe("low");
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
