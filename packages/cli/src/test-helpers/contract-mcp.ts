// packages/cli/src/test-helpers/contract-mcp.ts
/**
 * Drives a real claudish MCP server over stdio (newline-delimited JSON-RPC, the MCP stdio
 * transport) for the *.contract.test.ts files. The test process stands in for Claude Code:
 * it is the server's parent, so a correct `hostPid` equals `process.pid` (design §8.1 9b).
 *
 * The protocol is public. What is NOT in the contract, and is therefore isolated in the
 * "tool adapters" section at the bottom, is the exact argument and result field names of the
 * claudish tools. Each adapter is marked INFERRED; fix a mismatch there, once.
 */
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TempLayout } from "./contract-records.js";

export const SRC_DIR = join(import.meta.dir, "..");
export const PACKAGE_DIR = join(SRC_DIR, "..");
export const SERVER_ENTRY = join(SRC_DIR, "index.ts");
export const FAKE_CHILD = join(import.meta.dir, "contract-fake-child.ts");
/** Design §3.5 step 1: the dispatcher reads `extra._meta?.["claudecode/toolUseId"]`. */
export const TOOL_USE_ID_META_KEY_FROM_SPEC = "claudecode/toolUseId";
export const FAKE_MODEL = "contract-fake-model";

/**
 * A server environment built from scratch, so nothing leaks in from the shell that runs the
 * tests (for example a CLAUDE_CODE_SESSION_ID set because the tests run inside Claude Code).
 * `undefined` in `extra` deletes a key.
 */
export function serverEnv(
  layout: TempLayout,
  extra: Record<string, string | undefined> = {}
): Record<string, string> {
  chmodSync(FAKE_CHILD, 0o755);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: layout.home,
    TMPDIR: tmpdir(),
    CLAUDISH_SESSIONS_DIR: layout.sessionsDir,
    CLAUDISH_BIN: FAKE_CHILD,
    CLAUDE_CONFIG_DIR: layout.configDir,
    NO_COLOR: "1",
  };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

export interface ToolResult {
  isError: boolean;
  text: string;
  json: Record<string, unknown> | undefined;
  raw: unknown;
}

