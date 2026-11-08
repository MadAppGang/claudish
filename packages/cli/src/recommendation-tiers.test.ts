import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  RECOMMENDATION_SECTIONS,
  RECOMMENDED_MODELS_CACHE_PATH,
  type RecommendationCatalogSnapshot,
  type RecommendationTier,
  type RecommendationWireEntry,
  type RecommendationsWire,
  type RecommendedModelEntry,
  type RecommendedModelsDoc,
  collectRoutingPrefixes,
  computeQuickPicks,
  groupRecommendedModels,
  projectRecommendations,
  quickPickCandidates,
  readProjectedRecommendationsDoc,
  uniqueRecommendedModels,
} from "./model-loader.js";
import { _recommendedFallbackRows } from "./model-selector.js";

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
const livePlans = readFixture<{
  generationId: string;
  plans: RecommendationCatalogSnapshot["plans"];
}>("live", "plans.json");
const liveTop100 = readFixture<{ generationId: string; models: RichModels }>("live", "top100.json");
const liveMeta = readFixture<{ generationId: string; capturedAt: string }>("live", "meta.json");
const live: Snapshot = {
  name: "live",
  recommendations: readFixture<{ data: { recommendations: RecommendationsWire } }>(
    "live",
    "recommended.json"
  ).data.recommendations,
  catalog: {
    catalogGenerationId: liveSlim.generationId,
    entries: liveSlim.models,
    plans: livePlans.plans,
  },
  richModels: liveTop100.models,
  now: new Date(liveMeta.capturedAt),
};

const dryrunModels = readFixture<{
  generationId: string;
  models: RecommendationCatalogSnapshot["entries"];
}>("dryrun-subscription", "models.json");
const dryrunPlans = readFixture<{
  generationId: string;
  plans: RecommendationCatalogSnapshot["plans"];
}>("dryrun-subscription", "plans.json");
const dryrunMeta = readFixture<{ generationId: string; generatedAt: string }>(
  "dryrun-subscription",
  "meta.json"
);
const dryrun: Snapshot = {
  name: "dryrun-subscription",
  recommendations: readFixture<RecommendationsWire>("dryrun-subscription", "recommendations.json"),
  catalog: {
    catalogGenerationId: dryrunModels.generationId,
    entries: dryrunModels.models,
    plans: dryrunPlans.plans,
  },
  richModels: [],
  now: new Date(dryrunMeta.generatedAt),
};

const isWireEntry = (value: unknown): value is RecommendationWireEntry =>
  value !== null &&
  typeof value === "object" &&
  "modelId" in value &&
  typeof value.modelId === "string" &&
  "tier" in value &&
  typeof value.tier === "string";

type KnownRecommendationWireEntry = RecommendationWireEntry & { tier: RecommendationTier };
const isRecommendationTier = (tier: string): tier is RecommendationTier =>
  RECOMMENDATION_SECTIONS.some((section) => section.recommendationTier === tier);

