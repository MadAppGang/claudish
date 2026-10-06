/**
 * BLACK-BOX: the channel tools (create_session, send_input, get_output, cancel_session,
 * list_sessions, get_diagnostics, capture_session) through the REAL claudish MCP server,
 * every session the pane fake (marker mode, `contract-fake-model`) in a real headless magmux.
 *
 * Written from spec.md (FR2, FR5, FR7, FR9 B–D, FR10, NFR1) and the frozen mod contract v1
 * (§8 B–E, architecture §4.2, §5). No implementation file was read.
 *
 * The fake answers a typed line `ANSWER <model> <sha1(line)[0..8]>`, so a test can prove the
 * exact text it sent is the text that was answered.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { waitNoOrphans } from "../pane/test-helpers/hermetic-env.js";
import { useBlackboxEnv } from "../test-helpers/blackbox-env.js";
import {
  FAKE_MODEL,
  MAGMUX_AVAILABLE,
  McpServer,
  NO_MAGMUX_MESSAGE,
  type ToolResult,
  findField,
  paneOrphans,
  paneRootOf,
  serverEnv,
} from "../test-helpers/contract-mcp.js";
import { type TempLayout, makeTempLayout, waitFor } from "../test-helpers/contract-records.js";

useBlackboxEnv();

const T_TEST = 90_000;
type Json = Record<string, unknown>;

const CAPABILITIES = ["list", "status", "cancel", "capture", "capture_since_seq", "capture_spans"];
const SLOT_STATES = [
  "STARTING",
  "RUNNING",
  "AWAITING_INPUT",
  "AWAITING_PERMISSION",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
  "EMPTY",
];
const TERMINAL_STATES = ["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "EMPTY"];
const FAILURE_REASONS = [
  "cancelled",
  "timeout",
  "boot_timeout",
  "boot_blocked",
  "first_run_dialog",
  "agent_rejected",
  "prompt_not_accepted",
  "prompt_not_read",
  "child_exited",
  "pane_lost",
  "blocked",
  "api_error",
  "refused",
  "empty_output",
  "shape_mismatch",
];
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
];
const SESSION_ROW_KEYS = [
  ...SLOT_ROW_KEYS,
  "completed_at",
  "elapsed_seconds",
  "session_id",
  "started_at",
].sort();
const CAPTURE_KEYS = ["cols", "cursor", "final", "lines", "rows", "seq"].sort();
const SESSION_CANCEL_KEYS = ["changed", "session_id", "state"];

const keys = (v: unknown): string[] => Object.keys(v as Json).sort();
const isIso = (v: unknown): boolean =>
  typeof v === "string" && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v);
const sha8 = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 8);

let layout: TempLayout;
let server: McpServer;

if (!MAGMUX_AVAILABLE) console.warn(NO_MAGMUX_MESSAGE);

beforeEach(async () => {
  layout = makeTempLayout("bbchan");
  server = await McpServer.start({
    env: serverEnv(layout, { CONTRACT_FAKE_MAX_MS: "80000" }),
    cwd: layout.cwd,
  });
});

afterEach(async () => {
  await server.close();
  const report = await paneOrphans(layout, 15_000);
  layout.cleanup();
  expect(report).toEqual({ processes: [], files: [] });
});

function ok(r: ToolResult): Json {
  if (r.isError) throw new Error(`expected success, got error: ${r.text}`);
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

/** §8 SessionRow: SlotRow + session fields, types and state-dependent rules. */
function expectSessionRowTyped(row: Json): void {
  expect(keys(row)).toEqual(SESSION_ROW_KEYS);
  expect(typeof row.session_id).toBe("string");
  expect(row.slot).toBe(row.session_id);
  expect(typeof row.model).toBe("string");
  expect(row.provider === null || typeof row.provider === "string").toBe(true);
  expect(SLOT_STATES).toContain(row.state as string);
  expect(row.reason === null || FAILURE_REASONS.includes(row.reason as string)).toBe(true);
  for (const k of ["tokens_in", "tokens_out", "cost_usd", "idle_seconds"])
    expect(row[k] === null || typeof row[k] === "number").toBe(true);
  expect(Number.isInteger(row.tool_calls)).toBe(true);
  expect(Number.isInteger(row.turns_completed)).toBe(true);
  expect(row.last_activity_at === null || isIso(row.last_activity_at)).toBe(true);
  expect(row.activity === null || typeof row.activity === "string").toBe(true);
  expect(row.pane === null || typeof row.pane === "string").toBe(true);
  expect(isIso(row.started_at)).toBe(true);
  expect(row.completed_at === null || isIso(row.completed_at)).toBe(true);
  expect(typeof row.elapsed_seconds).toBe("number");
  expect(row.elapsed_seconds as number).toBeGreaterThanOrEqual(0);

  const terminal = TERMINAL_STATES.includes(row.state as string);
  if (terminal) {
    expect(row.idle_seconds).toBeNull();
    expect(row.activity).toBeNull();
    expect(isIso(row.completed_at)).toBe(true);
  } else {
    expect(row.completed_at).toBeNull();
  }
  if (["FAILED", "EMPTY", "CANCELLED", "TIMEOUT"].includes(row.state as string))
    expect(row.reason).not.toBeNull();
  else expect(row.reason).toBeNull();
}

