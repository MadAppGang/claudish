import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type ModelChoiceFacts,
  modelChoiceProblems,
  userRequiredProvidersArg,
} from "./mcp-server.js";
import type { RecommendedModelsDoc } from "./model-loader.js";
import { parseModelChain } from "./providers/model-parser.js";
import { catalogModelId } from "./providers/route-candidates.js";

const captured = JSON.parse(
  readFileSync(
    new URL("./test-fixtures/mcp-model-check/recommended-20261023.json", import.meta.url),
    "utf8"
  )
) as RecommendedModelsDoc;
const recommended = captured.models;
const gptIds = ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"];
const pairs = (specs: readonly string[]) => specs.map((spec) => ({ given: spec, spec }));
const facts = (overrides: Partial<ModelChoiceFacts> = {}): ModelChoiceFacts => ({
  recommended,
  userRule: () => false,
  inCatalog: () => false,
  namespaceClaim: () => false,
  ...overrides,
});

describe("modelChoiceProblems with captured recommended rows", () => {
  test("the capture has duplicate tiers and release dates in a different order from ids", () => {
    const sol = recommended.filter((row) => row.id === gptIds[0]);
    expect(sol.map((row) => row.recommendationTier)).toEqual(["flagship", "cost_efficient"]);
    expect(gptIds.map((id) => recommended.find((row) => row.id === id)?.releaseDate)).toEqual([
      "2026-09-29",
      "2026-09-22",
      "2026-09-03",
    ]);
    expect(recommended.some((row) => row.id === "minimax-m3")).toBe(true);
    expect(recommended.some((row) => row.id === "gpt-5")).toBe(false);
  });

  test("family names answer unknown_model with newest-first, deduplicated recommended ids", () => {
    const rows = structuredClone(recommended).reverse();
    const before = structuredClone(rows);
    expect(
      modelChoiceProblems(pairs(["gpt", "minimax"]), new Set(), facts({ recommended: rows }))
    ).toEqual([
      { spec: "gpt", kind: "unknown_model", matching: gptIds },
      { spec: "minimax", kind: "unknown_model", matching: ["minimax-m3"] },
    ]);
    expect(rows).toEqual(before);
  });

  test.each([
    { spec: "openai", matching: gptIds },
    { spec: "OpenAI", matching: gptIds },
    { spec: "MiniMax", matching: ["minimax-m3"] },
    { spec: "z-ai", matching: ["glm-5.3-flash", "glm-5.3"] },
  ])("vendor $spec also matches ids outside that family", ({ spec, matching }) => {
    expect(modelChoiceProblems(pairs([spec]), new Set(), facts())).toEqual([
      { spec, kind: "unknown_model", matching: [...matching] },
    ]);
  });

  test("an unknown name without a matching family or vendor has no suggestions", () => {
    expect(modelChoiceProblems(pairs(["no-such-model"]), new Set(), facts())).toEqual([
      { spec: "no-such-model", kind: "unknown_model", matching: [] },
    ]);
  });

  test("a catalog model outside the recommended list answers not_recommended", () => {
    expect(
      modelChoiceProblems(pairs(["gpt-5"]), new Set(), facts({ inCatalog: (id) => id === "gpt-5" }))
    ).toEqual([{ spec: "gpt-5", kind: "not_recommended", matching: gptIds }]);
  });

  test.each([
    { spec: "MiniMax-M3", canonical: "minimax-m3" },
    { spec: "k3", canonical: "kimi-k3" },
    { spec: "gemini-4-argon-high", canonical: "gemini-4-argon" },
  ])("accepts $spec when its canonical id $canonical is recommended", ({ spec, canonical }) => {
    expect(recommended.some((row) => row.id === canonical)).toBe(true);
    expect(
      modelChoiceProblems(
        pairs([spec]),
        new Set(),
        facts({
          inCatalog: () => true,
          canonicalId: (model) => (model === spec ? canonical : undefined),
        })
      )
    ).toEqual([]);
  });

  test("a canonical id outside the recommended list still answers not_recommended", () => {
    expect(recommended.some((row) => row.id === "gpt-5")).toBe(false);
    expect(
      modelChoiceProblems(
        pairs(["GPT-5"]),
        new Set(),
        facts({
          inCatalog: () => true,
          canonicalId: (model) => (model === "GPT-5" ? "gpt-5" : undefined),
        })
      )
    ).toEqual([{ spec: "GPT-5", kind: "not_recommended", matching: gptIds }]);
  });

  test.each([true, false, undefined])(
    "catalogMissAllowed %j decides an unclaimed catalog miss",
    (allowed) => {
      const injected = facts(allowed === undefined ? {} : { catalogMissAllowed: () => allowed });
      expect(modelChoiceProblems(pairs(["minimax"]), new Set(), injected)).toEqual(
        allowed === true
          ? []
          : [{ spec: "minimax", kind: "unknown_model", matching: ["minimax-m3"] }]
      );
    }
  );

  test("allowing catalog misses never exempts a non-recommended catalog hit", () => {
    expect(
      modelChoiceProblems(
        pairs(["gpt-5"]),
        new Set(),
        facts({ inCatalog: () => true, catalogMissAllowed: () => true })
      )
    ).toEqual([{ spec: "gpt-5", kind: "not_recommended", matching: gptIds }]);
  });

  test("a catalog hit wins over a namespace claim", () => {
    expect(
      modelChoiceProblems(
        pairs(["gpt-5"]),
        new Set(),
        facts({ inCatalog: () => true, namespaceClaim: () => true })
      )
    ).toEqual([{ spec: "gpt-5", kind: "not_recommended", matching: gptIds }]);
  });

  test.each([
    "gpt-6.1-sol",
    "minimax-m3",
    "gpt-6.1-sol+pro",
    "gpt-6.1-sol#fast",
    "gpt-6.1-sol+pro#fast",
    "opus",
    "claude-opus-5-5",
    "kc@k3",
    "ollama@llama3.2",
    "or@gpt",
    "gpt+minimax",
    "kc@k3+or@gpt",
  ])("exempts %s", (spec) => {
    expect(modelChoiceProblems(pairs([spec]), new Set(), facts())).toEqual([]);
  });

  test("a chain is not mistaken for a +pro marker", () => {
    expect(parseModelChain("gpt+minimax")).toEqual(["gpt", "minimax"]);
    expect(parseModelChain("gpt-6.1-sol+pro")).toEqual(["gpt-6.1-sol+pro"]);
    expect(modelChoiceProblems(pairs(["gpt+minimax"]), new Set(), facts())).toEqual([]);
    expect(modelChoiceProblems(pairs(["gpt+pro"]), new Set(), facts())).toEqual([
      { spec: "gpt+pro", kind: "unknown_model", matching: gptIds },
    ]);
  });

  test("a user routing rule exempts even a non-recommended catalog model", () => {
    expect(
      modelChoiceProblems(
        pairs(["gpt-5"]),
        new Set(),
        facts({ userRule: (id) => id === "gpt-5", inCatalog: () => true })
      )
    ).toEqual([]);
  });

  test("a namespace claim exempts a name absent from the catalog", () => {
    expect(
      modelChoiceProblems(
        pairs(["swe-1.7"]),
        new Set(),
        facts({ namespaceClaim: (id) => id === "swe-1.7" })
      )
    ).toEqual([]);
  });

  test("required specs bypass only the entries the user named", () => {
    expect(
      modelChoiceProblems(
        pairs(["gpt", "gpt-5", "minimax"]),
        new Set(["gpt", "gpt-5"]),
        facts({ inCatalog: (id) => id === "gpt-5" })
      )
    ).toEqual([{ spec: "minimax", kind: "unknown_model", matching: ["minimax-m3"] }]);
  });

  test("a stripped provider keeps the caller's spelling in the problem", () => {
    expect(
      modelChoiceProblems(
        [{ given: "oai@gpt-5", spec: "gpt-5" }],
        new Set(),
        facts({ inCatalog: (id) => id === "gpt-5" })
      )
    ).toEqual([{ spec: "oai@gpt-5", kind: "not_recommended", matching: gptIds }]);
  });

  test("required matches given, not the stripped spec", () => {
    const input = [{ given: "oai@gpt-5", spec: "gpt-5" }];
    const injected = facts({ inCatalog: () => true });
    expect(modelChoiceProblems(input, new Set(["oai@gpt-5"]), injected)).toEqual([]);
    expect(modelChoiceProblems(input, new Set(["gpt-5"]), injected)).toEqual([
      { spec: "oai@gpt-5", kind: "not_recommended", matching: gptIds },
    ]);
  });

  test("a missing recommended list checks no name and never consults the facts", () => {
    const unexpected = (): boolean => {
      throw new Error("facts must not be consulted without a recommended list");
    };
    expect(
      modelChoiceProblems(
        pairs(["gpt", "minimax", "gpt-5", "swe-1.7", "opus", "kc@k3", "gpt+minimax"]),
        new Set(),
        facts({
          recommended: null,
          userRule: unexpected,
          inCatalog: unexpected,
          namespaceClaim: unexpected,
        })
      )
    ).toEqual([]);
  });

  test("empty input returns no problems", () => {
    expect(modelChoiceProblems([], new Set(), facts())).toEqual([]);
  });
});

