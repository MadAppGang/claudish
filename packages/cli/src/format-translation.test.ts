/**
 * Format Translation Integration Tests
 *
 * Tests the SSE stream parser pipeline by replaying real (or seed) SSE fixtures
 * through the parser stack and asserting correct Claude SSE output.
 *
 * Workflow for adding regression tests from production failures:
 *   1. Run failing model with --debug: claudish --model kimi-k2.5 --debug ...
 *   2. Extract fixtures: bun run src/test-fixtures/extract-sse-from-log.ts logs/claudish_*.log
 *   3. Add a describe() block below referencing the new fixture
 *   4. Run: bun test src/format-translation.test.ts
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Test Helpers ───────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "test-fixtures", "sse-responses");

/** Parsed Claude SSE event */
interface ClaudeEvent {
  event: string;
  data: any;
}

/**
 * Read an SSE fixture file and return as a Response with streaming body.
 * This simulates the HTTP response from a provider API.
 */
function fixtureToResponse(fixturePath: string): Response {
  const content = readFileSync(fixturePath, "utf-8");
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Send all SSE lines as a single chunk (simulates buffered response)
      controller.enqueue(encoder.encode(content));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * Consume a Claude SSE ReadableStream and parse into structured events.
 * This is the assertion helper — it reads what the parser emits.
 */
async function parseClaudeSseStream(response: Response): Promise<ClaudeEvent[]> {
  const events: ClaudeEvent[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Parse SSE events from buffer
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";

    for (const part of parts) {
      const lines = part.split("\n").filter((l) => l.trim());
      let eventType = "";
      let dataStr = "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7);
        } else if (line.startsWith("data: ")) {
          dataStr += line.slice(6);
        }
      }

      if (dataStr && dataStr !== "[DONE]") {
        try {
          events.push({ event: eventType, data: JSON.parse(dataStr) });
        } catch {
          // Skip unparseable events
        }
      }
    }
  }

  return events;
}

/** Extract all text content from parsed Claude events */
function extractText(events: ClaudeEvent[]): string {
  return events
    .filter((e) => e.data?.type === "content_block_delta" && e.data?.delta?.type === "text_delta")
    .map((e) => e.data.delta.text)
    .join("");
}

/** Extract tool_use block names from parsed Claude events */
function extractToolNames(events: ClaudeEvent[]): string[] {
  return events
    .filter(
      (e) => e.data?.type === "content_block_start" && e.data?.content_block?.type === "tool_use"
    )
    .map((e) => e.data.content_block.name);
}

/** Extract stop_reason from message_delta event */
function extractStopReason(events: ClaudeEvent[]): string | null {
  const delta = events.find((e) => e.data?.type === "message_delta");
  return delta?.data?.delta?.stop_reason || null;
}

/** Create a minimal mock Hono context for stream parsers */
function createMockContext(): any {
  let capturedBody: ReadableStream | null = null;
  let capturedInit: any = null;

  return {
    body(stream: ReadableStream, init?: any) {
      capturedBody = stream;
      capturedInit = init;
      return new Response(stream, init);
    },
    getCapturedResponse() {
      return capturedBody ? new Response(capturedBody, capturedInit) : null;
    },
  };
}

// ─── OpenAI SSE Parser Tests ────────────────────────────────────────────────

describe("OpenAI SSE → Claude SSE (createStreamingResponseHandler)", () => {
  // Dynamic import to avoid circular dependency issues at module level
  async function getParser() {
    const mod = await import("./handlers/shared/openai-compat.js");
    return mod.createStreamingResponseHandler;
  }

  async function getDefaultAdapter() {
    const mod = await import("./adapters/base-api-format.js");
    return new mod.DefaultAPIFormat("test-model");
  }

  test("SEED: text-only response produces text events and stop_reason=end_turn", async () => {
    const createStreamingResponseHandler = await getParser();
    const adapter = await getDefaultAdapter();
    const fixture = fixtureToResponse(join(FIXTURES_DIR, "SEED-openai-text-only.sse"));
    const ctx = createMockContext();

    const response = createStreamingResponseHandler(
      ctx,
      fixture,
      adapter,
      "test-model",
      null, // no middleware
      undefined, // no token callback
      undefined // no tool schemas
    );

    const events = await parseClaudeSseStream(response);

    // Should have message_start
    expect(events.some((e) => e.data?.type === "message_start")).toBe(true);

    // Should have text content
    const text = extractText(events);
    expect(text).toContain("Hello");
    expect(text).toContain("test model");

    // Should have no tool calls
    expect(extractToolNames(events)).toHaveLength(0);

    // Should end with end_turn (not tool_use)
    expect(extractStopReason(events)).toBe("end_turn");

    // Should have message_stop
    expect(events.some((e) => e.data?.type === "message_stop")).toBe(true);
  });

  test("SEED: tool-call response produces tool_use blocks and stop_reason=tool_use", async () => {
    const createStreamingResponseHandler = await getParser();
    const adapter = await getDefaultAdapter();
    const fixture = fixtureToResponse(join(FIXTURES_DIR, "SEED-openai-tool-call.sse"));
    const ctx = createMockContext();

    const response = createStreamingResponseHandler(
      ctx,
      fixture,
      adapter,
      "test-model",
      null,
      undefined,
      undefined
    );

    const events = await parseClaudeSseStream(response);

    // Should have text before tool call
    const text = extractText(events);
    expect(text).toContain("read that file");

    // Should have a Read tool call
    const tools = extractToolNames(events);
    expect(tools).toContain("Read");

    // Should end with tool_use
    expect(extractStopReason(events)).toBe("tool_use");
  });
});

// ─── Anthropic SSE Parser Tests ─────────────────────────────────────────────

describe("Anthropic SSE Passthrough (createAnthropicPassthroughStream)", () => {
  async function getParser() {
    const mod = await import("./handlers/shared/stream-parsers/anthropic-sse.js");
    return mod.createAnthropicPassthroughStream;
  }

  test("SEED: text-only Anthropic response passes through text events", async () => {
    const createAnthropicPassthroughStream = await getParser();
    const fixture = fixtureToResponse(join(FIXTURES_DIR, "SEED-anthropic-text-only.sse"));
    const ctx = createMockContext();

    let tokenInput = 0;
    let tokenOutput = 0;

    const response = createAnthropicPassthroughStream(ctx, fixture, {
      modelName: "test-model",
      onTokenUpdate: (input, output) => {
        tokenInput = input;
        tokenOutput = output;
      },
    });

    const events = await parseClaudeSseStream(response);

    // Should have text content passed through
    const text = extractText(events);
    expect(text).toContain("Hello from");
    expect(text).toContain("Anthropic format");

    // Should have message_start with usage
    const msgStart = events.find((e) => e.data?.type === "message_start");
    expect(msgStart).toBeDefined();
    expect(msgStart?.data?.message?.usage?.input_tokens).toBe(50);

    // Should have stop_reason=end_turn
    const msgDelta = events.find((e) => e.data?.type === "message_delta");
    expect(msgDelta?.data?.delta?.stop_reason).toBe("end_turn");

    // Token callback should have been called
    expect(tokenInput).toBe(50);
    expect(tokenOutput).toBe(5);
  });
});

// ─── Adapter Message Conversion Tests ───────────────────────────────────────

