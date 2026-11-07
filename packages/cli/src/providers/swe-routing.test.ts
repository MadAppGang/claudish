import { describe, expect, test } from "bun:test";
import { parseModelSpec } from "./model-parser.js";
import { getProviderByName } from "./provider-definitions.js";
import { gatherRouteCandidates } from "./route-candidates.js";

describe("SWE model routing", () => {
  test("leaves bare swe-* names to auto-route without marking them explicit", () => {
    for (const modelId of ["swe-1.7", "SWE-1.7", "swe-2"]) {
      const parsed = parseModelSpec(modelId);

      expect(parsed.provider).toBe("auto-route");
      expect(parsed.isExplicitProvider).toBe(false);
    }
  });

  test("does not gather Devin from a swe-* spelling without an account list", () => {
    const gathered = gatherRouteCandidates(
      "swe-1.7",
      `${import.meta.dir}/fixtures/intentionally-missing-catalog.json`
    );
    expect(gathered.candidates.map(({ provider }) => provider)).not.toContain("devin");
  });

  test.each(["antigravity", "devin", "grok-subscription", "sakana-subscription"])(
    "%s declares no regex namespace claim",
    (provider) => {
      expect(getProviderByName(provider)?.nativeModelPatterns ?? []).toEqual([]);
    }
  );

  test("never auto-detects Devin's re-served vendor model collisions", () => {
    // A bare name keeps its vendor identity; account-listed candidates are gathered later.
    for (const modelId of [
      "claude-opus-5-medium",
      "gpt-5-6-luna-medium",
      "glm-5-2",
      "kimi-k3-high",
    ]) {
      expect(parseModelSpec(modelId).provider).not.toBe("devin");
    }
  });

  test("keeps explicit dv@swe-1.7 addressing working", () => {
    const parsed = parseModelSpec("dv@swe-1.7");

    expect(parsed.provider).toBe("devin");
    expect(parsed.model).toBe("swe-1.7");
    expect(parsed.isExplicitProvider).toBe(true);
  });
});
