import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isRecommendationTier } from "../model-loader.js";
import { _setBundledListForTest, readBundledList } from "./all-models-cache.js";
import { type BundledListFile, serializeBundledList } from "./bundled-list-build.js";
import { bundledListRaw, bundledProvenance } from "./bundled-list.js";

// The shipped JSON is never imported or read as a file here. Both observations
// go through the public readers; setup suites install their own list instead.
beforeEach(() => _setBundledListForTest(undefined));
afterEach(() => _setBundledListForTest(undefined));

function shipped() {
  const raw = bundledListRaw();
  const parsed = readBundledList();
  expect(raw).not.toBeNull();
  expect(parsed).not.toBeNull();
  if (!raw || !parsed) throw new Error("the shipped bundled recommended list is unreadable");
  return { file: raw as BundledListFile, parsed };
}

describe("R1 RB-17 RB-25: the release-generated bundled recommended list", () => {
  test("R1.5: provenance identifies production and one complete generation", () => {
    const { file, parsed } = shipped();

    expect(file.bundle.format).toBe(1);
    expect(file.bundle.source).toBe("https://us-central1-claudish-6da10.cloudfunctions.net");
    expect(Number.isNaN(Date.parse(file.bundle.fetchedAt))).toBe(false);
    expect(file.catalogGenerationId.length).toBeGreaterThan(0);
    expect(file.routeRegistry.generationId).toBe(file.catalogGenerationId);
    expect(file.bundle.recommendations.contractVersion).toBe(3);
    expect(file.bundle.recommendations.generationId).toBe(file.catalogGenerationId);
    expect(parsed.catalogGenerationId).toBe(file.catalogGenerationId);
    expect(bundledProvenance()).toMatchObject({
      version: expect.any(String),
      generationId: file.catalogGenerationId,
      fetchedAt: file.bundle.fetchedAt,
    });
    expect(parsed.entries).toHaveLength(file.entries.length);
  });

  test("R1.1 RB-17: all recommendation tiers are known and every row has a model", () => {
    const { file } = shipped();
    const ids = new Set(file.entries.map((entry) => entry.modelId));
    const rows = file.bundle.recommendations.entries;

    expect(rows.length).toBeGreaterThan(0);
    expect(ids.size).toBe(file.entries.length);
    for (const row of rows) {
      expect(isRecommendationTier(row.tier)).toBe(true);
      expect(ids.has(row.modelId)).toBe(true);
    }
    const recommendedIds = new Set(rows.map((row) => row.modelId));
    for (const entry of file.entries) {
      if (recommendedIds.has(entry.modelId)) continue;
      // R1: the slim read includes route variants of recommended base models.
      expect(entry.routeVariant?.baseModelId, entry.modelId).toBeDefined();
      expect(recommendedIds.has(entry.routeVariant!.baseModelId!), entry.modelId).toBe(true);
    }
  });

  test("RB-17: every connection is mapped to a vendor-own direct or subscription profile", () => {
    const { file, parsed } = shipped();
    let count = 0;
    for (const entry of file.entries) {
      const kept = entry.aggregators ?? [];
      for (const connection of kept) {
        count++;
        expect(connection.routeStatus).toBe("mapped");
        expect(connection.route).toBeDefined();
        const binding = connection.route!;
        const profile =
          file.routeRegistry.registry.routes[binding.routeId]?.profiles[binding.routeProfileId];
        expect(profile).toBeDefined();
        expect(["direct", "subscription"]).toContain(profile!.kind);
        expect(profile!.nativeModelProviders).toContain(entry.provider!);
        expect(binding.routeId).toBe(entry.provider!);
      }
      const reread = parsed.entries.find((model) => model.modelId === entry.modelId)!;
      expect((reread.aggregators?.length ?? 0) + (reread.optInConnections?.length ?? 0)).toBe(
        kept.length
      );
    }
    expect(count).toBeGreaterThan(0);
  });

  test("R1.2 RB-23: effort coverage and sendableOn refer only to bundled ids and kept connections", () => {
    const { file } = shipped();
    const byId = new Map(file.entries.map((entry) => [entry.modelId, entry]));
    const recommendedIds = new Set(file.bundle.recommendations.entries.map((row) => row.modelId));
    for (const modelId of recommendedIds) {
      const entry = byId.get(modelId);
      expect(entry, modelId).toBeDefined();
      if (entry!.reasoning?.efforts?.length && file.bundle.efforts[modelId] !== undefined) {
        expect(Object.keys(file.bundle.efforts[modelId]).length, modelId).toBeGreaterThan(0);
      }
    }
    for (const [modelId, tasks] of Object.entries(file.bundle.efforts)) {
      const entry = byId.get(modelId);
      expect(entry).toBeDefined();
      expect(Object.keys(tasks).length).toBeGreaterThan(0);
      for (const cell of Object.values(tasks)) {
        expect(cell.effort.length).toBeGreaterThan(0);
        // Empty after connection trimming is valid; the cell itself must survive.
        for (const sendable of cell.sendableOn) {
          // Stored encoding is backend metadata; only sending requires request_parameter.
          if (sendable.encoding !== undefined) expect(typeof sendable.encoding).toBe("string");
          expect(
            entry!.aggregators!.some(
              (connection) =>
                connection.route?.routeId === sendable.routeId &&
                connection.route?.routeProfileId === sendable.routeProfileId &&
                connection.externalModelId === sendable.externalModelId
            )
          ).toBe(true);
        }
      }
    }
  });

  test("R1 RB-25: no evidence content ships at any depth", () => {
    const { file } = shipped();
    const inspect = (value: unknown, path = "$"): void => {
      if (Array.isArray(value)) {
        value.forEach((cell, index) => inspect(cell, `${path}[${index}]`));
      } else if (value && typeof value === "object") {
        for (const [key, cell] of Object.entries(value)) {
          if (["evidenceSourceUrl", "sourceUrl", "sourceCollectorId", "confidence"].includes(key)) {
            throw new Error(`evidence field shipped at ${path}.${key}`);
          }
          if (key === "evidence") {
            expect(path.endsWith(".wire")).toBe(true);
            expect(cell).toEqual([]);
          } else inspect(cell, `${path}.${key}`);
        }
      }
    };
    inspect(file);
  });

  test("R1: public raw data serializes deterministically without losing metadata", () => {
    const { file } = shipped();

    const serialized = serializeBundledList(file);

    expect(JSON.parse(serialized)).toEqual(file);
    expect(serializeBundledList(JSON.parse(serialized))).toBe(serialized);
    expect(serialized.endsWith("\n")).toBe(true);
    // Exact on-disk byte equality needs a public byte reader. Reading the
    // shipped JSON directly to add that assertion would bypass this contract.
  });
});
