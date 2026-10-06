/**
 * The team run registry behind `team(mode="list"|"status"|"cancel"|"capture")` (§3.2,
 * §8 A–D, CA-13): runs are keyed by run_id with a newest-by-path index, ACTIVE runs list
 * first, SETTLED runs stay for 30 minutes (at most 20), two runs whose paths share a
 * basename are both listed (F6), a superseded run stays addressable by its run_id, and a
 * path holds at most one ACTIVE run.
 *
 * Orchestrator + the pane fake in a real headless magmux; the §8 verbs are driven through
 * the MCP handler's own functions so their JSON and ContractError envelopes are pinned.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { teamContractVerb, teamStatusAnswer } from "./mcp-server.js";
import { CAPABILITIES, type CaptureResult, type TeamRunRow } from "./pane/index.js";
import {
  MAX_SETTLED_RUNS,
  type TeamHandle,
  cancelTeamRun,
  judgeResponses,
  listTeamRuns,
  preflightTeamRun,
  pruneTeamRunsForTests,
  resetTeamRegistryForTests,
  setupSession,
  startModels,
} from "./team-orchestrator.js";
import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type PaneTestEnv,
  finishPaneTest,
  makePaneTestEnv,
  paneRunOptions,
} from "./test-helpers/team-pane.js";

if (!MAGMUX) console.warn(NO_MAGMUX_MESSAGE);

const HANG = "@@HANG@@ hold until cancelled";
let t: PaneTestEnv;
/** Session dirs live under the cwd: the §8 verbs validate `path` the way the server does. */
let base: string;
let handles: TeamHandle[];

beforeEach(() => {
  resetTeamRegistryForTests();
  t = makePaneTestEnv();
  base = mkdtempSync(join(process.cwd(), ".tmp-team-list-"));
  handles = [];
});

afterEach(async () => {
  for (const h of handles) {
    await cancelTeamRun(h.sessionPath, undefined, h.runId).catch(() => undefined);
    await h.done;
  }
  resetTeamRegistryForTests();
  rmSync(base, { recursive: true, force: true });
  const report = await finishPaneTest(t);
  expect(report).toEqual({ processes: [], files: [] });
});

async function start(path: string, models: string[], input: string): Promise<TeamHandle> {
  setupSession(path, models, input);
  const h = await startModels(path, paneRunOptions(t));
  handles.push(h);
  return h;
}

function json(answer: { content: Array<{ text: string }>; isError?: boolean }) {
  return { isError: answer.isError === true, body: JSON.parse(answer.content[0]?.text ?? "{}") };
}