describe("Adapter: convertMessagesToOpenAI", () => {
  async function getConverter() {
    const mod = await import("./handlers/shared/openai-compat.js");
    return mod.convertMessagesToOpenAI;
  }

  test("converts system prompt to system message", async () => {
    const convert = await getConverter();
    const req = {
      system: "You are a helpful assistant.",
      messages: [{ role: "user", content: "Hello" }],
    };

    const messages = convert(req, "test-model");
    expect(messages[0]).toEqual({ role: "system", content: "You are a helpful assistant." });
    expect(messages[1]).toEqual({ role: "user", content: "Hello" });
  });

  test("converts assistant tool_use to OpenAI tool_calls format", async () => {
    const convert = await getConverter();
    const req = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me read that." },
            {
              type: "tool_use",
              id: "call_123",
              name: "Read",
              input: { file_path: "/tmp/test.txt" },
            },
          ],
        },
      ],
    };

    const messages = convert(req, "test-model");
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content).toBe("Let me read that.");
    expect(messages[0].tool_calls).toHaveLength(1);
    expect(messages[0].tool_calls[0].function.name).toBe("Read");
  });

  test("converts user tool_result to OpenAI tool message", async () => {
    const convert = await getConverter();
    const req = {
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_123", content: "file contents here" },
          ],
        },
      ],
    };

    const messages = convert(req, "test-model");
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("tool");
    expect(messages[0].tool_call_id).toBe("call_123");
    expect(messages[0].content).toBe("file contents here");
  });

  test("Kimi K2.5: empty thinking block still produces reasoning_content field", async () => {
    // Regression: Kimi rejects turn 2+ with HTTP 400 when reasoning_content is absent.
    // This happens when the thinking block has empty-string content — the old truthiness
    // check `if (reasoningContent)` silently dropped the field.
    const convert = await getConverter();
    const req = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "" },
            {
              type: "tool_use",
              id: "call_abc",
              name: "Read",
              input: { file_path: "/tmp/foo.ts" },
            },
          ],
        },
      ],
    };

    const messages = convert(req, "kimi-k2.5");
    expect(messages).toHaveLength(1);
    // reasoning_content must be present even though the text is empty
    expect(Object.prototype.hasOwnProperty.call(messages[0], "reasoning_content")).toBe(true);
    expect(messages[0].reasoning_content).toBe("");
    // tool_calls should still be present
    expect(messages[0].tool_calls).toHaveLength(1);
    expect(messages[0].tool_calls[0].function.name).toBe("Read");
  });

  test("Kimi K2.5: non-empty thinking block produces reasoning_content with text", async () => {
    const convert = await getConverter();
    const req = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me think about this." },
            {
              type: "tool_use",
              id: "call_xyz",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      ],
    };

    const messages = convert(req, "kimi-k2.5");
    expect(messages).toHaveLength(1);
    expect(messages[0].reasoning_content).toBe("Let me think about this.");
    expect(messages[0].tool_calls[0].function.name).toBe("Bash");
  });

  test("no thinking blocks means no reasoning_content field", async () => {
    const convert = await getConverter();
    const req = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Sure." },
            {
              type: "tool_use",
              id: "call_no_think",
              name: "Read",
              input: { file_path: "/tmp/bar.ts" },
            },
          ],
        },
      ],
    };

    const messages = convert(req, "test-model");
    expect(messages).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(messages[0], "reasoning_content")).toBe(false);
  });
});

describe("Adapter: AnthropicAPIFormat", () => {
  async function getAdapter() {
    const mod = await import("./adapters/anthropic-api-format.js");
    return mod.AnthropicAPIFormat;
  }

  test("passes messages through without OpenAI conversion", async () => {
    const AnthropicAPIFormat = await getAdapter();
    const adapter = new AnthropicAPIFormat("test-model", "minimax");

    const claudeRequest = {
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "Hi there" }],
        },
      ],
    };

    const messages = adapter.convertMessages(claudeRequest);
    // Should be the same messages (not converted to OpenAI format)
    expect(messages).toHaveLength(2);
    expect(messages[0].content[0].type).toBe("text");
    expect(messages[0].content[0].text).toBe("Hello");
  });

  test("strips tool_reference content types", async () => {
    const AnthropicAPIFormat = await getAdapter();
    const adapter = new AnthropicAPIFormat("test-model", "kimi");

    const claudeRequest = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                { type: "text", text: "result" },
                { type: "tool_reference", tool_use_id: "t0" },
              ],
            },
          ],
        },
      ],
    };

    const messages = adapter.convertMessages(claudeRequest);
    // tool_reference should be stripped from tool_result content
    const toolResult = messages[0].content[0];
    expect(toolResult.content).toHaveLength(1);
    expect(toolResult.content[0].type).toBe("text");
  });

  test("builds Anthropic-format payload (not OpenAI)", async () => {
    const AnthropicAPIFormat = await getAdapter();
    const adapter = new AnthropicAPIFormat("minimax-m2.5", "minimax");

    const claudeRequest = {
      model: "claude-3-opus",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 4096,
      system: "Be helpful.",
      tools: [{ name: "Read", input_schema: {} }],
    };

    const messages = adapter.convertMessages(claudeRequest);
    const tools = adapter.convertTools(claudeRequest);
    const payload = adapter.buildPayload(claudeRequest, messages, tools);

    // Model should be overridden to target
    expect(payload.model).toBe("minimax-m2.5");
    expect(payload.stream).toBe(true);
    expect(payload.max_tokens).toBe(4096);
    expect(payload.system).toBe("Be helpful.");
    // Tools should be Claude format (not OpenAI function format)
    expect(payload.tools[0].name).toBe("Read");
    // Should NOT have messages in OpenAI format
    expect(payload.messages).toBeDefined();
  });
});

// ─── Model Adapter Quirks Tests ─────────────────────────────────────────────

describe("Model Adapter Quirks", () => {
  test("MiniMaxModelDialect: native thinking passthrough (no reasoning_split)", async () => {
    const { MiniMaxModelDialect } = await import("./adapters/minimax-model-dialect.js");
    const adapter = new MiniMaxModelDialect("minimax-m2.5");

    // MiniMax's Anthropic-compatible endpoint supports `thinking` natively.
    // prepareRequest should NOT convert it to reasoning_split.
    const request: any = {
      model: "minimax-m2.5",
      messages: [],
      thinking: { budget_tokens: 10000 },
    };
    const original = { thinking: { budget_tokens: 10000 } };

    adapter.prepareRequest(request, original);
    expect(request.reasoning_split).toBeUndefined();
    expect(request.thinking).toEqual({ budget_tokens: 10000 });
  });

  test("MiniMaxModelDialect: temperature clamping — 0 → 0.01", async () => {
    const { MiniMaxModelDialect } = await import("./adapters/minimax-model-dialect.js");
    const adapter = new MiniMaxModelDialect("minimax-m2.5");

    const request: any = { model: "minimax-m2.5", messages: [], temperature: 0 };
    adapter.prepareRequest(request, {});
    expect(request.temperature).toBe(0.01);
  });

  test("MiniMaxModelDialect: temperature clamping — negative → 0.01", async () => {
    const { MiniMaxModelDialect } = await import("./adapters/minimax-model-dialect.js");
    const adapter = new MiniMaxModelDialect("minimax-m2.5");

    const request: any = { model: "minimax-m2.5", messages: [], temperature: -0.5 };
    adapter.prepareRequest(request, {});
    expect(request.temperature).toBe(0.01);
  });

  test("MiniMaxModelDialect: temperature clamping — >1 → 1.0", async () => {
    const { MiniMaxModelDialect } = await import("./adapters/minimax-model-dialect.js");
    const adapter = new MiniMaxModelDialect("minimax-m2.5");

    const request: any = { model: "minimax-m2.5", messages: [], temperature: 1.5 };
    adapter.prepareRequest(request, {});
    expect(request.temperature).toBe(1.0);
  });

  test("MiniMaxModelDialect: valid temperature unchanged", async () => {
    const { MiniMaxModelDialect } = await import("./adapters/minimax-model-dialect.js");
    const adapter = new MiniMaxModelDialect("minimax-m2.5");

    const request: any = { model: "minimax-m2.5", messages: [], temperature: 0.7 };
    adapter.prepareRequest(request, {});
    expect(request.temperature).toBe(0.7);
  });

  test("MiniMaxModelDialect: unknown minimax model → context window 0", async () => {
    const { MiniMaxModelDialect } = await import("./adapters/minimax-model-dialect.js");
    const adapter = new MiniMaxModelDialect("minimax-m2.5");
    expect(adapter.getContextWindow()).toBe(0);
  });

  test("MiniMaxModelDialect: supportsVision returns false", async () => {
    const { MiniMaxModelDialect } = await import("./adapters/minimax-model-dialect.js");
    const adapter = new MiniMaxModelDialect("minimax-m2.5");
    expect(adapter.supportsVision()).toBe(false);
  });

  test("OpenAIAdapter: thinking → reasoning_effort for o3", async () => {
    const { OpenAIAPIFormat } = await import("./adapters/openai-api-format.js");
    const adapter = new OpenAIAPIFormat("o3-mini");

    const request: any = { model: "o3-mini", messages: [] };
    const original = { thinking: { budget_tokens: 32000 } };

    adapter.prepareRequest(request, original);
    expect(request.reasoning_effort).toBe("high");
    expect(request.thinking).toBeUndefined();
  });

  test("GLMAdapter: strips thinking params", async () => {
    const { GLMModelDialect } = await import("./adapters/glm-model-dialect.js");
    const adapter = new GLMModelDialect("glm-5");

    const request: any = { model: "glm-5", messages: [], thinking: { budget_tokens: 10000 } };
    const original = { thinking: { budget_tokens: 10000 } };

    adapter.prepareRequest(request, original);
    expect(request.thinking).toBeUndefined();
  });

  test("AdapterManager selects correct adapter for model IDs", async () => {
    const { DialectManager } = await import("./adapters/dialect-manager.js");

    expect(new DialectManager("glm-5").getAdapter().getName()).toBe("GLMModelDialect");
    expect(new DialectManager("grok-3").getAdapter().getName()).toBe("GrokModelDialect");
    expect(new DialectManager("minimax-m2.5").getAdapter().getName()).toBe("MiniMaxModelDialect");
    expect(new DialectManager("qwen3.5-plus").getAdapter().getName()).toBe("QwenModelDialect");
    expect(new DialectManager("deepseek-r1").getAdapter().getName()).toBe("DeepSeekModelDialect");
    expect(new DialectManager("unknown-model").getAdapter().getName()).toBe("DefaultAPIFormat");
  });
});

