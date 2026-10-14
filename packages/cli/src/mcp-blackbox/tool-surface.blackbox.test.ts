/**
 * BLACK-BOX: the MCP tool surface and the text/JSON error forms that need no pane
 * (FR9 A–E, FR11, architecture §4, §4.3). Real claudish MCP server over stdio.
 *
 * Written from spec.md and the frozen mod contract v1 only. No implementation file was read.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { version as packageVersion } from "../../package.json";
import { useBlackboxEnv } from "../test-helpers/blackbox-env.js";
import {
  McpServer,
  SERVER_ENTRY,
  type ToolResult,
  paneOrphans,
  serverEnv,
} from "../test-helpers/contract-mcp.js";
import { type TempLayout, makeTempLayout } from "../test-helpers/contract-records.js";

useBlackboxEnv();

type Json = Record<string, unknown>;
const keys = (v: unknown): string[] => Object.keys(v as Json).sort();
const CAPABILITIES = ["list", "status", "cancel", "capture", "capture_since_seq", "capture_spans"];

// REQ-15: literal sorted sets from architecture-contracts.md, not from implementation.
const ALL_TOOLS = [
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
];
const SESSION_TOOLS = [
  "cancel_session",
  "capture_session",
  "create_session",
  "get_diagnostics",
  "get_output",
  "list_sessions",
  "resize_session",
  "send_input",
];
const TOOL_GROUPS: Array<{ value: string | undefined; names: string[] }> = [
  { value: undefined, names: ALL_TOOLS },
  { value: "all", names: ALL_TOOLS },
  { value: "low-level", names: ["list_models", "run_prompt", "search_models"] },
  { value: "agentic", names: ["preflight", "report_error", "team"] },
  { value: "session", names: SESSION_TOOLS },
  { value: "debug", names: ["compare_models"] },
  // Removed spelling is not a session alias: unrecognized values fall back to all.
  { value: "channel", names: ALL_TOOLS },
];

let layout: TempLayout;
let server: McpServer;

function useStandardServer(): void {
  beforeEach(async () => {
    layout = makeTempLayout("bbsurface");
    server = await McpServer.start({ env: serverEnv(layout), cwd: layout.cwd });
  });

  afterEach(async () => {
    await server.close();
    const report = await paneOrphans(layout);
    layout.cleanup();
    expect(report).toEqual({ processes: [], files: [] });
    // REQ-19: none of these public calls may emit the removed push notification.
    expect(server.notifications.filter((n) => n.method === "notifications/claude/channel")).toEqual(
      []
    );
  });
}

function contractError(r: ToolResult, code: string): void {
  expect(r.isError).toBe(true);
  const body = JSON.parse(r.text) as Json;
  expect(keys(body)).toEqual(["error"]);
  expect(keys(body.error)).toEqual(["code", "message"]);
  expect((body.error as Json).code).toBe(code);
  expect(typeof (body.error as Json).message).toBe("string");
}

/** Capture the first initialize response on a fresh public stdio connection.
 * McpServer.start deliberately discards it; sending initialize twice would test
 * an unsupported MCP lifecycle rather than the contract's initialization.
 */
async function initializeOnce(env: Record<string, string>): Promise<Json> {
  const child = Bun.spawn([process.execPath, SERVER_ENTRY, "--mcp"], {
    env,
    cwd: layout.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  let buffer = "";
  try {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "quick-prompt-blackbox", version: "0.0.0" },
        },
      })}\n`
    );
    child.stdin.flush();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`MCP initialize ended without a response: ${await stderr}`);
      buffer += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("{")) continue;
        const message = JSON.parse(line) as Json;
        if (message.id !== 1) continue;
        expect(message.error).toBeUndefined();
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`
        );
        child.stdin.flush();
        return message.result as Json;
      }
    }
  } finally {
    reader.releaseLock();
    child.stdin.end();
    const ended = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(3_000).then(() => false),
    ]);
    if (!ended) child.kill("SIGKILL");
    await child.exited;
    clearTimeout(timer);
    await stderr;
  }
}

