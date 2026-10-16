import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RECOMMENDATION_SECTIONS,
  type RecommendationCatalogSnapshot,
  type RecommendationSectionDef,
  type RecommendationsWire,
  type RecommendedModelEntry,
  type RecommendedModelsDoc,
  formatListingPrice,
  groupRecommendedModels,
  projectRecommendations,
} from "./model-loader.js";
import { renderRecommendedMarkdown, renderRecommendedText } from "./recommended-listing.js";

type RichModels = NonNullable<Parameters<typeof projectRecommendations>[2]>;
type Snapshot = {
  name: string;
  recommendations: RecommendationsWire;
  catalog: RecommendationCatalogSnapshot;
  richModels: RichModels;
  now: Date;
};

const fixtureDir = join(import.meta.dir, "fixtures", "recommendation-tiers");
const readFixture = <T>(directory: string, filename: string): T =>
  JSON.parse(readFileSync(join(fixtureDir, directory, filename), "utf-8")) as T;
const liveSlim = readFixture<{
  generationId: string;
  models: RecommendationCatalogSnapshot["entries"];
}>("live", "slim.json");
const live: Snapshot = {
  name: "live",
  recommendations: readFixture<{ data: { recommendations: RecommendationsWire } }>(
    "live",
    "recommended.json"
  ).data.recommendations,
  catalog: {
    catalogGenerationId: liveSlim.generationId,
    entries: liveSlim.models,
    plans: readFixture<{ plans: RecommendationCatalogSnapshot["plans"] }>("live", "plans.json")
      .plans,
  },
  richModels: readFixture<{ models: RichModels }>("live", "top100.json").models,
  now: new Date(readFixture<{ capturedAt: string }>("live", "meta.json").capturedAt),
};
const dryrunModels = readFixture<{
  generationId: string;
  models: RecommendationCatalogSnapshot["entries"];
}>("dryrun-subscription", "models.json");
const dryrun: Snapshot = {
  name: "dryrun-subscription",
  recommendations: readFixture<RecommendationsWire>("dryrun-subscription", "recommendations.json"),
  catalog: {
    catalogGenerationId: dryrunModels.generationId,
    entries: dryrunModels.models,
    plans: readFixture<{ plans: RecommendationCatalogSnapshot["plans"] }>(
      "dryrun-subscription",
      "plans.json"
    ).plans,
  },
  richModels: [],
  now: new Date(
    readFixture<{ generatedAt: string }>("dryrun-subscription", "meta.json").generatedAt
  ),
};

const noNativePrefix = (_vendorSlug: string): string | null => null;
const project = (snapshot: Snapshot) =>
  projectRecommendations(
    snapshot.recommendations,
    snapshot.catalog,
    snapshot.richModels,
    snapshot.now
  );
const textHeading = (section: RecommendationSectionDef) =>
  section.description ? `${section.title} — ${section.description}` : section.title;
const markdownHeading = (section: RecommendationSectionDef) => `## ${section.title}`;

const nonemptyDefinitions = (snapshot: Snapshot) => {
  const ids = new Set(snapshot.catalog.entries.map((model) => model.modelId));
  return RECOMMENDATION_SECTIONS.filter((section) =>
    snapshot.recommendations.entries.some(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        "tier" in entry &&
        "modelId" in entry &&
        entry.tier === section.recommendationTier &&
        typeof entry.modelId === "string" &&
        ids.has(entry.modelId)
    )
  );
};

const sectionLines = (
  output: string,
  tier: string,
  heading: (section: RecommendationSectionDef) => string
) => {
  const def = RECOMMENDATION_SECTIONS.find((section) => section.recommendationTier === tier);
  expect(def).toBeDefined();
  if (!def) throw new Error(`No section definition for ${tier}`);
  const lines = output.split("\n");
  const start = lines.indexOf(heading(def));
  expect(start).toBeGreaterThanOrEqual(0);
  const headings = RECOMMENDATION_SECTIONS.map(heading);
  const end = lines.findIndex((line, index) => index > start && headings.includes(line));
  return lines.slice(start + 1, end === -1 ? lines.length : end);
};

const identifies = (line: string, row: RecommendedModelEntry) =>
  line.includes(row.id) || (row.name.length > 0 && line.includes(row.name));

const textRowLines = (output: string, row: RecommendedModelEntry) => {
  const lines = sectionLines(output, row.recommendationTier, textHeading).filter((line) =>
    identifies(line, row)
  );
  expect(lines.length).toBeGreaterThan(0);
  return lines;
};

