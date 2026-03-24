/**
 * E2E tests for the model catalog and translation layer.
 *
 * Four test groups:
 *   Group 1: Model catalog unit tests (no API calls) — validate catalog data
 *   Group 2: Dialect integration tests (no API calls) — validate each dialect uses catalog
 *   Group 3: Real API E2E tests (MiniMax) — hits real API endpoints
 *   Group 4: Full pipeline integration (no API calls) — verify AnthropicAPIFormat + MiniMaxModelDialect
 *
 * Group 3 is skipped unless MINIMAX_CODING_API_KEY or MINIMAX_API_KEY is set.
 */

import { describe, test, expect } from "bun:test";
import { lookupModel } from "./adapters/model-catalog.js";
import { MiniMaxModelDialect } from "./adapters/minimax-model-dialect.js";
import { GLMModelDialect } from "./adapters/glm-model-dialect.js";
import { GrokModelDialect } from "./adapters/grok-model-dialect.js";
import { resolveModelDialect } from "./adapters/dialect-manager.js";
import { AnthropicAPIFormat } from "./adapters/anthropic-api-format.js";

const MINIMAX_API_KEY =
  process.env.MINIMAX_CODING_API_KEY || process.env.MINIMAX_API_KEY;
const SKIP_REAL_API = !MINIMAX_API_KEY;

const MINIMAX_API_BASE = "https://api.minimax.io/anthropic/v1/messages";

// ─── Group 1: Model Catalog Unit Tests ───────────────────────────────────────

describe("Group 1: Model Catalog — lookupModel()", () => {
  test("MiniMax-M2.7 → contextWindow 204800, supportsVision false, temperatureRange", () => {
    const entry = lookupModel("MiniMax-M2.7");
    expect(entry).toBeDefined();
    expect(entry!.contextWindow).toBe(204_800);
    expect(entry!.supportsVision).toBe(false);
    expect(entry!.temperatureRange).toEqual({ min: 0.01, max: 1.0 });
  });

  test("minimax-m2.5 → same entry as MiniMax-M2.7 (case insensitive, catch-all)", () => {
    const entry = lookupModel("minimax-m2.5");
    expect(entry).toBeDefined();
    expect(entry!.contextWindow).toBe(204_800);
    expect(entry!.supportsVision).toBe(false);
    expect(entry!.temperatureRange).toEqual({ min: 0.01, max: 1.0 });
  });

  test("grok-4 → contextWindow 256000, no temperatureRange", () => {
    const entry = lookupModel("grok-4");
    expect(entry).toBeDefined();
    expect(entry!.contextWindow).toBe(256_000);
    expect(entry!.temperatureRange).toBeUndefined();
  });

  test("glm-5 → contextWindow 80000, supportsVision true", () => {
    const entry = lookupModel("glm-5");
    expect(entry).toBeDefined();
    expect(entry!.contextWindow).toBe(80_000);
    expect(entry!.supportsVision).toBe(true);
  });

  test("x-ai/grok-4-fast → contextWindow 2000000 (vendor prefix)", () => {
    const entry = lookupModel("x-ai/grok-4-fast");
    expect(entry).toBeDefined();
    expect(entry!.contextWindow).toBe(2_000_000);
  });

  test("unknown-model → undefined", () => {
    expect(lookupModel("unknown-model")).toBeUndefined();
  });
});

// ─── Group 2: Dialect Integration Tests ──────────────────────────────────────

describe("Group 2: MiniMaxModelDialect — catalog integration", () => {
  test("getContextWindow() returns 204800 for MiniMax-M2.7", () => {
    const dialect = new MiniMaxModelDialect("MiniMax-M2.7");
    expect(dialect.getContextWindow()).toBe(204_800);
  });

  test("supportsVision() returns false for MiniMax-M2.7", () => {
    const dialect = new MiniMaxModelDialect("MiniMax-M2.7");
    expect(dialect.supportsVision()).toBe(false);
  });

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

  test("minimax-m1 returns contextWindow 1000000 (longer context model)", () => {
    const dialect = new MiniMaxModelDialect("minimax-m1");
    expect(dialect.getContextWindow()).toBe(1_000_000);
  });

  test("minimax-01 returns contextWindow 1000000", () => {
    const dialect = new MiniMaxModelDialect("minimax-01");
    expect(dialect.getContextWindow()).toBe(1_000_000);
  });
});

describe("Group 2: GLMModelDialect — catalog integration", () => {
  test("glm-5 contextWindow is 80000", () => {
    const dialect = new GLMModelDialect("glm-5");
    expect(dialect.getContextWindow()).toBe(80_000);
  });

  test("glm-4-long contextWindow is 1000000", () => {
    const dialect = new GLMModelDialect("glm-4-long");
    expect(dialect.getContextWindow()).toBe(1_000_000);
  });

  test("glm-4v supportsVision is true", () => {
    const dialect = new GLMModelDialect("glm-4v");
    expect(dialect.supportsVision()).toBe(true);
  });

  test("glm-4-flash supportsVision defaults to false (not explicitly vision model)", () => {
    const dialect = new GLMModelDialect("glm-4-flash");
    expect(dialect.supportsVision()).toBe(false);
  });

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

  test("glm-5-turbo contextWindow is 202752", () => {
    const dialect = new GLMModelDialect("glm-5-turbo");
    expect(dialect.getContextWindow()).toBe(202_752);
  });
});

describe("Group 2: GrokModelDialect — catalog integration", () => {
  test("grok-4 contextWindow is 256000", () => {
    const dialect = new GrokModelDialect("grok-4");
    expect(dialect.getContextWindow()).toBe(256_000);
  });

  test("grok-4-fast contextWindow is 2000000", () => {
    const dialect = new GrokModelDialect("grok-4-fast");
    expect(dialect.getContextWindow()).toBe(2_000_000);
  });

  test("grok-3 contextWindow is 131072", () => {
    const dialect = new GrokModelDialect("grok-3");
    expect(dialect.getContextWindow()).toBe(131_072);
  });
});

describe("Group 2: resolveModelDialect — correct dialect selection", () => {
  test("selects MiniMaxModelDialect for MiniMax-M2.7", () => {
    const adapter = resolveModelDialect("MiniMax-M2.7");
    expect(adapter.getName()).toBe("MiniMaxModelDialect");
  });

  test("selects GLMModelDialect for glm-5", () => {
    const adapter = resolveModelDialect("glm-5");
    expect(adapter.getName()).toBe("GLMModelDialect");
  });

  test("selects GrokModelDialect for grok-4", () => {
    const adapter = resolveModelDialect("grok-4");
    expect(adapter.getName()).toBe("GrokModelDialect");
  });

  test("selects GrokModelDialect for x-ai/grok-4-fast", () => {
    const adapter = resolveModelDialect("x-ai/grok-4-fast");
    expect(adapter.getName()).toBe("GrokModelDialect");
  });

  test("selects MiniMaxModelDialect for minimax-m2.5", () => {
    const adapter = resolveModelDialect("minimax-m2.5");
    expect(adapter.getName()).toBe("MiniMaxModelDialect");
  });

  test("returns DefaultAPIFormat for unknown model", () => {
    const adapter = resolveModelDialect("totally-unknown-model-xyz");
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
  function buildMinimaxPayload(
    claudeRequest: any,
    modelId = "MiniMax-M2.7"
  ): any {
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
