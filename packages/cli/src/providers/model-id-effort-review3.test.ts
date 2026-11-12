// Catalog lookups use readAllModelsCache; recommendation reads are stubbed.
// Stored dynamic models catalogs come from the production discovery/refresh writer,
// then are read from an isolated directory after the in-memory lists are cleared.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookupFamilyDefaultVariant } from "../adapters/model-catalog.js";
import * as antigravityToken from "../auth/antigravity-token.js";
import * as antigravityUser from "../auth/antigravity-user.js";
import { credentials } from "../auth/credentials/authority.js";
import * as allModelsCache from "./all-models-cache.js";
import type { DiskCacheV3, SlimModelEntry } from "./all-models-cache.js";
import { resolveAntigravityServedModel } from "./antigravity-model-id.js";
import type { AntigravityServedSet } from "./antigravity-model-id.js";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "./catalog-client.js";
import * as dynamicModelsCatalog from "./dynamic-models-catalog.js";
import { providerServesModel } from "./model-availability.js";
import { invalidateModelDiscovery } from "./model-discovery.js";
import "./model-discovery-builtins.js";
import { gatherRouteCandidates } from "./route-candidates.js";
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

describe("an excluded exact id that is not a mapped base stays fixed", () => {
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

describe("stored Antigravity exact-id routing agrees with transport", () => {
  const readAccountModelsList = dynamicModelsCatalog.readAccountModelsList;
  let directory: string;
  let options: { dir: string; keyPath: string };
  let warm: boolean;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "antigravity-exact-id-"));
    options = { dir: directory, keyPath: join(directory, "catalog.key") };
    warm = false;
    invalidateModelDiscovery("antigravity");
    dynamicModelsCatalog._resetAccountModelsListsForTest();
    _resetCatalogClient();
    const identity = spyOn(credentials, "accountIdentity").mockResolvedValue("test-account");
    const token = spyOn(antigravityToken, "getValidAntigravityAccessToken").mockResolvedValue(
      "unit-test-token"
    );
    const user = spyOn(antigravityUser, "setupAntigravityUser").mockResolvedValue({
      projectId: "unit-test-project",
      tierId: "free-tier",
    });
    const fullServedSet = () => ({
      ...served,
      excludedIds: served.excludedIds ? new Set(served.excludedIds) : undefined,
      meta: {},
    });
    const discovery = spyOn(antigravityUser, "getServedAntigravityModels").mockImplementation(
      async () => fullServedSet()
    );
    const peek = spyOn(antigravityUser, "peekServedAntigravityModels").mockImplementation(() =>
      warm ? fullServedSet() : null
    );
    // Keep the production reader, but bind availability's implicit read to test-owned storage.
    const lists = spyOn(dynamicModelsCatalog, "readAccountModelsList").mockImplementation(
      (provider) => readAccountModelsList(provider, options)
    );
    for (const spy of [identity, token, user, discovery, peek, lists]) {
      restore.push(() => spy.mockRestore());
    }
  });

  afterEach(() => {
    invalidateModelDiscovery("antigravity");
    dynamicModelsCatalog._resetAccountModelsListsForTest();
    _resetCatalogClient();
    rmSync(directory, { recursive: true, force: true });
  });

  async function storedLists(expectedIds: string[]) {
    _setCatalogEntriesForTest(entries);
    const refreshed = await dynamicModelsCatalog.refreshAccountModelsList(
      "antigravity",
      "picker-open",
      { ...options, minAgeMs: 0 }
    );
    expect(refreshed).toMatchObject({ kind: "refreshed", outcome: { kind: "served" } });
    // Read back from disk, not the refresh's live memory or discovery's cached answer.
    dynamicModelsCatalog._resetAccountModelsListsForTest();
    invalidateModelDiscovery("antigravity");
    const lists = await dynamicModelsCatalog.loadAccountModelsLists(["antigravity"], options);
    const list = lists.get("antigravity");
    expect(list?.models.map(({ id }) => id)).toEqual(expectedIds);
    expect(list).toMatchObject({ age: "live", mayDeny: true });
    return lists;
  }

  function addExactIdFamilyDefault() {
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
  }

  for (const state of ["cold", "warm"] as const) {
    test(`${state === "warm" ? "control: " : ""}${state}: availability rejects the excluded exact high id`, async () => {
      addExactIdFamilyDefault();
      await storedLists([MEDIUM]);
      // Cache warmth changes only the full served set, never the stored list.
      warm = true;
      const warmAnswer = await providerServesModel("antigravity", HIGH);
      expect(warmAnswer).toBe("not-served");
      warm = state === "warm";
      expect(await providerServesModel("antigravity", HIGH)).toBe(warmAnswer);
    });

    test(`${state}: gathering cannot use medium as evidence for the excluded exact high id`, async () => {
      addExactIdFamilyDefault();
      const lists = await storedLists([MEDIUM]);
      warm = state === "warm";
      const { candidates } = gatherRouteCandidates(HIGH, undefined, lists);
      // Account-listed candidates keep the requested wire id, even when their
      // entitlement was incorrectly inferred from another listed id.
      expect(
        candidates.filter(
          ({ provider, source }) => provider === "antigravity" && source === "account-listed"
        )
      ).toEqual([]);
    });

    test(`control: ${state} family base is served through its listed tiered id`, async () => {
      const family = "gemini-3.8-flash";
      const tiered = "gemini-3.8-flash-tiered";
      entries = [];
      served = { servedIds: [tiered], defaultId: null };
      const lists = await storedLists([tiered]);
      warm = state === "warm";
      expect(resolveAntigravityServedModel(family, served)).toBe(tiered);
      expect(await providerServesModel("antigravity", family)).toBe("serves");
      expect(gatherRouteCandidates(family, undefined, lists).candidates).toContainEqual(
        expect.objectContaining({
          provider: "antigravity",
          source: "account-listed",
          wireId: family,
        })
      );
    });
  }

  test("control: transport preserves the excluded exact high id with a family default", async () => {
    addExactIdFamilyDefault();
    await storedLists([MEDIUM]);
    for (const effort of EFFORTS) {
      expect(resolveAntigravityServedModel(HIGH, served, effort)).toBe(HIGH);
    }
  });
});
