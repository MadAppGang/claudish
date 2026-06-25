/**
 * Minimal MCP streamable-http client for the SearXNG MCP server.
 *
 * The cluster exposes the mcp-searxng server (ihor-sokoliuk/mcp-searxng)
 * via a TBXark mcp-proxy in streamable-http mode, e.g.:
 *   https://mcp-tools.myia.io/searxng/mcp
 *
 * This is a plain JSON-RPC-over-HTTP client — no MCP SDK, no stdio spawn.
 * It exists so executeWebSearch/executeWebFetch can call the MCP tools
 * (searxng_web_search, web_url_read) from the synchronous SSE-stream
 * context with a strict deadline and graceful failure.
 *
 * HARD CONSTRAINT: nothing in this module may throw. Every entry point
 * returns { ok: true, text } | { ok: false, error }. A failed web call
 * must never crash a stream or block an agent turn.
 */

import { log } from "../../logger.js";

// Env is read at call time (not module load) so tests and late-injected
// container env can configure the client without import-order concerns.
function mcpUrl(): string {
  return process.env.SEARXNG_MCP_URL || "";
}
function mcpToken(): string {
  return process.env.MCP_AUTH || process.env.SEARXNG_MCP_TOKEN || "";
}

/** Whether the MCP route is configured. When false, callers skip straight to their fallbacks. */
export function isMcpSearxngAvailable(): boolean {
  return !!mcpUrl();
}

export type McpToolResult = { ok: true; text: string } | { ok: false; error: string };

/** Session ID negotiated via the initialize handshake, when the server requires one. */
let sessionId: string | null = null;
let nextRequestId = 1;

function baseHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const token = mcpToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return headers;
}

/**
 * Parse a streamable-http response body into the JSON-RPC response object.
 * Servers may answer with application/json (single object) or
 * text/event-stream (SSE frames whose data lines carry JSON-RPC messages).
 */
async function parseRpcResponse(response: Response, requestId: number): Promise<any> {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("text/event-stream")) {
    const body = await response.text();
    for (const line of body.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const msg = JSON.parse(payload);
        if (msg.id === requestId && (msg.result !== undefined || msg.error !== undefined)) {
          return msg;
        }
      } catch {
        // Non-JSON SSE data line — skip
      }
    }
    throw new Error("no JSON-RPC response found in SSE body");
  }

  return await response.json();
}

/**
 * Perform the MCP initialize handshake and cache the session ID.
 * Returns true on success.
 */
async function initializeSession(deadlineMs: number): Promise<boolean> {
  try {
    const id = nextRequestId++;
    const url = mcpUrl();
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(deadlineMs),
      headers: baseHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "claudish", version: "1.0" },
        },
      }),
    });

    if (!response.ok) {
      log(`[MCP-SearXNG] initialize failed: HTTP ${response.status}`);
      return false;
    }

    const sid = response.headers.get("mcp-session-id");
    if (sid) sessionId = sid;

    const msg = await parseRpcResponse(response, id);
    if (msg.error) {
      log(`[MCP-SearXNG] initialize error: ${JSON.stringify(msg.error)}`);
      return false;
    }

    // Per spec, the client must send notifications/initialized after initialize.
    // Fire-and-forget: some proxies don't require it, and a failure here is non-fatal.
    fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(3000),
      headers: baseHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }).catch(() => {});

    log(`[MCP-SearXNG] session initialized${sessionId ? ` (sid=${sessionId.slice(0, 8)}…)` : " (stateless)"}`);
    return true;
  } catch (err: any) {
    log(`[MCP-SearXNG] initialize error: ${err.message}`);
    return false;
  }
}

/**
 * Extract the text content from an MCP tools/call result.
 * Result shape: { content: [{ type: "text", text: "..." }, ...], isError?: boolean }
 */
function extractResultText(result: any): McpToolResult {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const text = blocks
    .filter((b: any) => b.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n");

  if (result?.isError) {
    return { ok: false, error: text || "MCP tool returned an error with no message" };
  }
  if (!text) {
    return { ok: false, error: "MCP tool returned empty content" };
  }
  return { ok: true, text };
}

async function postToolCall(name: string, args: Record<string, any>, deadlineMs: number): Promise<{ status: number; msg?: any }> {
  const id = nextRequestId++;
  const response = await fetch(mcpUrl(), {
    method: "POST",
    signal: AbortSignal.timeout(deadlineMs),
    headers: baseHeaders(),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

  if (!response.ok) {
    // Drain body so the connection can be reused
    await response.text().catch(() => {});
    return { status: response.status };
  }

  return { status: response.status, msg: await parseRpcResponse(response, id) };
}

/**
 * Call an MCP tool on the SearXNG server. Non-throwing, deadline-bounded.
 *
 * Tries a direct tools/call first (many proxies are stateless). If the server
 * rejects it in a way that suggests a missing session (HTTP 400/404, or a
 * "session" JSON-RPC error), performs the initialize handshake once and retries.
 */
export async function callMcpTool(
  name: string,
  args: Record<string, any>,
  deadlineMs: number
): Promise<McpToolResult> {
  if (!isMcpSearxngAvailable()) {
    return { ok: false, error: "SEARXNG_MCP_URL not configured" };
  }

  const startedAt = Date.now();
  try {
    let { status, msg } = await postToolCall(name, args, deadlineMs);

    const needsSession =
      (status === 400 || status === 404) ||
      (msg?.error && /session/i.test(String(msg.error.message || "")));

    if (needsSession) {
      sessionId = null;
      const initialized = await initializeSession(Math.min(deadlineMs, 5000));
      if (!initialized) {
        return { ok: false, error: `MCP session init failed (after HTTP ${status})` };
      }
      ({ status, msg } = await postToolCall(name, args, deadlineMs));
    }

    if (!msg) {
      return { ok: false, error: `MCP endpoint returned HTTP ${status}` };
    }
    if (msg.error) {
      return { ok: false, error: `MCP error: ${msg.error.message || JSON.stringify(msg.error)}` };
    }

    const result = extractResultText(msg.result);
    log(`[MCP-SearXNG] tools/call ${name} ${Date.now() - startedAt}ms ok=${result.ok}`);
    return result;
  } catch (err: any) {
    log(`[MCP-SearXNG] tools/call ${name} ${Date.now() - startedAt}ms failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/** Search the web via the MCP searxng_web_search tool. */
export async function mcpWebSearch(query: string, deadlineMs = 5000): Promise<McpToolResult> {
  return callMcpTool("searxng_web_search", { query }, deadlineMs);
}

/** Read a URL via the MCP web_url_read tool (server-side fetch + markdown conversion). */
export async function mcpUrlRead(url: string, deadlineMs = 12_000): Promise<McpToolResult> {
  return callMcpTool("web_url_read", { url }, deadlineMs);
}

/** Test hook: reset module state between tests. */
export function _resetMcpClientState(): void {
  sessionId = null;
  nextRequestId = 1;
}
