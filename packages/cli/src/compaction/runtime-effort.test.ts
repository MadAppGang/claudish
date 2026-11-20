import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DiskCacheV3,
  _clearAllModelsCacheMemo,
  writeAllModelsCache,
} from "../providers/all-models-cache.js";
import {
  capturedLines,
  startLogCapture,
  stopLogCapture,
} from "../recovery/test-helpers/capture-log.js";
import { DEFAULT_COMPACTION_SETTINGS } from "./config.js";
import { type CompactionRuntime, prepareCompaction } from "./runtime.js";

// A catalog whose Claude API connection of claude-sonnet-5-5 publishes
// effort at /output_config/effort with a "low" level.
const catalog: DiskCacheV3 = JSON.parse(
  readFileSync(
    new URL("../test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json", import.meta.url),
    "utf8"
  )
);
const model = "claude-sonnet-5-5";

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (() => {
    throw new Error("Unexpected network access");
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

let dir: string;
let runtime: CompactionRuntime | null = null;
beforeEach(() => {
  _clearAllModelsCacheMemo();
  dir = mkdtempSync(join(tmpdir(), "compaction-runtime-effort-"));
  startLogCapture();
});
afterEach(async () => {
  await runtime?.shutdown?.();
  runtime = null;
  stopLogCapture();
  rmSync(dir, { recursive: true, force: true });
  _clearAllModelsCacheMemo();
});

const CALL = { system: "S", user: "U", maxTokens: 64, timeoutMs: 1000, purpose: "history" };

test("a catalog that arrives after compaction started sets the effort of the next call", async () => {
  const catalogPath = join(dir, "catalog.json");
  const bodies: Record<string, unknown>[] = [];
  runtime = await prepareCompaction({
    settings: { ...DEFAULT_COMPACTION_SETTINGS, enabled: true, model },
    storeRoot: join(dir, "store"),
    catalogPath,
    credentials: {
      async resolveForUse() {
        return { state: "present" as const, key: "FAKE_RUNTIME_EFFORT_0000", source: "env" };
      },
    },
    fetchImpl: (async (req: Request) => {
      bodies.push(JSON.parse(await req.text()));
      return Response.json({
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "SUMMARY" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as unknown as typeof fetch,
    warn() {},
    record() {},
  });
  if (!runtime) throw new Error("an exact model and a present key must enable compaction");

  // First run: no catalog file yet, so no effort is sent.
  await runtime.client.complete(CALL);
  expect(bodies[0]).not.toHaveProperty("output_config");

  // The first catalog refresh writes the file.
  writeAllModelsCache(structuredClone(catalog), catalogPath);
  await runtime.client.complete(CALL);
  expect(bodies[1]?.output_config).toEqual({ effort: "low" });
  await runtime.client.complete(CALL);
  expect(bodies[2]?.output_config).toEqual({ effort: "low" });

  const lines = await capturedLines();
  // The startup line does not claim an answer the catalog has not given yet.
  const startup = lines.find((l) => l.includes("[compaction] on: model"));
  expect(startup).toBeDefined();
  expect(startup).not.toContain("none published");
  // The effort actually sent is logged on the first call, and again only when it changes.
  const effortLines = lines.filter((l) => l.includes("[compaction] output_config.effort"));
  expect(effortLines).toHaveLength(2);
  expect(effortLines[0]).toContain("not sent");
  expect(effortLines[1]).toContain('sent: "low"');
});
