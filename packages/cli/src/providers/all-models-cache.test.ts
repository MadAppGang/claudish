/**
 * Tests for the shared ~/.claudish/all-models.json cache helpers.
 *
 * Each test uses a unique tmp path via `node:os.tmpdir()` to isolate state.
 *
 * Run: bun test packages/cli/src/providers/all-models-cache.test.ts
 */

import { describe, test, expect, afterEach } from "bun:test";
import { writeFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import * as maybeMocked from "./all-models-cache.js";

// #272: bun's mock.module is process-global with no unregister API. When
// launcher/catalog-warm.test.ts (which replaces this whole module) is loaded
// in the same run, our static bindings silently point at its mock and every
// tmp-file test fails confusingly. Detect the mock via the canary path every
// mock installs, then re-import the real file through a query-suffixed
// specifier — a distinct registry key the mock does not cover.
const realModuleSpecifier = "./all-models-cache.js?real";
const cache =
  maybeMocked.allModelsCachePath?.() === "/tmp/test-all-models.json"
    ? await import(realModuleSpecifier)
    : maybeMocked;
if (cache.allModelsCachePath?.() === "/tmp/test-all-models.json") {
  throw new Error(
    "#272 bypass failed: query-suffixed import still serves the mock — update the bypass"
  );
}
const readAllModelsCache = cache.readAllModelsCache.bind(cache);
const writeAllModelsCache = cache.writeAllModelsCache.bind(cache);
type DiskCacheV2 = maybeMocked.DiskCacheV2;
type SlimModelEntry = maybeMocked.SlimModelEntry;

/**
 * Create a unique tmp directory for a single test. Returns (path, cleanup).
 * The path points at a file inside a fresh tmp dir — callers can pass it
 * as the optional path argument to readAllModelsCache/writeAllModelsCache.
 */
function makeTmpCachePath(): { path: string; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "claudish-cache-test-"));
  const path = join(dir, "all-models.json");
  return {
    path,
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    const c = cleanups.pop();
    c?.();
  }
});

const sampleEntry = (modelId: string, externalId: string): SlimModelEntry => ({
  modelId,
  aliases: [],
  sources: { "openrouter-api": { externalId } },
});

