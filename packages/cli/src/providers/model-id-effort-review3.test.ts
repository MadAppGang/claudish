// Catalog lookups use readAllModelsCache; recommendation reads are stubbed.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { lookupFamilyDefaultVariant } from "../adapters/model-catalog.js";
import * as allModelsCache from "./all-models-cache.js";
import type { DiskCacheV3, SlimModelEntry } from "./all-models-cache.js";
import { resolveAntigravityServedModel } from "./antigravity-model-id.js";
import type { AntigravityServedSet } from "./antigravity-model-id.js";
import {
  catalogEntry,
  connection,
  effortMap,
  stubEffortRecommendations,
} from "./test-helpers/model-id-effort.js";

const BASE = "gemini-3.1-pro";
const HIGH = `${BASE}-high`;
const MEDIUM = `${BASE}-medium`;
const EFFORTS = [undefined, "low", "high"] as const;
let entries: SlimModelEntry[];
let served: AntigravityServedSet;
let restore: Array<() => void>;
const originalFetch = globalThis.fetch;
const noNetwork = mock(async () => {
  throw new Error("Unexpected network in exact model-id tests");
});

beforeEach(() => {
  entries = [
    catalogEntry(BASE, [
      connection("antigravity", BASE, effortMap({ high: HIGH, medium: MEDIUM })),
    ]),
  ];
  served = {
    servedIds: [HIGH, MEDIUM],
    excludedIds: new Set([HIGH]),
    defaultId: MEDIUM,
  };
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

describe("R7: an excluded exact id that is not a mapped base stays fixed", () => {
  for (const effort of EFFORTS) {
    test(`family default never replaces the exact high id at ${effort ?? "no"} effort`, () => {
      entries.push({
        ...catalogEntry(MEDIUM, [connection("antigravity", MEDIUM)]),
        routeVariant: {
          kind: "preset",
          baseModelId: HIGH,
          familyId: HIGH,
          provider: "antigravity",
          isDefault: true,
        },
      });
      expect(lookupFamilyDefaultVariant(HIGH, "antigravity")).toBe(MEDIUM);
      expect(resolveAntigravityServedModel(HIGH, served, effort)).toBe(HIGH);
    });

    test(`control: no family default preserves the exact high id at ${effort ?? "no"} effort`, () => {
      expect(lookupFamilyDefaultVariant(HIGH, "antigravity")).toBeUndefined();
      expect(resolveAntigravityServedModel(HIGH, served, effort)).toBe(HIGH);
    });
  }

  test("control: an excluded mapped base with no effort still selects medium", () => {
    served = {
      servedIds: [BASE, MEDIUM],
      excludedIds: new Set([BASE]),
      defaultId: BASE,
    };
    expect(resolveAntigravityServedModel(BASE, served)).toBe(MEDIUM);
  });
});
