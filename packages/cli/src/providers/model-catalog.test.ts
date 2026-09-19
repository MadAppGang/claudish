import { catalogRouteForProvider } from "./catalog-route-bindings.js";
/**
 * Tests for `providers/model-catalog.ts` — the `CatalogClient` interface.
 *
 * Tests use dependency injection (the optional `deps` argument to
 * `createCatalogClient`) to substitute fake `model-loader.ts` functions and
 * a fake slim-cache reader. This matches the codebase convention (see
 * openrouter.test.ts) since the project doesn't use `mock.module()`.
 *
 * Run: bun test packages/cli/src/providers/model-catalog.test.ts
 */

import { describe, expect, mock, test } from "bun:test";
import type { AggregatorEntry, ModelDoc } from "../model-loader.js";
import type { DiskCacheV3, SlimModelEntry } from "./all-models-cache.js";
import { FIREBASE_CACHE_TTL_MS } from "./cache-ttl.js";
import { createCatalogClient } from "./model-catalog.js";

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function aggregator(provider: string, externalId: string): AggregatorEntry {
  return {
    sourceProviderId: provider,
    sourceCollectorId: "test",
    routeStatus: "mapped",
    route: catalogRouteForProvider(provider.toLowerCase()),
    externalModelId: externalId,
    confidence: "gateway_official",
  };
}

function slimEntry(
  modelId: string,
  aggregators: AggregatorEntry[],
  aliases: string[] = []
): SlimModelEntry {
  return {
    modelId,
    aliases,

    aggregators,
  };
}

function modelDoc(modelId: string, provider: string, extra: Partial<ModelDoc> = {}): ModelDoc {
  return {
    modelId,
    provider,
    displayName: modelId,
    ...extra,
  };
}

function freshCache(entries: SlimModelEntry[]): DiskCacheV3 {
  return {
    catalogGenerationId: "test-generation",
    plans: [],
    version: 3,
    lastUpdated: new Date().toISOString(),
    entries,
    models: [],
  };
}

function staleCache(entries: SlimModelEntry[]): DiskCacheV3 {
  return {
    catalogGenerationId: "test-generation",
    plans: [],
    version: 3,
    // Twice the TTL — definitely expired.
    lastUpdated: new Date(Date.now() - 2 * FIREBASE_CACHE_TTL_MS).toISOString(),
    entries,
    models: [],
  };
}

// ─── modelsByVendor ──────────────────────────────────────────────────────────

