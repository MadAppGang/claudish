// No-effort seams: lookupModelEfforts / bundledEffortRecommendations; disk reads are stubbed.
// The shared resolver reads connection effort maps through readAllModelsCache.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { EffortLevel } from "../../adapters/base-api-format.js";
import * as allModelsCache from "../all-models-cache.js";
import type { DiskCacheV3, SlimModelEntry } from "../all-models-cache.js";
import {
  catalogEntry,
  connection,
  effortMap,
  stubEffortRecommendations,
} from "../test-helpers/model-id-effort.js";
import type { ModelIdEffort } from "../test-helpers/model-id-effort.js";
import { resolveAntigravityServedModel } from "./antigravity.js";

const resolve: (
  requested: string,
  served: { servedIds: string[]; defaultId: string | null },
  effort?: EffortLevel
) => string = resolveAntigravityServedModel;

const BASE = "gemini-4-carbon";
const HIGH = `${BASE}-high`;
const MEDIUM = `${BASE}-medium`;
const LOW = `${BASE}-low`;
const served = (servedIds = [HIGH, MEDIUM, LOW], defaultId: string | null = HIGH) => ({
  servedIds,
  defaultId,
});
let entries: SlimModelEntry[] = [];
let restoreCache: () => void;
const realFetch = globalThis.fetch;
const noNetwork = mock(async () => {
  throw new Error("Unexpected network in model-id unit tests");
});

function publish(map: ModelIdEffort, base = BASE): void {
  entries = [catalogEntry(base, [connection("antigravity", base, map)])];
}

beforeEach(() => {
  entries = [];
  noNetwork.mockClear();
  globalThis.fetch = noNetwork as unknown as typeof fetch;
  const read = spyOn(allModelsCache, "readAllModelsCache").mockImplementation(
    (): DiskCacheV3 => ({
      version: 3,
      lastUpdated: "2026-11-12T00:00:00.000Z",
      catalogGenerationId: "model-id-effort-test-data",
      entries,
      models: [],
      plans: [],
    })
  );
  const restoreEfforts = stubEffortRecommendations();
  restoreCache = () => {
    restoreEfforts();
    read.mockRestore();
  };
});

afterEach(() => {
  restoreCache();
  globalThis.fetch = realFetch;
  expect(noNetwork).not.toHaveBeenCalled();
});

test("Antigravity resolution, transport and gathering import no speed-premium name helpers", () => {
  const forbiddenImports = [
    "../antigravity-model-id.ts",
    "./antigravity.ts",
    "../route-candidates.ts",
  ].flatMap((file) => {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const imports = source.match(/\bimport\s+[^;]+\s+from\s+["'][^"']+["'];/g) ?? [];
    return imports.flatMap((statement) =>
      ["namesSpeedPremium", "SPEED_PREMIUM_SUFFIXES"]
        .filter((name) => new RegExp(`\\b${name}\\b`).test(statement))
        .map((name) => ({ file, name }))
    );
  });
  expect(forbiddenImports).toEqual([]);
});

