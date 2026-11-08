import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AggregatorEntry } from "../model-loader.js";
import type { DiskCacheV3 } from "./all-models-cache.js";
import type { CachedRouteRegistry, KnownWire } from "./connection-wire.js";

const id = "muse-spark-1.3";
const generation = "g-run3-connections";
// Cloud models catalog fixture, not a Meta HTTP response.
const plainWire: KnownWire = {
  status: "known",
  api: "responses",
  tokenParam: "max_output_tokens",
  toolsWithReasoning: "ok",
  reasoning: { status: "unknown" },
  speed: { status: "unknown" },
  evidence: [],
};
const contributorWire: KnownWire = {
  ...plainWire,
  api: "chat-completions",
  tokenParam: "max_tokens",
};
function connection(
  wireId: string,
  wire: KnownWire,
  routeId = "meta",
  profile = "direct-api"
): AggregatorEntry {
  return {
    sourceProviderId: routeId,
    sourceCollectorId: routeId,
    confidence: "api_official",
    routeStatus: "mapped",
    route: { routeId, routeProfileId: profile },
    externalModelId: wireId,
    wire,
  };
}
let home: string;
let path: string;
let savedKeychain: string | undefined;
let savedFetch: typeof fetch;
let cache: typeof import("./all-models-cache.js");
let catalog: typeof import("./catalog-client.js");
let resolver: typeof import("./connection-resolver.js");
beforeEach(async () => {
  // All disk access uses the explicit cache path; HOME is not an isolation seam.
  home = mkdtempSync(join(tmpdir(), "claudish-g3-"));
  path = join(home, "models.json");
  savedKeychain = process.env.CLAUDISH_DISABLE_KEYCHAIN;
  process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
  savedFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("G3 forbids network");
    },
    { preconnect: () => {} }
  ) as typeof fetch;
  cache = await import("./all-models-cache.js");
  catalog = await import("./catalog-client.js");
  resolver = await import("./connection-resolver.js");
  cache._clearAllModelsCacheMemo();
  catalog._resetCatalogClient();
});
afterEach(() => {
  cache?._clearAllModelsCacheMemo();
  catalog?._setCatalogEntriesForTest(null);
  catalog?._resetCatalogClient();
  globalThis.fetch = savedFetch;
  if (savedKeychain === undefined) delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
  else process.env.CLAUDISH_DISABLE_KEYCHAIN = savedKeychain;
  rmSync(home, { recursive: true, force: true });
});
function install(aggregators: AggregatorEntry[]) {
  const routeRegistry: CachedRouteRegistry = {
    generationId: generation,
    registry: {
      registryVersion: "3.7.0",
      routes: {
        meta: {
          profiles: {
            "direct-api": {
              kind: "direct",
              nativeModelProviders: ["meta"],
              apis: {
                responses: { baseUrl: "https://api.meta.ai/v1" },
                "chat-completions": { baseUrl: "https://api.meta.ai/v1" },
              },
            },
          },
        },
        openrouter: {
          profiles: {
            gateway: {
              kind: "gateway",
              apis: {
                responses: { baseUrl: "https://openrouter.ai/api/v1" },
              },
            },
          },
        },
      },
    },
  };
  const entries = [
    { contractVersion: 3 as const, modelId: id, provider: "meta", aliases: [], aggregators },
  ];
  const data: DiskCacheV3 = {
    version: 3,
    lastUpdated: new Date().toISOString(),
    catalogGenerationId: generation,
    entries,
    models: [{ id }],
    plans: [],
    routeRegistry,
  };
  cache.writeAllModelsCache(data, path);
  catalog._setCatalogEntriesForTest(entries);
}

test.each([id, `${id}-contributor`])(
  "G3: explicit %s uses its exact connection and request URL",
  (requested) => {
    install([connection(`${id}-contributor`, contributorWire), connection(id, plainWire)]);
    const result = resolver.resolveConnection("meta", requested, path);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.connection.externalModelId).toBe(requested);
    expect(result.connection.wire).toEqual(requested === id ? plainWire : contributorWire);
    expect(result.connection.generationId).toBe(generation);
    expect(
      resolver.connectionRequestUrl(
        result.connection,
        requested === id ? "responses" : "chat-completions"
      )
    ).toBe(`https://api.meta.ai/v1/${requested === id ? "responses" : "chat/completions"}`);
  }
);

test("G3: implicit selection and borrowed owner wire exclude contributor-first connection", () => {
  const gateway = connection(id, plainWire, "openrouter", "gateway");
  gateway.wire = { status: "unknown", evidence: [] };
  install([connection(`${id}-contributor`, contributorWire), connection(id, plainWire), gateway]);
  const result = resolver.resolveConnection("openrouter", id, path);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  expect(result.connection.externalModelId).toBe(id);
  expect(result.connection.ownerWire).toEqual(plainWire);
  expect(result.connection.ownerWire).not.toEqual(contributorWire);
});

test("G3: opt-in-only Meta connection is unavailable for an implicit plain request", () => {
  install([connection(`${id}-contributor`, contributorWire)]);
  expect(resolver.resolveConnection("meta", id, path)).toEqual({
    ok: false,
    reason: "no-connection",
  });
});
