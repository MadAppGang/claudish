import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "../providers/catalog-client.js";
import { DEFAULT_COMPACTION_SETTINGS } from "./config.js";
import { type CompactionCredentialSource, prepareCompaction } from "./runtime.js";

const TIER_MODEL = "claude-haiku-test-9";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "compaction-cold-"));
  _resetCatalogClient();
  _setCatalogEntriesForTest([]);
});
afterEach(() => {
  _resetCatalogClient();
  rmSync(root, { recursive: true, force: true });
});

const credentials: CompactionCredentialSource = {
  resolveForUse: async () => ({ state: "present", key: "FAKE_COLD_VALUE_00000", source: "test" }),
};

function seedCatalog(): void {
  _setCatalogEntriesForTest([
    {
      modelId: TIER_MODEL,
      provider: "anthropic",
      aliases: [],
      contextWindow: 200_000,
      aggregators: [],
    } as never,
  ]);
}

test("a tier alias waits for a cold catalog, then resolves", async () => {
  const warnings: string[] = [];
  let waits = 0;
  const runtime = await prepareCompaction({
    settings: { ...DEFAULT_COMPACTION_SETTINGS, enabled: true },
    credentials,
    storeRoot: root,
    warn: (m) => warnings.push(m),
    waitForCatalog: async () => {
      waits += 1;
      seedCatalog();
    },
    record() {},
  });
  expect(warnings).toEqual([]);
  expect(waits).toBe(1);
  expect(runtime?.model).toBe(TIER_MODEL);
});

test("a catalog that stays cold turns compaction off with one warning", async () => {
  const warnings: string[] = [];
  const runtime = await prepareCompaction({
    settings: { ...DEFAULT_COMPACTION_SETTINGS, enabled: true },
    credentials,
    storeRoot: root,
    warn: (m) => warnings.push(m),
    waitForCatalog: async () => {},
    record() {},
  });
  expect(runtime).toBeNull();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("compaction.model does not resolve");
});

test("a warm catalog is not waited for, and a non-Claude name is refused without a wait", async () => {
  seedCatalog();
  let waits = 0;
  const waitForCatalog = async () => {
    waits += 1;
  };
  const warm = await prepareCompaction({
    settings: { ...DEFAULT_COMPACTION_SETTINGS, enabled: true },
    credentials,
    storeRoot: root,
    warn() {},
    waitForCatalog,
    record() {},
  });
  expect(warm?.model).toBe(TIER_MODEL);
  const refused = await prepareCompaction({
    settings: { ...DEFAULT_COMPACTION_SETTINGS, enabled: true, model: "not-a-claude-model" },
    credentials,
    storeRoot: root,
    warn() {},
    waitForCatalog,
    record() {},
  });
  expect(refused).toBeNull();
  expect(waits).toBe(0);
});