// Independent oracle: use only the table and recorded input, never the projected output.
const expectedEntries = (snapshot: Snapshot): KnownRecommendationWireEntry[] => {
  const catalogIds = new Set(snapshot.catalog.entries.map((model) => model.modelId));
  const seen = new Set<string>();
  return snapshot.recommendations.entries.filter((value): value is KnownRecommendationWireEntry => {
    if (!isWireEntry(value) || !isRecommendationTier(value.tier) || !catalogIds.has(value.modelId))
      return false;
    const key = JSON.stringify(
      value.tier === "subscription"
        ? [
            value.tier,
            value.modelId,
            value.route?.routeId,
            value.route?.routeProfileId,
            value.planId,
          ]
        : [value.tier, value.modelId]
    );
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const expectedRows = (snapshot: Snapshot) => {
  const priorities = new Map<string, number>();
  return expectedEntries(snapshot).map((entry) => {
    const priority = (priorities.get(entry.tier) ?? 0) + 1;
    priorities.set(entry.tier, priority);
    return { id: entry.modelId, recommendationTier: entry.tier, priority };
  });
};

const rowIdentity = (row: RecommendedModelEntry) => ({
  id: row.id,
  recommendationTier: row.recommendationTier,
  priority: row.priority,
});
const project = (snapshot: Snapshot) =>
  projectRecommendations(
    snapshot.recommendations,
    snapshot.catalog,
    snapshot.richModels,
    snapshot.now
  );
const noNativePrefix = (_vendorSlug: string): string | null => null;

const expectedUniqueRows = (snapshot: Snapshot) => {
  const rows = expectedRows(snapshot);
  const inSectionOrder = RECOMMENDATION_SECTIONS.flatMap((section) =>
    rows.filter((row) => row.recommendationTier === section.recommendationTier)
  );
  const seen = new Set<string>();
  return inSectionOrder.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
};

type MutableProjectedCache = {
  models: Record<string, unknown>[];
  recommendationTiers?: string[];
};
const liveProjectedCache = () => {
  const expected = JSON.parse(JSON.stringify(project(live))) as RecommendedModelsDoc;
  const value = structuredClone(expected) as unknown as MutableProjectedCache;
  return { expected, value };
};
const withoutCacheField = (value: object, field: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
const readCacheWithoutMutation = (value: unknown) => {
  const before = structuredClone(value);
  const result = readProjectedRecommendationsDoc(value);
  expect(value).toEqual(before);
  return result;
};

const recordedAverage = (row: RecommendedModelEntry): number | undefined => {
  const rich = live.richModels.find((model) => model.modelId === row.id);
  const input = rich?.pricing?.input;
  const output = rich?.pricing?.output;
  return typeof input === "number" && typeof output === "number" ? (input + output) / 2 : undefined;
};

describe("recommendation tier contract", () => {
  test("T15 R1/R8/R9 pins section titles, order, descriptions, and quick-pick eligibility", () => {
    expect(RECOMMENDATION_SECTIONS).toEqual([
      { recommendationTier: "flagship", title: "Flagship", quickPickEligible: true },
      {
        recommendationTier: "cost_efficient",
        title: "Cost-efficient",
        description: "Best value: strong models at a much lower cost per task",
        quickPickEligible: true,
      },
      { recommendationTier: "lightweight", title: "Lightweight", quickPickEligible: true },
      {
        recommendationTier: "luxury",
        title: "Luxury",
        description: "Most capable, most expensive. Use for the hardest tasks",
        quickPickEligible: false,
      },
      { recommendationTier: "subscription", title: "Subscription", quickPickEligible: true },
    ]);
  });

  for (const snapshot of [live, dryrun]) {
    describe(snapshot.name, () => {
      test("T1 R1/R7/R10 preserves wire tiers without category or subscription fields on other tiers", () => {
        const doc = project(snapshot);
        expect(
          doc.models.map(({ id, recommendationTier }) => ({ id, recommendationTier }))
        ).toEqual(
          expectedRows(snapshot).map(({ id, recommendationTier }) => ({ id, recommendationTier }))
        );
        expect(doc.recommendationTiers).toEqual(
          RECOMMENDATION_SECTIONS.map((section) => section.recommendationTier)
        );
        for (const row of doc.models) {
          expect("category" in row).toBe(false);
          if (row.recommendationTier !== "subscription") {
            expect("subscription" in row).toBe(false);
            expect("subscriptions" in row).toBe(false);
          }
        }
      });

      test("T2 R3/R4/R5 preserves API order and assigns priority independently within each tier", () => {
        expect(project(snapshot).models.map(rowIdentity)).toEqual(expectedRows(snapshot));
      });

      test("R10 stamps projected JSON metadata from the recorded generation and injected clock", () => {
        const doc = project(snapshot);
        expect(snapshot.catalog.catalogGenerationId).toBe(snapshot.recommendations.generationId);
        expect(doc.contractVersion).toBe(3);
        expect(doc.generationId).toBe(snapshot.recommendations.generationId);
        expect(doc.version).toBe(snapshot.recommendations.generationId);
        expect(doc.lastUpdated).toBe(snapshot.now.toISOString());
        expect(doc.generatedAt).toBe(snapshot.now.toISOString());
        expect("source" in doc).toBe(false);
      });

      test("R8/R10 derives prices from recorded rich metadata and leaves missing prices unavailable", () => {
        const doc = project(snapshot);
        for (const row of doc.models) {
          const rich = snapshot.richModels.find((model) => model.modelId === row.id);
          const input = rich?.pricing?.input;
          const output = rich?.pricing?.output;
          expect(row.pricing).toEqual({
            input: typeof input === "number" ? `$${input}/1M` : "N/A",
            output: typeof output === "number" ? `$${output}/1M` : "N/A",
            average:
              typeof input === "number" && typeof output === "number"
                ? `$${((input + output) / 2).toFixed(2)}/1M`
                : "N/A",
          });
        }
      });

      test("T7 R3/R6/R8 groups in table order, omits empty tiers, and leaves rows unchanged", () => {
        const doc = project(snapshot);
        const before = structuredClone(doc.models);
        const expected = expectedRows(snapshot);
        const sections = groupRecommendedModels(doc.models);
        expect(sections.map((section) => section.recommendationTier)).toEqual(
          RECOMMENDATION_SECTIONS.filter((section) =>
            expected.some((row) => row.recommendationTier === section.recommendationTier)
          ).map((section) => section.recommendationTier)
        );
        for (const section of sections) {
          const def = RECOMMENDATION_SECTIONS.find(
            (candidate) => candidate.recommendationTier === section.recommendationTier
          );
          expect(def).toBeDefined();
          if (!def) throw new Error("T7 requires a definition for every grouped section");
          expect(section.title).toBe(def.title);
          expect(section.description).toBe(
            def && "description" in def ? def.description : undefined
          );
          expect(section.groups.length).toBeGreaterThan(0);
          const tierRows = expected.filter(
            (row) => row.recommendationTier === section.recommendationTier
          );
          expect(section.groups.map((group) => group.id)).toEqual([
            ...new Set(tierRows.map((row) => row.id)),
          ]);
          for (const group of section.groups) {
            expect("bucket" in group).toBe(false);
            const expectedPrimary = doc.models.find(
              (row) => row.id === group.id && row.recommendationTier === section.recommendationTier
            );
            expect(expectedPrimary).toBeDefined();
            if (!expectedPrimary) throw new Error("T7 requires a primary row for every group");
            expect(group.primary).toEqual(expectedPrimary);
            expect(group.subscriptions).toEqual(
              doc.models.filter(
                (row) => row.id === group.id && row.recommendationTier === "subscription"
              )
            );
          }
        }
        expect(doc.models).toEqual(before);
      });

      test("T18(a,k) R10 accepts a JSON-round-tripped projection as a new doc without mutating input", () => {
        const value = JSON.parse(JSON.stringify(project(snapshot)));
        const before = structuredClone(value);
        const result = readProjectedRecommendationsDoc(value);
        expect(result).toEqual(before);
        expect(result).not.toBeNull();
        expect(result).not.toBe(value);
        expect(value).toEqual(before);
      });
    });
  }

  test("R10 fixture generations agree across each recorded input set", () => {
    expect(liveSlim.generationId).toBe(liveMeta.generationId);
    expect(livePlans.generationId).toBe(liveMeta.generationId);
    expect(liveTop100.generationId).toBe(liveMeta.generationId);
    expect(dryrunModels.generationId).toBe(dryrunMeta.generationId);
    expect(dryrunPlans.generationId).toBe(dryrunMeta.generationId);
  });

  test("T3 R2 fault injection: one unknown-tier entry is skipped silently without changing rows", () => {
    const recorded = live.recommendations.entries.filter(isWireEntry);
    const first = recorded[0];
    expect(first).toBeDefined();
    const firstTiers = new Set(
      recorded.filter((entry) => entry.modelId === first.modelId).map((entry) => entry.tier)
    );
    const second = recorded.find(
      (entry) =>
        !recorded.some((other) => other.modelId === entry.modelId && firstTiers.has(other.tier))
    );
    expect(second).toBeDefined();
    if (!second) throw new Error("T3 requires recorded ids with disjoint tier memberships");
    const baseline = project(live);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      // Each independent call appends exactly ONE permitted unknown-tier entry.
      for (const seed of [first, second]) {
        const recommendations = structuredClone(live.recommendations);
        recommendations.entries.push({ modelId: seed.modelId, tier: "experimental" });
        const inputBefore = structuredClone(recommendations);
        expect(() =>
          projectRecommendations(recommendations, live.catalog, live.richModels, live.now)
        ).not.toThrow();
        expect(
          projectRecommendations(recommendations, live.catalog, live.richModels, live.now).models
        ).toEqual(baseline.models);
        expect(recommendations).toEqual(inputBefore);
      }
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
      log.mockRestore();
    }
  });

  test("T3 R2 fault injection: null and an entry without modelId are skipped without changing rows", () => {
    const baseline = project(live);
    const recommendations = structuredClone(live.recommendations);
    // Fault injection specified by T3, not recorded backend records.
    recommendations.entries.push(null, { tier: "flagship" });
    const before = structuredClone(recommendations);
    expect(() =>
      projectRecommendations(recommendations, live.catalog, live.richModels, live.now)
    ).not.toThrow();
    expect(
      projectRecommendations(recommendations, live.catalog, live.richModels, live.now).models
    ).toEqual(baseline.models);
    expect(recommendations).toEqual(before);
  });

  test("T4 R5 fault injection: one unknown modelId is skipped without changing other rows or priorities", () => {
    const modelId = "no-such-model-in-catalog";
    expect(live.catalog.entries.some((model) => model.modelId === modelId)).toBe(false);
    const baseline = project(live);
    const recommendations = structuredClone(live.recommendations);
    recommendations.entries.push({ modelId, tier: "flagship" });
    expect(() =>
      projectRecommendations(recommendations, live.catalog, live.richModels, live.now)
    ).not.toThrow();
    const doc = projectRecommendations(recommendations, live.catalog, live.richModels, live.now);
    expect(doc.models.some((row) => row.id === modelId)).toBe(false);
    expect(doc.models).toEqual(baseline.models);
  });

  test("T2 R5 skips the recorded recommendation absent from the same-generation slim catalog", () => {
    const catalogIds = new Set(live.catalog.entries.map((model) => model.modelId));
    const absent = live.recommendations.entries
      .filter(isWireEntry)
      .filter((entry) => !catalogIds.has(entry.modelId));
    expect(absent.length).toBeGreaterThan(0);
    const rows = project(live).models;
    for (const entry of absent) expect(rows.some((row) => row.id === entry.modelId)).toBe(false);
  });

  test("T5 R4 fault injection: a duplicate recorded entry produces one row within its tier", () => {
    const seed = expectedEntries(live).find((entry) => entry.tier !== "subscription");
    expect(seed).toBeDefined();
    if (!seed) throw new Error("T5 requires a recorded non-subscription entry in the catalog");
    const baseline = project(live);
    const recommendations = structuredClone(live.recommendations);
    // Fault injection: duplicate one entire recorded entry, without editing its fields.
    recommendations.entries.push(structuredClone(seed));
    const doc = projectRecommendations(recommendations, live.catalog, live.richModels, live.now);
    expect(doc.models).toEqual(baseline.models);
    expect(
      doc.models.filter((row) => row.id === seed.modelId && row.recommendationTier === seed.tier)
    ).toHaveLength(1);
  });

  test("T6 R4 preserves every recorded cross-tier model in each of its sections", () => {
    const expected = expectedRows(live);
    const tiersById = new Map<string, Set<RecommendationTier>>();
    for (const row of expected) {
      const tiers = tiersById.get(row.id) ?? new Set<RecommendationTier>();
      tiers.add(row.recommendationTier);
      tiersById.set(row.id, tiers);
    }
    const crossTier = [...tiersById].filter(([, tiers]) => tiers.size > 1);
    expect(crossTier.length).toBeGreaterThan(0);
    const doc = project(live);
    const sections = groupRecommendedModels(doc.models);
    for (const [id, tiers] of crossTier) {
      const orderedTiers = RECOMMENDATION_SECTIONS.filter((section) =>
        tiers.has(section.recommendationTier)
      ).map((section) => section.recommendationTier);
      expect(doc.models.filter((row) => row.id === id)).toHaveLength(tiers.size);
      expect(
        new Set(doc.models.filter((row) => row.id === id).map((row) => row.recommendationTier))
      ).toEqual(tiers);
      expect(
        sections
          .filter((section) => section.groups.some((group) => group.id === id))
          .map((section) => section.recommendationTier)
      ).toEqual(orderedTiers);
    }
  });

  test("T13 R9 excludes luxury ids and preserves eligible section, priority, and first-occurrence order", () => {
    const doc = project(live);
    const sections = groupRecommendedModels(doc.models);
    const before = structuredClone(sections);
    const excludedTiers = new Set<string>(
      RECOMMENDATION_SECTIONS.filter((section) => !section.quickPickEligible).map(
        (section) => section.recommendationTier
      )
    );
    const excludedIds = new Set(
      expectedRows(live)
        .filter((row) => excludedTiers.has(row.recommendationTier))
        .map((row) => row.id)
    );
    expect(excludedIds.size).toBeGreaterThan(0);
    const seen = new Set<string>();
    const expected = expectedUniqueRows(live).filter((row) => {
      if (excludedTiers.has(row.recommendationTier) || excludedIds.has(row.id) || seen.has(row.id))
        return false;
      seen.add(row.id);
      return true;
    });
    const candidates = quickPickCandidates(sections);
    expect(candidates.map(rowIdentity)).toEqual(expected);
    expect(sections).toEqual(before);
    const picks = computeQuickPicks(candidates);
    for (const row of candidates) expect(excludedIds.has(row.id)).toBe(false);
    for (const pick of Object.values(picks)) {
      if (pick) {
        expect(excludedIds.has(pick.id)).toBe(false);
        expect(candidates.some((candidate) => candidate.id === pick.id)).toBe(true);
      }
    }
    const priced = candidates.filter((row) => (recordedAverage(row) ?? 0) > 0);
    expect(priced.length).toBeGreaterThan(0);
    const minimum = Math.min(...priced.map((row) => recordedAverage(row) as number));
    expect(picks.budget?.id).toBe(priced.find((row) => recordedAverage(row) === minimum)?.id);
  });

  test("T13 R9 budget ties prefer the first candidate using only recorded equal-price rows", () => {
    const candidates = quickPickCandidates(groupRecommendedModels(project(live).models));
    const byPrice = new Map<number, RecommendedModelEntry[]>();
    for (const row of candidates) {
      const price = recordedAverage(row);
      if (price === undefined || price <= 0) continue;
      const rows = byPrice.get(price) ?? [];
      rows.push(row);
      byPrice.set(price, rows);
    }
    const tie = [...byPrice].find(([, rows]) => rows.length > 1);
    expect(tie).toBeDefined();
    if (!tie)
      throw new Error("T13 requires recorded eligible candidates with equal positive prices");
    // Select whole projected rows; do not change prices or backend records.
    const tiedRows = tie[1];
    expect(computeQuickPicks(tiedRows).budget?.id).toBe(tiedRows[0].id);
    const reversed = tiedRows.toReversed();
    expect(computeQuickPicks(reversed).budget?.id).toBe(reversed[0].id);
  });

  test("T13 R9 fault injection: a luxury id also listed in flagship never becomes a quick pick", () => {
    const seed = expectedEntries(live).find((entry) => entry.tier === "luxury");
    expect(seed).toBeDefined();
    if (!seed) throw new Error("T13 requires a recorded luxury entry in the catalog");
    const recommendations = structuredClone(live.recommendations);
    // Fault injection specified by T13: copy a recorded luxury id into the flagship tier.
    recommendations.entries.push({ modelId: seed.modelId, tier: "flagship" });
    const doc = projectRecommendations(recommendations, live.catalog, live.richModels, live.now);
    const sections = groupRecommendedModels(doc.models);
    for (const tier of ["flagship", "luxury"]) {
      expect(
        doc.models.some((row) => row.id === seed.modelId && row.recommendationTier === tier)
      ).toBe(true);
      expect(
        sections.some(
          (section) =>
            section.recommendationTier === tier &&
            section.groups.some((group) => group.id === seed.modelId)
        )
      ).toBe(true);
    }
    const luxuryIds = new Set(
      expectedEntries({ ...live, recommendations })
        .filter((entry) => entry.tier === "luxury")
        .map((entry) => entry.modelId)
    );
    const candidates = quickPickCandidates(sections);
    expect(candidates.some((row) => row.id === seed.modelId)).toBe(false);
    for (const row of candidates) expect(luxuryIds.has(row.id)).toBe(false);
    for (const pick of Object.values(computeQuickPicks(candidates))) {
      if (pick) expect(luxuryIds.has(pick.id)).toBe(false);
    }
  });

  test("T14a R7/R8 keeps every recorded subscription row and its resolved command after all other sections", () => {
    const doc = project(dryrun);
    const expected = expectedRows(dryrun).filter(
      (row) => row.recommendationTier === "subscription"
    );
    expect(expected.length).toBeGreaterThan(0);
    const rows = doc.models.filter((row) => row.recommendationTier === "subscription");
    expect(rows.map(rowIdentity)).toEqual(expected);
    for (const row of rows) {
      expect(typeof row.subscription?.command).toBe("string");
      expect(row.subscription?.command.length).toBeGreaterThan(0);
    }
    const sections = groupRecommendedModels(doc.models);
    expect(sections.at(-1)?.recommendationTier).toBe("subscription");
    const sharedIds = [...new Set(expected.map((row) => row.id))].filter((id) =>
      expectedRows(dryrun).some((row) => row.id === id && row.recommendationTier !== "subscription")
    );
    expect(sharedIds.length).toBeGreaterThan(0);
    for (const id of sharedIds) {
      expect(
        sections.some(
          (section) =>
            section.recommendationTier !== "subscription" &&
            section.groups.some((group) => group.id === id)
        )
      ).toBe(true);
    }
  });

  test("T14b R4/R7 retains distinct subscription route and plan keys in other sections and routing shortcuts", () => {
    const entries = expectedEntries(dryrun).filter((entry) => entry.tier === "subscription");
    const byId = new Map<string, RecommendationWireEntry[]>();
    for (const entry of entries) {
      const rows = byId.get(entry.modelId) ?? [];
      rows.push(entry);
      byId.set(entry.modelId, rows);
    }
    const routeKey = (entry: RecommendationWireEntry) =>
      JSON.stringify([entry.route?.routeId, entry.route?.routeProfileId]);
    const multiRoute = [...byId].filter(([, rows]) => new Set(rows.map(routeKey)).size > 1);
    const multiPlan = [...byId].filter(([, rows]) =>
      rows.some(
        (entry) =>
          new Set(rows.filter((row) => routeKey(row) === routeKey(entry)).map((row) => row.planId))
            .size > 1
      )
    );
    expect(multiRoute.length).toBeGreaterThan(0);
    expect(multiPlan.length).toBeGreaterThan(0);
    const ids = new Set([...multiRoute, ...multiPlan].map(([id]) => id));
    const doc = project(dryrun);
    const sections = groupRecommendedModels(doc.models);
    for (const id of ids) {
      const rows = doc.models.filter(
        (row) => row.id === id && row.recommendationTier === "subscription"
      );
      expect(rows).toHaveLength((byId.get(id) as RecommendationWireEntry[]).length);
      const groups = sections
        .filter((section) => section.recommendationTier !== "subscription")
        .flatMap((section) => section.groups.filter((group) => group.id === id));
      expect(groups.length).toBeGreaterThan(0);
      const prefixes = rows
        .map((row) => row.subscription?.prefix)
        .filter((prefix): prefix is string => typeof prefix === "string");
      expect(prefixes.length).toBeGreaterThan(0);
      for (const group of groups) {
        expect(group.subscriptions).toEqual(rows);
        const actualPrefixes = collectRoutingPrefixes(group, noNativePrefix);
        for (const prefix of prefixes) expect(actualPrefixes).toContain(prefix);
      }
    }
  });

  test("T16 R4 unique models use section order then priority, keep the first row, and do not mutate input", () => {
    const doc = project(live);
    const before = structuredClone(doc.models);
    const rows = uniqueRecommendedModels(doc.models);
    const expected = expectedUniqueRows(live);
    expect(rows.map(rowIdentity)).toEqual(expected);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(rows).toEqual(
      expected
        .map((item) =>
          before.find(
            (row) => row.id === item.id && row.recommendationTier === item.recommendationTier
          )
        )
        .filter((row): row is RecommendedModelEntry => row !== undefined)
    );
    expect(doc.models).toEqual(before);
  });

  test("T17 R4/R10 picker fallback has one row per recorded id, newest first, without mutating the doc", () => {
    const doc = project(live);
    const before = structuredClone(doc);
    const expected = expectedUniqueRows(live).map((row) => row.id);
    expect(doc.models.length).toBeGreaterThan(expected.length);
    const rows = _recommendedFallbackRows(doc);
    expect(rows).toHaveLength(expected.length);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(rows.map((row) => row.id).toSorted()).toEqual(expected.toSorted());
    const releaseDate = (id: string) => doc.models.find((row) => row.id === id)?.releaseDate ?? "";
    // The contract does not specify where rows without a release date go.
    const dates = rows.map((row) => releaseDate(row.id)).filter((date) => date.length > 0);
    expect(dates).toEqual(dates.toSorted((left, right) => right.localeCompare(left)));
    expect(doc).toEqual(before);
  });

  // T18 fault injections change only our JSON-round-tripped cache doc, not backend records.
  test("T18(b,k) R10 skips one cache row without recommendationTier and keeps the others", () => {
    const { expected, value } = liveProjectedCache();
    expect(expected.models.length).toBeGreaterThan(1);
    value.models[0] = withoutCacheField(value.models[0], "recommendationTier");
    expect(readCacheWithoutMutation(value)).toEqual({
      ...expected,
      models: expected.models.slice(1),
    });
  });

  test("T18(c,k) R10 rejects an old category-only cache without tier declarations", () => {
    const { value } = liveProjectedCache();
    value.models = value.models.map((row) =>
      withoutCacheField({ ...row, category: row.recommendationTier }, "recommendationTier")
    );
    const oldCache = withoutCacheField(value, "recommendationTiers");
    expect(readCacheWithoutMutation(oldCache)).toBeNull();
  });

  test("T18(d,k) R2/R10 skips an unknown-tier row in a newer cache while retaining valid rows", () => {
    const { expected, value } = liveProjectedCache();
    expect(expected.models.length).toBeGreaterThan(1);
    value.models[0].recommendationTier = "experimental";
    value.recommendationTiers = [...(value.recommendationTiers ?? []), "experimental"];
    expect(readCacheWithoutMutation(value)).toEqual({
      ...expected,
      recommendationTiers: RECOMMENDATION_SECTIONS.map((section) => section.recommendationTier),
      models: expected.models.slice(1),
    });
  });

  test("T18(e,k) R10 rejects a cache whose tier declarations omit luxury", () => {
    const { value } = liveProjectedCache();
    value.recommendationTiers = value.recommendationTiers?.filter((tier) => tier !== "luxury");
    expect(readCacheWithoutMutation(value)).toBeNull();
  });

  test("T18(f,k) R10 skips one cache row without provider and keeps the others", () => {
    const { expected, value } = liveProjectedCache();
    expect(expected.models.length).toBeGreaterThan(1);
    value.models[0] = withoutCacheField(value.models[0], "provider");
    expect(readCacheWithoutMutation(value)).toEqual({
      ...expected,
      models: expected.models.slice(1),
    });
  });

  test("T18(g,k) R10 skips one cache row with numeric pricing.average and keeps the others", () => {
    const { expected, value } = liveProjectedCache();
    expect(expected.models.length).toBeGreaterThan(1);
    value.models[0].pricing = {
      ...(value.models[0].pricing as Record<string, unknown>),
      average: 5,
    };
    expect(readCacheWithoutMutation(value)).toEqual({
      ...expected,
      models: expected.models.slice(1),
    });
  });

  test("T18(h,k) R10 skips one cache row with an invalid subscription object and keeps the others", () => {
    const { expected, value } = liveProjectedCache();
    expect(expected.models.length).toBeGreaterThan(1);
    value.models[0].subscription = {};
    expect(readCacheWithoutMutation(value)).toEqual({
      ...expected,
      models: expected.models.slice(1),
    });
  });

  test("T18(i,k) R10 rejects a cache with no usable rows", () => {
    const { value } = liveProjectedCache();
    expect(value.models.length).toBeGreaterThan(0);
    value.models = value.models.map((row) => withoutCacheField(row, "provider"));
    expect(readCacheWithoutMutation(value)).toBeNull();
  });

  test("T18(j,k) R10 rejects the documented sync empty doc without mutating it", () => {
    // The public contract explicitly defines this return value; it is not a fabricated backend record.
    const value = { version: "0", lastUpdated: "", models: [] };
    const before = structuredClone(value);
    expect(readProjectedRecommendationsDoc(value)).toBeNull();
    expect(value).toEqual(before);
  });

  test("T19 R10 uses the versioned projected-recommendations cache filename without reading it", () => {
    expect(basename(RECOMMENDED_MODELS_CACHE_PATH)).toBe("recommended-models-cache-v2.json");
  });

  test.todo(
    "R9 unchanged plugin and team automatic defaults: queryPluginDefaults and team default APIs have no callable contract in this sandbox",
    () => {}
  );
  test.todo(
    "R11 backend evidence expiry: requires an implementation-wide read-path audit; no expiresAt/maxAgeHours policy API is exposed here",
    () => {}
  );
  test.todo(
    "R12 benchmark regeneration: generator, experiment files, and madbench inputs are outside this sandbox and have no injectable module contract",
    () => {}
  );
});
