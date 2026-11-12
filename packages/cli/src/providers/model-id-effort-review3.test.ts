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
import { fetchEveryServedModel, invalidateModelDiscovery } from "./model-discovery.js";
import "./model-discovery-builtins.js";
import { gatherRouteCandidates } from "./route-candidates.js";
import { explainRoute } from "./routing-rules.js";
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

describe("unbound Antigravity routing preserves discovery exclusions", () => {
  let discovery: ReturnType<typeof spyOn<typeof antigravityUser, "getServedAntigravityModels">>;

  beforeEach(() => {
    invalidateModelDiscovery("antigravity");
    dynamicModelsCatalog._resetAccountModelsListsForTest();
    _resetCatalogClient();
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
    _setCatalogEntriesForTest(entries);

    const identity = spyOn(credentials, "accountIdentity").mockResolvedValue(undefined);
    const readiness = spyOn(credentials, "describeReadiness").mockImplementation(
      async (provider) => ({
        readiness: provider === "antigravity" ? "present" : "absent",
      })
    );
    const available = spyOn(credentials, "isAvailable").mockImplementation(
      async (provider) => provider === "antigravity"
    );
    const token = spyOn(antigravityToken, "getValidAntigravityAccessToken").mockResolvedValue(
      "unit-test-token"
    );
    const user = spyOn(antigravityUser, "setupAntigravityUser").mockResolvedValue({
      projectId: "unit-test-project",
      tierId: "free-tier",
    });
    discovery = spyOn(antigravityUser, "getServedAntigravityModels").mockImplementation(
      async () => ({
        ...served,
        excludedIds: served.excludedIds ? new Set(served.excludedIds) : undefined,
        meta: {},
      })
    );
    const peek = spyOn(antigravityUser, "peekServedAntigravityModels").mockReturnValue(null);
    for (const spy of [identity, readiness, available, token, user, discovery, peek]) {
      restore.push(() => spy.mockRestore());
    }
  });

  afterEach(() => {
    invalidateModelDiscovery("antigravity");
    dynamicModelsCatalog._resetAccountModelsListsForTest();
    _resetCatalogClient();
  });

  async function primeDiscovery(expectedId: string, excludedIds?: string[]) {
    const outcome = await fetchEveryServedModel("antigravity");
    expect(outcome.kind).toBe("served");
    if (outcome.kind !== "served") throw new Error("Antigravity discovery returned no models");
    expect(outcome.models.map(({ id }) => id)).toEqual([expectedId]);
    expect(outcome.excludedIds).toEqual(excludedIds);
    expect(discovery).toHaveBeenCalledTimes(1);
    expect(await credentials.accountIdentity("antigravity")).toBeUndefined();
    expect(antigravityUser.peekServedAntigravityModels()).toBeNull();
    expect(await dynamicModelsCatalog.readAccountModelsList("antigravity")).toBeNull();
  }

  async function unboundCandidates(model: string) {
    // Observe the production gatherer without replacing its implementation.
    const gather = spyOn(await import("./route-candidates.js"), "gatherRouteCandidates");
    restore.push(() => gather.mockRestore());
    const explanation = await explainRoute(model, {
      rules: {},
      defaultProvider: { provider: "", source: "config-file", legacyAutoPromoted: false },
      network: "await",
    });
    expect(gather).toHaveBeenCalledTimes(1);
    expect(gather.mock.calls[0]?.[0]).toBe(model);
    expect(gather.mock.calls[0]?.[2]?.get("antigravity")).toMatchObject({
      provider: "antigravity",
      age: "live",
      mayDeny: true,
    });
    const result = gather.mock.results[0];
    if (result?.type !== "return") throw new Error("Chain loading did not gather candidates");
    expect(discovery).toHaveBeenCalledTimes(1);
    return { explanation, candidates: result.value.candidates };
  }

  test("unbound chain loading gathers no account-listed candidate for the excluded exact high id", async () => {
    expect(lookupFamilyDefaultVariant(HIGH, "antigravity")).toBe(MEDIUM);
    await primeDiscovery(MEDIUM, [HIGH]);
    const { candidates } = await unboundCandidates(HIGH);
    expect(
      candidates.filter(
        ({ provider, source }) => provider === "antigravity" && source === "account-listed"
      )
    ).toEqual([]);
  });

  test("unbound availability does not serve the excluded exact high id from cached discovery", async () => {
    expect(lookupFamilyDefaultVariant(HIGH, "antigravity")).toBe(MEDIUM);
    await primeDiscovery(MEDIUM, [HIGH]);
    const availability = await providerServesModel("antigravity", HIGH);
    expect(discovery).toHaveBeenCalledTimes(1);
    expect(availability).not.toBe("serves");
  });

  test("control: an unbound family listed only as a tiered id is served and keeps its candidate", async () => {
    const family = "gemini-3.8-flash";
    const tiered = "gemini-3.8-flash-tiered";
    entries = [];
    served = { servedIds: [tiered], defaultId: null };
    _setCatalogEntriesForTest(entries);
    await primeDiscovery(tiered);
    expect(await providerServesModel("antigravity", family)).toBe("serves");
    const { candidates, explanation } = await unboundCandidates(family);
    expect(candidates).toContainEqual(
      expect.objectContaining({
        provider: "antigravity",
        source: "account-listed",
        wireId: family,
      })
    );
    expect(explanation.candidates).toContainEqual(
      expect.objectContaining({
        provider: "antigravity",
        wireId: family,
        outcome: "kept",
        availability: "serves",
      })
    );
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

  async function storedFastFamily() {
    const family = "carbon";
    const selected = "carbon-high-fast";
    entries = [
      {
        ...catalogEntry(selected, [connection("antigravity", selected)]),
        routeVariant: {
          kind: "preset",
          baseModelId: family,
          familyId: family,
          provider: "antigravity",
          isDefault: true,
        },
      },
    ];
    served = { servedIds: [selected], defaultId: selected };
    const lists = await storedLists([selected]);
    return { family, selected, lists };
  }

  for (const state of ["cold", "warm"] as const) {
    test(`${state}: availability serves a family whose default is a listed -fast id`, async () => {
      const { family } = await storedFastFamily();
      warm = state === "warm";
      expect(await providerServesModel("antigravity", family)).toBe("serves");
    });

    test(`${state}: gathering retains a family whose default is a listed -fast id`, async () => {
      const { family, lists } = await storedFastFamily();
      warm = state === "warm";
      expect(gatherRouteCandidates(family, undefined, lists).candidates).toContainEqual(
        expect.objectContaining({
          provider: "antigravity",
          source: "account-listed",
          wireId: family,
        })
      );
    });

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
