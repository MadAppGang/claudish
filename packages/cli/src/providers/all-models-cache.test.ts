import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AggregatorEntry } from "../model-loader.js";
import {
  type DiskCacheV3,
  type DroppedConnection,
  type SlimModelEntry,
  _clearAllModelsCacheMemo,
  readAllModelsCache,
  reasoningStatusOf,
  reconcileWires,
  routeRegistryPathFor,
  writeAllModelsCache,
  writeRouteRegistry,
} from "./all-models-cache.js";
import type { CachedRouteRegistry } from "./connection-wire.js";

const dirs: string[] = [];
function cachePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "claudish-cache-v3-"));
  dirs.push(dir);
  return join(dir, "nested", "all-models.json");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sampleEntry = (modelId: string, _externalId: string): SlimModelEntry => ({
  modelId,
  aliases: [],
});

function snapshot(entries: SlimModelEntry[], generation: string): DiskCacheV3 {
  return {
    version: 3,
    lastUpdated: "2026-09-19T01:33:46.169Z",
    catalogGenerationId: generation,
    entries,
    models: [],
    plans: [],
  };
}

describe("all-models-cache v3", () => {
  test("rejects a cache without the current contract or complete snapshot", () => {
    const path = cachePath();
    expect(readAllModelsCache(path)).toBeNull();
    writeAllModelsCache(snapshot([], "generation-a"), path);
    const partial = { version: 3, entries: [], models: [], plans: [] };
    writeFileSync(path, JSON.stringify(partial));
    expect(readAllModelsCache(path)).toBeNull();
    writeFileSync(path, JSON.stringify({ ...snapshot([], "generation-a"), version: 2 }));
    expect(readAllModelsCache(path)).toBeNull();
  });

  test("writes one complete generation without merging earlier rows", () => {
    const path = cachePath();
    const first = snapshot([sampleEntry("model-one", "model-one")], "generation-a");
    const second = snapshot([sampleEntry("model-two", "model-two")], "generation-b");
    writeAllModelsCache(first, path);
    expect(existsSync(path)).toBe(true);
    expect(readAllModelsCache(path)).toEqual(first);
    writeAllModelsCache(second, path);
    expect(readAllModelsCache(path)).toEqual(second);
  });
});

describe("reasoningStatusOf", () => {
  test("keeps explicit unknown truthful even when coarse thinking support is true", () => {
    expect(
      reasoningStatusOf({
        ...sampleEntry("orion-8.0-future", "future-labs/orion-8.0-future"),
        reasoningStatus: "unknown",
        supportsThinking: true,
      })
    ).toBe("unknown");
  });

  test("returns explicit known", () => {
    expect(
      reasoningStatusOf({
        ...sampleEntry("orion-8.1-future", "future-labs/orion-8.1-future"),
        reasoningStatus: "known",
      })
    ).toBe("known");
  });

  test("infers known only from a self-describing reasoning record", () => {
    expect(
      reasoningStatusOf({
        ...sampleEntry("reasoning-described", "future-labs/reasoning-described"),
        reasoning: { supported: true, control: "toggle" },
      })
    ).toBe("known");
    expect(
      reasoningStatusOf({
        ...sampleEntry("reasoning-undescribed", "future-labs/reasoning-undescribed"),
        supportsThinking: true,
      })
    ).toBe("unknown");
  });
});

const wireFixture: DiskCacheV3 = JSON.parse(
  readFileSync(
    new URL("../test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json", import.meta.url),
    "utf8"
  )
);
beforeEach(() => _clearAllModelsCacheMemo());

function knownConnection(cache: DiskCacheV3) {
  return cache.entries
    .flatMap((entry) => entry.aggregators ?? [])
    .find(
      (connection) => connection.routeStatus === "mapped" && connection.wire?.status === "known"
    )!;
}

