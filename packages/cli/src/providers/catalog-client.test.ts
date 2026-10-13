import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DiskCacheV3,
  type SlimModelEntry,
  _clearAllModelsCacheMemo,
  readAllModelsCache,
  writeAllModelsCache,
} from "./all-models-cache.js";
import {
  _resetCatalogClient,
  buildRoutesUrl,
  catalogWarmDisabledFor,
  getCatalogEntries,
  refreshCatalog,
  resolveTargetForCatalog,
} from "./catalog-client.js";
import { CATALOG_V3_ACCEPT } from "./catalog-v3.js";
import { parseModelSpec } from "./model-parser.js";

const realFetch = globalThis.fetch;
const originalEnv = {
  warm: process.env.CLAUDISH_DISABLE_CATALOG_WARM,
  catalog: process.env.CLAUDISH_CATALOG_URL,
  plans: process.env.CLAUDISH_PLANS_URL,
};
const dirs: string[] = [];
function tempCachePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "claudish-catalog-v3-"));
  dirs.push(dir);
  return join(dir, "all-models.json");
}
function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
beforeEach(() => {
  _resetCatalogClient();
  _clearAllModelsCacheMemo();
  delete process.env.CLAUDISH_DISABLE_CATALOG_WARM;
  process.env.CLAUDISH_CATALOG_URL = "https://catalog.test/queryModels?catalog=slim";
  process.env.CLAUDISH_PLANS_URL = "https://catalog.test/queryPlans";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  restore("CLAUDISH_DISABLE_CATALOG_WARM", originalEnv.warm);
  restore("CLAUDISH_CATALOG_URL", originalEnv.catalog);
  restore("CLAUDISH_PLANS_URL", originalEnv.plans);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  _resetCatalogClient();
});

function envelope(data: unknown, generationId = "generation-a"): Response {
  return Response.json({
    contractVersion: 3,
    generationId,
    generatedAt: "2026-09-19T01:33:46.169Z",
    data,
  });
}
const wireFixture: DiskCacheV3 = JSON.parse(
  readFileSync(
    new URL("../test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json", import.meta.url),
    "utf8"
  )
);

function legacyRoutes(): Response {
  // These existing pagination tests predate wires. Keep their rows and assertions
  // meaningful with a 3.6.0 registry; the wire tests below use production 3.7.0.
  return envelope({
    mode: "routes",
    registry: {
      ...structuredClone(wireFixture.routeRegistry!.registry),
      registryVersion: "3.6.0",
    },
  });
}
function entry(modelId: string, provider: string, externalModelId: string): SlimModelEntry {
  const routes: Record<string, { routeId: string; routeProfileId: string }> = {
    "qwen-coding": { routeId: "qwen", routeProfileId: "modelstudio-coding-plan" },
    "qwen-token-plan": { routeId: "qwen", routeProfileId: "qwencloud-token-plan" },
    "qwen-payg": { routeId: "qwen", routeProfileId: "dashscope-direct" },
  };
  return {
    modelId,
    aliases: [],
    aggregators: [
      {
        sourceProviderId: "qwen",
        sourceCollectorId: "test",
        confidence: "api_official",
        routeStatus: "mapped",
        route: routes[provider],
        externalModelId,
      },
    ],
  };
}

