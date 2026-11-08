import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effortRecommendationsPathFor,
  lookupModelEfforts,
  parseEffortRecommendations,
  readEffortRecommendations,
  writeEffortRecommendations,
} from "./effort-recommendations.js";

const capturePath = join(
  import.meta.dir,
  "../test-fixtures/effort-recommendations/recommended-2.3.0.json"
);
function captured() {
  return JSON.parse(readFileSync(capturePath, "utf8")) as {
    generationId: string;
    data: {
      recommendations: {
        efforts: Record<
          string,
          Record<
            string,
            {
              effort: string;
              basis: string;
              sendableOn: Array<{
                routeId: string;
                routeProfileId: string;
                externalModelId: string;
                encoding?: string;
              }>;
              [key: string]: unknown;
            }
          >
        >;
      };
    };
  };
}
const dirs: string[] = [];
function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), "effort-sidecar-blackbox-"));
  dirs.push(dir);
  return join(dir, "catalog.efforts.json");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// These are projections of captured public cells, not implementation-produced expectations.
function expectedCells(raw: ReturnType<typeof captured>["data"]["recommendations"]["efforts"]) {
  return Object.fromEntries(
    Object.entries(raw).map(([model, tasks]) => [
      model,
      Object.fromEntries(
        Object.entries(tasks).map(([task, cell]) => [
          task,
          {
            effort: cell.effort,
            basis: cell.basis,
            sendableOn: cell.sendableOn,
          },
        ])
      ),
    ])
  );
}

