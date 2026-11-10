import { describe, expect, test } from "bun:test";

import {
  type ProviderResolution,
  type RescueOracle,
  getMissingKeyResolutions,
  rescueRoutableResolutions,
  resolveModelProvider,
} from "./provider-resolver.js";

function makeResolution(overrides: Partial<ProviderResolution> = {}): ProviderResolution {
  return {
    category: "direct-api",
    catalogName: "glm",
    providerName: "GLM",
    modelName: "glm-5-turbo",
    fullModelId: "glm-5-turbo",
    requiredApiKeyEnvVar: "ZHIPU_API_KEY",
    apiKeyAvailable: false,
    apiKeyDescription: "Zhipu API Key",
    apiKeyUrl: "https://open.bigmodel.cn/",
    ...overrides,
  };
}

// REQ-103: The launch rescue consumes a plan wrapped with optional explanation.
const routable: RescueOracle = async () => ({
  plan: {
    kind: "ok",
    primary: {
      provider: "openrouter",
      modelSpec: "openrouter@z-ai/glm-5-turbo",
      displayName: "OpenRouter",
    },
    fallbacks: [],
  },
});

const notRoutable: RescueOracle = async () => ({
  plan: {
    kind: "no-route",
    reason: "No credentialed provider in the routing chain",
  },
});

describe("resolveModelProvider", () => {
  test("classifies a bare non-Claude name as auto-route without requiring a key", () => {
    const resolution = resolveModelProvider("o4-mini");

    expect(resolution).toEqual(
      expect.objectContaining({
        category: "auto-route",
        catalogName: null,
        providerName: "unresolved (routed on the first request)",
        modelName: "o4-mini",
        fullModelId: "o4-mini",
        requiredApiKeyEnvVar: null,
        apiKeyAvailable: true,
      })
    );
    expect(getMissingKeyResolutions([resolution])).toEqual([]);
  });
});

describe("rescueRoutableResolutions", () => {
  test("routing chain overturns a missing-key verdict", async () => {
    const resolution = makeResolution();
    await rescueRoutableResolutions([resolution], routable);
    expect(resolution.apiKeyAvailable).toBe(true);
  });

  test("genuine missing key stays unavailable when there is no route", async () => {
    const resolution = makeResolution();
    await rescueRoutableResolutions([resolution], notRoutable);
    expect(resolution.apiKeyAvailable).toBe(false);
  });

  test("never creates a failure for an already-available resolution", async () => {
    let calls = 0;
    const router: RescueOracle = async () => {
      calls++;
      return { plan: { kind: "no-route", reason: "No route" } };
    };
    const resolution = makeResolution({ apiKeyAvailable: true });

    await rescueRoutableResolutions([resolution], router);

    expect(resolution.apiKeyAvailable).toBe(true);
    expect(calls).toBe(0);
  });

  test("does not consult the router when no key is required", async () => {
    let calls = 0;
    const router: RescueOracle = async () => {
      calls++;
      return { plan: { kind: "no-route", reason: "No route" } };
    };
    const resolution = makeResolution({
      requiredApiKeyEnvVar: null,
      apiKeyAvailable: false,
    });

    await rescueRoutableResolutions([resolution], router);

    expect(resolution.apiKeyAvailable).toBe(false);
    expect(calls).toBe(0);
  });

  test("a throwing router preserves the original verdict", async () => {
    const router: RescueOracle = async () => {
      throw new Error("routing unavailable");
    };
    const resolution = makeResolution();

    await rescueRoutableResolutions([resolution], router);

    expect(resolution.apiKeyAvailable).toBe(false);
  });

  test("asks the router about fullModelId", async () => {
    const specs: string[] = [];
    const router: RescueOracle = async (spec) => {
      specs.push(spec);
      return { plan: { kind: "no-route", reason: "No route" } };
    };

    await rescueRoutableResolutions([makeResolution()], router);

    expect(specs).toEqual(["glm-5-turbo"]);
  });

  test("handles mixed outcomes independently per resolution", async () => {
    const rescuable = makeResolution({ fullModelId: "glm-5-turbo" });
    const unavailable = makeResolution({
      catalogName: "openai",
      providerName: "OpenAI",
      modelName: "gpt-5",
      fullModelId: "openai@gpt-5",
      requiredApiKeyEnvVar: "OPENAI_API_KEY",
    });
    const alreadyAvailable = makeResolution({
      fullModelId: "google@gemini-2.5-pro",
      apiKeyAvailable: true,
    });
    const router: RescueOracle = async (spec) => ({
      plan:
        spec === "glm-5-turbo"
          ? {
              kind: "ok",
              primary: {
                provider: "openrouter",
                modelSpec: "openrouter@z-ai/glm-5-turbo",
                displayName: "OpenRouter",
              },
              fallbacks: [],
            }
          : { kind: "no-route", reason: "No route" },
    });

    await rescueRoutableResolutions([rescuable, unavailable, alreadyAvailable], router);

    expect([
      rescuable.apiKeyAvailable,
      unavailable.apiKeyAvailable,
      alreadyAvailable.apiKeyAvailable,
    ]).toEqual([true, false, true]);
  });

  test("empty input is a no-op", async () => {
    let calls = 0;
    const router: RescueOracle = async () => {
      calls++;
      return { plan: { kind: "no-route", reason: "No route" } };
    };

    await rescueRoutableResolutions([], router);

    expect(calls).toBe(0);
  });
});
