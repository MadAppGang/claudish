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

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { envDescribe } from "../test-support/env-gate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER_ENTRY = join(__dirname, "../index.ts");

// ─── Group 1: MCP Protocol Tests (SDK Client) ───────────────────────────────
// Validates the MCP server itself works correctly at the protocol level.

describe("Group 1: MCP Protocol — channel capability", () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: "bun",
      args: ["run", SERVER_ENTRY, "--mcp"],
      env: { ...process.env, CLAUDISH_MCP_TOOLS: "all" },
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
  const hasOpenRouterKey = !!process.env.OPENROUTER_API_KEY;

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

      // Poll until done
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const list = await client.callTool({
          name: "list_sessions",
          arguments: { include_completed: true },
        });
        const sessions = JSON.parse((list.content as any)[0].text).sessions;
        const s = sessions.find((x: any) => x.sessionId === sid);
        if (s && ["completed", "failed", "timeout"].includes(s.status)) break;
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
    90000
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
      env: { ...process.env, CLAUDISH_MCP_TOOLS: "channel" },
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
      env: { ...process.env, CLAUDISH_MCP_TOOLS: "low-level" },
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

/**
 * Run `claude -p` with our MCP server and return stdout.
 */
async function runClaudeWithMcp(
  prompt: string,
  opts?: { timeout?: number; extraEnv?: Record<string, string> }
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
          "--bare",
          prompt,
        ],
        {
          env: { ...process.env, ...opts?.extraEnv },
          stdio: ["pipe", "pipe", "pipe"],
        }
      );

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

// Check if claude CLI is available
let claudeAvailable = false;
try {
  const proc = spawn("claude", ["--version"], { stdio: "pipe" });
  const code = await new Promise<number>((r) => {
    proc.on("exit", (c) => r(c ?? 1));
    // A failed spawn (ENOENT — npm-shim installs have no claude.exe for CreateProcess
    // to resolve) emits an async 'error' and never 'exit': without this listener the
    // top-level await hangs forever and takes the whole bounded run down with it.
    proc.on("error", () => r(1));
  });
  claudeAvailable = code === 0;
} catch {}

// Opt-in budget gate (#175 arbitration 06/10): these tests spawn a REAL
// `claude -p` — a full model call on the machine's endpoint — on every
// `bun test` / `test:strict` run that leaves them ungated. Default OFF;
// CLAUDISH_E2E_REAL_CC=1 opts in. (Cause of the hermetic-protocol red,
// measured 07/10: `Not logged in · Please run /login` on stdout — auth fails
// before any model call under a fake HOME; with a real logged-in HOME these
// tests would spend budget on every run.)
const realCcOptIn = process.env.CLAUDISH_E2E_REAL_CC === "1";

envDescribe({
  id: "real-cc-e2e",
  active: realCcOptIn && claudeAvailable,
  // kind "budget": inactive by operator choice when CLAUDISH_E2E_REAL_CC is
  // unset — each run spends real model budget, so strict mode must not
  // mandate it and the manifest footer must not claim a complete machine
  // would run these (#385 review follow-up).
  kind: "budget",
  reason: realCcOptIn
    ? "binaire `claude` introuvable sur PATH"
    : "appel modèle réel — opt-in budget : chaque exécution lance un `claude -p` complet sur l'endpoint de la machine sans demande de l'opérateur",
  activation: realCcOptIn
    ? "installer le binaire `claude` sur PATH"
    : "CLAUDISH_E2E_REAL_CC=1 (avec le binaire `claude` sur PATH et un HOME authentifié)",
}, "Group 2: Real Claude Code — MCP tool discovery")((test) => {
  test(
    "claude discovers claudish MCP tools and can call list_models",
    async () => {
      const { stdout, stderr, exitCode } = await runClaudeWithMcp(
        "Use the list_models tool from the claudish MCP server and show me the results. Just call the tool and output the result, nothing else.",
        { timeout: 90_000 }
      );

      // Diagnostic surface (#175): the helper already returns stderr — print it
      // when the call fails, or the expect below shows only "Expected 0,
      // Received 1" and the cause (auth / endpoint / MCP / model) stays hidden.
      if (exitCode !== 0) {
        console.error(`[RealCC:1] exitCode=${exitCode} stdout=${stdout.slice(0, 1200)} stderr=${stderr.slice(0, 2000)}`);
      }

      // Claude should have called list_models and included model data in output
      expect(exitCode).toBe(0);
      expect(stdout.length).toBeGreaterThan(0);
      // The output should contain model-related content (either model names or "no recommended models")
      const hasModels =
        stdout.includes("Recommended Models") ||
        stdout.includes("recommended models") ||
        stdout.includes("search_models");
      expect(hasModels).toBe(true);
    },
    120_000
  );

  test(
    "claude discovers channel tools (create_session, list_sessions)",
    async () => {
      const { stdout, stderr, exitCode } = await runClaudeWithMcp(
        "Call the list_sessions tool from the claudish MCP server with include_completed=true. Output the raw JSON result.",
        { timeout: 90_000 }
      );

      if (exitCode !== 0) {
        console.error(`[RealCC:2] exitCode=${exitCode} stdout=${stdout.slice(0, 1200)} stderr=${stderr.slice(0, 2000)}`);
      }
      expect(exitCode).toBe(0);
      expect(stdout.length).toBeGreaterThan(0);
      // Claude should have called list_sessions and shown the result
      expect(stdout).toContain("sessions");
    },
    120_000
  );

  const hasOpenRouterKey = !!process.env.OPENROUTER_API_KEY;

  test.skipIf(!hasOpenRouterKey)(
    "claude creates a session via create_session tool",
    async () => {
      const { stdout, stderr, exitCode } = await runClaudeWithMcp(
        `Use the create_session tool from the claudish MCP server to create a session with model "x-ai/grok-code-fast-1" and prompt "Say exactly: hello e2e test". Then call list_sessions with include_completed=true and show the session status. Finally, wait 15 seconds and call get_output for that session_id. Show me all the raw results.`,
        { timeout: 120_000 }
      );

      if (exitCode !== 0) {
        console.error(`[RealCC:3] exitCode=${exitCode} stderr=${stderr.slice(0, 2000)}`);
      }
      expect(exitCode).toBe(0);
      expect(stdout.length).toBeGreaterThan(0);
      // Claude should have created a session and shown the session_id
      expect(stdout).toContain("session_id");
    },
    180_000
  );
});