describe("modelsByVendor", () => {
  test("owner path excludes lineage models the provider does not serve directly", async () => {
    // gpt-latest is OpenAI-owned by lineage but the served-by index lists only
    // openrouter → it must NOT appear under the openai (oai@) list. gpt-5 IS
    // served by openai → kept. Backend emits the owner's canonical slug in the
    // served-by index, so this is a plain exact-match (no slug translation).
    const fakeProviderQuery = mock(async (_slug: string) => [
      modelDoc("gpt-5", "openai"),
      modelDoc("gpt-latest", "openai"),
    ]);
    const entries = [
      slimEntry("gpt-5", [aggregator("openai", "gpt-5"), aggregator("openrouter", "openai/gpt-5")]),
      slimEntry("gpt-latest", [aggregator("openrouter", "~openai/gpt-latest")]),
    ];
    const client = createCatalogClient({
      getModelsByProvider: fakeProviderQuery,
      readSlimCache: () => freshCache(entries),
    });

    const result = await client.modelsByVendor("openai");
    expect(result.map((m) => m.modelId).sort()).toEqual(["gpt-5"]);
    // The kept model carries the grafted served-by aggregators (owner query
    // returns aggregators: null).
    expect(
      result[0]?.aggregators?.some(
        (a) => a.route?.routeId === "openai" && a.route?.routeProfileId === "direct-api"
      )
    ).toBe(true);
  });

  test("owner path keeps a direct-API owner's models once the catalog indexes them", async () => {
    // After the backend fix, minimax models carry a "minimax" served-by entry,
    // so the picker keeps them (this used to blank because the catalog had no
    // minimax entry at all).
    const fakeProviderQuery = mock(async (_slug: string) => [
      modelDoc("minimax-m3", "minimax"),
      modelDoc("minimax-m2", "minimax"),
    ]);
    const entries = [
      slimEntry("minimax-m3", [
        aggregator("minimax", "MiniMax-M3"),
        aggregator("openrouter", "minimax/minimax-m3"),
      ]),
      slimEntry("minimax-m2", [aggregator("minimax", "MiniMax-M2")]),
    ];
    const client = createCatalogClient({
      getModelsByProvider: fakeProviderQuery,
      readSlimCache: () => freshCache(entries),
    });

    const result = await client.modelsByVendor("minimax");
    expect(result.map((m) => m.modelId).sort()).toEqual(["minimax-m2", "minimax-m3"]);
  });

  test("owner path returns full list on cold-start (empty cache) to avoid blanking", async () => {
    const fakeProviderQuery = mock(async (_slug: string) => [
      modelDoc("gpt-5", "openai"),
      modelDoc("gpt-latest", "openai"),
    ]);
    const client = createCatalogClient({
      getModelsByProvider: fakeProviderQuery,
      readSlimCache: () => null, // cold start
    });

    const result = await client.modelsByVendor("openai");
    // No filtering when the cache is unavailable — both models returned.
    expect(result.map((m) => m.modelId).sort()).toEqual(["gpt-5", "gpt-latest"]);
  });

  test("aggregator 'opencode-zen' filters slim cache by aggregators[].provider", async () => {
    const entries = [
      slimEntry("claude-opus-4-7", [
        aggregator("anthropic", "claude-opus-4-7"),
        aggregator("opencode-zen", "anthropic/claude-opus-4-7"),
      ]),
      slimEntry("gpt-5", [
        aggregator("openai", "gpt-5"),
        aggregator("opencode-zen", "openai/gpt-5"),
      ]),
      // No opencode-zen → must be filtered out.
      slimEntry("grok-4", [aggregator("x-ai", "grok-4")]),
    ];

    const fakeProviderQuery = mock(async () => []);
    const client = createCatalogClient({
      getModelsByProvider: fakeProviderQuery,
      readSlimCache: () => freshCache(entries),
    });

    const result = await client.modelsByVendor("opencode-zen");

    expect(result.map((m) => m.modelId).sort()).toEqual(["claude-opus-4-7", "gpt-5"].sort());
    // Aggregator path must not hit the rich provider query.
    expect(fakeProviderQuery).not.toHaveBeenCalled();
  });

  test("aggregator returns [] when slim cache is empty", async () => {
    const client = createCatalogClient({
      getModelsByProvider: mock(async () => []),
      readSlimCache: () => null,
    });

    const result = await client.modelsByVendor("opencode-zen");
    expect(result).toEqual([]);
  });

  test("aggregator slug match is case-insensitive", async () => {
    const entries = [slimEntry("claude-opus-4-7", [aggregator("OpenCode-Zen", "x")])];
    const client = createCatalogClient({
      getModelsByProvider: mock(async () => []),
      readSlimCache: () => freshCache(entries),
    });

    const result = await client.modelsByVendor("opencode-zen");
    expect(result).toHaveLength(1);
  });

  test.each([["litellm"], ["ollama"], ["lmstudio"], ["lm-studio"]])(
    "'%s' returns [] without any I/O",
    async (slug) => {
      const fakeProviderQuery = mock(async () => []);
      const fakeReadSlim = mock(() => null);

      const client = createCatalogClient({
        getModelsByProvider: fakeProviderQuery,
        readSlimCache: fakeReadSlim,
      });

      const result = await client.modelsByVendor(slug);

      expect(result).toEqual([]);
      expect(fakeProviderQuery).not.toHaveBeenCalled();
      expect(fakeReadSlim).not.toHaveBeenCalled();
    }
  );

  test("unknown slug falls through to rich provider query", async () => {
    const fakeProviderQuery = mock(async (slug: string) => {
      expect(slug).toBe("brand-new-vendor");
      return [];
    });

    const client = createCatalogClient({
      getModelsByProvider: fakeProviderQuery,
      readSlimCache: () => null,
    });

    const result = await client.modelsByVendor("brand-new-vendor");
    expect(result).toEqual([]);
    expect(fakeProviderQuery).toHaveBeenCalledTimes(1);
  });
});

// ─── vendorsForModel ─────────────────────────────────────────────────────────

