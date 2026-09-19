/**
 * Tests for the slim-catalog query accessor module.
 *
 * Run: bun test packages/cli/src/providers/catalog-query.test.ts
 *
 * Covers:
 *   - findEntryByAlias: hit, miss, multi-entry cache
 *   - findEntryByModelId: hit, miss
 *   - findVisionAlias: respects `supportsVision === true`, miss when no vision entry
 *   - Cache missing (readAllModelsCache → null): all three return null without throwing
 *   - Empty entries array: all three return null
 *
 * Mock strategy mirrors `catalog-warm.test.ts` — `mock.module` swaps the
 * `./all-models-cache.js` module so `readAllModelsCache()` returns a synthetic
 * `DiskCacheV3` (or null) configured per-test. No real disk I/O.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import type { DiskCacheV3, SlimModelEntry } from "./all-models-cache.js";
// Value import captured BEFORE the mock.module below so afterAll can restore
// the REAL module. mock.module is PROCESS-GLOBAL and bleeds across files, so
// without this restore the stub here breaks the sibling all-models-cache.test
// suite (same process). The spread snapshots the real exports.
import * as __realAllModelsCache from "./all-models-cache.js";
const __realAllModelsCacheExports = { ...__realAllModelsCache };

// ---------------------------------------------------------------------------
// Module mock for the disk-cache layer
// ---------------------------------------------------------------------------
//
// `mock.module()` is hoisted by Bun, so we register the mock BEFORE importing
// the module under test. `mockReadResult` is mutated in beforeEach.
//
// Test path note: in commit 6 the accessors gained a mtime-keyed memo that
// calls `statSync(ALL_MODELS_CACHE_PATH)` to detect file changes. The mock
// reports `ALL_MODELS_CACHE_PATH = "/tmp/test-all-models.json"`, so we
// create a placeholder file in `beforeAll` (and remove it in `afterAll`) so
// `statSync` succeeds and returns a stable mtime. The mocked
// `readAllModelsCache` still serves the synthetic `mockReadResult` — the
// file's contents don't matter, only its mtime does.

const TEST_CACHE_PATH = "/tmp/test-all-models.json";

let mockReadResult: DiskCacheV3 | null = null;

mock.module("./all-models-cache.js", () => ({
  readAllModelsCache: () => mockReadResult,
  // catalog-query.ts imports readAllModelsCache + ALL_MODELS_CACHE_PATH +
  // the SlimModelEntry type. The other exports are present in the real
  // module but unused here; we still expose them as no-ops so a type-only
  // import doesn't crash if tree-shaking doesn't strip it.
  writeAllModelsCache: () => undefined,
  ALL_MODELS_CACHE_PATH: TEST_CACHE_PATH,
}));

// Now import the module under test. The mock above is wired in.
import {
  _resetMemo,
  findEntryByAlias,
  findEntryByModelId,
  findVisionAlias,
} from "./catalog-query.js";

// Touch the file so `statSync(ALL_MODELS_CACHE_PATH)` resolves in the memo
// path. The mocked `readAllModelsCache` ignores the file contents.
beforeAll(() => {
  writeFileSync(TEST_CACHE_PATH, "{}", "utf-8");
});

afterAll(() => {
  if (existsSync(TEST_CACHE_PATH)) {
    try {
      unlinkSync(TEST_CACHE_PATH);
    } catch {
      // Best-effort cleanup; ignore if another test already removed it.
    }
  }
  // Restore the real disk-cache module so the process-global stub doesn't
  // bleed into sibling suites (e.g. all-models-cache.test.ts).
  mock.module("./all-models-cache.js", () => __realAllModelsCacheExports);
});

// Reset the in-module memo before every test so swapping `mockReadResult`
// takes effect immediately rather than returning the previously-cached
// entries.
beforeEach(() => {
  _resetMemo();
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Build a synthetic disk cache from a list of slim entries. Wraps them in the
 * v2 envelope with a fixed `lastUpdated` so tests don't depend on `now`.
 */
function diskCache(entries: SlimModelEntry[]): DiskCacheV3 {
  return {
    catalogGenerationId: "test-generation",
    plans: [],
    version: 3,
    lastUpdated: "2026-05-08T12:00:00.000Z",
    entries,
    models: entries.map((e) => ({ id: e.modelId })),
  };
}