describe("quick-prompt public surface", () => {
  useStandardServer();
  for (const { value, names } of TOOL_GROUPS) {
    test(`REQ-15 REQ-18: CLAUDISH_MCP_TOOLS=${value ?? "unset"} exposes the exact sorted set and polling-only initialization`, async () => {
      if (value !== undefined) {
        await server.close();
        server = await McpServer.start({
          env: serverEnv(layout, { CLAUDISH_MCP_TOOLS: value }),
          cwd: layout.cwd,
        });
      }
      const tools = await server.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(names);

      const result = await initializeOnce(serverEnv(layout, { CLAUDISH_MCP_TOOLS: value }));
      expect(result.serverInfo).toEqual({ name: "claudish", version: packageVersion });
      const capabilities = result.capabilities as Json;
      expect(Object.hasOwn(capabilities, "tools")).toBe(true);
      expect(capabilities.experimental).toBeUndefined();
      expect(Object.hasOwn(capabilities, "experimental")).toBe(false);
      expect(typeof result.instructions).toBe("string");
      const instructions = result.instructions as string;
      expect(instructions).toContain("list_sessions");
      expect(instructions).toContain("get_output");
      expect(instructions).not.toContain("<channel");
      expect(instructions.toLowerCase()).not.toContain("notification");
    }, 30_000);
  }

  test("REQ-16 REQ-17: quick-prompt schemas omit output limits and descriptions distinguish prompts from sessions/debug", async () => {
    const tools = await server.listTools();
    const prompt = tools.find((tool) => tool.name === "run_prompt");
    const compare = tools.find((tool) => tool.name === "compare_models");
    expect(prompt).toBeDefined();
    expect(compare).toBeDefined();
    expect(Object.keys(prompt?.inputSchema?.properties ?? {}).sort()).toEqual([
      "model",
      "prompt",
      "system_prompt",
    ]);
    expect(prompt?.inputSchema?.required).toEqual(["model", "prompt"]);
    expect(prompt?.inputSchema?.properties).not.toHaveProperty("max_tokens");
    expect(Object.keys(compare?.inputSchema?.properties ?? {}).sort()).toEqual([
      "models",
      "prompt",
      "system_prompt",
    ]);
    expect(compare?.inputSchema?.required).toEqual(["models", "prompt"]);
    expect(compare?.inputSchema?.properties).not.toHaveProperty("max_tokens");
    const promptDescription = (prompt as unknown as { description: string }).description;
    const compareDescription = (compare as unknown as { description: string }).description;
    expect(promptDescription.startsWith("One quick prompt, straight to one model's API")).toBe(
      true
    );
    expect(promptDescription).toContain("create_session");
    expect(promptDescription).toContain("team");
    expect(compareDescription.startsWith("DEBUG.")).toBe(true);
  }, 30_000);
});

describe("CLAUDISH_MCP_TOOLS startup warnings", () => {
  useStandardServer();
  for (const value of ["channel", "lowlevel", undefined, "all", "session", "debug"]) {
    test(`${value ?? "unset"}: warns exactly once only for an unknown value`, async () => {
      if (value !== undefined) {
        await server.close();
        server = await McpServer.start({
          env: serverEnv(layout, { CLAUDISH_MCP_TOOLS: value }),
          cwd: layout.cwd,
        });
      }
      const tools = await server.listTools();
      await server.close();
      const warnings = server.stderrText
        .split(/\r?\n/)
        .filter((line) => line.includes("CLAUDISH_MCP_TOOLS"));
      if (value === "channel" || value === "lowlevel") {
        expect(tools.map((tool) => tool.name).sort()).toEqual(ALL_TOOLS);
        expect(tools).toHaveLength(15);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(value);
        expect(warnings[0]).toContain("all, low-level, agentic, session, debug");
        if (value === "channel") {
          expect(warnings[0]).toContain("renamed to");
          expect(warnings[0]).toContain("session");
        }
      } else {
        expect(warnings).toEqual([]);
      }
    }, 30_000);
  }
});

// REQ-20 (TEST-21–TEST-26): preserve the existing pane-free session/team regressions.
describe("tool list (FR11, §4)", () => {
  useStandardServer();
  test("15 tools, resize_session among them, team modes are exactly the eight", async () => {
    const tools = await server.listTools();
    const names = tools.map((t) => t.name);
    expect(names.length).toBe(15);
    expect(new Set(names).size).toBe(15);
    for (const n of [
      "team",
      "create_session",
      "send_input",
      "get_output",
      "cancel_session",
      "list_sessions",
      "get_diagnostics",
      "capture_session",
      "resize_session",
    ])
      expect(names).toContain(n);
    // FR8: run_prompt / compare_models are out of scope and stay
    expect(names).toContain("run_prompt");
    expect(names).toContain("compare_models");

    const teamTool = tools.find((t) => t.name === "team");
    const props = (teamTool?.inputSchema?.properties ?? {}) as Record<string, Json>;
    expect(((props.mode as Json).enum as string[]).slice().sort()).toEqual(
      ["run", "judge", "run-and-judge", "status", "cancel", "list", "capture", "resize"].sort()
    );
    expect(teamTool?.inputSchema?.required).toEqual(["mode"]);
    for (const p of [
      "since_seq",
      "spans",
      "run_id",
      "slot",
      "path",
      "require_pattern",
      "min_output_bytes",
    ])
      expect(Object.keys(props)).toContain(p);

    const cap = tools.find((t) => t.name === "capture_session");
    const capProps = Object.keys(cap?.inputSchema?.properties ?? {}).sort();
    expect(capProps).toEqual(["session_id", "since_seq", "spans"]);
    expect(cap?.inputSchema?.required).toEqual(["session_id"]);
  });
});

