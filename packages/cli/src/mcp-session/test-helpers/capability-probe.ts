#!/usr/bin/env bun
/**
 * mcp-capability-probe — measures what THIS Claude Code build actually supports.
 *
 * Research instrument, not a test. Answers, from the client's own declarations
 * and observed behaviour:
 *   1. What protocolVersion + capabilities does the client advertise? (initialize)
 *   2. Does it send a progressToken? (prerequisite for any progress signal)
 *   3. Does progress emission kill the stdio transport? (the parked regression)
 *   4. Does it accept resource_link content blocks?
 *   5. Does it accept structuredContent + outputSchema?
 *
 * Every observation is appended to $PROBE_LOG as JSONL.
 */
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const LOG_PATH = process.env.PROBE_LOG ?? "/tmp/mcp-capability-probe.jsonl";

function log(event: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  try {
    appendFileSync(LOG_PATH, `${line}\n`);
  } catch {
    /* never let logging break the probe */
  }
  process.stderr.write(`[probe] ${line}\n`);
}

const server = new Server(
  { name: "mcp-capability-probe", version: "0.0.1" },
  { capabilities: { tools: {}, resources: {}, logging: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // By now initialize has completed, so the client's declarations are readable.
  log({
    event: "CLIENT_DECLARATIONS",
    clientCapabilities: server.getClientCapabilities() ?? null,
    clientVersion: server.getClientVersion() ?? null,
  });
  return {
    tools: [
      {
        name: "probe_progress",
        description:
          "Emits 3 notifications/progress over ~4s then returns. Reports whether the " +
          "client sent a progressToken.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "probe_ping",
        description: "Returns 'pong'. Call AFTER probe_progress to detect stdio transport death.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "probe_resource_link",
        description: "Returns a resource_link content block pointing at a real file.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "probe_structured",
        description: "Returns structuredContent validated against an outputSchema.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: {
          type: "object",
          properties: {
            verdict: { type: "string" },
            models_failed: { type: "number" },
          },
          required: ["verdict", "models_failed"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, _meta } = req.params;
  const progressToken = _meta?.progressToken;
  log({ event: "tools.call", name, progressToken: progressToken ?? null, meta: _meta ?? null });

  if (name === "probe_ping") {
    return { content: [{ type: "text", text: "pong — transport alive" }] };
  }

  if (name === "probe_progress") {
    if (progressToken === undefined) {
      log({ event: "NO_PROGRESS_TOKEN", note: "client did not request progress" });
      return {
        content: [
          {
            type: "text",
            text: "NO_PROGRESS_TOKEN — client sent no progressToken; emitted nothing",
          },
        ],
      };
    }
    for (let i = 1; i <= 3; i++) {
      await new Promise((r) => setTimeout(r, 1200));
      const params = {
        progressToken,
        progress: i,
        total: 3,
        message: `PROBE-STEP-${i}: model ${i} of 3 finished`,
      };
      log({ event: "emit.progress", ...params });
      try {
        await server.notification({ method: "notifications/progress", params });
      } catch (err) {
        log({ event: "ERROR.progress_emit", err: (err as Error).message });
      }
    }
    return {
      content: [
        {
          type: "text",
          text: "probe_progress done — 3 progress notifications emitted with messages",
        },
      ],
    };
  }

  if (name === "probe_resource_link") {
    log({ event: "returning.resource_link" });
    return {
      content: [
        { type: "text", text: "Result summary: 2 of 3 models failed. Detail in the linked file." },
        {
          type: "resource_link",
          uri: `file://${LOG_PATH}`,
          name: "probe-log.jsonl",
          description: "Full diagnostic log for this probe run",
          mimeType: "application/jsonl",
        },
      ],
    };
  }

  if (name === "probe_structured") {
    log({ event: "returning.structuredContent" });
    return {
      content: [{ type: "text", text: '{"verdict":"degraded","models_failed":2}' }],
      structuredContent: { verdict: "degraded", models_failed: 2 },
    };
  }

  throw new Error(`unknown tool: ${name}`);
});

process.stdin.on("end", () => log({ event: "STDIN_END", note: "client closed stdin" }));
process.on("exit", (code) => log({ event: "process.exit", code }));

const transport = new StdioServerTransport();
await server.connect(transport);
log({ event: "server.connected" });
