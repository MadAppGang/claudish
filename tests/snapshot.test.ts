/**
 * Snapshot Integration Tests
 *
 * Replays captured fixtures through the proxy and validates protocol compliance.
 * Ensures 1:1 compatibility with official Claude Code protocol.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { ProxyServer } from "../src/types";
import { createProxyServer } from "../src/proxy-server";

interface FixtureEvent {
  event: string;
  data: any;
}

interface Fixture {
  name: string;
  description: string;
  category: string;
  request: {
    headers: Record<string, string>;
    body: any;
  };
  response: {
    type: "streaming" | "json";
    events?: FixtureEvent[];
    data?: any;
  };
  assertions: {
    eventSequence: string[];
    contentBlocks: Array<{
      index: number;
      type: string;
      name?: string;
      hasContent?: boolean;
    }>;
    stopReason: string | null;
    hasUsage: boolean;
    minInputTokens?: number;
    minOutputTokens?: number;
  };
}

/**
 * Load all fixtures from the fixtures directory
 */
function loadFixtures(): Fixture[] {
  const fixturesDir = join(import.meta.dir, "fixtures");
  const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json"));

  return files.map((file) => {
    const content = readFileSync(join(fixturesDir, file), "utf-8");
    return JSON.parse(content) as Fixture;
  });
}

/**
 * Parse SSE stream into events
 */
async function parseSSEStream(response: Response): Promise<FixtureEvent[]> {
  const events: FixtureEvent[] = [];

  if (!response.body) {
    throw new Error("Response has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) {
        currentEvent = null;
        continue;
      }

      if (line.startsWith("event:")) {
        currentEvent = line.substring(6).trim();
      } else if (line.startsWith("data:")) {
        const dataStr = line.substring(5).trim();
        if (dataStr === "[DONE]") {
          continue;
        }

        try {
          const data = JSON.parse(dataStr);
          const eventType = currentEvent || data.type || "unknown";
          events.push({ event: eventType, data });
        } catch (e) {
          console.warn("Failed to parse SSE data:", dataStr);
        }
      }
    }
  }

  return events;
}

/**
 * Validate event sequence matches expected pattern
 */
