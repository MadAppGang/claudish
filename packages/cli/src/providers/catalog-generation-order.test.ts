/**
 * A stale full refresh reports the KEPT generation through the existing
 * RefreshOutcome { kind: "refreshed", catalogGenerationId, modelCount } fields.
 * This asserts the caller's usable result, not that the downloaded generation
 * was installed. No new export or result type is required; pages is not asserted
 * when the downloaded generation loses to the file already on disk.
 *
 * Generation ids are opaque: their lexical order deliberately opposes publication
 * time. The deciding times are the envelope's generatedAt and disk's lastUpdated.
 * A synchronous external-file write at the second-page fetch models another
 * process publishing after this refresh pinned its first page, without sleeps.
 *
 * All fetches are replaced. Explicit cache paths own every models/routes/efforts
 * file; the test preload supplies a temporary HOME for incidental default reads.
 * Efforts are written by the separate recommendations path, not refreshCatalog;
 * their preservation is a control, not a claim that full refresh fetches efforts.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type DiskCacheV3,
  _clearAllModelsCacheMemo,
  readAllModelsCache,
  routeRegistryPathFor,
} from "./all-models-cache.js";
import { _resetCatalogClient, getCatalogEntries, refreshCatalog } from "./catalog-client.js";
import { CATALOG_V3_ACCEPT } from "./catalog-v3.js";
import {
  effortRecommendationsPathFor,
  readEffortRecommendations,
  writeEffortRecommendations,
} from "./effort-recommendations.js";

const originalFetch = globalThis.fetch;
const envNames = [
  "CLAUDISH_CATALOG_URL",
  "CLAUDISH_PLANS_URL",
  "CLAUDISH_DISABLE_CATALOG_WARM",
] as const;
const savedEnv = new Map(envNames.map((name) => [name, process.env[name]]));
let directory: string;
let cachePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "claudish-generation-order-"));
  cachePath = join(directory, "cloud-models-catalog-v3.json");
  _resetCatalogClient();
  _clearAllModelsCacheMemo();
  process.env.CLAUDISH_CATALOG_URL = "https://generation-order.test/queryModels?catalog=slim";
  process.env.CLAUDISH_PLANS_URL = "https://generation-order.test/queryPlans";
  delete process.env.CLAUDISH_DISABLE_CATALOG_WARM;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of envNames) {
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  _resetCatalogClient();
  _clearAllModelsCacheMemo();
  rmSync(directory, { recursive: true, force: true });
});

function generation(id: string, publishedAt: string, count: number): DiskCacheV3 {
  return {
    version: 3,
    catalogGenerationId: id,
    lastUpdated: publishedAt,
    entries: Array.from({ length: count }, (_, index) => ({
      modelId: `${id}-model-${index}`,
      aliases: [],
      inputModalities: ["text"],
      outputModalities: ["text"],
      aggregators: [
        {
          sourceProviderId: "test-labs",
          sourceCollectorId: "test",
          confidence: "api_official",
          routeStatus: "mapped",
          route: { routeId: "test-labs", routeProfileId: "direct-api" },
          externalModelId: `${id}-wire-${index}`,
          wire: { status: "unknown", evidence: [] },
        },
      ],
    })),
    models: [],
    plans: [
      {
        id: `${id}-subscription`,
        routeStatus: "supported",
        route: { routeId: "test-labs", routeProfileId: "direct-api" },
        modelDiscovery: "catalog",
      },
    ],
    routeRegistry: {
      generationId: id,
      registry: {
        registryVersion: "3.7.0",
        routes: {
          "test-labs": {
            routeId: "test-labs",
            profiles: {
              "direct-api": {
                kind: "direct",
                apis: {
                  "chat-completions": { baseUrl: `https://${id}.test/v1` },
                },
              },
            },
          },
        },
      },
    },
  };
}

const older = generation("z-opaque-old", "2026-11-04T11:20:00.000Z", 2);
const newer = generation("a-opaque-new", "2026-11-04T12:17:00.000Z", 3);

function envelope(cache: DiskCacheV3, data: unknown): Response {
  return Response.json({
    contractVersion: 3,
    generationId: cache.catalogGenerationId,
    generatedAt: cache.lastUpdated,
    data,
  });
}

function serve(cache: DiskCacheV3, onSecondPage?: () => void) {
  const calls: Array<{ url: URL; accept: string | null }> = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, accept: new Headers(init?.headers).get("accept") });
    if (url.origin !== "https://generation-order.test") {
      throw new Error(`Unexpected fetch: ${url}`);
    }
    if (url.searchParams.get("catalog") === "routes") {
      return envelope(cache, { mode: "routes", registry: cache.routeRegistry!.registry });
    }
    if (url.pathname === "/queryPlans") {
      return envelope(cache, { plans: cache.plans, total: cache.plans.length });
    }
    if (url.pathname !== "/queryModels") throw new Error(`Unexpected fetch: ${url}`);
    const secondPage = url.searchParams.has("cursor");
    if (secondPage) onSecondPage?.();
    return envelope(cache, {
      mode: "slim",
      models: secondPage ? cache.entries.slice(1) : cache.entries.slice(0, 1),
      total: cache.entries.length,
      ...(secondPage ? {} : { nextCursor: "opaque-next-page" }),
    });
  }) as unknown as typeof fetch;
  return calls;
}

function expectPinnedRequests(calls: ReturnType<typeof serve>, cache: DiskCacheV3): void {
  expect(
    calls.map(({ url, accept }) => ({
      path: url.pathname,
      cursor: url.searchParams.get("cursor"),
      generation: url.searchParams.get("generationId"),
      routes: url.searchParams.get("catalog") === "routes",
      accept,
    }))
  ).toEqual([
    {
      path: "/queryModels",
      cursor: null,
      generation: null,
      routes: false,
      accept: CATALOG_V3_ACCEPT,
    },
    {
      path: "/queryModels",
      cursor: "opaque-next-page",
      generation: cache.catalogGenerationId,
      routes: false,
      accept: CATALOG_V3_ACCEPT,
    },
    {
      path: "/queryPlans",
      cursor: null,
      generation: cache.catalogGenerationId,
      routes: false,
      accept: CATALOG_V3_ACCEPT,
    },
    {
      path: "/queryModels",
      cursor: null,
      generation: cache.catalogGenerationId,
      routes: true,
      accept: CATALOG_V3_ACCEPT,
    },
  ]);
}

/** Write bytes like another process, without invalidating this process's memo. */
function publishExternally(cache: DiskCacheV3): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache));
  writeFileSync(routeRegistryPathFor(cachePath), JSON.stringify(cache.routeRegistry));
  writeEffortRecommendations(
    cache.catalogGenerationId,
    {
      [cache.entries[0]!.modelId]: {
        coding: {
          effort: "high",
          sendableOn: [
            {
              routeId: "test-labs",
              routeProfileId: "direct-api",
              externalModelId: cache.entries[0]!.aggregators![0]!.externalModelId,
              encoding: "request_parameter",
            },
          ],
        },
      },
    },
    effortRecommendationsPathFor(cachePath)
  );
}

