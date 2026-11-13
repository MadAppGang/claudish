import { describe, expect, test } from "bun:test";
import type { AggregatorEntry } from "../model-loader.js";
import type { SlimModelEntry } from "./all-models-cache.js";
import {
  BundleShapeError,
  type BundledListInputs,
  buildBundledList,
  buildBundledListWithSummary,
  serializeBundledList,
  vendorRoleOf,
} from "./bundled-list-build.js";
import type { RouteRegistry } from "./connection-wire.js";
import { gatewayWireIdFor } from "./gateway-wire-lists.js";
import {
  GENERATION,
  KEPT_BINDINGS,
  PRODUCTION_SOURCE,
  RECOMMENDED_IDS,
  TIERS,
  routingSetupCatalog,
} from "./test-data/routing-setups.js";

type Recommendations = {
  entries: Array<{
    modelId: string;
    tier: string;
    route?: { routeId: string; routeProfileId: string };
    planId?: string;
  }>;
  efforts?: Record<
    string,
    Record<
      string,
      {
        effort: string;
        basis?: string;
        sendableOn: Array<{
          routeId: string;
          routeProfileId: string;
          externalModelId: string;
          encoding?: string;
        }>;
      }
    >
  >;
};
const recommendations = (input: BundledListInputs) =>
  input.recommended.recommendations as Recommendations;
const model = (input: BundledListInputs, id = "gpt-6.1-sol") =>
  (input.slim.models as SlimModelEntry[]).find((entry) => entry.modelId === id)!;
const warningsOf = (summary: ReturnType<typeof buildBundledListWithSummary>["summary"]) =>
  (summary as typeof summary & { warnings?: string[] }).warnings ?? [];
const registry = (input: BundledListInputs) => input.routes.registry as RouteRegistry;
const own = (input: BundledListInputs) =>
  model(input).aggregators!.find(
    (connection) =>
      connection.route?.routeId === "openai" && connection.route.routeProfileId === "direct-api"
  )!;

function withInput(run: (inputs: BundledListInputs) => void) {
  const data = routingSetupCatalog();
  try {
    run(structuredClone(data.inputs));
  } finally {
    data.cleanup();
  }
}