// Scope pricing to this row, not another row with the same price or the Quick picks block.
const markdownRowLines = (
  output: string,
  row: RecommendedModelEntry,
  doc: RecommendedModelsDoc
) => {
  const lines = sectionLines(output, row.recommendationTier, markdownHeading);
  const start = lines.findIndex((line) => identifies(line, row));
  expect(start).toBeGreaterThanOrEqual(0);
  const others = doc.models.filter(
    (other) => other.recommendationTier === row.recommendationTier && other.id !== row.id
  );
  const end = lines.findIndex(
    (line, index) => index > start && others.some((other) => identifies(line, other))
  );
  return lines.slice(start, end === -1 ? lines.length : end);
};

const assertPriceOnOwnRows = (
  doc: RecommendedModelsDoc,
  row: RecommendedModelEntry,
  text: string,
  markdown: string
) => {
  const textPrice = formatListingPrice(row, { compact: true });
  const markdownPrice = formatListingPrice(row);
  expect(textRowLines(text, row).some((line) => line.includes(textPrice))).toBe(true);
  const priceLines = markdownRowLines(markdown, row, doc).filter((line) =>
    line.startsWith("- **Pricing**:")
  );
  expect(priceLines).toEqual([
    `- **Pricing**: ${markdownPrice} avg · ${row.context || "N/A"} context`,
  ]);
};