async function sessionRow(id: string): Promise<Json | undefined> {
  const list = ok(await server.callTool("list_sessions", { include_completed: true }));
  expect(list.contract_version).toBe(1);
  expect(list.capabilities).toEqual(CAPABILITIES);
  return (list.sessions as Json[]).find((s) => s.session_id === id);
}

async function waitState(id: string, states: string[], timeoutMs = 30_000): Promise<Json> {
  return waitFor(
    async () => {
      const row = await sessionRow(id);
      return row && states.includes(row.state as string) ? row : undefined;
    },
    { what: `session ${id} to reach ${states.join("|")}`, timeoutMs, intervalMs: 100 }
  );
}

async function create(args: Json): Promise<string> {
  const created = ok(await server.callTool("create_session", { model: FAKE_MODEL, ...args }));
  expect(keys(created)).toEqual(["session_id", "state"]);
  expect(created.state).toBe("STARTING");
  return created.session_id as string;
}

/* ─────────────── tests ─────────────── */

describe.skipIf(!MAGMUX_AVAILABLE)("create_session WITH a prompt is one-shot (FR2)", () => {
  test(
    "it answers, turns COMPLETED, closes its pane and reaps everything; get_output has the answer",
    async () => {
      const prompt = "Reply with exactly PEAR";
      const id = await create({ prompt });
      const row = await waitState(id, TERMINAL_STATES);
      expectSessionRowTyped(row);
      expect(row.state).toBe("COMPLETED");
      expect(row.reason).toBeNull();
      expect(row.model).toBe(FAKE_MODEL);
      expect(row.turns_completed).toBe(1);

      // FR5: the answer from the transcript, the exact text that was typed
      const out = await server.callTool("get_output", { session_id: id });
      expect(out.isError).toBe(false);
      expect(out.text).toContain(`ANSWER ${FAKE_MODEL} ${sha8(prompt)}`);

      // one-shot: the pane is closed → capture's last screen, final:true
      const cap = await waitFor(
        async () => {
          const c = ok(await server.callTool("capture_session", { session_id: id }));
          return c.final === true ? c : undefined;
        },
        { what: "the one-shot pane's final screen", timeoutMs: 15_000, intervalMs: 200 }
      );
      expect(keys(cap)).toEqual(CAPTURE_KEYS);
      expect((cap.lines as string[]).length).toBe(50);

      // NFR1: nothing outlives the finished session — checked while the server still runs
      const report = await waitNoOrphans({ sockRoot: paneRootOf(layout), ids: [id] }, 15_000);
      expect(report.processes).toEqual([]);
      expect(report.files.filter((f) => f.endsWith(".sock"))).toEqual([]);

      // terminal is absorbing: a later send is refused with its reason and the state
      const late = ok(await server.callTool("send_input", { session_id: id, text: "more" }));
      expect(late).toEqual({ success: false, reason: "terminal", state: "COMPLETED" });
      const cancel = ok(await server.callTool("cancel_session", { session_id: id }));
      expect(keys(cancel)).toEqual(SESSION_CANCEL_KEYS);
      expect(cancel).toEqual({ session_id: id, state: "COMPLETED", changed: false });
      expect((await sessionRow(id))?.state).toBe("COMPLETED");
    },
    T_TEST
  );
});