// ─── APIFormat: getStreamFormat() Tests ──────────────────────────────────────

describe("APIFormat: getStreamFormat()", () => {
  test("DefaultAPIFormat returns openai-sse", async () => {
    const { DefaultAPIFormat } = await import("./adapters/base-api-format.js");
    expect(new DefaultAPIFormat("test").getStreamFormat()).toBe("openai-sse");
  });

  test("AnthropicAPIFormat returns anthropic-sse", async () => {
    const { AnthropicAPIFormat } = await import("./adapters/anthropic-api-format.js");
    expect(new AnthropicAPIFormat("test", "minimax").getStreamFormat()).toBe("anthropic-sse");
  });

  test("GeminiAPIFormat returns gemini-sse", async () => {
    const { GeminiAPIFormat } = await import("./adapters/gemini-api-format.js");
    expect(new GeminiAPIFormat("gemini-2.0-flash").getStreamFormat()).toBe("gemini-sse");
  });

  test("OllamaAPIFormat returns ollama-jsonl", async () => {
    const { OllamaAPIFormat } = await import("./adapters/ollama-api-format.js");
    expect(new OllamaAPIFormat("llama3.2").getStreamFormat()).toBe("ollama-jsonl");
  });

  test("OpenAIAPIFormat returns openai-sse for GPT models", async () => {
    const { OpenAIAPIFormat } = await import("./adapters/openai-api-format.js");
    expect(new OpenAIAPIFormat("gpt-5.4").getStreamFormat()).toBe("openai-sse");
  });

  test("CodexAPIFormat returns openai-responses-sse", async () => {
    const { CodexAPIFormat } = await import("./adapters/codex-api-format.js");
    expect(new CodexAPIFormat("codex-mini").getStreamFormat()).toBe("openai-responses-sse");
  });

  test("GLMModelDialect inherits openai-sse (uses OpenAI-compat API)", async () => {
    const { GLMModelDialect } = await import("./adapters/glm-model-dialect.js");
    expect(new GLMModelDialect("glm-5").getStreamFormat()).toBe("openai-sse");
  });
});

describe("CodexAdapter", () => {
  test("shouldHandle returns true for codex models", async () => {
    const { CodexAPIFormat } = await import("./adapters/codex-api-format.js");
    expect(new CodexAPIFormat("codex-mini").shouldHandle("codex-mini")).toBe(true);
    expect(new CodexAPIFormat("codex-mini").shouldHandle("codex-davinci-002")).toBe(true);
  });

  test("shouldHandle returns false for non-codex models", async () => {
    const { CodexAPIFormat } = await import("./adapters/codex-api-format.js");
    expect(new CodexAPIFormat("gpt-5.4").shouldHandle("gpt-5.4")).toBe(false);
    expect(new CodexAPIFormat("o3").shouldHandle("o3")).toBe(false);
  });

  test("getStreamFormat returns openai-responses-sse", async () => {
    const { CodexAPIFormat } = await import("./adapters/codex-api-format.js");
    expect(new CodexAPIFormat("codex-mini").getStreamFormat()).toBe("openai-responses-sse");
  });

  test("getName returns CodexAPIFormat", async () => {
    const { CodexAPIFormat } = await import("./adapters/codex-api-format.js");
    expect(new CodexAPIFormat("codex-mini").getName()).toBe("CodexAPIFormat");
  });

  test("AdapterManager selects CodexAPIFormat for codex-mini", async () => {
    const { DialectManager } = await import("./adapters/dialect-manager.js");
    expect(new DialectManager("codex-mini").getAdapter().getName()).toBe("CodexAPIFormat");
  });
});

describe("ModelDialect interface compliance", () => {
  test("GLMAdapter implements translator methods", async () => {
    const { GLMModelDialect } = await import("./adapters/glm-model-dialect.js");
    const t = new GLMModelDialect("glm-5");
    expect(typeof t.getContextWindow()).toBe("number");
    expect(typeof t.supportsVision()).toBe("boolean");
    expect(typeof t.prepareRequest).toBe("function");
    expect(typeof t.shouldHandle).toBe("function");
    expect(typeof t.getName).toBe("function");
  });
});

// ─── ProviderProfile Table Tests ─────────────────────────────────────────────

describe("ProviderProfile table completeness", () => {
  test("all expected providers are registered", async () => {
    const { PROVIDER_PROFILES } = await import("./providers/provider-profiles.js");

    const expectedProviders = [
      "gemini",
      "gemini-codeassist",
      "openai",
      "minimax",
      "minimax-coding",
      "kimi",
      "kimi-coding",
      "zai",
      "glm",
      "glm-coding",
      "opencode-zen",
      "opencode-zen-go",
      "ollamacloud",
      "litellm",
      "vertex",
    ];

    for (const provider of expectedProviders) {
      expect(PROVIDER_PROFILES).toHaveProperty(provider);
    }
  });

  test("each profile has a createHandler function", async () => {
    const { PROVIDER_PROFILES } = await import("./providers/provider-profiles.js");

    for (const [name, profile] of Object.entries(PROVIDER_PROFILES)) {
      expect(typeof profile.createHandler).toBe("function");
    }
  });
});

// ─── Regression: Production Fixture Tests ───────────────────────────────────
//
// Add new describe() blocks here when extracting fixtures from production logs.
// Each block references a fixture file extracted by extract-sse-from-log.ts.
//
// Template:
//
// describe("Regression: <model> - <issue description>", () => {
//   test("text content reaches output", async () => {
//     const parser = (await import("./handlers/shared/openai-compat.js")).createStreamingResponseHandler;
//     const adapter = new (await import("./adapters/base-api-format.js")).DefaultAdapter("<model>");
//     const fixture = fixtureToResponse(join(FIXTURES_DIR, "<model>-openai-turn1.sse"));
//     const ctx = createMockContext();
//     const response = parser(ctx, fixture, adapter, "<model>", null);
//     const events = await parseClaudeSseStream(response);
//     expect(extractText(events).length).toBeGreaterThan(0);
//   });
// });