describe.skipIf(!MAGMUX)("team run registry (list / status / cancel / capture)", () => {
  it("lists ACTIVE runs first, then SETTLED by finished_at desc, with contract meta", async () => {
    const a = await start(join(base, "a"), ["fake-answer"], "Reply with exactly PEAR");
    await a.done;
    const b = await start(join(base, "b"), ["fake-answer"], "Reply with exactly PEAR");
    await b.done;
    const c = await start(join(base, "c"), ["contract-fake-model"], HANG);

    const listed = listTeamRuns();
    expect(listed.contract_version).toBe(1);
    expect(listed.capabilities).toEqual([...CAPABILITIES]);
    expect(listed.runs.map((r) => [r.run_id, r.state])).toEqual([
      [c.runId, "ACTIVE"],
      [b.runId, "SETTLED"],
      [a.runId, "SETTLED"],
    ]);
    const settled = listed.runs[1] as TeamRunRow;
    expect(settled.outcome).toBe("ok");
    expect(settled.finished_at).not.toBeNull();
    expect(listed.runs[0]?.outcome).toBeNull();
    expect(listed.runs[0]?.finished_at).toBeNull();
    // run_id format: <team_session_id>-<base36 start ms>-<6 hex>
    expect(c.runId).toMatch(/^c-[0-9a-z]+-[0-9a-f]{6}$/);

    // The MCP list verb answers the same object.
    const viaMcp = json(await teamContractVerb("list", {}));
    expect(viaMcp.isError).toBe(false);
    expect(viaMcp.body.runs.map((r: TeamRunRow) => r.run_id)).toEqual(
      listed.runs.map((r) => r.run_id)
    );
  }, 60_000);

  it("lists two runs whose paths share a basename, each addressable by path (F6)", async () => {
    const p1 = join(base, "one", "review");
    const p2 = join(base, "two", "review");
    mkdirSync(join(base, "one"));
    mkdirSync(join(base, "two"));
    const r1 = await start(p1, ["contract-fake-model"], HANG);
    const r2 = await start(p2, ["contract-fake-model"], HANG);

    const paths = listTeamRuns()
      .runs.map((r) => r.path)
      .sort();
    expect(paths).toEqual([p1, p2].sort());
    expect(json(await teamContractVerb("status", { path: p1 })).body.run.run_id).toBe(r1.runId);
    expect(json(await teamContractVerb("status", { path: p2 })).body.run.run_id).toBe(r2.runId);
  }, 60_000);

  it("keeps a superseded run addressable by run_id: listed, capturable, cancel changed:false, status without legacy keys", async () => {
    const path = join(base, "reused");
    const first = await start(path, ["fake-answer"], "Reply with exactly PEAR");
    await first.done;
    const slot = Object.values(first.slots)[0] as string;
    // The next round reuses the path (its directory is cleared, as /dev:dev does).
    rmSync(path, { recursive: true, force: true });
    const second = await start(path, ["contract-fake-model"], HANG);

    const runs = listTeamRuns().runs;
    expect(runs.map((r) => r.run_id).sort()).toEqual([first.runId, second.runId].sort());

    // status by the old run_id: `run` + contract keys, never the newer run's legacy keys.
    const old = teamStatusAnswer(path, first.runId);
    expect(Object.keys(old).sort()).toEqual(["capabilities", "contract_version", "run"]);
    expect((old.run as TeamRunRow).run_id).toBe(first.runId);
    expect((old.run as TeamRunRow).state).toBe("SETTLED");
    // status by path: the newest run, with the legacy keys.
    const newest = teamStatusAnswer(path);
    expect((newest.run as TeamRunRow).run_id).toBe(second.runId);
    expect(newest).toHaveProperty("models");

    // capture of the superseded run's slot: its retained final screen.
    const cap = json(await teamContractVerb("capture", { path, slot, run_id: first.runId }));
    expect(cap.isError).toBe(false);
    expect((cap.body as CaptureResult).final).toBe(true);
    expect((cap.body as CaptureResult).lines).toHaveLength(50);

    // cancel of the superseded run: every slot changed:false.
    const cancel = json(await teamContractVerb("cancel", { path, run_id: first.runId }));
    expect(cancel.body).toEqual({
      run_id: first.runId,
      path,
      results: [{ slot, state: "COMPLETED", changed: false }],
    });
  }, 60_000);

  it("refuses a second run on a path whose newest run is ACTIVE", async () => {
    const path = join(base, "busy");
    const active = await start(path, ["contract-fake-model"], HANG);
    const message = `invalid_args: a team run is already ACTIVE at ${path} (run_id ${active.runId}); cancel it or wait for it`;

    await expect(preflightTeamRun({ path, slots: 1 })).rejects.toThrow(message);
    await expect(startModels(path, paneRunOptions(t))).rejects.toThrow(message);
    // judging it now would vote on whichever slots happen to have finished
    await expect(judgeResponses(path)).rejects.toThrow(
      `invalid_args: the team run at ${path} is still ACTIVE (run_id ${active.runId})`
    );
  }, 60_000);

  it("refuses an invalid require_pattern in preflight, before any session dir or record", async () => {
    const path = join(base, "bad-pattern");
    await expect(preflightTeamRun({ path, slots: 1, requirePattern: "(" })).rejects.toThrow(
      /^invalid_args: Invalid requirePattern \/\(\//
    );
    expect(existsSync(path)).toBe(false);
  });

  it("checks every argument's type before the run lookup, for status, cancel and capture", async () => {
    const path = join(base, "nothing-here");
    const bad: Array<[string, Record<string, unknown>]> = [
      ["spans", { spans: "yes" }],
      ["spans", { spans: 1 }],
      ["since_seq", { since_seq: "3" }],
      ["since_seq", { since_seq: 1.5 }],
      ["run_id", { run_id: 7 }],
      ["slot", { slot: 1 }],
    ];
    for (const mode of ["status", "cancel", "capture"] as const)
      for (const [name, extra] of bad) {
        const r = json(await teamContractVerb(mode, { path, slot: "01", ...extra }));
        expect(r.body.error.code).toBe("invalid_args");
        expect(r.body.error.message).toContain(`'${name}'`);
      }
    // well-typed arguments reach the lookup: the run does not exist
    const ok = json(
      await teamContractVerb("capture", { path, slot: "01", spans: false, since_seq: 0 })
    );
    expect(ok.body.error.code).toBe("unknown_run");
  });

  it("answers unknown runs and slots with ContractError JSON", async () => {
    const path = join(base, "nothing-here");
    const unknownStatus = json(await teamContractVerb("status", { path }));
    expect(unknownStatus).toEqual({
      isError: true,
      body: { error: { code: "unknown_run", message: expect.any(String) } },
    });
    const unknownId = json(
      await teamContractVerb("capture", { path, slot: "01", run_id: "x-1-abcdef" })
    );
    expect(unknownId.body.error.code).toBe("unknown_run");
    const noPath = json(await teamContractVerb("cancel", {}));
    expect(noPath.body.error.code).toBe("invalid_args");

    const r = await start(join(base, "known"), ["contract-fake-model"], HANG);
    const badSlot = json(await teamContractVerb("capture", { path: r.sessionPath, slot: "99" }));
    expect(badSlot.body.error.code).toBe("unknown_slot");
    const noSlot = json(await teamContractVerb("capture", { path: r.sessionPath }));
    expect(noSlot.body.error.code).toBe("invalid_args");
  }, 60_000);

  it("captures a live slot with since_seq and spans, and answers unchanged at the same seq", async () => {
    const r = await start(join(base, "cap"), ["contract-fake-model"], HANG);
    const slot = Object.values(r.slots)[0] as string;
    const full = json(
      await teamContractVerb("capture", { path: r.sessionPath, slot, spans: true })
    );
    const screen = full.body as CaptureResult;
    expect(screen.seq).toBeGreaterThan(0);
    expect(screen.cols).toBe(160);
    expect(screen.rows).toBe(50);
    expect(screen.final).toBe(false);
    expect(Array.isArray(screen.spans)).toBe(true);
    const same = json(
      await teamContractVerb("capture", { path: r.sessionPath, slot, since_seq: screen.seq })
    );
    if (same.body.unchanged)
      expect(same.body).toEqual({ unchanged: true, seq: screen.seq, final: false });
    else expect(same.body.seq).toBeGreaterThan(screen.seq); // the screen moved in between
  }, 60_000);

  it("drops a settled run after 30 minutes; status then answers from status.json", async () => {
    const path = join(base, "old");
    const r = await start(path, ["fake-answer"], "Reply with exactly PEAR");
    await r.done;
    expect(listTeamRuns().runs.map((x) => x.run_id)).toEqual([r.runId]);

    pruneTeamRunsForTests(Date.now() + 31 * 60_000);

    expect(listTeamRuns().runs).toEqual([]);
    const fromDisk = teamStatusAnswer(path);
    const run = fromDisk.run as TeamRunRow;
    expect(run.run_id).toBe(r.runId); // persisted in status.json
    expect(run.state).toBe("SETTLED");
    expect(run.slots.every((s) => s.idle_seconds === null && s.activity === null)).toBe(true);
    const slot = Object.values(r.slots)[0] as string;
    const cap = json(await teamContractVerb("capture", { path, slot }));
    expect(cap.body.error.code).toBe("unknown_run");
    // CA-13: an evicted run_id never falls back to disk data, even data carrying that id
    for (const mode of ["status", "cancel"] as const) {
      const byId = json(await teamContractVerb(mode, { path, run_id: r.runId }));
      expect(byId.isError).toBe(true);
      expect(byId.body.error.code).toBe("unknown_run");
    }
  }, 60_000);

  it(`keeps at most ${MAX_SETTLED_RUNS} settled runs, evicting the oldest first`, async () => {
    // Slots whose pane never spawns settle at once (FAILED pane_lost, no pane): a
    // claudish subcommand name is refused as a model before anything starts.
    const ids: string[] = [];
    for (let i = 0; i < MAX_SETTLED_RUNS + 2; i++) {
      const h = await start(join(base, `r${i}`), ["update"], "Reply with exactly PEAR");
      await h.done;
      ids.push(h.runId);
      await Bun.sleep(2); // distinct finished_at
    }
    const listed = listTeamRuns().runs;
    expect(listed).toHaveLength(MAX_SETTLED_RUNS);
    expect(listed.map((r) => r.run_id)).not.toContain(ids[0]);
    expect(listed.map((r) => r.run_id)).not.toContain(ids[1]);
    expect(listed[0]?.run_id).toBe(ids.at(-1) as string);
    const row = listed[0] as TeamRunRow;
    expect(row.slots[0]).toMatchObject({ state: "FAILED", reason: "pane_lost", pane: null });
    const cap = json(
      await teamContractVerb("capture", { path: row.path, slot: row.slots[0]?.slot })
    );
    expect(cap.body).toEqual({
      seq: 0,
      cols: 160,
      rows: 50,
      cursor: { x: 0, y: 0 },
      lines: Array.from({ length: 50 }, () => ""),
      final: true,
    });
  }, 60_000);
});