describe.skipIf(!MAGMUX_AVAILABLE)(
  "create_session WITHOUT a prompt stays open between turns",
  () => {
    test(
      "AWAITING_INPUT → send_input → answer → AWAITING_INPUT (never STARTING again) → cancel",
      async () => {
        const id = await create({});
        const idle = await waitState(id, ["AWAITING_INPUT"]);
        expectSessionRowTyped(idle);
        expect(idle.turns_completed).toBe(0);
        expect(idle.activity).toBeNull();
        expect(typeof idle.pane).toBe("string");

        const text = "What is two plus two";
        const sent = ok(await server.callTool("send_input", { session_id: id, text }));
        expect(sent.success).toBe(true);
        expect(typeof sent.queued).toBe("number");

        // poll the turn; record every state seen until it settles back to idle
        const seen: string[] = [];
        const settled = await waitFor(
          async () => {
            const row = await sessionRow(id);
            if (!row) return undefined;
            seen.push(row.state as string);
            return row.state === "AWAITING_INPUT" && row.turns_completed === 1 ? row : undefined;
          },
          { what: "the first turn to settle", timeoutMs: 30_000, intervalMs: 50 }
        );
        // "a promptless session's first send_input goes AWAITING_INPUT → RUNNING, never back to STARTING"
        expect(seen).not.toContain("STARTING");
        for (const s of seen) expect(TERMINAL_STATES).not.toContain(s);
        expectSessionRowTyped(settled);
        expect(settled.reason).toBeNull();
        expect(typeof settled.idle_seconds).toBe("number");

        const out = await server.callTool("get_output", { session_id: id });
        expect(out.isError).toBe(false);
        expect(out.text).toContain(`ANSWER ${FAKE_MODEL} ${sha8(text)}`);

        const first = ok(await server.callTool("cancel_session", { session_id: id }));
        expect(first).toEqual({ session_id: id, state: "CANCELLED", changed: true });
        // returns once the state has turned CANCELLED
        const row = (await sessionRow(id)) as Json;
        expect(row.state).toBe("CANCELLED");
        expect(row.reason).toBe("cancelled");
        expectSessionRowTyped(row);
        const second = ok(await server.callTool("cancel_session", { session_id: id }));
        expect(second).toEqual({ session_id: id, state: "CANCELLED", changed: false });

        const report = await waitNoOrphans({ sockRoot: paneRootOf(layout), ids: [id] }, 15_000);
        expect(report.processes).toEqual([]);
        expect(report.files.filter((f) => f.endsWith(".sock"))).toEqual([]);
      },
      T_TEST
    );

    test(
      "send_input is accepted while a turn runs and queued: two sends → two settled turns, both answered",
      async () => {
        const id = await create({});
        await waitState(id, ["AWAITING_INPUT"]);
        const a = "first question alpha";
        const b = "second question bravo";
        const sa = ok(await server.callTool("send_input", { session_id: id, text: a }));
        const sb = ok(await server.callTool("send_input", { session_id: id, text: b }));
        expect(sa.success).toBe(true);
        expect(sb.success).toBe(true);
        const done = await waitFor(
          async () => {
            const row = await sessionRow(id);
            return row?.state === "AWAITING_INPUT" && row.turns_completed === 2 ? row : undefined;
          },
          { what: "both queued turns to settle", timeoutMs: 40_000, intervalMs: 100 }
        );
        expectSessionRowTyped(done);
        const out = await server.callTool("get_output", { session_id: id });
        expect(out.text).toContain(`ANSWER ${FAKE_MODEL} ${sha8(a)}`);
        expect(out.text).toContain(`ANSWER ${FAKE_MODEL} ${sha8(b)}`);
        expect(out.text.indexOf(sha8(a))).toBeLessThan(out.text.indexOf(sha8(b)));
        ok(await server.callTool("cancel_session", { session_id: id }));
      },
      T_TEST
    );
  }
);

