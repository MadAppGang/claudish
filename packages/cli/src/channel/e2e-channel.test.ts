/**
 * E2E tests for channel mode using real Claude Code.
 *
 * Spawns `claude -p` with `--mcp-config` pointing at our MCP server and
 * validates the full flow: Claude Code connects to our server, discovers
 * tools, calls them, and receives channel notifications.
 *
 * Tests are grouped by what they validate:
 *   Group 1: MCP server protocol (capabilities, tools) — via SDK client
 *   Group 2: Real Claude Code integration — spawns `claude` with our MCP tools
 *
 * Group 2 requires ANTHROPIC_API_KEY (Claude subscription).
 * Both groups require the claudish MCP server to be buildable.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { hasCredential } from "../test-helpers/credential-gate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER_ENTRY = join(__dirname, "../index.ts");
const SESSIONS_DIR = mkdtempSync(join(tmpdir(), "claudish-e2e-sessions-"));
const SKIP_LIVE_E2E = process.env.CLAUDISH_SKIP_LIVE_E2E === "1";

afterAll(() => {
  rmSync(SESSIONS_DIR, { recursive: true, force: true });
});

// Asked via claudish's OWN credential authority (env → aliases →
// ~/.claudish/config.json apiKeys → 1Password), NOT raw process.env: a key
// configured any supported way must run these tests, exactly as it would serve
// a real run. Module scope — describe() callbacks are sync, so no await there.
const hasOpenRouterKey = SKIP_LIVE_E2E ? false : await hasCredential("openrouter");

// ─── Group 1: MCP Protocol Tests (SDK Client) ───────────────────────────────
// Validates the MCP server itself works correctly at the protocol level.

describe("Group 1: MCP Protocol — channel capability", () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: "bun",
      args: ["run", SERVER_ENTRY, "--mcp"],
      env: {
        ...process.env,
        CLAUDISH_MCP_TOOLS: "all",
        CLAUDISH_SESSIONS_DIR: SESSIONS_DIR,
      },
      stderr: "pipe",
    });
    client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
  }, 15000);

  afterAll(async () => {
    try {
      await transport.close();
    } catch {}
  });

  test("declares experimental claude/channel capability", () => {
    const caps = client.getServerCapabilities();
    expect(caps?.experimental?.["claude/channel"]).toBeDefined();
  });

  test("provides instructions containing channel event docs", () => {
    const instructions = client.getInstructions();
    expect(instructions).toContain("session_id");
    expect(instructions).toContain("input_required");
    expect(instructions).toContain("completed");
  });

  test("lists all 11 tools (6 existing + 5 channel)", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "cancel_session",
      "compare_models",
      "create_session",
      "get_output",
      "list_models",
      "list_sessions",
      "report_error",
      "run_prompt",
      "search_models",
      "send_input",
      "team",
    ]);
  });

  test("create_session schema requires 'model'", async () => {
    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === "create_session")!;
    expect(tool.inputSchema.required).toContain("model");
    expect(tool.inputSchema.properties).toHaveProperty("prompt");
  });

  test("list_sessions returns empty initially", async () => {
    const result = await client.callTool({
      name: "list_sessions",
      arguments: { include_completed: true },
    });
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.sessions).toEqual([]);
  });

  test("send_input returns false for non-existent session", async () => {
    const result = await client.callTool({
      name: "send_input",
      arguments: { session_id: "bad", text: "hi" },
    });
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.success).toBe(false);
  });

  test("get_output errors for non-existent session", async () => {
    const result = await client.callTool({ name: "get_output", arguments: { session_id: "bad" } });
    expect(result.isError).toBe(true);
  });

  test("cancel_session returns false for non-existent session", async () => {
    const result = await client.callTool({
      name: "cancel_session",
      arguments: { session_id: "bad" },
    });
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.success).toBe(false);
  });

  test("unknown tool returns isError", async () => {
    const result = await client.callTool({ name: "no_such_tool", arguments: {} });
    expect(result.isError).toBe(true);
  });

  // Live session test via SDK client

  test.skipIf(!hasOpenRouterKey)(
    "create_session → poll → get_output lifecycle",
    async () => {
      const notifications: any[] = [];
      client.fallbackNotificationHandler = async (n: any) => {
        if (n.method === "notifications/claude/channel") notifications.push(n.params);
      };

      const res = await client.callTool({
        name: "create_session",
        arguments: {
          model: "minimax-m2.5",
          prompt: "Say exactly: hello world",
          timeout_seconds: 30,
        },
      });
      const { session_id: sid } = JSON.parse((res.content as any)[0].text);
      expect(sid).toBeDefined();

      // Poll until the session reaches a terminal state. Use a wall-clock
      // budget so scheduler contention cannot turn a slow session into a
      // misleading empty-output failure.
      const terminalStatuses = new Set(["completed", "failed", "timeout"]);
      const pollStartedAt = Date.now();
      const pollBudgetMs = 120_000;
      let lastObservedStatus = "not found";
      let reachedTerminal = false;

      while (Date.now() - pollStartedAt < pollBudgetMs) {
        await new Promise((r) => setTimeout(r, 1000));
        const list = await client.callTool({
          name: "list_sessions",
          arguments: { include_completed: true },
        });
        const sessions = JSON.parse((list.content as any)[0].text).sessions;
        const s = sessions.find((x: any) => x.sessionId === sid);
        lastObservedStatus = s?.status ?? "not found";
        if (s && terminalStatuses.has(s.status)) {
          reachedTerminal = true;
          break;
        }
      }

      const pollElapsedMs = Date.now() - pollStartedAt;
      if (!reachedTerminal) {
        throw new Error(
          `Session ${sid} did not reach a terminal status within ${pollElapsedMs}ms ` +
            `(last observed status: ${lastObservedStatus})`
        );
      }

      const out = await client.callTool({ name: "get_output", arguments: { session_id: sid } });
      const output = JSON.parse((out.content as any)[0].text);
      expect(output.output.length).toBeGreaterThan(0);
      expect(notifications.length).toBeGreaterThan(0);

      // All notifications must carry required meta fields
      for (const n of notifications) {
        expect(n.meta.session_id).toBe(sid);
        expect(n.meta.event).toBeDefined();
        expect(n.meta.model).toBeDefined();
        expect(n.meta.elapsed_seconds).toBeDefined();
      }

      // At least one "running" event (first output triggers starting → running)
      const events = notifications.map((n: any) => n.meta.event as string);
      expect(events).toContain("running");

      // Last event must be a terminal state
      const lastEvent = events[events.length - 1];
      expect(["completed", "failed"]).toContain(lastEvent);

      // No terminal event before a "running" event
      const firstRunningIdx = events.indexOf("running");
      const firstTerminalIdx = events.findIndex((e: string) => e === "completed" || e === "failed");
      expect(firstTerminalIdx).toBeGreaterThan(firstRunningIdx);
    },
    150_000
  );
});

// ─── Group 1b: Tool group filtering ──────────────────────────────────────────
// Validates that CLAUDISH_MCP_TOOLS env var correctly limits which tools are
// exposed by the MCP server.

describe("Group 1b: MCP Protocol — channel-only tools", () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: "bun",
      args: ["run", SERVER_ENTRY, "--mcp"],
      env: {
        ...process.env,
        CLAUDISH_MCP_TOOLS: "channel",
        CLAUDISH_SESSIONS_DIR: SESSIONS_DIR,
      },
      stderr: "pipe",
    });
    client = new Client({ name: "test-client-channel", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
  }, 15000);

  afterAll(async () => {
    try {
      await transport.close();
    } catch {}
  });

  test("lists only the 5 channel tools when CLAUDISH_MCP_TOOLS=channel", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "cancel_session",
      "create_session",
      "get_output",
      "list_sessions",
      "send_input",
    ]);
  });
});

describe("Group 1b: MCP Protocol — low-level-only tools", () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: "bun",
      args: ["run", SERVER_ENTRY, "--mcp"],
      env: {
        ...process.env,
        CLAUDISH_MCP_TOOLS: "low-level",
        CLAUDISH_SESSIONS_DIR: SESSIONS_DIR,
      },
      stderr: "pipe",
    });
    client = new Client({ name: "test-client-low-level", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
  }, 15000);

  afterAll(async () => {
    try {
      await transport.close();
    } catch {}
  });

  test("lists only the 4 low-level tools when CLAUDISH_MCP_TOOLS=low-level", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["compare_models", "list_models", "run_prompt", "search_models"]);
  });
});

// ─── Group 2: Real Claude Code Integration ───────────────────────────────────
// Spawns `claude -p` with our MCP server registered via --mcp-config.
// Validates that Claude Code sees our tools and can call them.

function hasNonEmptyContent(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasNonEmptyContent);
  if (value && typeof value === "object") {
    return Object.values(value).some(hasNonEmptyContent);
  }
  return value !== undefined && value !== null;
}

/**
 * Run `claude -p` with our MCP server and return stdout.
 */
