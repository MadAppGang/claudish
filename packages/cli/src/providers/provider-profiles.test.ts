import { describe, expect, test } from "bun:test";
import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";
import { ComposedHandler } from "../handlers/composed-handler.js";
import { getProviderByName, toRemoteProvider } from "./provider-definitions.js";
import {
  type ProfileContext,
  openCodeZenProfile,
  openaiCodexProfile,
  openaiProfile,
  vertexProfile,
} from "./provider-profiles.js";
import { buildWireHandler } from "./wire-handler.js";

const catalogCachePath = new URL(
  "../test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json",
  import.meta.url
).pathname;
function context(provider: string, modelName: string): ProfileContext {
  return {
    provider: toRemoteProvider(getProviderByName(provider)!),
    modelName,
    targetModel: `${provider}@${modelName}`,
    apiKey: "test-key",
    port: 0,
    sharedOpts: {},
    catalogCachePath,
  };
}
async function describeHandler(provider: string, model: string) {
  const handler = await vertexProfile.createHandler(context(provider, model));
  expect(handler).toBeInstanceOf(ComposedHandler);
  try {
    return (handler as ComposedHandler).describeComposition();
  } finally {
    await handler?.shutdown();
  }
}

for (const provider of ["openai", "opencode-zen", "opencode-zen-go"]) {
  for (const model of [
    "qwen3.7-plus",
    "claude-opus-5",
    "minimax-m3",
    "gpt-6.1-sol",
    "grok-4.7",
    "codex-mini-latest",
  ]) {
    test(`${provider}@${model} off catalog uses OpenAIAPIFormat and the configured chat endpoint`, async () => {
      const ctx = context(provider, model);
      const factory = provider === "openai" ? openaiProfile : openCodeZenProfile;
      const handler = factory.createHandler(ctx);
      expect(handler).toBeInstanceOf(ComposedHandler);
      try {
        expect((handler as any).explicitAdapter).toBeInstanceOf(OpenAIAPIFormat);
        expect((handler as ComposedHandler).describeComposition()).toEqual({
          transport: provider,
          streamFormat: "openai-sse",
          endpoint: ctx.provider.baseUrl + ctx.provider.apiPath,
        });
      } finally {
        await handler?.shutdown();
      }
    });
  }
}

for (const [provider, model, streamFormat, endpoint] of [
  [
    "opencode-zen-go",
    "grok-4.7",
    "openai-responses-sse",
    "https://opencode.ai/zen/go/v1/responses",
  ],
  ["opencode-zen-go", "minimax-m3", "anthropic-sse", "https://opencode.ai/zen/go/v1/messages"],
  ["opencode-zen", "minimax-m3", "openai-sse", "https://opencode.ai/zen/v1/chat/completions"],
  ["openai", "gpt-6.1-sol", "openai-responses-sse", "https://api.openai.com/v1/responses"],
  ["poe", "grok-4.7", "openai-sse", "https://api.poe.com/v1/chat/completions"],
]) {
  test(`${provider}@${model} composition comes from its published wire`, async () => {
    const result = await buildWireHandler(context(provider!, model!), provider!);
    if (result.kind !== "handler") throw new Error(JSON.stringify(result));
    try {
      expect(result.handler).toBeInstanceOf(ComposedHandler);
      expect((result.handler as ComposedHandler).describeComposition()).toEqual({
        transport: provider,
        streamFormat,
        endpoint,
      });
    } finally {
      await result.handler.shutdown();
    }
  });
}

test.each(["gpt-5.3-codex", "gpt-4o"])(
  "Codex off-catalog profile uses Responses for %s",
  async (model) => {
    const handler = openaiCodexProfile.createHandler(context("openai-codex", model));
    try {
      expect((handler as ComposedHandler).describeComposition()).toEqual({
        transport: "openai-codex",
        streamFormat: "openai-responses-sse",
        endpoint: "https://api.openai.com/v1/responses",
      });
    } finally {
      await handler?.shutdown();
    }
  }
);

describe("Vertex project-aware composition", () => {
  test("a selected project constructs its regional OAuth endpoint even with an Express key", async () => {
    const prior = {
      project: process.env.VERTEX_PROJECT,
      key: process.env.VERTEX_API_KEY,
      credentials: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      location: process.env.VERTEX_LOCATION,
    };
    try {
      process.env.VERTEX_PROJECT = "selected-project";
      process.env.VERTEX_API_KEY = "express-key";
      process.env.GOOGLE_APPLICATION_CREDENTIALS = "/tmp/vertex-test-credentials";
      process.env.VERTEX_LOCATION = "us-central1";
      expect(await describeHandler("vertex", "gemini-3.6-flash")).toEqual({
        transport: "vertex",
        streamFormat: "gemini-sse",
        endpoint:
          "https://us-central1-aiplatform.googleapis.com/v1/projects/selected-project/locations/us-central1/publishers/google/models/gemini-3.6-flash:streamGenerateContent?alt=sse",
      });
    } finally {
      if (prior.project === undefined) delete process.env.VERTEX_PROJECT;
      else process.env.VERTEX_PROJECT = prior.project;
      if (prior.key === undefined) delete process.env.VERTEX_API_KEY;
      else process.env.VERTEX_API_KEY = prior.key;
      if (prior.credentials === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      else process.env.GOOGLE_APPLICATION_CREDENTIALS = prior.credentials;
      if (prior.location === undefined) delete process.env.VERTEX_LOCATION;
      else process.env.VERTEX_LOCATION = prior.location;
    }
  });
});