describe("v3 catalog refresh", () => {
  test("the warm switch prevents network and disk writes", async () => {
    process.env.CLAUDISH_DISABLE_CATALOG_WARM = "1";
    const fetchStub = mock(async () => envelope({ mode: "slim", models: [] }));
    globalThis.fetch = fetchStub as unknown as typeof fetch;
    expect(await refreshCatalog(100, { cachePath: tempCachePath() })).toEqual({
      kind: "fetch_failed",
      reason: "disabled",
    });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(catalogWarmDisabledFor("true")).toBe(false);
  });

  test("pins opaque model and plan cursors and commits exact routes together", async () => {
    const cachePath = tempCachePath();
    const requests: Array<{
      pathname: string;
      cursor: string | null;
      generation: string | null;
      accept: string | null;
    }> = [];
    const first = entry("qwen3.7-plus", "qwen-coding", "qwen3.7-plus");
    const second = entry("qwen3.8-max", "qwen-token-plan", "qwen3.8-max");
    const plan = {
      id: "alibaba-ai-coding-plan",
      routeStatus: "supported" as const,
      route: { routeId: "qwen", routeProfileId: "modelstudio-coding-plan" },
      modelDiscovery: "catalog" as const,
    };
    const stub = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const request = new URL(String(url));
      requests.push({
        pathname: request.pathname,
        cursor: request.searchParams.get("cursor"),
        generation: request.searchParams.get("generationId"),
        accept: new Headers(init?.headers).get("accept"),
      });
      if (request.searchParams.get("catalog") === "routes") return legacyRoutes();
      if (request.pathname === "/queryModels")
        return envelope({
          mode: "slim",
          models: request.searchParams.has("cursor") ? [second] : [first],
          total: 2,
          ...(request.searchParams.has("cursor") ? {} : { nextCursor: "opaque-model" }),
        });
      return envelope({ plans: [plan], total: 1 });
    });
    globalThis.fetch = stub as unknown as typeof fetch;
    expect(await refreshCatalog(1000, { cachePath })).toEqual({
      kind: "refreshed",
      modelCount: 2,
      catalogGenerationId: "generation-a",
      pages: 2,
    });
    expect(requests).toEqual([
      { pathname: "/queryModels", cursor: null, generation: null, accept: CATALOG_V3_ACCEPT },
      {
        pathname: "/queryModels",
        cursor: "opaque-model",
        generation: "generation-a",
        accept: CATALOG_V3_ACCEPT,
      },
      {
        pathname: "/queryPlans",
        cursor: null,
        generation: "generation-a",
        accept: CATALOG_V3_ACCEPT,
      },
      {
        pathname: "/queryModels",
        cursor: null,
        generation: "generation-a",
        accept: CATALOG_V3_ACCEPT,
      },
    ]);
    expect(readAllModelsCache(cachePath)?.entries).toEqual([first, second]);
    expect(readAllModelsCache(cachePath)?.plans).toEqual([plan]);
    expect(getCatalogEntries()).toEqual([first, second]);
  });

  test("a different plan generation does not replace the complete cache", async () => {
    const cachePath = tempCachePath();
    let planGeneration = "generation-a";
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const request = new URL(String(url));
      if (request.searchParams.get("catalog") === "routes") return legacyRoutes();
      const path = request.pathname;
      return path === "/queryPlans"
        ? envelope(
            {
              plans: [
                {
                  id: "plan",
                  routeStatus: "supported",
                  route: { routeId: "qwen", routeProfileId: "modelstudio-coding-plan" },
                },
              ],
              total: 1,
            },
            planGeneration
          )
        : envelope({
            mode: "slim",
            models: [entry("qwen3.7-plus", "qwen-coding", "qwen3.7-plus")],
            total: 1,
          });
    }) as unknown as typeof fetch;
    expect((await refreshCatalog(1000, { cachePath })).kind).toBe("refreshed");
    const bytes = readFileSync(cachePath, "utf-8");
    planGeneration = "generation-b";
    expect(await refreshCatalog(1000, { cachePath })).toEqual({
      kind: "fetch_failed",
      reason: "generation_mismatch",
    });
    expect(readFileSync(cachePath, "utf-8")).toBe(bytes);
  });

  test("rejects a truncated model snapshot without replacing the cache", async () => {
    const cachePath = tempCachePath();
    let total = 1;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const request = new URL(String(url));
      if (request.searchParams.get("catalog") === "routes") return legacyRoutes();
      const path = request.pathname;
      return path === "/queryPlans"
        ? envelope({
            plans: [
              {
                id: "plan",
                routeStatus: "supported",
                route: { routeId: "qwen", routeProfileId: "modelstudio-coding-plan" },
              },
            ],
            total: 1,
          })
        : envelope({
            mode: "slim",
            models: [entry("qwen3.7-plus", "qwen-coding", "qwen3.7-plus")],
            total,
          });
    }) as unknown as typeof fetch;
    expect((await refreshCatalog(1000, { cachePath })).kind).toBe("refreshed");
    const complete = readFileSync(cachePath, "utf-8");
    total = 2;
    expect(await refreshCatalog(1000, { cachePath })).toEqual({
      kind: "fetch_failed",
      reason: "incomplete",
    });
    expect(readFileSync(cachePath, "utf-8")).toBe(complete);
  });

  test("classifies a bodyless upgrade response as an incompatible contract", async () => {
    globalThis.fetch = mock(
      async () => new Response(null, { status: 426 })
    ) as unknown as typeof fetch;
    expect(await refreshCatalog(1000, { cachePath: tempCachePath() })).toEqual({
      kind: "incompatible",
      serverContractVersion: null,
    });
  });

  test("rejects a response outside contract v3", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ contractVersion: 2, models: [] })
    ) as unknown as typeof fetch;
    expect(await refreshCatalog(1000, { cachePath: tempCachePath() })).toEqual({
      kind: "incompatible",
      serverContractVersion: 2,
    });
  });
});

