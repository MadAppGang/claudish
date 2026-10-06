/**
 * BLACK-BOX: the `team` tool through the REAL claudish MCP server (JSON-RPC over stdio),
 * every slot the pane fake inside a real headless magmux.
 *
 * Written from spec.md (FR1, FR6, FR7, FR9 A–D, NFR1, NFR2) and the frozen mod contract
 * v1 (§8 A–E, architecture §4.1, §4.3, §5) only. No implementation file was read; every
 * literal below is copied from the contract text so a failure names the rule it broke.
 *
 * Fake child models used (CLAUDISH_BIN = the fake):
 *   - `fake-answer`   answers `ANSWER fake-answer <sha8>` and settles;
 *   - `fake-no_shape` answers prose without the `ANSWER` shape;
 *   - `contract-fake-model` marker mode: `@@HANG@@` = accepted, never answered.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { waitNoOrphans } from "../pane/test-helpers/hermetic-env.js";
import { useBlackboxEnv } from "../test-helpers/blackbox-env.js";
import {
  MAGMUX_AVAILABLE,
  McpServer,
  NO_MAGMUX_MESSAGE,
  type ToolResult,
  paneOrphans,
  paneRootOf,
  serverEnv,
} from "../test-helpers/contract-mcp.js";
import { type TempLayout, makeTempLayout, waitFor } from "../test-helpers/contract-records.js";

useBlackboxEnv();

const T_TEST = 90_000;
type Json = Record<string, unknown>;

/* ─────────────── literals from the frozen contract (§8 Types) ─────────────── */

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
const UNCHANGED_KEYS = ["final", "seq", "unchanged"];
const TEAM_CANCEL_KEYS = ["path", "results", "run_id"];
/** §4.1 `run` row of the table: the start answer's keys. */
const RUN_START_KEYS = [
  "started",
  "run_id",
  "team_session_id",
  "session_path",
  "monitor_record",
  "slots",
  "run",
  "next",
  "note",
];

const HANG = "stay busy @@HANG@@";
const PEAR = "Reply with exactly PEAR";

/* ─────────────── helpers ─────────────── */

const keys = (v: unknown): string[] => Object.keys(v as Json).sort();
const isIso = (v: unknown): boolean =>
  typeof v === "string" && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v);
const isNumOrNull = (v: unknown): boolean => v === null || typeof v === "number";
const isStrOrNull = (v: unknown): boolean => v === null || typeof v === "string";

let layout: TempLayout;
let server: McpServer;

if (!MAGMUX_AVAILABLE) console.warn(NO_MAGMUX_MESSAGE);

async function startServer(): Promise<McpServer> {
  return McpServer.start({
    // the fake's safety exit must not end a @@HANG@@ slot mid-test
    env: serverEnv(layout, { CONTRACT_FAKE_MAX_MS: "80000" }),
    cwd: layout.cwd,
  });
}

