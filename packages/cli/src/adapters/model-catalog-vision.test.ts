import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiskCacheV3 } from "../providers/all-models-cache.js";
import { lookupModelAcceptsImages } from "./model-catalog.js";

const fixture: DiskCacheV3 = JSON.parse(
  readFileSync(
    new URL("../test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json", import.meta.url),
    "utf8"
  )
);
test.each([
  { modalities: ["image", "text"], vision: false, expected: true },
  { modalities: ["text"], vision: true, expected: false },
  { modalities: [], vision: true, expected: true },
  { modalities: [], vision: false, expected: false },
  { modalities: undefined, vision: true, expected: true },
  { modalities: undefined, vision: undefined, expected: undefined },
  { modalities: [], vision: undefined, expected: undefined },
])("image input metadata: %j", ({ modalities, vision, expected }) => {
  const dir = mkdtempSync(join(tmpdir(), "vision-wire-"));
  try {
    const cache = structuredClone(fixture);
    const entry = cache.entries.find((e) => e.modelId === "gpt-6.1-sol")!;
    if (modalities === undefined) delete entry.inputModalities;
    else entry.inputModalities = [...modalities];
    if (vision === undefined) delete entry.supportsVision;
    else entry.supportsVision = vision;
    const path = join(dir, "catalog.json");
    writeFileSync(path, JSON.stringify(cache));
    expect(lookupModelAcceptsImages(entry.modelId, path)).toBe(expected);
    expect(lookupModelAcceptsImages("unpublished-model", path)).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
