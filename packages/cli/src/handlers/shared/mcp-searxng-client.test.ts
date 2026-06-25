/**
 * Tests for the MCP streamable-http client (mcp-searxng-client.ts).
 *
 * Uses a local Bun.serve mock that simulates the TBXark mcp-proxy +
 * mcp-searxng backend: JSON and SSE response formats, session handshake,
 * auth header check, error shapes, and timeouts.
 *
 * The hard contract under test: callMcpTool NEVER throws — every failure
 * mode resolves to { ok: false, error }.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  callMcpTool,
  mcpWebSearch,
  mcpUrlRead,
  isMcpSearxngAvailable,
  _resetMcpClientState,
} from "./mcp-searxng-client.js";

type MockBehavior =
  | "json-ok"
  | "sse-ok"
  | "session-required"
  | "http-500"
  | "tool-error"
  | "hang"
  | "rpc-error";

let behavior: MockBehavior = "json-ok";
let sawAuthHeader: string | null = null;
let initializeCount = 0;

function rpcResult(id: any, text: string, isError = false) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }], isError },
  });
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    sawAuthHeader = req.headers.get("authorization");
    const body = (await req.json().catch(() => ({}))) as any;
    const { id, method } = body;

    if (method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    if (method === "initialize") {
      initializeCount++;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "mock" } },
        }),
        { headers: { "Content-Type": "application/json", "mcp-session-id": "mock-session-123" } }
      );
    }

    // tools/call
    switch (behavior) {
      case "json-ok":
        return new Response(rpcResult(id, "mock search results"), {
          headers: { "Content-Type": "application/json" },
        });
      case "sse-ok": {
        const frame = `event: message\ndata: ${rpcResult(id, "mock sse results")}\n\n`;
        return new Response(frame, { headers: { "Content-Type": "text/event-stream" } });
      }
      case "session-required": {
        const sid = req.headers.get("mcp-session-id");
        if (sid !== "mock-session-123") {
          return new Response("Bad Request: no session", { status: 400 });
        }
        return new Response(rpcResult(id, "session-bound results"), {
          headers: { "Content-Type": "application/json" },
        });
      }
      case "http-500":
        return new Response("Internal Server Error", { status: 500 });
      case "tool-error":
        return new Response(rpcResult(id, "fetch failed: 403 Forbidden", true), {
          headers: { "Content-Type": "application/json" },
        });
      case "rpc-error":
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool" } }),
          { headers: { "Content-Type": "application/json" } }
        );
      case "hang":
        await new Promise((r) => setTimeout(r, 10_000));
        return new Response(rpcResult(id, "too late"), {
          headers: { "Content-Type": "application/json" },
        });
    }
  },
});

const MOCK_URL = `http://localhost:${server.port}/searxng/mcp`;

beforeEach(() => {
  _resetMcpClientState();
  process.env.SEARXNG_MCP_URL = MOCK_URL;
  process.env.MCP_AUTH = "test-token";
  behavior = "json-ok";
  sawAuthHeader = null;
  initializeCount = 0;
});

afterAll(() => {
  server.stop(true);
  delete process.env.SEARXNG_MCP_URL;
  delete process.env.MCP_AUTH;
});

describe("mcp-searxng-client", () => {
  test("not configured → ok:false without any network call", async () => {
    delete process.env.SEARXNG_MCP_URL;
    expect(isMcpSearxngAvailable()).toBe(false);
    const res = await callMcpTool("searxng_web_search", { query: "x" }, 1000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("not configured");
  });

  test("JSON response → ok:true with text, sends Bearer auth", async () => {
    const res = await mcpWebSearch("docker compose", 3000);
    expect(res).toEqual({ ok: true, text: "mock search results" });
    expect(sawAuthHeader).toBe("Bearer test-token");
  });

  test("SSE response format is parsed", async () => {
    behavior = "sse-ok";
    const res = await callMcpTool("searxng_web_search", { query: "x" }, 3000);
    expect(res).toEqual({ ok: true, text: "mock sse results" });
  });

  test("session-required: HTTP 400 triggers initialize handshake then retry succeeds", async () => {
    behavior = "session-required";
    const res = await callMcpTool("web_url_read", { url: "https://example.com" }, 5000);
    expect(res).toEqual({ ok: true, text: "session-bound results" });
    expect(initializeCount).toBe(1);
  });

  test("HTTP 500 → ok:false, never throws", async () => {
    behavior = "http-500";
    const res = await callMcpTool("searxng_web_search", { query: "x" }, 3000);
    expect(res.ok).toBe(false);
  });

  test("tool result with isError → ok:false carrying the error text", async () => {
    behavior = "tool-error";
    const res = await mcpUrlRead("https://blocked.example.com", 3000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("403");
  });

  test("JSON-RPC error object → ok:false with message", async () => {
    behavior = "rpc-error";
    const res = await callMcpTool("nonexistent_tool", {}, 3000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Unknown tool");
  });

  test("deadline: hung server → ok:false within budget, never throws", async () => {
    behavior = "hang";
    const started = Date.now();
    const res = await callMcpTool("searxng_web_search", { query: "x" }, 500);
    expect(res.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
