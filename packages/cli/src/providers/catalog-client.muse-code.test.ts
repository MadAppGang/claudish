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

let catalog: typeof import("./catalog-client.js") | undefined;
afterEach(() => {
  catalog?._setCatalogEntriesForTest(null);
  catalog?._resetCatalogClient();
});

describe("G2b: catalog setter and wire-id resolution", () => {
  beforeEach(async () => {
    catalog = await import("./catalog-client.js");
    catalog._resetCatalogClient();
  });

  test("G2b: setter normalizes contributor-first rows; implicit selection stays plain", async () => {
    const { allConnections } = await import("./content-use.js");
    const opt = connection("muse-spark-1.3-contributor");
    const plain = connection("muse-spark-1.3");
    catalog!._setCatalogEntriesForTest([seed([opt, plain])]);
    const entry = catalog!.getCatalogEntries()![0]!;
    expect(entry.aggregators).toEqual([plain]);
    expect(allConnections(entry)).toEqual([plain, opt]);
    expect(catalog!.externalIdFor(entry, "meta")).toBe("muse-spark-1.3");
  });

  test("G2b: exact contributor id survives while plain lookup chooses plain id", () => {
    const opt = connection("muse-spark-1.3-contributor");
    const plain = connection("muse-spark-1.3");
    writeFileSync(cachePath, JSON.stringify(disk([seed([opt, plain])])));
    catalog!._setCatalogEntriesForTest([seed([opt, plain])]);
    expect(catalog!.resolveExternalId("muse-spark-1.3-contributor", "meta", cachePath)).toBe(
      opt.externalModelId!
    );
    expect(catalog!.resolveExternalId("muse-spark-1.3", "meta", cachePath)).toBe(
      plain.externalModelId!
    );
  });

  test("G2b: plain request cannot inherit an opt-in-only connection", () => {
    const entry = seed([connection("muse-spark-1.3-contributor")]);
    writeFileSync(cachePath, JSON.stringify(disk([entry])));
    catalog!._setCatalogEntriesForTest([entry]);
    expect(catalog!.externalIdFor(catalog!.getCatalogEntries()![0]!, "meta")).toBeNull();
    expect(catalog!.resolveExternalId("muse-spark-1.3", "meta", cachePath)).toBeNull();
    expect(catalog!.resolveExternalId("muse-spark-1.3-contributor", "meta", cachePath)).toBe(
      "muse-spark-1.3-contributor"
    );
  });

  test.skip("G2b BLOCKED: CatalogV3Envelope<T> leaves refresh model-page T and pagination/completeness fields undeclared", () => {});
});
