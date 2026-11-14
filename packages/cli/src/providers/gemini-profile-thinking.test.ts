import { describe, expect, test } from "bun:test";
import { GeminiAPIFormat } from "../adapters/gemini-api-format.js";
import { ComposedHandler } from "../handlers/composed-handler.js";
import { getProviderByName, toRemoteProvider } from "./provider-definitions.js";
import {
  type AsyncProviderProfile,
  type ProfileContext,
  type ProviderProfile,
  antigravityProfile,
  geminiProfile,
  vertexProfile,
} from "./provider-profiles.js";

function context(provider: string, modelName: string): ProfileContext {
  return {
    provider: toRemoteProvider(getProviderByName(provider)!),
    modelName,
    targetModel: `${provider}@${modelName}`,
    apiKey: "test-key",
    port: 0,
    sharedOpts: {},
  };
}

async function thinkingConfigFrom(
  profile: ProviderProfile | AsyncProviderProfile,
  provider: string,
  modelName: string,
  req: Record<string, unknown>
): Promise<unknown> {
  const handler = await profile.createHandler(context(provider, modelName));
  expect(handler).toBeInstanceOf(ComposedHandler);
  try {
    const adapter = (handler as any).explicitAdapter;
    expect(adapter).toBeInstanceOf(GeminiAPIFormat);
    return adapter.buildPayload(req, [], []).generationConfig?.thinkingConfig;
  } finally {
    await handler?.shutdown();
  }
}

// REGRESSION: the Gemini dialect chose thinkingLevel or thinkingBudget from the model name.
describe("only the Antigravity profile keeps the model-name thinking rule", () => {
  test("antigravity@claude-sonnet-4-6 at effort high caps thinkingBudget below max_tokens", async () => {
    const cfg = (await thinkingConfigFrom(antigravityProfile, "antigravity", "claude-sonnet-4-6", {
      max_tokens: 16000,
      messages: [],
      output_config: { effort: "high" },
    })) as any;
    expect(cfg.thinkingBudget).toBe(8000);
  });

  test("google@gemini-4-carbon at effort high sends no thinkingConfig", async () => {
    const cfg = await thinkingConfigFrom(geminiProfile, "google", "gemini-4-carbon", {
      max_tokens: 32000,
      messages: [],
      output_config: { effort: "high" },
    });
    expect(cfg).toBeUndefined();
  });

  test("vertex@gemini-4-carbon at effort high sends no thinkingConfig", async () => {
    const names = ["VERTEX_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS", "VERTEX_LOCATION"];
    const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      process.env.VERTEX_PROJECT = "selected-project";
      process.env.GOOGLE_APPLICATION_CREDENTIALS = "/tmp/vertex-test-credentials";
      process.env.VERTEX_LOCATION = "us-central1";
      const cfg = await thinkingConfigFrom(vertexProfile, "vertex", "gemini-4-carbon", {
        max_tokens: 32000,
        messages: [],
        output_config: { effort: "high" },
      });
      expect(cfg).toBeUndefined();
    } finally {
      for (const name of names) {
        if (prior[name] === undefined) delete process.env[name];
        else process.env[name] = prior[name];
      }
    }
  });
});
