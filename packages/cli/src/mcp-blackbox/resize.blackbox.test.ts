import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ContractError } from "../pane/contract.js";
import { useBlackboxEnv } from "../test-helpers/blackbox-env.js";
import { McpServer, paneOrphans, serverEnv } from "../test-helpers/contract-mcp.js";
import { type TempLayout, makeTempLayout } from "../test-helpers/contract-records.js";

useBlackboxEnv();

let layout: TempLayout;
let server: McpServer;

beforeEach(async () => {
  layout = makeTempLayout("bbresize");
  server = await McpServer.start({ env: serverEnv(layout), cwd: layout.cwd });
});

afterEach(async () => {
  await server.close();
  const report = await paneOrphans(layout);
  layout.cleanup();
  expect(report).toEqual({ processes: [], files: [] });
});

describe("resize verbs: contract error codes without a pane", () => {
  const cases: Array<{
    name: string;
    tool: string;
    args: Record<string, unknown>;
    code: ContractError["error"]["code"];
  }> = [
    {
      name: "resize_session missing cols",
      tool: "resize_session",
      args: { session_id: "missing", rows: 30 },
      code: "invalid_args",
    },
    {
      name: "resize_session fractional rows",
      tool: "resize_session",
      args: { session_id: "missing", cols: 120, rows: 30.5 },
      code: "invalid_args",
    },
    {
      name: "resize_session string rows",
      tool: "resize_session",
      args: { session_id: "missing", cols: 120, rows: "30" },
      code: "invalid_args",
    },
    {
      name: "resize_session unknown session_id",
      tool: "resize_session",
      args: { session_id: "missing", cols: 120, rows: 30 },
      code: "unknown_session",
    },
    {
      name: "team resize missing slot",
      tool: "team",
      args: { mode: "resize", cols: 120, rows: 30 },
      code: "invalid_args",
    },
    {
      name: "team resize path has no run",
      tool: "team",
      args: { mode: "resize", slot: "01", cols: 120, rows: 30 },
      code: "unknown_run",
    },
  ];

  for (const { name, tool, args, code } of cases) {
    test(name, async () => {
      const result = await server.callTool(tool, {
        ...args,
        ...(tool === "team" ? { path: join(layout.cwd, "no-run") } : {}),
      });
      expect((result.json as unknown as ContractError)?.error?.code).toBe(code);
    });
  }
});
