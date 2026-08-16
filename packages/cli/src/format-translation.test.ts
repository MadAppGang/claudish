/**
 * Format Translation Integration Tests
 *
 * Tests the SSE stream parser pipeline by replaying real (or seed) SSE fixtures
 * through the parser stack and asserting correct Claude SSE output.
 *
 * Workflow for adding regression tests from production failures:
 *   1. Run failing model with --debug-claudish: claudish --model kimi-k2.5 --debug-claudish ...
 *   2. Extract fixtures: bun run src/test-fixtures/extract-sse-from-log.ts logs/claudish_*.log
 *   3. Add a describe() block below referencing the new fixture
 *   4. Run: bun test src/format-translation.test.ts
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

/**
 * Consume a parser response with a wall-clock timeout while tracking the real
 * intervals it creates. The wrappers delegate to the native timer functions;
 * they only record whether parser teardown cleared its keepalive interval.
 */
async function parseWithTimeoutAndIntervalTracking(
  createResponse: () => Response,
  timeoutMs = 500
): Promise<{
  events: ClaudeEvent[] | null;
  timedOut: boolean;
  intervalsStarted: number;
  intervalsStillActive: number;
}> {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const activeIntervals = new Set<ReturnType<typeof globalThis.setInterval>>();
  let intervalsStarted = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutMarker = Symbol("stream parse timeout");

  globalThis.setInterval = ((...args: Parameters<typeof globalThis.setInterval>) => {
    const interval = originalSetInterval(...args);
    intervalsStarted++;
    activeIntervals.add(interval);
    return interval;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = ((...args: Parameters<typeof globalThis.clearInterval>) => {
    const [interval] = args;
    if (interval !== undefined) {
      activeIntervals.delete(interval as ReturnType<typeof globalThis.setInterval>);
    }
    return originalClearInterval(...args);
  }) as typeof globalThis.clearInterval;

  try {
    const response = createResponse();
    const result = await Promise.race([
      parseClaudeSseStream(response),
      new Promise<typeof timeoutMarker>((resolve) => {
        timeout = setTimeout(() => resolve(timeoutMarker), timeoutMs);
      }),
    ]);

    return {
      events: result === timeoutMarker ? null : result,
      timedOut: result === timeoutMarker,
      intervalsStarted,
      intervalsStillActive: activeIntervals.size,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    for (const interval of activeIntervals) originalClearInterval(interval);
  }
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

describe("Regression: Anthropic SSE abandoned streams emit a terminal tail", () => {
  const encoder = new TextEncoder();

  async function getParser() {
    const mod = await import("./handlers/shared/stream-parsers/anthropic-sse.js");
    return mod.createAnthropicPassthroughStream;
  }

  function frame(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function messageStart(model = "test-model"): string {
    return frame("message_start", {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    });
  }

  function responseThatDrops(frames: string[]): Response {
    let nextFrame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emitNext = () => {
          if (nextFrame < frames.length) {
            controller.enqueue(encoder.encode(frames[nextFrame++]));
            timer = setTimeout(emitNext, 0);
            return;
          }
          timer = setTimeout(() => controller.error(new Error("upstream socket closed")), 0);
        };

        emitNext();
      },
      cancel() {
        if (timer) clearTimeout(timer);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  test("mid-stream socket close preserves partial text, emits message_stop, and terminates", async () => {
    const createAnthropicPassthroughStream = await getParser();
    const fixture = responseThatDrops([
      messageStart(),
      frame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "partial " },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "answer" },
      }),
    ]);
    let turnEndCalls = 0;
    let tokenUpdate: [number, number] | null = null as [number, number] | null;

    const response = createAnthropicPassthroughStream(createMockContext(), fixture, {
      modelName: "test-model",
      onTurnEnd: () => {
        turnEndCalls++;
      },
      onTokenUpdate: (input, output) => {
        tokenUpdate = [input, output];
      },
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const events = await Promise.race([
        parseClaudeSseStream(response),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("abandoned stream did not terminate")), 500);
        }),
      ]);

      expect(extractText(events)).toBe("partial answer");
      expect(events.some((event) => event.data?.type === "message_stop")).toBe(true);
      expect(turnEndCalls).toBe(1);
      expect(tokenUpdate).toEqual([12, 0]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  });

  test("healthy stream remains byte-identical with one message_delta and one message_stop", async () => {
    const createAnthropicPassthroughStream = await getParser();
    const healthyStream = [
      messageStart(),
      frame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      frame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "complete" },
      }),
      frame("content_block_stop", { type: "content_block_stop", index: 0 }),
      frame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      }),
      frame("message_stop", { type: "message_stop" }),
    ].join("");

    const response = createAnthropicPassthroughStream(
      createMockContext(),
      new Response(healthyStream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
      { modelName: "test-model" }
    );
    const output = await response.text();
    const initialPing = 'event: ping\ndata: {"type":"ping"}\n\n';

    expect(output).toBe(`${initialPing}${healthyStream}`);

    const events = await parseClaudeSseStream(new Response(output));
    expect(events.filter((event) => event.data?.type === "message_delta")).toHaveLength(1);
    expect(events.filter((event) => event.data?.type === "message_stop")).toHaveLength(1);
  });

  test("synthetic tail honors an upstream tool_use stop reason", async () => {
    const createAnthropicPassthroughStream = await getParser();
    const fixture = responseThatDrops([
      messageStart(),
      frame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 4 },
      }),
    ]);
    const response = createAnthropicPassthroughStream(createMockContext(), fixture, {
      modelName: "test-model",
    });

    const events = await parseClaudeSseStream(response);
    const messageDeltas = events.filter((event) => event.data?.type === "message_delta");

    expect(messageDeltas).toHaveLength(2);
    expect(messageDeltas.at(-1)?.data?.delta?.stop_reason).toBe("tool_use");
  });

  test("synthetic tail closes an open content block before message_stop", async () => {
    const createAnthropicPassthroughStream = await getParser();
    const fixture = responseThatDrops([
      messageStart(),
      frame("content_block_start", {
        type: "content_block_start",
        index: 3,
        content_block: { type: "text", text: "" },
      }),
    ]);
    const response = createAnthropicPassthroughStream(createMockContext(), fixture, {
      modelName: "test-model",
    });

    const events = await parseClaudeSseStream(response);
    // Under index clamping (see anthropic-sse index-clamping tests), the
    // client sees the block at the renumbered sequential index (0), not the
    // upstream index (3) — so the synthetic tail must close the index the
    // client actually has open.
    const blockStopIndex = events.findIndex(
      (event) => event.data?.type === "content_block_stop" && event.data?.index === 0
    );
    const messageStopIndex = events.findIndex((event) => event.data?.type === "message_stop");

    expect(blockStopIndex).toBeGreaterThan(-1);
    expect(messageStopIndex).toBeGreaterThan(blockStopIndex);
  });

  test("drop before message_start produces a complete parseable synthetic turn", async () => {
    const createAnthropicPassthroughStream = await getParser();
    const response = createAnthropicPassthroughStream(createMockContext(), responseThatDrops([]), {
      modelName: "test-model",
    });

    const events = await parseClaudeSseStream(response);

    expect(events.find((event) => event.data?.type === "message_start")?.data?.message?.model).toBe(
      "test-model"
    );
    expect(events.some((event) => event.data?.type === "message_delta")).toBe(true);
    expect(events.some((event) => event.data?.type === "message_stop")).toBe(true);
  });

  test("synthetic frames remain valid JSON when modelName contains a quote and backslash", async () => {
    const createAnthropicPassthroughStream = await getParser();
    const modelName = 'provider/model"quoted\\path';
    const response = createAnthropicPassthroughStream(createMockContext(), responseThatDrops([]), {
      modelName,
    });

    const output = await response.text();
    const dataLines = output
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6));
    const parsed = dataLines.map((line) => JSON.parse(line));

    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.find((data) => data.type === "message_start")?.message?.model).toBe(modelName);
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
  test("MiniMaxModelDialect: thinking maps to a {type} toggle (never reasoning_split)", async () => {
    const { MiniMaxModelDialect } = await import("./adapters/minimax-model-dialect.js");
    const adapter = new MiniMaxModelDialect("minimax-m2.5");

    // MiniMax's Anthropic-compatible endpoint takes a BOOLEAN `thinking` toggle
    // ({type:"adaptive"|"disabled"}), NOT a budget. A legacy budget hint
    // resolves to an effort level which maps to the toggle. prepareRequest must
    // NOT convert it to reasoning_split.
    const request: any = {
      model: "minimax-m2.5",
      messages: [],
      thinking: { budget_tokens: 10000 },
    };
    const original = { thinking: { budget_tokens: 10000 } };

    adapter.prepareRequest(request, original);
    expect(request.reasoning_split).toBeUndefined();
    expect(request.thinking).toEqual({ type: "adaptive" });
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

  test("OpenAIAdapter: thinking → reasoning_effort for o3", async () => {
    const { OpenAIAPIFormat } = await import("./adapters/openai-api-format.js");
    const adapter = new OpenAIAPIFormat("o3-mini");

    const request: any = { model: "o3-mini", messages: [] };
    const original = { thinking: { budget_tokens: 32000 } };

    adapter.prepareRequest(request, original);
    expect(request.reasoning_effort).toBe("high");
    expect(request.thinking).toBeUndefined();
  });

  test("GLMAdapter: glm-5 converts Anthropic budget thinking to GLM's toggle", async () => {
    const { GLMModelDialect } = await import("./adapters/glm-model-dialect.js");
    const adapter = new GLMModelDialect("glm-5");

    const request: any = { model: "glm-5", messages: [], thinking: { budget_tokens: 10000 } };
    const original = { thinking: { budget_tokens: 10000 } };

    adapter.prepareRequest(request, original);
    expect(request.thinking).toEqual({ type: "enabled" });
    expect(request.thinking.budget_tokens).toBeUndefined();
  });

  test("GLMAdapter: pre-4.5 GLM strips Anthropic budget thinking", async () => {
    const { GLMModelDialect } = await import("./adapters/glm-model-dialect.js");
    const adapter = new GLMModelDialect("glm-4-plus");

    const request: any = {
      model: "glm-4-plus",
      messages: [],
      thinking: { budget_tokens: 10000 },
    };
    const original = { thinking: { budget_tokens: 10000 } };

    adapter.prepareRequest(request, original);
    expect(request.thinking).toBeUndefined();
  });
});

