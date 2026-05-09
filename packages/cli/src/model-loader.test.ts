/**
 * Regression tests for model-loader.ts.
 *
 * Run: bun test packages/cli/src/model-loader.test.ts
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MODEL_LOADER_SOURCE = readFileSync(
  join(__dirname, "model-loader.ts"),
  "utf-8"
);

describe("getRecommendedModelsSync — TTL gate (source-level regression guard)", () => {
  // Guards against the sync resolver serving disk-cache of unbounded age.
  // The async resolver gates its disk-cache read with `isFreshEnough()`
  // (FIREBASE_CACHE_TTL_HOURS); the sync path must do the same so callers
  // (loadModelInfo, getAvailableModels) cannot silently surface stale models
  // in --model flag help text.

  test("getRecommendedModelsSync gates the cached doc on isFreshEnough", () => {
    // Extract the body of getRecommendedModelsSync for targeted assertions.
    const fnStart = MODEL_LOADER_SOURCE.indexOf(
      "export function getRecommendedModelsSync"
    );
    expect(fnStart).toBeGreaterThan(-1);

    // The next top-level export marks the end of this function's body.
    const fnEnd = MODEL_LOADER_SOURCE.indexOf("\nexport ", fnStart + 1);
    const fnBody = MODEL_LOADER_SOURCE.slice(
      fnStart,
      fnEnd === -1 ? undefined : fnEnd
    );

    expect(fnBody).toContain("isFreshEnough(");
  });

  test("isFreshEnough is defined and uses FIREBASE_CACHE_TTL_HOURS", () => {
    expect(MODEL_LOADER_SOURCE).toContain("function isFreshEnough(");
    expect(MODEL_LOADER_SOURCE).toContain("FIREBASE_CACHE_TTL_HOURS");
  });
});
