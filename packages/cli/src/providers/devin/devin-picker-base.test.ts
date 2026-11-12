// No-effort seams: lookupModelEfforts / bundledEffortRecommendations.
// collapse reads readAllModelsCache; disk reads are stubbed.
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
import { resolveDevinModelUid } from "./model-id-resolver.js";

const BASE = "claude-opus-5-5";
const LOW = `${BASE}-low`;
const MEDIUM = `${BASE}-medium`;
const HIGH = `${BASE}-high`;
const LABEL = "Claude Opus 5.5";
const resolver = new DevinModelResolver();
const models = () => [
  devinModel(HIGH, "high", { family: BASE, groupLabel: LABEL, cost: 5 }),
  devinModel(MEDIUM, "medium", { family: BASE, groupLabel: LABEL, cost: 3, isDefault: true }),
  devinModel(LOW, "low", { family: BASE, groupLabel: LABEL, cost: 1 }),
];
let entries: SlimModelEntry[];
let restore: Array<() => void>;
const originalFetch = globalThis.fetch;
const noNetwork = mock(async () => {
  throw new Error("Unexpected network in Devin picker base tests");
});

beforeEach(() => {
  entries = [
    catalogEntry("claude-opus-5.5", [
      connection("devin", BASE, effortMap({ high: HIGH, medium: MEDIUM, low: LOW })),
    ]),
  ];
  noNetwork.mockClear();
  globalThis.fetch = noNetwork as unknown as typeof fetch;
  const disk = spyOn(allModelsCache, "readAllModelsCache").mockImplementation(
    (): DiskCacheV3 => ({
      version: 3,
      lastUpdated: "2026-11-12T00:00:00.000Z",
      catalogGenerationId: "model-id-effort-test-data",
      entries,
      models: [],
      plans: [],
    })
  );
  restore = [() => disk.mockRestore(), stubEffortRecommendations()];
});

afterEach(() => {
  for (const undo of restore.reverse()) undo();
  globalThis.fetch = originalFetch;
  expect(noNetwork).not.toHaveBeenCalled();
});