function bytes(path: string): string {
  return readFileSync(path, "utf8");
}

async function staleRefresh(timing: "before" | "during" = "during") {
  // Prime both memory copies with M, so keeping N on disk alone cannot pass.
  serve(older);
  expect(await refreshCatalog(1000, { cachePath })).toMatchObject({
    kind: "refreshed",
    catalogGenerationId: older.catalogGenerationId,
  });
  expect(readAllModelsCache(cachePath)?.entries).toEqual(older.entries);
  expect(getCatalogEntries()).toEqual(older.entries);

  let heldModels = "";
  let heldRoutes = "";
  let heldEfforts = "";
  const publishNewer = () => {
    publishExternally(newer);
    heldModels = bytes(cachePath);
    heldRoutes = bytes(routeRegistryPathFor(cachePath));
    heldEfforts = bytes(effortRecommendationsPathFor(cachePath));
    // Exercise the memoized reader before M's final write too.
    expect(readAllModelsCache(cachePath)?.catalogGenerationId).toBe(newer.catalogGenerationId);
  };
  if (timing === "before") publishNewer();
  const calls = serve(older, timing === "during" ? publishNewer : undefined);
  const outcome = await refreshCatalog(1000, { cachePath });
  expectPinnedRequests(calls, older);
  expect(heldModels).not.toBe("");
  return { outcome, heldModels, heldRoutes, heldEfforts };
}

