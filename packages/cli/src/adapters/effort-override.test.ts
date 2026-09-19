import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DiskCacheV3, writeAllModelsCache } from "../providers/all-models-cache.js";
import { GLMModelDialect } from "./glm-model-dialect.js";
import {
  type ReasoningCapability,
  lookupModelReasoning,
  lookupModelReasoningStatus,
} from "./model-catalog.js";

const MODEL_ID = "glm-effort-override-test";

class CatalogBackedGLMFormat extends GLMModelDialect {
  constructor(
    modelId: string,
    private readonly cachePath: string
  ) {
    super(modelId);
  }

  protected override lookupReasoningCapability(): ReasoningCapability | undefined {
    return lookupModelReasoning(this.getModelId(), this.cachePath);
  }

  /**
   * Redirected alongside the capability, and for the same reason: the dispatch
   * now reads the status first and emits nothing when the control is unknown.
   * Leaving this one pointed at the default would read the REAL cache on disk
   * while the capability came from this test's temp file — green on a machine
   * with a warm catalog, red on a clean one.
   */
  protected override lookupReasoningStatus(): "known" | "unknown" | undefined {
    return lookupModelReasoningStatus(this.getModelId(), this.cachePath);
  }
}

let tempDir = "";
let cachePath = "";
let format: CatalogBackedGLMFormat;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "claudish-effort-override-"));
  cachePath = join(tempDir, "all-models.json");
  const entries: DiskCacheV3["entries"] = [
    {
      modelId: MODEL_ID,
      aliases: [],

      reasoning: {
        supported: true,
        control: "effort",
        efforts: ["medium", "high"],
        defaultEffort: "medium",
      },
    },
  ];
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
  format = new CatalogBackedGLMFormat(MODEL_ID, cachePath);
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {}
  tempDir = "";
  cachePath = "";
});

function payloadFor(effort: string): Record<string, unknown> {
  return format.prepareRequest({}, { output_config: { effort } });
}

describe("BaseAPIFormat --effort override", () => {
  test("without an override, effort outside the advertised catalog set is clamped", () => {
    const payload = payloadFor("max");

    expect(payload.thinking).toEqual({ type: "enabled" });
    expect(payload.reasoning_effort).toBe("high");
  });

  test("setEffortOverride(max) skips the clamp for the same model and catalog entry", () => {
    expect(payloadFor("max").reasoning_effort).toBe("high");

    format.setEffortOverride("max");

    expect(payloadFor("max").reasoning_effort).toBe("max");
  });

  test("the override beats the request's own output_config.effort", () => {
    format.setEffortOverride("max");

    expect(payloadFor("low").reasoning_effort).toBe("max");
  });

  test("setEffortOverride(undefined) restores catalog-clamped behavior", () => {
    format.setEffortOverride("max");
    expect(payloadFor("max").reasoning_effort).toBe("max");

    format.setEffortOverride(undefined);

    expect(payloadFor("max").reasoning_effort).toBe("high");
  });
});