describe("Structural log redaction", () => {
  test("redacts long string content but keeps short strings", async () => {
    const { structuralRedact } = await import("./logger.js");
    const input =
      '{"choices":[{"delta":{"content":"This is a very long text that should be redacted because it exceeds twenty characters"},"finish_reason":null}]}';
    const result = structuralRedact(input);
    const parsed = JSON.parse(result);
    expect(parsed.choices[0].delta.content).toMatch(/^<\d+ chars>$/);
    expect(parsed.choices[0].finish_reason).toBeNull();
  });

  test("preserves model names and event types (short strings)", async () => {
    const { structuralRedact } = await import("./logger.js");
    const input = '{"type":"message_start","message":{"model":"gpt-5.4","role":"assistant"}}';
    const result = structuralRedact(input);
    const parsed = JSON.parse(result);
    expect(parsed.type).toBe("message_start");
    expect(parsed.message.model).toBe("gpt-5.4");
    expect(parsed.message.role).toBe("assistant");
  });

  test("preserves numbers and booleans", async () => {
    const { structuralRedact } = await import("./logger.js");
    const input = '{"usage":{"prompt_tokens":1250,"completion_tokens":89},"stream":true}';
    const result = structuralRedact(input);
    const parsed = JSON.parse(result);
    expect(parsed.usage.prompt_tokens).toBe(1250);
    expect(parsed.stream).toBe(true);
  });

  test("preserves tool call names but redacts arguments", async () => {
    const { structuralRedact } = await import("./logger.js");
    const input =
      '{"choices":[{"delta":{"tool_calls":[{"function":{"name":"Read","arguments":"{\\"file_path\\":\\"/Users/jack/secret/important-file.ts\\"}"}}]}}]}';
    const result = structuralRedact(input);
    const parsed = JSON.parse(result);
    expect(parsed.choices[0].delta.tool_calls[0].function.name).toBe("Read");
    // Arguments string is >20 chars so should be redacted
    expect(parsed.choices[0].delta.tool_calls[0].function.arguments).toMatch(/^<\d+ chars>$/);
  });

  test("handles non-JSON gracefully", async () => {
    const { structuralRedact } = await import("./logger.js");
    const input = "[DONE]";
    const result = structuralRedact(input);
    expect(result).toBe("[DONE]");
  });
});

// ─── sanitizeSchemaForOpenAI Tests ───────────────────────────────────────────

describe("sanitizeSchemaForOpenAI", () => {
  async function getSanitizer() {
    const mod = await import("./handlers/shared/format/openai-tools.js");
    return mod.sanitizeSchemaForOpenAI;
  }

  test("passes through normal object schema unchanged", async () => {
    const sanitize = await getSanitizer();
    const schema = {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL" },
        timeout: { type: "number" },
      },
      required: ["url"],
    };
    const result = sanitize(schema);
    expect(result.type).toBe("object");
    expect(result.properties.url.type).toBe("string");
    expect(result.required).toEqual(["url"]);
    expect(result.oneOf).toBeUndefined();
    expect(result.anyOf).toBeUndefined();
  });

  test("collapses top-level oneOf by picking the object branch", async () => {
    const sanitize = await getSanitizer();
    // browser-use pattern: oneOf at root with one object branch
    const schema = {
      oneOf: [
        {
          type: "object",
          properties: { selector: { type: "string" } },
          required: ["selector"],
        },
      ],
    };
    const result = sanitize(schema);
    expect(result.type).toBe("object");
    expect(result.oneOf).toBeUndefined();
    expect(result.properties.selector.type).toBe("string");
    expect(result.required).toEqual(["selector"]);
  });

  test("collapses top-level anyOf by picking the object branch", async () => {
    const sanitize = await getSanitizer();
    const schema = {
      anyOf: [
        { type: "string" },
        {
          type: "object",
          properties: { action: { type: "string" } },
        },
      ],
    };
    const result = sanitize(schema);
    expect(result.type).toBe("object");
    expect(result.anyOf).toBeUndefined();
    expect(result.properties.action.type).toBe("string");
  });

  test("falls back to permissive object schema when no object branch in oneOf", async () => {
    const sanitize = await getSanitizer();
    const schema = {
      oneOf: [{ type: "string" }, { type: "number" }],
    };
    const result = sanitize(schema);
    expect(result.type).toBe("object");
    expect(result.oneOf).toBeUndefined();
    expect(result.additionalProperties).toBe(true);
  });

  test("removes top-level enum", async () => {
    const sanitize = await getSanitizer();
    const schema = { type: "object", enum: ["a", "b"] };
    const result = sanitize(schema);
    expect(result.type).toBe("object");
    expect(result.enum).toBeUndefined();
  });

  test("removes top-level not", async () => {
    const sanitize = await getSanitizer();
    const schema = { type: "object", not: { type: "null" } };
    const result = sanitize(schema);
    expect(result.type).toBe("object");
    expect(result.not).toBeUndefined();
  });

  test("forces type to object even when missing", async () => {
    const sanitize = await getSanitizer();
    const schema = { properties: { x: { type: "string" } } };
    const result = sanitize(schema);
    expect(result.type).toBe("object");
  });

  test("preserves nested oneOf inside properties (only top-level fixed)", async () => {
    const sanitize = await getSanitizer();
    const schema = {
      type: "object",
      properties: {
        value: {
          oneOf: [{ type: "string" }, { type: "number" }],
        },
      },
    };
    const result = sanitize(schema);
    expect(result.type).toBe("object");
    // Nested oneOf inside properties should be preserved
    expect(result.properties.value.oneOf).toBeDefined();
    expect(result.properties.value.oneOf).toHaveLength(2);
  });

  test("removes uri format via removeUriFormat after sanitization", async () => {
    const sanitize = await getSanitizer();
    const schema = {
      type: "object",
      properties: {
        website: { type: "string", format: "uri" },
      },
    };
    const result = sanitize(schema);
    expect(result.properties.website.format).toBeUndefined();
  });

  test("convertToolsToOpenAI sanitizes browser-use oneOf schema", async () => {
    const { convertToolsToOpenAI } = await import("./handlers/shared/format/openai-tools.js");
    const req = {
      tools: [
        {
          name: "mcp__browser-use__browser_click",
          description: "Click an element",
          input_schema: {
            oneOf: [
              {
                type: "object",
                properties: { selector: { type: "string" } },
                required: ["selector"],
              },
            ],
          },
        },
      ],
    };
    const tools = convertToolsToOpenAI(req, false);
    expect(tools).toHaveLength(1);
    const params = tools[0].function.parameters;
    expect(params.type).toBe("object");
    expect(params.oneOf).toBeUndefined();
    expect(params.properties.selector.type).toBe("string");
  });

  // REGRESSION: OpenAI rejects bare object schemas without properties field
  // Fixed in /dev:fix session dev-fix-20260405-102347-199b209c
  test("adds properties:{} to bare { type: 'object' } schema", async () => {
    const sanitize = await getSanitizer();
    const schema = { type: "object" };
    const result = sanitize(schema);
    expect(result.type).toBe("object");
    expect(result.properties).toEqual({});
  });

  test("adds properties:{} to empty schema {}", async () => {
    const sanitize = await getSanitizer();
    const schema = {};
    const result = sanitize(schema);
    expect(result.type).toBe("object");
    expect(result.properties).toEqual({});
  });

  test("convertToolsToOpenAI handles MCP tool with no parameters (list_models pattern)", async () => {
    const { convertToolsToOpenAI } = await import("./handlers/shared/format/openai-tools.js");
    const req = {
      tools: [
        {
          name: "mcp__plugin_claudish__list_models",
          description: "List recommended models",
          input_schema: { type: "object" },
        },
      ],
    };
    const tools = convertToolsToOpenAI(req, false);
    expect(tools).toHaveLength(1);
    const params = tools[0].function.parameters;
    expect(params.type).toBe("object");
    expect(params.properties).toEqual({});
  });
});

// ─── Regression: Z.AI GLM-5 usage tokens (GitHub #74) ─────────────────────

// ─── Regression: Gemini images in tool_result (browser_screenshot) ──────────

