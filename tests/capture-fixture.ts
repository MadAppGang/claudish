#!/usr/bin/env bun

/**
 * Fixture Capture Tool
 *
 * Parses monitor mode logs and extracts structured test fixtures.
 *
 * Usage:
 *   bun tests/capture-fixture.ts logs/monitor.log --output tests/fixtures/my_test.json
 *   bun tests/capture-fixture.ts logs/monitor.log --name "simple_query" --category "text"
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

interface FixtureEvent {
  event: string;
  data: any;
}

interface Fixture {
  name: string;
  description: string;
  category: string;
  captured_at: string;
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
  notes?: string;
}

/**
 * Normalize dynamic values for reproducible tests
 */
function normalizeValue(key: string, value: any): any {
  // Normalize IDs
  if (key === "id" && typeof value === "string") {
    if (value.startsWith("msg_")) return "msg_***NORMALIZED***";
    if (value.startsWith("toolu_")) return "toolu_***NORMALIZED***";
  }

  // Normalize tool_call_id
  if (key === "tool_call_id" && typeof value === "string") {
    return "toolu_***NORMALIZED***";
  }

  // Normalize tool_use_id
  if (key === "tool_use_id" && typeof value === "string") {
    return "toolu_***NORMALIZED***";
  }

  // Recursively normalize objects
  if (typeof value === "object" && value !== null) {
    if (Array.isArray(value)) {
      return value.map((item, idx) => normalizeValue(`${idx}`, item));
    }
    const normalized: any = {};
    for (const [k, v] of Object.entries(value)) {
      normalized[k] = normalizeValue(k, v);
    }
    return normalized;
  }

  return value;
}

/**
 * Parse monitor log file and extract request/response
 */
function parseMonitorLog(logContent: string): { request: any; response: FixtureEvent[] } | null {
  const lines = logContent.split("\n");

  let request: any = null;
  const responseEvents: FixtureEvent[] = [];
  let inRequest = false;
  let inResponse = false;
  let jsonBuffer = "";

  for (const line of lines) {
    // Detect request start
    if (line.includes("=== [MONITOR] Claude Code → Anthropic API Request ===")) {
      inRequest = true;
      inResponse = false;
      jsonBuffer = "";
      continue;
    }

    // Detect response start
    if (line.includes("=== [MONITOR] Anthropic API → Claude Code Response (Streaming) ===")) {
      inRequest = false;
      inResponse = true;
      jsonBuffer = "";
      continue;
    }

    // Detect end markers
    if (line.includes("=== End Request ===") || line.includes("=== End Streaming Response ===")) {
      inRequest = false;
      inResponse = false;
      continue;
    }

    // Capture request body
    if (
      inRequest &&
      !line.includes("Headers received:") &&
      !line.includes("API Key found:") &&
      !line.includes("Request body:")
    ) {
      jsonBuffer += line + "\n";
    }

    // Capture response events (SSE format)
    if (inResponse) {
      // Parse SSE events
      if (line.startsWith("event:")) {
        const eventType = line.substring(6).trim();
        // Next line should be data:
        continue;
      }
      if (line.startsWith("data:")) {
        const dataStr = line.substring(5).trim();
        if (dataStr && dataStr !== "[DONE]") {
          try {
            const data = JSON.parse(dataStr);
            const eventType = data.type || "unknown";
            responseEvents.push({
              event: eventType,
              data: normalizeValue("root", data),
            });
          } catch (e) {
            // Ignore parse errors (might be partial JSON in logs)
          }
        }
      }
    }
  }

  // Try to parse request JSON
  if (jsonBuffer.trim()) {
    try {
      const lines = jsonBuffer
        .trim()
        .split("\n")
        .filter((l) => l.trim());
      const jsonStart = lines.findIndex((l) => l.trim().startsWith("{"));
      if (jsonStart >= 0) {
        const jsonStr = lines.slice(jsonStart).join("\n");
        request = JSON.parse(jsonStr);
      }
    } catch (e) {
      console.error("Failed to parse request JSON:", e);
    }
  }

  if (!request || responseEvents.length === 0) {
    return null;
  }

  return { request, response: responseEvents };
}

/**
 * Analyze response and build assertions
 */
function buildAssertions(events: FixtureEvent[]): Fixture["assertions"] {
  const eventSequence = events.map((e) => e.event);
  const contentBlocks: Array<{
    index: number;
    type: string;
    name?: string;
    hasContent?: boolean;
  }> = [];

  let stopReason: string | null = null;
  let hasUsage = false;
  let minInputTokens = 0;
  let minOutputTokens = 0;

  // Track content blocks
  const blockMap = new Map<number, { type: string; name?: string; hasContent: boolean }>();

  for (const event of events) {
    if (event.event === "content_block_start") {
      const index = event.data.index;
      const blockType = event.data.content_block?.type;
      const name = event.data.content_block?.name;
      blockMap.set(index, { type: blockType, name, hasContent: false });
    }

    if (event.event === "content_block_delta") {
      const index = event.data.index;
      if (blockMap.has(index)) {
        blockMap.get(index)!.hasContent = true;
      }
    }

    if (event.event === "message_delta") {
      stopReason = event.data.delta?.stop_reason || null;
      if (event.data.usage) {
        hasUsage = true;
        minInputTokens = event.data.usage.input_tokens || 0;
        minOutputTokens = event.data.usage.output_tokens || 0;
      }
    }

    if (event.event === "message_start") {
      if (event.data.message?.usage) {
        hasUsage = true;
      }
    }
  }

  // Convert block map to array
  for (const [index, block] of blockMap.entries()) {
    contentBlocks.push({
      index,
      type: block.type,
      ...(block.name && { name: block.name }),
      hasContent: block.hasContent,
    });
  }

  return {
    eventSequence,
    contentBlocks,
    stopReason,
    hasUsage,
    ...(minInputTokens > 0 && { minInputTokens }),
    ...(minOutputTokens > 0 && { minOutputTokens }),
  };
}

