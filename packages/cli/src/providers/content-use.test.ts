import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { AggregatorEntry } from "../model-loader.js";
import {
  allConnections,
  isOptInWireId,
  normaliseCatalogPayload,
  splitOptInConnections,
} from "./content-use.js";

// Wire ids from wire-capture §4; contributor-free is architecture §3(b).
function connection(id: string): AggregatorEntry {
  return {
    sourceProviderId: "meta",
    sourceCollectorId: "meta",
    confidence: "api_official",
    routeStatus: "mapped",
    route: { routeId: "meta", routeProfileId: "direct-api" },
    externalModelId: id,
  };
}

describe("G1: content-use opt-in is explicit", () => {
  test.each([
    ["muse-spark-1.3-contributor", true],
    ["meta/muse-spark-1.3-CONTRIBUTOR", true],
    ["meta/muse-spark-1.3-Contributor-Free", true],
    ["muse-spark-1.3", false],
    ["muse-wonder-full-1.0", false],
    ["muse-spark-1.3-contributor-preview", false],
    ["contributor/muse-spark-1.3", false],
    ["muse-spark-1.3-contributor/ordinary", false],
    ["", false],
  ])("G1: %s → %s", (id, expected) => {
    expect(isOptInWireId(id)).toBe(expected);
  });

  test("G1: contributor-first partition is lossless and idempotent", () => {
    const opt = connection("muse-spark-1.3-contributor");
    const plain = connection("muse-spark-1.3");
    const free = connection("muse-spark-1.3-contributor-free");
    const entry = { modelId: "muse-spark-1.3", aggregators: [opt, plain, free] };
    const split = splitOptInConnections(entry);
    expect(split.aggregators).toEqual([plain]);
    expect(split.optInConnections).toEqual([opt, free]);
    expect(splitOptInConnections(split)).toEqual(split);
    expect(allConnections(split)).toEqual([plain, opt, free]);
    expect(
      allConnections(split).find((row) => row.externalModelId === opt.externalModelId)
    ).toEqual(opt);
  });

  test("G1: payload normalization retains model metadata and plain connections", () => {
    const plain = connection("muse-wonder-full-1.0");
    const opt = connection("muse-wonder-full-1.0-contributor");
    const payload = {
      models: [{ modelId: "muse-wonder-full-1.0", provider: "meta", aggregators: [opt, plain] }],
    };
    const normalized = normaliseCatalogPayload(payload);
    expect(normalized.models[0]?.aggregators).toEqual([plain]);
    expect(normalized.models[0]?.provider).toBe("meta");
    expect(allConnections(normalized.models[0]!)).toEqual([plain, opt]);
    expect(normaliseCatalogPayload(normalized)).toEqual(normalized);
  });
});

// These guards inspect the final repository ONLY when the runner executes them.
// The authoring sandbox contains no implementation source.
function sources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

test("G1: content-use.ts owns the sole contributor suffix regex", () => {
  const root = fileURLToPath(new URL("./", import.meta.url));
  const occurrences = sources(root).flatMap((path) => {
    const text = readFileSync(path, "utf8");
    return [...text.matchAll(/\/(?:\\.|[^/\r\n])+\/[dgimsuvy]*/g)]
      .filter((match) => match[0].includes("contributor") && match[0].includes("$"))
      .map(() => relative(root, path));
  });
  expect(occurrences).toEqual(["content-use.ts"]);
});

test("G1: aggregators readers require architecture review", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const approved = new Set([
    "providers/content-use.ts",
    "providers/catalog-client.ts",
    "adapters/model-catalog.ts",
    "providers/route-candidates.ts",
    "providers/connection-resolver.ts",
    "providers/model-availability.ts",
    "model-selector.ts",
    "model-loader.ts",
    "handlers/native-handler-advisor.ts",
    "services/pricing-cache.ts",
    "session/baseline-pricing.ts",
    "providers/model-catalog.ts",
    "providers/catalog-query.ts",
    "providers/all-models-cache.ts",
  ]);
  const unexpected = sources(root)
    .filter((path) => {
      const text = readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      return (
        /\.aggregators\b|\[\s*["\']aggregators["\']\s*\]/.test(text) &&
        !approved.has(relative(root, path))
      );
    })
    .map((path) => relative(root, path));
  expect(unexpected).toEqual([]);
});
