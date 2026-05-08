#!/usr/bin/env bun
/**
 * Client-side channel diagnostic.
 *
 * Spawns `claude -p` against our claudish MCP server (with CLAUDISH_CHANNEL_TRACE=1
 * enabled so we can see what the server emits). Asks Claude Code to create a
 * session and report on what it observes.
 *
 * Captures three streams in parallel:
 *   1. Server stderr — our [channel-trace] markers prove what frames we sent
 *   2. Client stdout — Claude Code's stream-json events: tool calls, tool
 *      results, system messages. If channel notifications are surfaced, they
 *      should appear somewhere here.
 *   3. Client stderr — Claude Code's own debug logs (--debug mcp captures
 *      MCP-layer events including unknown notification handling).
 *
 * Comparing what the server sent vs what the client surfaced tells us
 * definitively whether Claude Code consumes notifications/claude/channel.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER_ENTRY = resolve(__dirname, "../../index.ts");

const LOG_DIR = resolve(__dirname, "../../../../../logs");
mkdirSync(LOG_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = join(LOG_DIR, `client-diagnostic-${stamp}.log`);
const log = createWriteStream(LOG_FILE);

function logBoth(s: string) {
  process.stderr.write(s);
  log.write(s);
}

logBoth(`[client-diag] starting end-to-end client diagnostic\n`);
logBoth(`[client-diag] log file: ${LOG_FILE}\n`);

// File where the MCP server will mirror its trace output. Claude Code
// captures the server's stderr internally and never propagates it to us, so
// without this file mirror we'd be blind to the server side.
const SERVER_TRACE_FILE = join(LOG_DIR, `server-trace-${stamp}.log`);
writeFileSync(SERVER_TRACE_FILE, "", "utf-8");

// MCP config that wires our instrumented server into Claude Code
const mcpConfig = {
  mcpServers: {
    claudish: {
      command: "bun",
      args: ["run", SERVER_ENTRY, "--mcp"],
      env: {
        CLAUDISH_MCP_TOOLS: "all",
        CLAUDISH_CHANNEL_TRACE: "1",
        CLAUDISH_CHANNEL_TRACE_FILE: SERVER_TRACE_FILE,
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "",
      },
    },
  },
};

const configPath = join(tmpdir(), `claudish-client-diag-${Date.now()}.json`);
writeFileSync(configPath, JSON.stringify(mcpConfig), "utf-8");
logBoth(`[client-diag] mcp config: ${configPath}\n`);

// The prompt: ask Claude Code to create a session AND report on what it sees.
// The prompt is crucial: it must elicit observable evidence of notifications.
//
// We use x-ai/grok-code-fast-1 because it actually returns output unlike the
// :free models. We tell the agent EXPLICITLY not to cancel — earlier runs
// showed it was happy to call cancel_session prematurely. We also tell it to
// quote the channel notifications verbatim, which forces them to appear in
// the output stream if the client does receive them.
const PROMPT = `Use the create_session tool from the claudish MCP server with model "x-ai/grok-code-fast-1" and prompt "Reply with exactly the word: hello". DO NOT CANCEL THE SESSION. After create_session returns, the server will push notifications about the session lifecycle (events like running, tool_executing, completed). Quote VERBATIM every channel notification you observe — paste them as JSON or describe their event/content/meta fields exactly. If no notifications arrive within 60 seconds, report "NO NOTIFICATIONS RECEIVED". Then call list_sessions with include_completed=true and call get_output for the session. Output your findings in this exact format:\n\nNOTIFICATIONS_OBSERVED:\n<list each notification verbatim>\n\nFINAL_OUTPUT:\n<get_output result>`;

logBoth(`[client-diag] prompt: ${PROMPT.slice(0, 100)}...\n`);

const claudeArgs = [
  "-p",
  "--mcp-config",
  configPath,
  "--strict-mcp-config",
  "--bare",
  "--dangerously-skip-permissions",
  // Channels are gated: server must be named in --channels OR bypassed via
  // the development flag. Per official docs:
  // https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview
  // Using the development flag because Claudish isn't on Anthropic's allowlist.
  "--dangerously-load-development-channels",
  "server:claudish",
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--debug",
  "mcp",
  PROMPT,
];

logBoth(`[client-diag] claude args: ${claudeArgs.slice(0, 8).join(" ")} ...\n`);

const claude = spawn("claude", claudeArgs, {
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
});

interface Counters {
  serverChannelTraceLines: number;
  serverWireFrames: number;
  clientStreamEvents: number;
  clientToolCalls: number;
  clientToolResults: number;
  clientChannelMentions: number;
  clientSystemReminders: number;
  clientUnhandledMcpLogs: number;
}

const counts: Counters = {
  serverChannelTraceLines: 0,
  serverWireFrames: 0,
  clientStreamEvents: 0,
  clientToolCalls: 0,
  clientToolResults: 0,
  clientChannelMentions: 0,
  clientSystemReminders: 0,
  clientUnhandledMcpLogs: 0,
};

let stdoutBuf = "";

claude.stdout.on("data", (chunk: Buffer) => {
  const text = chunk.toString("utf-8");
  log.write(`STDOUT: ${text}`);
  stdoutBuf += text;

  // Parse line-delimited JSON
  let nl: number;
  while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
    const line = stdoutBuf.slice(0, nl);
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line.trim()) continue;
    counts.clientStreamEvents++;
    try {
      const event = JSON.parse(line);
      // Walk the event for evidence of channel notification reception
      const json = JSON.stringify(event);
      if (json.includes("notifications/claude/channel")) {
        counts.clientChannelMentions++;
        logBoth(`[client-diag] FOUND channel reference in stream: ${line.slice(0, 200)}\n`);
      }
      if (json.includes("<channel")) {
        counts.clientChannelMentions++;
        logBoth(`[client-diag] FOUND <channel> tag in stream: ${line.slice(0, 200)}\n`);
      }
      if (event.type === "system") {
        counts.clientSystemReminders++;
      }
      if (event.type === "assistant" || event.type === "user") {
        const blocks = event.message?.content ?? [];
        for (const b of Array.isArray(blocks) ? blocks : []) {
          if (b.type === "tool_use") {
            counts.clientToolCalls++;
            logBoth(`[client-diag] tool_use: ${b.name} input=${JSON.stringify(b.input).slice(0, 150)}\n`);
          }
          if (b.type === "tool_result") {
            counts.clientToolResults++;
          }
        }
      }
    } catch {
      // not JSON; ignore
    }
  }
});

claude.stderr.on("data", (chunk: Buffer) => {
  const text = chunk.toString("utf-8");
  log.write(`STDERR: ${text}`);

  // Server's [channel-trace] markers come through as nested stderr
  if (text.includes("[channel-trace]")) {
    for (const line of text.split("\n")) {
      if (line.includes("[channel-trace]")) {
        if (line.includes("WIRE-OUT")) counts.serverWireFrames++;
        else counts.serverChannelTraceLines++;
      }
    }
  }
  // Claude Code's own debug logging — look for evidence of MCP notification handling
  if (/unhandled|unknown.*notification|drop/i.test(text)) {
    counts.clientUnhandledMcpLogs++;
    logBoth(`[client-diag] CLIENT MCP LOG: ${text.trim().slice(0, 300)}\n`);
  }
});

const TIMEOUT_MS = 180_000;
const killTimer = setTimeout(() => {
  logBoth(`[client-diag] TIMEOUT — killing claude\n`);
  claude.kill("SIGTERM");
  setTimeout(() => claude.kill("SIGKILL"), 3000);
}, TIMEOUT_MS);

claude.on("exit", (code) => {
  clearTimeout(killTimer);
  logBoth(`\n[client-diag] claude exited code=${code}\n`);

  // Read the server trace file — this is the ground truth for what the
  // server emitted, since Claude Code captures the server's stderr and we
  // can't see it via the host stderr stream.
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const traceContent = fs.readFileSync(SERVER_TRACE_FILE, "utf-8");
    const lines = traceContent.split("\n").filter((l) => l.includes("[channel-trace]"));
    counts.serverChannelTraceLines = lines.length;
    counts.serverWireFrames = lines.filter((l) => l.includes("WIRE-OUT")).length;
    logBoth(`\n[client-diag] server trace file: ${SERVER_TRACE_FILE}\n`);
    if (lines.length > 0) {
      logBoth(`[client-diag] first 5 trace lines:\n`);
      for (const l of lines.slice(0, 5)) logBoth(`  ${l}\n`);
    }
  } catch (err) {
    logBoth(`[client-diag] failed to read server trace file: ${(err as Error).message}\n`);
  }

  logBoth(`\n=== END-TO-END CLIENT DIAGNOSTIC SUMMARY ===\n`);
  logBoth(`SERVER SIDE (proves we sent frames):\n`);
  logBoth(`  channel-trace markers:     ${counts.serverChannelTraceLines}\n`);
  logBoth(`  wire-out frames:           ${counts.serverWireFrames}\n`);
  logBoth(`\nCLIENT SIDE (proves Claude Code processed them):\n`);
  logBoth(`  total stream events:       ${counts.clientStreamEvents}\n`);
  logBoth(`  MCP tool calls (by Claude):${counts.clientToolCalls}\n`);
  logBoth(`  MCP tool results:          ${counts.clientToolResults}\n`);
  logBoth(`  channel mentions in stream:${counts.clientChannelMentions}\n`);
  logBoth(`  system messages:           ${counts.clientSystemReminders}\n`);
  logBoth(`  unhandled-mcp log lines:   ${counts.clientUnhandledMcpLogs}\n`);

  logBoth(`\n=== VERDICT ===\n`);
  if (counts.serverWireFrames === 0) {
    logBoth(`❌ Server didn't send frames. Test setup issue, not a client question.\n`);
  } else if (counts.clientChannelMentions > 0) {
    logBoth(`✅ Server sent ${counts.serverWireFrames} frames. Client surfaced them in the stream.\n`);
    logBoth(`   Channel notifications ARE consumed by Claude Code.\n`);
  } else if (counts.clientUnhandledMcpLogs > 0) {
    logBoth(`❌ Server sent ${counts.serverWireFrames} frames. Client logged "unhandled" warnings.\n`);
    logBoth(`   Channel notifications reach Claude Code but are dropped (no handler).\n`);
  } else {
    logBoth(`⚠️  Server sent ${counts.serverWireFrames} frames. Client showed NO evidence of receiving them.\n`);
    logBoth(`    No channel mentions, no <channel> tags, no debug logs about them.\n`);
    logBoth(`    Either: Claude Code silently discards unknown methods, OR it consumes them\n`);
    logBoth(`    but doesn't pass them through to the agent's visible context.\n`);
    logBoth(`    Inspect the log file directly to look for subtler signals: ${LOG_FILE}\n`);
  }

  log.end();
  process.exit(code ?? 0);
});