describe("Devin picker mapped base", () => {
  test("H1 a mapped effort group shows the connection base, not its medium representative", () => {
    const rows = resolver.collapse(models().map(devinModelsCatalogEntry));
    expect(rows.map((row) => row.id)).toEqual([BASE]);
  });

  test("H2 launching the picker row at low sends the mapped low id", () => {
    const list = models();
    const rows = resolver.collapse(list.map(devinModelsCatalogEntry));
    const id = rows[0]!.id;
    expect({
      expand: resolver.expand(id, list.map(devinModelsCatalogEntry), { effort: "low" }),
      uid: resolveDevinModelUid(id, "low", list),
    }).toEqual({ expand: LOW, uid: LOW });
  });

  test("H2 launching the picker row without effort uses medium, not the provider low default", () => {
    const list = models().map((model) => ({ ...model, isFamilyDefault: model.uid === LOW }));
    const rows = resolver.collapse(list.map(devinModelsCatalogEntry));
    const id = rows[0]!.id;
    expect({
      expand: resolver.expand(id, list.map(devinModelsCatalogEntry), {}),
      uid: resolveDevinModelUid(id, undefined, list),
    }).toEqual({ expand: MEDIUM, uid: MEDIUM });
  });

  test("H3 a group with no catalog map keeps its provider default row id", () => {
    entries = [catalogEntry("claude-opus-5.5", [connection("devin", BASE)])];
    expect(resolver.collapse(models().map(devinModelsCatalogEntry)).map((row) => row.id)).toEqual([
      MEDIUM,
    ]);
  });

  function contextGroups() {
    const base = "glm-5-2";
    const extended = `${base}-1m`;
    const high = `${base}-high`;
    const max = `${base}-max`;
    const extendedMax = `${base}-max-1m`;
    const list = [
      devinModel(high, "high", { family: "glm-5.2", groupLabel: "GLM 5.2", isDefault: true }),
      devinModel(max, "max", { family: "glm-5.2", groupLabel: "GLM 5.2" }),
      devinModel(extendedMax, "max", {
        family: "glm-5.2",
        groupLabel: "GLM 5.2",
        contextWindow: 1_000_000,
        isDefault: true,
      }),
    ];
    entries = [
      catalogEntry("glm-5.2", [
        connection("devin", base, effortMap({ max, high })),
        connection("devin", extended, effortMap({ max: extendedMax })),
      ]),
    ];
    return { base, extended, extendedMax, list };
  }

  test("H4 a 1M picker group uses only its own connection base", () => {
    const { base, extended, list } = contextGroups();
    const rows = resolver.collapse(list.map(devinModelsCatalogEntry));
    expect(rows.map(({ id, contextWindow }) => ({ id, contextWindow }))).toEqual([
      { id: base, contextWindow: 200_000 },
      { id: extended, contextWindow: 1_000_000 },
    ]);
  });

  test("H4 a 1M group without its own map never takes the default-context base", () => {
    const { extendedMax, list } = contextGroups();
    entries[0]!.aggregators = entries[0]!.aggregators!.slice(0, 1);
    const row = resolver
      .collapse(list.map(devinModelsCatalogEntry))
      .find((row) => row.contextWindow === 1_000_000);
    expect(row?.id).toBe(extendedMax);
  });

  function crossContextMap() {
    const base = "glm-5-2";
    const high = `${base}-high`;
    const extendedMax = `${base}-max-1m`;
    entries = [
      catalogEntry("glm-5.2", [connection("devin", base, effortMap({ high, max: extendedMax }))]),
    ];
    const list = [
      devinModel(high, "high", {
        family: "glm-5.2",
        groupLabel: "GLM 5.2",
        contextWindow: 200_000,
        isDefault: true,
      }),
      devinModel(extendedMax, "max", {
        family: "glm-5.2",
        groupLabel: "GLM 5.2",
        contextWindow: 1_000_000,
        isDefault: true,
      }),
    ];
    return { base, high, extendedMax, list };
  }

  test("R5 one connection spanning 200K and 1M never emits duplicate picker ids", () => {
    const { list } = crossContextMap();
    const rows = resolver.collapse(list.map(devinModelsCatalogEntry));
    expect(rows.map((row) => row.contextWindow)).toEqual([200_000, 1_000_000]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });

  test("R5 the 1M row retains its representative and never launches the 200K high id", () => {
    const { extendedMax, list } = crossContextMap();
    const catalog = list.map(devinModelsCatalogEntry);
    const row = resolver.collapse(catalog).find((row) => row.contextWindow === 1_000_000)!;
    expect({
      expand: resolver.expand(row.id, catalog, {}),
      uid: resolveDevinModelUid(row.id, undefined, list),
    }).toEqual({ expand: extendedMax, uid: extendedMax });
    expect(row.id).toBe(extendedMax);
  });

  test("R8 a served base stays with its real context group in either discovery order", () => {
    const base = "glm-5-2";
    const high = `${base}-high`;
    entries = [
      catalogEntry("glm-5.2", [
        connection("devin", base, effortMap({ high }, { baseServed: true })),
      ]),
    ];
    const list = [
      devinModel(high, "high", {
        family: "glm-5.2",
        groupLabel: "GLM 5.2",
        contextWindow: 200_000,
      }),
      devinModel(base, "medium", {
        family: "glm-5.2",
        groupLabel: "GLM 5.2",
        contextWindow: 1_000_000,
      }),
    ];
    // Compute both orders before asserting, so both discovery orders are exercised.
    const results = [list, [...list].reverse()].map((discovered) => {
      const catalog = discovered.map(devinModelsCatalogEntry);
      const rows = resolver.collapse(catalog);
      const launch = (contextWindow: number) => {
        const row = rows.find((row) => row.contextWindow === contextWindow)!;
        return {
          id: row.id,
          expand: resolver.expand(row.id, catalog, {}),
          uid: resolveDevinModelUid(row.id, undefined, discovered),
        };
      };
      return {
        uniqueIds: new Set(rows.map((row) => row.id)).size,
        rowCount: rows.length,
        standard: launch(200_000),
        extended: launch(1_000_000),
      };
    });
    const expected = {
      uniqueIds: 2,
      rowCount: 2,
      standard: { id: high, expand: high, uid: high },
      extended: { id: base, expand: base, uid: base },
    };
    expect(results).toEqual([expected, expected]);
  });

  test("R9 a 1M group keeps its representative when the base resolves to an unmapped 200K sibling", () => {
    const base = "glm-5-2";
    const low = `${base}-low`;
    const high = `${base}-high`;
    const extendedMax = `${base}-max-1m`;
    entries = [
      catalogEntry("glm-5.2", [connection("devin", base, effortMap({ high, max: extendedMax }))]),
    ];
    const list = [
      devinModel(low, "low", {
        family: "glm-5.2",
        groupLabel: "GLM 5.2",
        contextWindow: 200_000,
      }),
      devinModel(extendedMax, "max", {
        family: "glm-5.2",
        groupLabel: "GLM 5.2",
        contextWindow: 1_000_000,
      }),
    ];
    const catalog = list.map(devinModelsCatalogEntry);
    expect({
      expand: resolver.expand(base, catalog, {}),
      uid: resolveDevinModelUid(base, undefined, list),
    }).toEqual({ expand: low, uid: low });
    const rows = resolver.collapse(catalog);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    const row = rows.find((row) => row.contextWindow === 1_000_000)!;
    expect({
      id: row.id,
      expand: resolver.expand(row.id, catalog, {}),
      uid: resolveDevinModelUid(row.id, undefined, list),
    }).toEqual({ id: extendedMax, expand: extendedMax, uid: extendedMax });
  });

  test("H5 choosing the mapped base leaves the displayed label unchanged", () => {
    const catalog = models().map(devinModelsCatalogEntry);
    const mappedLabel = resolver.collapse(catalog)[0]!.displayName;
    entries = [];
    const oldLabel = resolver.collapse(catalog)[0]!.displayName;
    expect({ mappedLabel, oldLabel }).toEqual({ mappedLabel: LABEL, oldLabel: LABEL });
  });
});