describe("resolveTargetForCatalog", () => {
  test("rewrites a changed explicit MiniMax spec and returns its resolution", () => {
    const resolution = {
      resolvedId: "MiniMax-M2.5",
      wasResolved: true,
      sourceLabel: "minimax catalog",
    };

    const result = resolveTargetForCatalog(
      "mm@minimax-m2.5",
      true,
      "minimax-m2.5",
      "minimax",
      () => resolution
    );

    expect(result).toEqual({
      target: "minimax@MiniMax-M2.5",
      resolution,
    });
    expect(parseModelSpec(result.target).isExplicitProvider).toBe(true);
  });

  test("preserves a bare MiniMax name and never resolves it", () => {
    let resolveCalls = 0;
    const result = resolveTargetForCatalog("minimax-m2.5", false, "minimax-m2.5", "minimax", () => {
      resolveCalls += 1;
      return {
        resolvedId: "MiniMax-M2.5",
        wasResolved: true,
        sourceLabel: "minimax catalog",
      };
    });

    // Rewriting this bare name would yield `minimax@MiniMax-M2.5`, which
    // parseModelSpec reads as an explicit provider and makes proxy-server skip
    // the routing chain. MiniMax is the only measured family whose wire id
    // differs from the typed name, so unaffected passthrough models cannot catch
    // this regression.
    expect(result).toEqual({ target: "minimax-m2.5", resolution: null });
    expect(parseModelSpec(result.target).isExplicitProvider).toBe(false);
    expect(resolveCalls).toBe(0);
  });

  test("keeps an unchanged explicit target but returns its resolution", () => {
    const resolution = {
      resolvedId: "glm-5.2",
      wasResolved: false,
      sourceLabel: "passthrough",
    };

    const result = resolveTargetForCatalog("glm@glm-5.2", true, "glm-5.2", "glm", () => resolution);

    expect(result).toEqual({ target: "glm@glm-5.2", resolution });
  });

  for (const [model, provider] of [
    ["glm-5.2", "glm"],
    ["kimi-k2.7", "kimi"],
  ] as const) {
    test(`leaves unaffected ${model} explicit and bare forms unchanged`, () => {
      const passthrough = () => ({
        resolvedId: model,
        wasResolved: false,
        sourceLabel: "passthrough",
      });
      const explicitTarget = `${provider}@${model}`;

      const explicit = resolveTargetForCatalog(explicitTarget, true, model, provider, passthrough);
      const bare = resolveTargetForCatalog(model, false, model, provider, passthrough);

      expect(explicit.target).toBe(explicitTarget);
      expect(explicit.resolution).not.toBeNull();
      expect(bare).toEqual({ target: model, resolution: null });
    });
  }
});