interface Pending {
  resolve: (msg: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

export interface ToolInfo {
  name: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

export class McpServer {
  readonly proc: ReturnType<typeof Bun.spawn>;
  readonly pid: number;
  stderrText = "";
  readonly notifications: Record<string, unknown>[] = [];
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private tools: ToolInfo[] | undefined;
  private exited = false;

  private constructor(command: string[], env: Record<string, string>, cwd: string) {
    this.proc = Bun.spawn(command, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.pid = this.proc.pid;
    void this.pumpStdout();
    void this.pumpStderr();
    void this.proc.exited.then(() => {
      this.exited = true;
      for (const p of this.pending.values()) {
        p.reject(new Error(`MCP server exited; stderr tail:\n${this.stderrText.slice(-3000)}`));
      }
      this.pending.clear();
    });
  }

  /** Start `bun <src>/index.ts --mcp` (the compiled-binary branch, §8.1 9b) unless `command` is given. */
  static async start(opts: {
    env: Record<string, string>;
    cwd: string;
    command?: string[];
  }): Promise<McpServer> {
    const server = new McpServer(
      opts.command ?? [process.execPath, SERVER_ENTRY, "--mcp"],
      opts.env,
      opts.cwd
    );
    await server.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claudish-contract-tests", version: "0.0.0" },
    });
    server.notify("notifications/initialized", {});
    return server;
  }

  private async pumpStdout(): Promise<void> {
    const stdout = this.proc.stdout as ReadableStream<Uint8Array>;
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line) this.onMessage(line);
      }
    }
  }

  private async pumpStderr(): Promise<void> {
    const stderr = this.proc.stderr as ReadableStream<Uint8Array>;
    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      this.stderrText = (this.stderrText + decoder.decode(value, { stream: true })).slice(-50_000);
    }
  }

  private onMessage(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // not protocol traffic
    }
    const id = msg.id;
    if (typeof id === "number" && ("result" in msg || "error" in msg) && this.pending.has(id)) {
      const p = this.pending.get(id) as Pending;
      this.pending.delete(id);
      p.resolve(msg);
      return;
    }
    if ("method" in msg && id !== undefined) {
      // A server-to-client request (ping, roots/list, ...): answer with an empty result.
      this.write({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    this.notifications.push(msg);
  }

  private write(msg: unknown): void {
    const sink = this.proc.stdin as { write(s: string): unknown; flush?(): unknown };
    sink.write(`${JSON.stringify(msg)}\n`);
    sink.flush?.();
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  request(method: string, params: unknown, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    if (this.exited)
      return Promise.reject(
        new Error(`MCP server already exited; stderr:\n${this.stderrText.slice(-3000)}`)
      );
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `MCP ${method} timed out after ${timeoutMs} ms; stderr tail:\n${this.stderrText.slice(-3000)}`
          )
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async listTools(): Promise<ToolInfo[]> {
    if (!this.tools) {
      const msg = await this.request("tools/list", {});
      this.tools = ((msg.result as { tools?: ToolInfo[] } | undefined)?.tools ?? []) as ToolInfo[];
    }
    return this.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>
  ): Promise<ToolResult> {
    const params: Record<string, unknown> = { name, arguments: args };
    if (meta) params._meta = meta;
    const msg = await this.request("tools/call", params);
    if (msg.error) {
      const text = String(
        (msg.error as { message?: unknown }).message ?? JSON.stringify(msg.error)
      );
      return { isError: true, text, json: undefined, raw: msg };
    }
    const result = (msg.result ?? {}) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .map((c) => (typeof c.text === "string" ? c.text : ""))
      .join("\n");
    let json: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      json = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      json = undefined;
    }
    return { isError: Boolean(result.isError), text, json, raw: msg };
  }

  async close(): Promise<void> {
    if (!this.exited) {
      try {
        (this.proc.stdin as { end?(): unknown }).end?.();
      } catch {
        // already closed
      }
      const ended = await Promise.race([
        this.proc.exited.then(() => true),
        Bun.sleep(3_000).then(() => false),
      ]);
      if (!ended) {
        this.proc.kill("SIGKILL");
        await this.proc.exited;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Tool adapters. INFERRED: argument and result field names of the claudish tools are not in the
// contract. Tool NAMES (create_session, send_input, get_session, get_output, get_diagnostics,
// cancel_session, list_sessions, team) and `timeout_seconds`, `session_id`, `monitor_record`
// come from the design text. Where a name could vary, the adapter reads the tool's own
// inputSchema from tools/list instead of guessing.
// ---------------------------------------------------------------------------------------------

async function pickArgKey(server: McpServer, tool: string, preferred: string[]): Promise<string> {
  const info = (await server.listTools()).find((t) => t.name === tool);
  const props = Object.keys(info?.inputSchema?.properties ?? {});
  return preferred.find((k) => props.includes(k)) ?? (preferred[0] as string);
}

/** Find a string field anywhere in a JSON value, depth-first, by key. */
export function findField(value: unknown, key: string, depth = 0): unknown {
  if (!value || typeof value !== "object" || depth > 6) return undefined;
  const obj = value as Record<string, unknown>;
  if (key in obj) return obj[key];
  for (const child of Object.values(obj)) {
    const hit = findField(child, key, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

export interface CreateArgs {
  model?: string;
  prompt?: string;
  timeout_seconds?: number;
}

export async function createSession(
  server: McpServer,
  args: CreateArgs,
  toolUseId?: string
): Promise<{ sessionId: string | undefined; result: ToolResult }> {
  const callArgs: Record<string, unknown> = { model: args.model ?? FAKE_MODEL };
  if (args.prompt !== undefined) callArgs.prompt = args.prompt;
  if (args.timeout_seconds !== undefined) callArgs.timeout_seconds = args.timeout_seconds;
  const meta =
    toolUseId === undefined ? undefined : { [TOOL_USE_ID_META_KEY_FROM_SPEC]: toolUseId };
  const result = await server.callTool("create_session", callArgs, meta);
  const fromJson = findField(result.json, "session_id") ?? findField(result.json, "sessionId");
  const fromText = /"?session_?[iI]d"?\s*[:=]\s*"?([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(
    result.text
  )?.[1];
  const sessionId = typeof fromJson === "string" ? fromJson : fromText;
  return { sessionId, result };
}

export async function sendInput(
  server: McpServer,
  sessionId: string,
  text: string
): Promise<ToolResult> {
  const key = await pickArgKey(server, "send_input", [
    "input",
    "message",
    "text",
    "content",
    "prompt",
  ]);
  return server.callTool("send_input", { session_id: sessionId, [key]: text });
}

export function sessionTool(
  server: McpServer,
  tool: string,
  sessionId: string
): Promise<ToolResult> {
  return server.callTool(tool, { session_id: sessionId });
}

/**
 * The session's status as `get_diagnostics` reports it, or undefined. The server exposes no
 * `get_session` tool (tools/list); `get_diagnostics` is the documented per-id tool, and its
 * result carries `status` for a live session and for one read back from disk.
 */
export async function sessionStatus(
  server: McpServer,
  sessionId: string
): Promise<string | undefined> {
  const r = await sessionTool(server, "get_diagnostics", sessionId);
  const status = findField(r.json, "status");
  if (typeof status === "string") return status;
  return /"status"\s*:\s*"([a-z_]+)"/.exec(r.text)?.[1];
}

export async function teamCall(
  server: McpServer,
  mode: string,
  args: { path: string; models?: string[]; input?: string }
): Promise<ToolResult> {
  const pathKey = await pickArgKey(server, "team", ["path", "session_path", "sessionPath"]);
  const call: Record<string, unknown> = { mode, [pathKey]: args.path };
  if (args.models) call.models = args.models;
  if (args.input !== undefined) {
    const inputKey = await pickArgKey(server, "team", ["input", "prompt", "task"]);
    call[inputKey] = args.input;
  }
  return server.callTool("team", call);
}
