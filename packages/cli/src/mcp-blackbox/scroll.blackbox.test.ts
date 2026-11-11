import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CAPABILITIES, CONTRACT_VERSION, type ContractError } from "../pane/contract.js";
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
let layout: TempLayout;
let server: McpServer | undefined;

beforeEach(async () => {
  layout = makeTempLayout("bbscroll");
  server = await McpServer.start({ env: serverEnv(layout), cwd: layout.cwd });
});
afterEach(async () => {
  try {
    await server?.close();
  } finally {
    const report = await paneOrphans(layout);
    try {
      expect(report).toEqual({ processes: [], files: [] });
    } finally {
      layout.cleanup();
      server = undefined;
    }
  }
});

async function call(tool: string, args: Json): Promise<ToolResult> {
  if (!server) throw new Error("server not started");
  return server.callTool(tool, args);
}
function error(result: ToolResult, code: ContractError["error"]["code"]): void {
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.text)).toEqual({
    error: { code, message: expect.any(String) },
  });
  expect((JSON.parse(result.text) as ContractError).error.message.length).toBeGreaterThan(0);
}
async function restart(extra: Record<string, string | undefined>): Promise<void> {
  await server?.close();
  server = await McpServer.start({ env: serverEnv(layout, extra), cwd: layout.cwd });
}

const badRequests: Array<{ name: string; request: Json }> = [
  { name: "neither by nor to", request: {} },
  { name: "both by and to", request: { by: -1, to: "end" } },
  { name: "both zero and to", request: { by: 0, to: "end" } },
  { name: "zero", request: { by: 0 } },
  { name: "negative zero", request: { by: -0 } },
  { name: "fraction", request: { by: 1.5 } },
  { name: "negative fraction", request: { by: -0.5 } },
  { name: "numeric string", request: { by: "-2" } },
  { name: "boolean true", request: { by: true } },
  { name: "boolean false", request: { by: false } },
  { name: "null by", request: { by: null } },
  { name: "array by", request: { by: [-1] } },
  { name: "object by", request: { by: {} } },
  { name: "to top", request: { to: "top" } },
  { name: "to End with wrong case", request: { to: "End" } },
  { name: "empty to", request: { to: "" } },
  { name: "numeric to", request: { to: 1 } },
  { name: "boolean to", request: { to: true } },
  { name: "null to", request: { to: null } },
];

describe("scroll argument validation before owner lookup", () => {
  for (const { name, request } of badRequests) {
    // REQ: 1
    test(`scroll_session rejects ${name} before unknown session lookup`, async () => {
      error(await call("scroll_session", { session_id: "missing", ...request }), "invalid_args");
    });

    // REQ: 2
    test(`team scroll rejects ${name} before unknown run lookup`, async () => {
      error(
        await call("team", {
          mode: "scroll",
          path: join(layout.cwd, "no-run"),
          slot: "01",
          ...request,
        }),
        "invalid_args"
      );
    });
  }

  for (const request of [{ by: -3 }, { by: 3 }, { to: "end" }, { by: 999999 }]) {
    // REQ: 1, 5 (state gate)
    test(`valid ${JSON.stringify(request)} preserves unknown_session`, async () => {
      error(await call("scroll_session", { session_id: "missing", ...request }), "unknown_session");
    });

    // REQ: 2, 5 (state gate)
    test(`valid team ${JSON.stringify(request)} preserves unknown_run`, async () => {
      error(
        await call("team", {
          mode: "scroll",
          path: join(layout.cwd, "no-run"),
          slot: "01",
          ...request,
        }),
        "unknown_run"
      );
    });
  }

  // REQ: 1
  test("scroll_session requires a string session_id", async () => {
    for (const args of [{ by: -1 }, { session_id: 7, by: -1 }, { session_id: null, to: "end" }])
      error(await call("scroll_session", args), "invalid_args");
  });

  // REQ: 2
  test("team scroll requires a string slot before lookup", async () => {
    for (const slot of [undefined, 1, null]) {
      error(
        await call("team", {
          mode: "scroll",
          path: join(layout.cwd, "no-run"),
          by: -1,
          ...(slot === undefined ? {} : { slot }),
        }),
        "invalid_args"
      );
    }
  });

  // REQ: 2
  test("team scroll keeps capture/resize path and run_id validation", async () => {
    for (const args of [
      { slot: "01", by: -1 },
      { path: "/etc", slot: "01", by: -1 },
      { path: join(layout.cwd, "no-run"), slot: "01", run_id: 123, by: -1 },
    ])
      error(await call("team", { mode: "scroll", ...args }), "invalid_args");
  });
});

