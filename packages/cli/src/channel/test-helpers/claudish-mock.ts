#!/usr/bin/env bun
/**
 * claudish-mock — minimal MCP server that mimics a Claudish channel session
 * for end-to-end Claude Code rendering validation.
 *
 * Purpose: prove (or disprove) that Claude Code surfaces
 * notifications/claude/channel as <channel source="claudish-mock"> blocks in
 * an interactive session. Avoids depending on a real model — pure scripted
 * timing means any failure must be in Claude Code's channel rendering path,
 * not in our session machinery.
 *
 * Tool: `start_mock_session`
 *   Returns immediately with a session_id. Then over the next ~9 seconds,
 *   pushes the documented sequence of channel notifications:
 *     t=0.5s   running (first model output)
 *     t=2.0s   tool_executing (Read)
 *     t=3.5s   tool_executing (Bash)
 *     t=5.0s   tool_executing (Edit)
 *     t=6.5s   tool_executing (Write)
 *     t=8.0s   completed
 *
 * Wire format matches the real claudish bridge byte-for-byte (capability,
 * method name, params shape, meta key naming) so this also serves as a
 * reference of what conformant emission looks like.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";

const SERVER_NAME = "claudish-mock";

// Scripted sequence: each entry becomes a single notifications/claude/channel
// frame, fired at the offset given (ms from session start).
interface MockEvent {
  delayMs: number;
  type: string;
  content: string;
  extraMeta?: Record<string, string>;
}

const SCRIPT: MockEvent[] = [
  { delayMs: 500, type: "running", content: "Starting analysis of the codebase." },
  { delayMs: 2000, type: "tool_executing", content: "Read package.json", extraMeta: { tool: "Read" } },
  { delayMs: 3500, type: "tool_executing", content: "Running build", extraMeta: { tool: "Bash" } },
  { delayMs: 5000, type: "tool_executing", content: "Editing src/index.ts", extraMeta: { tool: "Edit" } },
  { delayMs: 6500, type: "tool_executing", content: "Writing CHANGELOG.md", extraMeta: { tool: "Write" } },
  { delayMs: 8000, type: "completed", content: "Mock session finished. All 6 events emitted." },
];

function trace(line: string): void {
  // Mirror to stderr for live observation. Claude Code captures MCP server
  // stderr internally so this only shows up in --debug logs.
  process.stderr.write(`[mock] ${line}\n`);
}

const server = new Server(
  { name: SERVER_NAME, version: "0.0.1" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions:
      `Mock channel server for testing. Call start_mock_session to begin a ` +
      `scripted sequence of channel events. Events arrive as ` +
      `<channel source="${SERVER_NAME}" event="..." session_id="..." ...> blocks. ` +
      `Quote each <channel> block VERBATIM as it arrives so we can verify they reach the agent.`,
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "start_mock_session",
      description:
        "Start a mock Claudish session that emits a scripted sequence of channel notifications " +
        "over ~9 seconds. Returns the session_id immediately; events arrive asynchronously.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "start_mock_session") {
    throw new Error(`unknown tool: ${req.params.name}`);
  }

  const sessionId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  trace(`session ${sessionId} started, scheduling ${SCRIPT.length} events`);

  for (const event of SCRIPT) {
    setTimeout(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const params = {
        content: event.content,
        meta: {
          session_id: sessionId,
          event: event.type,
          model: "mock",
          elapsed_seconds: String(elapsed),
          ...(event.extraMeta ?? {}),
        },
      };
      trace(`emit sid=${sessionId} type=${event.type} t=${elapsed}s`);
      server.notification({
        method: "notifications/claude/channel",
        params,
      });
    }, event.delayMs);
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            session_id: sessionId,
            scheduled_events: SCRIPT.length,
            duration_seconds: SCRIPT[SCRIPT.length - 1].delayMs / 1000,
            note: "Notifications will arrive asynchronously as <channel> blocks.",
          },
          null,
          2
        ),
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
trace(`server connected, name=${SERVER_NAME}`);
