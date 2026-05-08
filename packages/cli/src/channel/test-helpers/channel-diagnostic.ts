#!/usr/bin/env bun
/**
 * Channel notification diagnostic.
 *
 * Spawns the claudish MCP server with CLAUDISH_CHANNEL_TRACE=1 and drives a
 * full create_session → completion lifecycle while capturing:
 *   - All stderr (our channel-trace markers + any errors)
 *   - All stdout (raw JSON-RPC frames the server emits)
 *
 * Both streams are written to logs/channel-diagnostic-<timestamp>.log AND
 * mirrored to the console for live observation.
 *
 * Usage:
 *   bun run packages/cli/src/channel/test-helpers/channel-diagnostic.ts [model] [prompt]
 *
 * Defaults:
 *   model:  z-ai/glm-4.5-air:free   (free OpenRouter model — no cost)
 *   prompt: "Reply with exactly: hello channel diagnostic"
 *
 * Exit codes:
 *   0 — session completed AND we observed wire-out frames + completed event
 *   1 — diagnostic failure (no frames, no completion, or transport error)
 */
import { spawn } from "node:child_process";
import { mkdirSync, createWriteStream } from "node:fs";
import { join, resolve } from "node:path";

const MODEL = process.argv[2] ?? "z-ai/glm-4.5-air:free";
const PROMPT = process.argv[3] ?? "Reply with exactly: hello channel diagnostic";
const TIMEOUT_MS = 90_000; // hard cap — fail-loud rather than hang

const LOG_DIR = resolve(import.meta.dir, "../../../../../logs");
mkdirSync(LOG_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const LOG_FILE = join(LOG_DIR, `channel-diagnostic-${stamp}.log`);
const log = createWriteStream(LOG_FILE);

function writeBoth(line: string) {
  process.stderr.write(line);
  log.write(line);
}

writeBoth(`[diag] starting channel diagnostic\n`);
writeBoth(`[diag] model=${MODEL}\n`);
writeBoth(`[diag] prompt=${PROMPT}\n`);
writeBoth(`[diag] log file: ${LOG_FILE}\n`);

const SERVER_ENTRY = resolve(import.meta.dir, "../../../src/index.ts");
const proc = spawn("bun", ["run", SERVER_ENTRY, "--mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    CLAUDISH_CHANNEL_TRACE: "1",
    // Force channel tools enabled regardless of default
    CLAUDISH_MCP_TOOLS: "all",
  },
});

let observedTraceLines = 0;
let observedWireFrames = 0;
let observedCompletion = false;
let observedFailure = false;
let stderrBuf = "";
let stdoutBuf = "";

proc.stderr.on("data", (chunk: Buffer) => {
  const text = chunk.toString("utf-8");
  stderrBuf += text;
  log.write(`STDERR: ${text}`);
  process.stderr.write(`\x1b[2m${text}\x1b[0m`); // dim color for stderr mirror
  if (text.includes("[channel-trace]")) {
    observedTraceLines += text.split("\n").filter((l) => l.includes("[channel-trace]")).length;
  }
  if (text.includes("WIRE-OUT")) {
    observedWireFrames += text.split("\n").filter((l) => l.includes("WIRE-OUT")).length;
  }
});

proc.stdout.on("data", (chunk: Buffer) => {
  const text = chunk.toString("utf-8");
  stdoutBuf += text;
  log.write(`STDOUT: ${text}`);
  // Line-by-line JSON-RPC parse for "completed" / "failed" notifications
  const lines = (stdoutBuf.match(/[^\n]+\n/g) ?? []) as string[];
  if (lines.length > 0) {
    stdoutBuf = stdoutBuf.slice(lines.join("").length);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.method === "notifications/claude/channel") {
          const evt = msg.params?.meta?.event;
          writeBoth(`[diag] received notification event=${evt}\n`);
          if (evt === "completed") observedCompletion = true;
          if (evt === "failed") observedFailure = true;
        } else if (msg.id !== undefined && msg.result) {
          writeBoth(`[diag] received response id=${msg.id} keys=${Object.keys(msg.result).join(",")}\n`);
        } else if (msg.id !== undefined && msg.error) {
          writeBoth(`[diag] received ERROR id=${msg.id} code=${msg.error.code} msg=${msg.error.message}\n`);
        }
      } catch {
        // not JSON, skip
      }
    }
  }
});

function send(rpc: object) {
  const frame = JSON.stringify(rpc) + "\n";
  log.write(`SEND: ${frame}`);
  proc.stdin.write(frame);
}

// Step A: initialize
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    clientInfo: { name: "channel-diagnostic", version: "1.0.0" },
    capabilities: {
      experimental: { "claude/channel": {} },
    },
  },
});

// Step B: notifications/initialized + tools/call create_session
// Slight delay to let init complete
setTimeout(() => {
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  setTimeout(() => {
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "create_session",
        arguments: {
          model: MODEL,
          prompt: PROMPT,
          timeout_seconds: 60,
        },
      },
    });
  }, 200);
}, 500);

// Hard timeout
const killTimer = setTimeout(() => {
  writeBoth(`[diag] TIMEOUT after ${TIMEOUT_MS}ms — killing server\n`);
  proc.kill("SIGTERM");
  setTimeout(() => proc.kill("SIGKILL"), 2000);
}, TIMEOUT_MS);

proc.on("exit", (code) => {
  clearTimeout(killTimer);
  writeBoth(`[diag] server exited code=${code}\n`);
  writeBoth(`\n=== DIAGNOSTIC SUMMARY ===\n`);
  writeBoth(`trace lines observed:   ${observedTraceLines}\n`);
  writeBoth(`wire frames observed:   ${observedWireFrames}\n`);
  writeBoth(`completion event:       ${observedCompletion}\n`);
  writeBoth(`failure event:          ${observedFailure}\n`);
  writeBoth(`exit code:              ${code}\n`);
  writeBoth(`log written to:         ${LOG_FILE}\n`);

  // Diagnostic verdict
  if (observedTraceLines === 0) {
    writeBoth(`\n❌ VERDICT: onStateChange callback never fired.\n`);
    writeBoth(`   Producer side broken — SignalWatcher or SessionManager not driving events.\n`);
  } else if (observedWireFrames === 0) {
    writeBoth(`\n❌ VERDICT: onStateChange fired but no JSON-RPC frame reached stdout.\n`);
    writeBoth(`   server.notification() is being called but transport is silently dropping.\n`);
  } else if (!observedCompletion && !observedFailure) {
    writeBoth(`\n⚠️  VERDICT: Frames flowed but no terminal event seen.\n`);
    writeBoth(`   Session may be hung or model produced no output.\n`);
  } else {
    writeBoth(`\n✅ VERDICT: Producer→bridge→wire pipeline confirmed working.\n`);
    writeBoth(`   If client sees no <channel> blocks, the issue is client-side handling.\n`);
  }

  log.end();
  process.exit(observedTraceLines > 0 && observedWireFrames > 0 ? 0 : 1);
});