describe("team: mode and argument errors", () => {
  useStandardServer();
  test("an unknown team mode answers the text `Error: Unknown mode: <mode>`", async () => {
    const r = await server.callTool("team", { mode: "bogus-mode", path: join(layout.cwd, "x") });
    expect(r.isError).toBe(true);
    expect(r.text.startsWith("Error: Unknown mode: bogus-mode")).toBe(true);
  });

  test("list needs no path and answers an empty run list with contract meta on a fresh server", async () => {
    const r = await server.callTool("team", { mode: "list" });
    expect(r.isError).toBe(false);
    const body = r.json as Json;
    expect(keys(body)).toEqual(["capabilities", "contract_version", "runs"]);
    expect(body.contract_version).toBe(1);
    expect(body.capabilities).toEqual(CAPABILITIES);
    expect(body.runs).toEqual([]);
  });

  test("§8 team verbs answer bad arguments with an invalid_args ContractError", async () => {
    const path = join(layout.cwd, "none");
    // path is required by every mode except list
    contractError(await server.callTool("team", { mode: "cancel", slot: "01" }), "invalid_args");
    contractError(
      await server.callTool("team", { mode: "capture", slot: "01", run_id: "a-1-abcdef" }),
      "invalid_args"
    );
    // a path outside the working directory
    contractError(await server.callTool("team", { mode: "cancel", path: "/etc" }), "invalid_args");
    contractError(
      await server.callTool("team", { mode: "capture", path: "/etc", slot: "01" }),
      "invalid_args"
    );
    // wrongly typed arguments
    contractError(
      await server.callTool("team", { mode: "status", path, run_id: 12345 }),
      "invalid_args"
    );
    // unknown run at a valid path
    contractError(await server.callTool("team", { mode: "status", path }), "unknown_run");
    contractError(
      await server.callTool("team", { mode: "cancel", path, slot: "01" }),
      "unknown_run"
    );
    // spans is a boolean (§4.1); a string is the caller's error, refused before the lookup
    // the same way a string since_seq is
    contractError(
      await server.callTool("team", { mode: "capture", path, slot: "01", spans: "yes" }),
      "invalid_args"
    );
  });

  test("spawning modes keep their text `Error:` form for bad input (§4.3) and start nothing", async () => {
    const path = join(layout.cwd, "spawn-errors");
    // `input` and `input_file` together: "Passing both is an error"
    const both = await server.callTool("team", {
      mode: "run",
      path,
      models: ["fake-answer"],
      input: "x",
      input_file: "input.md",
    });
    expect(both.isError).toBe(true);
    expect(both.text.startsWith("Error")).toBe(true);
    expect(() => JSON.parse(both.text)).toThrow();
    // `run` without models
    const noModels = await server.callTool("team", { mode: "run", path, input: "x" });
    expect(noModels.isError).toBe(true);
    expect(noModels.text.startsWith("Error")).toBe(true);
    // a print-mode flag is refused (the pane is interactive)
    const printFlag = await server.callTool("team", {
      mode: "run",
      path,
      models: ["fake-answer"],
      input: "x",
      claude_flags: "-p",
    });
    expect(printFlag.isError).toBe(true);
    expect(printFlag.text.startsWith("Error")).toBe(true);
    const list = await server.callTool("team", { mode: "list" });
    expect((list.json as Json).runs).toEqual([]);
    expect(existsSync(join(path, "status.json"))).toBe(false);
  });
});

describe("session: argument errors that need no pane", () => {
  useStandardServer();
  test("create_session refuses a print-mode flag with text `Error: invalid_args:`", async () => {
    const r = await server.callTool("create_session", {
      model: "contract-fake-model",
      claude_flags: "--output-format stream-json",
    });
    expect(r.isError).toBe(true);
    expect(r.text.startsWith("Error: invalid_args:")).toBe(true);
    const list = await server.callTool("list_sessions", { include_completed: true });
    expect((list.json as Json).sessions).toEqual([]);
  });
});

