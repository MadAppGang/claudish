import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AggregatorEntry } from "../model-loader.js";
import type { DiskCacheV3, SlimModelEntry } from "./all-models-cache.js";

let home: string;
let savedKeychain: string | undefined;
let cachePath: string;
let savedFetch: typeof globalThis.fetch;
let cache: typeof import("./all-models-cache.js");

function connection(id: string, routeId = "meta", routeProfileId = "direct-api"): AggregatorEntry {
  return {
    sourceProviderId: routeId,
    sourceCollectorId: routeId,
    confidence: "api_official",
    routeStatus: "mapped",
    route: { routeId, routeProfileId },
    externalModelId: id,
  };
}
function seed(aggregators: AggregatorEntry[]): SlimModelEntry {
  return {
    contractVersion: 3,
    modelId: "muse-spark-1.3",
    provider: "meta",
    aliases: [],
    aggregators,
  };
}
function disk(entries: SlimModelEntry[]): DiskCacheV3 {
  return {
    version: 3,
    lastUpdated: new Date().toISOString(),
    catalogGenerationId: "g-run3-fixture",
    entries,
    models: entries.map((entry) => ({ id: entry.modelId })),
    plans: [],
  };
}
beforeEach(async () => {
  // All disk access uses the explicit cache path; HOME is not an isolation seam.
  home = mkdtempSync(join(tmpdir(), "claudish-run3-"));
  savedKeychain = process.env.CLAUDISH_DISABLE_KEYCHAIN;
  process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
  cachePath = join(home, "all-models.json");
  savedFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("Run 3 tests forbid network requests");
    },
    { preconnect: () => {} }
  ) as typeof fetch;
  cache = await import("./all-models-cache.js");
  cache._clearAllModelsCacheMemo();
});
afterEach(() => {
  cache?._clearAllModelsCacheMemo();
  if (savedFetch) globalThis.fetch = savedFetch;
  if (savedKeychain === undefined) delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
  else process.env.CLAUDISH_DISABLE_KEYCHAIN = savedKeychain;
  rmSync(home, { recursive: true, force: true });
});

describe("G2a: disk ingestion partitions before exposing connections", () => {
  test("G2a: raw contributor-first v3 disk data is normalized on read", async () => {
    const { allConnections } = await import("./content-use.js");
    const opt = connection("muse-spark-1.3-contributor");
    const plain = connection("muse-spark-1.3");
    // Bypass the writer so a writer-side fix cannot conceal a reader regression.
    writeFileSync(cachePath, JSON.stringify(disk([seed([opt, plain])])));
    const result = cache.readAllModelsCache(cachePath);
    expect(result).not.toBeNull();
    expect(result!.entries[0]!.aggregators).toEqual([plain]);
    expect(allConnections(result!.entries[0]!)).toEqual([plain, opt]);
    expect(cache.isSlimModelEntry(result!.entries[0])).toBe(true);
  });

  test("G2a: write/read retains both plain and opt-in connections", async () => {
    const { allConnections } = await import("./content-use.js");
    const opt = connection("muse-spark-1.3-contributor");
    const plain = connection("muse-spark-1.3");
    cache.writeAllModelsCache(disk([seed([opt, plain])]), cachePath);
    cache._clearAllModelsCacheMemo();
    const result = cache.readAllModelsCache(cachePath);
    expect(result).not.toBeNull();
    expect(result!.entries[0]!.aggregators).toEqual([plain]);
    expect(allConnections(result!.entries[0]!)).toEqual([plain, opt]);
  });

  const invalidRows = [
    { field: "routeStatus", mutate: (row: AggregatorEntry) => ({ ...row, routeStatus: 42 }) },
    {
      field: "route.routeId",
      mutate: (row: AggregatorEntry) => ({ ...row, route: { ...row.route!, routeId: 42 } }),
    },
    {
      field: "route.routeProfileId",
      mutate: (row: AggregatorEntry) => ({ ...row, route: { ...row.route!, routeProfileId: 42 } }),
    },
    {
      field: "externalModelId",
      mutate: (row: AggregatorEntry) => ({ ...row, externalModelId: "" }),
    },
  ];
  for (const { field, mutate } of invalidRows) {
    test.each([true, false])(
      `G2a: malformed raw row (${field}, opt-in=%s) is rejected before partition`,
      (optIn) => {
        // Identical invalid fields on opt-in and plain rows test validation parity.
        const invalid = mutate(connection(optIn ? "muse-spark-1.3-contributor" : "muse-spark-1.3"));
        const raw = { ...seed([]), aggregators: [invalid, connection("muse-spark-1.3")] };
        expect(cache.isSlimModelEntry(raw)).toBe(false);
        writeFileSync(
          cachePath,
          JSON.stringify({ ...disk([]), entries: [raw], models: [{ id: raw.modelId }] })
        );
        cache._clearAllModelsCacheMemo();
        const read = cache.readAllModelsCache(cachePath);
        expect(read?.entries.some((entry) => entry.modelId === raw.modelId) ?? false).toBe(false);
      }
    );
  }
});
