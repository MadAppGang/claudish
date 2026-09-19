import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProviderByName, toRemoteProvider } from "./provider-definitions.js";
import { createHandlerForProvider } from "./provider-profiles.js";

// The composition table must not read the ambient ~/.claudish/all-models.json.
const fixtureDir = mkdtempSync(join(tmpdir(), "provider-profiles-"));
const catalogCachePath = join(fixtureDir, "all-models.json");

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

writeFileSync(
  catalogCachePath,
  JSON.stringify({
    catalogGenerationId: "test-generation",
    plans: [],
    version: 3,
    lastUpdated: new Date().toISOString(),
    entries: [
      {
        modelId: "acme-responses-x1.0",
        aliases: [],

        endpoints: {
          openai: { api: "responses", toolsWithReasoning: "requires-responses" },
        },
        tokenParam: "max_output_tokens",
      },
    ],
    models: [],
  })
);

interface Composition {
  transport: string;
  streamFormat: string;
  endpoint: string;
}

async function describeHandler(providerName: string, modelName: string): Promise<Composition> {
  const def = getProviderByName(providerName)!;
  const handler: any = await createHandlerForProvider({
    provider: toRemoteProvider(def),
    modelName,
    apiKey: "test-key",
    targetModel: modelName,
    port: 1234,
    sharedOpts: {},
    catalogCachePath,
  } as any);

  return handler.describeComposition();
}

const expectedCompositions = [
  {
    provider: "opencode-zen-go",
    model: "minimax-m2.5",
    streamFormat: "anthropic-sse",
    endpoint: "https://opencode.ai/zen/go/v1/messages",
  },
  {
    provider: "opencode-zen-go",
    model: "glm-5",
    streamFormat: "openai-sse",
    endpoint: "https://opencode.ai/zen/go/v1/chat/completions",
  },
  {
    provider: "opencode-zen-go",
    model: "gpt-5.6-luna",
    streamFormat: "openai-responses-sse",
    endpoint: "https://opencode.ai/zen/go/v1/responses",
  },
  {
    provider: "opencode-zen",
    model: "minimax-m2.5",
    streamFormat: "openai-sse",
    endpoint: "https://opencode.ai/zen/v1/chat/completions",
  },
  {
    provider: "opencode-zen",
    model: "glm-5",
    streamFormat: "openai-sse",
    endpoint: "https://opencode.ai/zen/v1/chat/completions",
  },
  {
    provider: "opencode-zen",
    model: "gpt-5.6-luna",
    streamFormat: "openai-responses-sse",
    endpoint: "https://opencode.ai/zen/v1/responses",
  },
  {
    provider: "opencode-zen-go",
    model: "qwen3.7-plus",
    streamFormat: "anthropic-sse",
    endpoint: "https://opencode.ai/zen/go/v1/messages",
  },
  {
    provider: "opencode-zen",
    model: "qwen3.7-max",
    streamFormat: "anthropic-sse",
    endpoint: "https://opencode.ai/zen/v1/messages",
  },
  {
    provider: "opencode-zen",
    model: "claude-fable-5",
    streamFormat: "anthropic-sse",
    endpoint: "https://opencode.ai/zen/v1/messages",
  },
  {
    provider: "opencode-zen",
    model: "grok-4.5",
    streamFormat: "openai-responses-sse",
    endpoint: "https://opencode.ai/zen/v1/responses",
  },
] as const;

describe("OpenCode Zen provider composition", () => {
  for (const row of expectedCompositions) {
    test(`${row.provider} ${row.model} uses ${row.streamFormat} at ${row.endpoint}`, async () => {
      expect(await describeHandler(row.provider, row.model)).toEqual({
        transport: row.provider,
        streamFormat: row.streamFormat,
        endpoint: row.endpoint,
      });
    });
  }

  test("Go MiniMax and metered Zen MiniMax use their documented distinct APIs", async () => {
    expect(
      (await describeHandler("opencode-zen-go", "minimax-m3")).endpoint.endsWith("/v1/messages")
    ).toBe(true);
    expect(
      (await describeHandler("opencode-zen", "minimax-m3")).endpoint.endsWith(
        "/v1/chat/completions"
      )
    ).toBe(true);
  });
});

describe("Poe gateway composition", () => {
  test("builds a callable OpenAI-compatible handler", async () => {
    expect(await describeHandler("poe", "GPT-4o")).toEqual({
      transport: "poe",
      streamFormat: "openai-sse",
      endpoint: "https://api.poe.com/v1/chat/completions",
    });
  });
});

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

describe("OpenAI Responses-API gate", () => {
  const responsesComposition = {
    transport: "openai",
    streamFormat: "openai-responses-sse",
    endpoint: "https://api.openai.com/v1/responses",
  } as const;
  const chatCompletionsComposition = {
    transport: "openai",
    streamFormat: "openai-sse",
    endpoint: "https://api.openai.com/v1/chat/completions",
  } as const;
  const openAICompositionCases = [
    { model: "acme-responses-x1.0", expected: responsesComposition },
    { model: "gpt-5.3-codex", expected: responsesComposition },
    { model: "gpt-5-codex", expected: responsesComposition },
    { model: "gpt-5.1-codex-max", expected: responsesComposition },
    { model: "gpt-5.1-codex-mini", expected: responsesComposition },
    { model: "GPT-5.1-CODEX-MINI", expected: responsesComposition },
    { model: "gpt-5.6-luna", expected: responsesComposition },
    { model: "gpt-5.6-sol", expected: responsesComposition },
    { model: "gpt-5.4", expected: chatCompletionsComposition },
    { model: "gpt-5.5", expected: chatCompletionsComposition },
    { model: "gpt-4o", expected: chatCompletionsComposition },
    { model: "gpt-5", expected: chatCompletionsComposition },
    { model: "gpt-5-mini", expected: chatCompletionsComposition },
  ] as const;

  for (const row of openAICompositionCases) {
    test(`openai ${row.model} uses ${row.expected.streamFormat} at ${row.expected.endpoint}`, async () => {
      expect(await describeHandler("openai", row.model)).toEqual(row.expected);
    });
  }

  test("a codex id routes to Responses regardless of where 'codex' appears in the name", async () => {
    expect(await describeHandler("openai", "codex-mini-latest")).toEqual(responsesComposition);
  });

  test("a codex id gets a Responses body AND a Responses endpoint (the two layers must agree)", async () => {
    for (const model of ["gpt-5.4-codex", "gpt-5.3-codex", "codex-mini-latest"]) {
      const composition = await describeHandler("openai", model);

      // The endpoint already follows the codex rule in transport/openai.ts:31,37;
      // streamFormat is what catches drift in the profile adapter choice.
      expect(composition.streamFormat).toBe("openai-responses-sse");
      expect(composition.endpoint.endsWith("/v1/responses")).toBe(true);
    }
  });

  test("a non-codex model keeps both layers on Chat Completions", async () => {
    const composition = await describeHandler("openai", "gpt-5.4");

    expect(composition.streamFormat).toBe("openai-sse");
    expect(composition.endpoint.endsWith("/v1/chat/completions")).toBe(true);
  });

  test("openai-codex remains Responses-only for codex and non-codex ids", async () => {
    const expected = { ...responsesComposition, transport: "openai-codex" };

    // This provider composes to Responses by construction, so the `openai` gate is not what decides it.
    expect(await describeHandler("openai-codex", "gpt-5.3-codex")).toEqual(expected);
    expect(await describeHandler("openai-codex", "gpt-4o")).toEqual(expected);
  });
});