// ─── APIFormat: getStreamFormat() Tests ──────────────────────────────────────

// ─── ProviderProfile Table Tests ─────────────────────────────────────────────

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
                {
                  type: "text",
                  text: '{"size_bytes": 358688, "viewport": {"width": 1800, "height": 991}}',
                },
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
            {
              type: "tool_use",
              id: "toolu_read_1",
              name: "Read",
              input: { file_path: "/tmp/test.ts" },
            },
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
          content: [{ type: "tool_use", id: "toolu_multi_1", name: "multi_screenshot", input: {} }],
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

// ─── Regression: OpenAI/Codex images in tool_result (Read of an image file) ──
//
// Real production failure: a claudish session on gpt-5.6-sol (codex Responses
// API) Read screenshot files. Each Read returns a tool_result containing an
// image; the converter JSON-stringified that content, so a ~350KB base64 image
// became ~90k TEXT tokens in the tool output. Three of them + the conversation
// blew the context window: "[API Error: context_length_exceeded]". Images in a
// tool_result must ride as image_url (→ input_image), never as text.
// (Transcript: aniflow/mastra cdadb661, messages #31/#32.)
describe("Regression: OpenAI/Codex images in tool_result", () => {
  async function getConverter() {
    const mod = await import("./handlers/shared/format/openai-messages.js");
    return mod.convertMessagesToOpenAI;
  }
  async function getCodexFormat() {
    const mod = await import("./adapters/codex-api-format.js");
    return mod.CodexAPIFormat;
  }

  const TINY_PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

  const requestWithToolResultImage = {
    model: "gpt-5.6-sol",
    messages: [
      { role: "user", content: [{ type: "text", text: "read the screenshot" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_read_1", name: "Read", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_read_1",
            content: [
              { type: "text", text: "[Image: original 4514x2432, displayed at 2000x1078]" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: TINY_PNG_B64 },
              },
            ],
          },
        ],
      },
    ],
  };

  test("tool_result image becomes image_url, not JSON-stringified into the tool output", async () => {
    const convertMessagesToOpenAI = await getConverter();
    const messages = convertMessagesToOpenAI(requestWithToolResultImage, "gpt-5.6-sol");

    const toolMsg = messages.find((m: any) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    // Text stays in the tool output; the base64 must NOT be there.
    expect(toolMsg.content).toContain("original 4514x2432");
    expect(toolMsg.content).not.toContain(TINY_PNG_B64);

    // The image rides in its own user message as an image_url part.
    const imageMsg = messages.find(
      (m: any) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some((p: any) => p.type === "image_url")
    );
    expect(imageMsg).toBeDefined();
    const imagePart = imageMsg.content.find((p: any) => p.type === "image_url");
    expect(imagePart.image_url.url).toBe(`data:image/png;base64,${TINY_PNG_B64}`);
  });

  test("codex Responses payload sends the tool_result image as input_image (bounded tokens)", async () => {
    const convertMessagesToOpenAI = await getConverter();
    const CodexAPIFormat = await getCodexFormat();
    const messages = convertMessagesToOpenAI(requestWithToolResultImage, "gpt-5.6-sol");
    const payload = new CodexAPIFormat("gpt-5.6-sol").buildPayload(
      requestWithToolResultImage,
      messages,
      []
    );

    const serialized = JSON.stringify(payload);
    // Image is a proper input_image, and the base64 never lands in a tool output.
    expect(serialized).toContain('"input_image"');
    const toolOutputs = payload.input
      .filter((i: any) => i.type === "function_call_output")
      .map((i: any) => i.output || "")
      .join("");
    expect(toolOutputs).not.toContain(TINY_PNG_B64);
    expect(toolOutputs).toContain("original 4514x2432");
  });

  test("string tool_result still passes through unchanged", async () => {
    const convertMessagesToOpenAI = await getConverter();
    const messages = convertMessagesToOpenAI(
      {
        model: "gpt-5.6-sol",
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: "file contents here" },
            ],
          },
        ],
      },
      "gpt-5.6-sol"
    );
    const toolMsg = messages.find((m: any) => m.role === "tool");
    expect(toolMsg.content).toBe("file contents here");
    // No stray image message.
    expect(
      messages.some(
        (m: any) =>
          m.role === "user" &&
          Array.isArray(m.content) &&
          m.content.some((p: any) => p.type === "image_url")
      )
    ).toBe(false);
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
      (e) => e.data?.type === "content_block_start" && e.data?.content_block?.type === "thinking"
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
      (e) => e.data?.type === "content_block_start" && e.data?.content_block?.type === "thinking"
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
      (e) => e.data?.type === "content_block_start" && e.data?.content_block?.type === "thinking"
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
      (e) => e.data?.type === "content_block_start" && e.data?.content_block?.type === "text"
    );
    expect(textStart?.data?.index).toBe(0);

    const toolStart = events.find(
      (e) => e.data?.type === "content_block_start" && e.data?.content_block?.type === "tool_use"
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
      (e) => e.data?.type === "content_block_stop" && e.data?.index === 0
    );
    // Note: there will be a content_block_stop with index 0 for text (the thinking one was filtered)
    expect(textStop).toBeDefined();

    // content_block_stop for tool_use should be index 1
    const toolStop = events.find(
      (e) => e.data?.type === "content_block_stop" && e.data?.index === 1
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

    const fixture = fixtureToResponse(
      join(FIXTURES_DIR, "minimax-m25-turn1-thinking-text-tool.sse")
    );
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
    const signatureEvents = events.filter((e) => e.data?.delta?.type === "signature_delta");
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

    const fixture = fixtureToResponse(
      join(FIXTURES_DIR, "minimax-m25-turn2-thinking-tool-only.sse")
    );
    const ctx = createMockContext();

    const response = createAnthropicPassthroughStream(ctx, fixture, {
      modelName: "minimax-m2.5",
      adapter,
    });

    const events = await parseClaudeSseStream(response);

    // NO thinking blocks
    const thinkingStarts = events.filter((e) => e.data?.content_block?.type === "thinking");
    expect(thinkingStarts.length).toBe(0);

    // NO text blocks (this turn had none)
    const textStarts = events.filter((e) => e.data?.content_block?.type === "text");
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

    const fixture = fixtureToResponse(
      join(FIXTURES_DIR, "minimax-m25-turn3-thinking-multichunk.sse")
    );
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

    const fixture = fixtureToResponse(
      join(FIXTURES_DIR, "minimax-m25-turn1-thinking-text-tool.sse")
    );
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
    const thinkingDeltas = events.filter((e) => e.data?.delta?.type === "thinking_delta");
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

  test("in-stream error payload emits proper error event instead of crashing (non-filtering path)", async () => {
    // REGRESSION: Z.AI returns HTTP 200 with {"error":{"code":"1305","message":"..."}} in-stream.
    // Before fix: raw error payload passed through, Claude Code crashes with "undefined is not an object"
    // because it expects a `type` field. Fixed in /dev:fix session dev-fix-20260417-224919-72cb371e
    const createAnthropicPassthroughStream = await getParser();
    const fixture = fixtureToResponse(join(FIXTURES_DIR, "regression-zai-glm5-instream-error.sse"));
    const ctx = createMockContext();

    const response = createAnthropicPassthroughStream(ctx, fixture, {
      modelName: "glm-5.1",
    });

    const events = await parseClaudeSseStream(response);

    // Should have received text content before the error
    const text = extractText(events);
    expect(text).toContain("Hello");

    // Should have an error event with proper structure
    const errorEvent = events.find((e) => e.data?.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.data?.error?.type).toBe("api_error");
    expect(errorEvent?.data?.error?.message).toContain("temporarily overloaded");

    // Should NOT have a message_stop (stream was terminated by error)
    const msgStop = events.find((e) => e.data?.type === "message_stop");
    expect(msgStop).toBeUndefined();
  });

  test("in-stream error payload handled in filtering path (adapter present)", async () => {
    // Same scenario but with filterThinking enabled (MiniMax, Kimi)
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

    // Should have an error event
    const errorEvent = events.find((e) => e.data?.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.data?.error?.message).toContain("temporarily overloaded");
  });
});