function mixedWireCache(): DiskCacheV3 {
  const generationId = "generation-google-wires";
  const routeRegistry: CachedRouteRegistry = {
    generationId,
    registry: {
      registryVersion: "3.7.0",
      routes: {
        google: {
          routeId: "google",
          profiles: {
            "direct-api": {
              kind: "direct",
              apis: {
                gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
              },
            },
            "antigravity-subscription": { kind: "subscription", apis: {} },
          },
        },
      },
    },
  };
  const source = wireFixture.entries
    .flatMap((entry) => entry.aggregators ?? [])
    .find(
      (connection) =>
        connection.route?.routeId === "google" &&
        connection.route.routeProfileId === "direct-api" &&
        connection.wire?.status === "known" &&
        connection.wire.api === "gemini"
    );
  if (!source) throw new Error("Expected a known Google Gemini connection in the test data");
  const connection = (modelId: string, routeProfileId: string): AggregatorEntry => ({
    ...structuredClone(source),
    route: { routeId: "google", routeProfileId },
    externalModelId: modelId,
  });
  return {
    ...snapshot(
      [
        {
          modelId: "model-a",
          aliases: [],
          aggregators: [connection("model-a", "antigravity-subscription")],
        },
        {
          modelId: "model-b",
          aliases: [],
          aggregators: [connection("model-b", "direct-api")],
        },
      ],
      generationId
    ),
    routeRegistry,
  };
}

function missingProfileCache(): DiskCacheV3 {
  const cache = mixedWireCache();
  delete cache.routeRegistry!.registry.routes.google!.profiles["antigravity-subscription"];
  return cache;
}

function unknownApiCache(): DiskCacheV3 {
  const cache = mixedWireCache();
  Object.assign(
    cache.routeRegistry!.registry.routes.google!.profiles["antigravity-subscription"]!.apis,
    { "cloudcode-v1internal": { baseUrl: "https://daily-cloudcode-pa.googleapis.com/v1internal" } }
  );
  Object.assign(cache.entries[0]!.aggregators![0]!.wire!, { api: "cloudcode-v1internal" });
  return cache;
}

describe("reconcileWires", () => {
  test("drops a mapped connection on a missing profile without dropping its model", () => {
    const cache = missingProfileCache();
    const result = reconcileWires(cache.entries, cache.routeRegistry!, cache.catalogGenerationId);
    expect(result).not.toBeNull();
    expect(result!.entries.find((entry) => entry.modelId === "model-a")).toEqual({
      ...cache.entries[0]!,
      aggregators: [],
    });
    expect(result!.dropped).toEqual([
      {
        modelId: "model-a",
        routeId: "google",
        routeProfileId: "antigravity-subscription",
        reason: "missing-profile",
      },
    ] satisfies DroppedConnection[]);
    expect(result!.demoted).toEqual([]);
    expect(result!.entries.find((entry) => entry.modelId === "model-b")).toEqual(cache.entries[1]);
  });

  test("reports an unknown API demotion and preserves the valid Gemini model", () => {
    const cache = unknownApiCache();
    const original = structuredClone(cache.entries);
    const result = reconcileWires(cache.entries, cache.routeRegistry!, cache.catalogGenerationId);
    expect(result).not.toBeNull();
    expect(result!.entries[0]!.aggregators).toHaveLength(1);
    expect(result!.entries[0]!.aggregators![0]!.wire?.status).toBe("unknown");
    expect(result!.demoted).toEqual([
      {
        modelId: "model-a",
        routeId: "google",
        routeProfileId: "antigravity-subscription",
        reason: "unknown-api",
      },
    ]);
    expect(result!.entries[1]).toEqual(original[1]);
    expect(cache.entries).toEqual(original);
  });

  test("demotes a known Gemini wire whose subscription profile has no API", () => {
    expect(reconcileWires).toBeFunction();
    const cache = mixedWireCache();
    const result = reconcileWires(cache.entries, cache.routeRegistry!, cache.catalogGenerationId);
    expect(result).not.toBeNull();
    expect(result!.entries).toHaveLength(2);
    expect(
      result!.entries.find((entry) => entry.modelId === "model-a")?.aggregators?.[0]?.wire?.status
    ).toBe("unknown");
    expect(result!.demoted).toHaveLength(1);
  });

  test("preserves the valid direct-api model unchanged beside a demoted connection", () => {
    expect(reconcileWires).toBeFunction();
    const cache = mixedWireCache();
    const unchangedModel = structuredClone(cache.entries[1]);
    const result = reconcileWires(cache.entries, cache.routeRegistry!, cache.catalogGenerationId);
    expect(result).not.toBeNull();
    expect(result!.entries.find((entry) => entry.modelId === "model-b")).toEqual(unchangedModel);
  });

  test("returns null for a different registry generation", () => {
    expect(reconcileWires).toBeFunction();
    const cache = mixedWireCache();
    cache.routeRegistry!.generationId = "different-generation";
    expect(
      reconcileWires(cache.entries, cache.routeRegistry!, cache.catalogGenerationId)
    ).toBeNull();
  });
});