describe("Antigravity connection modelIdEffort", () => {
  test("rule 1: an exact effort id stays fixed even when it is the backend default", () => {
    publish(effortMap({ high: HIGH, medium: MEDIUM, low: LOW }));
    expect(resolve(MEDIUM, served([HIGH, MEDIUM, LOW], MEDIUM), "low")).toBe(MEDIUM);
  });

  test("rule 1: an exact non-default low id ignores conflicting high effort", () => {
    publish(effortMap({ high: HIGH, medium: MEDIUM, low: LOW }));
    expect(resolve(LOW, served(), "high")).toBe(LOW);
  });

  test("rule 2: no effort chooses medium instead of the weaker backend default", () => {
    publish(effortMap({ high: HIGH, medium: MEDIUM, low: LOW }));
    expect(resolve(BASE, served([HIGH, MEDIUM, LOW], LOW))).toBe(MEDIUM);
  });

  test("rule 2: absent backend default chooses medium instead of the highest listed effort", () => {
    publish(effortMap({ high: HIGH, medium: MEDIUM, low: LOW }));
    expect(resolve(BASE, served([MEDIUM, LOW, HIGH], null))).toBe(MEDIUM);
  });

  test("rule 2: an unrelated backend default falls back to medium", () => {
    publish(effortMap({ high: HIGH, medium: MEDIUM, low: LOW }));
    expect(
      resolve(BASE, served([HIGH, MEDIUM, LOW, "gemini-other-high"], "gemini-other-high"))
    ).toBe(MEDIUM);
  });

  for (const [effort, expected] of [
    ["high", HIGH],
    ["medium", MEDIUM],
    ["low", LOW],
  ] as const) {
    test(`rule 3: ${effort} chooses the mapped id rather than the backend high default`, () => {
      publish(effortMap({ high: HIGH, medium: MEDIUM, low: LOW }));
      expect(resolve(BASE, served(), effort)).toBe(expected);
    });
  }

  test("rules 3/10: map ids need not be spelled base plus effort", () => {
    const mapped = "carbon-account-route-b";
    publish(effortMap({ high: HIGH, low: mapped }));
    expect(resolve(BASE, served([HIGH, LOW, mapped]), "low")).toBe(mapped);
  });

  for (const effort of ["minimal", "low", "medium", "high", "xhigh"] as const) {
    test(`rule 4: ${effort} upgrades to max when only max is published`, () => {
      publish(effortMap({ max: "glm-5-2-max" }), "glm-5-2");
      expect(
        resolve("glm-5-2", served(["glm-5-2-low", "glm-5-2-max"], "glm-5-2-low"), effort)
      ).toBe("glm-5-2-max");
    });
  }

  test("rule 4: the next higher level wins even when a lower level is closer", () => {
    const max = `${BASE}-max`;
    publish(effortMap({ max, low: LOW }));
    expect(resolve(BASE, served([LOW, max], LOW), "medium")).toBe(max);
  });

  test("rule 4: missing medium chooses high, not the first max map key", () => {
    const max = `${BASE}-max`;
    publish(effortMap({ max, high: HIGH, low: LOW }));
    expect(resolve(BASE, served([LOW, HIGH, max], LOW), "medium")).toBe(HIGH);
  });

  test("rule 4: above every map level uses the highest published level, not backend low", () => {
    publish(effortMap({ medium: MEDIUM, low: LOW }));
    expect(resolve(BASE, served([LOW, MEDIUM], LOW), "max")).toBe(MEDIUM);
  });

  test("rule 5: none sends the published off id", () => {
    const off = "carbon-without-thinking";
    publish(effortMap({ high: HIGH, low: LOW }, { off }));
    expect(resolve(BASE, served([HIGH, LOW, off]), "none")).toBe(off);
  });

  test("rule 5: none without off keeps the current backend default behaviour", () => {
    publish(effortMap({ high: HIGH, low: LOW }));
    expect(resolve(BASE, served([HIGH, LOW], HIGH), "none")).toBe(HIGH);
  });

  test("rule 6: a missing mapped id falls back to the backend default, not another effort", () => {
    publish(effortMap({ high: HIGH, medium: MEDIUM, low: "carbon-unlisted-low" }));
    expect(resolve(BASE, served(), "low")).toBe(HIGH);
  });

  test("rule 6: entitlement changes whether the mapped id may be sent", () => {
    const mapped = "carbon-entitled-low";
    publish(effortMap({ high: HIGH, low: mapped }));
    const present = resolve(BASE, served([HIGH, LOW, mapped]), "low");
    const absent = resolve(BASE, served([HIGH, LOW]), "low");
    expect({ present, absent }).toEqual({ present: mapped, absent: HIGH });
  });

  test("rule 6: unlisted off falls back to the current none behaviour", () => {
    publish(effortMap({ high: HIGH, low: LOW }, { off: "carbon-unlisted-off" }));
    expect(resolve(BASE, served(), "none")).toBe(HIGH);
  });

  for (const suffix of ["fast", "priority"]) {
    test(`rule 7: mapped -${suffix} is selected and an exact id stays fixed`, () => {
      const premium = `${BASE}-high-${suffix}`;
      publish(effortMap({ high: premium, low: LOW }));
      expect(resolve(BASE, served([LOW, premium], LOW), "high")).toBe(premium);
      expect(resolve(premium, served([LOW, premium], LOW), "low")).toBe(premium);
    });
  }

  test("rule 8: matches provider binding and exact externalModelId, not the first connection", () => {
    const mapped = "carbon-correct-low";
    entries = [
      catalogEntry(BASE, [
        connection("devin", BASE, effortMap({ low: "carbon-wrong-provider" })),
        connection("antigravity", `${BASE}-1m`, effortMap({ low: "carbon-wrong-context" })),
        connection("antigravity", BASE, effortMap({ low: mapped })),
      ]),
    ];
    expect(
      resolve(
        BASE,
        served([HIGH, LOW, mapped, "carbon-wrong-provider", "carbon-wrong-context"]),
        "low"
      )
    ).toBe(mapped);
  });

  test("rule 8: a served 1M base uses its own map rather than its identity or the default-context map", () => {
    entries = [
      catalogEntry(
        "glm-5.2",
        [
          connection("antigravity", "glm-5-2", effortMap({ max: "glm-5-2-max" })),
          connection(
            "antigravity",
            "glm-5-2-1m",
            effortMap({ max: "glm-5-2-max-1m" }, { baseServed: true })
          ),
        ],
        ["glm-5-2", "glm-5-2-1m"]
      ),
    ];
    expect(
      resolve(
        "glm-5-2-1m",
        served(["glm-5-2-1m", "glm-5-2-max", "glm-5-2-max-1m"], "glm-5-2-max"),
        "high"
      )
    ).toBe("glm-5-2-max-1m");
  });

  test("rule 8: a default-context map alone cannot select a default-context id for a 1M base", () => {
    publish(effortMap({ max: "glm-5-2-max" }), "glm-5-2");
    expect(
      resolve(
        "glm-5-2-1m",
        served(["glm-5-2-1m", "glm-5-2-max", "glm-5-2-max-1m"], "glm-5-2-max"),
        "high"
      )
    ).toBe("glm-5-2-1m");
  });

  test("rules 1/8: an exact suffixed 1M id never enters the default-context map", () => {
    publish(effortMap({ max: "glm-5-2-max" }), "glm-5-2");
    expect(
      resolve("glm-5-2-max-1m", served(["glm-5-2-max-1m", "glm-5-2-max"], "glm-5-2-max"), "low")
    ).toBe("glm-5-2-max-1m");
  });

  test("rules 8/10: a sibling map does not leak when the exact connection has no map", () => {
    entries = [
      catalogEntry(BASE, [
        connection("antigravity", `${BASE}-1m`, effortMap({ low: "carbon-sibling-only" })),
        connection("antigravity", BASE),
      ]),
    ];
    expect(resolve(BASE, served([HIGH, LOW, "carbon-sibling-only"]), "low")).toBe(HIGH);
  });

  test("rule 10: a published off id is read from data even when it looks like an effort id", () => {
    publish(effortMap({ high: HIGH }, { off: LOW }));
    expect(resolve(BASE, served(), "none")).toBe(LOW);
  });

  test("rule 10: replacing the map on one connection changes the sent id", () => {
    const a = "carbon-low-route-a";
    const b = "carbon-low-route-b";
    const list = served([HIGH, a, b]);
    publish(effortMap({ low: a }));
    const first = resolve(BASE, list, "low");
    publish(effortMap({ low: b }));
    const second = resolve(BASE, list, "low");
    expect([first, second]).toEqual([a, b]);
  });
});