// ─── OpenAI Responses API SSE Parser Tests ──────────────────────────────────

/**
 * Regression: gpt-5.6-sol (Responses API) duplicated its FIRST tool call.
 *
 * Fixtures are real captures from POST https://api.openai.com/v1/responses
 * (gpt-5.6-sol, streaming, parallel function calls).
 *
 * The bug: the parser advanced `blockIndex` onto the first tool's block index
 * and never cleared `hasTextContent`, so end-of-stream emitted a second
 * content_block_stop for that tool. Claude Code re-dispatched it — two identical
 * agents, plan approval asked twice. Separately, `functionCalls` is keyed twice
 * per call (call_id + item_id), so `functionCalls.size` inflated the block index
 * and produced non-contiguous indices (1, 4, 6, 8 instead of 1, 2, 3, 4).
 */
describe("OpenAI Responses SSE → Claude SSE (createResponsesStreamHandler)", () => {
  async function getParser() {
    const mod = await import("./handlers/shared/stream-parsers/openai-responses-sse.js");
    return mod.createResponsesStreamHandler;
  }

  /** Every content_block_start index, in emission order. */
  function blockStarts(events: ClaudeEvent[]): { index: number; type: string; id?: string }[] {
    return events
      .filter((e) => e.data?.type === "content_block_start")
      .map((e) => ({
        index: e.data.index,
        type: e.data.content_block.type,
        id: e.data.content_block.id,
      }));
  }

  test("text + parallel tool calls: no duplicate tool_use, contiguous block indices", async () => {
    const createResponsesStreamHandler = await getParser();
    const fixture = fixtureToResponse(join(FIXTURES_DIR, "gpt-5.6-sol-responses-turn1.sse"));

    const response = createResponsesStreamHandler(createMockContext(), fixture, {
      modelName: "gpt-5.6-sol",
    });
    const events = await parseClaudeSseStream(response);

    const starts = blockStarts(events);
    const toolStarts = starts.filter((s) => s.type === "tool_use");

    // The fixture has 3 parallel read_file calls — exactly 3 tool_use blocks.
    expect(extractToolNames(events)).toEqual(["read_file", "read_file", "read_file"]);

    // Each tool_use id appears exactly once. (The bug re-emitted the first one.)
    const toolIds = toolStarts.map((t) => t.id);
    expect(new Set(toolIds).size).toBe(toolIds.length);

    // Block indices are contiguous from 0 and never reused.
    expect(starts.map((s) => s.index)).toEqual(starts.map((_, i) => i));

    // Exactly one stop per start, and no stop for a block that never started.
    const stops = events
      .filter((e) => e.data?.type === "content_block_stop")
      .map((e) => e.data.index);
    expect([...stops].sort((a, b) => a - b)).toEqual(starts.map((s) => s.index));

    expect(extractStopReason(events)).toBe("tool_use");
  });

  test("tool calls with no preceding text still emit one block per call", async () => {
    const createResponsesStreamHandler = await getParser();
    const fixture = fixtureToResponse(
      join(FIXTURES_DIR, "gpt-5.6-sol-responses-toolsonly-turn1.sse")
    );

    const response = createResponsesStreamHandler(createMockContext(), fixture, {
      modelName: "gpt-5.6-sol",
    });
    const events = await parseClaudeSseStream(response);

    const starts = blockStarts(events);
    expect(starts.every((s) => s.type === "tool_use")).toBe(true);
    expect(new Set(starts.map((s) => s.id)).size).toBe(starts.length);
    expect(starts.map((s) => s.index)).toEqual(starts.map((_, i) => i));
    expect(extractStopReason(events)).toBe("tool_use");
  });

  test("reasoning summary becomes a thinking block, not the assistant's answer", async () => {
    const createResponsesStreamHandler = await getParser();

    // Synthetic: the captured fixtures carry no reasoning summary (OpenAI only
    // returns one for verified orgs), but the codex transport requests
    // summary:auto and gpt-5.6 reasoning models emit these events in every turn.
    const sse =
      `data: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "Let me check the files." })}\n\n` +
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Reading them now." })}\n\n` +
      `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 7 } } })}\n\n`;
    const fixture = new Response(new Blob([sse]).stream(), { status: 200 });

    const response = createResponsesStreamHandler(createMockContext(), fixture, {
      modelName: "gpt-5.6-sol",
    });
    const events = await parseClaudeSseStream(response);

    const starts = blockStarts(events);
    expect(starts.map((s) => s.type)).toEqual(["thinking", "text"]);

    // Reasoning must NOT leak into the visible answer.
    expect(extractText(events)).toBe("Reading them now.");

    const thinking = events
      .filter((e) => e.data?.delta?.type === "thinking_delta")
      .map((e) => e.data.delta.thinking)
      .join("");
    expect(thinking).toBe("Let me check the files.");
    expect(extractStopReason(events)).toBe("end_turn");
  });

  test("multi-part reasoning summary keeps paragraph breaks between sections", async () => {
    // Real capture: 3 reasoning summary parts from cx@gpt-5.6-sol (OAuth codex
    // path). OpenAI streams each section as "**Title**" with the break between
    // parts carried structurally (summary_index), NOT in the text — so naive
    // concatenation smashes them into "**A****B****C**" (the reported glitch).
    const createResponsesStreamHandler = await getParser();
    const fixture = fixtureToResponse(
      join(FIXTURES_DIR, "gpt-5.6-sol-responses-reasoning-multipart.sse")
    );

    const response = createResponsesStreamHandler(createMockContext(), fixture, {
      modelName: "gpt-5.6-sol",
    });
    const events = await parseClaudeSseStream(response);

    const thinking = events
      .filter((e) => e.data?.delta?.type === "thinking_delta")
      .map((e) => e.data.delta.thinking)
      .join("");

    // The three real section titles are separated, not concatenated.
    expect(thinking).toContain(
      "**Auditing actual repository context**\n\n**Investigating log-based environment clues**"
    );
    expect(thinking).toContain(
      "**Investigating log-based environment clues**\n\n**Identifying possible Magus codebase relation**"
    );
    // The smash-together signature must be gone.
    expect(thinking).not.toContain("context****Investigating");
    expect(thinking).not.toContain("clues****Identifying");

    // Reasoning stays in the thinking block; the answer is separate.
    expect(blockStarts(events).map((s) => s.type)).toEqual(["thinking", "text"]);
    expect(extractText(events)).toBe("Done.");
  });
});