describe("route registry refresh", () => {
  function serveFixture(
    options: {
      cache?: DiskCacheV3;
      routesGeneration?: (attempt: number) => string;
      registry?: unknown;
    } = {}
  ) {
    const cache = options.cache ?? wireFixture;
    const requests: Array<{ url: URL; accept: string | null }> = [];
    let attempts = 0;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ url, accept: new Headers(init?.headers).get("accept") });
      if (url.searchParams.get("catalog") === "routes") {
        return envelope(
          {
            mode: "routes",
            registry:
              options.registry === undefined ? cache.routeRegistry!.registry : options.registry,
          },
          options.routesGeneration?.(attempts) ?? cache.catalogGenerationId
        );
      }
      if (url.pathname === "/queryPlans") {
        return envelope(
          { plans: cache.plans, total: cache.plans.length },
          cache.catalogGenerationId
        );
      }
      // Two model pages make a full retry observable, including cursor reset.
      if (!url.searchParams.has("cursor")) attempts++;
      const second = url.searchParams.has("cursor");
      return envelope(
        {
          mode: "slim",
          models: second ? cache.entries.slice(8) : cache.entries.slice(0, 8),
          total: cache.entries.length,
          ...(second ? {} : { nextCursor: "fixture-page-two" }),
        },
        cache.catalogGenerationId
      );
    }) as unknown as typeof fetch;
    return requests;
  }

  function expectAttempt(requests: Array<{ url: URL; accept: string | null }>) {
    expect(
      requests.map(({ url, accept }) => ({
        path: url.pathname,
        mode: url.searchParams.get("catalog"),
        cursor: url.searchParams.get("cursor"),
        generation: url.searchParams.get("generationId"),
        accept,
      }))
    ).toEqual([
      {
        path: "/queryModels",
        mode: "slim",
        cursor: null,
        generation: null,
        accept: CATALOG_V3_ACCEPT,
      },
      {
        path: "/queryModels",
        mode: "slim",
        cursor: "fixture-page-two",
        generation: wireFixture.catalogGenerationId,
        accept: CATALOG_V3_ACCEPT,
      },
      {
        path: "/queryPlans",
        mode: null,
        cursor: null,
        generation: wireFixture.catalogGenerationId,
        accept: CATALOG_V3_ACCEPT,
      },
      {
        path: "/queryModels",
        mode: "routes",
        cursor: null,
        generation: wireFixture.catalogGenerationId,
        accept: CATALOG_V3_ACCEPT,
      },
    ]);
  }

  test("pins the routes URL to the model generation and writes its registry", async () => {
    const cachePath = tempCachePath();
    const requests = serveFixture();
    expect(await refreshCatalog(1000, { cachePath })).toEqual({
      kind: "refreshed",
      modelCount: 16,
      catalogGenerationId: wireFixture.catalogGenerationId,
      pages: 2,
    });
    expectAttempt(requests);
    const cache = readAllModelsCache(cachePath)!;
    expect(cache.entries).toEqual(wireFixture.entries);
    expect(cache.routeRegistry).toEqual(wireFixture.routeRegistry);
    expect(cache.routeRegistry!.generationId).toBe(cache.catalogGenerationId);
  });

  test.each([
    ["persistent mismatch", false],
    ["matching retry", true],
  ] as const)("retries the full refresh exactly once: %s", async (_name, recovers) => {
    const cachePath = tempCachePath();
    writeAllModelsCache(wireFixture, cachePath);
    const bytes = readFileSync(cachePath, "utf8");
    const requests = serveFixture({
      routesGeneration: (attempt) =>
        recovers && attempt === 2 ? wireFixture.catalogGenerationId : "different-generation",
    });
    expect(await refreshCatalog(1000, { cachePath })).toEqual(
      recovers
        ? {
            kind: "refreshed",
            modelCount: 16,
            catalogGenerationId: wireFixture.catalogGenerationId,
            pages: 2,
          }
        : { kind: "fetch_failed", reason: "generation_mismatch" }
    );
    expect(requests).toHaveLength(8);
    expectAttempt(requests.slice(0, 4));
    expectAttempt(requests.slice(4));
    if (recovers) {
      expect(readAllModelsCache(cachePath)!.routeRegistry).toEqual(wireFixture.routeRegistry);
    } else {
      expect(readFileSync(cachePath, "utf8")).toBe(bytes);
    }
  });

  test("malformed registry fails empty without replacing the existing file", async () => {
    const cachePath = tempCachePath();
    writeAllModelsCache(wireFixture, cachePath);
    const bytes = readFileSync(cachePath, "utf8");
    const registry = structuredClone(wireFixture.routeRegistry!.registry);
    Reflect.deleteProperty(registry, "routes");
    const requests = serveFixture({ registry });
    expect(await refreshCatalog(1000, { cachePath })).toEqual({
      kind: "fetch_failed",
      reason: "empty",
    });
    expect(requests).toHaveLength(4);
    expect(readFileSync(cachePath, "utf8")).toBe(bytes);
  });

  test("wires missing from a 3.7.0 connection fail incomplete without replacing the file", async () => {
    const cachePath = tempCachePath();
    writeAllModelsCache(wireFixture, cachePath);
    const bytes = readFileSync(cachePath, "utf8");
    const cache = structuredClone(wireFixture);
    const connection = cache.entries
      .flatMap((entry) => entry.aggregators ?? [])
      .find((connection) => connection.routeStatus === "mapped")!;
    delete connection.wire;
    const requests = serveFixture({ cache });
    expect(await refreshCatalog(1000, { cachePath })).toEqual({
      kind: "fetch_failed",
      reason: "incomplete",
    });
    expect(requests).toHaveLength(4);
    expect(readFileSync(cachePath, "utf8")).toBe(bytes);
  });

  test("buildRoutesUrl discards slim filters, pagination and stale generation", () => {
    const url = new URL(
      buildRoutesUrl(
        "https://catalog.test/queryModels?catalog=slim&cursor=old&limit=5&provider=openai&generationId=stale",
        "generation/with spaces+opaque"
      )
    );
    expect(url.origin + url.pathname).toBe("https://catalog.test/queryModels");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      catalog: "routes",
      generationId: "generation/with spaces+opaque",
    });
  });
});

