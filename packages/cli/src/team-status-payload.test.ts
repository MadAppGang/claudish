import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTeamStatusPayload, teamStatusNote } from "./mcp-server.js";
import { CAPABILITIES, type TeamRunRow } from "./pane/index.js";
import { type ModelStatus, type TeamStatus, teamRunRowFromDisk } from "./team-orchestrator.js";

const PATH = "/tmp/team-status-payload-test";

function slot(state: ModelStatus["state"], outputSize: number): ModelStatus {
  return {
    state,
    exitCode: state === "COMPLETED" ? 0 : null,
    startedAt: "2026-09-09T00:00:00.000Z",
    completedAt: state === "COMPLETED" ? "2026-09-09T00:22:00.000Z" : null,
    outputSize,
  };
}

function runOf(status: TeamStatus): TeamRunRow {
  return teamRunRowFromDisk(PATH, status);
}

describe("teamStatusNote", () => {
  test("omits the note for settled runs regardless of liveness", () => {
    expect(teamStatusNote({ anyActive: false, live: false })).toBeUndefined();
    expect(teamStatusNote({ anyActive: false, live: true })).toBeUndefined();
  });

  test("names outputSize and all three live fields for working live slots", () => {
    const note = teamStatusNote({ anyActive: true, live: true });

    expect(typeof note).toBe("string");
    expect(note).toContain("outputSize");
    expect(note).toContain("live_output_bytes_by_slot");
    expect(note).toContain("idle_seconds_by_slot");
    expect(note).toContain("activity_by_slot");
  });

  test("puts the outputSize trap before the live-field remedy", () => {
    const note = teamStatusNote({ anyActive: true, live: true }) ?? "";
    const trapIndex = note.indexOf("outputSize");
    const remedyIndex = note.indexOf("live_output_bytes_by_slot");

    // A missing warning has index -1, which would otherwise pass the ordering check.
    expect(trapIndex).toBeGreaterThanOrEqual(0);
    expect(remedyIndex).toBeGreaterThanOrEqual(0);
    expect(trapIndex).toBeLessThan(remedyIndex);
  });

  test("warns about outputSize without naming unavailable live fields", () => {
    const note = teamStatusNote({ anyActive: true, live: false });

    expect(note).toContain("outputSize");
    expect(note).not.toContain("live_output_bytes_by_slot");
    expect(note).not.toContain("idle_seconds_by_slot");
    expect(note).not.toContain("activity_by_slot");
  });

  test("tells the caller to cancel a slot whose end-of-turn record is missing (R3-M4)", () => {
    const note = teamStatusNote({ anyActive: true, live: true, endRecordMissing: ["02"] }) ?? "";

    expect(note).toContain("02");
    expect(note).toContain("turn_end_record_missing");
    expect(note).toContain("cancel");
    expect(teamStatusNote({ anyActive: true, live: true }) ?? "").not.toContain(
      "turn_end_record_missing"
    );
  });
});

