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

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookupModel } from "./adapters/model-catalog.js";
import { setMemCatalogForTests } from "./providers/catalog-resolvers/openrouter.js";
import type { SlimModelEntry } from "./providers/all-models-cache.js";
import { MiniMaxModelDialect } from "./adapters/minimax-model-dialect.js";
import { GLMModelDialect } from "./adapters/glm-model-dialect.js";
import { DialectManager } from "./adapters/dialect-manager.js";
import { AnthropicAPIFormat } from "./adapters/anthropic-api-format.js";

const MINIMAX_CODING_KEY = process.env.MINIMAX_CODING_API_KEY;
const MINIMAX_REGULAR_KEY = process.env.MINIMAX_API_KEY;
const MINIMAX_API_KEY = MINIMAX_CODING_KEY || MINIMAX_REGULAR_KEY;
const SKIP_REAL_API = !MINIMAX_API_KEY;
const MINIMAX_API_BASE = MINIMAX_CODING_KEY
  ? "https://api.minimax.io/anthropic/v1/messages"
  : "https://api.minimaxi.com/anthropic/v1/messages";

// ─── Mock slim-cache seeding ─────────────────────────────────────────────────

let tmpDir: string;
let mockCachePath: string;
const missingCachePath = () => join(tmpDir, "does-not-exist.json");

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claudish-catalog-test-"));
  mockCachePath = join(tmpDir, "all-models.json");

  const entries = [
    {
      modelId: "minimax-m2.7",
      aliases: ["MiniMax-M2.7", "minimax-m2-7"],
      sources: {},
      contextWindow: 204_800,
      supportsVision: false,
    },
    {
      modelId: "minimax-m2.5",
      aliases: ["MiniMax-M2.5", "minimax-m2-5"],
      sources: {},
      contextWindow: 204_800,
      supportsVision: false,
    },
    {
      modelId: "minimax-m1",
      aliases: [],
      sources: {},
      contextWindow: 1_000_000,
      supportsVision: false,
    },
    {
      modelId: "minimax-01",
      aliases: [],
      sources: {},
      contextWindow: 1_000_000,
      supportsVision: false,
    },
    {
      modelId: "grok-4",
      aliases: [],
      sources: {},
      contextWindow: 256_000,
    },
    {
      modelId: "grok-4-fast",
      aliases: ["x-ai/grok-4-fast"],
      sources: {},
      contextWindow: 2_000_000,
    },
    {
      modelId: "grok-3",
      aliases: [],
      sources: {},
      contextWindow: 131_072,
    },
    {
      modelId: "glm-5",
      aliases: [],
      sources: {},
      contextWindow: 204_800,
      supportsVision: true,
    },
    {
      modelId: "glm-4-long",
      aliases: [],
      sources: {},
      contextWindow: 1_000_000,
    },
    {
      modelId: "glm-4v",
      aliases: [],
      sources: {},
      contextWindow: 128_000,
      supportsVision: true,
    },
    {
      modelId: "glm-4-flash",
      aliases: [],
      sources: {},
      contextWindow: 128_000,
      supportsVision: false,
    },
    {
      modelId: "glm-5-turbo",
      aliases: [],
      sources: {},
      contextWindow: 202_752,
    },
  ];

  writeFileSync(
    mockCachePath,
    JSON.stringify({
      version: 2,
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

// ─── Group 1b: Memory-catalog fallback (#222 c) ─────────────────────────────

describe("Group 1b: lookupModel() — memory fallback without disk cache (#222 c)", () => {
  // Real catalog values (witness: po-2026 ~/.claudish/all-models.json, 2026-09-23).
  const MEMORY_ENTRIES: SlimModelEntry[] = [
    {
      modelId: "glm-4.6v",
      aliases: [],
      sources: {},
      contextWindow: 131_072,
      supportsVision: true,
    },
    {
      modelId: "glm-5.3-flash",
      aliases: [],
      sources: {},
      contextWindow: 1_000_000,
      supportsVision: true,
    },
    {
      modelId: "glm-5.3",
      aliases: [],
      sources: {},
      contextWindow: 1_000_000,
      supportsVision: false,
    },
    {
      modelId: "minimax-m2.7",
      aliases: ["MiniMax-M2.7", "minimax-m2-7"],
      sources: {},
      contextWindow: 204_800,
      supportsVision: false,
    },
  ];

  beforeEach(() => setMemCatalogForTests(MEMORY_ENTRIES));
  // The module-level catalog is shared state — clear it so the "cold start"
  // assertions in Group 1 stay hermetic regardless of test order.
  afterEach(() => setMemCatalogForTests(null));

  test("vision model resolves true with NO disk cache (the hub case)", () => {
    const entry = lookupModel("glm-4.6v", missingCachePath());
    expect(entry).toBeDefined();
    expect(entry!.contextWindow).toBe(131_072);
    expect(entry!.supportsVision).toBe(true);
  });

  test("alias match works through the memory fallback", () => {
    const entry = lookupModel("MiniMax-M2.7", missingCachePath());
    expect(entry).toBeDefined();
    expect(entry!.contextWindow).toBe(204_800);
    expect(entry!.supportsVision).toBe(false);
  });

  test("text-only model resolves false vision with NO disk cache", () => {
    const entry = lookupModel("glm-5.3", missingCachePath());
    expect(entry).toBeDefined();
    expect(entry!.supportsVision).toBe(false);
  });

  test("unknown id with seeded memory → undefined (fail-closed)", () => {
    expect(lookupModel("totally-unknown-xyz", missingCachePath())).toBeUndefined();
  });

  test("disk cache stays authoritative when both sources are populated", () => {
    setMemCatalogForTests([
      {
        modelId: "minimax-m2.7",
        aliases: [],
        sources: {},
        contextWindow: 42,
        supportsVision: false,
      },
    ]);
    const entry = lookupModel("minimax-m2.7", mockCachePath);
    expect(entry!.contextWindow).toBe(204_800);
  });

  test("memory entry without contextWindow → undefined, same fail-closed contract as disk", () => {
    setMemCatalogForTests([
      { modelId: "glm-unknown", aliases: [], sources: {}, contextWindow: undefined },
    ]);
    expect(lookupModel("glm-unknown", missingCachePath())).toBeUndefined();
  });

  test("cold memory (null) + no disk → undefined, behaviour unchanged from before", () => {
    setMemCatalogForTests(null);
    expect(lookupModel("glm-4.6v", missingCachePath())).toBeUndefined();
  });

  test("empty memory catalog + no disk → undefined", () => {
    setMemCatalogForTests([]);
    expect(lookupModel("glm-4.6v", missingCachePath())).toBeUndefined();
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

  test("thinking param is NOT deleted (MiniMax passes it through)", () => {
    const dialect = new MiniMaxModelDialect("MiniMax-M2.7");
    const originalRequest: any = {
      thinking: { type: "enabled", budget_tokens: 10000 },
      messages: [],
      max_tokens: 100,
    };
    const request: any = { ...originalRequest };
    dialect.prepareRequest(request, originalRequest);
    expect(request.thinking).toBeDefined();
    expect(request.thinking.type).toBe("enabled");
  });
});

describe("Group 2: GLMModelDialect — prepareRequest", () => {
  test("thinking param is stripped by GLM (not supported)", () => {
    const dialect = new GLMModelDialect("glm-5");
    const originalRequest: any = {
      thinking: { type: "enabled", budget_tokens: 5000 },
      messages: [],
    };
    const request: any = { ...originalRequest };
    dialect.prepareRequest(request, originalRequest);
    expect(request.thinking).toBeUndefined();
  });
});

describe("Group 2: DialectManager — correct dialect selection", () => {
  test("selects MiniMaxModelDialect for MiniMax-M2.7", () => {
    const manager = new DialectManager("MiniMax-M2.7");
    const adapter = manager.getAdapter();
    expect(adapter.getName()).toBe("MiniMaxModelDialect");
  });

  test("selects GLMModelDialect for glm-5", () => {
    const manager = new DialectManager("glm-5");
    const adapter = manager.getAdapter();
    expect(adapter.getName()).toBe("GLMModelDialect");
  });

  test("selects GrokModelDialect for grok-4", () => {
    const manager = new DialectManager("grok-4");
    const adapter = manager.getAdapter();
    expect(adapter.getName()).toBe("GrokModelDialect");
  });

  test("selects GrokModelDialect for x-ai/grok-4-fast", () => {
    const manager = new DialectManager("x-ai/grok-4-fast");
    const adapter = manager.getAdapter();
    expect(adapter.getName()).toBe("GrokModelDialect");
  });

  test("selects MiniMaxModelDialect for minimax-m2.5", () => {
    const manager = new DialectManager("minimax-m2.5");
    const adapter = manager.getAdapter();
    expect(adapter.getName()).toBe("MiniMaxModelDialect");
  });

  test("returns DefaultAPIFormat for unknown model", () => {
    const manager = new DialectManager("totally-unknown-model-xyz");
    const adapter = manager.getAdapter();
    expect(adapter.getName()).toBe("DefaultAPIFormat");
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

  test("thinking param passes through (not converted to reasoning_split)", () => {
    const claudeRequest = {
      model: "MiniMax-M2.7",
      max_tokens: 100,
      thinking: { type: "enabled", budget_tokens: 8000 },
      messages: [{ role: "user", content: "Hello" }],
    };

    const payload = buildMinimaxPayload(claudeRequest);

    expect(payload.thinking).toBeDefined();
    expect(payload.thinking.type).toBe("enabled");
    expect(payload.thinking.budget_tokens).toBe(8000);
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

  test("AnthropicAPIFormat stream format is anthropic-sse", () => {
    const format = new AnthropicAPIFormat("MiniMax-M2.7", "minimax");
    expect(format.getStreamFormat()).toBe("anthropic-sse");
  });
});