/**
 * Infer category from response
 */
function inferCategory(events: FixtureEvent[]): string {
  const hasToolUse = events.some(
    (e) => e.event === "content_block_start" && e.data.content_block?.type === "tool_use"
  );

  const toolCount = events.filter(
    (e) => e.event === "content_block_start" && e.data.content_block?.type === "tool_use"
  ).length;

  if (toolCount > 1) return "multi_tool";
  if (hasToolUse) return "tool_use";
  if (events.length > 20) return "streaming";
  return "text";
}

/**
 * Main function
 */
function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
Fixture Capture Tool

Usage:
  bun tests/capture-fixture.ts <log-file> [options]

Options:
  --output <path>       Output fixture file path (default: auto-generate)
  --name <name>         Fixture name (default: extracted from filename)
  --category <cat>      Category: text|tool_use|multi_tool|streaming|error
  --description <desc>  Custom description

Examples:
  bun tests/capture-fixture.ts logs/test_1_simple.log
  bun tests/capture-fixture.ts logs/monitor.log --output tests/fixtures/my_test.json
  bun tests/capture-fixture.ts logs/tool_test.log --name "read_file" --category "tool_use"
    `);
    process.exit(0);
  }

  const logFile = args[0];
  let outputPath: string | null = null;
  let fixtureName: string | null = null;
  let category: string | null = null;
  let description: string | null = null;

  // Parse options
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--output" && args[i + 1]) {
      outputPath = args[i + 1];
      i++;
    } else if (args[i] === "--name" && args[i + 1]) {
      fixtureName = args[i + 1];
      i++;
    } else if (args[i] === "--category" && args[i + 1]) {
      category = args[i + 1];
      i++;
    } else if (args[i] === "--description" && args[i + 1]) {
      description = args[i + 1];
      i++;
    }
  }

  // Validate input file
  if (!existsSync(logFile)) {
    console.error(`❌ Log file not found: ${logFile}`);
    process.exit(1);
  }

  console.log(`📖 Reading log file: ${logFile}`);
  const logContent = readFileSync(logFile, "utf-8");

  console.log("🔍 Parsing monitor logs...");
  const parsed = parseMonitorLog(logContent);

  if (!parsed) {
    console.error("❌ Failed to parse monitor logs. No request/response found.");
    console.error("   Make sure the log file contains monitor mode output with:");
    console.error("   - [MONITOR] Claude Code → Anthropic API Request");
    console.error("   - [MONITOR] Anthropic API → Claude Code Response");
    process.exit(1);
  }

  const { request, response } = parsed;

  console.log(`✅ Parsed request with ${response.length} events`);

  // Infer fixture name from filename if not provided
  if (!fixtureName) {
    const basename = logFile.split("/").pop()?.replace(".log", "") || "fixture";
    fixtureName = basename.replace(/^test_\d+_/, "").replace(/-/g, "_");
  }

  // Infer category if not provided
  if (!category) {
    category = inferCategory(response);
  }

  // Build assertions
  const assertions = buildAssertions(response);

  // Generate description if not provided
  if (!description) {
    const toolNames = assertions.contentBlocks
      .filter((b) => b.type === "tool_use" && b.name)
      .map((b) => b.name)
      .join(", ");

    if (toolNames) {
      description = `${category} scenario using: ${toolNames}`;
    } else {
      description = `${category} scenario`;
    }
  }

  // Build fixture
  const fixture: Fixture = {
    name: fixtureName,
    description,
    category,
    captured_at: new Date().toISOString(),
    request: {
      headers: {
        "anthropic-version": "2023-06-01",
        "anthropic-beta":
          "oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
        "content-type": "application/json",
      },
      body: normalizeValue("request", request),
    },
    response: {
      type: "streaming",
      events: response,
    },
    assertions,
    notes: `Captured from monitor mode: ${logFile}`,
  };

  // Determine output path if not provided
  if (!outputPath) {
    outputPath = join(process.cwd(), "tests", "fixtures", `${fixtureName}.json`);
  }

  // Write fixture
  console.log(`💾 Writing fixture to: ${outputPath}`);
  writeFileSync(outputPath, JSON.stringify(fixture, null, 2));

  console.log(`
✅ Fixture created successfully!

Summary:
  Name:        ${fixture.name}
  Category:    ${fixture.category}
  Description: ${fixture.description}
  Events:      ${response.length}
  Blocks:      ${assertions.contentBlocks.length}
  Stop Reason: ${assertions.stopReason}

Content Blocks:
${assertions.contentBlocks.map((b) => `  [${b.index}] ${b.type}${b.name ? ` (${b.name})` : ""}`).join("\n")}

Event Sequence:
  ${assertions.eventSequence.slice(0, 10).join(" → ")}${assertions.eventSequence.length > 10 ? ` ... (${assertions.eventSequence.length} total)` : ""}

Next steps:
  1. Review the fixture: cat ${outputPath}
  2. Run snapshot tests: bun test tests/snapshot.test.ts
  `);
}

main();
