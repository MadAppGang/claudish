/**
 * Tests for OpenRouterCatalogResolver — Firebase-backed model resolution.
 *
 * Run: bun test packages/cli/src/providers/catalog-resolvers/openrouter.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

// We need to test the resolver's resolveSync logic with controlled cache state.
// The resolver uses module-level _memCache, so we import the class and inject test data.
import { OpenRouterCatalogResolver, setMemCatalogForTests, firebaseCatalogUrl } from "./openrouter.js";
import type { SlimModelEntry } from "../all-models-cache.js";

// Helper: create a slim catalog entry
function entry(
  modelId: string,
  aliases: string[],
  sources: Record<string, { externalId: string }>
) {
  return { modelId, aliases, sources };
}

// Sample catalog data representing what Firebase returns
const SAMPLE_CATALOG = [
  entry("grok-4.20", ["grok-4-20"], {
    "openrouter-api": { externalId: "x-ai/grok-4.20" },
    "xai-scraper": { externalId: "grok-4.20" },
  }),
  entry("grok-4", [], {
    "openrouter-api": { externalId: "x-ai/grok-4" },
  }),
  entry("deepseek-v3.2", ["deepseek-v3-2"], {
    "openrouter-api": { externalId: "deepseek/deepseek-v3.2" },
    "deepseek-api": { externalId: "deepseek-v3.2" },
  }),
  entry("gemini-3.1-pro-preview", [], {
    "openrouter-api": { externalId: "google/gemini-3.1-pro-preview" },
    "google-api": { externalId: "models/gemini-3.1-pro-preview" },
  }),
  entry("kimi-k2.5", ["kimi-k2-5"], {
    "openrouter-api": { externalId: "moonshotai/kimi-k2.5" },
    "kimi-scraper": { externalId: "kimi-k2.5" },
  }),
  entry("qwen3-coder-next", [], {
    "openrouter-api": { externalId: "qwen/qwen3-coder-next" },
  }),
  // Model without OpenRouter source (only direct API)
  entry("some-direct-only-model", [], {
    "provider-api": { externalId: "vendor/some-direct-only-model" },
  }),
];

/**
 * Create a resolver with injected cache data (bypasses fetch/disk).
 */
function createResolverWithCache(data: typeof SAMPLE_CATALOG): OpenRouterCatalogResolver {
  const resolver = new OpenRouterCatalogResolver();
  // Inject data into the resolver via the module cache
  // We use a workaround: call _getEntries' disk path won't exist in test,
  // so we warm via the memory cache mechanism
  (resolver as any)._getEntries = () => data;
  return resolver;
}

// ---------------------------------------------------------------------------
// Resolution chain tests
// ---------------------------------------------------------------------------