describe("efforts sidecar public contract", () => {
  test("TEST-1 REQ-1 keeps all 180 captured cells and only their supported fields", () => {
    const raw = captured().data.recommendations.efforts;
    expect(Object.keys(raw)).toHaveLength(18);
    expect(Object.values(raw).reduce((n, tasks) => n + Object.keys(tasks).length, 0)).toBe(180);
    expect(parseEffortRecommendations(raw)).toEqual(expectedCells(raw));
  });

  test("TEST-2 REQ-1 tolerates a future task, basis and cell field", () => {
    const raw = captured().data.recommendations.efforts;
    // Derived from the real qwen cell: add one future task and log-only metadata.
    const cell = { ...raw["qwen3.8-max"].long_context, basis: "future_basis", futureField: true };
    raw["qwen3.8-max"].future_task = cell;
    expect(parseEffortRecommendations(raw)["qwen3.8-max"].future_task).toEqual({
      effort: cell.effort,
      basis: "future_basis",
      sendableOn: cell.sendableOn,
    });
  });

  test.each(
    [undefined, null, [], {}, [{ routeId: "fireworks" }]].map((sendableOn) => ({ sendableOn }))
  )("TEST-3 REQ-1 REQ-4 skips a cell with malformed sendableOn %j", ({ sendableOn }) => {
    const raw = captured().data.recommendations.efforts;
    // Negative variant changes only the captured cell's sendableOn field.
    const cell = { ...raw["qwen3.8-max"].long_context, sendableOn };
    const parsed = parseEffortRecommendations({
      "qwen3.8-max": {
        long_context: cell,
        planning: raw["qwen3.8-max"].planning,
      },
    });
    expect(parsed["qwen3.8-max"]).not.toHaveProperty("long_context");
    expect(parsed["qwen3.8-max"].planning.effort).toBe(raw["qwen3.8-max"].planning.effort);
    expect(parseEffortRecommendations({ "qwen3.8-max": { long_context: cell } })).toEqual({});
  });

  test.each([undefined, null, "", 42, [], {}].map((effort) => ({ effort })))(
    "TEST-3 REQ-1 skips a captured cell with malformed effort %j",
    ({ effort }) => {
      const cell = captured().data.recommendations.efforts["qwen3.8-max"].long_context;
      expect(
        parseEffortRecommendations({
          "qwen3.8-max": {
            long_context: { ...cell, effort },
          },
        })
      ).toEqual({});
    }
  );

  test("TEST-3 REQ-1 retains valid sendability elements among malformed siblings", () => {
    const cell = captured().data.recommendations.efforts["qwen3.8-max"].long_context;
    // Negative variant inserts malformed elements around the original entries.
    expect(
      parseEffortRecommendations({
        "qwen3.8-max": {
          long_context: { ...cell, sendableOn: [null, {}, ...cell.sendableOn, "bad"] },
        },
      })["qwen3.8-max"].long_context.sendableOn
    ).toEqual(cell.sendableOn);
  });

  test.each([undefined, null, [], "not an object", 1, true].map((raw) => ({ raw })))(
    "TEST-4 REQ-2 records absent or non-object efforts %j as an empty generation",
    ({ raw }) => {
      const path = tempPath();
      const { generationId } = captured();
      expect(parseEffortRecommendations(raw)).toEqual({});
      writeEffortRecommendations(generationId, raw, path);
      const stored = readEffortRecommendations(path);
      expect(stored).toMatchObject({ contractVersion: 3, format: 2 });
      expect(stored?.generations[generationId].efforts).toEqual({});
    }
  );

  test("TEST-4 REQ-2 missing and malformed sidecars return null", () => {
    const path = tempPath();
    expect(readEffortRecommendations(path)).toBeNull();
    expect(lookupModelEfforts("qwen3.8-max", captured().generationId, path)).toMatchObject({
      ok: false,
      reason: "no-sidecar",
    });
    writeFileSync(path, "{broken JSON");
    expect(readEffortRecommendations(path)).toBeNull();
  });

  test("TEST-5 REQ-3 derives a sidecar path without using the real home", () => {
    const dir = mkdtempSync(join(tmpdir(), "effort-path-blackbox-"));
    dirs.push(dir);
    expect(effortRecommendationsPathFor(join(dir, "catalog.json"))).toBe(
      join(dir, "catalog.efforts.json")
    );
  });

  test("TEST-5 REQ-3 round trips only the exact canonical id and generation", () => {
    const path = tempPath();
    const { generationId, data } = captured();
    writeEffortRecommendations(generationId, data.recommendations.efforts, path);
    expect(lookupModelEfforts("qwen3.8-max", generationId, path)).toEqual({
      ok: true,
      byTaskType: expectedCells(data.recommendations.efforts)["qwen3.8-max"],
    });
    expect(lookupModelEfforts("qwen3.8-max", `${generationId}-missing`, path)).toMatchObject({
      ok: false,
      reason: "generation",
    });
    const wireId =
      data.recommendations.efforts["qwen3.8-max"].long_context.sendableOn[0].externalModelId;
    expect(wireId).not.toBe("qwen3.8-max");
    for (const id of [wireId, "qwen3.8-max-unpublished-variant"]) {
      expect(lookupModelEfforts(id, generationId, path)).toMatchObject({
        ok: false,
        reason: "model",
      });
    }
    expect(lookupModelEfforts("qwen3.8-max", "declared", path)).toMatchObject({
      ok: false,
      reason: "declared",
    });
  });

  test("TEST-6 REQ-3 keeps four newest generations and evicts the oldest", () => {
    const path = tempPath();
    const { generationId, data } = captured();
    const generations = Array.from({ length: 5 }, (_, index) => `${generationId}-test-${index}`);
    // Generation ids and timestamps are labelled variants, not a manufactured catalog.
    // Explicit timestamps avoid relying on multiple writes landing in different milliseconds.
    for (let index = 0; index < 4; index++) {
      writeEffortRecommendations(generations[index], data.recommendations.efforts, path);
      const stored = JSON.parse(readFileSync(path, "utf8"));
      stored.generations[generations[index]].writtenAt = index + 1;
      writeFileSync(path, JSON.stringify(stored));
      utimesSync(path, new Date(1000 * (index + 1)), new Date(1000 * (index + 1)));
    }
    writeEffortRecommendations(generations[4], data.recommendations.efforts, path);
    const stored = readEffortRecommendations(path);
    expect(Object.keys(stored?.generations ?? {}).sort()).toEqual(generations.slice(1).sort());
    expect(lookupModelEfforts("qwen3.8-max", generations[0], path)).toMatchObject({
      ok: false,
      reason: "generation",
    });
    for (const generation of generations.slice(1)) {
      expect(lookupModelEfforts("qwen3.8-max", generation, path).ok).toBe(true);
    }
  });

  test("TEST-6 REQ-3 replaces a generation and invalidates an already read value", () => {
    const path = tempPath();
    const { generationId, data } = captured();
    writeEffortRecommendations(generationId, data.recommendations.efforts, path);
    expect(lookupModelEfforts("qwen3.8-max", generationId, path).ok).toBe(true);
    writeEffortRecommendations(generationId, undefined, path);
    expect(readEffortRecommendations(path)?.generations[generationId].efforts).toEqual({});
    expect(lookupModelEfforts("qwen3.8-max", generationId, path)).toMatchObject({
      ok: false,
      reason: "model",
    });
  });
});
