import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { recommendedSearchMatches } from "./mcp-server.js";
import type { RecommendedModelsDoc } from "./model-loader.js";

const recommended = JSON.parse(
  readFileSync(
    new URL("./test-fixtures/mcp-model-check/recommended-20261023.json", import.meta.url),
    "utf8"
  )
) as RecommendedModelsDoc;

describe("recommendedSearchMatches", () => {
  test("openai gpt returns newest-first GPT ids once across recommendation tiers", () => {
    const matches = recommendedSearchMatches("openai gpt", recommended.models);
    const ids = matches.map((m) => m.id);
    expect(ids).toEqual(["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(matches[0]).toEqual({
      id: "gpt-6.1-sol",
      vendor: "openai",
      tiers: ["flagship", "cost_efficient"],
      released: "2026-09-29",
    });
  });

  test.each([
    { query: "grok-3", ids: ["grok-4.7"] },
    { query: "minimax", ids: ["minimax-m3"] },
    { query: "vision", ids: [] },
    { query: "a", ids: [] },
    { query: "g p t", ids: [] },
    { query: "a grok-3 x", ids: ["grok-4.7"] },
  ])("$query returns $ids, ignoring one-letter words", ({ query, ids }) => {
    expect(recommendedSearchMatches(query, recommended.models).map((m) => m.id)).toEqual([...ids]);
  });
});
