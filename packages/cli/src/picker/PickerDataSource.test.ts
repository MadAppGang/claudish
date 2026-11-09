import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentials } from "../auth/credentials/authority.js";
import type { PickerDiscoveryOutcome } from "../model-selector.js";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "../providers/catalog-client.js";
import {
  deriveAccountKey,
  writeStoredModelsList,
} from "../providers/dynamic-models-catalog-store.js";
import {
  _resetAccountModelsListsForTest,
  loadAccountModelsLists,
} from "../providers/dynamic-models-catalog.js";
import { createPickerDataSource, discoveryShapeOf } from "./PickerDataSource.js";

let home: string;
let previous: { dir?: string; key?: string };
let identity: ReturnType<typeof spyOn>;
let network: ReturnType<typeof spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "claudish-picker-source-"));
  previous = {
    dir: process.env.CLAUDISH_DYNAMIC_CATALOG_DIR,
    key: process.env.CLAUDISH_DYNAMIC_CATALOG_KEY,
  };
  process.env.CLAUDISH_DYNAMIC_CATALOG_DIR = join(home, "lists");
  process.env.CLAUDISH_DYNAMIC_CATALOG_KEY = join(home, "secret");
  _setCatalogEntriesForTest([]);
  _resetAccountModelsListsForTest();
  identity = spyOn(credentials, "accountIdentity").mockImplementation(async (provider) =>
    provider === "devin" ? "picker-account" : undefined
  );
  network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
});

afterEach(() => {
  identity.mockRestore();
  network.mockRestore();
  _resetAccountModelsListsForTest();
  _resetCatalogClient();
  for (const [name, value] of [
    ["CLAUDISH_DYNAMIC_CATALOG_DIR", previous.dir],
    ["CLAUDISH_DYNAMIC_CATALOG_KEY", previous.key],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

test("52. the cached outcome is synchronous", async () => {
  const models = [
    {
      id: "swe-1-7-medium",
      displayName: "SWE-1.7",
      contextWindow: 200000,
      reported: "chat" as const,
    },
  ];
  const key = deriveAccountKey("devin", "picker-account");
  expect(key.ok).toBe(true);
  if (!key.ok) throw new Error(key.reason);
  expect(writeStoredModelsList("devin", key.accountKey, models)).toBe(true);
  const lists = await loadAccountModelsLists();
  expect(lists.get("devin")?.models).toEqual(models);

  const source = createPickerDataSource() as ReturnType<typeof createPickerDataSource> & {
    cachedModelsCatalog(provider: string): PickerDiscoveryOutcome | null;
  };
  // Drain the disk-only read started when the data source opened.
  await loadAccountModelsLists();
  expect(typeof source.cachedModelsCatalog).toBe("function");
  const cached = source.cachedModelsCatalog("devin");
  expect(cached).not.toBeInstanceOf(Promise);
  expect(cached?.kind).toBe("rows");
  if (cached?.kind !== "rows") throw new Error("Expected cached rows");
  expect(cached.rows.map((row) => row.id)).toEqual(["swe-1-7-medium"]);
  expect(source.cachedModelsCatalog("grok-subscription")).toBeNull();
  expect(network).not.toHaveBeenCalled();
});

// REGRESSION: LM Studio picker hides models the cloud models catalog does not list
test("LM Studio's discovery runs through the GET half, so it earns the deadline indicator", () => {
  // The native /api/v0/models list is fetched by the same GET half as an
  // OpenAI-style list, under the same FETCH_TIMEOUT_MS, so the panel draws the
  // same determinate deadline for both.
  expect(discoveryShapeOf("lmstudio")).toBe("deadline");
  expect(discoveryShapeOf("kimi-coding")).toBe("deadline");
  expect(discoveryShapeOf("ollama")).toBe("elapsed");
});
