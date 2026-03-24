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
    const request: any = { model: "minimax-m2.5", messages: [], thinking: { budget_tokens: 10000 } };
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

  test("MiniMaxModelDialect: context window is 204_800", async () => {
    const { MiniMaxModelDialect } = await import("./adapters/minimax-model-dialect.js");
    const adapter = new MiniMaxModelDialect("minimax-m2.5");
    expect(adapter.getContextWindow()).toBe(204_800);
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

  test("resolveModelDialect selects correct adapter for model IDs", async () => {
    const { resolveModelDialect } = await import("./providers/provider-profiles.js");

    expect(resolveModelDialect("glm-5").getName()).toBe("GLMModelDialect");
    expect(resolveModelDialect("grok-3").getName()).toBe("GrokModelDialect");
    expect(resolveModelDialect("minimax-m2.5").getName()).toBe("MiniMaxModelDialect");
    expect(resolveModelDialect("qwen3.5-plus").getName()).toBe("QwenModelDialect");
    expect(resolveModelDialect("deepseek-r1").getName()).toBe("DeepSeekModelDialect");
    expect(resolveModelDialect("unknown-model").getName()).toBe("DefaultAPIFormat");
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
  test("getStreamFormat returns openai-responses-sse", async () => {
    const { CodexAPIFormat } = await import("./adapters/codex-api-format.js");
    expect(new CodexAPIFormat("codex-mini").getStreamFormat()).toBe("openai-responses-sse");
  });

  test("getName returns CodexAPIFormat", async () => {
    const { CodexAPIFormat } = await import("./adapters/codex-api-format.js");
    expect(new CodexAPIFormat("codex-mini").getName()).toBe("CodexAPIFormat");
  });

  test("resolveModelDialect selects CodexAPIFormat for codex-mini", async () => {
    const { resolveModelDialect } = await import("./providers/provider-profiles.js");
    expect(resolveModelDialect("codex-mini").getName()).toBe("CodexAPIFormat");
  });
});

describe("ModelDialect interface compliance", () => {
  test("GLMAdapter implements translator methods", async () => {
    const { GLMModelDialect } = await import("./adapters/glm-model-dialect.js");
    const t = new GLMModelDialect("glm-5");
    expect(typeof t.getContextWindow()).toBe("number");
    expect(typeof t.supportsVision()).toBe("boolean");
    expect(typeof t.prepareRequest).toBe("function");
    expect(typeof t.getName).toBe("function");
  });
});

// ─── ProviderProfile Table Tests ─────────────────────────────────────────────

describe("Provider coverage completeness", () => {
  test("all expected providers create handlers via createHandlerForProvider", async () => {
    const { createHandlerForProvider } = await import("./providers/provider-profiles.js");
    const { getProviderByName } = await import("./providers/provider-definitions.js");

    // Providers wired through createHandlerForProvider (excludes vertex which needs env config)
    const expectedProviders = [
      "google", "gemini-codeassist", "openai",
      "minimax", "minimax-coding", "kimi", "kimi-coding", "zai",
      "glm", "glm-coding", "opencode-zen", "opencode-zen-go",
      "ollamacloud",
    ];

    for (const name of expectedProviders) {
      const def = getProviderByName(name);
      expect(def).toBeDefined();
      const handler = createHandlerForProvider(
        def!, "test-model", "test-key", "test-target", 4000,
        { isInteractive: false, invocationMode: "explicit-model" as const },
      );
      expect(handler).not.toBeNull();
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
});

// ─── Regression: Z.AI GLM-5 usage tokens (GitHub #74) ─────────────────────

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