describe("wire registry cache validation", () => {
  test("reads a cache with a missing profile and removes only its connection", () => {
    const path = cachePath();
    const cache = missingProfileCache();
    writeAllModelsCache(cache, path);
    const loaded = readAllModelsCache(path);
    expect(loaded).not.toBeNull();
    expect(loaded!.entries.find((entry) => entry.modelId === "model-a")).toEqual({
      ...cache.entries[0]!,
      aggregators: [],
    });
    expect(loaded!.entries[1]).toEqual(cache.entries[1]);
  });

  test("reads a generation containing an unknown API beside a valid Gemini wire", () => {
    const path = cachePath();
    const cache = unknownApiCache();
    writeAllModelsCache(cache, path);
    const loaded = readAllModelsCache(path);
    expect(loaded).not.toBeNull();
    expect(loaded!.entries[0]!.aggregators).toHaveLength(1);
    expect(loaded!.entries[0]!.aggregators![0]!.wire?.status).toBe("unknown");
    expect(loaded!.entries[1]).toEqual(cache.entries[1]);
  });

  test("loads both models from an inline registry and demotes only the unusable wire", () => {
    const path = cachePath();
    const cache = mixedWireCache();
    writeAllModelsCache(cache, path);
    rmSync(routeRegistryPathFor(path));
    const loaded = readAllModelsCache(path);
    expect(loaded).not.toBeNull();
    expect(loaded!.entries).toHaveLength(2);
    expect(
      loaded!.entries.find((entry) => entry.modelId === "model-a")?.aggregators?.[0]?.wire?.status
    ).toBe("unknown");
    expect(loaded!.entries.find((entry) => entry.modelId === "model-b")).toEqual(cache.entries[1]);
  });
  test("loads the whole production fixture", () => {
    const path = cachePath();
    writeAllModelsCache(wireFixture, path);
    expect(readAllModelsCache(path)).toEqual(wireFixture);
  });
  const demotedCases: Array<[string, (cache: DiskCacheV3) => void]> = [
    [
      "mapped connection without wire",
      (cache) => {
        delete knownConnection(cache).wire;
      },
    ],
    [
      "malformed connection wire",
      (cache) => {
        Object.assign(knownConnection(cache).wire!, { api: "realtime" });
      },
    ],
    [
      "known API absent from its profile",
      (cache) => {
        const connection = knownConnection(cache);
        if (connection.wire?.status !== "known") throw new Error("Expected known fixture wire");
        delete cache.routeRegistry!.registry.routes[connection.route!.routeId]!.profiles[
          connection.route!.routeProfileId
        ]!.apis[connection.wire.api];
      },
    ],
  ];
  for (const [name, mutate] of demotedCases) {
    test(`demotes ${name} without rejecting the cache`, () => {
      const path = cachePath();
      const cache = structuredClone(wireFixture);
      const connection = knownConnection(cache);
      const entryIndex = cache.entries.findIndex((entry) =>
        entry.aggregators?.includes(connection)
      );
      const connectionIndex = cache.entries[entryIndex]!.aggregators!.indexOf(connection);
      mutate(cache);
      writeAllModelsCache(cache, path);
      const loaded = readAllModelsCache(path);
      expect(loaded).not.toBeNull();
      expect(loaded!.entries).toHaveLength(cache.entries.length);
      expect(loaded!.entries[entryIndex]!.aggregators![connectionIndex]!.wire?.status).toBe(
        "unknown"
      );
    });
  }

  const invalidCases: Array<[string, (cache: DiskCacheV3) => void]> = [
    [
      "different registry generation",
      (cache) => {
        cache.routeRegistry!.generationId = "other-generation";
      },
    ],
    [
      "malformed registry",
      (cache) => {
        Reflect.deleteProperty(cache.routeRegistry!.registry, "routes");
      },
    ],
  ];
  for (const [name, mutate] of invalidCases) {
    test(`rejects ${name}`, () => {
      const path = cachePath();
      const cache = structuredClone(wireFixture);
      writeAllModelsCache(cache, path);
      expect(readAllModelsCache(path)).toEqual(cache);
      mutate(cache);
      writeFileSync(path, JSON.stringify(cache));
      expect(readAllModelsCache(path)).toBeNull();
    });
  }
  test("accepts a cache written before route registries", () => {
    const cache = structuredClone(wireFixture);
    delete cache.routeRegistry;
    const path = cachePath();
    writeAllModelsCache(cache, path);
    expect(readAllModelsCache(path)).toEqual(cache);
  });
  test("accepts a missing wire under registry 3.6.0", () => {
    const cache = structuredClone(wireFixture);
    cache.routeRegistry!.registry.registryVersion = "3.6.0";
    delete knownConnection(cache).wire;
    const path = cachePath();
    writeAllModelsCache(cache, path);
    expect(readAllModelsCache(path)).toEqual(cache);
  });
  test("memo observes writer updates, direct size-changing writes and deletion", () => {
    const path = cachePath();
    const cache = structuredClone(wireFixture);
    writeAllModelsCache(cache, path);
    const timestamp = new Date("2026-10-12T00:00:00Z");
    utimesSync(path, timestamp, timestamp);
    const firstRead = readAllModelsCache(path);
    expect(firstRead).toEqual(cache);
    expect(readAllModelsCache(path)).toBe(firstRead);
    // Same size and mtime: only writeAllModelsCache's invalidation sees this.
    cache.lastUpdated = "2026-10-13T00:00:00.000Z";
    expect(cache.lastUpdated.length).toBe(wireFixture.lastUpdated.length);
    writeAllModelsCache(cache, path);
    utimesSync(path, timestamp, timestamp);
    expect(readAllModelsCache(path)).toEqual(cache);
    // Same mtime, different size: out-of-band writes must also invalidate.
    cache.entries[0]!.displayName = "A different and longer value written directly to disk";
    writeFileSync(path, JSON.stringify(cache));
    utimesSync(path, timestamp, timestamp);
    expect(readAllModelsCache(path)).toEqual(cache);
    rmSync(path);
    expect(readAllModelsCache(path)).toBeNull();
  });
});