describe("Regression: GeminiAPIFormat images in tool_result", () => {
  async function getAdapter() {
    const mod = await import("./adapters/gemini-api-format.js");
    return mod.GeminiAPIFormat;
  }

  // Minimal 1x1 red PNG (base64) for test assertions
  const TINY_PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

  test("tool_result with image array extracts inlineData parts (not JSON-stringified)", async () => {
    const GeminiAPIFormat = await getAdapter();
    const adapter = new GeminiAPIFormat("gemini-3.1-pro-preview");

    // Simulate: assistant called browser_screenshot, now user sends tool_result with text+image
    // First, register the tool call so convertUserParts can find it
    adapter.registerToolCall("toolu_screenshot_1", "browser_screenshot");

    const claudeRequest = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_screenshot_1",
              name: "browser_screenshot",
              input: {},
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_screenshot_1",
              content: [
                { type: "text", text: '{"size_bytes": 358688, "viewport": {"width": 1800, "height": 991}}' },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: TINY_PNG_B64,
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const messages = adapter.convertMessages(claudeRequest);

    // The user message should have parts for both the functionResponse AND the inlineData
    const userMsg = messages.find((m: any) => m.role === "user");
    expect(userMsg).toBeDefined();

    // Should have functionResponse part
    const fnResponse = userMsg.parts.find((p: any) => p.functionResponse);
    expect(fnResponse).toBeDefined();
    expect(fnResponse.functionResponse.name).toBe("browser_screenshot");
    // The text content should be in the response (not the raw image data)
    expect(fnResponse.functionResponse.response.content).toContain("size_bytes");

    // Should have inlineData part for the image (NOT embedded in functionResponse)
    const inlineData = userMsg.parts.find((p: any) => p.inlineData);
    expect(inlineData).toBeDefined();
    expect(inlineData.inlineData.mimeType).toBe("image/png");
    expect(inlineData.inlineData.data).toBe(TINY_PNG_B64);
  });

  test("tool_result with string content still works as before", async () => {
    const GeminiAPIFormat = await getAdapter();
    const adapter = new GeminiAPIFormat("gemini-2.0-flash");

    adapter.registerToolCall("toolu_read_1", "Read");

    const claudeRequest = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_read_1", name: "Read", input: { file_path: "/tmp/test.ts" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_read_1",
              content: "file contents here",
            },
          ],
        },
      ],
    };

    const messages = adapter.convertMessages(claudeRequest);
    const userMsg = messages.find((m: any) => m.role === "user");

    const fnResponse = userMsg.parts.find((p: any) => p.functionResponse);
    expect(fnResponse).toBeDefined();
    expect(fnResponse.functionResponse.response.content).toBe("file contents here");

    // No inlineData for plain text tool results
    const inlineData = userMsg.parts.find((p: any) => p.inlineData);
    expect(inlineData).toBeUndefined();
  });

  test("tool_result with multiple images extracts all as inlineData", async () => {
    const GeminiAPIFormat = await getAdapter();
    const adapter = new GeminiAPIFormat("gemini-3.1-pro-preview");

    adapter.registerToolCall("toolu_multi_1", "multi_screenshot");

    const claudeRequest = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_multi_1", name: "multi_screenshot", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_multi_1",
              content: [
                { type: "text", text: "Two screenshots captured" },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: TINY_PNG_B64 },
                },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/jpeg", data: TINY_PNG_B64 },
                },
              ],
            },
          ],
        },
      ],
    };

    const messages = adapter.convertMessages(claudeRequest);
    const userMsg = messages.find((m: any) => m.role === "user");

    const inlineDataParts = userMsg.parts.filter((p: any) => p.inlineData);
    expect(inlineDataParts).toHaveLength(2);
    expect(inlineDataParts[0].inlineData.mimeType).toBe("image/png");
    expect(inlineDataParts[1].inlineData.mimeType).toBe("image/jpeg");
  });
});

describe("Regression: Z.AI GLM-5 input_tokens in final usage event (#74)", () => {
  test("input_tokens from message_delta.usage is captured (not stuck at 0)", async () => {
    const mod = await import("./handlers/shared/stream-parsers/anthropic-sse.js");
    const createAnthropicPassthroughStream = mod.createAnthropicPassthroughStream;
    const fixture = fixtureToResponse(join(FIXTURES_DIR, "regression-zai-glm5-usage.sse"));
    const ctx = createMockContext();

    let tokenInput = 0;
    let tokenOutput = 0;

    const response = createAnthropicPassthroughStream(ctx, fixture, {
      modelName: "glm-5",
      onTokenUpdate: (input, output) => {
        tokenInput = input;
        tokenOutput = output;
      },
    });

    await parseClaudeSseStream(response);

    // Z.AI sends input_tokens:0 in message_start, real value in message_delta.usage
    // Before fix: tokenInput stayed at 0 because data.usage only read output_tokens
    expect(tokenInput).toBe(8897);
    expect(tokenOutput).toBe(125);
  });
});

// ─── Anthropic SSE: Thinking Block Filtering Tests ──────────────────────────

describe("Anthropic SSE: thinking block filtering", () => {
  async function getParser() {
    const mod = await import("./handlers/shared/stream-parsers/anthropic-sse.js");
    return mod.createAnthropicPassthroughStream;
  }

  test("without adapter, thinking passes through (backward compat)", async () => {
    const createAnthropicPassthroughStream = await getParser();
    const fixture = fixtureToResponse(join(FIXTURES_DIR, "SEED-anthropic-thinking.sse"));
    const ctx = createMockContext();

    const response = createAnthropicPassthroughStream(ctx, fixture, {
      modelName: "test-model",
    });

    const events = await parseClaudeSseStream(response);

    // Thinking block start should be present
    const thinkingStart = events.find(
      (e) =>
        e.data?.type === "content_block_start" && e.data?.content_block?.type === "thinking"
    );
    expect(thinkingStart).toBeDefined();

    // Thinking delta should be present
    const thinkingDelta = events.find(
      (e) => e.data?.type === "content_block_delta" && e.data?.delta?.type === "thinking_delta"
    );
    expect(thinkingDelta).toBeDefined();

    // Text content should still be there
    const text = extractText(events);
    expect(text).toContain("Visible response");

    // Tool use should still be there
    const tools = extractToolNames(events);
    expect(tools).toContain("Bash");
  });

  test("with adapter shouldFilterThinking=true, thinking is stripped", async () => {
    const createAnthropicPassthroughStream = await getParser();
    const { MiniMaxModelDialect } = await import("./adapters/minimax-model-dialect.js");
    const adapter = new MiniMaxModelDialect("minimax-m2.5");

    const fixture = fixtureToResponse(join(FIXTURES_DIR, "SEED-anthropic-thinking.sse"));
    const ctx = createMockContext();

    const response = createAnthropicPassthroughStream(ctx, fixture, {
      modelName: "minimax-m2.5",
      adapter,
    });

    const events = await parseClaudeSseStream(response);

    // No thinking block start should be present
    const thinkingStart = events.find(
      (e) =>
        e.data?.type === "content_block_start" && e.data?.content_block?.type === "thinking"
    );
    expect(thinkingStart).toBeUndefined();

    // No thinking_delta should be present
    const thinkingDelta = events.find(
      (e) => e.data?.type === "content_block_delta" && e.data?.delta?.type === "thinking_delta"
    );
    expect(thinkingDelta).toBeUndefined();

    // No signature_delta should be present
    const signatureDelta = events.find(
      (e) => e.data?.type === "content_block_delta" && e.data?.delta?.type === "signature_delta"
    );
    expect(signatureDelta).toBeUndefined();

    // Text content should still be there
    const text = extractText(events);
    expect(text).toContain("Visible response");

    // Tool use should still be there
    const tools = extractToolNames(events);
    expect(tools).toContain("Bash");
  });

  test("with adapter shouldFilterThinking=false, thinking passes through", async () => {
    const createAnthropicPassthroughStream = await getParser();
    const { DefaultAPIFormat } = await import("./adapters/base-api-format.js");
    const adapter = new DefaultAPIFormat("test-model");

    const fixture = fixtureToResponse(join(FIXTURES_DIR, "SEED-anthropic-thinking.sse"));
    const ctx = createMockContext();

    const response = createAnthropicPassthroughStream(ctx, fixture, {
      modelName: "test-model",
      adapter,
    });

    const events = await parseClaudeSseStream(response);

    // Thinking block start should be present (DefaultAPIFormat doesn't filter)
    const thinkingStart = events.find(
      (e) =>
        e.data?.type === "content_block_start" && e.data?.content_block?.type === "thinking"
    );
    expect(thinkingStart).toBeDefined();
  });

  test("content block indices are re-indexed after filtering", async () => {
    const createAnthropicPassthroughStream = await getParser();
    const { MiniMaxModelDialect } = await import("./adapters/minimax-model-dialect.js");
    const adapter = new MiniMaxModelDialect("minimax-m2.5");

    const fixture = fixtureToResponse(join(FIXTURES_DIR, "SEED-anthropic-thinking.sse"));
    const ctx = createMockContext();

    const response = createAnthropicPassthroughStream(ctx, fixture, {
      modelName: "minimax-m2.5",
      adapter,
    });

    const events = await parseClaudeSseStream(response);

    // The fixture has: thinking(index 0), text(index 1), tool_use(index 2)
    // After filtering thinking, text should be index 0, tool_use should be index 1

    const textStart = events.find(
      (e) =>
        e.data?.type === "content_block_start" && e.data?.content_block?.type === "text"
    );
    expect(textStart?.data?.index).toBe(0);

    const toolStart = events.find(
      (e) =>
        e.data?.type === "content_block_start" && e.data?.content_block?.type === "tool_use"
    );
    expect(toolStart?.data?.index).toBe(1);

    // text_delta should also have re-indexed index
    const textDelta = events.find(
      (e) => e.data?.type === "content_block_delta" && e.data?.delta?.type === "text_delta"
    );
    expect(textDelta?.data?.index).toBe(0);

    // input_json_delta should be index 1
    const toolDelta = events.find(
      (e) => e.data?.type === "content_block_delta" && e.data?.delta?.type === "input_json_delta"
    );
    expect(toolDelta?.data?.index).toBe(1);

    // content_block_stop for text should be index 0
    const textStop = events.find(
      (e) =>
        e.data?.type === "content_block_stop" && e.data?.index === 0
    );
    // Note: there will be a content_block_stop with index 0 for text (the thinking one was filtered)
    expect(textStop).toBeDefined();

    // content_block_stop for tool_use should be index 1
    const toolStop = events.find(
      (e) =>
        e.data?.type === "content_block_stop" && e.data?.index === 1
    );
    expect(toolStop).toBeDefined();
  });
});

