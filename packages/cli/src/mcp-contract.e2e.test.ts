/**
 * The mod contract v1 (architecture §8, §12.3) through the REAL MCP server over JSON-RPC,
 * every child the pane fake (marker mode) in a real headless magmux under the test's own
 * CLAUDISH_PANE_ROOT.
 *
 * What is pinned: the EXACT key set of every §8 shape (`Object.keys(x).sort()` equality —
 * a key added or dropped by accident fails here, a deliberate one is added here and to
 * pane/contract.ts together), `contract_version: 1` and the exact `capabilities`, state
 * values inside the closed set, cancel idempotency, `unchanged` captures while idle, and
 * the JSON `ContractError` envelope (`isError: true`) on the error path of every §8 verb.
 *
 * The team directory is inside the server's cwd, so `validateSessionPath` accepts it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CAPABILITIES, SLOT_STATES } from "./pane/contract.js";
import {
  MAGMUX_AVAILABLE,
  McpServer,
  NO_MAGMUX_MESSAGE,
  type ToolResult,
  paneOrphans,
  serverEnv,
} from "./test-helpers/contract-mcp.js";
import { type TempLayout, makeTempLayout, waitFor } from "./test-helpers/contract-records.js";

const T_TEST = 60_000;

type Json = Record<string, unknown>;

const keys = (v: unknown): string[] => Object.keys(v as Json).sort();

const SLOT_ROW_KEYS = [
  "activity",
  "cost_usd",
  "idle_seconds",
  "last_activity_at",
  "model",
  "pane",
  "provider",
  "reason",
  "slot",
  "state",
  "tokens_in",
  "tokens_out",
  "tool_calls",
  "turns_completed",
].sort();
const SESSION_ROW_KEYS = [
  ...SLOT_ROW_KEYS,
  "completed_at",
  "elapsed_seconds",
  "session_id",
  "started_at",
].sort();
const TEAM_RUN_ROW_KEYS = [
  "finished_at",
  "kind",
  "outcome",
  "path",
  "run_id",
  "slots",
  "started_at",
  "state",
].sort();
const CAPTURE_KEYS = ["cols", "cursor", "final", "lines", "rows", "seq"].sort();
const CAPTURE_SPANS_KEYS = [...CAPTURE_KEYS, "spans"].sort();
const UNCHANGED_KEYS = ["final", "seq", "unchanged"];
const TEAM_CANCEL_KEYS = ["path", "results", "run_id"];
const TEAM_CANCEL_ENTRY_KEYS = ["changed", "slot", "state"];
const SESSION_CANCEL_KEYS = ["changed", "session_id", "state"];

let layout: TempLayout;
let server: McpServer;

if (!MAGMUX_AVAILABLE) console.warn(NO_MAGMUX_MESSAGE);

beforeEach(async () => {
  layout = makeTempLayout("mcpcontract");
  server = await McpServer.start({
    // the fake's safety exit must not end a @@HANG@@ slot mid-test
    env: serverEnv(layout, { CONTRACT_FAKE_MAX_MS: "60000" }),
    cwd: layout.cwd,
  });
});
afterEach(async () => {
  await server.close();
  const report = await paneOrphans(layout);
  layout.cleanup();
  expect(report).toEqual({ processes: [], files: [] });
});

function ok(r: ToolResult): Json {
  expect(r.isError).toBe(false);
  expect(r.json).toBeDefined();
  return r.json as Json;
}

function contractError(r: ToolResult, code: string): void {
  expect(r.isError).toBe(true);
  const body = JSON.parse(r.text) as Json;
  expect(keys(body)).toEqual(["error"]);
  expect(keys(body.error)).toEqual(["code", "message"]);
  expect((body.error as Json).code).toBe(code);
  expect(typeof (body.error as Json).message).toBe("string");
}

function expectContractMeta(body: Json): void {
  expect(body.contract_version).toBe(1);
  expect(body.capabilities).toEqual([...CAPABILITIES]);
}

function expectSlotRow(row: Json, extended: string[] = SLOT_ROW_KEYS): void {
  expect(keys(row)).toEqual(extended);
  expect(SLOT_STATES).toContain(row.state as never);
}

function expectRunRow(run: Json): void {
  expect(keys(run)).toEqual(TEAM_RUN_ROW_KEYS);
  expect(["ACTIVE", "SETTLED"]).toContain(run.state as string);
  for (const s of run.slots as Json[]) expectSlotRow(s);
}

function team(args: Json): Promise<ToolResult> {
  return server.callTool("team", args);
}

async function sessionRow(id: string): Promise<Json | undefined> {
  const list = ok(await server.callTool("list_sessions", { include_completed: true }));
  return (list.sessions as Json[]).find((s) => s.session_id === id);
}

describe.skipIf(!MAGMUX_AVAILABLE)("team verbs: exact shapes, idempotent cancel", () => {
  test(
    "list, status, capture and cancel of a live run answer exactly the §8 keys",
    async () => {
      const path = join(layout.cwd, "team-contract");
      const started = ok(
        await team({
          mode: "run",
          path,
          models: ["contract-fake-a", "contract-fake-b"],
          input: "stay busy @@HANG@@",
        })
      );
      const runId = started.run_id as string;
      expect(typeof runId).toBe("string");
      expectRunRow(started.run as Json);

      // A — list
      const list = ok(await team({ mode: "list" }));
      expect(keys(list)).toEqual(["capabilities", "contract_version", "runs"]);
      expectContractMeta(list);
      const listed = (list.runs as Json[]).find((r) => r.run_id === runId) as Json;
      expect(listed).toBeDefined();
      expectRunRow(listed);
      expect(listed.state).toBe("ACTIVE");
      expect((listed.slots as Json[]).map((s) => s.slot)).toEqual(["01", "02"]);

      // B — status additions
      const status = ok(await team({ mode: "status", path }));
      expectContractMeta(status);
      expectRunRow(status.run as Json);
      expect((status.run as Json).run_id).toBe(runId);
      const byRunId = ok(await team({ mode: "status", path, run_id: runId }));
      expectContractMeta(byRunId);
      expect((byRunId.run as Json).run_id).toBe(runId);

      // D — capture, with and without spans
      const cap = ok(await team({ mode: "capture", path, slot: "01" }));
      expect(keys(cap)).toEqual(CAPTURE_KEYS);
      expect(cap.cols).toBe(160);
      expect(cap.rows).toBe(50);
      expect((cap.lines as string[]).length).toBe(50);
      expect(keys(cap.cursor)).toEqual(["x", "y"]);
      const spans = ok(await team({ mode: "capture", path, slot: "01", spans: true }));
      expect(keys(spans)).toEqual(CAPTURE_SPANS_KEYS);
      expect((spans.spans as unknown[]).length).toBe(50);

      // E — unknown slot on cancel, missing slot on capture
      contractError(await team({ mode: "cancel", path, slot: "99" }), "unknown_slot");
      contractError(await team({ mode: "capture", path, slot: "99" }), "unknown_slot");
      contractError(await team({ mode: "capture", path }), "invalid_args");

      // C — cancel one slot, then the run; each repeat is changed:false
      const one = ok(await team({ mode: "cancel", path, slot: "01" }));
      expect(keys(one)).toEqual(TEAM_CANCEL_KEYS);
      expect(one.run_id).toBe(runId);
      expect(one.results).toEqual([{ slot: "01", state: "CANCELLED", changed: true }]);
      for (const e of one.results as Json[]) expect(keys(e)).toEqual(TEAM_CANCEL_ENTRY_KEYS);
      const all = ok(await team({ mode: "cancel", path, run_id: runId }));
      expect(keys(all)).toEqual(TEAM_CANCEL_KEYS);
      expect(all.results).toEqual([
        { slot: "01", state: "CANCELLED", changed: false },
        { slot: "02", state: "CANCELLED", changed: true },
      ]);
      const again = ok(await team({ mode: "cancel", path }));
      expect(again.results).toEqual([
        { slot: "01", state: "CANCELLED", changed: false },
        { slot: "02", state: "CANCELLED", changed: false },
      ]);

      // the settled run, then a closed pane's final screen
      const settled = ok(await team({ mode: "status", path }));
      expect((settled.run as Json).state).toBe("SETTLED");
      expect((settled.run as Json).outcome).toBe("all-failed");
      for (const s of (settled.run as Json).slots as Json[]) {
        expect(s.reason).toBe("cancelled");
        expect(s.idle_seconds).toBeNull();
        expect(s.activity).toBeNull();
      }
      const final = await waitFor(
        async () => {
          const c = ok(await team({ mode: "capture", path, slot: "02" }));
          return c.final === true ? c : undefined;
        },
        { what: "slot 02's final screen", timeoutMs: 15_000, intervalMs: 200 }
      );
      expect(keys(final)).toEqual(CAPTURE_KEYS);
      const same = ok(
        await team({ mode: "capture", path, slot: "02", since_seq: final.seq as number })
      );
      expect(keys(same)).toEqual(UNCHANGED_KEYS);
      expect(same).toEqual({ unchanged: true, seq: final.seq, final: true });
    },
    T_TEST
  );
});

describe.skipIf(!MAGMUX_AVAILABLE)("channel verbs: exact shapes, idempotent cancel", () => {
  test(
    "create_session, list_sessions, capture_session, send_input and cancel_session",
    async () => {
      const created = ok(await server.callTool("create_session", { model: "contract-fake-model" }));
      expect(keys(created)).toEqual(["session_id", "state"]);
      expect(created.state).toBe("STARTING");
      const id = created.session_id as string;

      await waitFor(async () => (await sessionRow(id))?.state === "AWAITING_INPUT", {
        what: "the promptless session to be idle",
        timeoutMs: 20_000,
        intervalMs: 100,
      });

      // B — list_sessions
      const list = ok(await server.callTool("list_sessions", {}));
      expect(keys(list)).toEqual(["capabilities", "contract_version", "sessions"]);
      expectContractMeta(list);
      const row = (list.sessions as Json[]).find((s) => s.session_id === id) as Json;
      expectSlotRow(row, SESSION_ROW_KEYS);
      expect(row.slot).toBe(id);
      expect(row.reason).toBeNull();
      expect(row.activity).toBeNull();

      // D — capture: wait for two equal seqs, then since_seq answers unchanged
      const stable = await waitFor(
        async () => {
          const a = ok(await server.callTool("capture_session", { session_id: id }));
          await Bun.sleep(400);
          const b = ok(await server.callTool("capture_session", { session_id: id }));
          return a.seq === b.seq && (b.seq as number) > 0 ? b : undefined;
        },
        { what: "an idle screen", timeoutMs: 15_000, intervalMs: 100 }
      );
      expect(keys(stable)).toEqual(CAPTURE_KEYS);
      expect(stable.final).toBe(false);
      const unchanged = ok(
        await server.callTool("capture_session", { session_id: id, since_seq: stable.seq })
      );
      expect(keys(unchanged)).toEqual(UNCHANGED_KEYS);
      expect(unchanged).toEqual({ unchanged: true, seq: stable.seq, final: false });
      const lower = ok(
        await server.callTool("capture_session", {
          session_id: id,
          since_seq: (stable.seq as number) - 1,
        })
      );
      expect(keys(lower)).toEqual(CAPTURE_KEYS);
      const spans = ok(await server.callTool("capture_session", { session_id: id, spans: true }));
      expect(keys(spans)).toEqual(CAPTURE_SPANS_KEYS);

      // send_input answer shape
      const sent = ok(await server.callTool("send_input", { session_id: id, text: "hello" }));
      expect(keys(sent)).toEqual(["queued", "success"]);
      expect(sent.success).toBe(true);
      expect(typeof sent.queued).toBe("number");

      // C — cancel_session, twice
      const first = ok(await server.callTool("cancel_session", { session_id: id }));
      expect(keys(first)).toEqual(SESSION_CANCEL_KEYS);
      expect(first).toEqual({ session_id: id, state: "CANCELLED", changed: true });
      const second = ok(await server.callTool("cancel_session", { session_id: id }));
      expect(second).toEqual({ session_id: id, state: "CANCELLED", changed: false });

      const after = (await sessionRow(id)) as Json;
      expectSlotRow(after, SESSION_ROW_KEYS);
      expect(after.state).toBe("CANCELLED");
      expect(after.reason).toBe("cancelled");
      expect(after.idle_seconds).toBeNull();
      expect(typeof after.completed_at).toBe("string");
      const notListed = ok(await server.callTool("list_sessions", { include_completed: false }));
      expect((notListed.sessions as Json[]).some((s) => s.session_id === id)).toBe(false);

      // a refused send after the end names its reason and the state
      const refused = ok(await server.callTool("send_input", { session_id: id, text: "late" }));
      expect(refused).toEqual({ success: false, reason: "terminal", state: "CANCELLED" });
    },
    T_TEST
  );
});

describe.skipIf(!MAGMUX_AVAILABLE)("every §8 verb answers its errors as a ContractError", () => {
  test(
    "team status/cancel/capture and the channel verbs",
    async () => {
      const nowhere = join(layout.cwd, "no-such-run");
      const bogus = "team-00000000-zzzz-000000";

      // team status: unknown path, unknown run_id, path outside the cwd, missing path
      contractError(await team({ mode: "status", path: nowhere }), "unknown_run");
      contractError(await team({ mode: "status", path: nowhere, run_id: bogus }), "unknown_run");
      contractError(await team({ mode: "status", path: "/etc" }), "invalid_args");
      contractError(await team({ mode: "status" }), "invalid_args");
      contractError(await team({ mode: "status", path: nowhere, run_id: "" }), "invalid_args");

      // team cancel / capture
      contractError(await team({ mode: "cancel", path: nowhere }), "unknown_run");
      contractError(await team({ mode: "cancel", path: nowhere, run_id: bogus }), "unknown_run");
      contractError(
        await team({ mode: "capture", path: nowhere, slot: "01", run_id: bogus }),
        "unknown_run"
      );
      contractError(await team({ mode: "capture", path: nowhere, slot: "01" }), "unknown_run");
      contractError(await team({ mode: "capture", path: nowhere }), "invalid_args");
      contractError(
        await team({ mode: "capture", path: nowhere, slot: "01", since_seq: "x" }),
        "invalid_args"
      );

      // channel verbs
      contractError(
        await server.callTool("capture_session", { session_id: "deadbeef" }),
        "unknown_session"
      );
      contractError(
        await server.callTool("cancel_session", { session_id: "deadbeef" }),
        "unknown_session"
      );
      contractError(
        await server.callTool("capture_session", { session_id: "deadbeef", since_seq: "x" }),
        "invalid_args"
      );
      contractError(await server.callTool("capture_session", {}), "invalid_args");
      contractError(await server.callTool("cancel_session", {}), "invalid_args");
      // a refused create_session argument is the caller's error: no provider_failure hint
      const badFlags = await server.callTool("create_session", {
        model: "contract-fake-model",
        claude_flags: "--brief now", // a whitespace-split string; --brief takes no value
      });
      expect(badFlags.isError).toBe(true);
      expect(badFlags.text).toStartWith("Error: invalid_args:");
      expect(badFlags.text).not.toContain("report_error");

      // list verbs have no error for valid input, and carry the contract keys
      const teams = ok(await team({ mode: "list" }));
      expectContractMeta(teams);
      expect(teams.runs).toEqual([]);
      const sessions = ok(await server.callTool("list_sessions", { include_completed: true }));
      expectContractMeta(sessions);
      expect(sessions.sessions).toEqual([]);
    },
    T_TEST
  );
});