describe("vendorsForModel", () => {
  test("returns aggregators[] from slim cache when model is present", async () => {
    const aggs = [
      aggregator("anthropic", "claude-opus-4-7"),
      aggregator("openrouter", "anthropic/claude-opus-4-7"),
    ];
    const entries = [slimEntry("claude-opus-4-7", aggs)];

    const fakeFirebaseLookup = mock(async () => null);
    const client = createCatalogClient({
      getModelByIdFromFirebase: fakeFirebaseLookup,
      readSlimCache: () => freshCache(entries),
    });

    const result = await client.vendorsForModel("claude-opus-4-7");
    expect(result).toEqual(aggs);
    // Cache hit should not trigger the live Firebase fallback.
    expect(fakeFirebaseLookup).not.toHaveBeenCalled();
  });

  test("alias hit returns the underlying entry's aggregators", async () => {
    const aggs = [aggregator("openrouter", "moonshotai/kimi-k2.5")];
    const entries = [slimEntry("kimi-k2.5", aggs, ["kimi-k2-5"])];

    const client = createCatalogClient({
      getModelByIdFromFirebase: mock(async () => null),
      readSlimCache: () => freshCache(entries),
    });

    const result = await client.vendorsForModel("kimi-k2-5");
    expect(result).toEqual(aggs);
  });

  test("returns null for unknown model when cache is fresh", async () => {
    const fakeFirebaseLookup = mock(async () => null);
    const client = createCatalogClient({
      getModelByIdFromFirebase: fakeFirebaseLookup,
      readSlimCache: () => freshCache([slimEntry("gpt-5", [])]),
    });

    const result = await client.vendorsForModel("nonexistent-model-xyz");
    expect(result).toBeNull();
    // Fresh cache + miss → don't bother Firebase.
    expect(fakeFirebaseLookup).not.toHaveBeenCalled();
  });

  test("stale cache + cache miss falls back to Firebase lookup", async () => {
    const fbAggs = [aggregator("openrouter", "vendor/late-arrival")];
    const fakeFirebaseLookup = mock(async (modelId: string) => {
      expect(modelId).toBe("late-arrival");
      return modelDoc("late-arrival", "vendor", { aggregators: fbAggs });
    });

    const client = createCatalogClient({
      getModelByIdFromFirebase: fakeFirebaseLookup,
      readSlimCache: () => staleCache([]),
    });

    const result = await client.vendorsForModel("late-arrival");
    expect(result).toEqual(fbAggs);
    expect(fakeFirebaseLookup).toHaveBeenCalledTimes(1);
  });

  test("stale cache hit short-circuits Firebase lookup", async () => {
    // Even when stale, an in-cache match is preferable to a network call —
    // the cache is good enough for routing decisions until a refresh runs.
    const aggs = [aggregator("anthropic", "claude-opus-4-7")];
    const fakeFirebaseLookup = mock(async () => null);
    const client = createCatalogClient({
      getModelByIdFromFirebase: fakeFirebaseLookup,
      readSlimCache: () => staleCache([slimEntry("claude-opus-4-7", aggs)]),
    });

    const result = await client.vendorsForModel("claude-opus-4-7");
    expect(result).toEqual(aggs);
    expect(fakeFirebaseLookup).not.toHaveBeenCalled();
  });

  test("missing cache + Firebase miss returns null", async () => {
    const client = createCatalogClient({
      getModelByIdFromFirebase: mock(async () => null),
      readSlimCache: () => null,
    });

    const result = await client.vendorsForModel("ghost");
    expect(result).toBeNull();
  });
});

// ─── searchModels ────────────────────────────────────────────────────────────

describe("searchModels", () => {
  test("delegates to Firebase searchModels with the given term", async () => {
    const fakeSearch = mock(async (_term: string, _limit?: number) => [
      modelDoc("claude-opus-4-7", "anthropic"),
      modelDoc("claude-sonnet-4-5", "anthropic"),
    ]);
    const client = createCatalogClient({ searchModels: fakeSearch });

    const result = await client.searchModels("claude");

    expect(fakeSearch).toHaveBeenCalledTimes(1);
    expect(fakeSearch.mock.calls[0]?.[0]).toBe("claude");
    expect(result).toHaveLength(2);
    expect(result[0]?.modelId).toBe("claude-opus-4-7");
  });
});
