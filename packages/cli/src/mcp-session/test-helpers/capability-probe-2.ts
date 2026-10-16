#!/usr/bin/env bun
/**
 * capability-probe-2 — second-round measurement of Claude Code's MCP surface.
 *
 * Round 1 (`capability-probe.ts`) established: progress reaches nobody, resource_link
 * works, structuredContent is indistinguishable, and the client DECLARES elicitation.
 *
 * This round answers the two questions round 1 left open:
 *   1. Does the client ever call resources/list or resources/read? (Are MCP resources
 *      a usable payload channel, or is resource_link + file path the only option?)
 *   2. Does elicitation actually WORK end-to-end, or is the declaration aspirational?
 *
 * Observations append to $PROBE_LOG as JSONL.
 */
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const LOG_PATH = process.env.PROBE_LOG ?? "/tmp/mcp-capability-probe-2.jsonl";

function log(event: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  try {
    appendFileSync(LOG_PATH, `${line}\n`);
  } catch {
    /* never let logging break the probe */
  }
  process.stderr.write(`[probe2] ${line}\n`);
}

const server = new Server(
  { name: "mcp-capability-probe-2", version: "0.0.1" },
  { capabilities: { tools: {}, resources: { listChanged: true } } }
);

const RESOURCE_URI = "claudish://team/session-42/status";

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  log({ event: "RESOURCES_LIST_CALLED", note: "client DID query resources/list" });
  return {
    resources: [
      {
        uri: RESOURCE_URI,
        name: "team-session-42-status",
        description: "Diagnostic status for team session 42",
        mimeType: "application/json",
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  log({ event: "RESOURCES_READ_CALLED", uri: req.params.uri });
  return {
    contents: [
      {
        uri: req.params.uri,
        mimeType: "application/json",
        text: JSON.stringify({ marker: "RESOURCE-READ-OK", failed: 2 }),
      },
    ],
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  log({ event: "client.declarations", capabilities: server.getClientCapabilities() ?? null });
  return {
    tools: [
      {
        name: "probe_elicit",
        description:
          "Asks the human a question via MCP elicitation and reports their answer. " +
          "Tests whether the declared elicitation capability actually functions.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "probe_resource_uri",
        description:
          "Returns a resource_link using a CUSTOM SCHEME uri (claudish://...) rather than file://. " +
          "Tests whether the agent can dereference server-hosted resources.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params;
  log({ event: "tools.call", name });

  if (name === "probe_elicit") {
    try {
      const result = await server.elicitInput({
        message: "Model 'gemini-3.6-flash' has no credential. Route it via OpenRouter instead?",
        requestedSchema: {
          type: "object",
          properties: {
            reroute: {
              type: "boolean",
              description: "Re-route via OpenRouter",
            },
          },
          required: ["reroute"],
        },
      });
      log({ event: "ELICIT_RESULT", result });
      return {
        content: [
          {
            type: "text",
            text: `ELICIT_OK action=${result.action} content=${JSON.stringify(result.content ?? null)}`,
          },
        ],
      };
    } catch (err) {
      log({ event: "ELICIT_FAILED", err: (err as Error).message });
      return {
        content: [{ type: "text", text: `ELICIT_FAILED: ${(err as Error).message}` }],
      };
    }
  }

  if (name === "probe_resource_uri") {
    log({ event: "returning.custom_scheme_resource_link", uri: RESOURCE_URI });
    return {
      content: [
        {
          type: "text",
          text: "Summary: 2 of 6 models failed. Full status available as a resource.",
        },
        {
          type: "resource_link",
          uri: RESOURCE_URI,
          name: "team-session-42-status",
          description: "Diagnostic status JSON, served by this MCP server",
          mimeType: "application/json",
        },
      ],
    };
  }

  throw new Error(`unknown tool: ${name}`);
});

process.stdin.on("end", () => log({ event: "STDIN_END" }));
process.on("exit", (code) => log({ event: "process.exit", code }));

const transport = new StdioServerTransport();
await server.connect(transport);
log({ event: "server.connected" });
