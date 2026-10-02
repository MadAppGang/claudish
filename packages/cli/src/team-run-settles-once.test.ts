/**
 * A `team(mode:"run")` record ends exactly once.
 *
 * The handler ends the record from `onSettled` when `startModels` returns, and
 * from its `catch` (`failed reason=start-failed`) when `startModels` throws. A
 * review claimed both can run for one fast run: a slot that dies at once lets
 * `done` settle while the spawn loop's rethrow is in flight, and the catch then
 * overwrites the real outcome. These tests reproduce that scenario on the real
 * `startModels` and `SessionManager.finishTeamRun`:
 *
 * 1. a failed start never calls `onSettled`, however fast its spawned slot
 *    exits — `done` is built after the spawn loop, so a throwing loop never
 *    builds it;
 * 2. a run that settles at once calls `onSettled` exactly once, and only after
 *    `startModels` has returned — so the handler's `catch` cannot run for it;
 * 3. a second `finishTeamRun` for one record never replaces the first.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "./channel/session-manager.js";
import { type TeamStatus, getStatus, setupSession, startModels } from "./team-orchestrator.js";

const spawnPlanner = async () => ({ pinned: new Map<string, string>() });
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Until the one spawned slot's end is recorded in `status.json`. The slot whose
 * spawn threw stays `RUNNING` there: it was marked before the throw.
 */
async function waitForSpawnedSlotEnd(sessionPath: string, limitMs = 5_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  const ended = () =>
    Object.values(getStatus(sessionPath).models).some((m) => Boolean(m.completedAt));
  while (!ended()) {
    if (Date.now() > deadline) throw new Error(`the spawned slot never ended: ${sessionPath}`);
    await delay(10);
  }
}

let tempRoot: string;
let originalClaudishBin: string | undefined;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "team-run-settles-once-test-"));
  originalClaudishBin = process.env.CLAUDISH_BIN;
  // A slot that answers and exits at once.
  const fake = join(tempRoot, "claudish");
  writeFileSync(
    fake,
    "#!/bin/sh\ncat > /dev/null\necho 'PONG answer from the fake slot'\nexit 0\n"
  );
  chmodSync(fake, 0o755);
  process.env.CLAUDISH_BIN = fake;
});

afterEach(() => {
  if (originalClaudishBin === undefined) delete process.env.CLAUDISH_BIN;
  else process.env.CLAUDISH_BIN = originalClaudishBin;
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("team run record settles once", () => {
  it("never calls onSettled for a failed start whose spawned slot exits at once", async () => {
    const sessionPath = join(tempRoot, "fast-then-throw");
    setupSession(sessionPath, ["model-a", "model-b"], "ping");

    let first: ChildProcess | undefined;
    let calls = 0;
    const spawnChild = ((command: string, args: string[], options: object) => {
      calls++;
      if (calls === 1) {
        first = spawn(command, args, options);
        return first;
      }
      throw new Error("spawn EMFILE");
    }) as unknown as typeof spawn;

    let settledCalls = 0;
    const error = await startModels(sessionPath, {
      captureMode: "print",
      spawnPlanner,
      spawnChild,
      onSettled: () => {
        settledCalls++;
      },
    }).catch((err: unknown) => err);

    expect((error as Error).message).toBe("spawn EMFILE");
    expect(first).toBeDefined();
    // The first slot's exit and close handlers have run and recorded its end
    // — the path that settles a started run — and a stray settle has had time.
    await waitForSpawnedSlotEnd(sessionPath);
    await delay(300);
    expect(settledCalls).toBe(0);
  });

  it("calls onSettled exactly once, after startModels returned, for a run that settles at once", async () => {
    const sessionPath = join(tempRoot, "fast");
    setupSession(sessionPath, ["model-a", "model-b"], "ping");

    const order: string[] = [];
    const settled: TeamStatus[] = [];
    const handle = await startModels(sessionPath, {
      captureMode: "print",
      spawnPlanner,
      minOutputBytes: 1,
      onSettled: (status) => {
        order.push("settled");
        settled.push(status);
      },
    });
    order.push("returned");

    await handle.done;
    await delay(100);
    expect(order).toEqual(["returned", "settled"]);
    expect(settled).toHaveLength(1);
    // Settled: every slot has an outcome. Which one is not the point here.
    for (const model of Object.values(settled[0].models)) {
      expect(["PENDING", "RUNNING"]).not.toContain(model.state);
    }
  });

  it("keeps the first finishTeamRun outcome when a second call arrives", async () => {
    const manager = new SessionManager({ hostPid: 1, sessionsDir: join(tempRoot, "sessions") });
    try {
      const record = manager.recordTeamRun({ teamPath: tempRoot, slots: 2 });
      manager.finishTeamRun(record, {
        status: "completed",
        slots: 2,
        ok: 2,
        failed: 0,
        cancelled: 0,
      });
      manager.finishTeamRun(record, {
        status: "failed",
        slots: 2,
        ok: 0,
        failed: 2,
        cancelled: 0,
        reason: "start-failed",
      });
      const meta = JSON.parse(
        readFileSync(join(tempRoot, "sessions", record, "meta.json"), "utf-8")
      );
      expect(meta.status).toBe("completed");
      expect(meta.ok).toBe(2);
      expect(meta.reason).toBeUndefined();
    } finally {
      await manager.shutdownAll();
    }
  });
});
