import { describe, expect, test } from "bun:test";
import type { ModelDoc } from "../model-loader.js";
import { detectFamilyFreshness } from "./model-freshness.js";

function model(overrides: Partial<ModelDoc> & Pick<ModelDoc, "modelId">): ModelDoc {
  return {
    provider: "anthropic",
    status: "active",
    ...overrides,
  };
}

describe("detectFamilyFreshness", () => {
  test("detects Fable 5.1 as newer than Fable 5", () => {
    const models = [
      model({ modelId: "claude-fable-5", releaseDate: "2026-06-09" }),
      model({ modelId: "claude-fable-5-1", releaseDate: "2026-09-01" }),
    ];
    expect(detectFamilyFreshness("fable", "claude-fable-5", models)).toEqual({
      family: "fable",
      current: "claude-fable-5",
      latest: "claude-fable-5-1",
      releaseDate: "2026-09-01",
      status: "newer-candidate",
    });
    expect(detectFamilyFreshness("fable", "claude-fable-5-1[1m]", models).status).toBe(
      "up-to-date"
    );
  });

  test("keeps base Astra separate from Pro and preview variants", () => {
    const models = [
      model({ modelId: "gpt-6-astra", provider: "openai", releaseDate: "2026-09-03" }),
      model({ modelId: "gpt-6-astra-pro", provider: "openai", releaseDate: "2026-09-04" }),
      model({ modelId: "gpt-7-astra-preview", provider: "openai", releaseDate: "2026-10-01" }),
    ];
    const result = detectFamilyFreshness("astra", "cx@gpt-5-astra", models);
    expect(result.latest).toBe("gpt-6-astra");
    expect(result.status).toBe("newer-candidate");
  });

  test("filters wrong providers and alias-only collisions", () => {
    const models = [
      model({ modelId: "vendor-fable-9", provider: "other", aliases: ["fable"] }),
      model({ modelId: "gpt-9-astra", provider: "other" }),
    ];
    expect(detectFamilyFreshness("fable", "claude-fable-5-1", models).status).toBe("unknown");
    expect(detectFamilyFreshness("astra", "gpt-6-astra", models).status).toBe("unknown");
  });
});