describe("catalogModelId with the captured Kimi catalog used by the black-box tests", () => {
  const cachePath = fileURLToPath(
    new URL("./test-fixtures/catalog-v3/kimi-k3-g-20261021063612126-17350b71.json", import.meta.url)
  );

  test.each(["kimi-k3", "k3", "KIMI-K3", "K3"])("resolves %s to the canonical id", (model) => {
    expect(catalogModelId(model, cachePath)).toBe("kimi-k3");
  });

  test("an unknown name returns undefined", () => {
    expect(catalogModelId("no-such-model", cachePath)).toBeUndefined();
  });

  test("an unreadable file path returns undefined", () => {
    // The parent is a regular captured file, so this child path cannot be read.
    expect(catalogModelId("kimi-k3", `${cachePath}/unreadable.json`)).toBeUndefined();
  });
});

describe("userRequiredProvidersArg for user_required_model", () => {
  test("an unknown entry names user_required_model in the error", () => {
    expect(() => userRequiredProvidersArg(["x"], ["y"], "user_required_model")).toThrow(
      "Invalid 'user_required_model': \"x\" is not one of the models (y)."
    );
  });

  test.each([true, "gpt-5", [1]])("invalid type %j names user_required_model", (value) => {
    expect(() => userRequiredProvidersArg(value, ["gpt-5"], "user_required_model")).toThrow(
      "Invalid 'user_required_model': expected an array of model specs."
    );
  });

  test("accepts exact model and judge entries and deduplicates them", () => {
    expect([
      ...userRequiredProvidersArg(
        ["gpt-5", "minimax", "gpt-5"],
        ["gpt-5", "minimax"],
        "user_required_model"
      ),
    ]).toEqual(["gpt-5", "minimax"]);
  });
});
