/**
 * MCP server shutdown leaves nothing behind (architecture D15 layer 3, §20.3 item 8).
 *
 * A real claudish MCP server over stdio holds a live channel session and a live team run,
 * both panes of the pane fake (`@@HANG@@`: the prompt is accepted and never answered) in
 * real headless magmux under the test's own CLAUDISH_PANE_ROOT. Then:
 *
 *   - stdin EOF (the host closed the transport) → the server settles the team run and the
 *     session CANCELLED, so both records end (`meta.json` status `cancelled`, no wait left
 *     open), reaps every pane and exits 0;
 *   - SIGTERM → the same, exit 143;
 *   - SIGKILL → no record ends, but the per-pane watchers remove every process and file.
 *
 * After each: no process whose argv names the pane root, and no socket, record or
 * launcher dir in it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  MAGMUX_AVAILABLE,
  McpServer,
  NO_MAGMUX_MESSAGE,
  findField,
  paneOrphans,
  serverEnv,
} from "./test-helpers/contract-mcp.js";
import {
  type TempLayout,
  makeTempLayout,
  readJson,
  readWaitLines,
  waitFor,
  waitPairingViolations,
} from "./test-helpers/contract-records.js";

const T_TEST = 60_000;

type Json = Record<string, unknown>;

let layout: TempLayout;
let server: McpServer;

if (!MAGMUX_AVAILABLE) console.warn(NO_MAGMUX_MESSAGE);

beforeEach(async () => {
  layout = makeTempLayout("mcpshutdown");
  server = await McpServer.start({
    // the fake's safety exit must not end a @@HANG@@ pane before the shutdown does
    env: serverEnv(layout, { CONTRACT_FAKE_MAX_MS: "60000" }),
    cwd: layout.cwd,
  });
});
afterEach(async () => {
  await server.close(2_000);
  const report = await paneOrphans(layout, 12_000);
  layout.cleanup();
  expect(report).toEqual({ processes: [], files: [] });
});

interface Live {
  sessionId: string;
  monitorRecord: string;
}

/** A RUNNING channel session and an ACTIVE two-slot team run, both hanging. */
async function startWork(): Promise<Live> {
  const created = await server.callTool("create_session", {
    model: "contract-fake-model",
    prompt: "never answer @@HANG@@",
  });
  expect(created.isError).toBe(false);
  const sessionId = (created.json as Json).session_id as string;

  const run = await server.callTool("team", {
    mode: "run",
    path: join(layout.cwd, "team-shutdown"),
    models: ["contract-fake-a", "contract-fake-b"],
    input: "never answer @@HANG@@",
  });
  expect(run.isError).toBe(false);
  const monitorRecord = findField(run.json, "monitor_record") as string;
  expect(typeof monitorRecord).toBe("string");

  await waitFor(
    async () => {
      const list = await server.callTool("list_sessions", {});
      const row = ((list.json as Json).sessions as Json[]).find((s) => s.session_id === sessionId);
      return row?.state === "RUNNING";
    },
    { what: "the session to be RUNNING", timeoutMs: 20_000, intervalMs: 100 }
  );
  const status = await server.callTool("team", {
    mode: "status",
    path: join(layout.cwd, "team-shutdown"),
  });
  const slots = ((status.json as Json).run as Json).slots as Json[];
  expect(slots.map((s) => s.state)).toEqual(["RUNNING", "RUNNING"]);
  return { sessionId, monitorRecord };
}

async function exitCode(ms: number): Promise<number | null> {
  return Promise.race([server.proc.exited, Bun.sleep(ms).then(() => null)]);
}

/** Both records ended `cancelled`, and the session's wait log (if any) is closed. */
function expectRecordsEnded(live: Live): void {
  const sessionDir = join(layout.sessionsDir, live.sessionId);
  const meta = readJson(join(sessionDir, "meta.json"));
  expect(meta?.status).toBe("cancelled");
  expect(meta?.state).toBe("CANCELLED");
  expect(meta?.terminalReason).toBe("cancelled");
  expect(waitPairingViolations(readWaitLines(sessionDir) ?? [], false)).toEqual([]);

  const teamMeta = readJson(join(layout.sessionsDir, live.monitorRecord, "meta.json"));
  expect(teamMeta).toMatchObject({ kind: "team", status: "cancelled", slots: 2, cancelled: 2 });

  const status = readJson(join(layout.cwd, "team-shutdown", "status.json")) as Json;
  for (const m of Object.values(status.models as Record<string, Json>)) {
    expect(m.state).toBe("CANCELLED");
    expect((m.error as Json | undefined)?.reason).toBe("cancelled");
  }
}

describe.skipIf(!MAGMUX_AVAILABLE)("MCP server shutdown", () => {
  test(
    "stdin EOF: records end cancelled, every pane is reaped, exit 0",
    async () => {
      const live = await startWork();

      (server.proc.stdin as { end(): unknown }).end();
      const code = await exitCode(20_000);

      expect(code).toBe(0);
      expectRecordsEnded(live);
      const report = await paneOrphans(layout, 8_000);
      expect(report).toEqual({ processes: [], files: [] });
    },
    T_TEST
  );

  test(
    "SIGTERM: records end cancelled, every pane is reaped, exit 143",
    async () => {
      const live = await startWork();

      server.proc.kill("SIGTERM");
      const code = await exitCode(20_000);

      expect(code).toBe(143);
      expectRecordsEnded(live);
      const report = await paneOrphans(layout, 8_000);
      expect(report).toEqual({ processes: [], files: [] });
    },
    T_TEST
  );

  test(
    "SIGKILL: no record ends, but the pane watchers remove every process and file",
    async () => {
      const live = await startWork();

      server.proc.kill("SIGKILL");
      await exitCode(5_000);

      const report = await paneOrphans(layout, 10_000);
      expect(report).toEqual({ processes: [], files: [] });
      // the writer died: its records have no end (an observer reports from its liveness)
      expect(readJson(join(layout.sessionsDir, live.sessionId, "meta.json"))).toBeUndefined();
      expect(readJson(join(layout.sessionsDir, live.monitorRecord, "meta.json"))).toBeUndefined();
    },
    T_TEST
  );
});