function reject(inputs: BundledListInputs) {
  let failure: unknown;
  try {
    buildBundledList(inputs);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(BundleShapeError);
  expect((failure as BundleShapeError).path.length).toBeGreaterThan(0);
  expect((failure as Error).message.length).toBeGreaterThan(0);
}

const badInputs: Array<[string, (input: BundledListInputs) => void]> = [
  [
    "the recommended payload is null",
    (i) => {
      i.recommended.recommendations = null;
    },
  ],
  [
    "the recommendations contract version is wrong",
    (i) => {
      (i.recommended.recommendations as { contractVersion: number }).contractVersion = 2;
    },
  ],
  [
    "the recommendations generation differs",
    (i) => {
      (i.recommended.recommendations as { generationId: string }).generationId = "other-generation";
    },
  ],
  [
    "an invalid extra effort cell would be silently discarded",
    (i) => {
      recommendations(i).efforts!["gpt-6.1-sol"]!.invalid = { effort: "", sendableOn: [] };
    },
  ],
  [
    "every recommendation tier is unknown",
    (i) => {
      for (const row of recommendations(i).entries) row.tier = "future-tier";
    },
  ],
  [
    "contractVersion is not 3",
    (i) => {
      i.recommended.contractVersion = 2;
    },
  ],
  [
    "routes generation differs",
    (i) => {
      i.routes.generationId = "other-generation";
    },
  ],
  [
    "plans generation differs",
    (i) => {
      i.plans.generationId = "other-generation";
    },
  ],
  [
    "slim generation differs",
    (i) => {
      i.slim.generationId = "other-generation";
    },
  ],
  [
    "a recommended id is missing from slim",
    (i) => {
      i.slim.models = i.slim.models.filter((m) => (m as SlimModelEntry).modelId !== "kimi-k3");
    },
  ],
  [
    "a recommended slim row is invalid",
    (i) => {
      model(i).aliases = null as unknown as string[];
    },
  ],
  [
    "a plan row is invalid",
    (i) => {
      i.plans.plans[0] = { id: 42 };
    },
  ],
  [
    "the registry is malformed",
    (i) => {
      i.routes.registry = { registryVersion: "3.7.0", routes: null };
    },
  ],
  [
    "the registry version is incompatible",
    (i) => {
      registry(i).registryVersion = "1.0.0";
    },
  ],
  [
    "a mapped connection has no profile",
    (i) => {
      delete registry(i).routes.openai!.profiles["direct-api"];
    },
  ],
  [
    "a mapped connection has an unknown profile kind",
    (i) => {
      registry(i).routes.openai!.profiles["direct-api"]!.kind = "future-kind";
    },
  ],
  [
    "a kept connection has no wire",
    (i) => {
      delete own(i).wire;
    },
  ],
  [
    "a kept wire is malformed",
    (i) => {
      own(i).wire = { status: "known" } as AggregatorEntry["wire"];
    },
  ],
  [
    "a kept wire would be demoted because its API has no base URL",
    (i) => {
      delete registry(i).routes.openai!.profiles["direct-api"]!.apis.responses;
    },
  ],
  [
    "a kept wire has an unsupported API",
    (i) => {
      (own(i).wire as unknown as { api: string }).api = "future-api";
    },
  ],
  [
    "vendor ownership disagrees with routeId equality",
    (i) => {
      const connection = own(i);
      registry(i).routes["not-openai"] = structuredClone(registry(i).routes.openai!);
      connection.route = { routeId: "not-openai", routeProfileId: "direct-api" };
    },
  ],
  [
    "the efforts field is absent",
    (i) => {
      delete recommendations(i).efforts;
    },
  ],
  [
    "the efforts field is malformed",
    (i) => {
      recommendations(i).efforts = [] as unknown as Recommendations["efforts"];
    },
  ],
  [
    "a raw effort cell would be dropped for empty effort",
    (i) => {
      recommendations(i).efforts!["gpt-6.1-sol"]!.coding!.effort = "";
    },
  ],
  [
    "a raw effort cell has no valid sendableOn",
    (i) => {
      recommendations(i).efforts!["gpt-6.1-sol"]!.coding!.sendableOn = [];
    },
  ],
  [
    "the recommendation set is empty",
    (i) => {
      recommendations(i).entries = [];
    },
  ],
];

describe("R1 RB-17: builder rejects incomplete or untrustworthy publications", () => {
  for (const [reason, mutate] of badInputs) {
    test(`R1: fails when ${reason}`, () =>
      withInput((inputs) => {
        mutate(inputs);
        reject(inputs);
      }));
  }

  test("R1: a recommended model with effort levels and no row is kept with a warning", () =>
    withInput((inputs) => {
      const id = "gpt-6.1-sol";
      delete recommendations(inputs).efforts![id];
      expect(model(inputs, id).reasoning!.efforts!.length).toBeGreaterThan(0);

      let result!: ReturnType<typeof buildBundledListWithSummary>;
      expect(() => {
        result = buildBundledListWithSummary(inputs);
      }).not.toThrow();
      const { file, summary } = result;

      expect(file.entries.some((entry) => entry.modelId === id)).toBe(true);
      expect(file.bundle.recommendations.entries.some((entry) => entry.modelId === id)).toBe(true);
      expect(Object.hasOwn(file.bundle.efforts, id)).toBe(false);
      expect(warningsOf(summary).join("\n")).toContain(id);
    }));

  test("R1: a recommended model with effort levels and an empty row is kept with the absent-row warning", () =>
    withInput((inputs) => {
      const ids = ["gpt-6.1-sol", "kimi-k3"];
      const rows = recommendations(inputs);
      rows.efforts![ids[0]!] = {};
      delete rows.efforts![ids[1]!];
      for (const id of ids) {
        expect(model(inputs, id).reasoning!.efforts!.length).toBeGreaterThan(0);
      }
      inputs.slim.models.reverse();
      rows.entries.reverse();

      let result!: ReturnType<typeof buildBundledListWithSummary>;
      expect(() => {
        result = buildBundledListWithSummary(inputs);
      }).not.toThrow();
      const { file, summary } = result;

      for (const id of ids) {
        expect(file.entries.some((entry) => entry.modelId === id)).toBe(true);
        expect(file.bundle.recommendations.entries.some((entry) => entry.modelId === id)).toBe(
          true
        );
        expect(Object.hasOwn(file.bundle.efforts, id)).toBe(false);
        expect(summary.modelsWithNoEffortRow).toContain(id);
      }
      expect(warningsOf(summary)).toEqual([
        `recommendations.efforts: 2 recommended model(s) publish effort levels and have no effort row, bundled without one: ${ids.join(", ")}`,
      ]);
    }));

  test("R1: two recommended models with no effort rows are kept and warned in sorted order", () =>
    withInput((inputs) => {
      const ids = ["gpt-6.1-sol", "kimi-k3"];
      for (const id of ids) {
        delete recommendations(inputs).efforts![id];
        expect(model(inputs, id).reasoning!.efforts!.length).toBeGreaterThan(0);
      }
      inputs.slim.models.reverse();
      recommendations(inputs).entries.reverse();

      let result!: ReturnType<typeof buildBundledListWithSummary>;
      expect(() => {
        result = buildBundledListWithSummary(inputs);
      }).not.toThrow();
      const { file, summary } = result;

      for (const id of ids) {
        expect(file.entries.some((entry) => entry.modelId === id)).toBe(true);
        expect(file.bundle.recommendations.entries.some((entry) => entry.modelId === id)).toBe(
          true
        );
        expect(Object.hasOwn(file.bundle.efforts, id)).toBe(false);
      }
      const warnings = warningsOf(summary).join("\n");
      for (const id of ids) expect(warnings).toContain(id);
      expect(warnings.indexOf(ids[0]!)).toBeLessThan(warnings.indexOf(ids[1]!));
    }));

  test("R1: a non-empty effort row with a dropped cell still fails when another model has no row", () =>
    withInput((inputs) => {
      delete recommendations(inputs).efforts!["kimi-k3"];
      recommendations(inputs).efforts!["gpt-6.1-sol"]!.coding!.effort = "";

      expect(() => buildBundledListWithSummary(inputs)).toThrow(BundleShapeError);
      expect(() => buildBundledListWithSummary(inputs)).toThrow(
        "recommendations.efforts: the runtime parser drops 1 cell(s): gpt-6.1-sol.coding"
      );
    }));

  test("R1: a model with no effort levels and no row is bundled without a warning", () =>
    withInput((inputs) => {
      // Choose a captured no-effort-level model, not a patched reasoning capability.
      const rows = recommendations(inputs);
      rows.entries.push({ modelId: "minimax-m3", tier: "lightweight" });
      delete rows.efforts!["minimax-m3"];
      expect(model(inputs, "minimax-m3").reasoning?.efforts ?? []).toEqual([]);

      const { file, summary } = buildBundledListWithSummary(inputs);

      expect(file.entries.some((entry) => entry.modelId === "minimax-m3")).toBe(true);
      expect(file.bundle.efforts["minimax-m3"]).toBeUndefined();
      expect(summary.modelsWithNoEffortRow).toContain("minimax-m3");
      expect(warningsOf(summary)).toEqual([]);
    }));

  test("R1: a recommended model with no effort levels and an empty row is kept without a warning", () =>
    withInput((inputs) => {
      const id = "minimax-m3";
      const rows = recommendations(inputs);
      rows.entries.push({ modelId: id, tier: "lightweight" });
      rows.efforts![id] = {};
      expect(model(inputs, id).reasoning?.efforts ?? []).toEqual([]);

      let result!: ReturnType<typeof buildBundledListWithSummary>;
      expect(() => {
        result = buildBundledListWithSummary(inputs);
      }).not.toThrow();
      const { file, summary } = result;

      expect(file.entries.some((entry) => entry.modelId === id)).toBe(true);
      expect(file.bundle.recommendations.entries.some((entry) => entry.modelId === id)).toBe(true);
      expect(Object.hasOwn(file.bundle.efforts, id)).toBe(false);
      expect(summary.modelsWithNoEffortRow).toContain(id);
      expect(warningsOf(summary)).toEqual([]);
    }));

  test("R1: an empty effort row outside the bundled list is discarded without failing", () =>
    withInput((inputs) => {
      const id = "minimax-m3";
      const rows = recommendations(inputs);
      expect(rows.entries.some((entry) => entry.modelId === id)).toBe(false);
      rows.efforts![id] = {};

      let result!: ReturnType<typeof buildBundledListWithSummary>;
      expect(() => {
        result = buildBundledListWithSummary(inputs);
      }).not.toThrow();
      const { file, summary } = result;

      expect(file.entries.some((entry) => entry.modelId === id)).toBe(false);
      expect(file.bundle.recommendations.entries.some((entry) => entry.modelId === id)).toBe(false);
      expect(Object.hasOwn(file.bundle.efforts, id)).toBe(false);
      expect(warningsOf(summary)).toEqual([]);
    }));

  test("R1 RB-23: narrowing sendableOn to no kept connections does not discard or reject the cell", () =>
    withInput((inputs) => {
      const rows = recommendations(inputs);
      rows.efforts!["gpt-6.1-sol"]!.coding!.sendableOn = [
        {
          routeId: "openrouter",
          routeProfileId: "gateway",
          externalModelId: "openai/gpt-6.1-sol",
          encoding: "request_parameter",
        },
      ];

      const { file, summary } = buildBundledListWithSummary(inputs);

      expect(file.bundle.efforts["gpt-6.1-sol"]!.coding).toEqual({
        effort: "high",
        basis: "synthetic setup recommendation",
        sendableOn: [],
      });
      expect(summary.droppedSendableOn).toBeGreaterThan(0);
    }));

  test("R1: unknown tiers are skipped and counted rather than rejected", () =>
    withInput((inputs) => {
      recommendations(inputs).entries.push({
        modelId: "not-in-slim",
        tier: "future-recommendation-tier",
      });

      const { file, summary } = buildBundledListWithSummary(inputs);

      expect(file.entries.map((entry) => entry.modelId).sort()).toEqual(
        [...RECOMMENDED_IDS].sort()
      );
      expect(summary.skippedTiers["future-recommendation-tier"]).toBe(1);
      expect(
        file.bundle.recommendations.entries.some((entry) => entry.modelId === "not-in-slim")
      ).toBe(false);
    }));

  test("R1: effort rows outside the recommendation set are skipped and counted", () =>
    withInput((inputs) => {
      recommendations(inputs).efforts!["not-recommended"] = structuredClone(
        recommendations(inputs).efforts!["gpt-6.1-sol"]!
      );

      const { file, summary } = buildBundledListWithSummary(inputs);

      expect(file.bundle.efforts["not-recommended"]).toBeUndefined();
      expect(summary.effortRowsOutsideBundle).toBe(1);
    }));

  test("R1 RB-17: all five tiers, API order, subscription route and plan id survive gateway trimming", () =>
    withInput((inputs) => {
      const expected = structuredClone(recommendations(inputs).entries);

      const file = buildBundledList(inputs);

      expect<unknown>(file.bundle.recommendations.entries).toEqual(expected);
      expect(file.bundle.recommendations.entries.map((row) => row.tier)).toEqual([...TIERS]);
      expect(file.catalogGenerationId).toBe(GENERATION);
      expect(file.routeRegistry.generationId).toBe(GENERATION);
      expect(file.bundle.source).toBe(PRODUCTION_SOURCE);
      expect(file.bundle.fetchedAt).toBe(inputs.fetchedAt);
      expect(file.lastUpdated).toBe(inputs.recommended.generatedAt);
      for (const entry of file.entries) {
        expect(
          (entry.aggregators ?? [])
            .map((c) => `${c.route!.routeId}/${c.route!.routeProfileId}`)
            .sort()
        ).toEqual([...KEPT_BINDINGS[entry.modelId]!].sort());
      }
      expect(file.routeRegistry.registry.routes.openrouter!.profiles.gateway!.kind).toBe("gateway");
    }));

  test("R1.1: recommendation order within a tier is preserved, not sorted by canonical id", () =>
    withInput((inputs) => {
      const rows = recommendations(inputs);
      rows.entries.reverse();
      rows.entries.unshift({ modelId: "minimax-m3", tier: "flagship" });
      const expected = structuredClone(rows.entries);

      const file = buildBundledList(inputs);

      expect<unknown>(file.bundle.recommendations.entries).toEqual(expected);
      expect(
        file.bundle.recommendations.entries
          .filter((row) => row.tier === "flagship")
          .map((row) => row.modelId)
      ).toEqual(["minimax-m3", "gpt-6.1-sol"]);
    }));

  test("R1: canonical serialization is independent of input row and object-key order", () =>
    withInput((inputs) => {
      const first = buildBundledList(inputs);
      const reordered = structuredClone(inputs);
      reordered.slim.models.reverse();
      reordered.plans.plans.reverse();
      for (const entry of reordered.slim.models as SlimModelEntry[]) entry.aggregators?.reverse();
      const second = buildBundledList(reordered);

      expect(serializeBundledList(second)).toBe(serializeBundledList(first));
      const reverseKeys = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(reverseKeys);
        if (!value || typeof value !== "object") return value;
        return Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, v]) => [key, reverseKeys(v)])
        );
      };
      expect(serializeBundledList(reverseKeys(first) as typeof first)).toBe(
        serializeBundledList(first)
      );
      expect(serializeBundledList(first).endsWith("\n")).toBe(true);
      expect(JSON.parse(serializeBundledList(first))).toEqual(first);
    }));

  test("R1 RB-17: opt-in vendor-own connections are retained in the raw file", () =>
    withInput((inputs) => {
      const optIn = structuredClone(own(inputs));
      optIn.externalModelId = "gpt-6.1-sol-contributor";
      model(inputs).aggregators!.push(optIn);

      const file = buildBundledList(inputs);

      expect(
        file.entries
          .find((entry) => entry.modelId === "gpt-6.1-sol")!
          .aggregators!.some((c) => c.externalModelId === "gpt-6.1-sol-contributor")
      ).toBe(true);
    }));

  test("R1: native connection fields survive except recursively removed evidence", () =>
    withInput((inputs) => {
      const before = structuredClone(own(inputs));
      const strip = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(strip);
        if (!value || typeof value !== "object") return value;
        return Object.fromEntries(
          Object.entries(value).flatMap(([key, v]) => {
            if (
              [
                "evidence",
                "evidenceSourceUrl",
                "sourceUrl",
                "sourceCollectorId",
                "confidence",
              ].includes(key)
            )
              return [];
            return [[key, strip(v)]];
          })
        );
      };

      const file = buildBundledList(inputs);
      const kept = file.entries
        .find((entry) => entry.modelId === "gpt-6.1-sol")!
        .aggregators!.find((c) => c.route?.routeProfileId === "direct-api")!;

      const expected = strip(before) as Record<string, unknown>;
      if (expected.wire) (expected.wire as Record<string, unknown>).evidence = [];
      expect<unknown>(kept).toEqual(expected);
    }));
});