// ─── Integration Tests: Real MiniMax M2.5 Captures ───────────────────────────
//
// Fixtures extracted from logs/claudish_2026-04-16_12-24-09.log — real production
// SSE from MiniMax's Anthropic-compatible endpoint. Every MiniMax response includes
// thinking blocks that must be filtered to prevent leaking internal reasoning.

describe("Integration: Real MiniMax M2.5 SSE — thinking filtering", () => {
  async function getParser() {
    const mod = await import("./handlers/shared/stream-parsers/anthropic-sse.js");
    return mod.createAnthropicPassthroughStream;
  }

  async function makeMiniMaxAdapter() {
    const { MiniMaxModelDialect } = await import("./adapters/minimax-model-dialect.js");
    return new MiniMaxModelDialect("minimax-m2.5");
  }

  test("Turn 1: thinking+text+tool_use — thinking stripped, text and tool preserved with correct indices", async () => {
    const createAnthropicPassthroughStream = await getParser();
    const adapter = await makeMiniMaxAdapter();

    const fixture = fixtureToResponse(join(FIXTURES_DIR, "minimax-m25-turn1-thinking-text-tool.sse"));
    const ctx = createMockContext();

    const response = createAnthropicPassthroughStream(ctx, fixture, {
      modelName: "minimax-m2.5",
      adapter,
    });

    const events = await parseClaudeSseStream(response);

    // NO thinking blocks should appear
    const thinkingEvents = events.filter(
      (e) => e.data?.content_block?.type === "thinking" || e.data?.delta?.type === "thinking_delta"
    );
    expect(thinkingEvents.length).toBe(0);

    // NO signature_delta events should appear
    const signatureEvents = events.filter(
      (e) => e.data?.delta?.type === "signature_delta"
    );
    expect(signatureEvents.length).toBe(0);

    // Text block should be at index 0 (was index 1 before filtering thinking at index 0)
    const textStart = events.find(
      (e) => e.data?.type === "content_block_start" && e.data?.content_block?.type === "text"
    );
    expect(textStart).toBeDefined();
    expect(textStart?.data?.index).toBe(0);

    // Text content should be the real MiniMax response
    const text = extractText(events);
    expect(text).toContain("investigate the OAuth token handling");

    // Tool_use block should be at index 1 (was index 2)
    const toolStart = events.find(
      (e) => e.data?.type === "content_block_start" && e.data?.content_block?.type === "tool_use"
    );
    expect(toolStart).toBeDefined();
    expect(toolStart?.data?.index).toBe(1);
    expect(toolStart?.data?.content_block?.name).toBe("Grep");

    // Tool input should be preserved with real data
    const toolDeltas = events.filter(
      (e) => e.data?.delta?.type === "input_json_delta" && e.data?.index === 1
    );
    expect(toolDeltas.length).toBeGreaterThan(0);

    // message_delta with stop_reason should survive
    const stopReason = extractStopReason(events);
    expect(stopReason).toBe("tool_use");

    // message_stop should survive
    const msgStop = events.find((e) => e.data?.type === "message_stop");
    expect(msgStop).toBeDefined();
  });

  test("Turn 2: thinking+tool_only (no text) — tool_use re-indexed from 1 to 0", async () => {
    const createAnthropicPassthroughStream = await getParser();
    const adapter = await makeMiniMaxAdapter();

    const fixture = fixtureToResponse(join(FIXTURES_DIR, "minimax-m25-turn2-thinking-tool-only.sse"));
    const ctx = createMockContext();

    const response = createAnthropicPassthroughStream(ctx, fixture, {
      modelName: "minimax-m2.5",
      adapter,
    });

    const events = await parseClaudeSseStream(response);

    // NO thinking blocks
    const thinkingStarts = events.filter(
      (e) => e.data?.content_block?.type === "thinking"
    );
    expect(thinkingStarts.length).toBe(0);

    // NO text blocks (this turn had none)
    const textStarts = events.filter(
      (e) => e.data?.content_block?.type === "text"
    );
    expect(textStarts.length).toBe(0);

    // Tool_use should be at index 0 (was index 1 after thinking at index 0)
    const toolStart = events.find(
      (e) => e.data?.type === "content_block_start" && e.data?.content_block?.type === "tool_use"
    );
    expect(toolStart?.data?.index).toBe(0);
    expect(toolStart?.data?.content_block?.name).toBe("Read");

    // Tool input contains real file path
    const toolInput = events
      .filter((e) => e.data?.delta?.type === "input_json_delta" && e.data?.index === 0)
      .map((e) => e.data.delta.partial_json)
      .join("");
    expect(toolInput).toContain("codex-oauth.ts");

    // Token tracking still works with real usage data
    const stopReason = extractStopReason(events);
    expect(stopReason).toBe("tool_use");
  });

  test("Turn 3: thinking with multi-chunk deltas — all thinking content stripped", async () => {
    const createAnthropicPassthroughStream = await getParser();
    const adapter = await makeMiniMaxAdapter();

    const fixture = fixtureToResponse(join(FIXTURES_DIR, "minimax-m25-turn3-thinking-multichunk.sse"));
    const ctx = createMockContext();

    const response = createAnthropicPassthroughStream(ctx, fixture, {
      modelName: "minimax-m2.5",
      adapter,
    });

    const events = await parseClaudeSseStream(response);

    // NO thinking or signature deltas at all
    const thinkingRelated = events.filter(
      (e) =>
        e.data?.content_block?.type === "thinking" ||
        e.data?.delta?.type === "thinking_delta" ||
        e.data?.delta?.type === "signature_delta"
    );
    expect(thinkingRelated.length).toBe(0);

    // This fixture has: thinking(0), text(1), tool_use(2) with real escaped regex
    const toolStart = events.find(
      (e) => e.data?.type === "content_block_start" && e.data?.content_block?.type === "tool_use"
    );
    expect(toolStart?.data?.index).toBe(1); // re-indexed from 2

    // Tool input has real escaped regex pattern from production
    const toolInput = events
      .filter((e) => e.data?.delta?.type === "input_json_delta" && e.data?.index === 1)
      .map((e) => e.data.delta.partial_json)
      .join("");
    expect(toolInput).toContain("api");
  });

  test("Without adapter, real MiniMax thinking blocks pass through (backward compat)", async () => {
    const createAnthropicPassthroughStream = await getParser();

    const fixture = fixtureToResponse(join(FIXTURES_DIR, "minimax-m25-turn1-thinking-text-tool.sse"));
    const ctx = createMockContext();

    const response = createAnthropicPassthroughStream(ctx, fixture, {
      modelName: "minimax-m2.5",
      // No adapter passed — backward compat mode
    });

    const events = await parseClaudeSseStream(response);

    // Thinking blocks SHOULD be present (no filtering without adapter)
    const thinkingStart = events.find(
      (e) => e.data?.type === "content_block_start" && e.data?.content_block?.type === "thinking"
    );
    expect(thinkingStart).toBeDefined();

    // Thinking deltas with real content should be present
    const thinkingDeltas = events.filter(
      (e) => e.data?.delta?.type === "thinking_delta"
    );
    expect(thinkingDeltas.length).toBeGreaterThan(0);

    // Original indices preserved (thinking=0, text=1, tool=2)
    const textStart = events.find(
      (e) => e.data?.type === "content_block_start" && e.data?.content_block?.type === "text"
    );
    expect(textStart?.data?.index).toBe(1);

    const toolStart = events.find(
      (e) => e.data?.type === "content_block_start" && e.data?.content_block?.type === "tool_use"
    );
    expect(toolStart?.data?.index).toBe(2);
  });
});

