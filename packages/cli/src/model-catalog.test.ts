import { catalogRouteForProvider } from "./providers/catalog-route-bindings.js";
/**
 * E2E tests for the model catalog and translation layer.
 *
 * Four test groups:
 *   Group 1: Model catalog unit tests — validate lookupModel() against a seeded mock cache
 *   Group 2: Dialect integration tests — validate each dialect uses catalog
 *   Group 3: Real API E2E tests (MiniMax) — hits real API endpoints
 *   Group 4: Full pipeline integration — verify AnthropicAPIFormat + MiniMaxModelDialect
 *
 * Group 3 is skipped unless MINIMAX_CODING_API_KEY or MINIMAX_API_KEY is set.
 *
 * Groups 1, 2, 4 use a temp-file mock cache so assertions are hermetic and
 * don't depend on the user's ~/.claudish/all-models.json.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicAPIFormat } from "./adapters/anthropic-api-format.js";
import { GLMModelDialect } from "./adapters/glm-model-dialect.js";
import { MiniMaxModelDialect } from "./adapters/minimax-model-dialect.js";
import {
  lookupModel,
  lookupModelForProvider,
  searchCatalogModels,
} from "./adapters/model-catalog.js";

const MINIMAX_API_KEY = process.env.MINIMAX_CODING_API_KEY || process.env.MINIMAX_API_KEY;
const SKIP_REAL_API = !MINIMAX_API_KEY;
// Choose the host by key type because PAYG and coding are separate credential silos.
const MINIMAX_API_BASE = process.env.MINIMAX_CODING_API_KEY
  ? "https://api.minimax.io/anthropic/v1/messages"
  : "https://api.minimaxi.com/anthropic/v1/messages";

// ─── Mock slim-cache seeding ─────────────────────────────────────────────────

let tmpDir: string;
let mockCachePath: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claudish-catalog-test-"));
  mockCachePath = join(tmpDir, "all-models.json");

  const entries = [
    {
      modelId: "minimax-m2.7",
      aliases: ["MiniMax-M2.7", "minimax-m2-7"],

      contextWindow: 204_800,
      supportsVision: false,
    },
    {
      modelId: "minimax-m2.5",
      aliases: ["MiniMax-M2.5", "minimax-m2-5"],

      contextWindow: 204_800,
      supportsVision: false,
    },
    {
      modelId: "minimax-m1",
      aliases: [],

      contextWindow: 1_000_000,
      supportsVision: false,
    },
    {
      modelId: "minimax-01",
      aliases: [],

      contextWindow: 1_000_000,
      supportsVision: false,
    },
    {
      modelId: "grok-4",
      aliases: [],

      contextWindow: 256_000,
    },
    {
      modelId: "gpt-5.6-sol",
      aliases: [],

      contextWindow: 1_050_000,
      aggregators: [
        {
          sourceCollectorId: "test",
          routeStatus: "mapped",
          route: catalogRouteForProvider("openai"),
          sourceProviderId: "openai",
          externalModelId: "gpt-5.6-sol",
          confidence: "api_official",
          contextWindow: 1_050_000,
        },
        {
          sourceCollectorId: "test",
          routeStatus: "mapped",
          route: catalogRouteForProvider("openai-codex"),
          sourceProviderId: "openai-codex",
          externalModelId: "gpt-5.6-sol",
          confidence: "api_official",
          contextWindow: 372_000,
        },
        {
          sourceCollectorId: "test",
          routeStatus: "mapped",
          route: catalogRouteForProvider("openrouter"),
          sourceProviderId: "openrouter",
          externalModelId: "openai/gpt-5.6-sol",
          confidence: "gateway_official",
        },
      ],
    },
    {
      modelId: "grok-4-fast",
      aliases: ["x-ai/grok-4-fast"],

      contextWindow: 2_000_000,
    },
    {
      modelId: "grok-3",
      aliases: [],

      contextWindow: 131_072,
    },
    {
      modelId: "glm-5",
      aliases: [],

      contextWindow: 204_800,
      supportsVision: true,
    },
    {
      modelId: "glm-4-long",
      aliases: [],

      contextWindow: 1_000_000,
    },
    {
      modelId: "glm-4v",
      aliases: [],

      contextWindow: 128_000,
      supportsVision: true,
    },
    {
      modelId: "glm-4-flash",
      aliases: [],

      contextWindow: 128_000,
      supportsVision: false,
    },
    {
      modelId: "glm-5-turbo",
      aliases: [],

      contextWindow: 202_752,
    },
    {
      modelId: "kimi-k3",
      aliases: ["moonshotai/kimi-k3", "k3"],

      subscriptionPlanIds: ["kimi-coding", "opencode-zen-go"],
    },
    {
      modelId: "kimi-k3-256k",
      aliases: [],

      releaseDate: "2026-07-16",
    },
    {
      modelId: "kimi-k3-fast",
      aliases: [],
    },
    {
      modelId: "kimi-k2.6",
      aliases: [],
    },
  ];

  writeFileSync(
    mockCachePath,
    JSON.stringify({
      catalogGenerationId: "test-generation",
      plans: [],
      version: 3,
      lastUpdated: new Date().toISOString(),
      entries,
      models: entries.map((e) => ({ id: e.modelId })),
    }),
    "utf-8"
  );
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Group 1: Model Catalog Unit Tests ───────────────────────────────────────

describe("Group 1: Model Catalog — lookupModel()", () => {
  test("MiniMax-M2.7 alias → contextWindow 204800, supportsVision false", () => {
    const entry = lookupModel("MiniMax-M2.7", mockCachePath);
    expect(entry).toBeDefined();
    expect(entry!.contextWindow).toBe(204_800);
    expect(entry!.supportsVision).toBe(false);
  });

  test("minimax-m2.5 alias → contextWindow 204800", () => {
    const entry = lookupModel("minimax-m2.5", mockCachePath);
    expect(entry).toBeDefined();
    expect(entry!.contextWindow).toBe(204_800);
    expect(entry!.supportsVision).toBe(false);
  });

  test("grok-4 → contextWindow 256000", () => {
    const entry = lookupModel("grok-4", mockCachePath);
    expect(entry).toBeDefined();
    expect(entry!.contextWindow).toBe(256_000);
  });

  test("glm-5 → contextWindow 204800, supportsVision true", () => {
    const entry = lookupModel("glm-5", mockCachePath);
    expect(entry).toBeDefined();
    expect(entry!.contextWindow).toBe(204_800);
    expect(entry!.supportsVision).toBe(true);
  });

  test("x-ai/grok-4-fast vendor prefix → contextWindow 2000000", () => {
    const entry = lookupModel("x-ai/grok-4-fast", mockCachePath);
    expect(entry).toBeDefined();
    expect(entry!.contextWindow).toBe(2_000_000);
  });

  test("unknown model → undefined", () => {
    expect(lookupModel("unknown-model", mockCachePath)).toBeUndefined();
  });

  test("provider-routed ID throws (contract enforcement)", () => {
    expect(() => lookupModel("zai@glm-4.7", mockCachePath)).toThrow("@");
  });

  test("no cache file → undefined (cold start)", () => {
    const nonexistent = join(tmpDir, "does-not-exist.json");
    expect(lookupModel("glm-5", nonexistent)).toBeUndefined();
  });
});

describe("Group 1: Model Catalog — lookupModelForProvider()", () => {
  test("openai-codex provider → provider-specific contextWindow 372000", () => {
    expect(lookupModelForProvider("gpt-5.6-sol", "openai-codex", mockCachePath)).toBe(372_000);
  });

  test("openai provider → provider-specific contextWindow 1050000", () => {
    expect(lookupModelForProvider("gpt-5.6-sol", "openai", mockCachePath)).toBe(1_050_000);
  });

  test("aggregator without contextWindow → falls back to top-level contextWindow", () => {
    expect(lookupModelForProvider("gpt-5.6-sol", "openrouter", mockCachePath)).toBe(1_050_000);
  });

  test("provider without matching aggregator → falls back to top-level contextWindow", () => {
    expect(lookupModelForProvider("gpt-5.6-sol", "some-other-provider", mockCachePath)).toBe(
      1_050_000
    );
  });

  test("model without aggregators → returns top-level contextWindow", () => {
    expect(lookupModelForProvider("grok-4", "openai-codex", mockCachePath)).toBe(256_000);
  });

  test("unknown model → undefined", () => {
    expect(lookupModelForProvider("unknown-model", "openai-codex", mockCachePath)).toBeUndefined();
  });

  test("provider-routed ID throws (contract enforcement)", () => {
    expect(() => lookupModelForProvider("cx@gpt-5.6-sol", "openai-codex", mockCachePath)).toThrow(
      "@"
    );
  });
});

describe("searchCatalogModels", () => {
  test("resolves an exact alias to the catalog identity and reports the alias", () => {
    const results = searchCatalogModels("k3", 10, mockCachePath);

    expect(results[0]?.modelId).toBe("kimi-k3");
    expect(results[0]?.matchedAlias).toBe("k3");
  });

  test("leaves matchedAlias unset for an exact model id", () => {
    const results = searchCatalogModels("kimi-k3", 10, mockCachePath);

    expect(results[0]?.modelId).toBe("kimi-k3");
    expect(results[0]?.matchedAlias).toBeUndefined();
  });

  test("ranks the shorter canonical model ahead of a newer dated variant", () => {
    const results = searchCatalogModels("kimi", 10, mockCachePath);

    expect(results[0]?.modelId).toBe("kimi-k3");
  });

  test("ranks an exact alias ahead of partial model id matches", () => {
    const results = searchCatalogModels("k3", 10, mockCachePath);

    expect(results[0]?.modelId).toBe("kimi-k3");
    expect(results[0]?.matchedAlias).toBe("k3");
    expect(results.slice(1).some((result) => result.modelId === "kimi-k3-256k")).toBe(true);
  });

  test("preserves subscription plans and defaults missing plans to an empty array", () => {
    const withPlans = searchCatalogModels("kimi-k3", 10, mockCachePath);
    const withoutPlans = searchCatalogModels("kimi-k3-fast", 10, mockCachePath);

    expect(withPlans[0]?.subscriptionPlanIds).toEqual(["kimi-coding", "opencode-zen-go"]);
    expect(withoutPlans[0]?.subscriptionPlanIds).toEqual([]);
  });

  test("matches model ids case-insensitively", () => {
    const results = searchCatalogModels("KIMI-K3", 10, mockCachePath);

    expect(results[0]?.modelId).toBe("kimi-k3");
  });

  test("matches vendor-prefixed queries to the bare catalog identity", () => {
    const results = searchCatalogModels("moonshotai/kimi-k3", 10, mockCachePath);

    expect(results[0]?.modelId).toBe("kimi-k3");
  });

  test("returns no more than the requested limit", () => {
    const results = searchCatalogModels("kimi", 2, mockCachePath);

    expect(results).toHaveLength(2);
  });

  test("returns no matches for empty or whitespace-only queries", () => {
    expect(searchCatalogModels("", 10, mockCachePath)).toEqual([]);
    expect(searchCatalogModels("   ", 10, mockCachePath)).toEqual([]);
  });

  test("returns no matches when the cache is missing or unreadable", () => {
    const missingCachePath = join(tmpDir, "missing-search-cache.json");
    const unreadableCachePath = join(tmpDir, "unreadable-search-cache.json");
    writeFileSync(unreadableCachePath, "not valid json", "utf-8");

    expect(searchCatalogModels("kimi", 10, missingCachePath)).toEqual([]);
    expect(searchCatalogModels("kimi", 10, unreadableCachePath)).toEqual([]);
  });

  test("returns no matches when the query does not match the catalog", () => {
    expect(searchCatalogModels("definitely-not-a-model", 10, mockCachePath)).toEqual([]);
  });
});

// ─── Group 2: Dialect Integration Tests ──────────────────────────────────────

describe("Group 2: MiniMaxModelDialect — catalog integration", () => {
  // NOTE: these tests rely on the default cache at ~/.claudish/all-models.json
  // being populated. On a fresh install, all getContextWindow() calls return 0.
  // Jack's workstation has a warm cache; CI should run the mockCache-seeded
  // equivalents in Group 1 instead.

  test("temperature 0 is clamped to 0.01", () => {
    const dialect = new MiniMaxModelDialect("MiniMax-M2.7");
    const request: any = { temperature: 0, messages: [], max_tokens: 50 };
    dialect.prepareRequest(request, request);
    expect(request.temperature).toBe(0.01);
  });

  test("temperature 1.5 is clamped to 1.0", () => {
    const dialect = new MiniMaxModelDialect("MiniMax-M2.7");
    const request: any = { temperature: 1.5, messages: [], max_tokens: 50 };
    dialect.prepareRequest(request, request);
    expect(request.temperature).toBe(1.0);
  });

  test("temperature 0.7 is unchanged (within range)", () => {
    const dialect = new MiniMaxModelDialect("MiniMax-M2.7");
    const request: any = { temperature: 0.7, messages: [], max_tokens: 50 };
    dialect.prepareRequest(request, request);
    expect(request.temperature).toBe(0.7);
  });

  test("thinking maps to MiniMax's {type:adaptive} toggle (not passed through verbatim)", () => {
    const dialect = new MiniMaxModelDialect("MiniMax-M2.7");
    const originalRequest: any = {
      // Legacy budget hint resolves to an effort level → MiniMax's `adaptive`
      // enable value (its Anthropic-compatible endpoint takes adaptive/disabled,
      // NOT "enabled" and NOT a budget).
      thinking: { type: "enabled", budget_tokens: 10000 },
      messages: [],
      max_tokens: 100,
    };
    const request: any = { ...originalRequest };
    dialect.prepareRequest(request, originalRequest);
    expect(request.thinking).toBeDefined();
    expect(request.thinking.type).toBe("adaptive");
    expect(request.thinking.budget_tokens).toBeUndefined();
  });
});

describe("Group 2: GLMModelDialect — prepareRequest", () => {
  test("glm-5 converts Anthropic budget thinking to GLM's toggle", () => {
    const dialect = new GLMModelDialect("glm-5");
    const originalRequest: any = {
      thinking: { type: "enabled", budget_tokens: 5000 },
      messages: [],
    };
    const request: any = { ...originalRequest };
    dialect.prepareRequest(request, originalRequest);
    expect(request.thinking).toEqual({ type: "enabled" });
    expect(request.thinking.budget_tokens).toBeUndefined();
  });

  test("pre-4.5 GLM strips Anthropic budget thinking", () => {
    const dialect = new GLMModelDialect("glm-4-plus");
    const originalRequest: any = {
      thinking: { type: "enabled", budget_tokens: 5000 },
      messages: [],
    };
    const request: any = { ...originalRequest };
    dialect.prepareRequest(request, originalRequest);
    expect(request.thinking).toBeUndefined();
  });
});

// ─── Group 3: Real API E2E Tests (MiniMax) ───────────────────────────────────

describe.skipIf(SKIP_REAL_API)("Group 3: Real API — MiniMax E2E", () => {
  test("basic text response from MiniMax-M2.7", async () => {
    // M2.7 always emits a thinking block before the text block.
    // Use max_tokens: 300 so the model has room for both thinking and text.
    const response = await fetch(MINIMAX_API_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MINIMAX_API_KEY}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "MiniMax-M2.7",
        max_tokens: 300,
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.content).toBeDefined();
    expect(data.content.length).toBeGreaterThan(0);
    const textBlock = data.content.find((b: any) => b.type === "text");
    expect(textBlock).toBeDefined();
    expect(textBlock.text.toLowerCase()).toContain("ok");
  }, 30000);

  test("temperature=0 is accepted after dialect clamps to 0.01", async () => {
    const dialect = new MiniMaxModelDialect("MiniMax-M2.7");

    const request: any = {
      model: "MiniMax-M2.7",
      // Use 300 so M2.7 has room for both thinking block and text response
      max_tokens: 300,
      temperature: 0,
      messages: [{ role: "user", content: "Reply with: yes" }],
    };

    dialect.prepareRequest(request, { ...request });

    // Clamping must have happened before hitting the API
    expect(request.temperature).toBe(0.01);

    const response = await fetch(MINIMAX_API_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MINIMAX_API_KEY}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(request),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.content).toBeDefined();
    expect(data.content.length).toBeGreaterThan(0);
  }, 30000);

  test("streaming returns valid Anthropic SSE events", async () => {
    // M2.7 always produces a thinking block before text; use 300 tokens so
    // both are emitted and we see the full standard SSE event sequence.
    const response = await fetch(MINIMAX_API_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MINIMAX_API_KEY}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "MiniMax-M2.7",
        max_tokens: 300,
        stream: true,
        messages: [{ role: "user", content: "Reply with: hi" }],
      }),
    });

    expect(response.status).toBe(200);

    const text = await response.text();
    const lines = text.split("\n");
    const eventTypes = lines
      .filter((l) => l.startsWith("event: "))
      .map((l) => l.replace("event: ", "").trim());

    expect(eventTypes).toContain("message_start");
    expect(eventTypes).toContain("message_stop");
    expect(eventTypes.some((t) => t === "content_block_start")).toBe(true);
  }, 30000);

  test("thinking blocks are returned for M2.7 by default", async () => {
    // M2.7 always produces a thinking block. Use max_tokens: 300 so there is
    // room for both the thinking block and the final text answer.
    const response = await fetch(MINIMAX_API_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MINIMAX_API_KEY}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "MiniMax-M2.7",
        max_tokens: 300,
        messages: [{ role: "user", content: "What is 2+2? Be brief." }],
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.content).toBeDefined();

    // M2.7 returns thinking blocks by default
    const thinkingBlock = data.content.find((b: any) => b.type === "thinking");
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock.thinking).toBeTruthy();

    // Also has a text answer
    const textBlock = data.content.find((b: any) => b.type === "text");
    expect(textBlock).toBeDefined();
  }, 30000);

  test("invalid API key returns 401", async () => {
    const response = await fetch(MINIMAX_API_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer invalid-key-12345",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "MiniMax-M2.7",
        max_tokens: 50,
        messages: [{ role: "user", content: "test" }],
      }),
    });

    expect(response.status).toBe(401);
  }, 10000);
});

// ─── Group 4: Full Pipeline Integration (no API calls) ───────────────────────

describe("Group 4: AnthropicAPIFormat + MiniMaxModelDialect pipeline", () => {
  function buildMinimaxPayload(claudeRequest: any, modelId = "MiniMax-M2.7"): any {
    const format = new AnthropicAPIFormat(modelId, "minimax");
    const dialect = new MiniMaxModelDialect(modelId);

    const messages = format.convertMessages(claudeRequest);
    const tools = format.convertTools(claudeRequest);
    const payload = format.buildPayload(claudeRequest, messages, tools);

    // Layer 2: dialect post-processing
    dialect.prepareRequest(payload, claudeRequest);

    return payload;
  }

  test("thinking maps to {type:adaptive} (not reasoning_split, not a budget)", () => {
    const claudeRequest = {
      model: "MiniMax-M2.7",
      max_tokens: 100,
      thinking: { type: "enabled", budget_tokens: 8000 },
      messages: [{ role: "user", content: "Hello" }],
    };

    const payload = buildMinimaxPayload(claudeRequest);

    // MiniMax's Anthropic-compatible endpoint takes a {type:adaptive|disabled}
    // toggle, NOT a budget. The legacy budget hint resolves to an effort level
    // which maps to `adaptive`.
    expect(payload.thinking).toBeDefined();
    expect(payload.thinking.type).toBe("adaptive");
    expect(payload.thinking.budget_tokens).toBeUndefined();
    // Must not have been converted to reasoning_effort or reasoning_split
    expect(payload.reasoning_effort).toBeUndefined();
    expect(payload.reasoning_split).toBeUndefined();
  });

  test("temperature=0 is clamped to 0.01 by dialect", () => {
    const claudeRequest = {
      model: "MiniMax-M2.7",
      max_tokens: 50,
      temperature: 0,
      messages: [{ role: "user", content: "Hello" }],
    };

    const payload = buildMinimaxPayload(claudeRequest);

    expect(payload.temperature).toBe(0.01);
  });

  test("tools pass through in Anthropic format", () => {
    const claudeRequest = {
      model: "MiniMax-M2.7",
      max_tokens: 200,
      messages: [{ role: "user", content: "What files exist?" }],
      tools: [
        {
          name: "list_files",
          description: "List files in a directory",
          input_schema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Directory path" },
            },
            required: ["path"],
          },
        },
      ],
    };

    const payload = buildMinimaxPayload(claudeRequest);

    expect(payload.tools).toBeDefined();
    expect(payload.tools).toHaveLength(1);
    expect(payload.tools[0].name).toBe("list_files");
    expect(payload.tools[0].description).toBe("List files in a directory");
    expect(payload.tools[0].input_schema).toBeDefined();
    // Anthropic format uses input_schema (not parameters like OpenAI)
    expect(payload.tools[0].parameters).toBeUndefined();
  });

  test("system prompt is present in payload", () => {
    const claudeRequest = {
      model: "MiniMax-M2.7",
      max_tokens: 50,
      system: "You are a helpful assistant.",
      messages: [{ role: "user", content: "Hello" }],
    };

    const payload = buildMinimaxPayload(claudeRequest);

    expect(payload.system).toBe("You are a helpful assistant.");
  });

  test("payload includes correct model ID and max_tokens", () => {
    const claudeRequest = {
      model: "MiniMax-M2.7",
      max_tokens: 512,
      messages: [{ role: "user", content: "Hello" }],
    };

    const payload = buildMinimaxPayload(claudeRequest, "MiniMax-M2.7");

    expect(payload.model).toBe("MiniMax-M2.7");
    expect(payload.max_tokens).toBe(512);
  });

  test("messages are passed through with correct structure", () => {
    const claudeRequest = {
      model: "MiniMax-M2.7",
      max_tokens: 50,
      messages: [
        { role: "user", content: "First message" },
        { role: "assistant", content: "First response" },
        { role: "user", content: "Second message" },
      ],
    };

    const payload = buildMinimaxPayload(claudeRequest);

    expect(payload.messages).toHaveLength(3);
    expect(payload.messages[0].role).toBe("user");
    expect(payload.messages[1].role).toBe("assistant");
    expect(payload.messages[2].role).toBe("user");
  });
});
