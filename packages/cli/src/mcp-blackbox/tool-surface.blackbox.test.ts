/**
 * BLACK-BOX: the MCP tool surface and the text/JSON error forms that need no pane
 * (FR9 A–E, FR11, architecture §4, §4.3). Real claudish MCP server over stdio.
 *
 * Written from spec.md and the frozen mod contract v1 only. No implementation file was read.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { useBlackboxEnv } from "../test-helpers/blackbox-env.js";
import {
  McpServer,
  type ToolResult,
  paneOrphans,
  serverEnv,
} from "../test-helpers/contract-mcp.js";
import { type TempLayout, makeTempLayout } from "../test-helpers/contract-records.js";

useBlackboxEnv();

type Json = Record<string, unknown>;
const keys = (v: unknown): string[] => Object.keys(v as Json).sort();
const CAPABILITIES = ["list", "status", "cancel", "capture", "capture_since_seq", "capture_spans"];

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
});

function contractError(r: ToolResult, code: string): void {
  expect(r.isError).toBe(true);
  const body = JSON.parse(r.text) as Json;
  expect(keys(body)).toEqual(["error"]);
  expect(keys(body.error)).toEqual(["code", "message"]);
  expect((body.error as Json).code).toBe(code);
  expect(typeof (body.error as Json).message).toBe("string");
}

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

describe("channel: argument errors that need no pane", () => {
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
