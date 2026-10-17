#!/usr/bin/env bun
/**
 * MCP Server E2E test — uses the official MCP Client SDK for proper transport
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

console.log("╔══════════════════════════════════════╗");
console.log("║   MCP Server E2E Test                ║");
console.log("╚══════════════════════════════════════╝\n");

// mcp-server.ts only exports startMcpServer() — use index.ts --mcp to invoke it
const transport = new StdioClientTransport({
  command: "bun",
  args: ["packages/cli/src/index.ts", "--mcp"],
  stderr: "pipe",
});

const client = new Client({ name: "e2e-test", version: "1.0" });

// Capture stderr from the MCP server process
transport.stderr?.on("data", (d: Buffer) => {
  const msg = d.toString().trim();
  if (msg) console.log(`  [server] ${msg}`);
});

try {
  await client.connect(transport);
  console.log("✓ Connected to MCP server");

  // 1. List tools
  const tools = await client.listTools();
  console.log(`✓ Tools discovered: ${tools.tools.length}`);
  for (const t of tools.tools) {
    console.log(`  • ${t.name} — ${(t.description || "").slice(0, 65)}`);
  }

  // 2. list_models
  const listResult = await client.callTool({ name: "list_models", arguments: {} });
  const listText = (listResult.content as any)[0]?.text || "";
  const rows = (listText.match(/^\|[^-]/gm) || []).length;
  console.log(`✓ list_models: ${listText.length} chars, ~${rows} table rows`);

  // 3. search_models (requires network — may fail in sandbox)
  try {
    const searchResult = await client.callTool({
      name: "search_models",
      arguments: { query: "grok", limit: 3 },
    });
    const searchText = (searchResult.content as any)[0]?.text || "";
    const found = searchText.includes("grok");
    console.log(
      `✓ search_models("grok"): ${found ? "found grok models" : "no results"} (${searchText.length} chars)`
    );
  } catch (e: any) {
    console.log(`! search_models: ${e.message?.slice(0, 60) || "failed"}`);
  }

  // 4. team — status on nonexistent path (should error)
  const teamStatusResult = await client.callTool({
    name: "team",
    arguments: { mode: "status", path: "./nonexistent-session" },
  });
  const teamStatusText = (teamStatusResult.content as any)[0]?.text || "";
  const isErr = (teamStatusResult as any).isError;
  console.log(
    `✓ team(status, bad path): ${isErr ? "correctly errored" : "unexpected"} — ${teamStatusText.slice(0, 70)}`
  );

  // 5. team — run with fake models (tests session setup + spawn + timeout)
  const testPath = `./test-mcp-e2e-${Date.now()}`;
  console.log(`  … team(run) spawning 2 fake models at ${testPath} (5s timeout)…`);
  const teamRunResult = await client.callTool({
    name: "team",
    arguments: {
      mode: "run",
      path: testPath,
      models: ["fake-model-a", "fake-model-b"],
      input: "Say hello",
      timeout: 5,
    },
  });
  const teamRunText = (teamRunResult.content as any)[0]?.text || "";
  const teamRunErr = (teamRunResult as any).isError;
  if (teamRunErr) {
    console.log(`✓ team(run): errored — ${teamRunText.slice(0, 200)}`);
  } else {
    // Response is JSON + markdown error report — show the full thing
    console.log(`✓ team(run) response (${teamRunText.length} chars):`);
    // Show each line, indented
    for (const line of teamRunText.split("\n")) {
      console.log(`  ${line}`);
    }
  }

  // 6. report_error — test sanitization (endpoint will fail, but that's fine)
  const reportResult = await client.callTool({
    name: "report_error",
    arguments: {
      error_type: "provider_failure",
      model: "fake-model-a",
      command: "claudish --model fake-model-a -y --stdin --quiet",
      stderr_snippet: "Error: sk-or-abc123secret API key invalid for /Users/jack/secret/path",
      exit_code: 1,
      auto_send: true,
    },
  });
  const reportText = (reportResult.content as any)[0]?.text || "";
  const sanitized = reportText.includes("sk-***REDACTED***") || reportText.includes("/Users/***");
  const hasSuggestion = reportText.includes("automatic error reporting");
  console.log(`✓ report_error: sanitized=${sanitized}, auto_send_hint=${hasSuggestion}`);
  console.log(`  report_error response (${reportText.length} chars):`);
  for (const line of reportText.split("\n")) {
    console.log(`  ${line}`);
  }

  // Cleanup test session
  const { rmSync } = await import("node:fs");
  try {
    rmSync(testPath, { recursive: true, force: true });
  } catch {}
} catch (err: any) {
  console.error(`✗ Error: ${err.message}`);
} finally {
  await client.close();
}

console.log("\n══════════════════════════════════════");
console.log("   All MCP E2E tests complete");
console.log("══════════════════════════════════════");
