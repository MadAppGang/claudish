import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiskCacheV3 } from "./all-models-cache.js";
import { requiresResponsesApi } from "./provider-profiles.js";

const fixtureDir = mkdtempSync(join(tmpdir(), "responses-api-gate-"));
const cachePath = join(fixtureDir, "all-models.json");
const missingCachePath = join(fixtureDir, "missing-all-models.json");

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

const fixture: DiskCacheV3 = {
  catalogGenerationId: "test-generation",
  plans: [],
  version: 3,
  lastUpdated: new Date().toISOString(),
  entries: [
    {
      modelId: "acme-x1.0",
      aliases: ["openai/acme-x1.0"],

      contextWindow: 1050000,
      endpoints: { openai: { api: "responses" } },
      tokenParam: "max_output_tokens",
    },
    {
      modelId: "acme-x2.0",
      aliases: ["openai/acme-x2.0"],

      contextWindow: 1050000,
      endpoints: { openai: { toolsWithReasoning: "requires-responses" } },
      tokenParam: "max_output_tokens",
    },
    {
      modelId: "acme-x3.0",
      aliases: ["openai/acme-x3.0"],

      contextWindow: 1050000,
      tokenParam: "max_output_tokens",
    },
    {
      modelId: "acme-codex-x4.0",
      aliases: ["openai/acme-codex-x4.0"],

      contextWindow: 1050000,
      endpoints: { openai: { api: "chat-completions" } },
      tokenParam: "max_output_tokens",
    },
  ],
  models: [],
};
writeFileSync(cachePath, JSON.stringify(fixture));

describe("requiresResponsesApi with an isolated catalog", () => {
  test("A: the catalog API widens the gate for an unrelated name", () => {
    expect(requiresResponsesApi("acme-x1.0", cachePath)).toBe(true);
  });

  test("B: toolsWithReasoning alone widens the gate", () => {
    expect(requiresResponsesApi("acme-x2.0", cachePath)).toBe(true);
  });

  test("C: a catalog entry without endpoints does not require Responses", () => {
    expect(requiresResponsesApi("acme-x3.0", cachePath)).toBe(false);
  });

  test("D: a model absent from the catalog does not require Responses", () => {
    expect(requiresResponsesApi("acme-x5.0", cachePath)).toBe(false);
  });

  test("E: the catalog cannot narrow the codex name rule", () => {
    expect(requiresResponsesApi("acme-codex-x4.0", cachePath)).toBe(true);
  });

  test("F: a cold catalog falls back to the name rule", () => {
    expect(requiresResponsesApi("acme-codex-x6.0", missingCachePath)).toBe(true);
    expect(requiresResponsesApi("acme-x7.0", missingCachePath)).toBe(false);
  });
});