async function runClaudeWithMcp(
  prompt: string,
  opts?: {
    timeout?: number;
    extraEnv?: Record<string, string>;
    outputFormat?: "text" | "json" | "stream-json";
    bare?: boolean;
  }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const timeout = opts?.timeout ?? 60_000;

  // Create temp MCP config pointing at our server
  const mcpConfig = {
    mcpServers: {
      claudish: {
        command: "bun",
        args: ["run", SERVER_ENTRY, "--mcp"],
        env: {
          CLAUDISH_MCP_TOOLS: "all",
          CLAUDISH_SESSIONS_DIR: SESSIONS_DIR,
          OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "",
        },
      },
    },
  };

  const configPath = join(tmpdir(), `claudish-e2e-mcp-${Date.now()}.json`);
  writeFileSync(configPath, JSON.stringify(mcpConfig), "utf-8");

  try {
    return await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      let stdout = "";
      let stderr = "";
      let done = false;

      const proc = spawn(
        "claude",
        [
          "-p",
          "--mcp-config",
          configPath,
          "--strict-mcp-config",
          "--dangerously-skip-permissions",
          ...(opts?.bare === false ? [] : ["--bare"]),
          ...(opts?.outputFormat ? ["--output-format", opts.outputFormat] : []),
          ...(opts?.outputFormat === "stream-json" ? ["--verbose"] : []),
          prompt,
        ],
        {
          env: { ...process.env, ...opts?.extraEnv },
          stdio: ["pipe", "pipe", "pipe"],
        }
      );
      proc.stdin?.end();

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          proc.kill("SIGTERM");
          resolve({ stdout, stderr, exitCode: -1 });
        }
      }, timeout);

      proc.on("exit", (code) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve({ stdout, stderr, exitCode: code ?? 1 });
        }
      });

      proc.on("error", (err) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve({ stdout, stderr: stderr + err.message, exitCode: 1 });
        }
      });
    });
  } finally {
    try {
      unlinkSync(configPath);
    } catch {}
  }
}