describe("full cloud models catalog refresh publication order", () => {
  test.each(["before", "during"] as const)(
    "keeps newer disk bytes when N arrives %s the older paginated refresh",
    async (timing) => {
      const { heldModels } = await staleRefresh(timing);
      expect(bytes(cachePath)).toBe(heldModels);
    }
  );

  test("reports the kept newer generation and its model count, not downloaded M", async () => {
    const { outcome } = await staleRefresh();
    expect(outcome).toMatchObject({
      kind: "refreshed",
      catalogGenerationId: newer.catalogGenerationId,
      modelCount: newer.entries.length,
    });
  });

  test("does not replace N's routes sidecar with M's registry", async () => {
    const { heldRoutes } = await staleRefresh();
    expect(bytes(routeRegistryPathFor(cachePath))).toBe(heldRoutes);
  });

  test("leaves the separately written N efforts sidecar unchanged", async () => {
    const { heldEfforts } = await staleRefresh();
    expect(bytes(effortRecommendationsPathFor(cachePath))).toBe(heldEfforts);
    const efforts = readEffortRecommendations(effortRecommendationsPathFor(cachePath));
    expect(Object.keys(efforts!.generations)).toEqual([newer.catalogGenerationId]);
    expect(efforts!.generations[newer.catalogGenerationId]!.efforts).toHaveProperty(
      newer.entries[0]!.modelId
    );
  });

  test("readAllModelsCache serves all of N after rejecting the older refresh", async () => {
    await staleRefresh();
    expect(readAllModelsCache(cachePath)).toEqual(newer);
  });

  test("the in-process catalog memory serves N rather than downloaded M", async () => {
    await staleRefresh();
    expect(getCatalogEntries()).toEqual(newer.entries);
    expect(getCatalogEntries()).toEqual(readAllModelsCache(cachePath)?.entries ?? null);
  });

  test("installs a newer publication despite its lexically smaller generation id", async () => {
    publishExternally(older);
    expect(readAllModelsCache(cachePath)?.catalogGenerationId).toBe(older.catalogGenerationId);
    const calls = serve(newer);
    expect(await refreshCatalog(1000, { cachePath })).toEqual({
      kind: "refreshed",
      catalogGenerationId: newer.catalogGenerationId,
      modelCount: newer.entries.length,
      pages: 2,
    });
    expectPinnedRequests(calls, newer);
    expect(JSON.parse(bytes(cachePath))).toEqual(newer);
    expect(JSON.parse(bytes(routeRegistryPathFor(cachePath)))).toEqual(newer.routeRegistry);
    expect(readAllModelsCache(cachePath)).toEqual(newer);
    expect(getCatalogEntries()).toEqual(newer.entries);
  });

  test("an equal generation leaves the result, disk, routes and memory consistent", async () => {
    publishExternally(newer);
    const calls = serve(newer);
    expect(await refreshCatalog(1000, { cachePath })).toMatchObject({
      kind: "refreshed",
      catalogGenerationId: newer.catalogGenerationId,
      modelCount: newer.entries.length,
    });
    expectPinnedRequests(calls, newer);
    expect(readAllModelsCache(cachePath)).toEqual(newer);
    expect(JSON.parse(bytes(routeRegistryPathFor(cachePath)))).toEqual(newer.routeRegistry);
    expect(getCatalogEntries()).toEqual(newer.entries);
  });

  test("writes a complete generation when no models file exists", async () => {
    expect(readAllModelsCache(cachePath)).toBeNull();
    const calls = serve(older);
    expect(await refreshCatalog(1000, { cachePath })).toEqual({
      kind: "refreshed",
      catalogGenerationId: older.catalogGenerationId,
      modelCount: older.entries.length,
      pages: 2,
    });
    expectPinnedRequests(calls, older);
    expect(JSON.parse(bytes(cachePath))).toEqual(older);
    expect(JSON.parse(bytes(routeRegistryPathFor(cachePath)))).toEqual(older.routeRegistry);
    expect(readAllModelsCache(cachePath)).toEqual(older);
    expect(getCatalogEntries()).toEqual(older.entries);
  });
});
