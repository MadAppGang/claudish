import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CachedSubscriptionPlan,
  type DiskCacheV2,
  type SlimModelEntry,
  writeAllModelsCache,
} from "../providers/all-models-cache.js";
import { resolveSubscriptionRouting } from "./model-catalog.js";

type VendorPlan = CachedSubscriptionPlan & { provider: string };

let tempDir = "";
let cachePath = "";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "claudish-subscription-routing-"));
  cachePath = join(tempDir, "all-models.json");
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {}
  tempDir = "";
  cachePath = "";
});

function modelEntry(
  modelId: string,
  subscriptionPlans: string[] = [],
  provider?: string,
  externalId: string = modelId
): SlimModelEntry {
  return {
    modelId,
    aliases: [],
    sources: {},
    subscriptionPlans,
    ...(provider
      ? {
          aggregators: [
            {
              provider,
              externalId,
              confidence: "api_official" as const,
            },
          ],
        }
      : {}),
  };
}

function routedPlan(id: string, provider: string, providerUid: string): VendorPlan {
  return {
    id,
    provider,
    modelDiscovery: "catalog",
    routing: { providerUid, nativeModelProviders: [] },
  };
}

function writeCatalog(entries: SlimModelEntry[], plans: VendorPlan[]): void {
  const cache: DiskCacheV2 = {
    version: 2,
    lastUpdated: new Date().toISOString(),
    entries,
    models: [],
    plans,
  };
  writeAllModelsCache(cache, cachePath);
}

describe("resolveSubscriptionRouting", () => {
  test("returns unknown when an unrouted sibling makes the provider plan view partial", () => {
    writeCatalog(
      [
        modelEntry("qwen3-coder-plus", [], "qwen-cloud"),
        modelEntry("qwen3.8-max", ["alibaba-token-plan-individual"]),
      ],
      [
        {
          id: "alibaba-ai-coding-plan",
          provider: "alibaba",
          modelDiscovery: "catalog",
        },
        routedPlan("alibaba-token-plan-individual", "alibaba", "qwen-cloud"),
        routedPlan("alibaba-token-plan-team-edition", "alibaba", "qwen-cloud"),
      ]
    );

    expect(resolveSubscriptionRouting("qwen3-coder-plus", "qwen-cloud", cachePath)).toEqual({
      kind: "unknown",
    });
  });

  test("returns not-served when the provider plan view is complete and omits the model", () => {
    writeCatalog(
      [modelEntry("glm-4.7", [], "glm-coding"), modelEntry("glm-5.3", ["z-ai-glm-coding-plan"])],
      [routedPlan("z-ai-glm-coding-plan", "z-ai", "glm-coding")]
    );

    expect(resolveSubscriptionRouting("glm-4.7", "glm-coding", cachePath)).toEqual({
      kind: "not-served",
    });
  });

  test("returns serves with the provider external id when the model has plan membership", () => {
    writeCatalog(
      [
        modelEntry(
          "qwen3-coder-plus",
          ["alibaba-token-plan-individual"],
          "qwen-cloud",
          "qwen3-coder-plus-wire"
        ),
      ],
      [routedPlan("alibaba-token-plan-individual", "alibaba", "qwen-cloud")]
    );

    expect(resolveSubscriptionRouting("qwen3-coder-plus", "qwen-cloud", cachePath)).toEqual({
      kind: "serves",
      externalId: "qwen3-coder-plus-wire",
    });
  });

  test("returns unknown when the provider publishes no membership rows", () => {
    writeCatalog(
      [modelEntry("qwen3-coder-plus", [], "qwen-cloud"), modelEntry("unrelated-model")],
      [routedPlan("alibaba-token-plan-individual", "alibaba", "qwen-cloud")]
    );

    expect(resolveSubscriptionRouting("qwen3-coder-plus", "qwen-cloud", cachePath)).toEqual({
      kind: "unknown",
    });
  });
});