// Check if claude CLI is available AND authenticated for non-interactive use.
// Group 2 spawns real `claude -p`, which needs a working credential (an
// ANTHROPIC_API_KEY, or a claude.ai login that headless mode can use). Merely
// having the binary is not enough: on a machine whose only auth is an
// interactive claude.ai session, `claude -p` prints "Not logged in · Please run
// /login" and exits — so without this gate Group 2 FAILS where it should SKIP.
// The probe runs one tiny headless prompt and treats a login/credential error
// as "not usable".
let claudeUsable = false;
if (!SKIP_LIVE_E2E) {
  try {
    const proc = spawn("claude", ["--version"], { stdio: "pipe" });
    const versionOk = (await new Promise<number>((r) => proc.on("exit", (c) => r(c ?? 1)))) === 0;
    if (versionOk) {
      const probe = spawn("claude", ["-p", "--dangerously-skip-permissions", "--bare", "hi"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      probe.stdout?.on("data", (c: Buffer) => {
        out += c.toString();
      });
      probe.stderr?.on("data", (c: Buffer) => {
        out += c.toString();
      });
      const probeCode = await new Promise<number>((r) => {
        const t = setTimeout(() => {
          probe.kill("SIGTERM");
          r(-1);
        }, 30_000);
        probe.on("exit", (c) => {
          clearTimeout(t);
          r(c ?? 1);
        });
        probe.on("error", () => {
          clearTimeout(t);
          r(1);
        });
      });
      claudeUsable =
        probeCode === 0 && !/not logged in|please run \/login|invalid api key/i.test(out);
    }
  } catch {}
}

if (!claudeUsable) {
  console.warn(
    "[e2e-channel] Group 2 SKIPPED — `claude -p` is unavailable or not authenticated " +
      "(needs ANTHROPIC_API_KEY or a headless-usable claude.ai login)."
  );
}

describe("Group 2: Real Claude Code — MCP tool discovery", () => {
  test.skipIf(!claudeUsable)(
    "claude discovers claudish MCP tools and can call list_models",
    async () => {
      const { stdout, exitCode } = await runClaudeWithMcp(
        "Use the list_models tool from the claudish MCP server and show me the results. Just call the tool and output the result, nothing else.",
        { timeout: 90_000, outputFormat: "stream-json", bare: false }
      );

      expect(exitCode).toBe(0);
      expect(stdout.length).toBeGreaterThan(0);

      const events = stdout
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, any>];
          } catch {
            return [];
          }
        });

      // system/init is a pre-handshake snapshot that races the MCP server's ~2s startup.
      // The linked tool_use/tool_result pair below is deterministic evidence of both
      // discovery and successful invocation.
      const contentBlocks = events.flatMap((event) => {
        const content = event.message?.content;
        return Array.isArray(content) ? content : [];
      });
      const listModelsUse = contentBlocks.find(
        (block) => block.type === "tool_use" && block.name === "mcp__claudish__list_models"
      );

      expect(listModelsUse).toBeDefined();
      expect(listModelsUse.id).toBeDefined();

      const listModelsResult = contentBlocks.find(
        (block) => block.type === "tool_result" && block.tool_use_id === listModelsUse?.id
      );
      expect(listModelsResult).toBeDefined();
      expect(hasNonEmptyContent(listModelsResult?.content)).toBe(true);
    },
    120_000
  );

  test.skipIf(!claudeUsable)(
    "claude discovers channel tools (create_session, list_sessions)",
    async () => {
      const { stdout, exitCode } = await runClaudeWithMcp(
        "Call the list_sessions tool from the claudish MCP server with include_completed=true. Output the raw JSON result.",
        { timeout: 90_000, outputFormat: "stream-json", bare: false }
      );

      expect(exitCode).toBe(0);
      expect(stdout.length).toBeGreaterThan(0);

      const events = stdout
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, any>];
          } catch {
            return [];
          }
        });

      // system/init is a pre-handshake snapshot that races the MCP server's ~2s startup.
      // The linked tool_use/tool_result pair below is deterministic evidence of both
      // discovery and successful invocation.
      const contentBlocks = events.flatMap((event) => {
        const content = event.message?.content;
        return Array.isArray(content) ? content : [];
      });
      const listSessionsUse = contentBlocks.find(
        (block) => block.type === "tool_use" && block.name === "mcp__claudish__list_sessions"
      );

      expect(listSessionsUse).toBeDefined();
      expect(listSessionsUse?.id).toBeDefined();

      const listSessionsResult = contentBlocks.find(
        (block) => block.type === "tool_result" && block.tool_use_id === listSessionsUse?.id
      );
      expect(listSessionsResult).toBeDefined();
      expect(hasNonEmptyContent(listSessionsResult?.content)).toBe(true);
    },
    120_000
  );

  test.skipIf(!claudeUsable || !hasOpenRouterKey)(
    "claude creates a session via create_session tool",
    async () => {
      const { stdout, exitCode } = await runClaudeWithMcp(
        `Use the create_session tool from the claudish MCP server to create a session with model "x-ai/grok-code-fast-1" and prompt "Say exactly: hello e2e test". Then call list_sessions with include_completed=true and show the session status. Finally, wait 15 seconds and call get_output for that session_id. Show me all the raw results.`,
        { timeout: 120_000 }
      );

      expect(exitCode).toBe(0);
      expect(stdout.length).toBeGreaterThan(0);
      // Claude should have created a session and shown the session_id
      expect(stdout).toContain("session_id");
    },
    180_000
  );
});