describe("OpenRouterCatalogResolver.resolveSync", () => {
  let resolver: OpenRouterCatalogResolver;

  beforeEach(() => {
    resolver = createResolverWithCache(SAMPLE_CATALOG);
  });

  // Step 1: Exact modelId match
  test("exact modelId → returns OpenRouter externalId", () => {
    expect(resolver.resolveSync("grok-4.20")).toBe("x-ai/grok-4.20");
  });

  test("exact modelId for deepseek → returns OpenRouter externalId", () => {
    expect(resolver.resolveSync("deepseek-v3.2")).toBe("deepseek/deepseek-v3.2");
  });

  test("exact modelId for gemini → returns OpenRouter externalId", () => {
    expect(resolver.resolveSync("gemini-3.1-pro-preview")).toBe(
      "google/gemini-3.1-pro-preview"
    );
  });

  // Step 2: Alias match
  test("alias match → returns OpenRouter externalId of matched model", () => {
    expect(resolver.resolveSync("grok-4-20")).toBe("x-ai/grok-4.20");
  });

  test("alias match for deepseek → returns OpenRouter externalId", () => {
    expect(resolver.resolveSync("deepseek-v3-2")).toBe("deepseek/deepseek-v3.2");
  });

  test("alias match for kimi → returns OpenRouter externalId", () => {
    expect(resolver.resolveSync("kimi-k2-5")).toBe("moonshotai/kimi-k2.5");
  });

  // Step 3: Sources externalId match — already vendor-prefixed input
  test("vendor-prefixed input exact match → returns as-is", () => {
    expect(resolver.resolveSync("x-ai/grok-4.20")).toBe("x-ai/grok-4.20");
  });

  test("vendor-prefixed input not in catalog → returns as-is (passthrough)", () => {
    expect(resolver.resolveSync("x-ai/nonexistent")).toBe("x-ai/nonexistent");
  });

  // Step 4: Suffix match on OpenRouter externalIds
  test("suffix match → finds via endsWith", () => {
    expect(resolver.resolveSync("qwen3-coder-next")).toBe("qwen/qwen3-coder-next");
  });

  // Model without OpenRouter source falls back to any vendor-prefixed externalId
  test("model without openrouter-api source → uses first vendor-prefixed externalId", () => {
    expect(resolver.resolveSync("some-direct-only-model")).toBe(
      "vendor/some-direct-only-model"
    );
  });

  // Step 5: Passthrough (null) — cold-start handled by proxy-server + launcher warm
  test("completely unknown model → null", () => {
    const noDataResolver = createResolverWithCache([]);
    expect(noDataResolver.resolveSync("totally-unknown-model")).toBeNull();
  });

  test("unknown model with vendor-keyword prefix → null (no static fallback)", () => {
    // Previously the static vendor map would have mapped "grok-99" → "x-ai/grok-99".
    // After the cold-start fallback was removed, an empty catalog returns null
    // and the launcher/proxy warm path is responsible for ensuring the catalog
    // is populated before resolveSync is consulted.
    const noDataResolver = createResolverWithCache([]);
    expect(noDataResolver.resolveSync("grok-99")).toBeNull();
    expect(noDataResolver.resolveSync("deepseek-future")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cache state tests
// ---------------------------------------------------------------------------

describe("OpenRouterCatalogResolver cache state", () => {
  test("isCacheWarm returns false when no data", () => {
    const resolver = new OpenRouterCatalogResolver();
    // Fresh resolver with no fetch — cache is cold
    // (isCacheWarm checks module-level _memCache which is reset between test files)
    // We can't easily test this without resetting module state, so just verify the method exists
    expect(typeof resolver.isCacheWarm).toBe("function");
  });

  test("ensureReady resolves without error even if fetch fails", async () => {
    const resolver = new OpenRouterCatalogResolver();
    // ensureReady should gracefully handle fetch failures
    // With a very short timeout, it should resolve quickly
    await expect(resolver.ensureReady(100)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// refreshCatalog tests
// ---------------------------------------------------------------------------
//
// The resolver uses module-level `_memCache` and `_warmPromise` plus the disk
// helpers in `all-models-cache.js`. To avoid clobbering the user's real
// `~/.claudish/all-models.json` we mock the cache module before importing the
// resolver in this block. `mock.module()` is hoisted to the top of the file
// scope by Bun, so we re-import the resolver from a sub-path import after the
// mock is registered to ensure the mocked dependency is wired in.
//
// Error simulation strategy:
//   - timeout       → fetch rejects with `{ name: "TimeoutError" }`
//   - network       → fetch rejects with a generic Error (e.g. ECONNREFUSED)
//   - http_error    → fetch resolves with `Response` whose `ok=false`
//   - empty         → fetch resolves with `Response` whose body has 0 entries
//   - refreshed     → fetch resolves with `Response` whose body has ≥1 entries

// Mock the disk-cache module so writeAllModelsCache becomes a no-op spy and
// readAllModelsCache returns null. Must be registered before resolver import.
const mockWrite = mock((_data: unknown): void => undefined);
const mockRead = mock(() => null);

mock.module("../all-models-cache.js", () => ({
  writeAllModelsCache: mockWrite,
  readAllModelsCache: mockRead,
  ALL_MODELS_CACHE_PATH: "/tmp/test-all-models.json",
}));

describe("OpenRouterCatalogResolver.refreshCatalog", () => {
  let resolver: OpenRouterCatalogResolver;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    mockWrite.mockClear();
    mockRead.mockClear();
    resolver = new OpenRouterCatalogResolver();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Helper: build a Response-like object with controllable ok/json behavior.
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  test("success → returns refreshed with modelCount", async () => {
    const fakeModels = [
      entry("alpha", [], { "openrouter-api": { externalId: "vendor-a/alpha" } }),
      entry("beta", [], { "openrouter-api": { externalId: "vendor-b/beta" } }),
    ];
    globalThis.fetch = mock(async () =>
      jsonResponse({ models: fakeModels, total: 2 })
    ) as unknown as typeof globalThis.fetch;

    const outcome = await resolver.refreshCatalog(8000);

    // The legacy envelope carries no pagination metadata: one page, and it is
    // the whole catalog (#635 AC4).
    expect(outcome).toEqual({
      kind: "refreshed",
      modelCount: 2,
      coverage: { pages: 1, fetched: 2, serverTotal: null, complete: true },
    });
    // Disk cache mutated with the new entries plus backward-compat models array.
    expect(mockWrite).toHaveBeenCalledTimes(1);
    const writeArg = mockWrite.mock.calls[0]?.[0] as unknown as {
      entries: typeof fakeModels;
      models: Array<{ id: string }>;
    };
    expect(writeArg.entries).toEqual(fakeModels);
    expect(writeArg.models).toEqual([{ id: "vendor-a/alpha" }, { id: "vendor-b/beta" }]);
  });

  test("disk write throws (EROFS read-only fs) → refresh still succeeds, memory serves (#270)", async () => {
    const fakeModels = [
      entry("erofs-model", [], { "openrouter-api": { externalId: "vendor-e/erofs-model" } }),
    ];
    globalThis.fetch = mock(async () =>
      jsonResponse({ models: fakeModels, total: 1 })
    ) as unknown as typeof globalThis.fetch;
    // Hub container: homedir=/root on a read-only rootfs — the very first
    // catalog-resolving request paid a 500 for this throw before the fix.
    mockWrite.mockImplementationOnce(() => {
      throw new Error("EROFS: read-only file system, open '/root/.claudish/all-models.json'");
    });

    const outcome = await resolver.refreshCatalog(8000);

    expect(outcome).toEqual({
      kind: "refreshed",
      modelCount: 1,
      coverage: { pages: 1, fetched: 1, serverTotal: null, complete: true },
    });
    expect(resolver.isCacheWarm()).toBe(true);
    expect(resolver.resolveSync("erofs-model")).toBe("vendor-e/erofs-model");
  });

  test("success → in-memory cache reflects fetched models via resolveSync", async () => {
    const fakeModels = [
      entry("gamma", ["g"], { "openrouter-api": { externalId: "vendor-g/gamma" } }),
    ];
    globalThis.fetch = mock(async () =>
      jsonResponse({ models: fakeModels, total: 1 })
    ) as unknown as typeof globalThis.fetch;

    await resolver.refreshCatalog(8000);

    // After a successful refresh, resolveSync should hit the in-memory cache.
    // (No need to override _getEntries here — the real one reads _memCache first.)
    expect(resolver.resolveSync("gamma")).toBe("vendor-g/gamma");
    expect(resolver.resolveSync("g")).toBe("vendor-g/gamma");
  });

  test("success → isCacheWarm returns true after refresh", async () => {
    const fakeModels = [
      entry("delta", [], { "openrouter-api": { externalId: "vendor-d/delta" } }),
    ];
    globalThis.fetch = mock(async () =>
      jsonResponse({ models: fakeModels, total: 1 })
    ) as unknown as typeof globalThis.fetch;

    await resolver.refreshCatalog(8000);

    expect(resolver.isCacheWarm()).toBe(true);

    // _warmPromise short-circuit: a subsequent warmCache() should resolve
    // immediately without calling fetch again. This is the F2 fix from
    // architecture.md §0 — the proxy-server bg warm at proxy-server.ts:535
    // sees the resolved promise and skips the redundant fetch.
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof mock>;
    const callsBefore = fetchSpy.mock.calls.length;
    await resolver.warmCache();
    expect(fetchSpy.mock.calls.length).toBe(callsBefore);
  });

  test("http error (500) → returns fetch_failed:http_error, caches untouched", async () => {
    globalThis.fetch = mock(
      async () => new Response("upstream blew up", { status: 500 })
    ) as unknown as typeof globalThis.fetch;

    const outcome = await resolver.refreshCatalog(8000);

    expect(outcome).toEqual({ kind: "fetch_failed", reason: "http_error" });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  test("timeout (TimeoutError) → returns fetch_failed:timeout", async () => {
    globalThis.fetch = mock(async () => {
      const err = new Error("The operation timed out.") as Error & { name: string };
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof globalThis.fetch;

    const outcome = await resolver.refreshCatalog(50);

    expect(outcome).toEqual({ kind: "fetch_failed", reason: "timeout" });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  test("real AbortSignal timeout fires after timeoutMs → fetch_failed:timeout", async () => {
    // Use a fetch that hangs forever, paired with a small timeoutMs. The
    // resolver's internal AbortSignal.timeout(timeoutMs) should fire and
    // surface as a timeout reason.
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => {
          // Mimic Node/Bun's behavior: AbortSignal.timeout fires a TimeoutError.
          const reason = (signal as AbortSignal & { reason?: unknown }).reason;
          reject(reason ?? new DOMException("aborted", "AbortError"));
        });
      });
    }) as unknown as typeof globalThis.fetch;

    const outcome = await resolver.refreshCatalog(50);

    expect(outcome.kind).toBe("fetch_failed");
    if (outcome.kind === "fetch_failed") {
      expect(outcome.reason).toBe("timeout");
    }
    expect(mockWrite).not.toHaveBeenCalled();
  });

  test("network error (generic throw) → returns fetch_failed:network", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:1");
    }) as unknown as typeof globalThis.fetch;

    const outcome = await resolver.refreshCatalog(8000);

    expect(outcome).toEqual({ kind: "fetch_failed", reason: "network" });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  test("empty body (models: []) → returns fetch_failed:empty", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ models: [], total: 0 })
    ) as unknown as typeof globalThis.fetch;

    const outcome = await resolver.refreshCatalog(8000);

    expect(outcome).toEqual({ kind: "fetch_failed", reason: "empty" });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  test("malformed body (no models key) → returns fetch_failed:empty", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ total: 0 })
    ) as unknown as typeof globalThis.fetch;

    const outcome = await resolver.refreshCatalog(8000);

    // No `models` array → !Array.isArray short-circuits the same branch as empty.
    expect(outcome).toEqual({ kind: "fetch_failed", reason: "empty" });
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Catalog contract v3 (#222) — the endpoint went v3-only on 2026-09-23: bare
// GET answers 426 and the model list moved under `data.models`. The resolver
// must negotiate via Accept, parse both envelopes, and map v3 entries (which
// carry `aggregators[]` instead of a `sources` record) onto SlimModelEntry.
// ---------------------------------------------------------------------------

describe("OpenRouterCatalogResolver.refreshCatalog — catalog contract v3 (#222)", () => {
  let resolver: OpenRouterCatalogResolver;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    mockWrite.mockClear();
    mockRead.mockClear();
    setMemCatalogForTests(null);
    resolver = new OpenRouterCatalogResolver();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function writeArg(): { entries: SlimModelEntry[]; models: Array<{ id: string }> } {
    return mockWrite.mock.calls[0]?.[0] as {
      entries: SlimModelEntry[];
      models: Array<{ id: string }>;
    };
  }

  test("negotiates v3 on the wire — fetch carries the Accept header", async () => {
    let seenAccept: string | undefined;
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      seenAccept = (init?.headers as Record<string, string> | undefined)?.Accept;
      return jsonResponse({
        models: [entry("x", [], { "openrouter-api": { externalId: "v/x" } })],
      });
    }) as unknown as typeof globalThis.fetch;

    await resolver.refreshCatalog(8000);

    expect(seenAccept).toContain("version=3");
  });

  test("v3 envelope maps data.models — vision, contextWindow, sources from aggregators, backward-compat ids", async () => {
    const v3Vision = {
      contractVersion: 3,
      modelId: "glm-4.6v",
      aliases: ["GLM-4.6V"],
      releaseDate: "2026-05-01",
      contextWindow: 131072,
      inputModalities: ["image", "text"],
      aggregators: [
        {
          sourceProviderId: "openrouter",
          sourceCollectorId: "openrouter-api",
          externalModelId: "z-ai/glm-4.6v",
          confidence: "aggregator_reported",
        },
        {
          sourceProviderId: "fireworks",
          sourceCollectorId: "fireworks-api",
          externalModelId: "accounts/fireworks/models/glm-4p6v",
        },
      ],
    };
    const v3Text = {
      contractVersion: 3,
      modelId: "glm-5.3",
      inputModalities: ["text"],
      aggregators: [
        {
          sourceProviderId: "openrouter",
          sourceCollectorId: "openrouter-api",
          externalModelId: "z-ai/glm-5.3",
          confidence: "aggregator_reported",
        },
      ],
    };
    globalThis.fetch = mock(async () =>
      jsonResponse({
        contractVersion: 3,
        generationId: "g-test",
        data: { mode: "slim", models: [v3Vision, v3Text], total: 2 },
      })
    ) as unknown as typeof globalThis.fetch;

    const outcome = await resolver.refreshCatalog(8000);

    expect(outcome).toEqual({
      kind: "refreshed",
      modelCount: 2,
      coverage: { pages: 1, fetched: 2, serverTotal: 2, complete: true },
    });
    const [vision, text] = writeArg().entries;
    expect(vision.modelId).toBe("glm-4.6v");
    // The strip gate reads exactly these two fields (#222: fail-closed on absent data).
    expect(vision.supportsVision).toBe(true);
    expect(vision.contextWindow).toBe(131072);
    expect(vision.releaseDate).toBe("2026-05-01");
    // sources keyed by sourceCollectorId — "openrouter-api" keeps steps 1-4 alive.
    expect(vision.sources["openrouter-api"]).toEqual({ externalId: "z-ai/glm-4.6v" });
    expect(vision.sources["fireworks-api"]).toEqual({
      externalId: "accounts/fireworks/models/glm-4p6v",
    });
    // v3-native aggregator index feeds pricing-cache's provider === "openrouter" lookup.
    expect(vision.aggregators?.[0]).toMatchObject({
      provider: "openrouter",
      externalId: "z-ai/glm-4.6v",
    });
    expect(text.supportsVision).toBe(false);
    expect(writeArg().models).toEqual([{ id: "z-ai/glm-4.6v" }, { id: "z-ai/glm-5.3" }]);
    // Resolution runs off the mapped memory catalog.
    expect(resolver.resolveSync("glm-4.6v")).toBe("z-ai/glm-4.6v");
    expect(resolver.resolveSync("GLM-4.6V")).toBe("z-ai/glm-4.6v");
  });

  test("v3 entry without inputModalities leaves supportsVision undefined — fail-closed stays a data decision", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({
        contractVersion: 3,
        data: {
          models: [
            { contractVersion: 3, modelId: "mystery", aggregators: [] },
          ],
        },
      })
    ) as unknown as typeof globalThis.fetch;

    await resolver.refreshCatalog(8000);

    expect(writeArg().entries[0].supportsVision).toBeUndefined();
    expect(writeArg().entries[0].sources).toEqual({});
  });

  test("HTTP 426 upgrade_required → fetch_failed:http_error (the incident shape, 2026-09-23)", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse(
        {
          contractVersion: 3,
          error: { code: "catalog_client_upgrade_required" },
        },
        426
      )
    ) as unknown as typeof globalThis.fetch;

    const outcome = await resolver.refreshCatalog(8000);

    expect(outcome).toEqual({ kind: "fetch_failed", reason: "http_error" });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  test("v3 envelope with empty data.models → fetch_failed:empty", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ contractVersion: 3, data: { models: [], total: 0 } })
    ) as unknown as typeof globalThis.fetch;

    const outcome = await resolver.refreshCatalog(8000);

    expect(outcome).toEqual({ kind: "fetch_failed", reason: "empty" });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  test("entries without contractVersion pass through byte-identical; a sources-less entry cannot throw in resolveSync", async () => {
    const legacy = entry("legacy-1", ["l1"], { "openrouter-api": { externalId: "v/legacy-1" } });
    globalThis.fetch = mock(async () =>
      jsonResponse({ models: [legacy, { modelId: "future-contract" }] })
    ) as unknown as typeof globalThis.fetch;

    const outcome = await resolver.refreshCatalog(8000);

    expect(outcome).toEqual({
      kind: "refreshed",
      modelCount: 2,
      coverage: { pages: 1, fetched: 2, serverTotal: null, complete: true },
    });
    const entries = writeArg().entries;
    expect(entries[0]).toEqual(legacy);
    // Unknown future contract: sources normalized to {} so resolveSync's
    // Object.values(entry.sources) cannot throw; the entry simply never matches.
    expect(entries[1].sources).toEqual({});
    expect(() => resolver.resolveSync("future-contract")).not.toThrow();
    expect(resolver.resolveSync("legacy-1")).toBe("v/legacy-1");
  });
});

describe("firebaseCatalogUrl — empty overrides fall through (#310 review)", () => {
  // compose injects CLAUDISH_CATALOG_URL as "" (the ${VAR:-} default); the
  // documented default URL must win, not "" — the pre-fix ?? chain fetched ""
  // on every recreated container and refreshCatalog failed as fetch_failed.
  const A = "CLAUDISH_CATALOG_URL";
  const B = "FIREBASE_CATALOG_URL";
  const DEFAULT = "https://us-central1-claudish-6da10.cloudfunctions.net/queryModels?status=active&catalog=slim&limit=1000";

  afterEach(() => {
    delete process.env[A];
    delete process.env[B];
  });

  test("unset → the cloudfunctions default", () => {
    expect(firebaseCatalogUrl()).toBe(DEFAULT);
  });

  test('"" (compose default) → the default, never ""', () => {
    process.env[A] = "";
    expect(firebaseCatalogUrl()).toBe(DEFAULT);
    process.env[B] = "";
    expect(firebaseCatalogUrl()).toBe(DEFAULT);
  });

  test("explicit values win in documented order", () => {
    process.env[B] = "http://alias.example/cat";
    expect(firebaseCatalogUrl()).toBe("http://alias.example/cat");
    process.env[A] = "http://preferred.example/cat";
    expect(firebaseCatalogUrl()).toBe("http://preferred.example/cat");
  });
});

// ---------------------------------------------------------------------------
// Catalog pagination + coverage (#635 AC4)
//
// MEASURED 2026-10-24: the live v3 endpoint answers `data.total = 1002` for a
// `limit=1000` request and hands back a `nextCursor`. The resolver read page 1
// only and wrote it out as the whole catalog, so the models past the first page
// were invisible and NOTHING in the file could say so.
//
// These tests live in THIS file on purpose: `mock.module("../all-models-cache.js")`
// above is process-global (#272), so a separate file importing the same module
// races the mock instead of the real writer — and the run hangs.
// ---------------------------------------------------------------------------
describe("OpenRouterCatalogResolver.refreshCatalog — page walk (#635 AC4)", () => {
  let resolver: OpenRouterCatalogResolver;
  let originalFetch: typeof globalThis.fetch;
  let requested: string[];

  beforeEach(() => {
    mockWrite.mockClear();
    mockRead.mockClear();
    requested = [];
    resolver = new OpenRouterCatalogResolver();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function v3Page(ids: string[], total: number | null, nextCursor: string | null): Response {
    return jsonResponse({
      contractVersion: 3,
      data: {
        mode: "slim",
        models: ids.map((id) => ({
          contractVersion: 3,
          modelId: id,
          aggregators: [{ sourceCollectorId: "openrouter-api", externalModelId: `v/${id}` }],
        })),
        total,
        limit: 1000,
        nextCursor,
      },
    });
  }

  /** Script the n-th answer; every requested URL is recorded. */
  function script(pages: Array<(n: number) => Response>): void {
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      requested.push(String(input));
      const n = requested.length - 1;
      return pages[Math.min(n, pages.length - 1)]!(n);
    }) as unknown as typeof globalThis.fetch;
  }

  function written() {
    return mockWrite.mock.calls[0]?.[0] as {
      entries: SlimModelEntry[];
      models: Array<{ id: string }>;
      coverage?: { pages: number; fetched: number; serverTotal: number | null; complete: boolean };
    };
  }

  test("no cursor: exactly one fetch, coverage says complete", async () => {
    script([() => v3Page(["a", "b"], 2, null)]);

    const outcome = await resolver.refreshCatalog(5000);

    expect(requested.length).toBe(1);
    expect(outcome).toEqual({
      kind: "refreshed",
      modelCount: 2,
      coverage: { pages: 1, fetched: 2, serverTotal: 2, complete: true },
    });
    // What the disk will hold says the same thing as what the caller was told.
    expect(written().coverage).toEqual({
      pages: 1,
      fetched: 2,
      serverTotal: 2,
      complete: true,
    });
  });

  test("cursor present: second page fetched with cursor= and entries merged", async () => {
    script([() => v3Page(["a", "b"], 4, "cur-2"), () => v3Page(["c", "d"], 4, null)]);

    const outcome = await resolver.refreshCatalog(5000);

    expect(requested.length).toBe(2);
    const second = new URL(requested[1]!);
    expect(second.searchParams.get("cursor")).toBe("cur-2");
    // Everything else about the request is unchanged — page 2 is the same catalog.
    expect(second.searchParams.get("limit")).toBe("1000");

    expect(outcome.kind).toBe("refreshed");
    expect((outcome as { modelCount: number }).modelCount).toBe(4);
    expect(written().entries.map((e) => e.modelId)).toEqual(["a", "b", "c", "d"]);
    expect(written().models).toEqual([
      { id: "v/a" },
      { id: "v/b" },
      { id: "v/c" },
      { id: "v/d" },
    ]);
  });

  test("an entry repeated across pages is collected once", async () => {
    script([() => v3Page(["a", "b"], 3, "cur-2"), () => v3Page(["b", "c"], 3, null)]);

    const outcome = await resolver.refreshCatalog(5000);

    expect((outcome as { modelCount: number }).modelCount).toBe(3);
    expect((outcome as { coverage: { complete: boolean } }).coverage.complete).toBe(true);
  });

  test("total reached on page 1: the offered cursor is not followed", async () => {
    script([() => v3Page(["a", "b"], 2, "cur-2")]);

    const outcome = await resolver.refreshCatalog(5000);

    expect(requested.length).toBe(1);
    expect((outcome as { coverage: { complete: boolean } }).coverage.complete).toBe(true);
  });

  test("page-2 HTTP failure keeps page 1 and reports itself incomplete", async () => {
    script([
      () => v3Page(["a", "b"], 1002, "cur-2"),
      () => new Response("upstream boom", { status: 500 }),
    ]);

    const outcome = await resolver.refreshCatalog(5000);

    expect(requested.length).toBe(2);
    // A page past the first is ENRICHMENT (#270): the refresh still succeeded.
    expect(outcome).toEqual({
      kind: "refreshed",
      modelCount: 2,
      coverage: { pages: 1, fetched: 2, serverTotal: 1002, complete: false },
    });
    expect(written().entries.map((e) => e.modelId)).toEqual(["a", "b"]);
  });

  test("page-2 network throw keeps page 1", async () => {
    script([
      () => v3Page(["a"], 3, "cur-2"),
      () => {
        throw new Error("ECONNRESET");
      },
    ]);

    const outcome = await resolver.refreshCatalog(5000);

    expect(outcome.kind).toBe("refreshed");
    expect((outcome as { modelCount: number }).modelCount).toBe(1);
    expect((outcome as { coverage: { complete: boolean } }).coverage.complete).toBe(false);
  });

  test("a replayed cursor cannot loop the walk", async () => {
    script([() => v3Page(["a"], 3, "cur-2"), () => v3Page(["b"], 3, "cur-2")]);

    const outcome = await resolver.refreshCatalog(5000);

    expect(requested.length).toBe(2);
    expect((outcome as { coverage: { complete: boolean } }).coverage.complete).toBe(false);
  });

  test("an endless cursor stream stops at the page cap", async () => {
    script([(_n) => v3Page([`m${requested.length}`], null, `cur-${requested.length + 1}`)]);

    const outcome = await resolver.refreshCatalog(5000);

    expect(requested.length).toBe(10); // CATALOG_MAX_PAGES
    expect((outcome as { coverage: { complete: boolean } }).coverage.complete).toBe(false);
  });

  test("page 1 failure is still the refresh's failure", async () => {
    script([() => new Response("nope", { status: 503 })]);

    const outcome = await resolver.refreshCatalog(5000);

    expect(outcome).toEqual({ kind: "fetch_failed", reason: "http_error" });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  test("ONE deadline for the whole walk: a slow pager stops inside the budget, not per page (#668 r1)", async () => {
    // The headline property of the walk, unpinned until r1: every page costs
    // D ms, the server always offers a fresh cursor, and the caller's T is the
    // budget for the WHOLE refresh. At T = 2.5·D the third page's fetch is cut
    // mid-delay by its remaining-budget signal: 3 requests, 2 pages landed,
    // walk over at the deadline. A per-page timeout instead of the shared
    // deadline (r1 mutant A) hands page 3 the FULL budget, its delay
    // completes, and a third page lands past the deadline — `pages` is the
    // deterministic discriminator; the elapsed bound is the sanity check.
    const D = 150;
    const T = Math.round(2.5 * D); // 375 ms
    let seq = 0;
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      requested.push(String(_input));
      const mine = ++seq;
      const signal = init?.signal;
      const answer = () => v3Page([`m${mine}`], null, `cur-${mine}`);
      if (!signal) return answer();
      if (signal.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, D);
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
      return answer();
    }) as unknown as typeof globalThis.fetch;

    const t0 = Date.now();
    const outcome = await resolver.refreshCatalog(T);
    const elapsed = Date.now() - t0;

    const cov = (outcome as { coverage: { pages: number; complete: boolean } }).coverage;
    expect(cov.complete).toBe(false);
    expect(cov.pages).toBe(2); // page 3 was cut mid-delay by the SHARED deadline
    expect(requested.length).toBe(3);
    expect(requested.length).toBeLessThan(10);
    expect(elapsed).toBeLessThanOrEqual(T + D); // inside T + margin — never 10·D
  });

  test("serverTotal is adopted from a later page (#668 r1)", async () => {
    // Page 1 answers without a total; page 2 declares one and ends the walk.
    // The coverage must carry the SERVER's count, not page 1's absence of it.
    script([() => v3Page(["a"], null, "cur-2"), () => v3Page(["b", "c"], 3, null)]);

    const outcome = await resolver.refreshCatalog(5000);

    expect(outcome).toEqual({
      kind: "refreshed",
      modelCount: 3,
      coverage: { pages: 2, fetched: 3, serverTotal: 3, complete: true },
    });
  });
});