/**
 * Regression anchored to the REAL production failure.
 *
 * test-fixtures/transcripts/magus-fix-duplicate-agents-turn.json is a verbatim
 * capture of the Claude Code transcript turn (msg_1784036929422) where this bug
 * surfaced: gpt-5.6-sol asked for 4 parallel Agent investigations, but the buggy
 * parser re-emitted the first tool's content_block_stop, so Claude Code recorded
 * 5 tool_use blocks and ran "Trace missing plugin versions" twice.
 *
 * We (1) pin that historical signature, then (2) reconstruct the upstream
 * /v1/responses stream for that exact turn — deriving every call_id from the
 * real recorded tool_use ids — and replay it through the CURRENT parser,
 * asserting it now yields the 4 agents the model intended, no duplicate.
 */
describe("Regression: magus-fix duplicate-agents turn (real transcript)", () => {
  async function getParser() {
    const mod = await import("./handlers/shared/stream-parsers/openai-responses-sse.js");
    return mod.createResponsesStreamHandler;
  }

  const snapshot = JSON.parse(
    readFileSync(
      join(FIXTURES_DIR, "..", "transcripts", "magus-fix-duplicate-agents-turn.json"),
      "utf-8"
    )
  );

  test("historical signature: 5 blocks emitted, 4 distinct, first agent duplicated", () => {
    const emitted: string[] = snapshot.emittedToolIds;
    const distinct = [...new Set(emitted)];
    expect(emitted.length).toBe(5);
    expect(distinct.length).toBe(4);
    // The one repeated id is the FIRST tool — exactly the parser's off-by-one.
    const dup = emitted.find((id, i) => emitted.indexOf(id) !== i);
    expect(dup).toBe(emitted[0]);
    expect(snapshot.intendedToolIds).toEqual(distinct);
  });

  test("fixed parser reproduces the 4 intended agents, no duplicate", async () => {
    const createResponsesStreamHandler = await getParser();

    // Reconstruct upstream /v1/responses SSE for this turn. The parser derives
    // its output id as `toolu_${callId}` when callId lacks the toolu_ prefix, so
    // strip that prefix to recover each real upstream call_id.
    const ev = (o: any) => `data: ${JSON.stringify(o)}\n\n`;
    let sse = ev({ type: "response.created", response: { id: "resp_magus" } });
    // The model reasoned before dispatching (that reasoning is what set the
    // stale hasTextContent flag that triggered the duplicate).
    sse += ev({
      type: "response.reasoning_summary_text.delta",
      delta: "Four independent issues — fan out one investigator each.",
    });
    snapshot.tools.forEach((t: any, i: number) => {
      const callId = t.id.replace(/^toolu_/, "");
      const item = { type: "function_call", id: `fc_${i}`, call_id: callId, name: t.name };
      sse += ev({ type: "response.output_item.added", output_index: i, item });
      sse += ev({
        type: "response.function_call_arguments.delta",
        item_id: `fc_${i}`,
        call_id: callId,
        delta: `{"description":${JSON.stringify(t.desc)}}`,
      });
      sse += ev({ type: "response.output_item.done", output_index: i, item });
    });
    sse += ev({
      type: "response.completed",
      response: { usage: { input_tokens: 57092, output_tokens: 1159 } },
    });

    const fixture = new Response(new Blob([sse]).stream(), { status: 200 });
    const response = createResponsesStreamHandler(createMockContext(), fixture, {
      modelName: "gpt-5.6-sol",
    });
    const events = await parseClaudeSseStream(response);

    const toolStarts = events.filter(
      (e) => e.data?.type === "content_block_start" && e.data?.content_block?.type === "tool_use"
    );
    const emittedIds = toolStarts.map((e) => e.data.content_block.id);

    // The fix: exactly the 4 intended agents, in order, each once — NOT 5.
    expect(emittedIds).toEqual(snapshot.intendedToolIds);
    expect(new Set(emittedIds).size).toBe(emittedIds.length);
    expect(extractToolNames(events)).toEqual(["Agent", "Agent", "Agent", "Agent"]);

    // Every content block has contiguous index and exactly one matching stop.
    const starts = events
      .filter((e) => e.data?.type === "content_block_start")
      .map((e) => e.data.index);
    const stops = events
      .filter((e) => e.data?.type === "content_block_stop")
      .map((e) => e.data.index);
    expect(starts).toEqual(starts.map((_, i) => i));
    expect([...stops].sort((a, b) => a - b)).toEqual(starts);

    // Reasoning is a thinking block, not a 5th text/tool artefact.
    const firstBlockType = events.find((e) => e.data?.type === "content_block_start")?.data
      ?.content_block?.type;
    expect(firstBlockType).toBe("thinking");
    expect(extractStopReason(events)).toBe("tool_use");
  });
});