describe("nested MCP server over stdio", () => {
  let layout: TempLayout;
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let stderr: string;

  beforeEach(() => {
    layout = makeTempLayout("nested-surface");
    client = undefined;
    transport = undefined;
    stderr = "";
  });

  afterEach(async () => {
    try {
      if (client) await client.close();
    } finally {
      try {
        await transport?.close();
      } finally {
        const report = await paneOrphans(layout);
        layout.cleanup();
        expect(report).toEqual({ processes: [], files: [] });
      }
    }
  }, 30_000);

  async function connect(mode: string | undefined, nested = true): Promise<Client> {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", SERVER_ENTRY, "--mcp"],
      cwd: layout.cwd,
      env: serverEnv(layout, {
        CLAUDISH_PANE_CHILD: nested ? "1" : undefined,
        CLAUDISH_MCP_TOOLS: mode,
      }),
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    client = new Client({ name: "nested-surface-tests", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    return client;
  }

  async function waitForStartup(): Promise<void> {
    // stderr and stdout are separate pipes: wait for the startup line to be drained.
    const deadline = Date.now() + 2000;
    while (!stderr.includes("MCP server started") && Date.now() < deadline) await Bun.sleep(10);
    expect(stderr).toContain("MCP server started");
  }

  const fourTools = ["compare_models", "list_models", "run_prompt", "search_models"];
  const removedTools = [
    "team",
    "create_session",
    "send_input",
    "get_output",
    "cancel_session",
    "list_sessions",
    "get_diagnostics",
    "capture_session",
    "resize_session",
    "preflight",
    "report_error",
  ];

  test("T-MCP-1: all exposes exactly four nested tools and logs the nested startup line", async () => {
    const c = await connect("all");
    const names = (await c.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual(fourTools);
    for (const name of removedTools) expect(names).not.toContain(name);
    await waitForStartup();
    expect(stderr.split(/\r?\n/)).toContain(
      "[claudish] MCP server started (tools: nested, 4 tools)"
    );
  }, 30_000);

  for (const [mode, expected] of [
    ["channel", fourTools],
    ["low-level", ["list_models", "run_prompt", "search_models"]],
    ["agentic", []],
    ["session", []],
    ["debug", ["compare_models"]],
    ["all", fourTools],
    [undefined, fourTools],
  ] as const) {
    test(`T-MCP-2: ${mode ?? "unset"} intersects its tool group with nested tools`, async () => {
      const c = await connect(mode);
      expect((await c.listTools()).tools.map((tool) => tool.name).sort()).toEqual([...expected]);
      expect(c.getServerCapabilities()).toHaveProperty("tools");
      expect(c.getServerCapabilities()).not.toHaveProperty("experimental");
      expect(c.getInstructions()).toContain("## Nested mode — no sessions");
      expect(c.getInstructions()).not.toContain("Channel Mode");
      await waitForStartup();
      expect(stderr.split(/\r?\n/)).toContain(
        `[claudish] MCP server started (tools: nested, ${expected.length} tools)`
      );
      const warnings = stderr.split(/\r?\n/).filter((line) => line.includes("CLAUDISH_MCP_TOOLS"));
      if (mode === "channel") {
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("channel");
        expect(warnings[0]).toContain("renamed to");
        expect(warnings[0]).toContain("all, low-level, agentic, session, debug");
      } else {
        expect(warnings).toEqual([]);
      }
    }, 30_000);
  }

  test("T-MCP-3: initialize advertises tools without channels and gives nested instructions", async () => {
    const c = await connect("all");
    expect(c.getServerCapabilities()).toHaveProperty("tools");
    expect(c.getServerCapabilities()).not.toHaveProperty("experimental");
    const instructions = c.getInstructions();
    const { NESTED_INSTRUCTIONS } = await import("../mcp/nested-mode.js");
    expect(instructions).toBe(NESTED_INSTRUCTIONS);
    expect(
      instructions?.startsWith(
        "Claudish MCP server provides access to external AI models for one-shot calls."
      )
    ).toBe(true);
    expect(instructions).toContain("## Nested mode — no sessions");
    expect(instructions).toContain("nested session refused");
    expect(instructions).toContain(
      "You are the delegate: do the task with your own tools; a workflow step that says to delegate is satisfied by you running it."
    );
    expect(instructions).not.toContain("Channel Mode");
    expect(instructions).not.toMatch(/^- (?:preflight|report_error):/m);
  }, 30_000);

  test("T-MCP-4: removed session tools answer Unknown tool and leave no panes", async () => {
    const c = await connect("all");
    for (const name of ["create_session", "team"]) {
      const result = await c.callTool({ name, arguments: { model: "x", prompt: "y" } });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: `Error: Unknown tool "${name}"` }]);
    }
    expect(await paneOrphans(layout)).toEqual({ processes: [], files: [] });
  }, 30_000);

  test("T-MCP-5: without the flag all still exposes 15 tools without an experimental capability", async () => {
    const c = await connect("all", false);
    const tools = (await c.listTools()).tools;
    expect(tools).toHaveLength(15);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(15);
    expect(c.getServerCapabilities()).toHaveProperty("tools");
    expect(c.getServerCapabilities()).not.toHaveProperty("experimental");
    expect(c.getInstructions()).not.toContain("## Nested mode — no sessions");
  }, 30_000);
});