describe("REQ-110 RB-17: empty publication refusals", () => {
  test.each(["empty", "unknown-only"] as const)(
    "REQ-110: rejects a publication with no recognized recommendation row (%s)",
    (kind) =>
      withInput((inputs) => {
        const rows = recommendations(inputs);
        rows.entries = kind === "empty" ? [] : [{ modelId: "future-model", tier: "future-tier" }];

        expect(() => buildBundledList(inputs)).toThrow(BundleShapeError);
        expect(() => buildBundledListWithSummary(inputs)).toThrow(BundleShapeError);
      })
  );

  test("REQ-110: rejects a recognized recommendation set with no slim model entries", () =>
    withInput((inputs) => {
      inputs.slim.models = [];

      expect(() => buildBundledList(inputs)).toThrow(BundleShapeError);
      expect(() => buildBundledListWithSummary(inputs)).toThrow(BundleShapeError);
    }));

  test("REQ-110: permits one empty recommendation tier when the publication remains nonempty", () =>
    withInput((inputs) => {
      const rows = recommendations(inputs);
      rows.entries = rows.entries.filter((row) => row.tier !== "luxury");
      const expected = structuredClone(rows.entries);

      const { file, summary } = buildBundledListWithSummary(inputs);

      expect<unknown>(file.bundle.recommendations.entries).toEqual(expected);
      expect(file.entries.map((entry) => entry.modelId).sort()).toEqual(
        [...new Set(expected.map((row) => row.modelId))].sort()
      );
      expect(file.entries.length).toBeGreaterThan(0);
      expect(summary.rowsPerTier.luxury ?? 0).toBe(0);
    }));
});