test.each(["routes-only", "routes-fail", "disabled"])(
  "registry readiness in isolated HOME: %s",
  (scenario) => {
    const home = mkdtempSync(join(tmpdir(), "registry-ready-"));
    dirs.push(home);
    const source = (name: string) => JSON.stringify(new URL(name, import.meta.url).pathname);
    const child = Bun.spawnSync(
      [
        process.execPath,
        "--eval",
        `
    import assert from "node:assert/strict";
    import { readFileSync, existsSync } from "node:fs";
    import { ALL_MODELS_CACHE_PATH, writeAllModelsCache, readAllModelsCache, routeRegistryPathFor } from ${source("./all-models-cache.ts")};
    import { ensureRouteRegistryReady } from ${source("./catalog-client.ts")};
    const fixture = JSON.parse(readFileSync(${source("../test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json")}, "utf8"));
    const registry = fixture.routeRegistry;
    delete fixture.routeRegistry;
    assert.ok(ALL_MODELS_CACHE_PATH.startsWith(process.env.HOME + "/"));
    writeAllModelsCache(fixture);
    const calls = [];
    const original = globalThis.fetch;
    const envelope = data => Response.json({contractVersion: 3, generationId: fixture.catalogGenerationId, generatedAt: fixture.lastUpdated, data});
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      assert.equal(url.hostname, "catalog.test");
      calls.push(url);
      if (url.searchParams.get("catalog") === "routes") {
        if (process.env.SCENARIO === "routes-fail" && calls.length === 1) return new Response("unavailable", {status: 503});
        return envelope({mode: "routes", registry: registry.registry});
      }
      if (url.pathname === "/queryPlans") return envelope({plans: fixture.plans, total: fixture.plans.length});
      const second = url.searchParams.has("cursor");
      return envelope({mode: "slim", models: second ? fixture.entries.slice(8) : fixture.entries.slice(0,8), total: fixture.entries.length, ...(second ? {} : {nextCursor: "next"})});
    };
    try {
      await ensureRouteRegistryReady(2000);
      if (process.env.SCENARIO === "disabled") {
        assert.equal(calls.length, 0);
        assert.equal(existsSync(routeRegistryPathFor(ALL_MODELS_CACHE_PATH)), false);
      } else {
        assert.equal(calls[0].pathname, "/queryModels");
        assert.deepEqual(Object.fromEntries(calls[0].searchParams), {catalog: "routes", generationId: fixture.catalogGenerationId});
        if (process.env.SCENARIO === "routes-only") assert.equal(calls.length, 1);
        else assert.deepEqual(calls.filter(u => u.searchParams.get("catalog") === "slim").map(u => u.searchParams.get("cursor")), [null, "next"]);
        assert.deepEqual(readAllModelsCache().routeRegistry, registry);
        assert.deepEqual(JSON.parse(readFileSync(routeRegistryPathFor(ALL_MODELS_CACHE_PATH), "utf8")), registry);
      }
    } finally { globalThis.fetch = original; }
  `,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          SCENARIO: scenario,
          CLAUDISH_DISABLE_KEYCHAIN: "1",
          CLAUDISH_DISABLE_OP: "1",
          CLAUDISH_DISABLE_CATALOG_WARM: scenario === "disabled" ? "1" : "0",
          CLAUDISH_CATALOG_URL: "https://catalog.test/queryModels?catalog=slim",
          CLAUDISH_PLANS_URL: "https://catalog.test/queryPlans",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    expect(child.exitCode, child.stderr.toString()).toBe(0);
  }
);