// ─── Regression: Z.AI in-stream error handling (GitHub #106) ─────────────────

describe("Regression: Anthropic SSE in-stream error handling (#106)", () => {
  async function getParser() {
    const mod = await import("./handlers/shared/stream-parsers/anthropic-sse.js");
    return mod.createAnthropicPassthroughStream;
  }

  test("mid-stream error finalizes gracefully with message_stop instead of a bare error event (non-filtering path)", async () => {
    // REGRESSION (#106 → no-crash hardening): Z.AI returns HTTP 200 with
    // {"error":{"code":"1305","message":"..."}} in-stream. The original fix
    // forwarded a Claude-shaped `error` event, but Claude Code still treats a
    // turn that ends on a bare `error` event (no message_stop) as "empty or
    // malformed response (HTTP 200)" and crashes. The hardened contract:
    // ALWAYS emit a valid terminal message. Mid-stream (text already sent), we
    // close the open block and emit message_delta + message_stop — preserving
    // the partial text and ending the turn cleanly.
    const createAnthropicPassthroughStream = await getParser();
    const fixture = fixtureToResponse(join(FIXTURES_DIR, "regression-zai-glm5-instream-error.sse"));
    const ctx = createMockContext();

    const response = createAnthropicPassthroughStream(ctx, fixture, {
      modelName: "glm-5.1",
    });

    const events = await parseClaudeSseStream(response);

    // Partial text received before the error is preserved.
    const text = extractText(events);
    expect(text).toContain("Hello");

    // No bare `error` event reaches the client — that is what crashes the turn.
    const errorEvent = events.find((e) => e.data?.type === "error");
    expect(errorEvent).toBeUndefined();

    // The open content block is closed.
    const blockStop = events.find((e) => e.data?.type === "content_block_stop");
    expect(blockStop).toBeDefined();

    // The turn ends cleanly with message_delta + message_stop.
    const msgDelta = events.find((e) => e.data?.type === "message_delta");
    expect(msgDelta?.data?.delta?.stop_reason).toBe("end_turn");
    const msgStop = events.find((e) => e.data?.type === "message_stop");
    expect(msgStop).toBeDefined();
  });

  test("mid-stream error finalizes gracefully in the filtering path (adapter present)", async () => {
    // Same scenario with filterThinking enabled (MiniMax, Kimi).
    const createAnthropicPassthroughStream = await getParser();
    const { MiniMaxModelDialect } = await import("./adapters/minimax-model-dialect.js");
    const adapter = new MiniMaxModelDialect("minimax-m2.5");

    const fixture = fixtureToResponse(join(FIXTURES_DIR, "regression-zai-glm5-instream-error.sse"));
    const ctx = createMockContext();

    const response = createAnthropicPassthroughStream(ctx, fixture, {
      modelName: "minimax-m2.5",
      adapter,
    });

    const events = await parseClaudeSseStream(response);

    // No bare error event; the turn terminates with message_stop.
    const errorEvent = events.find((e) => e.data?.type === "error");
    expect(errorEvent).toBeUndefined();
    const msgStop = events.find((e) => e.data?.type === "message_stop");
    expect(msgStop).toBeDefined();
  });

  test("start-of-stream rate-limit emits a synthetic message with a rate-limit notice (no message_start yet)", async () => {
    // The burst-limit ([1302]) case: the provider sends a ping then an error
    // BEFORE any message envelope. finalizeWithError must synthesize the whole
    // message (message_start + a user-visible notice + message_stop) so the
    // client renders a clean turn rather than crashing on an empty 200.
    const createAnthropicPassthroughStream = await getParser();
    const fixture = fixtureToResponse(
      join(FIXTURES_DIR, "regression-zai-glm5-startofstream-ratelimit.sse")
    );
    const ctx = createMockContext();

    const response = createAnthropicPassthroughStream(ctx, fixture, {
      modelName: "glm-5.1",
    });

    const events = await parseClaudeSseStream(response);

    // A synthetic message envelope is produced even though upstream sent none.
    const msgStart = events.find((e) => e.data?.type === "message_start");
    expect(msgStart).toBeDefined();

    // The notice is rate-limit-aware (mentions retrying / a moment), not a raw dump.
    const text = extractText(events);
    expect(text.toLowerCase()).toContain("rate limited");

    // No bare error event; the turn ends with message_stop.
    const errorEvent = events.find((e) => e.data?.type === "error");
    expect(errorEvent).toBeUndefined();
    const msgStop = events.find((e) => e.data?.type === "message_stop");
    expect(msgStop).toBeDefined();
  });
});

// ─── Regression: web search remap (agentic blocking fix) ───────────────────
//
// CoursIA incident 2026-06-10: provider-side web search (web_search tool call
// or GLM <searchWeb> tag) was suppressed and replaced with a text block +
// stop_reason "end_turn" — the agent ended its turn on raw search results and
// the agentic loop stalled. The fix remaps these to a synthetic WebSearch
// tool_use (stop_reason "tool_use") whenever the client declared WebSearch,
// so Claude Code runs its own WebSearch and the conversation continues.

