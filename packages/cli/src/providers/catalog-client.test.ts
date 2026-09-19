import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SlimModelEntry, readAllModelsCache } from "./all-models-cache.js";
import {
  _resetCatalogClient,
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
    ]);
    expect(readAllModelsCache(cachePath)?.entries).toEqual([first, second]);
    expect(readAllModelsCache(cachePath)?.plans).toEqual([plan]);
    expect(getCatalogEntries()).toEqual([first, second]);
  });

  test("a different plan generation does not replace the complete cache", async () => {
    const cachePath = tempCachePath();
    let planGeneration = "generation-a";
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
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
      const path = new URL(String(url)).pathname;
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
