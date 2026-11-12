import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_LIMIT, readHistory } from "./history.js";

let root: string;
let sessionsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claudish-history-"));
  sessionsDir = join(root, "sessions");
  mkdirSync(sessionsDir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A directory whose mtime is `ageS` seconds before a fixed instant, so the order is known. */
function aged(dir: string, ageS: number): void {
  const t = new Date(Date.parse("2026-11-12T12:00:00Z") - ageS * 1000);
  utimesSync(dir, t, t);
}

function session(id: string, ageS: number, meta: Record<string, unknown>): void {
  const dir = join(sessionsDir, id);
  mkdirSync(dir);
  writeFileSync(
    join(dir, "spawn.json"),
    JSON.stringify({ kind: "session", sessionId: id, startedAt: "2026-11-12T11:00:00Z" })
  );
  writeFileSync(join(dir, "prompt.md"), "Explain the view claims\n\nmore text");
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ sessionId: id, ...meta }));
  aged(dir, ageS);
}

function teamRun(recordId: string, ageS: number, runPath: string, status: Record<string, unknown>) {
  mkdirSync(runPath, { recursive: true });
  writeFileSync(join(runPath, "status.json"), JSON.stringify(status));
  const dir = join(sessionsDir, recordId);
  mkdirSync(dir);
  writeFileSync(
    join(dir, "spawn.json"),
    JSON.stringify({ kind: "team", sessionId: recordId, startedAt: "x", teamPath: runPath })
  );
  aged(dir, ageS);
}

const FAILED_META = {
  state: "FAILED",
  status: "failed",
  model: "gpt-6-luna",
  startedAt: "2026-11-12T11:00:00Z",
  completedAt: "2026-11-12T11:00:01Z",
  terminalReason: "child_exited",
  detail: "pane child exited with code 1",
  turnsCompleted: 0,
  toolCallCount: 0,
  taskType: "explain",
};

describe("readHistory: finished runs from their records, with no server", () => {
  test("a failed session, a completed one and a team run, newest first", () => {
    session("aaaa1111", 30, FAILED_META);
    session("bbbb2222", 300, {
      ...FAILED_META,
      state: "COMPLETED",
      status: "completed",
      terminalReason: null,
      detail: null,
      turnsCompleted: 2,
      agent: "dev:architect",
    });
    teamRun("team-0000abcd", 120, join(root, "work", "viewclaims"), {
      runId: "viewclaims-mwcx0000-a1b2c3",
      kind: "run",
      startedAt: "2026-11-12T11:30:00Z",
      taskType: "research",
      models: {
        "01": {
          model: "gpt-6-luna",
          state: "COMPLETED",
          agent: "dev:reviewer",
          completedAt: "2026-11-12T11:40:00Z",
        },
        "02": { model: "kimi-k3", state: "FAILED", error: { reason: "api_error", detail: "429" } },
      },
    });

    const items = readHistory({ sessionsDir });
    expect(items.map((i) => i.target)).toEqual([
      "s:aaaa1111",
      "t:viewclaims-mwcx0000-a1b2c3/01",
      "t:viewclaims-mwcx0000-a1b2c3/02",
      "s:bbbb2222",
    ]);
    const failed = items[0];
    expect(failed).toMatchObject({
      kind: "session",
      state: "FAILED",
      reason: "child_exited",
      task_type: "explain",
      turns_completed: 0,
      prompt_summary: "Explain the view claims",
      view: null,
      magmux: null,
    });
    expect(failed?.kind === "session" && failed.reason_detail).toContain("exited with code 1");
    expect(items[1]).toMatchObject({
      kind: "team_slot",
      run_id: "viewclaims-mwcx0000-a1b2c3",
      run_path: join(root, "work", "viewclaims"),
      run_kind: "run",
      slot: "01",
      state: "COMPLETED",
      agent: "dev:reviewer",
      task_type: "research",
    });
    expect(items[2]).toMatchObject({ state: "FAILED", reason: "api_error" });
  });

  test("a run path reused by a newer run lists that run once", () => {
    const path = join(root, "work", "same");
    const status = {
      runId: "same-mwcx0001-a1b2c3",
      kind: "run",
      startedAt: "2026-11-12T11:30:00Z",
      models: { "01": { model: "m", state: "COMPLETED" } },
    };
    teamRun("team-00000001", 60, path, status);
    // the older record names the same directory, whose status.json now holds the newer run
    const older = join(sessionsDir, "team-00000002");
    mkdirSync(older);
    writeFileSync(
      join(older, "spawn.json"),
      JSON.stringify({ kind: "team", sessionId: "team-00000002", startedAt: "x", teamPath: path })
    );
    aged(older, 600);
    expect(readHistory({ sessionsDir }).map((i) => i.target)).toEqual([
      "t:same-mwcx0001-a1b2c3/01",
    ]);
  });

  test("at most `limit` runs, the newest; a team run counts once", () => {
    for (let i = 0; i < HISTORY_LIMIT + 5; i++)
      session(`c${String(i).padStart(7, "0")}`, 1000 + i, FAILED_META);
    teamRun("team-0000ffff", 1, join(root, "work", "t"), {
      runId: "t-mwcx0002-a1b2c3",
      kind: "run",
      startedAt: "2026-11-12T11:30:00Z",
      models: {
        "01": { model: "m", state: "COMPLETED" },
        "02": { model: "n", state: "COMPLETED" },
      },
    });
    const items = readHistory({ sessionsDir });
    expect(items).toHaveLength(HISTORY_LIMIT + 1);
    expect(items[0]?.target).toBe("t:t-mwcx0002-a1b2c3/01");
    expect(items.at(-1)?.target).toBe(`s:c${String(HISTORY_LIMIT - 2).padStart(7, "0")}`);
    expect(readHistory({ sessionsDir, limit: 2 }).map((i) => i.target)).toEqual([
      "t:t-mwcx0002-a1b2c3/01",
      "t:t-mwcx0002-a1b2c3/02",
      "s:c0000000",
    ]);
  });

  test("no sessions directory, unreadable records and stray files read as nothing", () => {
    expect(readHistory({ sessionsDir: join(root, "absent") })).toEqual([]);
    writeFileSync(join(sessionsDir, "stray.txt"), "x");
    mkdirSync(join(sessionsDir, "team-dead0000"));
    writeFileSync(join(sessionsDir, "team-dead0000", "spawn.json"), "{not json");
    expect(readHistory({ sessionsDir })).toEqual([]);
  });
});