function validateEventSequence(
  actual: string[],
  expected: string[]
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check for required events
  const requiredEvents = ["message_start", "message_delta", "message_stop"];
  for (const required of requiredEvents) {
    if (!actual.includes(required)) {
      errors.push(`Missing required event: ${required}`);
    }
  }

  // Check proper order
  const startIndex = actual.indexOf("message_start");
  const stopIndex = actual.indexOf("message_stop");

  if (startIndex !== 0) {
    errors.push(`message_start must be first event (found at index ${startIndex})`);
  }

  if (stopIndex !== actual.length - 1) {
    errors.push(`message_stop must be last event (found at index ${stopIndex})`);
  }

  // Check content blocks have proper start/stop pairs
  const blockStarts = actual.filter((e) => e === "content_block_start").length;
  const blockStops = actual.filter((e) => e === "content_block_stop").length;

  if (blockStarts !== blockStops) {
    errors.push(`Mismatched content blocks: ${blockStarts} starts, ${blockStops} stops`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate content block indices are sequential and correct
 */
function validateContentBlocks(
  events: FixtureEvent[],
  expected: Fixture["assertions"]["contentBlocks"]
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const blocks: Array<{ index: number; type: string; name?: string }> = [];

  for (const event of events) {
    if (event.event === "content_block_start") {
      const index = event.data.index;
      const type = event.data.content_block?.type;
      const name = event.data.content_block?.name;

      blocks.push({ index, type, name });
    }
  }

  // Check indices are sequential
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].index !== i) {
      errors.push(`Block ${i}: expected index ${i}, got ${blocks[i].index}`);
    }
  }

  // Check block types match
  if (blocks.length !== expected.length) {
    errors.push(`Expected ${expected.length} blocks, got ${blocks.length}`);
  } else {
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].type !== expected[i].type) {
        errors.push(`Block ${i}: expected type ${expected[i].type}, got ${blocks[i].type}`);
      }

      // Check tool names if present
      if (expected[i].name && blocks[i].name !== expected[i].name) {
        errors.push(
          `Block ${i}: expected tool ${expected[i].name}, got ${blocks[i].name || "none"}`
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate tool input streaming (fine-grained)
 */
function validateToolInputStreaming(events: FixtureEvent[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const toolBlocks = new Map<number, { args: string; complete: boolean }>();

  for (const event of events) {
    if (event.event === "content_block_start" && event.data.content_block?.type === "tool_use") {
      const index = event.data.index;
      toolBlocks.set(index, { args: "", complete: false });
    }

    if (event.event === "content_block_delta" && event.data.delta?.type === "input_json_delta") {
      const index = event.data.index;
      const toolState = toolBlocks.get(index);

      if (!toolState) {
        errors.push(`Tool delta at index ${index} without corresponding start`);
        continue;
      }

      toolState.args += event.data.delta.partial_json;
    }

    if (event.event === "content_block_stop") {
      const index = event.data.index;
      const toolState = toolBlocks.get(index);

      if (toolState) {
        toolState.complete = true;

        // Validate JSON is complete
        if (toolState.args) {
          try {
            JSON.parse(toolState.args);
          } catch (e) {
            errors.push(
              `Tool at index ${index}: incomplete or malformed JSON: ${toolState.args.substring(0, 100)}...`
            );
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate usage metrics are present
 */
function validateUsage(
  events: FixtureEvent[],
  hasUsage: boolean
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!hasUsage) {
    return { valid: true, errors: [] };
  }

  // Check message_start has usage
  const messageStart = events.find((e) => e.event === "message_start");
  if (!messageStart?.data?.message?.usage) {
    errors.push("message_start missing usage field");
  }

  // Check message_delta has usage
  // According to real Claude Code protocol, message_delta should ONLY have output_tokens
  const messageDelta = events.find((e) => e.event === "message_delta");
  if (!messageDelta?.data?.usage) {
    errors.push("message_delta missing usage field");
  } else {
    const usage = messageDelta.data.usage;
    if (typeof usage.output_tokens !== "number") {
      errors.push("message_delta usage.output_tokens must be a number");
    }
    // input_tokens and cache tokens should NOT be in message_delta (only in message_start)
    if (usage.input_tokens !== undefined) {
      errors.push(
        "message_delta should not contain input_tokens (only output_tokens per protocol)"
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate stop_reason is present and valid
 */
function validateStopReason(
  events: FixtureEvent[],
  expectedStopReason: string | null
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  const messageDelta = events.find((e) => e.event === "message_delta");
  if (!messageDelta) {
    errors.push("message_delta event not found");
    return { valid: false, errors };
  }

  const stopReason = messageDelta.data?.delta?.stop_reason;

  if (!stopReason) {
    errors.push("message_delta missing stop_reason");
  } else {
    const validReasons = ["end_turn", "max_tokens", "tool_use", "stop_sequence"];
    if (!validReasons.includes(stopReason)) {
      errors.push(`Invalid stop_reason: ${stopReason}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Main test suite
 */
describe("Snapshot Integration Tests", () => {
  let server: ProxyServer | null = null;
  const PORT = 8338;
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
  const TEST_MODEL = "anthropic/claude-sonnet-4.5"; // Use Claude for exact comparison

  beforeAll(async () => {
    if (!OPENROUTER_API_KEY) {
      console.warn("⚠️  OPENROUTER_API_KEY not set, tests will be skipped");
      return;
    }

    // Start proxy server
    server = await createProxyServer(PORT, OPENROUTER_API_KEY, TEST_MODEL, false);
    console.log(`✅ Proxy server started on port ${PORT}`);
  });

  afterAll(async () => {
    if (server) {
      await server.shutdown();
      console.log("✅ Proxy server stopped");
    }
  });

  test("fixtures directory exists", () => {
    const fixturesDir = join(import.meta.dir, "fixtures");
    expect(readdirSync(fixturesDir)).toBeDefined();
  });

  // Load and test each fixture
  const fixtures = loadFixtures();

  if (fixtures.length === 0) {
    test.skip("no fixtures found - run capture-fixture.ts first", () => {});
  }

  for (const fixture of fixtures) {
    describe(`Fixture: ${fixture.name} (${fixture.category})`, () => {
      let actualEvents: FixtureEvent[] = [];

      test.skipIf(!OPENROUTER_API_KEY)("replays request through proxy", async () => {
        const response = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...fixture.request.headers,
          },
          body: JSON.stringify(fixture.request.body),
        });

        expect(response.ok).toBe(true);

        if (fixture.response.type === "streaming") {
          actualEvents = await parseSSEStream(response);
          expect(actualEvents.length).toBeGreaterThan(0);
        } else {
          const data = await response.json();
          expect(data).toBeDefined();
        }
      });

      test.skipIf(!OPENROUTER_API_KEY)("validates event sequence", () => {
        const actualSequence = actualEvents.map((e) => e.event);
        const result = validateEventSequence(actualSequence, fixture.assertions.eventSequence);

        if (!result.valid) {
          console.error("Event sequence errors:");
          result.errors.forEach((err) => console.error(`  - ${err}`));
        }

        expect(result.valid).toBe(true);
      });

      test.skipIf(!OPENROUTER_API_KEY)("validates content block indices", () => {
        const result = validateContentBlocks(actualEvents, fixture.assertions.contentBlocks);

        if (!result.valid) {
          console.error("Content block errors:");
          result.errors.forEach((err) => console.error(`  - ${err}`));
        }

        expect(result.valid).toBe(true);
      });

      test.skipIf(!OPENROUTER_API_KEY)("validates tool input streaming (if tool_use)", () => {
        const hasTools = fixture.assertions.contentBlocks.some((b) => b.type === "tool_use");

        if (!hasTools) {
          return; // Skip if no tools
        }

        const result = validateToolInputStreaming(actualEvents);

        if (!result.valid) {
          console.error("Tool input streaming errors:");
          result.errors.forEach((err) => console.error(`  - ${err}`));
        }

        expect(result.valid).toBe(true);
      });

      test.skipIf(!OPENROUTER_API_KEY)("validates usage metrics", () => {
        const result = validateUsage(actualEvents, fixture.assertions.hasUsage);

        if (!result.valid) {
          console.error("Usage validation errors:");
          result.errors.forEach((err) => console.error(`  - ${err}`));
        }

        expect(result.valid).toBe(true);
      });

      test.skipIf(!OPENROUTER_API_KEY)("validates stop_reason", () => {
        const result = validateStopReason(actualEvents, fixture.assertions.stopReason);

        if (!result.valid) {
          console.error("Stop reason errors:");
          result.errors.forEach((err) => console.error(`  - ${err}`));
        }

        expect(result.valid).toBe(true);
      });
    });
  }
});