describe("teamRunRowFromDisk", () => {
  test("a SETTLED run whose rows carry no completedAt still has a finished_at", () => {
    const dir = mkdtempSync(join(tmpdir(), "team-disk-row-"));
    try {
      const status = {
        startedAt: "2026-09-09T00:00:00.000Z",
        models: {
          "01": { ...slot("CANCELLED", 0), completedAt: undefined },
          "02": { ...slot("CANCELLED", 0), completedAt: undefined },
        },
      } as unknown as TeamStatus;
      writeFileSync(join(dir, "status.json"), JSON.stringify(status));
      const row = teamRunRowFromDisk(dir, status);
      expect(row.state).toBe("SETTLED");
      expect(typeof row.finished_at).toBe("string");
      expect(Date.parse(row.finished_at as string)).toBeGreaterThan(Date.parse(status.startedAt));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildTeamStatusPayload", () => {
  test("a pre-contract slot state reads in the closed SlotState set, as run does", () => {
    const status = {
      startedAt: "2026-09-09T00:00:00.000Z",
      models: { "01": { ...slot("COMPLETED", 10), state: "PENDING" } },
    } as unknown as TeamStatus;
    const payload = buildTeamStatusPayload({
      status,
      sessionPath: PATH,
      idle: null,
      activity: null,
      liveBytes: null,
      run: {} as never,
    }) as { models: Record<string, { state: string; outputSize: number }> };
    expect(payload.models["01"]?.state).toBe("FAILED");
    expect(payload.models["01"]?.outputSize).toBe(10); // every other legacy field kept
  });

  test("carries live bytes without rewriting outputSize and includes a note, not a summary", () => {
    const status: TeamStatus = {
      startedAt: "2026-09-09T00:00:00.000Z",
      models: { "01": slot("RUNNING", 0), "02": slot("COMPLETED", 31112) },
    };
    const payload = buildTeamStatusPayload({
      status,
      sessionPath: PATH,
      idle: { "01": 2 },
      activity: { "01": "Bash" },
      liveBytes: { "01": 18342 },
      run: runOf(status),
    });

    expect(payload.live_output_bytes_by_slot).toEqual({ "01": 18342 });
    expect((payload.models as TeamStatus["models"])["01"].outputSize).toBe(0);
    expect(status.models["01"].outputSize).toBe(0);
    expect(payload).toHaveProperty("note");
    expect(payload.note).toContain("outputSize");
    expect(payload).not.toHaveProperty("summary");
  });

  test("keys the note on any non-terminal slot, not only RUNNING", () => {
    for (const state of ["STARTING", "AWAITING_INPUT", "AWAITING_PERMISSION"] as const) {
      const status: TeamStatus = {
        startedAt: "2026-09-09T00:00:00.000Z",
        models: { "01": slot(state, 0), "02": slot("COMPLETED", 10) },
      };
      const payload = buildTeamStatusPayload({
        status,
        sessionPath: PATH,
        idle: {},
        activity: {},
        liveBytes: {},
        run: runOf(status),
      });
      expect(payload).toHaveProperty("note");
      expect(payload).not.toHaveProperty("summary");
    }
  });

  test("includes a summary and no note when every slot is terminal", () => {
    const status: TeamStatus = {
      startedAt: "2026-09-09T00:00:00.000Z",
      models: { "01": slot("COMPLETED", 18342), "02": slot("CANCELLED", 0) },
    };
    const payload = buildTeamStatusPayload({
      status,
      sessionPath: PATH,
      idle: null,
      activity: null,
      liveBytes: null,
      run: runOf(status),
    });

    expect(payload).toHaveProperty("summary");
    expect(typeof payload.summary).toBe("string");
    expect(payload.summary).toContain("status: partial — 1/2 succeeded");
    expect(payload).not.toHaveProperty("note");
  });

  test("keeps the note for an orphaned running slot with null liveness fields", () => {
    const status: TeamStatus = {
      startedAt: "2026-09-09T00:00:00.000Z",
      models: { "01": slot("RUNNING", 0) },
    };
    const payload = buildTeamStatusPayload({
      status,
      sessionPath: PATH,
      idle: null,
      activity: null,
      liveBytes: null,
      run: runOf(status),
    });

    expect(payload).toHaveProperty("note");
    expect(payload.note).toContain("outputSize");
    expect(payload.live_output_bytes_by_slot).toBeNull();
    expect(payload.idle_seconds_by_slot).toBeNull();
    expect(payload.activity_by_slot).toBeNull();
  });

  test("adds contract_version, capabilities and the run row (CA-12, §8 B)", () => {
    const status: TeamStatus = {
      startedAt: "2026-09-09T00:00:00.000Z",
      runId: "team-x-abc-123456",
      models: { "01": slot("COMPLETED", 5) },
    };
    const payload = buildTeamStatusPayload({
      status,
      sessionPath: PATH,
      idle: null,
      activity: null,
      liveBytes: null,
      run: runOf(status),
    });

    expect(payload.contract_version).toBe(1);
    expect(payload.capabilities).toEqual([...CAPABILITIES]);
    const run = payload.run as TeamRunRow;
    expect(run.run_id).toBe("team-x-abc-123456");
    expect(run.state).toBe("SETTLED");
    expect(run.outcome).toBe("ok");
    expect(run.slots.map((s) => [s.slot, s.state, s.idle_seconds, s.activity])).toEqual([
      ["01", "COMPLETED", null, null],
    ]);
  });
});

describe("teamRunRowFromDisk", () => {
  test("reads a pre-contract state outside the closed set as FAILED with reason null", () => {
    const status = {
      startedAt: "2026-09-09T00:00:00.000Z",
      models: { "01": { ...slot("COMPLETED", 0), state: "PENDING" } },
    } as unknown as TeamStatus;
    const run = runOf(status);

    expect(run.slots[0]?.state).toBe("FAILED");
    expect(run.slots[0]?.reason).toBeNull();
  });

  test("reports a CANCELLED row's reason and an ACTIVE run with outcome null", () => {
    const status: TeamStatus = {
      startedAt: "2026-09-09T00:00:00.000Z",
      models: {
        "01": {
          ...slot("CANCELLED", 0),
          error: {
            model: "01",
            command: "claudish",
            reason: "cancelled",
            detail: "stopped",
            errorLogPath: `${PATH}/errors/01.log`,
            workDir: PATH,
          },
        },
        "02": slot("RUNNING", 0),
      },
    };
    const run = runOf(status);

    expect(run.state).toBe("ACTIVE");
    expect(run.outcome).toBeNull();
    expect(run.finished_at).toBeNull();
    expect(run.slots[0]?.reason).toBe("cancelled");
    expect(run.slots[1]?.reason).toBeNull();
  });
});
