import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as antigravityUser from "../auth/antigravity-user.js";
import type { AntigravityServedModels } from "../auth/antigravity-user.js";
import { credentials } from "../auth/credentials/authority.js";
import * as allModelsCache from "./all-models-cache.js";
import type { DiskCacheV3, SlimModelEntry } from "./all-models-cache.js";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "./catalog-client.js";
import { catalogRouteForProvider } from "./catalog-route-bindings.js";
import { providerServesModel } from "./model-availability.js";
import {
  type FetcherResult,
  discoverProviderModelsCatalog,
  getModelDiscoveryFetcher,
  invalidateModelDiscovery,
  registerModelDiscoveryFetcher,
} from "./model-discovery.js";
import "./model-discovery-builtins.js";
import { route } from "./routing-rules.js";
import { resolveAntigravityServedModel } from "./transport/antigravity.js";

// Structural inputs from ai-docs/reports/model-failures-2026-10-21.md, D8:
// the account serves the tiered id, not the requested bare family name.
const FAMILY = "gemini-3.8-flash";
const TIERED = "gemini-3.8-flash-tiered";
const MISSING = "gemini-9-flash"; // Negative input specified by the T6 brief.
const TIMEOUT = 20_000;

const realFetch = globalThis.fetch;
const realGetRequestAuth = credentials.getRequestAuth;
const realIsAvailable = credentials.isAvailable;
const realDescribeReadiness = credentials.describeReadiness;
const realDiscovery = getModelDiscoveryFetcher("antigravity");
if (!realDiscovery) throw new Error("Antigravity discovery fetcher was not registered");

let servedCache: AntigravityServedModels | null = null;
let diskCache: DiskCacheV3 | null = null;
let restoreCacheReads: () => void = () => {};
const networkFetch = mock(async () => {
  throw new Error("T6 must not fetch or contact a real account");
});

function setCatalog(entries: SlimModelEntry[]): void {
  _setCatalogEntriesForTest(entries);
  // This is an in-memory cache object, not a fabricated provider response.
  diskCache = {
    version: 3,
    lastUpdated: "2026-10-21T00:00:00.000Z",
    entries,
    models: entries.map(({ modelId }) => ({ id: modelId })),
    plans: [],
    catalogGenerationId: "T6-offline",
  };
}

function installAccount(
  servedIds: string[],
  defaultId: string | null = null,
  selectableIds = servedIds,
  populateCache = true
) {
  const cached: AntigravityServedModels = { servedIds, defaultId, meta: {} };
  const discovery = mock(async (): Promise<FetcherResult> => {
    // Discovery and the documented cache-read seam share this structural input.
    servedCache = populateCache ? cached : null;
    return { kind: "models", models: selectableIds.map((id) => ({ id })) };
  });
  registerModelDiscoveryFetcher("antigravity", discovery);
  return discovery;
}

beforeEach(() => {
  servedCache = null;
  diskCache = null;
  _resetCatalogClient();
  _setCatalogEntriesForTest([]);
  invalidateModelDiscovery();
  antigravityUser._resetAntigravityServedModelsCache();

  // Intercept disk/cache reads rather than touching ~/.claudish or auth files.
  const diskRead = spyOn(allModelsCache, "readAllModelsCache").mockImplementation(() => diskCache);
  const servedRead = spyOn(antigravityUser, "peekServedAntigravityModels").mockImplementation(
    () => servedCache
  );
  restoreCacheReads = () => {
    servedRead.mockRestore();
    diskRead.mockRestore();
  };

  credentials.getRequestAuth = mock(async () => ({ headers: {} }));
  credentials.isAvailable = async (provider: string) => provider === "antigravity";
  credentials.describeReadiness = async (provider: string) => ({
    readiness: provider === "antigravity" ? "present" : "absent",
  });
  networkFetch.mockClear();
  globalThis.fetch = networkFetch as unknown as typeof fetch;
});

afterEach(() => {
  restoreCacheReads();
  registerModelDiscoveryFetcher("antigravity", realDiscovery);
  invalidateModelDiscovery();
  antigravityUser._resetAntigravityServedModelsCache();
  _resetCatalogClient();
  credentials.getRequestAuth = realGetRequestAuth;
  credentials.isAvailable = realIsAvailable;
  credentials.describeReadiness = realDescribeReadiness;
  globalThis.fetch = realFetch;
  expect(networkFetch).not.toHaveBeenCalled();
});

describe("T6 G1 — Antigravity serves a family through its tiered variant", () => {
  test(
    "the explicit ag@ spec is available when discovery lists only the tiered id",
    async () => {
      installAccount([TIERED]);

      expect(await providerServesModel("antigravity", FAMILY)).toBe("serves");
      const plan = await route(`ag@${FAMILY}`, {}, "openrouter");

      expect(plan.kind).toBe("ok");
      if (plan.kind !== "ok") throw new Error(plan.reason);
      expect(plan.primary.provider).toBe("antigravity");
      expect(plan.primary.modelSpec).toBe(`ag@${FAMILY}`);
    },
    TIMEOUT
  );

  test(
    "the bare-name availability filter keeps the ag@ hop",
    async () => {
      installAccount([TIERED]);
      setCatalog([
        {
          modelId: FAMILY,
          aliases: [],
          aggregators: [
            {
              sourceProviderId: "antigravity",
              sourceCollectorId: "T6",
              routeStatus: "mapped",
              route: catalogRouteForProvider("antigravity"),
              externalModelId: FAMILY,
              confidence: "api_official",
            },
          ],
        },
      ]);

      const plan = await route(FAMILY, {}, "openrouter");

      expect(plan.kind).toBe("ok");
      if (plan.kind !== "ok") throw new Error(plan.reason);
      expect(plan.primary.provider).toBe("antigravity");
      expect(plan.primary.modelSpec).toBe(`ag@${FAMILY}`);
    },
    TIMEOUT
  );
});