describe("all-models-cache helpers", () => {
  test("reads v1 file and normalizes to v2", () => {
    const { path, cleanup } = makeTmpCachePath();
    cleanups.push(cleanup);

    const v1Payload = {
      lastUpdated: "2026-01-01T00:00:00.000Z",
      models: [{ id: "openai/gpt-4" }, { id: "anthropic/claude-3" }],
    };
    writeFileSync(path, JSON.stringify(v1Payload), "utf-8");

    const result = readAllModelsCache(path);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(2);
    expect(result!.lastUpdated).toBe("2026-01-01T00:00:00.000Z");
    expect(result!.entries).toEqual([]);
    expect(result!.models).toEqual([
      { id: "openai/gpt-4" },
      { id: "anthropic/claude-3" },
    ]);
  });

  test("reads v2 file unchanged", () => {
    const { path, cleanup } = makeTmpCachePath();
    cleanups.push(cleanup);

    const v2Payload: DiskCacheV2 = {
      version: 2,
      lastUpdated: "2026-02-02T12:00:00.000Z",
      entries: [
        sampleEntry("grok-4", "x-ai/grok-4"),
        sampleEntry("claude-3", "anthropic/claude-3"),
      ],
      models: [{ id: "x-ai/grok-4" }, { id: "anthropic/claude-3" }],
    };
    writeFileSync(path, JSON.stringify(v2Payload), "utf-8");

    const result = readAllModelsCache(path);
    expect(result).toEqual(v2Payload);
  });

  test("writer preserves existing entries when new data has no entries", () => {
    const { path, cleanup } = makeTmpCachePath();
    cleanups.push(cleanup);

    // Seed with v2 data containing rich entries
    const seed: DiskCacheV2 = {
      version: 2,
      lastUpdated: "2026-03-03T00:00:00.000Z",
      entries: [
        sampleEntry("firebase-model", "vendor/firebase-model"),
        sampleEntry("other-model", "vendor/other-model"),
      ],
      models: [{ id: "vendor/firebase-model" }, { id: "vendor/other-model" }],
    };
    writeFileSync(path, JSON.stringify(seed), "utf-8");

    // Legacy writer style: only supplies models
    const legacyModels = [{ id: "openai/gpt-4" }, { id: "anthropic/claude-3" }];
    writeAllModelsCache({ models: legacyModels }, path);

    const result = readAllModelsCache(path);
    expect(result).not.toBeNull();
    // Critical: entries must still be present after legacy write
    expect(result!.entries).toHaveLength(2);
    expect(result!.entries).toEqual(seed.entries);
    // Models were overwritten by the legacy write
    expect(result!.models).toEqual(legacyModels);
  });

  test("writer merges when new data has entries", () => {
    const { path, cleanup } = makeTmpCachePath();
    cleanups.push(cleanup);

    // Seed with partial data
    const seed: DiskCacheV2 = {
      version: 2,
      lastUpdated: "2026-04-04T00:00:00.000Z",
      entries: [sampleEntry("old-model", "vendor/old-model")],
      models: [{ id: "vendor/old-model" }],
    };
    writeFileSync(path, JSON.stringify(seed), "utf-8");

    // OpenRouter-style write: supplies fresh entries AND models
    const newEntries = [
      sampleEntry("grok-4", "x-ai/grok-4"),
      sampleEntry("claude-3", "anthropic/claude-3"),
    ];
    const newModels = [{ id: "x-ai/grok-4" }, { id: "anthropic/claude-3" }];
    writeAllModelsCache({ entries: newEntries, models: newModels }, path);

    const result = readAllModelsCache(path);
    expect(result).not.toBeNull();
    // New entries replace the old ones wholesale (this is the full refresh path)
    expect(result!.entries).toEqual(newEntries);
    expect(result!.models).toEqual(newModels);
  });

  test("writer creates parent directory if missing", () => {
    // Use a path inside a nested dir that doesn't exist yet
    const base = mkdtempSync(join(tmpdir(), "claudish-cache-test-"));
    const nestedDir = join(base, "nested", "cache", "dir");
    const path = join(nestedDir, "all-models.json");
    cleanups.push(() => {
      try {
        rmSync(base, { recursive: true, force: true });
      } catch {
        // best effort
      }
    });

    expect(existsSync(nestedDir)).toBe(false);

    writeAllModelsCache(
      {
        models: [{ id: "openai/gpt-4" }],
      },
      path
    );

    expect(existsSync(path)).toBe(true);
    const result = readAllModelsCache(path);
    expect(result).not.toBeNull();
    expect(result!.models).toEqual([{ id: "openai/gpt-4" }]);
    expect(result!.entries).toEqual([]);
  });
});

// #637 review point 2: the path must be resolved PER CALL. An import-time
// constant mutates silently — a value set after module load is ignored by the
// writers while catalog-query's mtime memo keeps watching the old file, and the
// two halves of the cache split with every test still green.
describe("allModelsCachePath — CLAUDISH_MODEL_CACHE_PATH (#637)", () => {
  const original = process.env.CLAUDISH_MODEL_CACHE_PATH;

  afterEach(() => {
    if (original === undefined) delete process.env.CLAUDISH_MODEL_CACHE_PATH;
    else process.env.CLAUDISH_MODEL_CACHE_PATH = original;
  });

  test("an override set AFTER import is honored by write and read", () => {
    const { path, dir, cleanup } = makeTmpCachePath();
    cleanups.push(cleanup);

    // Set after import on purpose: this is the whole point of the pin.
    process.env.CLAUDISH_MODEL_CACHE_PATH = path;

    expect(cache.allModelsCachePath()).toBe(path);
    writeAllModelsCache({ models: [{ id: "override/landed" }] });

    expect(existsSync(path)).toBe(true);
    expect(readAllModelsCache()!.models).toEqual([{ id: "override/landed" }]);
    expect(dir.length).toBeGreaterThan(0);
  });

  test("a whitespace-only override falls back to the historical path", () => {
    process.env.CLAUDISH_MODEL_CACHE_PATH = "   ";
    expect(cache.allModelsCachePath()).toBe(join(homedir(), ".claudish", "all-models.json"));
  });

  test("unset keeps the historical path byte-for-byte", () => {
    delete process.env.CLAUDISH_MODEL_CACHE_PATH;
    expect(cache.allModelsCachePath()).toBe(join(homedir(), ".claudish", "all-models.json"));
  });
});
