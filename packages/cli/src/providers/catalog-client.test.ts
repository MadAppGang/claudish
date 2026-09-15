import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  _resetCatalogClient,
  catalogWarmDisabled,
  refreshCatalog,
  resolveTargetForCatalog,
} from "./catalog-client.js";
import { parseModelSpec } from "./model-parser.js";

const realFetch = globalThis.fetch;
let previousDisableCatalogWarm: string | undefined;

beforeEach(() => {
  previousDisableCatalogWarm = process.env.CLAUDISH_DISABLE_CATALOG_WARM;
  _resetCatalogClient();
});

afterEach(() => {
  if (previousDisableCatalogWarm === undefined) {
    delete process.env.CLAUDISH_DISABLE_CATALOG_WARM;
  } else {
    process.env.CLAUDISH_DISABLE_CATALOG_WARM = previousDisableCatalogWarm;
  }
  globalThis.fetch = realFetch;
  _resetCatalogClient();
});

describe("refreshCatalog catalog-warm kill switch", () => {
  // This regression is a race: a sibling test's sticky empty-catalog override
  // could let the process exit before a live fetch reached the developer's
  // cache. The fetch assertion proves the kill switch returns before that path.
  test("returns disabled before network or disk side effects", async () => {
    process.env.CLAUDISH_DISABLE_CATALOG_WARM = "1";
    const fetchStub = mock(
      async () =>
        new Response(
          JSON.stringify({
            models: [
              {
                modelId: "offline-test-model",
                aliases: [],
                sources: { test: { externalId: "test/offline-test-model" } },
              },
            ],
            plans: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    );
    globalThis.fetch = fetchStub as unknown as typeof fetch;

    const outcome = await refreshCatalog(100);

    expect(outcome).toEqual({ kind: "fetch_failed", reason: "disabled" });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  test('recognizes only "1" as disabled', () => {
    expect(catalogWarmDisabled("1")).toBe(true);
  });

  // Pass negative values as arguments: putting them in the shared process env
  // would temporarily open the network gate this suite is meant to keep shut.
  for (const [label, switchValue] of [
    ['"true"', "true"],
    ['"0"', "0"],
    ['""', ""],
    ["undefined", undefined],
  ] as const) {
    test(`does not disable catalog warm for ${label}`, () => {
      expect(catalogWarmDisabled(switchValue)).toBe(false);
    });
  }
});

describe("resolveTargetForCatalog", () => {
  test("rewrites a changed explicit MiniMax spec and returns its resolution", () => {
    const resolution = {
      resolvedId: "MiniMax-M2.5",
      wasResolved: true,
      sourceLabel: "minimax catalog",
    };

    const result = resolveTargetForCatalog(
      "mm@minimax-m2.5",
      true,
      "minimax-m2.5",
      "minimax",
      () => resolution
    );

    expect(result).toEqual({
      target: "minimax@MiniMax-M2.5",
      resolution,
    });
    expect(parseModelSpec(result.target).isExplicitProvider).toBe(true);
  });

  test("preserves a bare MiniMax name and never resolves it", () => {
    let resolveCalls = 0;
    const result = resolveTargetForCatalog("minimax-m2.5", false, "minimax-m2.5", "minimax", () => {
      resolveCalls += 1;
      return {
        resolvedId: "MiniMax-M2.5",
        wasResolved: true,
        sourceLabel: "minimax catalog",
      };
    });

    // Rewriting this bare name would yield `minimax@MiniMax-M2.5`, which
    // parseModelSpec reads as an explicit provider and makes proxy-server skip
    // the routing chain. MiniMax is the only measured family whose wire id
    // differs from the typed name, so unaffected passthrough models cannot catch
    // this regression.
    expect(result).toEqual({ target: "minimax-m2.5", resolution: null });
    expect(parseModelSpec(result.target).isExplicitProvider).toBe(false);
    expect(resolveCalls).toBe(0);
  });

  test("keeps an unchanged explicit target but returns its resolution", () => {
    const resolution = {
      resolvedId: "glm-5.2",
      wasResolved: false,
      sourceLabel: "passthrough",
    };

    const result = resolveTargetForCatalog("glm@glm-5.2", true, "glm-5.2", "glm", () => resolution);

    expect(result).toEqual({ target: "glm@glm-5.2", resolution });
  });

  for (const [model, provider] of [
    ["glm-5.2", "glm"],
    ["kimi-k2.7", "kimi"],
  ] as const) {
    test(`leaves unaffected ${model} explicit and bare forms unchanged`, () => {
      const passthrough = () => ({
        resolvedId: model,
        wasResolved: false,
        sourceLabel: "passthrough",
      });
      const explicitTarget = `${provider}@${model}`;

      const explicit = resolveTargetForCatalog(explicitTarget, true, model, provider, passthrough);
      const bare = resolveTargetForCatalog(model, false, model, provider, passthrough);

      expect(explicit.target).toBe(explicitTarget);
      expect(explicit.resolution).not.toBeNull();
      expect(bare).toEqual({ target: model, resolution: null });
    });
  }
});