const expectedCapabilities: Array<(typeof CAPABILITIES)[number]> = [
  "list",
  "status",
  "cancel",
  "capture",
  "capture_since_seq",
  "capture_spans",
  "resize",
  "allowance",
  "scroll",
  "transcript",
  "replay",
  "view",
];
const expectedTools = [
  "allowance_status",
  "cancel_session",
  "capture_session",
  "close_replay",
  "compare_models",
  "create_session",
  "get_diagnostics",
  "get_output",
  "list_models",
  "list_sessions",
  "preflight",
  "replay_session",
  "report_error",
  "resize_session",
  "run_prompt",
  "scroll_session",
  "search_models",
  "send_input",
  "team",
  "transcript_session",
];

describe("scroll additive public contract", () => {
  // REQ: 3
  test("contract v1 appends scroll after all existing capabilities", async () => {
    expect(CONTRACT_VERSION).toBe(1);
    expect([...CAPABILITIES]).toEqual(expectedCapabilities);
    for (const [tool, args] of [
      ["list_sessions", {}],
      ["team", { mode: "list" }],
    ] as const) {
      const result = await call(tool, args);
      expect(result.isError).toBe(false);
      expect(result.json).toMatchObject({
        contract_version: 1,
        capabilities: expectedCapabilities,
      });
    }
  });

  // REQ: 1, 2, 3
  test("default surface has exactly 20 tools and the declared scroll schemas", async () => {
    const tools = await server!.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(expectedTools);
    expect(tools).toHaveLength(20);
    const scrollSchema = tools.find((t) => t.name === "scroll_session")?.inputSchema;
    if (!scrollSchema) throw new Error("scroll_session must declare an inputSchema");
    expect(scrollSchema.required).toEqual(["session_id"]);
    expect(Object.keys(scrollSchema.properties ?? {}).sort()).toEqual(["by", "session_id", "to"]);
    expect(scrollSchema.properties).toMatchObject({
      session_id: { type: "string" },
      by: { type: "integer" },
      to: { type: "string", enum: ["end"] },
    });
    const teamSchema = tools.find((t) => t.name === "team")?.inputSchema;
    if (!teamSchema) throw new Error("team must declare an inputSchema");
    const props = teamSchema.properties as Record<string, Json>;
    expect(props.mode!.enum).toEqual([
      "run",
      "judge",
      "run-and-judge",
      "status",
      "cancel",
      "list",
      "capture",
      "resize",
      "scroll",
      "transcript",
      "replay",
    ]);
    expect(props.by).toMatchObject({ type: "integer" });
    expect(props.to).toMatchObject({ enum: ["end"] });
  });

  // REQ: 3
  test("capture and resize keep their existing argument schemas", async () => {
    const tools = await server!.listTools();
    const captureSchema = tools.find((t) => t.name === "capture_session")?.inputSchema;
    if (!captureSchema) throw new Error("capture_session must declare an inputSchema");
    expect(Object.keys(captureSchema.properties ?? {}).sort()).toEqual([
      "session_id",
      "since_seq",
      "spans",
    ]);
    expect(captureSchema.required).toEqual(["session_id"]);
    const resizeSchema = tools.find((t) => t.name === "resize_session")?.inputSchema;
    if (!resizeSchema) throw new Error("resize_session must declare an inputSchema");
    expect(Object.keys(resizeSchema.properties ?? {}).sort()).toEqual([
      "cols",
      "rows",
      "session_id",
    ]);
    expect([...(resizeSchema.required ?? [])].sort()).toEqual(["cols", "rows", "session_id"]);
  });

  // REQ: 3
  test("session group includes scroll_session with the eight previous tools", async () => {
    await restart({ CLAUDISH_MCP_TOOLS: "session" });
    expect((await server!.listTools()).map((t) => t.name).sort()).toEqual([
      "cancel_session",
      "capture_session",
      "close_replay",
      "create_session",
      "get_diagnostics",
      "get_output",
      "list_sessions",
      "replay_session",
      "resize_session",
      "scroll_session",
      "send_input",
      "transcript_session",
    ]);
  });

  for (const group of ["all", "session", "agentic", "low-level", "debug", undefined]) {
    // REQ: 3
    test(`nested mode does not offer scroll_session (group=${group ?? "unset"})`, async () => {
      await restart({ CLAUDISH_PANE_CHILD: "1", CLAUDISH_MCP_TOOLS: group });
      const names = (await server!.listTools()).map((t) => t.name).sort();
      const expected =
        group === "session" || group === "agentic"
          ? []
          : group === "debug"
            ? ["compare_models"]
            : group === "low-level"
              ? ["list_models", "run_prompt", "search_models"]
              : ["compare_models", "list_models", "run_prompt", "search_models"];
      expect(names).toEqual(expected);
      expect(names).not.toContain("scroll_session");
    });
  }
});
