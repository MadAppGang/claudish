/**
 * E2E tests for session tools using real Claude Code.
 *
 * Spawns `claude -p` with `--mcp-config` pointing at our MCP server and
 * validates the full flow: Claude Code connects to our server, discovers
 * tools, calls them, and polls session output.
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
import { test as lifecycleTest } from "node:test";
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

const NO_RECOMMENDED_MODEL = "No currently recommended chat model was returned by list_models";

async function pickRecommendedSessionModel(client: Client) {
  const result = await client.callTool({ name: "list_models", arguments: {} });
  if (result.isError) return null;
  const text = (result.content as Array<{ text?: string }>)
    .map((part) => part.text ?? "")
    .join("\n");
  const models: Array<{ model: string; rank: number; price: number }> = [];
  let rank = 2;
  for (const line of text.split("\n")) {
    const section = /^## (.+)$/.exec(line);
    if (section) rank = section[1] === "Lightweight" ? 0 : section[1] === "Cost-efficient" ? 1 : 2;
    const model = /^### (\S+)\s*$/.exec(line);
    if (model) models.push({ model: model[1], rank, price: Number.POSITIVE_INFINITY });
    const price = /^- \*\*Pricing\*\*: \$([\d.]+)\/1M/.exec(line);
    if (price && models.length) models[models.length - 1].price = Number(price[1]);
  }
  // Every model heading in list_models is a recommended chat model; quick picks
  // and the effort table are not model headings. Prefer the cheaper row within a tier.
  const selected = models.sort((a, b) => a.rank - b.rank || a.price - b.price)[0];
  if (!selected) return null;
  const rows = text
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim())
    );
  const headers = rows.find((row) => row[0] === "model");
  const efforts = rows.find((row) => row[0] === selected.model);
  const effort = efforts?.[headers?.indexOf("quick_edit") ?? -1];
  return { model: selected.model, ...(effort && effort !== "-" ? { effort } : {}) };
}

// ─── Group 1: MCP Protocol Tests (SDK Client) ───────────────────────────────
// Validates the MCP server itself works correctly at the protocol level.

describe("Group 1: MCP Protocol — session tools", () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: "bun",
      args: ["--no-env-file", "run", SERVER_ENTRY, "--mcp"],
      env: Object.fromEntries(
        Object.entries({
          ...process.env,
          CLAUDISH_PANE_CHILD: undefined,
          CLAUDISH_MCP_TOOLS: "all",
          CLAUDISH_SESSIONS_DIR: SESSIONS_DIR,
          // create_session children would otherwise resolve the installed binary through PATH.
          CLAUDISH_BIN: SERVER_ENTRY,
        }).filter((entry): entry is [string, string] => entry[1] !== undefined)
      ),
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

  test("does not declare an experimental capability", () => {
    const caps = client.getServerCapabilities();
    expect(caps).toHaveProperty("tools");
    expect(caps).not.toHaveProperty("experimental");
  });

  test("provides polling instructions without channel or notification docs", () => {
    const instructions = client.getInstructions();
    expect(instructions).toContain("list_sessions");
    expect(instructions).toContain("get_output");
    expect(instructions).not.toContain("<channel");
    expect(instructions).not.toContain("notification");
  });

  test("lists the exact public tool list", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "allowance_status",
      "cancel_session",
      "capture_session",
      "compare_models",
      "create_session",
      "get_diagnostics",
      "get_output",
      "list_models",
      "list_sessions",
      "preflight",
      "report_error",
      "resize_session",
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
    // CA-12: the answer says which contract it speaks.
    expect(parsed.contract_version).toBe(1);
  });

  test("send_input returns false for non-existent session", async () => {
    const result = await client.callTool({
      name: "send_input",
      arguments: { session_id: "bad", text: "hi" },
    });
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.reason).toBe("unknown_session");
  });

  test("get_output errors for non-existent session", async () => {
    const result = await client.callTool({ name: "get_output", arguments: { session_id: "bad" } });
    expect(result.isError).toBe(true);
  });

  test("cancel_session answers unknown_session for a non-existent session", async () => {
    // A §8 verb: errors are a JSON ContractError with isError (was `{success:false}`).
    const result = await client.callTool({
      name: "cancel_session",
      arguments: { session_id: "bad" },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? "");
    expect(parsed.error.code).toBe("unknown_session");
  });

  test("capture_session answers unknown_session for a non-existent session", async () => {
    const result = await client.callTool({
      name: "capture_session",
      arguments: { session_id: "bad" },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? "");
    expect(parsed.error.code).toBe("unknown_session");
  });

  test("unknown tool returns isError", async () => {
    const result = await client.callTool({ name: "no_such_tool", arguments: {} });
    expect(result.isError).toBe(true);
  });

  // Live session test via SDK client

  lifecycleTest(
    "create_session → poll → get_output lifecycle",
    { skip: !hasOpenRouterKey, timeout: 150_000 },
    async (t) => {
      const selected = await pickRecommendedSessionModel(client);
      if (!selected) {
        console.warn(`[e2e-sessions] SKIPPED — ${NO_RECOMMENDED_MODEL}`);
        t.skip(NO_RECOMMENDED_MODEL);
        return;
      }
      const args = {
        ...selected,
        prompt: "Say exactly: hello world",
        timeout_seconds: 30,
      };
      console.info("[e2e-sessions] lifecycle pick from list_models:", selected);
      let res = await client.callTool({ name: "create_session", arguments: args });
      const textOf = (answer: typeof res) =>
        (answer.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n");
      if (res.isError && textOf(res).startsWith("needs_effort:")) {
        const recommendations = JSON.parse(textOf(res).split("Recommended levels: ")[1]) as Record<
          string,
          Record<string, string>
        >;
        const levels = recommendations[selected.model];
        const effort = levels?.quick_edit ?? Object.values(levels ?? {})[0];
        if (effort)
          res = await client.callTool({
            name: "create_session",
            arguments: { ...args, effort },
          });
      }
      if (res.isError) throw new Error(textOf(res));
      const { session_id: sid } = JSON.parse((res.content as any)[0].text);
      expect(sid).toBeDefined();

      // Poll until the session reaches a terminal state. Use a wall-clock
      // budget so scheduler contention cannot turn a slow session into a
      // misleading empty-output failure.
      const terminalStatuses = new Set(["COMPLETED", "FAILED", "TIMEOUT", "EMPTY"]);
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
        const s = sessions.find((x: any) => x.session_id === sid);
        lastObservedStatus = s?.state ?? "not found";
        if (s && terminalStatuses.has(s.state)) {
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
    }
  );
});

// ─── Group 1b: Tool group filtering ──────────────────────────────────────────
// Validates that CLAUDISH_MCP_TOOLS env var correctly limits which tools are
// exposed by the MCP server.

describe("Group 1b: MCP Protocol — session-only tools", () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: "bun",
      args: ["--no-env-file", "run", SERVER_ENTRY, "--mcp"],
      env: Object.fromEntries(
        Object.entries({
          ...process.env,
          CLAUDISH_PANE_CHILD: undefined,
          CLAUDISH_MCP_TOOLS: "session",
          CLAUDISH_SESSIONS_DIR: SESSIONS_DIR,
        }).filter((entry): entry is [string, string] => entry[1] !== undefined)
      ),
      stderr: "pipe",
    });
    client = new Client({ name: "test-client-session", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
  }, 15000);

  afterAll(async () => {
    try {
      await transport.close();
    } catch {}
  });

  test("lists only the 8 session tools when CLAUDISH_MCP_TOOLS=session", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "cancel_session",
      "capture_session",
      "create_session",
      "get_diagnostics",
      "get_output",
      "list_sessions",
      "resize_session",
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
      args: ["--no-env-file", "run", SERVER_ENTRY, "--mcp"],
      env: Object.fromEntries(
        Object.entries({
          ...process.env,
          CLAUDISH_PANE_CHILD: undefined,
          CLAUDISH_MCP_TOOLS: "low-level",
          CLAUDISH_SESSIONS_DIR: SESSIONS_DIR,
        }).filter((entry): entry is [string, string] => entry[1] !== undefined)
      ),
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

  test("lists only the 3 low-level tools when CLAUDISH_MCP_TOOLS=low-level", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["list_models", "run_prompt", "search_models"]);
  });
});

for (const [toolMode, expected] of [
  [
    "channel",
    [
      "allowance_status",
      "cancel_session",
      "capture_session",
      "compare_models",
      "create_session",
      "get_diagnostics",
      "get_output",
      "list_models",
      "list_sessions",
      "preflight",
      "report_error",
      "resize_session",
      "run_prompt",
      "search_models",
      "send_input",
      "team",
    ],
  ],
  ["debug", ["compare_models"]],
] as const) {
  describe(`Group 1b: MCP Protocol — CLAUDISH_MCP_TOOLS=${toolMode}`, () => {
    let client: Client;
    let transport: StdioClientTransport;

    beforeAll(async () => {
      transport = new StdioClientTransport({
        command: "bun",
        args: ["--no-env-file", "run", SERVER_ENTRY, "--mcp"],
        env: Object.fromEntries(
          Object.entries({
            ...process.env,
            CLAUDISH_PANE_CHILD: undefined,
            CLAUDISH_MCP_TOOLS: toolMode,
            CLAUDISH_SESSIONS_DIR: SESSIONS_DIR,
          }).filter((entry): entry is [string, string] => entry[1] !== undefined)
        ),
        stderr: "pipe",
      });
      client = new Client(
        { name: `test-client-${toolMode}`, version: "1.0.0" },
        { capabilities: {} }
      );
      await client.connect(transport);
    }, 15000);

    afterAll(async () => {
      try {
        await transport.close();
      } catch {}
    });

    test(`lists the exact tools for CLAUDISH_MCP_TOOLS=${toolMode}`, async () => {
      const result = await client.listTools();
      expect(result.tools.map((tool) => tool.name).sort()).toEqual([...expected]);
    });
  });
}

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
        args: ["--no-env-file", "run", SERVER_ENTRY, "--mcp"],
        env: {
          CLAUDISH_MCP_TOOLS: "all",
          CLAUDISH_SESSIONS_DIR: SESSIONS_DIR,
          OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "",
          // create_session children would otherwise resolve the installed binary through PATH.
          CLAUDISH_BIN: SERVER_ENTRY,
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
          env: { ...process.env, ...opts?.extraEnv, CLAUDISH_PANE_CHILD: undefined },
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
    const proc = spawn("claude", ["--version"], { env: { ...process.env }, stdio: "pipe" });
    const versionOk = (await new Promise<number>((r) => proc.on("exit", (c) => r(c ?? 1)))) === 0;
    if (versionOk) {
      const probe = spawn("claude", ["-p", "--dangerously-skip-permissions", "--bare", "hi"], {
        env: { ...process.env },
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
    "[e2e-sessions] Group 2 SKIPPED — `claude -p` is unavailable or not authenticated " +
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
    "claude discovers session tools (create_session, list_sessions)",
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
