#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
/**
 * progress-regression-mock — minimal MCP server that emits
 * notifications/progress during a tool call to test whether Claude Code's
 * stdio-kill regression (anthropics/claude-code#53617, #47378) still affects
 * the current installed version.
 *
 * Tools:
 *   - slow_ping_with_progress   : emits 2 progress notifications, then returns
 *   - simple_ping               : just returns "pong" (no progress emitted)
 *
 * Test flow (driven from outside):
 *   1. Call slow_ping_with_progress  -> server emits progress, returns success
 *   2. Call simple_ping              -> if regression is active, this fails
 *                                      because Claude Code closed stdio after
 *                                      step 1
 *
 * Verdict:
 *   - simple_ping succeeds  =>  regression FIXED in tested CC version
 *   - simple_ping hangs / errors  =>  regression STILL ACTIVE
 *
 * The server logs every received message and every emitted notification to a
 * file (path from PROGRESS_REGRESSION_LOG env var) so the test can verify
 * server-side what happened.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const LOG_PATH = process.env.PROGRESS_REGRESSION_LOG ?? "/tmp/progress-regression.log";

function log(event: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  try {
    appendFileSync(LOG_PATH, `${line}\n`);
  } catch {
    // never let logging break the server
  }
  process.stderr.write(`[progress-mock] ${line}\n`);
}

const server = new Server(
  { name: "progress-regression-mock", version: "0.0.1" },
  {
    capabilities: { tools: {} },
    instructions:
      "Test server for progress-notification regression detection. " +
      "Call slow_ping_with_progress first, then simple_ping. If the second " +
      "call hangs or fails, the stdio-kill regression is still active.",
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  log({ event: "tools.list" });
  return {
    tools: [
      {
        name: "slow_ping_with_progress",
        description:
          "Emits 2 notifications/progress then returns. Used to test whether " +
          "Claude Code closes the stdio transport after server-emitted progress.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "simple_ping",
        description: "Returns 'pong' immediately. Used as a follow-up to detect transport death.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "slow_with_many_progress",
        description:
          "Runs for ~10 seconds, emitting 5 distinct notifications/progress along the way. " +
          "Used to observe whether Claude Code 2.1.133 renders progress notifications in " +
          "the terminal UI or surfaces them to the agent context.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, _meta } = req.params;
  const progressToken = _meta?.progressToken;
  log({ event: "tools.call.received", name, progressToken: progressToken ?? null });

  if (name === "simple_ping") {
    log({ event: "simple_ping.responding" });
    return { content: [{ type: "text", text: "pong" }] };
  }

  if (name === "slow_with_many_progress") {
    if (progressToken === undefined) {
      log({
        event: "warn.no_progress_token",
        note: "client did not send progressToken; emitting nothing",
      });
    } else {
      const steps = [
        { message: "Step 1 of 5: scanning files" },
        { message: "Step 2 of 5: parsing AST" },
        { message: "Step 3 of 5: running checks" },
        { message: "Step 4 of 5: aggregating results" },
        { message: "Step 5 of 5: writing output" },
      ];
      for (let i = 0; i < steps.length; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const params = {
          progressToken,
          progress: i + 1,
          total: steps.length,
          message: steps[i].message,
        };
        log({ event: "emit.notification.progress", ...params });
        try {
          await server.notification({ method: "notifications/progress", params });
        } catch (err) {
          log({ event: "error.progress_emit_failed", err: (err as Error).message });
        }
      }
    }
    log({ event: "slow_with_many_progress.responding" });
    return {
      content: [
        {
          type: "text",
          text: "slow_with_many_progress completed (5 progress notifications emitted)",
        },
      ],
    };
  }

  if (name === "slow_ping_with_progress") {
    if (progressToken === undefined) {
      log({
        event: "warn.no_progress_token",
        note: "client did not send progressToken; skipping notifications",
      });
    } else {
      // First progress event
      log({ event: "emit.notification.progress", progress: 1, total: 2 });
      try {
        await server.notification({
          method: "notifications/progress",
          params: { progressToken, progress: 1, total: 2, message: "halfway" },
        });
      } catch (err) {
        log({ event: "error.progress_emit_failed", err: (err as Error).message });
      }

      await new Promise((r) => setTimeout(r, 500));

      // Second progress event
      log({ event: "emit.notification.progress", progress: 2, total: 2 });
      try {
        await server.notification({
          method: "notifications/progress",
          params: { progressToken, progress: 2, total: 2, message: "done" },
        });
      } catch (err) {
        log({ event: "error.progress_emit_failed", err: (err as Error).message });
      }
    }

    log({ event: "slow_ping.responding" });
    return { content: [{ type: "text", text: "slow ping done (progress emitted)" }] };
  }

  throw new Error(`unknown tool: ${name}`);
});

// Detect when Claude Code closes our stdin — the symptom of the regression.
process.stdin.on("end", () => {
  log({ event: "stdin.end", note: "client closed stdin" });
});
process.stdin.on("close", () => {
  log({ event: "stdin.close" });
});
process.on("beforeExit", (code) => {
  log({ event: "process.beforeExit", code });
});
process.on("exit", (code) => {
  log({ event: "process.exit", code });
});

const transport = new StdioServerTransport();
await server.connect(transport);
log({ event: "server.connected" });