describe("route registry sidecar", () => {
  function withoutRegistry() {
    const cache = structuredClone(wireFixture);
    delete cache.routeRegistry;
    return cache;
  }
  test("attaches a matching sidecar without embedding it in the models file", () => {
    const path = cachePath();
    writeAllModelsCache(withoutRegistry(), path);
    writeFileSync(routeRegistryPathFor(path), JSON.stringify(wireFixture.routeRegistry));
    expect(readAllModelsCache(path)?.routeRegistry).toEqual(wireFixture.routeRegistry);
    expect(JSON.parse(readFileSync(path, "utf8")).routeRegistry).toBeUndefined();
  });
  test("ignores a sidecar with a mismatched generation", () => {
    const path = cachePath();
    const cache = withoutRegistry();
    const registry = structuredClone(wireFixture.routeRegistry!);
    registry.generationId = "different-generation";
    writeAllModelsCache(cache, path);
    writeRouteRegistry(registry, path);
    expect(readAllModelsCache(path)).toEqual(cache);
  });
  test("attaches a sidecar with a missing profile and drops its connection", () => {
    const path = cachePath();
    const cache = withoutRegistry();
    const registry = structuredClone(wireFixture.routeRegistry!);
    const connection = knownConnection(cache);
    const entryIndex = cache.entries.findIndex((entry) => entry.aggregators?.includes(connection));
    const route = connection.route!;
    delete registry.registry.routes[route.routeId]!.profiles[route.routeProfileId];
    writeAllModelsCache(cache, path);
    writeRouteRegistry(registry, path);
    const loaded = readAllModelsCache(path);
    expect(loaded?.routeRegistry).toBeDefined();
    expect(loaded!.routeRegistry).toEqual(registry);
    expect(loaded!.entries[entryIndex]!.aggregators).not.toContainEqual(
      expect.objectContaining({ route })
    );
  });
  test("both writers persist the sidecar and the registry writer invalidates a memoized read", () => {
    const path = cachePath();
    expect(routeRegistryPathFor(path)).toBe(path.replace(/\.json$/, ".routes.json"));
    writeAllModelsCache(wireFixture, path);
    expect(JSON.parse(readFileSync(routeRegistryPathFor(path), "utf8"))).toEqual(
      wireFixture.routeRegistry
    );
    rmSync(routeRegistryPathFor(path));
    writeAllModelsCache(withoutRegistry(), path);
    expect(readAllModelsCache(path)?.routeRegistry).toBeUndefined();
    writeRouteRegistry(wireFixture.routeRegistry!, path);
    expect(readAllModelsCache(path)?.routeRegistry).toEqual(wireFixture.routeRegistry);
  });
  test("memo observes out-of-band sidecar creation, size, mtime and removal", () => {
    const path = cachePath();
    const side = routeRegistryPathFor(path);
    writeAllModelsCache(withoutRegistry(), path);
    expect(readAllModelsCache(path)?.routeRegistry).toBeUndefined();
    const bytes = JSON.stringify(wireFixture.routeRegistry);
    const stamp = new Date("2026-10-12T00:00:00Z");
    writeFileSync(side, bytes);
    utimesSync(side, stamp, stamp);
    expect(readAllModelsCache(path)?.routeRegistry).toEqual(wireFixture.routeRegistry);
    const invalid = JSON.stringify({ ...wireFixture.routeRegistry, generationId: "wrong" });
    writeFileSync(side, invalid);
    utimesSync(side, stamp, stamp);
    expect(readAllModelsCache(path)?.routeRegistry).toBeUndefined();
    writeFileSync(side, bytes);
    utimesSync(side, stamp, stamp);
    expect(readAllModelsCache(path)?.routeRegistry).toEqual(wireFixture.routeRegistry);
    // Same byte count: only the sidecar mtime reveals this invalid generation.
    writeFileSync(
      side,
      bytes.replace(
        wireFixture.catalogGenerationId,
        "x".repeat(wireFixture.catalogGenerationId.length)
      )
    );
    utimesSync(side, new Date(stamp.getTime() + 2000), new Date(stamp.getTime() + 2000));
    expect(readAllModelsCache(path)?.routeRegistry).toBeUndefined();
    writeFileSync(side, bytes);
    expect(readAllModelsCache(path)?.routeRegistry).toBeDefined();
    rmSync(side);
    expect(readAllModelsCache(path)?.routeRegistry).toBeUndefined();
  });
  test("an older claudish rewrite cannot attach the previous generation's sidecar", () => {
    const path = cachePath();
    writeAllModelsCache(wireFixture, path);
    expect(readAllModelsCache(path)?.routeRegistry).toBeDefined();
    const newer = { ...withoutRegistry(), catalogGenerationId: "new-generation" };
    writeFileSync(path, JSON.stringify(newer));
    expect(readAllModelsCache(path)).toEqual(newer);
    expect(JSON.parse(readFileSync(routeRegistryPathFor(path), "utf8"))).toEqual(
      wireFixture.routeRegistry
    );
  });
});
