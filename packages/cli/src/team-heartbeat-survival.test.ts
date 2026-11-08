/**
 * NO SLOT IS EVER KILLED ON A TIMER once its prompt is accepted (D10,
 * team-lifecycle.md). A slot inside a long silent tool call, and a slot whose Stop hook
 * runs for a long time after its answer, both settle on Claude Code's own end-of-turn
 * record with their answer intact — and report what they are doing meanwhile.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as pane from "./pane/index.js";
import {
  resetTeamRegistryForTests,
  runModels,
  setupSession,
  startModels,
  teamLiveMaps,
  teamRunRow,
} from "./team-orchestrator.js";
import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type PaneTestEnv,
  finishPaneTest,
  makePaneTestEnv,
  paneRunOptions,
  teamDirOf,
  waitUntil,
} from "./test-helpers/team-pane.js";

if (!MAGMUX) console.warn(NO_MAGMUX_MESSAGE);

let t: PaneTestEnv;

beforeEach(() => {
  t = makePaneTestEnv();
});

afterEach(async () => {
  const report = await finishPaneTest(t);
  expect(report).toEqual({ processes: [], files: [] });
});

describe("offline team slot anomaly projection", () => {
  // REGRESSION: one-shot session never settles when background-agent notifications arrive mid-turn as attachment/queued_command — Fixed in /dev:fix session dev-fix-20261016-224933-5e5cb5a4
  it("agent_count_mismatch shows in the row and map while live, and stays in status history after clearing", async () => {
    const sessionPath = teamDirOf(t);
    setupSession(sessionPath, ["haiku"], "Reply with exactly PEAR");
    const anomaly = "agent_count_mismatch: claudish 2 pending, Claude Code 0";
    let snap: pane.PaneSnapshot = {
      paneId: "c1-k0-t01-abcdef",
      phase: "RUNNING",
      state: "RUNNING",
      reason: null,
      detail: null,
      activity: "background",
      lastActivityAt: "2026-10-06T01:00:00.000Z",
      idleSeconds: 0,
      turnsCompleted: 0,
      tokensIn: 33324,
      tokensOut: 44,
      toolCalls: 2,
      liveAnswerBytes: 0,
      exitCode: null,
      captureSource: null,
      turnSource: "transcript",
      pendingInputs: 0,
      pendingHookInputs: 0,
      connected: true,
      startedAt: "2026-10-06T00:59:00.000Z",
      endedAt: null,
      transcriptPath: "/x.jsonl",
      panePid: null,
      screenTail: "",
      anomalies: [anomaly],
      claudeCodeVersion: null,
      shape: "one-shot",
      turnEndRecordMissing: false,
      agentCountMismatch: true,
      recent: null,
    };
    let onTransition: pane.PaneSessionOptions["onTransition"];
    const terminal = Promise.withResolvers<void>();
    // Exercise the real team projection and anomaly filter, without starting a pane.
    const available = spyOn(pane, "assertMagmuxAvailable").mockResolvedValue({
      binary: "unused-offline",
      version: "unused-offline",
    });
    const reserve = spyOn(pane, "reservePanes").mockImplementation(() => {});
    const start = spyOn(pane, "startPaneSession").mockImplementation(async (opts) => {
      onTransition = opts.onTransition;
      return {
        paneId: snap.paneId,
        snapshot: () => snap,
        ready: Promise.resolve(),
        terminal: terminal.promise,
        reaped: () => terminal.promise,
        turnAnswer: () => "PEAR",
      } as unknown as pane.PaneSession;
    });
    let handle: Awaited<ReturnType<typeof startModels>> | undefined;
    const update = (over: Partial<pane.PaneSnapshot>) => {
      snap = { ...snap, ...over };
      onTransition?.({ snap } as Parameters<NonNullable<typeof onTransition>>[0]);
    };
    try {
      handle = await startModels(sessionPath, paneRunOptions(t));
      const slotId = handle.slots.haiku!;
      const rowActivity = () =>
        teamRunRow(sessionPath)?.slots.find((s) => s.slot === slotId)?.activity ?? null;
      const anomalies = () =>
        JSON.parse(readFileSync(join(sessionPath, "status.json"), "utf8")).models[slotId].anomalies;
      update({});
      expect({
        flag: snap.agentCountMismatch,
        activity: teamLiveMaps(sessionPath)?.activity[slotId],
        rowActivity: rowActivity(),
        anomalies: anomalies(),
      }).toEqual({
        flag: true,
        activity: "background: agent_count_mismatch",
        rowActivity: "background: agent_count_mismatch",
        anomalies: [anomaly],
      });
      // The anomaly is history once the live condition clears, not an activity suffix.
      update({ activity: "Bash", agentCountMismatch: false });
      expect(snap.agentCountMismatch).toBe(false);
      expect(teamLiveMaps(sessionPath)?.activity[slotId]).toBe("Bash");
      expect(rowActivity()).toBe("Bash");
      expect(anomalies()).toEqual([anomaly]);
      expect(teamRunRow(sessionPath)?.state).toBe("ACTIVE");
      expect(snap.turnsCompleted).toBe(0);
      update({
        state: "COMPLETED",
        phase: "COMPLETED",
        activity: null,
        agentCountMismatch: false,
        turnsCompleted: 1,
        endedAt: new Date().toISOString(),
      });
      terminal.resolve();
      const status = await handle.done;
      expect(status.models[slotId]?.state).toBe("COMPLETED");
      expect(status.models[slotId]?.anomalies).toEqual([anomaly]);
      expect(rowActivity()).toBeNull();
    } finally {
      if (handle) {
        update({
          state: "COMPLETED",
          phase: "COMPLETED",
          activity: null,
          agentCountMismatch: false,
        });
        terminal.resolve();
        await handle.done;
      }
      start.mockRestore();
      reserve.mockRestore();
      available.mockRestore();
      resetTeamRegistryForTests();
    }
  });
});

describe.skipIf(!MAGMUX)("team slot heartbeat survival", () => {
  it("keeps a slot alive through a silent tool call and reports activity Bash", async () => {
    const sessionPath = teamDirOf(t);
    setupSession(sessionPath, ["fake-tool_slow"], "Run the long tool call.");

    const startedAt = Date.now();
    const handle = await startModels(
      sessionPath,
      paneRunOptions(t, {}, { FAKE_GAP_MS_TOOL: "3000" })
    );
    const slotId = handle.slots["fake-tool_slow"] as string;
    const seen = new Set<string>();
    let maxIdle = 0;
    const watch = setInterval(() => {
      const live = teamLiveMaps(sessionPath);
      if (live?.activity[slotId]) seen.add(live.activity[slotId] as string);
      maxIdle = Math.max(maxIdle, live?.idle[slotId] ?? 0);
    }, 100);
    const status = await handle.done;
    clearInterval(watch);
    const elapsedMs = Date.now() - startedAt;
    const model = status.models[slotId];
    const response = readFileSync(join(sessionPath, `response-${slotId}.md`), "utf-8");

    expect(elapsedMs).toBeGreaterThanOrEqual(3000);
    expect(seen.has("Bash")).toBe(true);
    expect(maxIdle).toBeGreaterThanOrEqual(1);
    expect(model?.state).toBe("COMPLETED");
    expect(model?.error).toBeUndefined();
    expect(response).toStartWith("ANSWER fake-tool_slow ");
    expect(response.split("ANSWER")).toHaveLength(2);
  }, 30_000);

  it("R3-M4: turn_end_record_missing shows in the row and the map while it holds, and clears when work resumes", async () => {
    const sessionPath = teamDirOf(t);
    setupSession(sessionPath, ["fake-finishing_then_wake"], "Answer in two parts.");
    const handle = await startModels(
      sessionPath,
      paneRunOptions(
        t,
        { paneTimings: { replStableMs: 200, secondaryQuietMs: 300 } },
        { FAKE_GAP_MS_WAKE: "3000" }
      )
    );
    const slotId = handle.slots["fake-finishing_then_wake"] as string;
    const rowActivity = () =>
      teamRunRow(sessionPath)?.slots.find((s) => s.slot === slotId)?.activity ?? null;
    await waitUntil(
      () => teamLiveMaps(sessionPath)?.endRecordMissing.includes(slotId) === true,
      "endRecordMissing",
      10_000
    );
    expect(teamLiveMaps(sessionPath)?.activity[slotId]).toBe("finishing: turn_end_record_missing");
    expect(rowActivity()).toBe("finishing: turn_end_record_missing");
    // the notification wakes the model and it runs a tool: working again, not wedged
    await waitUntil(
      () => teamLiveMaps(sessionPath)?.activity[slotId] === "Bash",
      "activity Bash, plain",
      10_000
    );
    expect(teamLiveMaps(sessionPath)?.endRecordMissing ?? []).not.toContain(slotId);
    expect(rowActivity()).toBe("Bash");
    const status = await handle.done;
    expect(status.models[slotId]?.state).toBe("COMPLETED");
    // the anomaly stays as history in the slot's record (L6: nothing else pinned it)
    expect(status.models[slotId]?.anomalies ?? []).toContain("turn_end_record_missing");
  }, 30_000);

  it("waits out a slow Stop hook after the answer, reading finishing meanwhile", async () => {
    const sessionPath = teamDirOf(t);
    setupSession(sessionPath, ["fake-slow_stop_hook"], "Answer, then let the hook run.");

    const handle = await startModels(
      sessionPath,
      paneRunOptions(t, {}, { FAKE_GAP_MS_HOOK: "3000" })
    );
    const slotId = handle.slots["fake-slow_stop_hook"] as string;
    await waitUntil(
      () => teamLiveMaps(sessionPath)?.activity[slotId] === "finishing",
      "activity finishing",
      5_000
    );
    const status = await handle.done;

    expect(status.models[slotId]?.state).toBe("COMPLETED");
    expect(readFileSync(join(sessionPath, `response-${slotId}.md`), "utf-8")).toStartWith(
      "ANSWER fake-slow_stop_hook "
    );
  }, 30_000);

  it("runModels resolves with the settled status of a quick slot", async () => {
    const sessionPath = teamDirOf(t);
    setupSession(sessionPath, ["fake-answer"], "Reply with exactly PEAR");
    const status = await runModels(sessionPath, paneRunOptions(t));
    expect(Object.values(status.models).map((m) => m.state)).toEqual(["COMPLETED"]);
  }, 30_000);
});