/**
 * The standard multi-entry fixture used by most tests:
 *   - sonnet entry: modelId "claude-sonnet-4-6", aliases include "sonnet",
 *     supportsVision: true.
 *   - haiku entry: modelId "claude-haiku-4-6", aliases include "haiku",
 *     supportsVision: false.
 *   - opus entry: modelId "claude-opus-4-7", aliases include "opus",
 *     supportsVision: true.
 *
 * This shape mirrors what the Firebase slim catalog actually returns — see
 * `OpenRouterCatalogResolver._fetchAndCache` for the producer.
 */
function standardEntries(): SlimModelEntry[] {
  return [
    {
      modelId: "claude-sonnet-4-6",
      aliases: ["sonnet", "claude-sonnet-4"],

      supportsVision: true,
      contextWindow: 200000,
    },
    {
      modelId: "claude-haiku-4-6",
      aliases: ["haiku"],

      supportsVision: false,
      contextWindow: 200000,
    },
    {
      modelId: "claude-opus-4-7",
      aliases: ["opus"],

      supportsVision: true,
      contextWindow: 200000,
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("findEntryByAlias", () => {
  beforeEach(() => {
    mockReadResult = diskCache(standardEntries());
  });

  test("returns the entry whose aliases includes 'sonnet'", () => {
    const result = findEntryByAlias("sonnet");
    expect(result).not.toBeNull();
    expect(result?.modelId).toBe("claude-sonnet-4-6");
    expect(result?.aliases).toContain("sonnet");
    expect(result?.supportsVision).toBe(true);
    expect(result?.contextWindow).toBe(200000);
  });

  test("returns the haiku entry from a multi-entry fixture", () => {
    const result = findEntryByAlias("haiku");
    expect(result).not.toBeNull();
    expect(result?.modelId).toBe("claude-haiku-4-6");
    expect(result?.supportsVision).toBe(false);
  });

  test("'nonexistent' alias → null", () => {
    expect(findEntryByAlias("nonexistent")).toBeNull();
  });

  test("alias match is case-sensitive (per architecture §6.B)", () => {
    // "SONNET" is not in the aliases array (which has "sonnet" lowercase).
    expect(findEntryByAlias("SONNET")).toBeNull();
  });
});

describe("findEntryByModelId", () => {
  beforeEach(() => {
    mockReadResult = diskCache(standardEntries());
  });

  test("returns the matching entry for 'claude-opus-4-7'", () => {
    const result = findEntryByModelId("claude-opus-4-7");
    expect(result).not.toBeNull();
    expect(result?.modelId).toBe("claude-opus-4-7");
    expect(result?.aliases).toContain("opus");
    expect(result?.supportsVision).toBe(true);
  });

  test("'not-real' modelId → null", () => {
    expect(findEntryByModelId("not-real")).toBeNull();
  });
});

describe("findVisionAlias", () => {
  beforeEach(() => {
    mockReadResult = diskCache(standardEntries());
  });

  test("returns the sonnet entry (supportsVision: true)", () => {
    const result = findVisionAlias("sonnet");
    expect(result).not.toBeNull();
    expect(result?.modelId).toBe("claude-sonnet-4-6");
    expect(result?.supportsVision).toBe(true);
  });

  test("haiku entry has supportsVision: false → null", () => {
    expect(findVisionAlias("haiku")).toBeNull();
  });

  test("'nonexistent-alias' → null", () => {
    expect(findVisionAlias("nonexistent-alias")).toBeNull();
  });
});

describe("when readAllModelsCache returns null (cache missing)", () => {
  beforeEach(() => {
    mockReadResult = null;
  });

  test("findEntryByAlias returns null without throwing", () => {
    expect(() => findEntryByAlias("sonnet")).not.toThrow();
    expect(findEntryByAlias("sonnet")).toBeNull();
  });

  test("findEntryByModelId returns null without throwing", () => {
    expect(() => findEntryByModelId("claude-opus-4-7")).not.toThrow();
    expect(findEntryByModelId("claude-opus-4-7")).toBeNull();
  });

  test("findVisionAlias returns null without throwing", () => {
    expect(() => findVisionAlias("sonnet")).not.toThrow();
    expect(findVisionAlias("sonnet")).toBeNull();
  });
});

describe("when cache exists but entries is empty", () => {
  beforeEach(() => {
    mockReadResult = diskCache([]);
  });

  test("findEntryByAlias returns null", () => {
    expect(findEntryByAlias("sonnet")).toBeNull();
  });

  test("findEntryByModelId returns null", () => {
    expect(findEntryByModelId("claude-opus-4-7")).toBeNull();
  });

  test("findVisionAlias returns null", () => {
    expect(findVisionAlias("sonnet")).toBeNull();
  });
});
