import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAllModelsCache } from "../providers/all-models-cache.js";
import { catalogRouteForProvider } from "../providers/catalog-route-bindings.js";
import { lookupRouteReasoningMode, lookupVariantPresets } from "./model-catalog.js";

const BASE_MODEL_ID = "gpt-5.6-sol";
const VARIANT_MODEL_ID = "gpt-5.6-sol-pro";
const PROVIDER = "openrouter";
const PRESET = "reasoning.mode=pro";

let tempDir = "";
let cachePath = "";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "claudish-variant-presets-"));
  cachePath = join(tempDir, "all-models.json");
  writeAllModelsCache(
    {
      version: 3,
      catalogGenerationId: "test-generation",
      lastUpdated: new Date().toISOString(),
      models: [],
      plans: [],
      entries: [
        {
          modelId: BASE_MODEL_ID,
          aliases: ["openai/gpt-5.6-sol"],

          aggregators: [
            {
              sourceCollectorId: "test",
              routeStatus: "mapped",
              route: catalogRouteForProvider("openai"),
              sourceProviderId: "openai",
              externalModelId: BASE_MODEL_ID,
              confidence: "api_official",
              reasoning: {
                mode: {
                  status: "supported",
                  values: ["standard", "pro"],
                  default: "standard",
                },
              },
            },
            {
              sourceCollectorId: "test",
              routeStatus: "mapped",
              route: catalogRouteForProvider("openai-codex"),
              sourceProviderId: "openai-codex",
              externalModelId: BASE_MODEL_ID,
              confidence: "gateway_official",
              reasoning: { mode: { status: "rejected" } },
            },
            {
              sourceCollectorId: "test",
              routeStatus: "mapped",
              route: catalogRouteForProvider("opencode-zen"),
              sourceProviderId: "opencode-zen",
              externalModelId: BASE_MODEL_ID,
              confidence: "gateway_official",
              reasoning: { mode: { status: "unknown" } },
            },
          ],
        },
        {
          modelId: VARIANT_MODEL_ID,
          aliases: [],

          routeVariant: {
            kind: "provider-preset",
            baseModelId: BASE_MODEL_ID,
            provider: PROVIDER,
            preset: PRESET,
          },
        },
      ],
    },
    cachePath
  );
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {}
  tempDir = "";
  cachePath = "";
});

describe("lookupVariantPresets", () => {
  test("normalizes vendor-prefixed model ids without weakening provider scoping", () => {
    const expected = [{ modelId: VARIANT_MODEL_ID, preset: PRESET, provider: PROVIDER }];

    expect(lookupVariantPresets(BASE_MODEL_ID, PROVIDER, cachePath)).toEqual(expected);

    // The OpenRouter route passes the vendor-prefixed form; a raw compare made
    // the feature inert on precisely the route whose presets the catalog records.
    expect(lookupVariantPresets("openai/gpt-5.6-sol", PROVIDER, cachePath)).toEqual(expected);
    expect(lookupVariantPresets("OpenAI/GPT-5.6-Sol", PROVIDER, cachePath)).toEqual(expected);

    expect(lookupVariantPresets("openai/gpt-5.6-sol", "openai", cachePath)).toEqual([]);
    expect(lookupVariantPresets("openai/gpt-5.6-terra", PROVIDER, cachePath)).toEqual([]);
  });
});

describe("lookupRouteReasoningMode", () => {
  test("returns the selected route's typed mode fact only", () => {
    expect(lookupRouteReasoningMode("openai/gpt-5.6-sol", "openai", cachePath)).toEqual({
      status: "supported",
      values: ["standard", "pro"],
      default: "standard",
    });
    expect(lookupRouteReasoningMode(BASE_MODEL_ID, "openai-codex", cachePath)).toEqual({
      status: "rejected",
    });
    expect(lookupRouteReasoningMode(BASE_MODEL_ID, "opencode-zen", cachePath)).toEqual({
      status: "unknown",
    });
    expect(lookupRouteReasoningMode(BASE_MODEL_ID, "openrouter", cachePath)).toBeUndefined();
  });
});