/**
 * Regression: a turn cut short by max_output_tokens was reported as a finished
 * tool call.
 *
 * Real failure (timeroo session, gpt-5.6-sol via codex, log 2026-07-15_15-27-02
 * line 24596): the model ran out of output budget mid-tool-call. OpenAI emitted
 * the partial function_call arguments it had produced, marked the item
 * status:"incomplete", and sent response.incomplete with
 * incomplete_details.reason = "max_output_tokens". The parser forwarded the
 * partial JSON and then said stop_reason:"tool_use" — so Claude Code executed an
 * Edit whose input was 189 bytes of truncated JSON:
 *   InputValidationError: Edit was called with input that could not be parsed as JSON
 *
 * The fixture replays that turn with the real 189-byte truncated arguments.
 * Note the codex backend rejects max_output_tokens ("Unsupported parameter"), so
 * claudish cannot cap the budget — reporting the truncation honestly is the only
 * available mitigation.
 */
describe("Regression: Responses turn truncated by max_output_tokens", () => {
  async function getParser() {
    const mod = await import("./handlers/shared/stream-parsers/openai-responses-sse.js");
    return mod.createResponsesStreamHandler;
  }

  test("reports stop_reason=max_tokens, not tool_use, so the partial tool is not executed", async () => {
    const createResponsesStreamHandler = await getParser();
    const fixture = fixtureToResponse(
      join(FIXTURES_DIR, "gpt-5.6-sol-responses-truncated-max-output.sse")
    );

    const response = createResponsesStreamHandler(createMockContext(), fixture, {
      modelName: "gpt-5.6-sol",
    });
    const events = await parseClaudeSseStream(response);

    // The whole point: the turn was cut off, so it must NOT look like a
    // complete tool call the client should run.
    expect(extractStopReason(events)).toBe("max_tokens");
    expect(extractStopReason(events)).not.toBe("tool_use");
  });

  test("the streamed tool arguments are genuinely truncated (the client must not execute them)", async () => {
    const createResponsesStreamHandler = await getParser();
    const fixture = fixtureToResponse(
      join(FIXTURES_DIR, "gpt-5.6-sol-responses-truncated-max-output.sse")
    );

    const response = createResponsesStreamHandler(createMockContext(), fixture, {
      modelName: "gpt-5.6-sol",
    });
    const events = await parseClaudeSseStream(response);

    const partialJson = events
      .filter((e) => e.data?.delta?.type === "input_json_delta")
      .map((e) => e.data.delta.partial_json)
      .join("");

    // Byte-for-byte the payload from the real InputValidationError.
    expect(partialJson.length).toBe(189);
    expect(partialJson.endsWith('"new_string":"  const {')).toBe(true);
    expect(() => JSON.parse(partialJson)).toThrow(); // unparseable — hence max_tokens

    // Blocks stay well-formed even though the turn was cut.
    const starts = events
      .filter((e) => e.data?.type === "content_block_start")
      .map((e) => e.data.index);
    const stops = events
      .filter((e) => e.data?.type === "content_block_stop")
      .map((e) => e.data.index);
    expect(starts).toEqual(starts.map((_, i) => i));
    expect([...stops].sort((a, b) => a - b)).toEqual(starts);
  });

  test("a complete turn still reports tool_use (no false max_tokens)", async () => {
    const createResponsesStreamHandler = await getParser();
    const fixture = fixtureToResponse(join(FIXTURES_DIR, "gpt-5.6-sol-responses-turn1.sse"));

    const response = createResponsesStreamHandler(createMockContext(), fixture, {
      modelName: "gpt-5.6-sol",
    });
    const events = await parseClaudeSseStream(response);
    expect(extractStopReason(events)).toBe("tool_use");
  });
});

