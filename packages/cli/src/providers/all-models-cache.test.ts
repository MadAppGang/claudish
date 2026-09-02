/**
 * Tests for the shared ~/.claudish/all-models.json cache helpers.
 *
 * Each test uses a unique tmp path via `node:os.tmpdir()` to isolate state.
 *
 * Run: bun test packages/cli/src/providers/all-models-cache.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DiskCacheV2,
  type SlimModelEntry,
  readAllModelsCache,
  writeAllModelsCache,
} from "./all-models-cache.js";

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
    expect(result!.models).toEqual([{ id: "openai/gpt-4" }, { id: "anthropic/claude-3" }]);
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

  test("stores queryPlans routing and preserves it across a model-only refresh", () => {
    const { path, cleanup } = makeTmpCachePath();
    cleanups.push(cleanup);
    const plans = [
      {
        id: "commercial-plan",
        modelDiscovery: "catalog" as const,
        routing: { providerUid: "subscription-provider", nativeModelProviders: [] },
      },
    ];

    writeAllModelsCache(
      {
        entries: [sampleEntry("model-one", "vendor/model-one")],
        models: [],
        plans,
      },
      path
    );
    writeAllModelsCache(
      {
        entries: [sampleEntry("model-two", "vendor/model-two")],
        models: [],
      },
      path
    );

    expect(readAllModelsCache(path)?.plans).toEqual(plans);
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
