import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DiskCacheV3,
  type SlimModelEntry,
  _clearAllModelsCacheMemo,
  readAllModelsCache,
  reasoningStatusOf,
  writeAllModelsCache,
} from "./all-models-cache.js";

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

describe("wire registry cache validation", () => {
  test("loads the whole production fixture", () => {
    const path = cachePath();
    writeAllModelsCache(wireFixture, path);
    expect(readAllModelsCache(path)).toEqual(wireFixture);
  });
  const invalidCases: Array<[string, (cache: DiskCacheV3) => void]> = [
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
    [
      "missing route profile",
      (cache) => {
        const route = knownConnection(cache).route!;
        delete cache.routeRegistry!.registry.routes[route.routeId]!.profiles[route.routeProfileId];
      },
    ],
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
