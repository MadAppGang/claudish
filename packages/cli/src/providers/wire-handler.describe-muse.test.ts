import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import museCatalog from "../test-fixtures/catalog-v3/muse-code-g-20261021063612126-17350b71.json";
import {
  type DiskCacheV3,
  _clearAllModelsCacheMemo,
  writeAllModelsCache,
} from "./all-models-cache.js";
import { resolveConnection } from "./connection-resolver.js";
import { describeConnectionWire } from "./wire-handler.js";

// MTL-189 follow-up: C — probe shows the pinned Muse URL (generation g-20261021063612126-17350b71).
const dirs: string[] = [];
afterEach(() => {
  _clearAllModelsCacheMemo();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("describes the pinned Muse Responses URL instead of the registry override", () => {
  const dir = mkdtempSync(join(tmpdir(), "describe-muse-"));
  dirs.push(dir);
  const cachePath = join(dir, "catalog.json");
  const data = structuredClone(museCatalog) as DiskCacheV3;
  data.routeRegistry!.registry.routes.meta!.profiles["muse-code-subscription"]!.apis
    .responses!.baseUrl = "https://override.invalid/v1";
  writeAllModelsCache(data, cachePath);
  const resolution = resolveConnection("meta-muse-code", "muse-wonder-full-1.0", cachePath);
  expect(resolution.ok).toBe(true);
  if (!resolution.ok) throw new Error(resolution.reason);
  const description = describeConnectionWire(resolution.connection);
  expect(description).toContain("https://api.meta.ai/v1/responses");
  expect(description).not.toContain("override.invalid");
});
