import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EFFORT_LEVELS } from "../../adapters/base-api-format.js";
import { decodeModelConfigs } from "../devin/devin-models.js";
import { DevinModelResolver, devinModelsCatalogEntry } from "./devin.js";
import type { ExpandContext, ModelChoice, ModelsCatalogEntry } from "./types.js";
import { groupKeyOf, nonEmpty, offerIsLive } from "./types.js";

const fixturePath = join(import.meta.dir, "../../test-fixtures/devin/GetCliModelConfigs.res.bin");
const modelsCatalog = decodeModelConfigs(readFileSync(fixturePath))
  .filter((config) => config.contextWindow > 0)
  .map(devinModelsCatalogEntry);
const resolver = new DevinModelResolver();
const choices = resolver.collapse(modelsCatalog);
const modelsCatalogById = new Map(modelsCatalog.map((entry) => [entry.wireId, entry]));

function groupKey(entry: ModelsCatalogEntry): string {
  return JSON.stringify([groupKeyOf(entry), entry.contextWindow ?? 0]);
}

function groupEntries(entries: ModelsCatalogEntry[]): Map<string, ModelsCatalogEntry[]> {
  const groups = new Map<string, ModelsCatalogEntry[]>();
  for (const entry of entries) {
    const key = groupKey(entry);
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  return groups;
}

function entryForChoice(choice: ModelChoice): ModelsCatalogEntry {
  const entry = modelsCatalogById.get(choice.id);
  if (!entry)
    throw new Error(`Collapsed id is not in the fixture dynamic models catalog: ${choice.id}`);
  return entry;
}

function seededPermutation<T>(values: T[], seed: number): T[] {
  const result = [...values];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index--) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const swapIndex = state % (index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

function exactNamesOf(entry: ModelsCatalogEntry): string[] {
  const names = new Map<string, string>();
  for (const value of [entry.groupLabel, entry.family]) {
    const name = nonEmpty(value);
    if (!name) continue;
    if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  }
  return [...names.values()];
}

function fixtureNameGroups(entries: ModelsCatalogEntry[]): Array<{
  selection: string;
  entries: ModelsCatalogEntry[];
}> {
  const byName = new Map<string, { selection: string; entries: ModelsCatalogEntry[] }>();
  for (const entry of entries) {
    for (const selection of exactNamesOf(entry)) {
      const key = selection.toLowerCase();
      const named = byName.get(key);
      if (named) named.entries.push(entry);
      else byName.set(key, { selection, entries: [entry] });
    }
  }
  return [...byName.values()];
}

type DuplicateEffortCase = {
  choice: ModelChoice;
  effort: (typeof EFFORT_LEVELS)[number];
  candidates: ModelsCatalogEntry[];
};

function fixtureDuplicateEffortCases(): DuplicateEffortCase[] {
  const cases: DuplicateEffortCase[] = [];
  for (const choice of choices) {
    const plain = choice.variants.filter((variant) => variant.modifiers.length === 0);
    const pool = plain.length > 0 ? plain : choice.variants;

    for (const effort of EFFORT_LEVELS) {
      const candidates = pool
        .filter((variant) => variant.effort === effort)
        .map((variant) => modelsCatalogById.get(variant.wireId))
        .filter((entry): entry is ModelsCatalogEntry => entry !== undefined);
      if (candidates.length > 1) cases.push({ choice, effort, candidates });
    }
  }
  return cases;
}

function expectDuplicateEffortTieBreak(
  duplicate: DuplicateEffortCase,
  permutations: ModelsCatalogEntry[][]
): void {
  const { choice, effort, candidates } = duplicate;
  const resolvedIds = new Set(
    [modelsCatalog, ...permutations].map((entries) =>
      resolver.expand(choice.id, entries, { effort })
    )
  );
  expect(resolvedIds.size).toBe(1);

  const [resolvedId] = resolvedIds;
  const vendorDefault = candidates.find((entry) => entry.isFamilyDefault);
  if (vendorDefault) {
    expect(resolvedId).toBe(vendorDefault.wireId);
    return;
  }

  const cheapestCost = Math.min(
    ...candidates.map((entry) => entry.costFactor ?? Number.MAX_SAFE_INTEGER)
  );
  const cheapestIds = candidates
    .filter((entry) => (entry.costFactor ?? Number.MAX_SAFE_INTEGER) === cheapestCost)
    .map((entry) => entry.wireId);
  expect(cheapestIds).toContain(resolvedId);
}

function exactNamePermutationFlaps(
  exactNames: string[],
  contexts: Array<{ label: string; ctx: ExpandContext }>,
  permutations: ModelsCatalogEntry[][]
): string[] {
  const flaps: string[] = [];
  for (const selection of exactNames) {
    for (const { label, ctx } of contexts) {
      const resolvedIds = new Set(
        [modelsCatalog, ...permutations].map((entries) => resolver.expand(selection, entries, ctx))
      );
      if (resolvedIds.size > 1) {
        flaps.push(`${selection} @ ${label}: ${[...resolvedIds].sort().join(" | ")}`);
        continue;
      }

      const [resolvedId] = resolvedIds;
      expect(modelsCatalogById.has(resolvedId!)).toBe(true);
    }
  }
  return flaps;
}

function deriveAmbiguousUidPrefixes(entries: ModelsCatalogEntry[]): Array<{
  prefix: string;
  sourceUid: string;
  matches: ModelsCatalogEntry[];
}> {
  const exactUids = new Set(entries.map((entry) => entry.wireId.toLowerCase()));
  const exactNames = new Set(entries.flatMap(exactNamesOf).map((name) => name.toLowerCase()));
  const usedRoots = new Set<string>();
  const derived: Array<{ prefix: string; sourceUid: string; matches: ModelsCatalogEntry[] }> = [];

  for (const source of entries) {
    const parts = source.wireId.split("-");
    for (let length = parts.length - 1; length > 0; length--) {
      const prefix = parts.slice(0, length).join("-");
      const lower = prefix.toLowerCase();
      if (exactUids.has(lower) || exactNames.has(lower)) continue;

      const matches = entries.filter((entry) => entry.wireId.toLowerCase().startsWith(`${lower}-`));
      if (new Set(matches.map(groupKey)).size <= 1) continue;

      const root = parts[0]!.toLowerCase();
      if (!usedRoots.has(root)) {
        usedRoots.add(root);
        derived.push({ prefix, sourceUid: source.wireId, matches });
      }
      break;
    }
  }
  return derived;
}

function firstGroupForPrefix(entries: ModelsCatalogEntry[], prefix: string): string {
  const first = entries.find((entry) =>
    entry.wireId.toLowerCase().startsWith(`${prefix.toLowerCase()}-`)
  );
  if (!first) throw new Error(`Permutation lost fixture prefix: ${prefix}`);
  return groupKey(first);
}

function expectPermutationInvariant(
  selection: string,
  passesThrough: boolean,
  ctx: ExpandContext,
  permutations: ModelsCatalogEntry[][]
): void {
  const expected = resolver.expand(selection, modelsCatalog, ctx);
  if (passesThrough) expect(expected).toBe(selection);
  else expect(modelsCatalogById.has(expected)).toBe(true);

  for (const entries of permutations) {
    expect(resolver.expand(selection, entries, ctx)).toBe(expected);
  }
}

const groups = groupEntries(modelsCatalog);
const windowsByLabel = new Map<string, Set<number>>();
for (const entry of modelsCatalog) {
  const label = groupKeyOf(entry);
  const windows = windowsByLabel.get(label) ?? new Set<number>();
  windows.add(entry.contextWindow ?? 0);
  windowsByLabel.set(label, windows);
}

describe("DevinModelResolver collapse", () => {
  test("collapses the captured dynamic models catalog to substantially fewer real, unique wire ids", () => {
    expect(modelsCatalog).toHaveLength(170);
    expect(choices.length).toBeLessThan(modelsCatalog.length / 2);
    expect(choices).toHaveLength(groups.size);
    expect(choices.every((choice) => modelsCatalogById.has(choice.id))).toBe(true);
    expect(new Set(choices.map((choice) => choice.id)).size).toBe(choices.length);
  });

  test("creates sibling rows exactly for labels with distinct context windows", () => {
    const rowsByLabel = new Map<string, number>();
    for (const choice of choices) {
      const label = groupKeyOf(entryForChoice(choice));
      rowsByLabel.set(label, (rowsByLabel.get(label) ?? 0) + 1);
    }

    const expectedMultiWindowLabels = [...windowsByLabel]
      .filter(([, windows]) => windows.size > 1)
      .map(([label]) => label)
      .sort();
    const actualMultiWindowLabels = [...rowsByLabel]
      .filter(([, count]) => count > 1)
      .map(([label]) => label)
      .sort();
    expect(actualMultiWindowLabels).toEqual(expectedMultiWindowLabels);

    for (const [label, windows] of windowsByLabel) {
      expect(rowsByLabel.get(label)).toBe(windows.size);
      if (windows.size === 1) expect(rowsByLabel.get(label)).toBe(1);
      else expect(rowsByLabel.get(label)).toBeGreaterThan(1);
    }
  });

  test("makes every row's variants its exact group and partitions the dynamic models catalog", () => {
    const allVariantIds: string[] = [];

    for (const choice of choices) {
      const expectedIds = groups
        .get(groupKey(entryForChoice(choice)))!
        .map((entry) => entry.wireId)
        .sort();
      const actualIds = choice.variants.map((variant) => variant.wireId).sort();
      expect(actualIds).toEqual(expectedIds);
      allVariantIds.push(...actualIds);
    }

    expect(allVariantIds.sort()).toEqual(modelsCatalog.map((entry) => entry.wireId).sort());
  });

  test("uses the provider-declared family default as the row id", () => {
    for (const choice of choices) {
      const defaults = groups
        .get(groupKey(entryForChoice(choice)))!
        .filter((entry) => entry.isFamilyDefault)
        .map((entry) => entry.wireId);
      if (defaults.length > 0) expect(defaults).toContain(choice.id);
    }
  });
});

describe("DevinModelResolver expand", () => {
  test("reaches the 1M GLM effort variants", () => {
    expect(resolver.expand("glm-5-2-1m", modelsCatalog, { effort: "max" })).toBe("glm-5-2-max-1m");
    expect(resolver.expand("glm-5-2-1m", modelsCatalog, { effort: "none" })).toBe(
      "glm-5-2-none-1m"
    );
    expect(resolver.expand("glm-5-2-1m", modelsCatalog, {})).toBe("glm-5-2-1m");
  });

  test("never auto-selects a premium variant when a plain variant exists", () => {
    for (const choice of choices) {
      if (!choice.variants.some((variant) => variant.modifiers.length === 0)) continue;

      for (const effort of EFFORT_LEVELS) {
        const resolved = resolver.expand(choice.id, modelsCatalog, { effort });
        const variant = choice.variants.find((candidate) => candidate.wireId === resolved);
        expect(variant).toBeDefined();
        if (resolved !== choice.id) expect(variant?.modifiers).toEqual([]);
      }
    }
  });

  test("round-trips every collapsed row id when effort is absent", () => {
    for (const choice of choices) {
      expect(resolver.expand(choice.id, modelsCatalog, {})).toBe(choice.id);
    }
  });

  test("honours an explicitly tier-named fixture uid despite conflicting effort", () => {
    const explicit = choices
      .flatMap((choice) => choice.variants.map((variant) => ({ choiceId: choice.id, variant })))
      .find(
        ({ choiceId, variant }) =>
          variant.wireId !== choiceId &&
          variant.effort !== undefined &&
          variant.wireId.toLowerCase().split("-").includes(variant.effort)
      );
    if (!explicit?.variant.effort) {
      throw new Error("Fixture has no non-default uid that explicitly names its effort tier");
    }
    const conflictingEffort = EFFORT_LEVELS.find((effort) => effort !== explicit.variant.effort);
    if (!conflictingEffort) throw new Error("No conflicting effort level is available");

    expect(
      resolver.expand(explicit.variant.wireId, modelsCatalog, { effort: conflictingEffort })
    ).toBe(explicit.variant.wireId);
  });

  test("keeps a bare multi-window label inside one context group for every effort", () => {
    const multiWindowLabels = [...windowsByLabel]
      .filter(([, windows]) => windows.size > 1)
      .map(([label]) => label);
    expect(multiWindowLabels.length).toBeGreaterThan(0);

    for (const label of multiWindowLabels) {
      const baselineId = resolver.expand(label, modelsCatalog, {});
      const baseline = modelsCatalogById.get(baselineId);
      if (!baseline) throw new Error(`Bare fixture label did not resolve: ${label}`);
      expect(groupKeyOf(baseline)).toBe(label);

      for (const effort of EFFORT_LEVELS) {
        const resolvedId = resolver.expand(label, modelsCatalog, { effort });
        const resolved = modelsCatalogById.get(resolvedId);
        if (!resolved) throw new Error(`Bare fixture label did not resolve: ${label}`);
        expect(groupKeyOf(resolved)).toBe(label);
        expect(resolved.contextWindow).toBe(baseline.contextWindow);
      }
    }
  });

  test("passes an unknown selection through unchanged", () => {
    expect(
      resolver.expand("not-in-the-captured-models-catalog", modelsCatalog, { effort: "high" })
    ).toBe("not-in-the-captured-models-catalog");
  });

  test("passes a selection through unchanged when the dynamic models catalog is empty", () => {
    expect(resolver.expand("any-model", [], { effort: "high" })).toBe("any-model");
  });

  test("resolves vendor labels case-insensitively", () => {
    const capitalisedLabel = modelsCatalog
      .map((entry) => nonEmpty(entry.groupLabel))
      .find((label) => label !== undefined && label !== label.toLowerCase());
    if (!capitalisedLabel) throw new Error("Fixture has no capitalised vendor label");

    expect(resolver.expand(capitalisedLabel.toLowerCase(), modelsCatalog, {})).toBe(
      resolver.expand(capitalisedLabel, modelsCatalog, {})
    );
  });

  test("prefers the vendor default, then lower cost, for duplicate effort levels", () => {
    const duplicateEffortCases = fixtureDuplicateEffortCases();

    // The property is fixture-derived: a future dynamic models catalog with no duplicate
    // declared levels has no tie-break case to exercise.
    if (duplicateEffortCases.length === 0) return;

    const permutations = Array.from({ length: 16 }, (_, index) =>
      seededPermutation(modelsCatalog, index + 1)
    );
    for (const duplicate of duplicateEffortCases) {
      expectDuplicateEffortTieBreak(duplicate, permutations);
    }
  });

  test("is invariant for every exact fixture name and effort across dynamic models catalog permutations", () => {
    const permutations = Array.from({ length: 16 }, (_, index) =>
      seededPermutation(modelsCatalog, index + 1)
    );
    expect(
      new Set(permutations.map((entries) => entries.map((entry) => entry.wireId).join("\0"))).size
    ).toBe(permutations.length);

    const exactNames = fixtureNameGroups(modelsCatalog).map(({ selection }) => selection);
    expect(exactNames.length).toBeGreaterThan(0);

    const contexts: Array<{ label: string; ctx: ExpandContext }> = [
      { label: "no effort", ctx: {} },
      ...EFFORT_LEVELS.map((effort) => ({ label: effort, ctx: { effort } })),
    ];
    const flaps = exactNamePermutationFlaps(exactNames, contexts, permutations);

    // Bun prints every string in this list on failure, naming each exact
    // (label/family, effort) pair and every wire id it alternated between.
    expect(flaps).toEqual([]);

    const ambiguousPrefixes = deriveAmbiguousUidPrefixes(modelsCatalog).slice(0, 2);
    if (ambiguousPrefixes.length < 2) {
      throw new Error("Fixture has fewer than two independently derived ambiguous uid prefixes");
    }

    for (const { prefix } of ambiguousPrefixes) {
      const firstMatchGroups = new Set(
        permutations.map((entries) => firstGroupForPrefix(entries, prefix))
      );
      expect(firstMatchGroups.size).toBeGreaterThan(1);
    }

    const passThroughSelections = [
      ...ambiguousPrefixes.map(({ prefix: selection }) => ({ selection, passesThrough: true })),
      { selection: "not-in-the-captured-models-catalog", passesThrough: true },
    ];
    for (const choice of choices) {
      expectPermutationInvariant(choice.id, false, {}, permutations);
    }
    for (const ctx of [{}, { effort: "high" as const }]) {
      for (const { selection, passesThrough } of passThroughSelections) {
        expectPermutationInvariant(selection, passesThrough, ctx, permutations);
      }
    }
  });

  test("passes independently fixture-derived multi-group uid prefixes through unchanged", () => {
    const derived = deriveAmbiguousUidPrefixes(modelsCatalog).slice(0, 2);
    expect(derived).toHaveLength(2);
    expect(new Set(derived.map(({ sourceUid }) => sourceUid)).size).toBe(2);
    expect(new Set(derived.map(({ prefix }) => prefix.split("-")[0]!.toLowerCase())).size).toBe(2);

    const exactUids = new Set(modelsCatalog.map((entry) => entry.wireId.toLowerCase()));
    const exactNames = new Set(
      modelsCatalog.flatMap(exactNamesOf).map((name) => name.toLowerCase())
    );
    for (const { prefix, sourceUid, matches } of derived) {
      expect(sourceUid.toLowerCase().startsWith(`${prefix.toLowerCase()}-`)).toBe(true);
      expect(new Set(matches.map(groupKey)).size).toBeGreaterThan(1);
      expect(exactUids.has(prefix.toLowerCase())).toBe(false);
      expect(exactNames.has(prefix.toLowerCase())).toBe(false);
      expect(resolver.expand(prefix, modelsCatalog, {})).toBe(prefix);
      expect(resolver.expand(prefix, modelsCatalog, { effort: "high" })).toBe(prefix);
    }
  });

  test("resolves fixture-derived exact names spanning context groups via the vendor default", () => {
    const exactUids = new Set(modelsCatalog.map((entry) => entry.wireId.toLowerCase()));
    const multiWindowNames = fixtureNameGroups(modelsCatalog).filter(
      ({ selection, entries }) =>
        !exactUids.has(selection.toLowerCase()) &&
        new Set(entries.map((entry) => entry.contextWindow)).size > 1
    );
    expect(multiWindowNames.length).toBeGreaterThan(0);

    for (const { selection, entries } of multiWindowNames) {
      expect(new Set(entries.map(groupKey)).size).toBeGreaterThan(1);
      const defaults = entries.filter((entry) => entry.isFamilyDefault);
      expect(defaults).toHaveLength(1);

      for (const ctx of [{}, { effort: "high" as const }]) {
        const resolvedId = resolver.expand(selection, modelsCatalog, ctx);
        const resolved = modelsCatalogById.get(resolvedId);
        if (!resolved) throw new Error(`Fixture name did not resolve to a real uid: ${selection}`);
        expect(entries.map((entry) => entry.wireId)).toContain(resolvedId);
        expect(groupKey(resolved)).toBe(groupKey(defaults[0]!));
      }
    }
  });

  test("keeps exact-name effort resolution inside its selected context group", () => {
    const exactUids = new Set(modelsCatalog.map((entry) => entry.wireId.toLowerCase()));
    const multiWindowNames = fixtureNameGroups(modelsCatalog).filter(
      ({ selection, entries }) =>
        !exactUids.has(selection.toLowerCase()) &&
        new Set(entries.map((entry) => entry.contextWindow)).size > 1
    );
    expect(multiWindowNames.length).toBeGreaterThan(0);

    for (const { selection, entries } of multiWindowNames) {
      const baselineId = resolver.expand(selection, modelsCatalog, {});
      const baseline = modelsCatalogById.get(baselineId);
      if (!baseline) throw new Error(`Fixture name did not resolve to a real uid: ${selection}`);

      const selectedGroup = groups.get(groupKey(baseline));
      if (!selectedGroup) throw new Error(`Resolved fixture group is missing: ${selection}`);
      const selectedIds = new Set(selectedGroup.map((entry) => entry.wireId));
      const siblingWindows = new Set(
        entries
          .map((entry) => entry.contextWindow)
          .filter((window) => window !== baseline.contextWindow)
      );
      expect(siblingWindows.size).toBeGreaterThan(0);

      for (const effort of EFFORT_LEVELS) {
        const resolvedId = resolver.expand(selection, modelsCatalog, { effort });
        const resolved = modelsCatalogById.get(resolvedId);
        if (!resolved) throw new Error(`Fixture name did not resolve to a real uid: ${selection}`);
        expect(selectedIds.has(resolvedId)).toBe(true);
        expect(resolved.contextWindow).toBe(baseline.contextWindow);
        expect(siblingWindows.has(resolved.contextWindow)).toBe(false);
      }
    }
  });
});

describe("DevinModelResolver expand: exact base ids", () => {
  type SyntheticOptions = { cost?: number; isDefault?: boolean; fast?: boolean };

  /**
   * One synthetic dynamic models catalog entry. The family is dotted the way
   * Devin spells it, so it never equals a dashed base request and the request
   * reaches the base-id rule rather than the exact label/family rule.
   */
  function synthetic(
    wireId: string,
    groupLabel: string,
    family: string,
    effortLabel: string,
    options: SyntheticOptions = {}
  ): ModelsCatalogEntry {
    return {
      wireId,
      displayName: wireId,
      contextWindow: 200_000,
      groupLabel,
      family,
      costFactor: options.cost ?? 1,
      costTier: 1,
      isFamilyDefault: options.isDefault ?? false,
      axes: [
        { key: "Reasoning Effort", label: effortLabel, enabled: true },
        { key: "Fast Mode", enabled: options.fast ?? false },
      ],
    };
  }

  const opus55 = [
    synthetic("claude-opus-5-5-high", "Claude Opus 5.5", "claude-opus-5.5", "High", { cost: 10 }),
    synthetic("claude-opus-5-5-low", "Claude Opus 5.5", "claude-opus-5.5", "Low", { cost: 8 }),
  ];

  const opusBoth = [
    synthetic("claude-opus-5-low", "Claude Opus 5", "claude-opus-5.0", "Low", { cost: 4 }),
    synthetic("claude-opus-5-high", "Claude Opus 5", "claude-opus-5.0", "High", { cost: 6 }),
    synthetic("claude-opus-5-max", "Claude Opus 5", "claude-opus-5.0", "Max", { cost: 9 }),
    synthetic("claude-opus-5-5-high", "Claude Opus 5.5", "claude-opus-5.5", "High", {
      cost: 1,
      isDefault: true,
    }),
    synthetic("claude-opus-5-5-xhigh", "Claude Opus 5.5", "claude-opus-5.5", "XHigh", { cost: 2 }),
  ];
  const opus5Ids = ["claude-opus-5-low", "claude-opus-5-high", "claude-opus-5-max"];

  const sonnetBoth = [
    synthetic("claude-sonnet-5-low", "Claude Sonnet 5", "claude-sonnet-5.0", "Low", { cost: 2 }),
    synthetic("claude-sonnet-5-high", "Claude Sonnet 5", "claude-sonnet-5.0", "High", { cost: 3 }),
    synthetic("claude-sonnet-5-max", "Claude Sonnet 5", "claude-sonnet-5.0", "Max", { cost: 5 }),
    synthetic("claude-sonnet-5-5-high", "Claude Sonnet 5.5", "claude-sonnet-5.5", "High", {
      cost: 1,
      isDefault: true,
    }),
    synthetic("claude-sonnet-5-5-xhigh", "Claude Sonnet 5.5", "claude-sonnet-5.5", "XHigh", {
      cost: 1,
    }),
  ];
  const sonnet5Ids = ["claude-sonnet-5-low", "claude-sonnet-5-high", "claude-sonnet-5-max"];

  const gpt54 = [
    synthetic("gpt-5-4-none", "GPT-5.4", "gpt-5.4", "None", { cost: 1 }),
    synthetic("gpt-5-4-low", "GPT-5.4", "gpt-5.4", "Low", { cost: 2 }),
    synthetic("gpt-5-4-high", "GPT-5.4", "gpt-5.4", "High", { cost: 3 }),
    synthetic("gpt-5-4-mini-high", "GPT-5.4 Mini", "gpt-5.4-mini", "High", { cost: 1 }),
  ];

  test("never resolves claude-opus-5 to an Opus 5.5 id when only Opus 5.5 is listed", () => {
    for (const ctx of [{}, { effort: "high" as const }, { effort: "low" as const }]) {
      const resolved = resolver.expand("claude-opus-5", opus55, ctx);
      expect(resolved.startsWith("claude-opus-5-5")).toBe(false);
      expect(resolved).toBe("claude-opus-5");
    }
  });

  test("resolves claude-opus-5 to its own effort ids when Opus 5.5 is listed beside it", () => {
    expect(resolver.expand("claude-opus-5", opusBoth, { effort: "high" })).toBe(
      "claude-opus-5-high"
    );
    // xhigh is not listed for Opus 5: high and max are equidistant, so it resolves upward.
    expect(resolver.expand("claude-opus-5", opusBoth, { effort: "xhigh" })).toBe(
      "claude-opus-5-max"
    );
    expect(opus5Ids).toContain(resolver.expand("claude-opus-5", opusBoth, {}));
  });

  test("picks the no-effort default of claude-opus-5 among its own effort ids only", () => {
    // The Opus 5.5 vendor default and its lower cost must not pull the answer
    // out of Opus 5; with no Opus 5 default the cheapest Opus 5 id wins.
    expect(resolver.expand("claude-opus-5", opusBoth, {})).toBe("claude-opus-5-low");
  });

  test("resolves claude-sonnet-5 to its own effort ids when Sonnet 5.5 is listed beside it", () => {
    expect(resolver.expand("claude-sonnet-5", sonnetBoth, { effort: "high" })).toBe(
      "claude-sonnet-5-high"
    );
    expect(resolver.expand("claude-sonnet-5", sonnetBoth, { effort: "xhigh" })).toBe(
      "claude-sonnet-5-max"
    );
    expect(sonnet5Ids).toContain(resolver.expand("claude-sonnet-5", sonnetBoth, {}));
    const only55 = sonnetBoth.filter((entry) => entry.wireId.startsWith("claude-sonnet-5-5"));
    expect(resolver.expand("claude-sonnet-5", only55, { effort: "high" })).toBe("claude-sonnet-5");
    expect(resolver.expand("claude-sonnet-5", only55, {})).toBe("claude-sonnet-5");
  });

  test("resolves kimi-k3 to kimi-k3-high when kimi-k3-1-pro is listed beside it", () => {
    const list = [
      synthetic("kimi-k3-high", "Kimi K3", "kimi-k3.0", "High", { cost: 2 }),
      synthetic("kimi-k3-low", "Kimi K3", "kimi-k3.0", "Low", { cost: 1 }),
      synthetic("kimi-k3-1-pro-high", "Kimi K3.1 Pro", "kimi-k3.1-pro", "High", { cost: 3 }),
    ];
    expect(resolver.expand("kimi-k3", list, { effort: "high" })).toBe("kimi-k3-high");
  });

  test("resolves gpt-5-4 to its own effort ids when gpt-5-4-mini is listed beside it", () => {
    expect(resolver.expand("gpt-5-4", gpt54, { effort: "high" })).toBe("gpt-5-4-high");
    expect(resolver.expand("gpt-5-4", gpt54, { effort: "none" })).toBe("gpt-5-4-none");
    // medium is not listed: low and high are equidistant, so it resolves upward.
    expect(resolver.expand("gpt-5-4", gpt54, { effort: "medium" })).toBe("gpt-5-4-high");
  });

  test("picks across effort siblings that sit in different groups", () => {
    // The vendor default and the cheaper id sit in the low sibling's group; the
    // high sibling has its own label and context window.
    const list = [
      synthetic("nova-2-low", "Nova 2", "nova-2.0", "Low", { cost: 1, isDefault: true }),
      {
        ...synthetic("nova-2-high", "Nova 2 Long", "nova-2.0-long", "High", { cost: 5 }),
        contextWindow: 1_000_000,
      },
    ];
    expect(resolver.expand("nova-2", list, { effort: "high" })).toBe("nova-2-high");
    expect(resolver.expand("nova-2", list, { effort: "low" })).toBe("nova-2-low");
    expect(resolver.expand("nova-2", list, {})).toBe("nova-2-low");
  });

  test("picks the cheaper of two vendor defaults in different groups, in either order", () => {
    const list = [
      synthetic("vega-3-high", "Vega 3", "vega-3.0", "High", { cost: 5, isDefault: true }),
      {
        ...synthetic("vega-3-low", "Vega 3 Long", "vega-3.0-long", "Low", {
          cost: 2,
          isDefault: true,
        }),
        contextWindow: 1_000_000,
      },
    ];
    expect(resolver.expand("vega-3", list, {})).toBe("vega-3-low");
    expect(resolver.expand("vega-3", [...list].reverse(), {})).toBe("vega-3-low");
  });

  test("passes glm-5-3 through when only glm-5-3-flash ids are listed", () => {
    const list = [synthetic("glm-5-3-flash-high", "GLM-5.3 Flash", "glm-5.3-flash", "High")];
    expect(resolver.expand("glm-5-3", list, { effort: "high" })).toBe("glm-5-3");
    expect(resolver.expand("glm-5-3", list, {})).toBe("glm-5-3");
  });

  test("never returns an id with more tokens between the base and the effort", () => {
    const list = [
      synthetic("gpt-5-4-high-priority", "GPT-5.4", "gpt-5.4", "High", { fast: true }),
      synthetic("claude-opus-5-5-high", "Claude Opus 5.5", "claude-opus-5.5", "High"),
      synthetic("kimi-k3-1-pro-high", "Kimi K3.1 Pro", "kimi-k3.1-pro", "High"),
      synthetic("glm-5-3-flash-low", "GLM-5.3 Flash", "glm-5.3-flash", "Low"),
    ];
    const contexts: ExpandContext[] = [{}, ...EFFORT_LEVELS.map((effort) => ({ effort }))];
    const offenders: string[] = [];
    for (const base of ["gpt-5-4", "claude-opus-5", "kimi-k3", "glm-5-3"]) {
      const allowed = new Set([base, ...EFFORT_LEVELS.map((level) => `${base}-${level}`)]);
      for (const ctx of contexts) {
        const resolved = resolver.expand(base, list, ctx);
        if (!allowed.has(resolved)) offenders.push(`${base}@${ctx.effort ?? "-"} -> ${resolved}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("resolves the fixture's gpt-5-4 to its own effort ids beside gpt-5-4-mini", () => {
    expect(resolver.expand("gpt-5-4", modelsCatalog, { effort: "high" })).toBe("gpt-5-4-high");
    expect(resolver.expand("gpt-5-4", modelsCatalog, { effort: "none" })).toBe("gpt-5-4-none");
    expect(resolver.expand("gpt-5-4", modelsCatalog, { effort: "max" })).toBe("gpt-5-4-xhigh");
  });
});

describe("model resolver helpers", () => {
  test("nonEmpty treats empty and whitespace-only strings as absent", () => {
    expect(nonEmpty("")).toBeUndefined();
    expect(nonEmpty(" \t\n ")).toBeUndefined();
    expect(nonEmpty(undefined)).toBeUndefined();
    expect(nonEmpty("  model family  ")).toBe("model family");
  });

  test("offerIsLive compares expiry against an injected clock", () => {
    const now = 2_000_000;
    expect(offerIsLive({ kind: "promo", expiresAt: 1_999 }, now)).toBe(false);
    expect(offerIsLive({ kind: "promo", expiresAt: 2_001 }, now)).toBe(true);
    expect(offerIsLive({ kind: "included" }, now)).toBe(true);
    expect(offerIsLive(undefined, now)).toBe(false);
  });

  test("groupKeyOf prefers a non-empty label, then family, then wire id", () => {
    expect(groupKeyOf({ wireId: "wire", groupLabel: " Vendor label ", family: "family" })).toBe(
      "Vendor label"
    );
    expect(groupKeyOf({ wireId: "wire", groupLabel: "", family: " family " })).toBe("family");
    expect(groupKeyOf({ wireId: "wire", groupLabel: " ", family: "" })).toBe("wire");
  });
});
