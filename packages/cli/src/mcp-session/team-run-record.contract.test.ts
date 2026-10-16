// packages/cli/src/channel/team-run-record.contract.test.ts
/**
 * Black-box contract tests for the team-run record and its exactly-once end
 * (design §3.3 "Team record", `finishTeamRun`; §8.1 tests 15, 17b; amendment 4).
 *
 * Drives `SessionManager.recordTeamRun({ teamPath, slots, parentClaudeSessionId })` and
 * `finishTeamRun(record, outcome)` directly, with the documented test override `hostPid`.
 * Outcomes are built with `summarise` (documented), exactly as the `team` handler builds them.
 * INFERRED (adapter): the class is `SessionManager`, constructed with `{ hostPid }`, and it
 * reads CLAUDISH_SESSIONS_DIR at construction or later.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { summarise } from "../team-orchestrator.js";
import {
  type SessionManagerHandle,
  modelStates,
  newSessionManager,
} from "../test-helpers/contract-adapters.js";
import {
  TEAM_RECORD_ID_PATTERN,
  type TempLayout,
  entries,
  makeTempLayout,
  spawnRecordViolations,
  teamRecordDirs,
} from "../test-helpers/contract-records.js";

const HOST_PID = 424_242;
const S = modelStates();

let layout: TempLayout;
let savedSessionsDir: string | undefined;
let handle: SessionManagerHandle;
let teamPath: string;

beforeEach(() => {
  layout = makeTempLayout("teamrec");
  savedSessionsDir = process.env.CLAUDISH_SESSIONS_DIR;
  process.env.CLAUDISH_SESSIONS_DIR = layout.sessionsDir;
  handle = newSessionManager(HOST_PID);
  teamPath = join(layout.root, "team-run-dir");
  mkdirSync(teamPath, { recursive: true });
});
afterEach(async () => {
  await handle.dispose();
  if (savedSessionsDir === undefined) delete process.env.CLAUDISH_SESSIONS_DIR;
  else process.env.CLAUDISH_SESSIONS_DIR = savedSessionsDir;
  for (const dir of teamRecordDirs(layout.sessionsDir))
    chmodSync(join(layout.sessionsDir, dir), 0o755);
  layout.cleanup();
});

const outcomeOf = (states: string[]) =>
  summarise({
    models: Object.fromEntries(states.map((state, i) => [`m${i}`, { state }])),
  } as never);

/** The one team record directory; asserts there is exactly one. */
function onlyRecordDir(): string {
  const dirs = teamRecordDirs(layout.sessionsDir);
  expect(dirs).toHaveLength(1);
  return join(layout.sessionsDir, dirs[0] as string);
}

function readMeta(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Record<string, unknown>;
}

/** Stub both stderr routes, so a line is counted once whichever one the implementation uses. */
function captureStderr() {
  const lines: string[] = [];
  const write = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  const error = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return {
    lines,
    restore() {
      write.mockRestore();
      error.mockRestore();
    },
  };
}

describe("REQ-17 recordTeamRun writes the team's spawn.json", () => {
  test("a team-<8 hex> directory holding only a valid kind:team spawn.json", async () => {
    const record = await handle.recordTeamRun({
      teamPath,
      slots: 3,
      parentClaudeSessionId: "parent-conversation-0001",
    });
    const dir = onlyRecordDir();
    const id = dir.slice(layout.sessionsDir.length + 1);
    const text = readFileSync(join(dir, "spawn.json"), "utf8");

    expect(id).toMatch(TEAM_RECORD_ID_PATTERN);
    expect(typeof record === "string" ? record : id).toBe(id);
    expect(spawnRecordViolations(text, id)).toEqual([]);
    expect(JSON.parse(text)).toEqual({
      schema: 1,
      kind: "team",
      sessionId: id,
      parentClaudeSessionId: "parent-conversation-0001",
      hostPid: HOST_PID,
      mcpPid: process.pid,
      startedAt: expect.any(String),
      teamPath,
      slots: 3,
    });
    expect(entries(dir)).toEqual(["spawn.json"]);
  });

  test.each([
    ["no parent", undefined],
    ["an empty parent", ""],
  ])("with %s, spawn.json has no parentClaudeSessionId key", async (_label, parent) => {
    await handle.recordTeamRun({ teamPath, slots: 2, parentClaudeSessionId: parent });

    const rec = JSON.parse(readFileSync(join(onlyRecordDir(), "spawn.json"), "utf8")) as Record<
      string,
      unknown
    >;

    expect("parentClaudeSessionId" in rec).toBe(false);
  });

  test("two runs get two distinct record ids", async () => {
    await handle.recordTeamRun({ teamPath, slots: 1 });
    await handle.recordTeamRun({ teamPath, slots: 1 });

    const dirs = teamRecordDirs(layout.sessionsDir);

    expect(new Set(dirs).size).toBe(2);
  });
});