/**
 * Reasoning-item passback: the parser must capture the encrypted reasoning that
 * precedes a tool call, keyed by the id the client echoes back.
 *
 * Fixture is a real capture from chatgpt.com/backend-api/codex/responses
 * (gpt-5.6-sol, high effort): a reasoning item carrying 2788 bytes of
 * encrypted_content, followed by the function_call it informed.
 *
 * The summary is intermittent — this capture happens to have one, while other
 * real captures return reasoning items with `summary: []` and emit no summary
 * events at all. That unreliability is why the encrypted payload cannot ride in
 * a thinking block (there is often no thinking block to attach it to), hence the
 * cache.
 */
describe("Responses SSE captures reasoning items for passback", () => {
  test("reasoning preceding a tool call is cached under the client-facing call id", async () => {
    const mod = await import("./handlers/shared/stream-parsers/openai-responses-sse.js");
    const cacheMod = await import("./adapters/reasoning-cache.js");
    cacheMod.clearReasoningCache();

    const fixture = fixtureToResponse(
      join(FIXTURES_DIR, "gpt-5.6-sol-responses-reasoning-item.sse")
    );
    const response = mod.createResponsesStreamHandler(createMockContext(), fixture, {
      modelName: "gpt-5.6-sol",
    });
    const events = await parseClaudeSseStream(response);

    // The tool id the client will send back on the next turn.
    const toolId = events.find(
      (e) => e.data?.type === "content_block_start" && e.data?.content_block?.type === "tool_use"
    )?.data.content_block.id;
    expect(toolId).toBeDefined();

    const cached = cacheMod.reasoningForCall(toolId);
    expect(cached).toBeDefined();
    expect(cached).toHaveLength(1);
    expect(cached?.[0].type).toBe("reasoning");
    expect((cached?.[0].encrypted_content ?? "").length).toBeGreaterThan(1000);
    // The item is kept verbatim so replay matches what OpenAI emitted.
    expect(cached?.[0].summary).toHaveLength(2);
    expect(cached?.[0].content).toEqual([]);

    cacheMod.clearReasoningCache();
  });

  test("a stream with no reasoning items caches nothing", async () => {
    const mod = await import("./handlers/shared/stream-parsers/openai-responses-sse.js");
    const cacheMod = await import("./adapters/reasoning-cache.js");
    cacheMod.clearReasoningCache();

    const fixture = fixtureToResponse(join(FIXTURES_DIR, "gpt-5.6-sol-responses-turn1.sse"));
    const response = mod.createResponsesStreamHandler(createMockContext(), fixture, {
      modelName: "gpt-5.6-sol",
    });
    await parseClaudeSseStream(response);

    expect(cacheMod.reasoningCacheSize()).toBe(0);
    cacheMod.clearReasoningCache();
  });
});