describe("recommended listing renderers", () => {
  for (const snapshot of [live, dryrun]) {
    describe(snapshot.name, () => {
      test("T9/T14a R6/R8/R10 text prints exact nonempty headings and descriptions in table order", () => {
        const doc = project(snapshot);
        const before = structuredClone(doc);
        const output = renderRecommendedText(doc, noNativePrefix);
        const lines = output.split("\n");
        const allHeadings = RECOMMENDATION_SECTIONS.map(textHeading);
        expect(lines.filter((line) => allHeadings.includes(line))).toEqual(
          nonemptyDefinitions(snapshot).map(textHeading)
        );
        for (const def of RECOMMENDATION_SECTIONS.filter(
          (section) => !nonemptyDefinitions(snapshot).includes(section)
        ))
          expect(lines).not.toContain(textHeading(def));
        expect(output).not.toContain("Flagship models");
        expect(output).not.toContain("Fast variants");
        expect(doc).toEqual(before);
      });

      test("T10/T14a R6/R8/R10 markdown prints ordered headings with descriptions on the next nonblank line", () => {
        const doc = project(snapshot);
        const before = structuredClone(doc);
        const output = renderRecommendedMarkdown(doc, noNativePrefix);
        const lines = output.split("\n");
        expect(
          lines.filter(
            (line) =>
              line.startsWith("## ") &&
              RECOMMENDATION_SECTIONS.some((section) => markdownHeading(section) === line)
          )
        ).toEqual(nonemptyDefinitions(snapshot).map(markdownHeading));
        for (const def of nonemptyDefinitions(snapshot)) {
          if ("description" in def) {
            const index = lines.indexOf(markdownHeading(def));
            const nextNonblankLine = lines.slice(index + 1).find((line) => line.trim().length > 0);
            expect(nextNonblankLine).toBe(`_${def.description}_`);
          }
        }
        for (const def of RECOMMENDATION_SECTIONS.filter(
          (section) => !nonemptyDefinitions(snapshot).includes(section)
        ))
          expect(lines).not.toContain(markdownHeading(def));
        expect(output).not.toContain("Flagship models");
        expect(output).not.toContain("Fast variants");
        expect(doc).toEqual(before);
      });
    });
  }

  test("T8 R6 naturally empty cost-efficient and luxury tiers omit groups, titles, and descriptions", () => {
    // The dry-run recording already has these tiers empty; no prohibited array edits are needed.
    const present = nonemptyDefinitions(dryrun);
    const absent = RECOMMENDATION_SECTIONS.filter((section) => !present.includes(section));
    expect(absent.some((section) => section.recommendationTier === "cost_efficient")).toBe(true);
    expect(absent.some((section) => section.recommendationTier === "luxury")).toBe(true);
    const doc = project(dryrun);
    const groups = groupRecommendedModels(doc.models);
    const outputs = [
      renderRecommendedText(doc, noNativePrefix),
      renderRecommendedMarkdown(doc, noNativePrefix),
    ];
    for (const def of absent) {
      expect(groups.some((section) => section.recommendationTier === def.recommendationTier)).toBe(
        false
      );
      for (const output of outputs) {
        expect(output).not.toContain(def.title);
        if ("description" in def) expect(output).not.toContain(def.description);
      }
    }
  });

  test("T11a R8 luxury rows show recorded prices on their own text and markdown rows", () => {
    const doc = project(live);
    const catalogIds = new Set(live.catalog.entries.map((model) => model.modelId));
    const expectedIds = live.recommendations.entries
      .filter(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          "tier" in entry &&
          "modelId" in entry &&
          entry.tier === "luxury" &&
          typeof entry.modelId === "string" &&
          catalogIds.has(entry.modelId)
      )
      .map((entry) => (entry as { modelId: string }).modelId);
    expect(expectedIds.length).toBeGreaterThan(0);
    const rows = doc.models.filter((row) => row.recommendationTier === "luxury");
    expect(rows.map((row) => row.id)).toEqual([...new Set(expectedIds)]);
    const text = renderRecommendedText(doc, noNativePrefix);
    const markdown = renderRecommendedMarkdown(doc, noNativePrefix);
    for (const row of rows) {
      const rich = live.richModels.find((model) => model.modelId === row.id);
      expect(typeof rich?.pricing?.input).toBe("number");
      expect(typeof rich?.pricing?.output).toBe("number");
      expect(formatListingPrice(row, { compact: true })).not.toBe("N/A");
      expect(formatListingPrice(row)).not.toBe("N/A");
      assertPriceOnOwnRows(doc, row, text, markdown);
    }
  });

  test("T11c R8 optional rich metadata absent keeps luxury rows with N/A prices on both surfaces", () => {
    // Exercise the documented optional argument, without changing any recorded backend record.
    const doc = projectRecommendations(live.recommendations, live.catalog, undefined, live.now);
    const baseline = project(live);
    expect(doc.models.map((row) => [row.id, row.recommendationTier, row.priority])).toEqual(
      baseline.models.map((row) => [row.id, row.recommendationTier, row.priority])
    );
    const rows = doc.models.filter((row) => row.recommendationTier === "luxury");
    expect(rows.length).toBeGreaterThan(0);
    const text = renderRecommendedText(doc, noNativePrefix);
    const markdown = renderRecommendedMarkdown(doc, noNativePrefix);
    for (const row of rows) {
      expect(row.pricing).toEqual({ input: "N/A", output: "N/A", average: "N/A" });
      expect(formatListingPrice(row, { compact: true })).toBe("N/A");
      expect(formatListingPrice(row)).toBe("N/A");
      assertPriceOnOwnRows(doc, row, text, markdown);
    }
  });

  test("T11c R8 fault injection: one missing luxury rich record keeps its row with N/A prices", () => {
    const baseline = project(live);
    const seed = baseline.models.find((row) => row.recommendationTier === "luxury");
    expect(seed).toBeDefined();
    if (!seed) throw new Error("T11c requires a recorded luxury row");
    expect(live.richModels.some((model) => model.modelId === seed.id)).toBe(true);
    // Fault injection specified by T11c: remove one luxury id's complete rich record.
    const richModels = live.richModels.filter((model) => model.modelId !== seed.id);
    const doc = projectRecommendations(live.recommendations, live.catalog, richModels, live.now);
    expect(doc.models.map((row) => [row.id, row.recommendationTier, row.priority])).toEqual(
      baseline.models.map((row) => [row.id, row.recommendationTier, row.priority])
    );
    const row = doc.models.find(
      (candidate) => candidate.id === seed.id && candidate.recommendationTier === "luxury"
    );
    expect(row).toBeDefined();
    if (!row) throw new Error("T11c must retain the unpriced luxury row");
    expect(row.pricing.average).toBe("N/A");
    expect(formatListingPrice(row, { compact: true })).toBe("N/A");
    expect(formatListingPrice(row)).toBe("N/A");
    assertPriceOnOwnRows(
      doc,
      row,
      renderRecommendedText(doc, noNativePrefix),
      renderRecommendedMarkdown(doc, noNativePrefix)
    );
    for (const other of doc.models.filter((candidate) => candidate.id !== seed.id)) {
      const previous = baseline.models.find(
        (candidate) =>
          candidate.id === other.id && candidate.recommendationTier === other.recommendationTier
      );
      expect(previous).toBeDefined();
      if (!previous) throw new Error("T11c requires each other row to match its baseline");
      expect(other.pricing).toEqual(previous.pricing);
    }
  });

  test("T14a R7 resolved subscription primaries retain SUB pricing in both renderers", () => {
    const doc = project(dryrun);
    const section = groupRecommendedModels(doc.models).find(
      (item) => item.recommendationTier === "subscription"
    );
    expect(section).toBeDefined();
    if (!section) throw new Error("T14a requires a recorded nonempty subscription section");
    expect(section.groups.length).toBeGreaterThan(0);
    const text = renderRecommendedText(doc, noNativePrefix);
    const markdown = renderRecommendedMarkdown(doc, noNativePrefix);
    for (const group of section.groups) {
      const row = group.primary;
      expect(typeof row.subscription?.command).toBe("string");
      expect(formatListingPrice(row, { compact: true })).toBe("SUB");
      expect(formatListingPrice(row)).toBe(`SUB (${row.subscription?.plan})`);
      assertPriceOnOwnRows(doc, row, text, markdown);
    }
  });

  test("R10 renderers return their output instead of printing it", () => {
    const doc = project(live);
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(typeof renderRecommendedText(doc, noNativePrefix)).toBe("string");
      expect(typeof renderRecommendedMarkdown(doc, noNativePrefix)).toBe("string");
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
