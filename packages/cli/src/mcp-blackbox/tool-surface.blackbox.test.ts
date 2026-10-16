/**
 * BLACK-BOX: the MCP tool surface and the text/JSON error forms that need no pane
 * (FR9 A–E, FR11, architecture §4, §4.3). Real claudish MCP server over stdio.
 *
 * Written from spec.md and the frozen mod contract v1 only. No implementation file was read.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
        expect(tools).toHaveLength(14);
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
  test("14 tools, capture_session among them, team modes are exactly the seven", async () => {
    const tools = await server.listTools();
    const names = tools.map((t) => t.name);
    expect(names.length).toBe(14);
    expect(new Set(names).size).toBe(14);
    for (const n of [
      "team",
      "create_session",
      "send_input",
      "get_output",
      "cancel_session",
      "list_sessions",
      "get_diagnostics",
      "capture_session",
    ])
      expect(names).toContain(n);
    // FR8: run_prompt / compare_models are out of scope and stay
    expect(names).toContain("run_prompt");
    expect(names).toContain("compare_models");

    const teamTool = tools.find((t) => t.name === "team");
    const props = (teamTool?.inputSchema?.properties ?? {}) as Record<string, Json>;
    expect(((props.mode as Json).enum as string[]).slice().sort()).toEqual(
      ["run", "judge", "run-and-judge", "status", "cancel", "list", "capture"].sort()
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