interface ParityCase {
  name: string;
  requested: string;
  servedIds: string[];
  defaultId: string | null;
  selectableIds?: string[];
  catalogDefault?: string;
  populateCache?: boolean;
  resolvedId: string;
  verdict: "serves" | "not-served";
}

// The 2.5-pro and 3.5-flash ids also come from report D8's observed account list.
const parityCases: ParityCase[] = [
  {
    name: "exact served id",
    requested: "gemini-2.5-pro",
    servedIds: [TIERED, "gemini-2.5-pro"],
    defaultId: TIERED,
    resolvedId: "gemini-2.5-pro",
    verdict: "serves",
  },
  {
    name: "bare family with a tiered variant",
    requested: FAMILY,
    servedIds: [TIERED, "gemini-2.5-pro"],
    defaultId: "gemini-2.5-pro",
    resolvedId: TIERED,
    verdict: "serves",
  },
  {
    name: "catalog-default variant instead of the stronger tier",
    requested: "gemini-3.5-flash",
    servedIds: ["gemini-3.5-flash-low", "gemini-3.5-flash-extra-low"],
    defaultId: null,
    catalogDefault: "gemini-3.5-flash-extra-low",
    resolvedId: "gemini-3.5-flash-extra-low",
    verdict: "serves",
  },
  {
    name: "catalog-default variant is unselectable despite another selectable tier",
    requested: "gemini-3.5-flash",
    servedIds: ["gemini-3.5-flash-low", "gemini-3.5-flash-extra-low"],
    defaultId: null,
    selectableIds: ["gemini-3.5-flash-low"],
    catalogDefault: "gemini-3.5-flash-extra-low",
    resolvedId: "gemini-3.5-flash-extra-low",
    verdict: "not-served",
  },
  {
    name: "backend default is unselectable despite another selectable tier",
    requested: "gemini-3.5-flash",
    servedIds: ["gemini-3.5-flash-low", "gemini-3.5-flash-extra-low"],
    defaultId: "gemini-3.5-flash-extra-low",
    selectableIds: ["gemini-3.5-flash-low"],
    resolvedId: "gemini-3.5-flash-extra-low",
    verdict: "not-served",
  },
  {
    name: "id the account does not serve",
    requested: MISSING,
    servedIds: [TIERED, "gemini-2.5-pro"],
    defaultId: TIERED,
    resolvedId: MISSING,
    verdict: "not-served",
  },
  {
    name: "no served-models cache uses discovery ids with no backend default",
    requested: FAMILY,
    servedIds: [TIERED],
    defaultId: null,
    populateCache: false,
    resolvedId: TIERED,
    verdict: "serves",
  },
];

describe("T6 G2 — availability agrees with the transport resolver", () => {
  test.each(parityCases)(
    "$name",
    async (row) => {
      const selectableIds = row.selectableIds ?? row.servedIds;
      installAccount(row.servedIds, row.defaultId, selectableIds, row.populateCache ?? true);
      if (row.catalogDefault) {
        setCatalog([
          {
            modelId: row.catalogDefault,
            aliases: [],
            routeVariant: {
              kind: "preset",
              familyId: row.requested,
              provider: "antigravity",
              isDefault: true,
            },
          },
        ]);
      }
      await discoverProviderModelsCatalog("antigravity");
      const transportInputs =
        row.populateCache === false
          ? { servedIds: selectableIds, defaultId: null }
          : { servedIds: row.servedIds, defaultId: row.defaultId };
      const resolved = resolveAntigravityServedModel(row.requested, transportInputs);

      expect(resolved).toBe(row.resolvedId);
      const transportVerdict = selectableIds.includes(resolved) ? "serves" : "not-served";
      expect(transportVerdict).toBe(row.verdict);
      expect(await providerServesModel("antigravity", row.requested)).toBe(transportVerdict);
    },
    TIMEOUT
  );
});

describe("T6 G3 — an unserved id cannot keep an Antigravity hop", () => {
  test(
    "reports not-served when resolution finds no served id",
    async () => {
      installAccount([TIERED]);

      expect(await providerServesModel("antigravity", MISSING)).toBe("not-served");
    },
    TIMEOUT
  );

  test(
    "drops the ag@ hop from a bare-name routing chain",
    async () => {
      installAccount([TIERED]);
      const rules = { "gemini-*": ["antigravity"] };
      // The positive control proves credentials and this rule can retain ag@.
      expect((await route(FAMILY, rules, "openrouter")).kind).toBe("ok");

      const plan = await route(MISSING, rules, "openrouter");

      expect(plan.kind).toBe("no-route");
    },
    TIMEOUT
  );
});

describe("T6 G4 — availability reuses the cache discovery filled", () => {
  test(
    "adds no discovery or fetch calls after discovery has populated the cache",
    async () => {
      const discovery = installAccount([TIERED], TIERED);
      await discoverProviderModelsCatalog("antigravity");
      expect(discovery).toHaveBeenCalledTimes(1);
      expect(servedCache?.servedIds).toEqual([TIERED]);

      expect(await providerServesModel("antigravity", FAMILY)).toBe("serves");
      expect(await providerServesModel("antigravity", TIERED)).toBe("serves");
      expect(await providerServesModel("antigravity", MISSING)).toBe("not-served");
      expect((await route(`ag@${FAMILY}`, {}, "openrouter")).kind).toBe("ok");
      expect((await route(FAMILY, { "gemini-*": ["antigravity"] }, "openrouter")).kind).toBe("ok");

      expect(discovery).toHaveBeenCalledTimes(1);
      expect(networkFetch).not.toHaveBeenCalled();
    },
    TIMEOUT
  );
});