describe("RB-9 RB-17: vendor roles are registry data, not model-name rules", () => {
  test("RB-17: gateway and cross-vendor subscription connections are dropped", () =>
    withInput((inputs) => {
      const entry = model(inputs, "kimi-k3");
      const gateway = entry.aggregators!.find((c) => c.route?.routeId === "openrouter")!;
      const cross = entry.aggregators!.find(
        (c) => c.route?.routeId === "opencode" && c.route.routeProfileId === "go-subscription"
      )!;
      expect(vendorRoleOf(gateway, entry, registry(inputs))).toBe("dropped");
      expect(vendorRoleOf(cross, entry, registry(inputs))).toBe("dropped");
      expect(vendorRoleOf(own(inputs), model(inputs), registry(inputs))).toBe("vendor-own");
    }));

  test("RB-17: a new vendor-own id is kept without adding a name pattern", () =>
    withInput((inputs) => {
      const entry = structuredClone(model(inputs));
      entry.modelId = "arbitrary-new-name-42";
      expect(vendorRoleOf(own(inputs), entry, registry(inputs))).toBe("vendor-own");
    }));
});

describe("RB-4: offline gateway ids use exact string equality", () => {
  test.each([
    ["vendor-qualified wins", ["kimi-k3", "moonshotai/kimi-k3"], "moonshotai/kimi-k3"],
    ["canonical id is second choice", ["kimi-k3"], "kimi-k3"],
    ["case mismatch is not an id", ["moonshotai/Kimi-K3"], undefined],
    ["moving pointer is not pinned", ["~moonshotai/kimi-latest"], undefined],
    [
      "gateway-specific namespace is not invented",
      ["accounts/fireworks/models/kimi-k3"],
      undefined,
    ],
    ["empty models list withholds the hop", [], undefined],
  ] as Array<[string, string[], string | undefined]>)("RB-4: %s", (_name, ids, expected) => {
    expect(gatewayWireIdFor("kimi-k3", "moonshotai", new Set(ids))).toBe(expected);
  });
});
