import { describe, expect, test } from "bun:test";
import type { EffortLevel } from "../../adapters/base-api-format.js";
import type { DevinModelConfig } from "./devin-models.js";
import { resolveDevinModelUid } from "./model-id-resolver.js";

function servedModel(uid: string, family = "claude-opus-5"): DevinModelConfig {
  return {
    uid,
    family,
    displayName: `Synthetic ${uid}`,
    contextWindow: 123_456,
    maxOutput: 7_890,
    // Declares no axes on purpose: this suite pins the SPELLING fallback, the
    // path the 12 real uids that publish no `model_family_metadata` take.
    axes: [],
    isFamilyDefault: false,
    isRecommended: false,
  };
}

// Synthetic and injected: the resolver tests never fetch or pin a real roster.
const effortRoster = (["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map(
  (effort) => servedModel(`claude-opus-5-${effort}`)
);

describe("resolveDevinModelUid", () => {
  test("passes an exact served uid through untouched", () => {
    const roster = [servedModel("claude-opus-5-high"), servedModel("claude-opus-5-max-fast")];
    expect(resolveDevinModelUid("claude-opus-5-high", "low", roster)).toBe("claude-opus-5-high");
    expect(resolveDevinModelUid("claude-opus-5-max-fast", undefined, roster)).toBe(
      "claude-opus-5-max-fast"
    );
  });

  test("resolves a family plus effort to the suffixed uid", () => {
    expect(resolveDevinModelUid("claude-opus-5", "high", effortRoster)).toBe("claude-opus-5-high");
  });

  for (const effort of [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ] satisfies EffortLevel[]) {
    test(`supports the ${effort} effort vocabulary`, () => {
      expect(resolveDevinModelUid("claude-opus-5", effort, effortRoster)).toBe(
        `claude-opus-5-${effort}`
      );
    });
  }

  test("never selects a fast variant implicitly", () => {
    const roster = [servedModel("claude-opus-5-medium"), servedModel("claude-opus-5-max-fast")];

    expect(resolveDevinModelUid("claude-opus-5", "max", roster)).toBe("claude-opus-5-medium");
    expect(resolveDevinModelUid("claude-opus-5", undefined, roster)).toBe("claude-opus-5-medium");
  });

  test("passes an unknown model through unchanged", () => {
    expect(resolveDevinModelUid("unknown-model", "high", effortRoster)).toBe("unknown-model");
  });
});