describe("Regression: Gemini visible text is never silently dropped", () => {
  async function getParser() {
    const mod = await import("./handlers/shared/stream-parsers/gemini-sse.js");
    return mod.createGeminiSseStream;
  }

  async function getAdapter() {
    const mod = await import("./adapters/gemini-api-format.js");
    return new mod.GeminiAPIFormat("gemini-3.6-flash");
  }

  test("real OK capture emits its text and starts a text block", async () => {
    const createGeminiSseStream = await getParser();
    const adapter = await getAdapter();
    const fixture = fixtureToResponse(
      join(FIXTURES_DIR, "gemini-3.6-flash-antigravity-ok-answer.sse")
    );

    const response = createGeminiSseStream(createMockContext(), fixture, {
      modelName: "gemini-3.6-flash",
      adapter,
      unwrapResponse: true,
    });
    const events = await parseClaudeSseStream(response);

    expect(extractText(events)).toBe("OK");
    const textBlockStart = events.find(
      (event) =>
        event.data?.type === "content_block_start" && event.data?.content_block?.type === "text"
    );
    expect(textBlockStart).toBeDefined();
  });

  test("real BANANA control capture still emits its text verbatim", async () => {
    const createGeminiSseStream = await getParser();
    const adapter = await getAdapter();
    const fixture = fixtureToResponse(
      join(FIXTURES_DIR, "gemini-3.6-flash-antigravity-banana-answer.sse")
    );

    const response = createGeminiSseStream(createMockContext(), fixture, {
      modelName: "gemini-3.6-flash",
      adapter,
      unwrapResponse: true,
    });
    const events = await parseClaudeSseStream(response);

    expect(extractText(events)).toBe("BANANA");
  });

  test.each([
    "OK",
    "Ok",
    "okay",
    "Okay",
    "OK.",
    "OKAY",
    "Hmmm, interesting — the answer is 42",
    "First, I recommend X",
    "Let me know if you need anything else",
    "I need to know your API key before continuing",
    "Wait",
  ])("processTextContent preserves %j verbatim", async (input) => {
    const adapter = await getAdapter();

    const result = adapter.processTextContent(input, "");

    expect(result.cleanedText).toBe(input);
    expect(result.wasTransformed).toBe(false);
  });

  test("processTextContent never returns empty cleaned text for a non-empty input", async () => {
    const adapter = await getAdapter();
    const nonEmptyInputs = [
      "A",
      "0",
      "No",
      "Done.",
      "Wait, I should verify that",
      "Let me think about the answer",
      "First, we should choose the safer option",
      "`result` is ready",
      "\nVisible after a leading newline",
      " ",
    ];

    for (const input of nonEmptyInputs) {
      expect(input.length).toBeGreaterThan(0);
      expect(adapter.processTextContent(input, "").cleanedText).not.toBe("");
    }
  });

  test("a boolean thought flag routes part.text only to the thinking block", async () => {
    const createGeminiSseStream = await getParser();
    const adapter = await getAdapter();

    // Synthetic protocol-shape case: no real includeThoughts capture is available.
    const chunk = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "reasoning here", thought: true }, { text: "the answer" }],
          },
          finishReason: "STOP",
        },
      ],
    };
    const fixture = new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const response = createGeminiSseStream(createMockContext(), fixture, {
      modelName: "gemini-3.6-flash",
      adapter,
      unwrapResponse: true,
    });
    const events = await parseClaudeSseStream(response);

    const blockTypes = events
      .filter((event) => event.data?.type === "content_block_start")
      .map((event) => event.data.content_block.type);
    expect(blockTypes).toEqual(["thinking", "text"]);

    const thinking = events
      .filter((event) => event.data?.delta?.type === "thinking_delta")
      .map((event) => event.data.delta.thinking)
      .join("");
    expect(thinking).toBe("reasoning here");
    expect(extractText(events)).toBe("the answer");
  });
});

describe("Regression: truncated turns are reported as max_tokens", () => {
  async function getOpenAiParser() {
    const mod = await import("./handlers/shared/stream-parsers/openai-sse.js");
    return mod.createStreamingResponseHandler;
  }

  async function getOpenRouterAdapter() {
    const mod = await import("./adapters/openrouter-api-format.js");
    return new mod.OpenRouterAPIFormat("google/gemini-3.1-pro-preview");
  }

  async function getGeminiParser() {
    const mod = await import("./handlers/shared/stream-parsers/gemini-sse.js");
    return mod.createGeminiSseStream;
  }

  async function getGeminiAdapter() {
    const mod = await import("./adapters/gemini-api-format.js");
    return new mod.GeminiAPIFormat("gemini-3.6-flash");
  }

  test("OpenRouter length finish with no visible text emits max_tokens", async () => {
    const createStreamingResponseHandler = await getOpenAiParser();
    const adapter = await getOpenRouterAdapter();
    const fixture = fixtureToResponse(join(FIXTURES_DIR, "gemini-3.1-pro-or-maxtokens-empty.sse"));

    const response = createStreamingResponseHandler(
      createMockContext(),
      fixture,
      adapter,
      "google/gemini-3.1-pro-preview",
      null
    );
    const events = await parseClaudeSseStream(response);
    const messageDelta = events.find((event) => event.data?.type === "message_delta");

    expect(messageDelta?.data.delta.stop_reason).toBe("max_tokens");
  });

  test("OpenRouter length finish preserves partial text and emits max_tokens", async () => {
    const createStreamingResponseHandler = await getOpenAiParser();
    const adapter = await getOpenRouterAdapter();
    const fixture = fixtureToResponse(
      join(FIXTURES_DIR, "gemini-3.1-pro-or-maxtokens-truncated.sse")
    );

    const response = createStreamingResponseHandler(
      createMockContext(),
      fixture,
      adapter,
      "google/gemini-3.1-pro-preview",
      null
    );
    const events = await parseClaudeSseStream(response);
    const messageDelta = events.find((event) => event.data?.type === "message_delta");

    expect(messageDelta?.data.delta.stop_reason).toBe("max_tokens");
    expect(extractText(events)).toBe("Hi marker x");
  });

  test("OpenRouter delta.reasoning reaches a thinking content block", async () => {
    const createStreamingResponseHandler = await getOpenAiParser();
    const adapter = await getOpenRouterAdapter();
    const fixture = fixtureToResponse(join(FIXTURES_DIR, "gemini-3.1-pro-or-maxtokens-empty.sse"));

    const response = createStreamingResponseHandler(
      createMockContext(),
      fixture,
      adapter,
      "google/gemini-3.1-pro-preview",
      null
    );
    const events = await parseClaudeSseStream(response);
    const thinkingStart = events.find(
      (event) =>
        event.data?.type === "content_block_start" && event.data?.content_block?.type === "thinking"
    );
    const thinking = events
      .filter((event) => event.data?.delta?.type === "thinking_delta")
      .map((event) => event.data.delta.thinking)
      .join("");

    expect(thinkingStart?.data.content_block.type).toBe("thinking");
    expect(thinking.length).toBeGreaterThan(200);
  });

  test("Gemini MAX_TOKENS preserves text and emits max_tokens", async () => {
    const createGeminiSseStream = await getGeminiParser();
    const adapter = await getGeminiAdapter();

    // Synthetic protocol-shape case: a standard Gemini chunk with a truncated text part.
    const chunk = {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "partial Gemini answer" }] },
          finishReason: "MAX_TOKENS",
        },
      ],
    };
    const fixture = new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const response = createGeminiSseStream(createMockContext(), fixture, {
      modelName: "gemini-3.6-flash",
      adapter,
      unwrapResponse: false,
    });
    const events = await parseClaudeSseStream(response);
    const messageDelta = events.find((event) => event.data?.type === "message_delta");

    expect(messageDelta?.data.delta.stop_reason).toBe("max_tokens");
    expect(extractText(events)).toBe("partial Gemini answer");
  });

  test("Gemini STOP control remains end_turn", async () => {
    const createGeminiSseStream = await getGeminiParser();
    const adapter = await getGeminiAdapter();
    const fixture = fixtureToResponse(
      join(FIXTURES_DIR, "gemini-3.6-flash-antigravity-ok-answer.sse")
    );

    const response = createGeminiSseStream(createMockContext(), fixture, {
      modelName: "gemini-3.6-flash",
      adapter,
      unwrapResponse: true,
    });
    const events = await parseClaudeSseStream(response);
    const messageDelta = events.find((event) => event.data?.type === "message_delta");

    expect(messageDelta?.data.delta.stop_reason).toBe("end_turn");
    expect(extractText(events)).toBe("OK");
  });

  test("OpenAI content_filter preserves text and emits refusal", async () => {
    const createStreamingResponseHandler = await getOpenAiParser();
    const adapter = await getOpenRouterAdapter();

    // Synthetic protocol-shape case: a provider refusal is not a turn the model chose to end.
    const contentChunk = {
      choices: [{ index: 0, delta: { content: "visible before refusal" }, finish_reason: null }],
    };
    const refusalChunk = {
      choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }],
    };
    const fixture = new Response(
      `data: ${JSON.stringify(contentChunk)}\n\ndata: ${JSON.stringify(refusalChunk)}\n\ndata: [DONE]\n\n`,
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }
    );

    const response = createStreamingResponseHandler(
      createMockContext(),
      fixture,
      adapter,
      "google/gemini-3.1-pro-preview",
      null
    );
    const events = await parseClaudeSseStream(response);
    const messageDelta = events.find((event) => event.data?.type === "message_delta");

    expect(messageDelta?.data.delta.stop_reason).toBe("refusal");
    expect(extractText(events)).toBe("visible before refusal");
  });

  test("OpenAI tool_calls finish remains tool_use", async () => {
    const createStreamingResponseHandler = await getOpenAiParser();
    const adapter = await getOpenRouterAdapter();

    // Synthetic protocol-shape case: the smallest structured tool-call turn.
    const chunk = {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_regression_tool",
                type: "function",
                function: { name: "Read", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const fixture = new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const response = createStreamingResponseHandler(
      createMockContext(),
      fixture,
      adapter,
      "google/gemini-3.1-pro-preview",
      null
    );
    const events = await parseClaudeSseStream(response);
    const messageDelta = events.find((event) => event.data?.type === "message_delta");

    expect(extractToolNames(events)).toEqual(["Read"]);
    expect(messageDelta?.data.delta.stop_reason).toBe("tool_use");
  });
});