describe("Regression: web search remap to client WebSearch tool_use", () => {
  async function getParser() {
    const mod = await import("./handlers/shared/openai-compat.js");
    return mod.createStreamingResponseHandler;
  }

  async function getDefaultAdapter() {
    const mod = await import("./adapters/base-api-format.js");
    return new mod.DefaultAPIFormat("test-model");
  }

  function sseToResponse(content: string): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(content));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  const WEBSEARCH_SCHEMA = {
    name: "WebSearch",
    description: "Search the web",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  };
  const READ_SCHEMA = {
    name: "Read",
    description: "Read a file",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  };

  // Provider emits a structured web_search tool call (GLM/z.ai dialect)
  const WEB_SEARCH_TOOLCALL_SSE = [
    `data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Let me look that up."},"finish_reason":null}]}`,
    ``,
    `data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_ws_1","type":"function","function":{"name":"web_search","arguments":""}}]},"finish_reason":null}]}`,
    ``,
    `data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"query\\":\\"chatterbox tts docker compose\\"}"}}]},"finish_reason":null}]}`,
    ``,
    `data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":7}}`,
    ``,
    `data: [DONE]`,
    ``,
  ].join("\n");

  test("web_search tool call + WebSearch declared → remapped tool_use, stop_reason=tool_use", async () => {
    const createStreamingResponseHandler = await getParser();
    const adapter = await getDefaultAdapter();
    const ctx = createMockContext();

    const response = createStreamingResponseHandler(
      ctx,
      sseToResponse(WEB_SEARCH_TOOLCALL_SSE),
      adapter,
      "glm-5.1",
      null,
      undefined,
      [WEBSEARCH_SCHEMA, READ_SCHEMA]
    );

    const events = await parseClaudeSseStream(response);

    // The provider tool call is remapped to the client's WebSearch tool
    const tools = extractToolNames(events);
    expect(tools).toContain("WebSearch");

    // The remapped input carries the original query
    const inputJson = events
      .filter((e) => e.data?.type === "content_block_delta" && e.data?.delta?.type === "input_json_delta")
      .map((e) => e.data.delta.partial_json)
      .join("");
    expect(JSON.parse(inputJson)).toEqual({ query: "chatterbox tts docker compose" });

    // THE fix: the turn must continue, not end on injected text
    expect(extractStopReason(events)).toBe("tool_use");

    // No raw search-results text block injected
    expect(extractText(events)).not.toContain("[Web search");
  });

  test("web_search tool call WITHOUT WebSearch declared → suppression fallback, stop_reason=end_turn", async () => {
    const createStreamingResponseHandler = await getParser();
    const adapter = await getDefaultAdapter();
    const ctx = createMockContext();

    const response = createStreamingResponseHandler(
      ctx,
      sseToResponse(WEB_SEARCH_TOOLCALL_SSE),
      adapter,
      "glm-5.1",
      null,
      undefined,
      [READ_SCHEMA] // no WebSearch in the request
    );

    const events = await parseClaudeSseStream(response);

    // No tool_use leaks through (web_search must not reach the client)
    expect(extractToolNames(events)).toHaveLength(0);

    // Results (or a graceful degradation notice) are injected as text
    expect(extractText(events)).toContain("[Web search");

    // Legitimate end_turn: without WebSearch declared the client could not
    // execute a remapped tool anyway (e.g. sub-agents without web tools).
    expect(extractStopReason(events)).toBe("end_turn");
  });

  test("GLM <searchWeb> tag + WebSearch declared → remapped tool_use, stop_reason=tool_use", async () => {
    const createStreamingResponseHandler = await getParser();
    const adapter = await getDefaultAdapter();
    const ctx = createMockContext();

    const glmSse = [
      `data: {"id":"c2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"<searchWeb><query>devnen Chatterbox-TTS-Server docker run</query></searchWeb>"},"finish_reason":null}]}`,
      ``,
      `data: {"id":"c2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":4}}`,
      ``,
      `data: [DONE]`,
      ``,
    ].join("\n");

    const response = createStreamingResponseHandler(
      ctx,
      sseToResponse(glmSse),
      adapter,
      "glm-5.1",
      null,
      undefined,
      [WEBSEARCH_SCHEMA, READ_SCHEMA]
    );

    const events = await parseClaudeSseStream(response);

    const tools = extractToolNames(events);
    expect(tools).toContain("WebSearch");

    const inputJson = events
      .filter((e) => e.data?.type === "content_block_delta" && e.data?.delta?.type === "input_json_delta")
      .map((e) => e.data.delta.partial_json)
      .join("");
    expect(JSON.parse(inputJson)).toEqual({ query: "devnen Chatterbox-TTS-Server docker run" });

    expect(extractStopReason(events)).toBe("tool_use");
  });
});

// ─── Regression: empty-response cause classification (no destructive /compact) ─
// Providers (GLM, qwen) sometimes return finish_reason with zero content. The
// old code injected a blanket "context too large → compact" message for every
// empty response, pushing agents into a destructive /compact on transient
// empties (sub-agents with tiny contexts) — discarding context mid-task.
// The fix classifies by finish_reason + prompt_tokens and leads transient
// empties with "retry, NOT a context problem".
describe("Regression: empty-response cause classification", () => {
  async function getParser() {
    const mod = await import("./handlers/shared/openai-compat.js");
    return mod.createStreamingResponseHandler;
  }

  async function getDefaultAdapter() {
    const mod = await import("./adapters/base-api-format.js");
    return new mod.DefaultAPIFormat("test-model");
  }

  function sseToResponse(content: string): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(content));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  // finish_reason "stop", tiny context → TRANSIENT (must NOT push /compact)
  const EMPTY_STOP_SMALL = [
    `data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}`,
    ``,
    `data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":0}}`,
    ``,
    `data: [DONE]`,
    ``,
  ].join("\n");

  // finish_reason "length" → OVERFLOW (mentions /compact)
  const EMPTY_LENGTH = [
    `data: {"id":"c2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}`,
    ``,
    `data: {"id":"c2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":5000,"completion_tokens":0}}`,
    ``,
    `data: [DONE]`,
    ``,
  ].join("\n");

  // finish_reason "content_filter" → CONTENT-FILTER message
  const EMPTY_FILTER = [
    `data: {"id":"c3","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}`,
    ``,
    `data: {"id":"c3","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}],"usage":{"prompt_tokens":20,"completion_tokens":0}}`,
    ``,
    `data: [DONE]`,
    ``,
  ].join("\n");

  test("empty + finish_reason=stop + small context → transient message (no /compact push)", async () => {
    const createStreamingResponseHandler = await getParser();
    const adapter = await getDefaultAdapter();
    const ctx = createMockContext();

    const response = createStreamingResponseHandler(
      ctx,
      sseToResponse(EMPTY_STOP_SMALL),
      adapter,
      "glm-5.1",
      null,
      undefined,
      undefined
    );

    const events = await parseClaudeSseStream(response);
    const text = extractText(events);

    // Transient empties lead with retry guidance, NOT compact.
    expect(text).toMatch(/transient/i);
    expect(text).toMatch(/retry/i);
    expect(text).toMatch(/NOT a context-size problem/i);
    // Must NOT be the old blanket "context is too large → compact" framing.
    expect(text).not.toMatch(/This usually happens when the conversation context is too large/);

    // Still terminates cleanly so the agent's turn ends gracefully.
    expect(extractStopReason(events)).toBe("end_turn");
  });

  test("empty + finish_reason=length → overflow message (mentions /compact)", async () => {
    const createStreamingResponseHandler = await getParser();
    const adapter = await getDefaultAdapter();
    const ctx = createMockContext();

    const response = createStreamingResponseHandler(
      ctx,
      sseToResponse(EMPTY_LENGTH),
      adapter,
      "glm-5.1",
      null,
      undefined,
      undefined
    );

    const events = await parseClaudeSseStream(response);
    const text = extractText(events);

    // A genuine length/overflow empty correctly advises /compact.
    expect(text).toMatch(/context is very large|\/compact/i);
    // And surfaces the real finish_reason.
    expect(text).toMatch(/length/);
  });

  test("empty + finish_reason=content_filter → content-filter message (not context)", async () => {
    const createStreamingResponseHandler = await getParser();
    const adapter = await getDefaultAdapter();
    const ctx = createMockContext();

    const response = createStreamingResponseHandler(
      ctx,
      sseToResponse(EMPTY_FILTER),
      adapter,
      "glm-5.1",
      null,
      undefined,
      undefined
    );

    const events = await parseClaudeSseStream(response);
    const text = extractText(events);

    expect(text).toMatch(/content policy|filtered/i);
    // A content filter is NOT a context-size problem.
    expect(text).not.toMatch(/context is very large/i);
  });
});
