import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EffortRecommendation,
  latestEffortRecommendations,
  writeEffortRecommendations,
} from "./providers/effort-recommendations.js";
import { renderEffortTableMarkdown } from "./recommended-listing.js";

type Efforts = Record<string, Record<string, EffortRecommendation>>;
const capture = JSON.parse(
  readFileSync(
    join(import.meta.dir, "test-fixtures/effort-recommendations/recommended-2.3.0.json"),
    "utf8"
  )
) as { generationId: string; data: { recommendations: { efforts: Efforts } } };
const raw = capture.data.recommendations.efforts;
const models = Object.keys(raw).sort();
const taskTypes = [...new Set(Object.values(raw).flatMap((tasks) => Object.keys(tasks)))].sort();

function tableRows(markdown: string): string[][] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim())
    );
}

describe("renderEffortTableMarkdown with captured recommendations", () => {
  test("includes the heading and every task type as a sorted column", () => {
    const markdown = renderEffortTableMarkdown(raw);
    expect(markdown).toContain("## Recommended effort by task type");
    expect(taskTypes.length).toBeGreaterThan(0);
    expect(tableRows(markdown)[0]).toEqual(["model", ...taskTypes]);
  });

  test("renders exactly one sorted row per canonical model id and every captured effort", () => {
    // Reverse both dimensions so insertion order cannot satisfy the sorting assertions.
    const reversed = Object.fromEntries(
      [...models]
        .reverse()
        .map((model) => [
          model,
          Object.fromEntries(Object.entries(raw[model]).sort(([a], [b]) => b.localeCompare(a))),
        ])
    );
    const rows = tableRows(renderEffortTableMarkdown(reversed));
    expect(rows[0]).toEqual(["model", ...taskTypes]);
    expect(rows.slice(2).map(([model]) => model)).toEqual(models);
    expect(rows).toHaveLength(models.length + 2);
    for (const [index, model] of models.entries()) {
      expect(rows[index + 2]).toEqual([
        model,
        ...taskTypes.map((task) => raw[model][task]?.effort ?? "-"),
      ]);
    }
  });

  test("renders a missing cell as a dash without dropping its row or column", () => {
    const sparse = structuredClone(raw);
    const model = models[0];
    const task = Object.keys(sparse[model]).sort()[0];
    // Negative variant of the real capture: remove one cell, invent no replacements.
    expect(sparse[model][task]).toBeDefined();
    delete sparse[model][task];
    const rows = tableRows(renderEffortTableMarkdown(sparse));
    const column = rows[0].indexOf(task);
    expect(column).toBeGreaterThan(0);
    expect(rows.slice(2).map(([id]) => id)).toEqual(models);
    expect(rows[models.indexOf(model) + 2][column]).toBe("-");
    for (const [index, id] of models.entries()) {
      expect(rows[index + 2]).toEqual([
        id,
        ...taskTypes.map((type) =>
          id === model && type === task ? "-" : (raw[id][type]?.effort ?? "-")
        ),
      ]);
    }
  });

  test("returns an empty string for no recommendations", () => {
    expect(renderEffortTableMarkdown({})).toBe("");
  });
});

const dirs: string[] = [];
function sidecarPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "latest-effort-test-"));
  dirs.push(dir);
  return join(dir, "catalog.efforts.json");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function expectedCells(efforts: Efforts): Efforts {
  return Object.fromEntries(
    Object.entries(efforts).map(([model, tasks]) => [
      model,
      Object.fromEntries(
        Object.entries(tasks).map(([task, cell]) => [
          task,
          { effort: cell.effort, basis: cell.basis, sendableOn: cell.sendableOn },
        ])
      ),
    ])
  );
}

describe("latestEffortRecommendations with a test-owned sidecar", () => {
  test("returns null when the sidecar does not exist", () => {
    expect(latestEffortRecommendations(sidecarPath())).toBeNull();
  });

  test("returns the newest written generation and its data after an earlier read", () => {
    const path = sidecarPath();
    const firstId = `${capture.generationId}-z`;
    const secondId = `${capture.generationId}-a`;
    const subset = { [models[0]]: raw[models[0]] };
    const clock = spyOn(Date, "now");
    try {
      clock.mockReturnValue(1000);
      writeEffortRecommendations(firstId, subset, path);
      expect(latestEffortRecommendations(path)).toEqual({
        generationId: firstId,
        efforts: expectedCells(subset),
      });
      clock.mockReturnValue(2000);
      writeEffortRecommendations(secondId, raw, path);
    } finally {
      clock.mockRestore();
    }
    expect(latestEffortRecommendations(path)).toEqual({
      generationId: secondId,
      efforts: expectedCells(raw),
    });
  });

  test("selects by writtenAt rather than generation id or insertion order", () => {
    const path = sidecarPath();
    const newestId = `${capture.generationId}-a`;
    const olderId = `${capture.generationId}-z`;
    const subset = { [models[0]]: raw[models[0]] };
    const clock = spyOn(Date, "now");
    try {
      clock.mockReturnValue(2000);
      writeEffortRecommendations(newestId, raw, path);
      clock.mockReturnValue(1000);
      writeEffortRecommendations(olderId, subset, path);
    } finally {
      clock.mockRestore();
    }
    expect(latestEffortRecommendations(path)).toEqual({
      generationId: newestId,
      efforts: expectedCells(raw),
    });
  });
});
