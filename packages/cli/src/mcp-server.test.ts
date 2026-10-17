/**
 * Regression tests for mcp-server.ts.
 *
 * Run: bun test packages/cli/src/mcp-server.test.ts
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseAnthropicSse } from "./mcp-server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MCP_SERVER_SOURCE = readFileSync(join(__dirname, "mcp-server.ts"), "utf-8");

describe("list_models MCP handler — source-level regression guard", () => {
  // Guards against reintroducing the stale-model-list bug.
  // The handler must await the async resolver, which runs the 4-tier
  // in-memory → fresh-disk → Firebase → bundled resolution.
  // The sync variant skips Firebase and has no freshness check on the disk
  // cache, so it silently served stale data.
  test("awaits getRecommendedModels (async resolver)", () => {
    expect(MCP_SERVER_SOURCE).toContain("await getRecommendedModels(");
  });

  test("does not call getRecommendedModelsSync (stale-by-design)", () => {
    expect(MCP_SERVER_SOURCE).not.toContain("getRecommendedModelsSync(");
  });
});

// Committed pin for the mcp-server SSE gate (review #469, nit 2): the
// coordinator's mutation pass showed reverting mcp-server's bare-data
// handling stayed GREEN — no committed test imported this reader. This is
// the MCP prompt round-trip's own parse of the proxy's stream, distinct
// from the stream parsers under test in sse-bare-data-lines.test.ts.
describe("parseAnthropicSse — bare `data:` lines (upstream 3dbd3167)", () => {
  test("accumulates text and usage from a bare-data wire", () => {
    const raw = [
      'data:{"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":1}}}',
      "",
      'data:{"type":"content_block_delta","delta":{"type":"text_delta","text":"bare-mcp"}}',
      "",
      'data:{"type":"content_block_delta","delta":{"type":"text_delta","text":"-ok"}}',
      "",
      'data:{"type":"message_delta","usage":{"output_tokens":3}}',
      "",
      "",
    ].join("\n");

    const { text, usage } = parseAnthropicSse(raw);
    expect(text).toBe("bare-mcp-ok");
    expect(usage).toEqual({ input: 7, output: 3 });
  });

  test("spaced wire parses identically (both forms are one contract)", () => {
    const spaced = [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
      "",
      "",
    ].join("\n");
    expect(parseAnthropicSse(spaced).text).toBe("hi");
  });
});
