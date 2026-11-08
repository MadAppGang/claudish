import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AggregatorEntry } from "../model-loader.js";
import museCatalog from "../test-fixtures/catalog-v3/muse-code-g-20261021063612126-17350b71.json";
import { isOptInWireId, splitOptInConnections } from "./content-use.js";

// MTL-189 follow-up: F — contentUse wins over contributor suffixes (generation g-20261021063612126-17350b71).
const spark = museCatalog.entries.find((entry) => entry.modelId === "muse-spark-1.3")!;
type CatalogConnection = (typeof spark.aggregators)[number];

function catalogConnection(row: CatalogConnection): AggregatorEntry & CatalogConnection {
  return row as AggregatorEntry & CatalogConnection;
}

const contributor = catalogConnection(
  spark.aggregators.find(
    (row) => row.route.routeProfileId === "direct-api" && row.contentUse === "contributor"
  )!
);
const standard = catalogConnection(
  spark.aggregators.find(
    (row) => row.route.routeProfileId === "direct-api" && row.contentUse === "standard"
  )!
);

test("F1: a real contributor contentUse connection is opt-in", () => {
  const row = structuredClone(contributor);
  const result = splitOptInConnections({ aggregators: [row] });
  expect(result.optInConnections).toEqual([row]);
  expect(result.aggregators).toEqual([]);
});

test("F2: a missing contentUse retains the contributor suffix fallback", () => {
  const { contentUse: _contentUse, ...row } = structuredClone(contributor);
  const result = splitOptInConnections({ aggregators: [row] });
  expect(result.optInConnections).toEqual([row]);
  expect(result.aggregators).toEqual([]);
});

test("F3: a real standard contentUse connection is not opt-in", () => {
  const row = structuredClone(standard);
  const result = splitOptInConnections({ aggregators: [row] });
  expect(result.aggregators).toEqual([row]);
  expect(result.optInConnections ?? []).toEqual([]);
});

test("F4: standard contentUse wins over a contributor suffix", () => {
  const row = { ...structuredClone(contributor), contentUse: "standard" };
  const result = splitOptInConnections({ aggregators: [row] });
  expect(result.optInConnections ?? []).toEqual([]);
  expect(result.aggregators).toEqual([row]);
});

test("F5: contributor contentUse is opt-in without a contributor suffix", () => {
  const row = {
    ...structuredClone(contributor),
    externalModelId: contributor.externalModelId.replace(/-contributor$/, ""),
  };
  const result = splitOptInConnections({ aggregators: [row] });
  expect(result.optInConnections).toEqual([row]);
  expect(result.aggregators).toEqual([]);
});

function catalogConnections(value: unknown): AggregatorEntry[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(catalogConnections);
  return Object.entries(value).flatMap(([key, child]) =>
    (key === "aggregators" || key === "optInConnections") && Array.isArray(child)
      ? (child as AggregatorEntry[])
      : catalogConnections(child)
  );
}

const catalogDir = join(import.meta.dir, "..", "test-fixtures", "catalog-v3");
const catalogFiles = readdirSync(catalogDir)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => ({
    file,
    connections: catalogConnections(JSON.parse(readFileSync(join(catalogDir, file), "utf8"))),
  }))
  .filter(({ connections }) => connections.length > 0);

test("the real catalog test data contains connections carrying contentUse", () => {
  expect(
    catalogFiles.flatMap(({ connections }) => connections).filter((row) => "contentUse" in row)
      .length
  ).toBeGreaterThan(0);
});

for (const { file, connections } of catalogFiles) {
  test(`contentUse and wire-id opt-in rules agree for every field-bearing connection in ${file}`, () => {
    for (const row of connections.filter((connection) => "contentUse" in connection)) {
      expect(typeof row.externalModelId).toBe("string");
      const result = splitOptInConnections({ aggregators: [row] });
      const optIn = isOptInWireId(row.externalModelId!);
      const label = `${file}: ${row.route?.routeId}/${row.route?.routeProfileId}/${row.externalModelId}`;
      expect(result.optInConnections?.includes(row) ?? false, label).toBe(optIn);
      expect(result.aggregators?.includes(row) ?? false, label).toBe(!optIn);
    }
  });
}
