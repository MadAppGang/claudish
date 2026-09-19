import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CachedSubscriptionPlan,
  type DiskCacheV3,
  type SlimModelEntry,
  writeAllModelsCache,
} from "../providers/all-models-cache.js";
import { catalogRouteForProvider } from "../providers/catalog-route-bindings.js";
import {
  lookupModel,
  lookupModelReasoning,
  lookupModelReasoningStatus,
  resolveSubscriptionRouting,
} from "./model-catalog.js";

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
  subscriptionPlanIds: string[] = [],
  provider?: string,
  externalId: string = modelId
): SlimModelEntry {
  return {
    modelId,
    aliases: [],

    subscriptionPlanIds,
    ...(provider
      ? {
          aggregators: [
            {
              sourceCollectorId: "test",
              routeStatus: "mapped",
              route: catalogRouteForProvider(provider),
              sourceProviderId: provider,
              externalModelId: externalId,
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
    routeStatus: "supported",
    route: catalogRouteForProvider(providerUid),
  };
}

function writeCatalog(entries: SlimModelEntry[], plans: CachedSubscriptionPlan[]): void {
  const cache: DiskCacheV3 = {
    catalogGenerationId: "test-generation",
    version: 3,
    lastUpdated: new Date().toISOString(),
    entries,
    models: [],
    plans,
  };
  writeAllModelsCache(cache, cachePath);
}

describe("resolveSubscriptionRouting", () => {
  test("returns serves only when every Qwen plan sharing the route includes the model", () => {
    writeCatalog(
      [
        modelEntry(
          "qwen3-coder-plus",
          ["alibaba-token-plan-individual", "alibaba-token-plan-team-edition"],
          "qwen-token-plan",
          "qwen3-coder-plus-wire"
        ),
      ],
      [
        routedPlan("alibaba-token-plan-individual", "alibaba", "qwen-token-plan"),
        routedPlan("alibaba-token-plan-team-edition", "alibaba", "qwen-token-plan"),
      ]
    );

    expect(resolveSubscriptionRouting("qwen3-coder-plus", "qwen-token-plan", cachePath)).toEqual({
      kind: "serves",
      externalId: "qwen3-coder-plus-wire",
    });
  });

  test("returns unknown when only some Qwen plans sharing the route include the model", () => {
    writeCatalog(
      [
        modelEntry(
          "qwen3-coder-plus",
          ["alibaba-token-plan-team-edition"],
          "qwen-token-plan",
          "qwen3-coder-plus-wire"
        ),
      ],
      [
        routedPlan("alibaba-token-plan-individual", "alibaba", "qwen-token-plan"),
        routedPlan("alibaba-token-plan-team-edition", "alibaba", "qwen-token-plan"),
      ]
    );

    expect(resolveSubscriptionRouting("qwen3-coder-plus", "qwen-token-plan", cachePath)).toEqual({
      kind: "unknown",
    });
  });

  test("preserves not-served when no Qwen plan includes the model and both rosters are catalog-authoritative", () => {
    writeCatalog(
      [
        modelEntry("qwen3-coder-plus", [], "qwen-token-plan"),
        modelEntry("qwen-roster-proof", [
          "alibaba-token-plan-individual",
          "alibaba-token-plan-team-edition",
        ]),
      ],
      [
        routedPlan("alibaba-token-plan-individual", "alibaba", "qwen-token-plan"),
        routedPlan("alibaba-token-plan-team-edition", "alibaba", "qwen-token-plan"),
      ]
    );

    // This is not a new destructive verdict: the pre-bc7fd79 implementation
    // already returned not-served for a complete, catalog-authoritative view.
    expect(resolveSubscriptionRouting("qwen3-coder-plus", "qwen-token-plan", cachePath)).toEqual({
      kind: "not-served",
    });
  });

  test("keeps Coding Plan separate from Token Plan membership", () => {
    writeCatalog(
      [
        modelEntry("qwen3-coder-plus", [], "qwen-token-plan"),
        modelEntry("qwen3.8-max", ["alibaba-token-plan-individual"]),
      ],
      [
        {
          id: "alibaba-ai-coding-plan",
          routeStatus: "supported",
          route: catalogRouteForProvider("qwen-coding"),
          provider: "alibaba",
          modelDiscovery: "catalog",
        },
        routedPlan("alibaba-token-plan-individual", "alibaba", "qwen-token-plan"),
        routedPlan("alibaba-token-plan-team-edition", "alibaba", "qwen-token-plan"),
      ]
    );

    expect(resolveSubscriptionRouting("qwen3-coder-plus", "qwen-token-plan", cachePath)).toEqual({
      kind: "not-served",
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
          "qwen-token-plan",
          "qwen3-coder-plus-wire"
        ),
      ],
      [routedPlan("alibaba-token-plan-individual", "alibaba", "qwen-token-plan")]
    );

    expect(resolveSubscriptionRouting("qwen3-coder-plus", "qwen-token-plan", cachePath)).toEqual({
      kind: "serves",
      externalId: "qwen3-coder-plus-wire",
    });
  });

  test("returns unknown when the provider publishes no membership rows", () => {
    writeCatalog(
      [modelEntry("qwen3-coder-plus", [], "qwen-token-plan"), modelEntry("unrelated-model")],
      [routedPlan("alibaba-token-plan-individual", "alibaba", "qwen-token-plan")]
    );

    expect(resolveSubscriptionRouting("qwen3-coder-plus", "qwen-token-plan", cachePath)).toEqual({
      kind: "unknown",
    });
  });
});

describe("plan modelDescriptions metadata lookup", () => {
  const describedEntries: SlimModelEntry[] = [
    {
      modelId: "qwen3.8-max-preview",
      aliases: [],

      contextWindow: 262_144,
      reasoningStatus: "known",
      reasoning: { supported: true, control: "budget", supportsBudgetTokens: true },
    },
    {
      modelId: "qwen3.8-flash-canonical",
      aliases: [],

      contextWindow: 131_072,
      reasoningStatus: "known",
      reasoning: { supported: true, control: "effort", efforts: ["low", "high"] },
    },
    {
      modelId: "claude-opus-4-5",
      aliases: [],

      contextWindow: 200_000,
      reasoningStatus: "known",
      reasoning: { supported: true, control: "effort", efforts: ["high", "max"] },
    },
  ];

  function writeDescribedCatalog(): void {
    writeCatalog(describedEntries, [
      {
        routeStatus: "supported",
        id: "future-subscription-plan",
        route: { routeId: "qwen", routeProfileId: "qwencloud-token-plan" },
        inclusions: [
          {
            kind: "provider_model",
            externalModelId: "qwen3.8-max",
            resolution: { status: "mapped", modelId: "qwen3.8-max-preview" },
          },
          {
            kind: "provider_model",
            externalModelId: "qwen3.8-flash",
            resolution: { status: "mapped", modelId: "qwen3.8-flash-canonical" },
          },
          {
            kind: "provider_model",
            externalModelId: "claude-opus-4-5-20251101",
            resolution: { status: "mapped", modelId: "claude-opus-4-5" },
          },
        ],
      },
    ]);
  }

  test("resolves exact plan wire ids through their different canonical metadata ids", () => {
    writeDescribedCatalog();

    for (const [wireId, canonicalId, contextWindow] of [
      ["qwen3.8-max", "qwen3.8-max-preview", 262_144],
      ["qwen3.8-flash", "qwen3.8-flash-canonical", 131_072],
      ["claude-opus-4-5-20251101", "claude-opus-4-5", 200_000],
    ] as const) {
      expect(lookupModel(wireId, cachePath)).toEqual({
        modelId: canonicalId,
        contextWindow,
        supportsVision: undefined,
        releaseDate: undefined,
      });
      expect(lookupModelReasoningStatus(wireId, cachePath)).toBe("known");
      expect(lookupModelReasoning(wireId, cachePath)?.supported).toBe(true);
    }
  });

  test("treats missing and ambiguous as negative answers without fuzzy matching", () => {
    writeCatalog(
      [
        {
          modelId: "qwen3.9-max-preview",
          aliases: [],

          contextWindow: 262_144,
          reasoningStatus: "known",
          reasoning: { supported: true, control: "budget" },
        },
        {
          modelId: "qwen3.9-flash-preview",
          aliases: [],

          contextWindow: 131_072,
          reasoningStatus: "known",
          reasoning: { supported: true, control: "effort", efforts: ["high"] },
        },
      ],
      [
        {
          routeStatus: "supported",
          id: "future-subscription-plan",
          route: { routeId: "qwen", routeProfileId: "qwencloud-token-plan" },
          inclusions: [
            {
              kind: "provider_model",
              externalModelId: "qwen3.9-max",
              resolution: { status: "missing" },
            },
            {
              kind: "provider_model",
              externalModelId: "qwen3.9-flash",
              resolution: { status: "ambiguous" },
            },
          ],
        },
      ]
    );

    for (const wireId of ["qwen3.9-max", "qwen3.9-flash"]) {
      expect(lookupModel(wireId, cachePath)).toBeUndefined();
      expect(lookupModelReasoning(wireId, cachePath)).toBeUndefined();
      expect(lookupModelReasoningStatus(wireId, cachePath)).toBeUndefined();
    }
  });

  test("looks up models through ids and aliases when plans have no inclusions", () => {
    writeCatalog(
      [
        {
          modelId: "legacy-canonical-model",
          aliases: ["legacy-wire-model"],

          contextWindow: 98_304,
          reasoning: { supported: true, control: "toggle" },
        },
      ],
      [{ id: "test-plan", routeStatus: "unknown" }]
    );

    expect(lookupModel("legacy-canonical-model", cachePath)?.contextWindow).toBe(98_304);
    expect(lookupModel("legacy-wire-model", cachePath)?.modelId).toBe("legacy-canonical-model");
    expect(lookupModelReasoningStatus("legacy-wire-model", cachePath)).toBe("known");
  });
});

describe("lookupModelReasoningStatus", () => {
  test("preserves explicit and described reasoning without manufacturing a control", () => {
    writeCatalog(
      [
        {
          modelId: "explicit-unknown",
          aliases: [],

          reasoningStatus: "unknown",
          supportsThinking: true,
        },
        {
          modelId: "explicit-known",
          aliases: [],

          reasoningStatus: "known",
          reasoning: { supported: false, control: "none" },
        },
        {
          modelId: "reasoning-described",
          aliases: [],

          reasoning: { supported: true, control: "toggle" },
        },
        {
          modelId: "reasoning-undescribed",
          aliases: [],

          supportsThinking: false,
        },
      ],
      [
        {
          routeStatus: "supported",
          id: "negative-plan",
          route: { routeId: "qwen", routeProfileId: "qwencloud-token-plan" },
          inclusions: [
            {
              kind: "provider_model",
              externalModelId: "missing-wire",
              resolution: { status: "missing" },
            },
            {
              kind: "provider_model",
              externalModelId: "ambiguous-wire",
              resolution: { status: "ambiguous" },
            },
          ],
        },
      ]
    );

    expect(lookupModelReasoningStatus("explicit-unknown", cachePath)).toBe("unknown");
    expect(lookupModelReasoning("explicit-unknown", cachePath)).toBeUndefined();
    expect(lookupModelReasoningStatus("explicit-known", cachePath)).toBe("known");
    expect(lookupModelReasoningStatus("reasoning-described", cachePath)).toBe("known");
    expect(lookupModelReasoningStatus("reasoning-undescribed", cachePath)).toBe("unknown");
    expect(lookupModelReasoning("reasoning-undescribed", cachePath)).toBeUndefined();

    for (const modelId of ["not-in-the-catalog", "missing-wire", "ambiguous-wire"]) {
      expect(lookupModelReasoningStatus(modelId, cachePath)).toBeUndefined();
      expect(lookupModelReasoning(modelId, cachePath)).toBeUndefined();
    }
  });
});
