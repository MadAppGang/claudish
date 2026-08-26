import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DiskCacheV2, writeAllModelsCache } from "../providers/all-models-cache.js";
import { GLMModelDialect } from "./glm-model-dialect.js";
import { type ReasoningCapability, lookupModelReasoning } from "./model-catalog.js";

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
}

let tempDir = "";
let cachePath = "";
let format: CatalogBackedGLMFormat;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "claudish-effort-override-"));
  cachePath = join(tempDir, "all-models.json");
  const entries: DiskCacheV2["entries"] = [
    {
      modelId: MODEL_ID,
      aliases: [],
      sources: {},
      reasoning: {
        supported: true,
        control: "effort",
        efforts: ["medium", "high"],
        defaultEffort: "medium",
      },
    },
  ];
  writeAllModelsCache({ entries }, cachePath);
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