describe.skipIf(!MAGMUX_AVAILABLE)("failure and timeout states (FR7)", () => {
  test(
    "an unknown agent → FAILED agent_rejected",
    async () => {
      const id = await create({ prompt: "Reply with exactly PEAR", agent: "zzz-not-real" });
      const row = await waitState(id, TERMINAL_STATES);
      expectSessionRowTyped(row);
      expect(row.state).toBe("FAILED");
      expect(row.reason).toBe("agent_rejected");
      const late = ok(await server.callTool("send_input", { session_id: id, text: "x" }));
      expect(late).toEqual({ success: false, reason: "terminal", state: "FAILED" });
    },
    T_TEST
  );

  test(
    "timeout_seconds elapsing on a hung turn → TIMEOUT timeout, pane closed",
    async () => {
      const id = await create({ prompt: "hold on @@HANG@@", timeout_seconds: 3 });
      const row = await waitState(id, TERMINAL_STATES, 30_000);
      expectSessionRowTyped(row);
      expect(row.state).toBe("TIMEOUT");
      expect(row.reason).toBe("timeout");
      const cancel = ok(await server.callTool("cancel_session", { session_id: id }));
      expect(cancel).toEqual({ session_id: id, state: "TIMEOUT", changed: false });
      const cap = await waitFor(
        async () => {
          const c = ok(await server.callTool("capture_session", { session_id: id }));
          return c.final === true ? c : undefined;
        },
        { what: "final:true after timeout", timeoutMs: 15_000, intervalMs: 200 }
      );
      expect(keys(cap)).toEqual(CAPTURE_KEYS);
    },
    T_TEST
  );
});

describe.skipIf(!MAGMUX_AVAILABLE)("diagnostics, channel frames, error forms", () => {
  test(
    "get_diagnostics names the state and the capture/turn source; channel frames fire for the session",
    async () => {
      const id = await create({ prompt: "Reply with exactly PEAR" });
      await waitState(id, TERMINAL_STATES);
      const diag = await server.callTool("get_diagnostics", { session_id: id });
      expect(diag.isError).toBe(false);
      expect(diag.json).toBeDefined();
      // §4.2: `event` beside `state` (SlotState); FR5: which source was used is recorded
      expect(SLOT_STATES).toContain(findField(diag.json, "state") as string);
      expect(findField(diag.json, "state")).toBe("COMPLETED");
      expect(typeof findField(diag.json, "event")).toBe("string");
      for (const k of ["captureSource", "turnSource", "pane", "anomalies", "transcriptPath"])
        expect(findField(diag.json, k)).not.toBeUndefined();

      // FR10/E: notifications/claude/channel frames fire on state transitions
      const frames = await waitFor(
        () => {
          const f = server.notifications.filter(
            (n) =>
              n.method === "notifications/claude/channel" && JSON.stringify(n.params).includes(id)
          );
          return f.length > 0 ? f : undefined;
        },
        { what: "a channel frame for the session", timeoutMs: 5_000 }
      );
      expect(frames.length).toBeGreaterThan(0);
    },
    T_TEST
  );

  test(
    "unknown session ids: send_input answers unknown_session; get_output/get_diagnostics answer Error text",
    async () => {
      const send = ok(await server.callTool("send_input", { session_id: "deadbeef", text: "x" }));
      expect(send.success).toBe(false);
      expect(send.reason).toBe("unknown_session");
      const out = await server.callTool("get_output", { session_id: "deadbeef" });
      expect(out.isError).toBe(true);
      expect(out.text.startsWith("Error")).toBe(true);
      const diag = await server.callTool("get_diagnostics", { session_id: "deadbeef" });
      expect(diag.isError).toBe(true);
      expect(diag.text.startsWith("Error")).toBe(true);
      // the §8 verbs answer a wrongly TYPED argument with an invalid_args ContractError
      contractError(await server.callTool("cancel_session", { session_id: 42 }), "invalid_args");
      contractError(
        await server.callTool("capture_session", { session_id: 42, since_seq: 1 }),
        "invalid_args"
      );
      contractError(
        await server.callTool("list_sessions", { include_completed: "yes" }),
        "invalid_args"
      );
    },
    T_TEST
  );
});