describe("REQ-18 finishTeamRun ends the record exactly once", () => {
  test("writes meta.json with the outcome's counts, kind team and the run's timing", async () => {
    const record = await handle.recordTeamRun({ teamPath, slots: 3 });
    const dir = onlyRecordDir();

    await handle.finishTeamRun(record, outcomeOf([S.COMPLETED, S.COMPLETED, S.RUNNING]));
    const meta = readMeta(dir);

    expect(meta).toEqual({
      kind: "team",
      status: "completed",
      startedAt: expect.any(String),
      completedAt: expect.any(String),
      elapsedSeconds: expect.any(Number),
      slots: 3,
      ok: 2,
      failed: 1,
      cancelled: 0,
    });
    expect(Date.parse(meta.completedAt as string)).toBeGreaterThanOrEqual(
      Date.parse(meta.startedAt as string)
    );
    expect(Number.isInteger(meta.elapsedSeconds) && (meta.elapsedSeconds as number) >= 0).toBe(
      true
    );
    expect(entries(dir)).toEqual(["meta.json", "spawn.json"]);
  });

  test("a start failure is recorded as failed with reason start-failed (amendment 4)", async () => {
    const record = await handle.recordTeamRun({ teamPath, slots: 2 });
    const dir = onlyRecordDir();

    await handle.finishTeamRun(record, {
      ...outcomeOf([S.RUNNING, S.PENDING]),
      status: "failed",
      reason: "start-failed",
    });

    expect(readMeta(dir)).toMatchObject({
      kind: "team",
      status: "failed",
      reason: "start-failed",
      slots: 2,
      ok: 0,
      failed: 2,
      cancelled: 0,
    });
  });

  test("a second call is a no-op that keeps the first content and writes one stderr line", async () => {
    const record = await handle.recordTeamRun({ teamPath, slots: 2 });
    const dir = onlyRecordDir();
    await handle.finishTeamRun(record, outcomeOf([S.COMPLETED, S.COMPLETED]));
    const first = readFileSync(join(dir, "meta.json"), "utf8");

    const stderr = captureStderr();
    try {
      await handle.finishTeamRun(record, {
        ...outcomeOf([S.RUNNING, S.RUNNING]),
        status: "failed",
        reason: "start-failed",
      });
    } finally {
      stderr.restore();
    }

    expect(readFileSync(join(dir, "meta.json"), "utf8")).toBe(first);
    expect(stderr.lines.join("").trimEnd().split("\n")).toHaveLength(1);
    expect(entries(dir)).toEqual(["meta.json", "spawn.json"]);
  });

  test("a failed write never throws: the record directory is read-only", async () => {
    const record = await handle.recordTeamRun({ teamPath, slots: 1 });
    const dir = onlyRecordDir();
    chmodSync(dir, 0o555);

    const stderr = captureStderr();
    let thrown: unknown;
    try {
      await handle.finishTeamRun(record, outcomeOf([S.COMPLETED]));
    } catch (err) {
      thrown = err;
    } finally {
      stderr.restore();
    }

    expect(thrown).toBeUndefined();
    expect(existsSync(join(dir, "meta.json"))).toBe(false);
    expect(stderr.lines.length).toBeGreaterThan(0);
  });
});
