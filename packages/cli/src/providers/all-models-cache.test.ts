import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DiskCacheV3,
  type SlimModelEntry,
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
