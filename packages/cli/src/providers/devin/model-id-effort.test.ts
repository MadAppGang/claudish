// Assumed no-effort table seam: currentEffortRecommendations, stubbed without disk I/O.
/**
 * No new callable seam is assumed for Devin: resolveDevinModelUid reads the
 * connection's modelIdEffort from the cloud models catalog. readAllModelsCache
 * is the existing in-memory injection seam. Direct expand tests pin identity.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as allModelsCache from "../all-models-cache.js";
import type { DiskCacheV3, SlimModelEntry } from "../all-models-cache.js";
import { DevinModelResolver, devinModelsCatalogEntry } from "../model-resolvers/devin.js";
import {
  catalogEntry,
  connection,
  devinModel,
  effortMap,
  stubEffortRecommendations,
} from "../test-helpers/model-id-effort.js";
import type { ModelIdEffort } from "../test-helpers/model-id-effort.js";
import type { DevinModelConfig } from "./devin-models.js";
import { resolveDevinModelUid } from "./model-id-resolver.js";

const BASE = "gemini-4-carbon";
const HIGH = `${BASE}-high`;
const MEDIUM = `${BASE}-medium`;
const LOW = `${BASE}-low`;
let entries: SlimModelEntry[] = [];
let restoreCache: () => void;
const realFetch = globalThis.fetch;
const noNetwork = mock(async () => {
  throw new Error("Unexpected network in model-id unit tests");
});

function publish(map: ModelIdEffort, base = BASE): void {
  entries = [catalogEntry(base, [connection("devin", base, map)])];
}

function models(): DevinModelConfig[] {
  return [
    devinModel(HIGH, "high", { cost: 5 }),
    devinModel(MEDIUM, "medium", { cost: 3, isDefault: true }),
    devinModel(LOW, "low", { cost: 1 }),
  ];
}

beforeEach(() => {
  entries = [];
  noNetwork.mockClear();
  globalThis.fetch = noNetwork as unknown as typeof fetch;
  const read = spyOn(allModelsCache, "readAllModelsCache").mockImplementation(
    (): DiskCacheV3 => ({
      version: 3,
      lastUpdated: "2026-11-12T00:00:00.000Z",
      catalogGenerationId: "model-id-effort-test-data",
      entries,
      models: [],
      plans: [],
    })
  );
  const restoreEfforts = stubEffortRecommendations();
  restoreCache = () => {
    restoreEfforts();
    read.mockRestore();
  };
});

afterEach(() => {
  restoreCache();
  globalThis.fetch = realFetch;
  expect(noNetwork).not.toHaveBeenCalled();
});

describe("Devin connection modelIdEffort", () => {
  test("rule 1: an exact suffixed group representative stays fixed at conflicting effort", () => {
    const list = models();
    const resolver = new DevinModelResolver();
    const row = resolver.collapse(list.map(devinModelsCatalogEntry))[0]!;
    expect(row.id).toBe(MEDIUM);
    expect(resolver.expand(row.id, list.map(devinModelsCatalogEntry), { effort: "low" })).toBe(
      MEDIUM
    );
  });

  test("rule 1: the transport resolver also keeps the exact default's suffixed uid", () => {
    publish(effortMap({ high: HIGH, medium: MEDIUM, low: LOW }));
    expect(resolveDevinModelUid(MEDIUM, "high", models())).toBe(MEDIUM);
  });

  test("rule 1: an exact non-default effort uid is unchanged", () => {
    publish(effortMap({ high: HIGH, medium: MEDIUM, low: LOW }));
    expect(resolveDevinModelUid(LOW, "high", models())).toBe(LOW);
  });

  test("rule 2: no effort chooses medium instead of a lower provider family default", () => {
    publish(effortMap({ high: HIGH, medium: MEDIUM, low: LOW }));
    const list = models().map((model) => ({ ...model, isFamilyDefault: model.uid === LOW }));
    expect(resolveDevinModelUid(BASE, undefined, list)).toBe(MEDIUM);
  });

  test("rule 2: no family default chooses medium instead of the lowest credit cost", () => {
    publish(effortMap({ high: HIGH, medium: MEDIUM, low: LOW }));
    const list = models().map((model) => ({ ...model, isFamilyDefault: false }));
    expect(resolveDevinModelUid(BASE, undefined, list)).toBe(MEDIUM);
  });

  for (const [effort, expected] of [
    ["high", HIGH],
    ["medium", MEDIUM],
    ["low", LOW],
  ] as const) {
    test(`rule 3: published ${effort} sends its mapped wire id`, () => {
      publish(effortMap({ high: HIGH, medium: MEDIUM, low: LOW }));
      expect(resolveDevinModelUid(BASE, effort, models())).toBe(expected);
    });
  }

  test("rules 3/10: the map wins over a tempting same-effort name sibling", () => {
    const mapped = "carbon-reasoning-route";
    publish(effortMap({ high: mapped, low: LOW }));
    const list = [
      ...models(),
      devinModel(mapped, "high", {
        family: "carbon-route",
        groupLabel: "Carbon mapped connection",
        cost: 10,
      }),
    ];
    expect(resolveDevinModelUid(BASE, "high", list)).toBe(mapped);
  });

  for (const effort of ["minimal", "low", "medium", "high", "xhigh"] as const) {
    test(`rule 4: ${effort} upgrades to max when only max is published`, () => {
      publish(effortMap({ max: "glm-5-2-max" }), "glm-5-2");
      const list = [
        devinModel("glm-5-2-low", "low", { family: "glm-5.2", groupLabel: "GLM 5.2" }),
        devinModel("glm-5-2-max", "max", { family: "glm-5.2", groupLabel: "GLM 5.2", cost: 5 }),
      ];
      expect(resolveDevinModelUid("glm-5-2", effort, list)).toBe("glm-5-2-max");
    });
  }

  test("rule 4: move upward even when a lower level is strictly closer", () => {
    publish(effortMap({ max: `${BASE}-max`, low: LOW }));
    const list = [devinModel(LOW, "low"), devinModel(`${BASE}-max`, "max", { cost: 10 })];
    expect(resolveDevinModelUid(BASE, "medium", list)).toBe(`${BASE}-max`);
  });

  test("rule 4: choose the next higher level, not the first or highest map key", () => {
    publish(effortMap({ max: `${BASE}-max`, high: HIGH, low: LOW }));
    const list = [...models(), devinModel(`${BASE}-max`, "max")];
    expect(resolveDevinModelUid(BASE, "medium", list)).toBe(HIGH);
  });

  test("rule 4: above every map level uses the highest published level", () => {
    publish(effortMap({ medium: MEDIUM, low: LOW }));
    expect(resolveDevinModelUid(BASE, "max", models())).toBe(MEDIUM);
  });

  test("rule 5: none sends the published off id rather than an inferred none sibling", () => {
    const off = "carbon-without-thinking";
    publish(effortMap({ high: HIGH, low: LOW }, { off }));
    expect(
      resolveDevinModelUid(BASE, "none", [
        ...models(),
        devinModel(`${BASE}-none`, "none"),
        devinModel(off, "none"),
      ])
    ).toBe(off);
  });

  test("rule 5: none without off keeps the current resolver behaviour", () => {
    publish(effortMap({ high: HIGH, low: LOW }));
    const list = [...models(), devinModel(`${BASE}-none`, "none")];
    expect(resolveDevinModelUid(BASE, "none", list)).toBe(`${BASE}-none`);
  });

  test("rule 6: a missing mapped id falls back to the current resolver, not another map id", () => {
    publish(effortMap({ high: HIGH, medium: MEDIUM, low: "carbon-unlisted-low" }));
    // A served lower-effort spelling exists, but it is not the published low id.
    expect(resolveDevinModelUid(BASE, "low", models())).toBe(LOW);
  });

  test("rule 6: account entitlement changes whether the mapped id may be sent", () => {
    const mapped = "carbon-entitled-low";
    publish(effortMap({ high: HIGH, low: mapped }));
    const list = [...models(), devinModel(mapped, "low", { cost: 10 })];
    const present = resolveDevinModelUid(BASE, "low", list);
    const absent = resolveDevinModelUid(BASE, "low", models());
    expect({ present, absent }).toEqual({ present: mapped, absent: LOW });
  });

  test("rule 6: an unlisted off id uses the existing none behaviour", () => {
    publish(effortMap({ high: HIGH }, { off: "carbon-unlisted-off" }));
    const list = [...models(), devinModel(`${BASE}-none`, "none")];
    expect(resolveDevinModelUid(BASE, "none", list)).toBe(`${BASE}-none`);
  });

  for (const suffix of ["fast", "priority"]) {
    test(`rule 7: never auto-selects -${suffix}, even when the map names it`, () => {
      const premium = `${BASE}-max-${suffix}`;
      publish(effortMap({ max: premium, low: LOW }));
      const list = [devinModel(LOW, "low"), devinModel(premium, "max", { premium: true })];
      expect(resolveDevinModelUid(BASE, "max", list)).toBe(LOW);
      expect(resolveDevinModelUid(premium, "low", list)).toBe(premium);
    });
  }

  test("rule 8: only the connection whose externalModelId equals the base supplies the map", () => {
    const mapped = "carbon-correct-low";
    entries = [
      catalogEntry(BASE, [
        connection("antigravity", BASE, effortMap({ low: "carbon-wrong-provider" })),
        connection("devin", `${BASE}-1m`, effortMap({ low: "carbon-wrong-context" })),
        connection("devin", BASE, effortMap({ low: mapped })),
      ]),
    ];
    const list = [
      ...models(),
      devinModel(mapped, "low", { family: "carbon-route", groupLabel: "Carbon route" }),
      devinModel("carbon-wrong-provider", "low", {
        family: "carbon-route",
        groupLabel: "Carbon route",
      }),
      devinModel("carbon-wrong-context", "low", {
        family: "carbon-route",
        groupLabel: "Carbon route",
      }),
    ];
    expect(resolveDevinModelUid(BASE, "low", list)).toBe(mapped);
  });

  test("rule 8: a served 1M base uses its own map, not the default-context connection", () => {
    const base = "glm-5-2";
    entries = [
      catalogEntry(
        "glm-5.2",
        [
          connection("devin", base, effortMap({ max: "glm-5-2-max" })),
          connection(
            "devin",
            "glm-5-2-1m",
            effortMap({ max: "glm-5-2-max-1m" }, { baseServed: true })
          ),
        ],
        ["glm-5-2", "glm-5-2-1m"]
      ),
    ];
    const list = [
      devinModel("glm-5-2-max", "max", { family: "glm-5.2", groupLabel: "GLM 5.2" }),
      devinModel("glm-5-2-1m", "low", {
        family: "glm-5.2",
        groupLabel: "GLM 5.2",
        contextWindow: 1_000_000,
      }),
      devinModel("glm-5-2-max-1m", "max", {
        family: "glm-5.2",
        groupLabel: "GLM 5.2",
        contextWindow: 1_000_000,
      }),
    ];
    expect(resolveDevinModelUid("glm-5-2-1m", "high", list)).toBe("glm-5-2-max-1m");
  });

  test("rule 8: a default-context map alone cannot select a default-context id for a 1M base", () => {
    publish(effortMap({ max: "glm-5-2-max" }), "glm-5-2");
    const list = [
      devinModel("glm-5-2-max", "max", { family: "glm-5.2", groupLabel: "GLM 5.2" }),
      devinModel("glm-5-2-1m", "low", {
        family: "glm-5.2",
        groupLabel: "GLM 5.2",
        contextWindow: 1_000_000,
      }),
      devinModel("glm-5-2-max-1m", "max", {
        family: "glm-5.2",
        groupLabel: "GLM 5.2",
        contextWindow: 1_000_000,
      }),
    ];
    expect(resolveDevinModelUid("glm-5-2-1m", "high", list)).toBe("glm-5-2-max-1m");
  });

  test("rules 1/8: an exact suffixed 1M uid is fixed despite a sibling base map", () => {
    publish(effortMap({ max: "glm-5-2-max" }), "glm-5-2");
    const list = [
      devinModel("glm-5-2-max-1m", "max", { contextWindow: 1_000_000, isDefault: true }),
      devinModel("glm-5-2-low-1m", "low", { contextWindow: 1_000_000 }),
    ];
    expect(resolveDevinModelUid("glm-5-2-max-1m", "low", list)).toBe("glm-5-2-max-1m");
  });

  test("rules 8/10: a sibling map must not leak when the exact base has no map", () => {
    entries = [
      catalogEntry(BASE, [
        connection("devin", `${BASE}-1m`, effortMap({ low: "carbon-sibling-only" })),
        connection("devin", BASE),
      ]),
    ];
    expect(
      resolveDevinModelUid(BASE, "low", [
        ...models(),
        devinModel("carbon-sibling-only", "low", {
          family: "carbon-route",
          groupLabel: "Carbon route",
        }),
      ])
    ).toBe(LOW);
  });

  test("rule 10: replacing the map in the same connection changes the sent id", () => {
    const a = "carbon-low-route-a";
    const b = "carbon-low-route-b";
    const list = [...models(), devinModel(a, "low"), devinModel(b, "low")];
    publish(effortMap({ low: a }));
    const first = resolveDevinModelUid(BASE, "low", list);
    publish(effortMap({ low: b }));
    const second = resolveDevinModelUid(BASE, "low", list);
    expect([first, second]).toEqual([a, b]);
  });
});
