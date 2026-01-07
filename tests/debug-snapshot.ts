/**
 * Debug script to inspect actual SSE events from proxy
 */

import { readFileSync } from "fs";
import { join } from "path";
import { createProxyServer } from "../src/proxy-server";
import type { ProxyServer } from "../src/types";

const PORT = 8340;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const TEST_MODEL = "anthropic/claude-sonnet-4.5";

async function parseSSE(response: Response) {
  const events: any[] = [];

  if (!response.body) throw new Error("No body");

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
        if (dataStr === "[DONE]") continue;

        try {
          const data = JSON.parse(dataStr);
          const eventType = currentEvent || data.type || "unknown";
          events.push({ event: eventType, data });
          console.log(
            `[${events.length}] ${eventType}`,
            data.index !== undefined ? `(index: ${data.index})` : ""
          );
        } catch (e) {
          console.warn("Parse error:", dataStr);
        }
      }
    }
  }

  return events;
}

async function main() {
  console.log("Starting debug test...\n");

  // Start proxy
  const server: ProxyServer = await createProxyServer(PORT, OPENROUTER_API_KEY, TEST_MODEL, false);
  console.log(`✅ Proxy started on port ${PORT}\n`);

  // Load fixture
  const fixturePath = join(import.meta.dir, "fixtures", "example_tool_use.json");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));

  console.log(`Testing fixture: ${fixture.name}`);
  console.log(`Expected blocks: ${fixture.assertions.contentBlocks.length}\n`);

  // Make request
  const response = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...fixture.request.headers,
    },
    body: JSON.stringify(fixture.request.body),
  });

  console.log("Response status:", response.status);
  console.log("\nSSE Events:\n");

  const events = await parseSSE(response);

  console.log(`\nTotal events: ${events.length}\n`);

  // Analyze content blocks
  const starts = events.filter((e) => e.event === "content_block_start");
  const stops = events.filter((e) => e.event === "content_block_stop");

  console.log("Content Block Analysis:");
  console.log(`  Starts: ${starts.length}`);
  starts.forEach((e, i) => {
    console.log(
      `    [${i}] index=${e.data.index}, type=${e.data.content_block?.type}, name=${e.data.content_block?.name || "n/a"}`
    );
  });

  console.log(`  Stops: ${stops.length}`);
  stops.forEach((e, i) => {
    console.log(`    [${i}] index=${e.data.index}`);
  });

  await server.shutdown();
  console.log("\n✅ Test complete");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