describe("Regression: finalize teardown survives callback failures", () => {
  test("openai-sse closes the stream and clears its ping when onTokenUpdate throws", async () => {
    const parserMod = await import("./handlers/shared/stream-parsers/openai-sse.js");
    const adapterMod = await import("./adapters/base-api-format.js");
    const adapter = new adapterMod.DefaultAPIFormat("test-model");
    let callbackCalls = 0;

    const result = await parseWithTimeoutAndIntervalTracking(() => {
      const fixture = fixtureToResponse(join(FIXTURES_DIR, "SEED-openai-text-only.sse"));
      return parserMod.createStreamingResponseHandler(
        createMockContext(),
        fixture,
        adapter,
        "test-model",
        null,
        () => {
          callbackCalls++;
          throw new Error("token callback failed");
        }
      );
    });

    expect(result.timedOut).toBe(false);
    expect(result.events).not.toBeNull();
    expect(result.intervalsStarted).toBe(1);
    expect(result.intervalsStillActive).toBe(0);
    expect(callbackCalls).toBe(1);
  });

  test("gemini-sse closes the stream and clears its ping when onTokenUpdate throws", async () => {
    const parserMod = await import("./handlers/shared/stream-parsers/gemini-sse.js");
    const adapterMod = await import("./adapters/gemini-api-format.js");
    const adapter = new adapterMod.GeminiAPIFormat("gemini-3.6-flash");
    let callbackCalls = 0;

    const result = await parseWithTimeoutAndIntervalTracking(() => {
      const fixture = fixtureToResponse(
        join(FIXTURES_DIR, "gemini-3.6-flash-antigravity-ok-answer.sse")
      );
      return parserMod.createGeminiSseStream(createMockContext(), fixture, {
        modelName: "gemini-3.6-flash",
        adapter,
        unwrapResponse: true,
        onTokenUpdate: () => {
          callbackCalls++;
          throw new Error("token callback failed");
        },
      });
    });

    expect(result.timedOut).toBe(false);
    expect(result.events).not.toBeNull();
    expect(result.intervalsStarted).toBe(1);
    expect(result.intervalsStillActive).toBe(0);
    expect(callbackCalls).toBe(1);
  });

  test("ollama-jsonl closes the stream, clears its ping, and emits one message_stop when onTokenUpdate throws", async () => {
    const parserMod = await import("./handlers/shared/stream-parsers/ollama-jsonl.js");
    let callbackCalls = 0;

    const result = await parseWithTimeoutAndIntervalTracking(() => {
      const fixture = new Response(
        `${JSON.stringify({ message: { content: "Hello" }, done: false })}\n${JSON.stringify({ done: true, prompt_eval_count: 12, eval_count: 3 })}\n`,
        { status: 200, headers: { "Content-Type": "application/x-ndjson" } }
      );
      return parserMod.createOllamaJsonlStream(createMockContext(), fixture, {
        modelName: "test-model",
        onTokenUpdate: () => {
          callbackCalls++;
          throw new Error("token callback failed");
        },
      });
    });

    expect(result.timedOut).toBe(false);
    expect(result.events).not.toBeNull();
    expect(result.intervalsStarted).toBe(1);
    expect(result.intervalsStillActive).toBe(0);
    expect(callbackCalls).toBe(1);
    expect(result.events?.filter((event) => event.data?.type === "message_stop")).toHaveLength(1);
  });
});
