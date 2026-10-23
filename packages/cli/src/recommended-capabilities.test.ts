import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type RecommendationCatalogSnapshot,
  type RecommendationsWire,
  projectRecommendations,
} from "./model-loader.js";
import { renderRecommendedMarkdown } from "./recommended-listing.js";

type RichModels = NonNullable<Parameters<typeof projectRecommendations>[2]>;
type SlimEntry = RecommendationCatalogSnapshot["entries"][number];

const fixtureDir = join(import.meta.dir, "fixtures", "recommendation-tiers", "live");
const readFixture = <T>(filename: string): T =>
  JSON.parse(readFileSync(join(fixtureDir, filename), "utf-8")) as T;

const slim = readFixture<{
  generationId: string;
  models: RecommendationCatalogSnapshot["entries"];
}>("slim.json");
const plans = readFixture<{
  generationId: string;
  plans: RecommendationCatalogSnapshot["plans"];
}>("plans.json");
const top100 = readFixture<{ generationId: string; models: RichModels }>("top100.json");
const meta = readFixture<{ generationId: string; capturedAt: string }>("meta.json");
const recommendations = readFixture<{
  data: { recommendations: RecommendationsWire };
}>("recommended.json").data.recommendations;
const catalog: RecommendationCatalogSnapshot = {
  catalogGenerationId: slim.generationId,
  entries: slim.models,
  plans: plans.plans,
};
const now = new Date(meta.capturedAt);
const project = (snapshot = catalog) =>
  projectRecommendations(recommendations, snapshot, top100.models, now);
const capabilityLines = (markdown: string) =>
  markdown.split("\n").filter((line) => line.startsWith("- **Capabilities**:"));
const expectedCapabilityLine = (entry: SlimEntry) => {
  const flags = [
    entry.supportsTools === true && "tools",
    entry.reasoning?.supported === true && "reasoning",
    entry.supportsVision === true && "vision",
  ].filter(Boolean);
  return `- **Capabilities**: ${flags.length > 0 ? flags.join(", ") : "none"}`;
};

const withoutCapabilities = () => {
  const baseline = project();
  const first = baseline.models[0];
  if (!first) throw new Error("Recorded recommendations must project at least one model");
  const copy = structuredClone(catalog);
  const entry = copy.entries.find((model) => model.modelId === first.id);
  if (!entry) throw new Error(`Recorded slim data must contain ${first.id}`);
  delete entry.supportsTools;
  delete entry.supportsVision;
  if (entry.reasoning) Reflect.deleteProperty(entry.reasoning, "supported");
  return { baseline, modelId: first.id, doc: project(copy) };
};

describe("recommended model capabilities", () => {
  test("projects every capability from the recorded slim entry without defaulting missing fields", () => {
    const doc = project();
    const byId = new Map(slim.models.map((entry) => [entry.modelId, entry]));
    let checked = 0;
    for (const row of doc.models) {
      const entry = byId.get(row.id);
      expect(entry).toBeDefined();
      if (!entry) throw new Error(`Recorded slim data must contain ${row.id}`);
      const expected = {
        supportsTools: entry.supportsTools,
        supportsReasoning: entry.reasoning?.supported,
        supportsVision: entry.supportsVision,
      };
      for (const key of ["supportsTools", "supportsReasoning", "supportsVision"] as const) {
        expect(row[key]).toBe(expected[key]);
        if (expected[key] === undefined) expect(key in row).toBe(false);
      }
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(20);
  });

  test("omits deleted capabilities for one model and leaves every other row unchanged", () => {
    const { baseline, modelId, doc } = withoutCapabilities();
    const affected = doc.models.filter((row) => row.id === modelId);
    expect(affected.length).toBeGreaterThan(0);
    expect(affected).toHaveLength(baseline.models.filter((row) => row.id === modelId).length);
    expect(doc.models).toHaveLength(baseline.models.length);
    for (const row of affected) {
      expect("supportsTools" in row).toBe(false);
      expect("supportsReasoning" in row).toBe(false);
      expect("supportsVision" in row).toBe(false);
    }
    const unaffected = doc.models.filter((row) => row.id !== modelId);
    expect(unaffected.length).toBeGreaterThan(0);
    expect(unaffected).toEqual(baseline.models.filter((row) => row.id !== modelId));
  });

  test("renders one nonempty capabilities line per recorded row with flags in contract order", () => {
    const doc = project();
    const lines = capabilityLines(renderRecommendedMarkdown(doc));
    expect(doc.models.length).toBeGreaterThanOrEqual(20);
    expect(lines).toHaveLength(doc.models.length);
    expect(lines).not.toContain("- **Capabilities**: none");
    const expected = doc.models.map((row) => {
      const entry = slim.models.find((model) => model.modelId === row.id);
      if (!entry) throw new Error(`Recorded slim data must contain ${row.id}`);
      expect(entry.supportsTools).toBe(true);
      return expectedCapabilityLine(entry);
    });
    expect(lines.toSorted()).toEqual(expected.toSorted());
  });

  test("renders none for the model whose slim capabilities were deleted", () => {
    const { modelId, doc } = withoutCapabilities();
    const affected = doc.models.filter((row) => row.id === modelId);
    expect(affected.length).toBeGreaterThan(0);
    const lines = capabilityLines(renderRecommendedMarkdown(doc));
    expect(lines).toHaveLength(doc.models.length);
    expect(lines.filter((line) => line === "- **Capabilities**: none")).toHaveLength(
      affected.length
    );
    // Render only the affected projected rows to verify which model owns the none lines.
    const modelLines = capabilityLines(renderRecommendedMarkdown({ ...doc, models: affected }));
    expect(modelLines).toHaveLength(affected.length);
    for (const line of modelLines) expect(line).toBe("- **Capabilities**: none");
  });
});