beforeEach(async () => {
  layout = makeTempLayout("bbteam");
  server = await startServer();
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
  expect(((body.error as Json).message as string).length).toBeGreaterThan(0);
}

function team(args: Json): Promise<ToolResult> {
  return server.callTool("team", args);
}

/** Every field of a §8 SlotRow, by key set, type and the state-dependent rules. */
function expectSlotRowTyped(row: Json): void {
  expect(keys(row)).toEqual(SLOT_ROW_KEYS);
  expect(typeof row.slot).toBe("string");
  expect(typeof row.model).toBe("string");
  expect(isStrOrNull(row.provider)).toBe(true);
  expect(SLOT_STATES).toContain(row.state as string);
  expect(row.reason === null || FAILURE_REASONS.includes(row.reason as string)).toBe(true);
  expect(isNumOrNull(row.tokens_in)).toBe(true);
  expect(isNumOrNull(row.tokens_out)).toBe(true);
  expect(isNumOrNull(row.cost_usd)).toBe(true);
  expect(Number.isInteger(row.tool_calls)).toBe(true);
  expect(row.tool_calls as number).toBeGreaterThanOrEqual(0);
  expect(Number.isInteger(row.turns_completed)).toBe(true);
  expect(row.turns_completed as number).toBeGreaterThanOrEqual(0);
  expect(row.last_activity_at === null || isIso(row.last_activity_at)).toBe(true);
  expect(isNumOrNull(row.idle_seconds)).toBe(true);
  if (typeof row.idle_seconds === "number") expect(row.idle_seconds).toBeGreaterThanOrEqual(0);
  expect(isStrOrNull(row.activity)).toBe(true);
  expect(isStrOrNull(row.pane)).toBe(true);

  const terminal = TERMINAL_STATES.includes(row.state as string);
  if (terminal) {
    // "idle_seconds: null in terminal states"; activity has a value only while busy/blocked
    expect(row.idle_seconds).toBeNull();
    expect(row.activity).toBeNull();
  }
  if (["FAILED", "EMPTY", "CANCELLED", "TIMEOUT"].includes(row.state as string)) {
    expect(row.reason).not.toBeNull();
  } else {
    // "null otherwise (incl. COMPLETED)"
    expect(row.reason).toBeNull();
  }
}

function expectRunRowTyped(run: Json): void {
  expect(keys(run)).toEqual(TEAM_RUN_ROW_KEYS);
  expect(typeof run.run_id).toBe("string");
  expect(typeof run.path).toBe("string");
  expect((run.path as string).startsWith("/")).toBe(true);
  expect(["run", "judge"]).toContain(run.kind as string);
  expect(isIso(run.started_at)).toBe(true);
  expect(["ACTIVE", "SETTLED"]).toContain(run.state as string);
  const slots = run.slots as Json[];
  expect(Array.isArray(slots)).toBe(true);
  for (const s of slots) expectSlotRowTyped(s);
  // "sorted by slot id"
  const ids = slots.map((s) => s.slot as string);
  expect(ids).toEqual([...ids].sort());
  // "SETTLED ⇔ every slot terminal"
  const allTerminal = slots.every((s) => TERMINAL_STATES.includes(s.state as string));
  expect(run.state === "SETTLED").toBe(allTerminal);
  if (run.state === "ACTIVE") {
    expect(run.outcome).toBeNull();
    expect(run.finished_at).toBeNull();
  } else {
    expect(["ok", "partial", "all-failed"]).toContain(run.outcome as string);
    expect(isIso(run.finished_at)).toBe(true);
  }
}

function expectContractMeta(body: Json): void {
  expect(body.contract_version).toBe(1);
  expect(body.capabilities).toEqual(CAPABILITIES);
}

async function runTeam(args: Json): Promise<Json> {
  return ok(await team({ mode: "run", ...args }));
}

async function waitSettled(path: string, runId?: string, timeoutMs = 45_000): Promise<Json> {
  return waitFor(
    async () => {
      const s = ok(await team({ mode: "status", path, ...(runId ? { run_id: runId } : {}) }));
      return (s.run as Json).state === "SETTLED" ? s : undefined;
    },
    { what: `the run at ${path} to settle`, timeoutMs, intervalMs: 200 }
  );
}

function slotRow(status: Json, slot: string): Json {
  const row = ((status.run as Json).slots as Json[]).find((s) => s.slot === slot);
  expect(row).toBeDefined();
  return row as Json;
}

/* ─────────────── tests ─────────────── */

describe.skipIf(!MAGMUX_AVAILABLE)(
  "team run → COMPLETED: shapes, types, terminal semantics",
  () => {
    test(
      "a settled run carries typed §8 rows, keeps its terminal state, and cancel is a no-op on it",
      async () => {
        const path = join(layout.cwd, "done-run");
        const started = await runTeam({ path, models: ["fake-answer"], input: PEAR });

        // §4.1: the start answer's keys, run_id top level and inside `run`
        for (const k of RUN_START_KEYS) expect(Object.keys(started)).toContain(k);
        const runId = started.run_id as string;
        expect(typeof runId).toBe("string");
        expect((started.run as Json).run_id).toBe(runId);
        expectRunRowTyped(started.run as Json);
        expect((started.run as Json).kind).toBe("run");
        expect((started.run as Json).path).toBe(path);
        // CA-13: `<team_session_id>-<base36 start ms>-<6 hex>`
        expect(runId.startsWith(`${started.team_session_id as string}-`)).toBe(true);
        expect(runId).toMatch(/-[0-9a-z]+-[0-9a-f]{6}$/);
        // the model→slot map
        const slots = started.slots as Record<string, string>;
        expect(Object.keys(slots)).toEqual(["fake-answer"]);
        const slot = slots["fake-answer"] as string;
        expect(slot).toBe("01");

        const settled = await waitSettled(path);
        expectContractMeta(settled);
        expectRunRowTyped(settled.run as Json);
        const run = settled.run as Json;
        expect(run.run_id).toBe(runId);
        expect(run.outcome).toBe("ok");
        const row = slotRow(settled, slot);
        expect(row.state).toBe("COMPLETED");
        expect(row.reason).toBeNull();
        expect(row.model).toBe("fake-answer");
        expect(row.turns_completed).toBe(1);
        expect(typeof row.pane).toBe("string"); // a pane was spawned
        // legacy keys kept beside the contract keys (§8 B)
        for (const k of ["startedAt", "models", "summary"])
          expect(Object.keys(settled)).toContain(k);
        expect(((settled.models as Json)[slot] as Json).state).toBe("COMPLETED");

        // §8 A: the run is listed, SETTLED, with its own run_id
        const list = ok(await team({ mode: "list" }));
        expect(keys(list)).toEqual(["capabilities", "contract_version", "runs"]);
        expectContractMeta(list);
        const listed = (list.runs as Json[]).find((r) => r.run_id === runId) as Json;
        expect(listed).toBeDefined();
        expectRunRowTyped(listed);
        expect(listed.state).toBe("SETTLED");
        expect(listed.finished_at).toBe(run.finished_at);

        // Terminal states are absorbing: cancel answers changed:false with the SAME state
        const cancel = ok(await team({ mode: "cancel", path }));
        expect(keys(cancel)).toEqual(TEAM_CANCEL_KEYS);
        expect(cancel).toEqual({
          run_id: runId,
          path,
          results: [{ slot, state: "COMPLETED", changed: false }],
        });
        const cancelOne = ok(await team({ mode: "cancel", path, slot, run_id: runId }));
        expect(cancelOne.results).toEqual([{ slot, state: "COMPLETED", changed: false }]);

        // …and later polls still report COMPLETED with the same finished_at
        await Bun.sleep(1_000);
        const later = ok(await team({ mode: "status", path }));
        expect(slotRow(later, slot).state).toBe("COMPLETED");
        expect((later.run as Json).finished_at).toBe(run.finished_at);

        // A closed pane answers its last screen with final:true; equal since_seq → unchanged
        const final = await waitFor(
          async () => {
            const c = ok(await team({ mode: "capture", path, slot }));
            return c.final === true ? c : undefined;
          },
          { what: "the closed pane's final screen", timeoutMs: 15_000, intervalMs: 200 }
        );
        expect(keys(final)).toEqual(CAPTURE_KEYS);
        expect((final.lines as string[]).length).toBe(50);
        const same = ok(
          await team({ mode: "capture", path, slot, since_seq: final.seq as number })
        );
        expect(same).toEqual({ unchanged: true, seq: final.seq, final: true });
      },
      T_TEST
    );
  }
);

describe.skipIf(!MAGMUX_AVAILABLE)("require_pattern and min_output_bytes (FR6)", () => {
  test(
    "require_pattern NEGATIVE control → EMPTY shape_mismatch, POSITIVE control → COMPLETED, mixed → partial",
    async () => {
      // negative: a pattern the fake's answer can never contain
      const neg = join(layout.cwd, "pattern-negative");
      const negStart = await runTeam({
        path: neg,
        models: ["fake-answer"],
        input: PEAR,
        require_pattern: "ZZZ_NEVER_IN_ANY_ANSWER_[0-9]{40}",
      });
      const negSlot = (negStart.slots as Record<string, string>)["fake-answer"] as string;
      const negDone = await waitSettled(neg);
      const negRow = slotRow(negDone, negSlot);
      expect(negRow.state).toBe("EMPTY");
      expect(negRow.reason).toBe("shape_mismatch");
      expect((negDone.run as Json).outcome).not.toBe("ok");

      // positive: the shape the fake does produce, anchored to the answer's start
      const pos = join(layout.cwd, "pattern-positive");
      const posStart = await runTeam({
        path: pos,
        models: ["fake-answer"],
        input: PEAR,
        require_pattern: "^ANSWER fake-answer [0-9a-f]{8}",
      });
      const posSlot = (posStart.slots as Record<string, string>)["fake-answer"] as string;
      const posDone = await waitSettled(pos);
      const posRow = slotRow(posDone, posSlot);
      expect(posRow.state).toBe("COMPLETED");
      expect(posRow.reason).toBeNull();
      expect((posDone.run as Json).outcome).toBe("ok");

      // mixed: one model matches, one does not → per-slot verdicts through the blind slot map
      const mixed = join(layout.cwd, "pattern-mixed");
      const mixStart = await runTeam({
        path: mixed,
        models: ["fake-answer", "fake-no_shape"],
        input: PEAR,
        require_pattern: "ANSWER",
      });
      const map = mixStart.slots as Record<string, string>;
      expect(Object.keys(map).sort()).toEqual(["fake-answer", "fake-no_shape"]);
      expect(Object.values(map).sort()).toEqual(["01", "02"]);
      const mixDone = await waitSettled(mixed);
      expectRunRowTyped(mixDone.run as Json);
      const good = slotRow(mixDone, map["fake-answer"] as string);
      const bad = slotRow(mixDone, map["fake-no_shape"] as string);
      expect(good.model).toBe("fake-answer");
      expect(bad.model).toBe("fake-no_shape");
      expect(good.state).toBe("COMPLETED");
      expect(bad.state).toBe("EMPTY");
      expect(bad.reason).toBe("shape_mismatch");
      expect((mixDone.run as Json).outcome).toBe("partial");
    },
    T_TEST
  );

  test(
    "min_output_bytes above the answer's length → EMPTY empty_output; below it → COMPLETED",
    async () => {
      const big = join(layout.cwd, "min-bytes-high");
      const bigStart = await runTeam({
        path: big,
        models: ["fake-answer"],
        input: PEAR,
        min_output_bytes: 100_000,
      });
      const bigSlot = (bigStart.slots as Record<string, string>)["fake-answer"] as string;
      const bigRow = slotRow(await waitSettled(big), bigSlot);
      expect(bigRow.state).toBe("EMPTY");
      // the only FailureReason that names "below min_output_bytes" is empty_output
      expect(bigRow.reason).toBe("empty_output");

      const small = join(layout.cwd, "min-bytes-low");
      const smallStart = await runTeam({
        path: small,
        models: ["fake-answer"],
        input: PEAR,
        min_output_bytes: 5,
      });
      const smallSlot = (smallStart.slots as Record<string, string>)["fake-answer"] as string;
      const smallRow = slotRow(await waitSettled(small), smallSlot);
      expect(smallRow.state).toBe("COMPLETED");
      expect(smallRow.reason).toBeNull();
    },
    T_TEST
  );

  test(
    "an invalid require_pattern is refused before anything starts (no session dir, no run listed)",
    async () => {
      const path = join(layout.cwd, "bad-pattern");
      const r = await team({
        mode: "run",
        path,
        models: ["fake-answer"],
        input: PEAR,
        require_pattern: "(",
      });
      expect(r.isError).toBe(true);
      expect(r.text.startsWith("Error:")).toBe(true);
      expect(r.text).toContain("invalid_args");
      expect(existsSync(path)).toBe(false);
      const list = ok(await team({ mode: "list" }));
      expect(list.runs).toEqual([]);
    },
    T_TEST
  );
});

describe.skipIf(!MAGMUX_AVAILABLE)("unknown agent (FR7)", () => {
  test(
    "team run with an unknown agent → slot FAILED agent_rejected, run SETTLED all-failed",
    async () => {
      const path = join(layout.cwd, "bad-agent");
      const started = await team({
        mode: "run",
        path,
        models: ["fake-answer"],
        input: PEAR,
        agent: "zzz-not-real",
      });
      // Either the run is refused outright, or it starts and the slot fails — never COMPLETED.
      if (started.isError) {
        expect(started.text).toContain("zzz-not-real");
        return;
      }
      const slot = ((started.json as Json).slots as Record<string, string>)[
        "fake-answer"
      ] as string;
      const done = await waitSettled(path);
      const row = slotRow(done, slot);
      expect(row.state).toBe("FAILED");
      expect(row.reason).toBe("agent_rejected");
      expect((done.run as Json).outcome).toBe("all-failed");
      expectRunRowTyped(done.run as Json);
    },
    T_TEST
  );
});

describe.skipIf(!MAGMUX_AVAILABLE)("run_id addressing (CA-13)", () => {
  test(
    "a reused path mints a distinct run_id per run; the old one stays addressable; one ACTIVE run per path",
    async () => {
      const path = join(layout.cwd, "review");
      const first = await runTeam({ path, models: ["fake-answer"], input: PEAR });
      await waitSettled(path);
      // The next round reuses the path, cleared as /dev:dev clears it
      rmSync(path, { recursive: true, force: true });
      const second = await runTeam({ path, models: ["contract-fake-model"], input: HANG });
      const id1 = first.run_id as string;
      const id2 = second.run_id as string;
      expect(id1).not.toBe(id2);

      // one ACTIVE run per path: a third start is refused with the usual text error
      const refused = await team({ mode: "run", path, models: ["fake-answer"], input: PEAR });
      expect(refused.isError).toBe(true);
      expect(refused.text.startsWith("Error: invalid_args:")).toBe(true);

      // both listed under their own run_id; ACTIVE first
      const list = ok(await team({ mode: "list" }));
      const runs = list.runs as Json[];
      expect(runs.map((r) => r.run_id)).toEqual([id2, id1]);
      expect(runs.map((r) => r.state)).toEqual(["ACTIVE", "SETTLED"]);
      for (const r of runs) {
        expectRunRowTyped(r);
        expect(r.path).toBe(path);
      }

      // status by the OLD run_id: that run, contract keys only, never the newer run's data
      const old = ok(await team({ mode: "status", path, run_id: id1 }));
      expect(keys(old)).toEqual(["capabilities", "contract_version", "run"]);
      expect((old.run as Json).run_id).toBe(id1);
      expect((old.run as Json).state).toBe("SETTLED");
      // status by path: the newest run
      const newest = ok(await team({ mode: "status", path }));
      expect((newest.run as Json).run_id).toBe(id2);
      expect((newest.run as Json).state).toBe("ACTIVE");

      // capture of the superseded run's slot: its retained final screen
      const cap = ok(await team({ mode: "capture", path, slot: "01", run_id: id1 }));
      expect(cap.final).toBe(true);
      // cancel of the superseded run: changed:false, its own state
      const oldCancel = ok(await team({ mode: "cancel", path, run_id: id1 }));
      expect(oldCancel).toEqual({
        run_id: id1,
        path,
        results: [{ slot: "01", state: "COMPLETED", changed: false }],
      });
      // the newest is untouched by that
      expect(slotRow(ok(await team({ mode: "status", path })), "01").state).not.toBe("CANCELLED");

      // a well-formed run_id this server never minted → unknown_run
      const neverMinted = `${second.team_session_id as string}-zzzzzzzz-abcdef`;
      contractError(await team({ mode: "status", path, run_id: neverMinted }), "unknown_run");
      contractError(await team({ mode: "cancel", path, run_id: neverMinted }), "unknown_run");
      contractError(
        await team({ mode: "capture", path, slot: "01", run_id: neverMinted }),
        "unknown_run"
      );

      ok(await team({ mode: "cancel", path, run_id: id2 }));
    },
    T_TEST
  );

  test(
    "after a server restart the old run_id is stale → unknown_run; status by path reads status.json",
    async () => {
      const path = join(layout.cwd, "restart");
      const started = await runTeam({ path, models: ["fake-answer"], input: PEAR });
      const runId = started.run_id as string;
      const slot = (started.slots as Record<string, string>)["fake-answer"] as string;
      await waitSettled(path);

      await server.close();
      server = await startServer();

      // "A server restart forgets every run"
      const list = ok(await team({ mode: "list" }));
      expectContractMeta(list);
      expect(list.runs).toEqual([]);
      // a run_id no longer retained → unknown_run, never disk data carrying that id
      contractError(await team({ mode: "status", path, run_id: runId }), "unknown_run");
      contractError(await team({ mode: "cancel", path, run_id: runId }), "unknown_run");
      contractError(await team({ mode: "capture", path, slot, run_id: runId }), "unknown_run");
      // without run_id: status is built from status.json, rows idle_seconds:null, activity:null
      const fromDisk = ok(await team({ mode: "status", path }));
      expectContractMeta(fromDisk);
      const run = fromDisk.run as Json;
      expect(keys(run)).toEqual(TEAM_RUN_ROW_KEYS);
      expect(run.state).toBe("SETTLED");
      const row = slotRow(fromDisk, slot);
      expect(keys(row)).toEqual(SLOT_ROW_KEYS);
      expect(row.state).toBe("COMPLETED");
      expect(row.idle_seconds).toBeNull();
      expect(row.activity).toBeNull();
      // capture of a run not retained → unknown_run
      contractError(await team({ mode: "capture", path, slot }), "unknown_run");
    },
    T_TEST
  );
});

describe.skipIf(!MAGMUX_AVAILABLE)("cancel (§8 C, NFR1)", () => {
  test(
    "cancel turns a RUNNING slot CANCELLED at once, is idempotent, and leaves no process or socket",
    async () => {
      const path = join(layout.cwd, "cancel-me");
      const started = await runTeam({ path, models: ["contract-fake-model"], input: HANG });
      const runId = started.run_id as string;
      const live = ok(await team({ mode: "status", path }));
      const liveRow = slotRow(live, "01");
      expect(TERMINAL_STATES).not.toContain(liveRow.state as string);
      expect(typeof liveRow.pane).toBe("string");

      const first = ok(await team({ mode: "cancel", path }));
      expect(first).toEqual({
        run_id: runId,
        path,
        results: [{ slot: "01", state: "CANCELLED", changed: true }],
      });
      // "Terminal states reach list and status in the same tick they are decided"
      const after = ok(await team({ mode: "status", path }));
      const row = slotRow(after, "01");
      expect(row.state).toBe("CANCELLED");
      expect(row.reason).toBe("cancelled");
      expectRunRowTyped(after.run as Json);
      expect((after.run as Json).state).toBe("SETTLED");
      expect((after.run as Json).outcome).toBe("all-failed");

      const second = ok(await team({ mode: "cancel", path, run_id: runId }));
      expect(second.results).toEqual([{ slot: "01", state: "CANCELLED", changed: false }]);
      const third = ok(await team({ mode: "cancel", path, slot: "01" }));
      expect(third.results).toEqual([{ slot: "01", state: "CANCELLED", changed: false }]);

      // the reap finishes in the background within ~12 s — WITH THE SERVER STILL RUNNING,
      // so this proves the cancel reaped, not the shutdown
      const report = await waitNoOrphans({ sockRoot: paneRootOf(layout) }, 15_000);
      expect(report.processes).toEqual([]);
      expect(report.files.filter((f) => f.endsWith(".sock"))).toEqual([]);
      expect(report.files.filter((f) => f.includes(liveRow.pane as string))).toEqual([]);

      // the closed pane is still capturable as its final screen
      const cap = ok(await team({ mode: "capture", path, slot: "01" }));
      expect(cap.final).toBe(true);
    },
    T_TEST
  );
});

describe.skipIf(!MAGMUX_AVAILABLE)("capture (§8 D, NFR2)", () => {
  test(
    "seq never goes backwards, a seq from elsewhere returns the full screen, lines are right-trimmed",
    async () => {
      const path = join(layout.cwd, "capture");
      await runTeam({ path, models: ["contract-fake-model"], input: HANG });

      const first = await waitFor(
        async () => {
          const c = ok(await team({ mode: "capture", path, slot: "01" }));
          return (c.seq as number) >= 1 ? c : undefined;
        },
        { what: "a first frame", timeoutMs: 15_000, intervalMs: 100 }
      );
      let prev = first.seq as number;
      for (let i = 0; i < 5; i++) {
        const started = Date.now();
        const c = ok(await team({ mode: "capture", path, slot: "01" }));
        // NFR2: a capture never blocks on the child
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(keys(c)).toEqual(CAPTURE_KEYS);
        expect(c.seq as number).toBeGreaterThanOrEqual(prev);
        prev = c.seq as number;
        const lines = c.lines as string[];
        expect(lines.length).toBe(c.rows as number);
        for (const l of lines) {
          expect(typeof l).toBe("string");
          expect(l).toBe(l.replace(/\s+$/, ""));
        }
        const cur = c.cursor as Json;
        expect(Number.isInteger(cur.x) && Number.isInteger(cur.y)).toBe(true);
        expect(cur.x as number).toBeGreaterThanOrEqual(0);
        expect(cur.y as number).toBeGreaterThanOrEqual(0);
        expect(cur.x as number).toBeLessThanOrEqual(c.cols as number);
        expect(cur.y as number).toBeLessThan(c.rows as number);
        await Bun.sleep(150);
      }
      // visible UI: the screen is not blank once a frame arrived
      const now = ok(await team({ mode: "capture", path, slot: "01" }));
      expect((now.lines as string[]).some((l) => l.trim() !== "")).toBe(true);

      // a since_seq HIGHER than the current one (e.g. from a previous server) → full screen
      const higher = ok(
        await team({ mode: "capture", path, slot: "01", since_seq: (now.seq as number) + 1000 })
      );
      expect(keys(higher)).toEqual(CAPTURE_KEYS);
      // the current seq → unchanged, or a newer full screen if it moved in between
      const same = ok(
        await team({ mode: "capture", path, slot: "01", since_seq: higher.seq as number })
      );
      if (same.unchanged === true) {
        expect(keys(same)).toEqual(UNCHANGED_KEYS);
        expect(same).toEqual({ unchanged: true, seq: higher.seq, final: false });
      } else {
        expect(same.seq as number).toBeGreaterThan(higher.seq as number);
      }

      // a terminal state is reflected by capture eventually: final:true after cancel
      ok(await team({ mode: "cancel", path }));
      const final = await waitFor(
        async () => {
          const c = ok(await team({ mode: "capture", path, slot: "01" }));
          return c.final === true ? c : undefined;
        },
        { what: "final:true after cancel", timeoutMs: 15_000, intervalMs: 200 }
      );
      expect(final.seq as number).toBeGreaterThanOrEqual(prev);
    },
    T_TEST
  );
});
