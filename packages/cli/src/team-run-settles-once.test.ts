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
 * 1. a failed start never calls `onSettled`, however fast its started slot
 *    answers — `done` is built after the spawn loop, so a throwing loop never
 *    builds it;
 * 2. a run that settles at once calls `onSettled` exactly once, and only after
 *    `startModels` has returned — so the handler's `catch` cannot run for it;
 * 3. a second `finishTeamRun` for one record never replaces the first.
 *
 * Ported to panes (architecture §20.2): the print-mode `/bin/sh` fake is the pane fake
 * in a real headless magmux, and the spawn throw is a failed status.json write after slot
 * 1's pane started. All three properties are kept.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "./channel/session-manager.js";
import { waitNoOrphans } from "./pane/test-helpers/hermetic-env.js";
import { type TeamStatus, setupSession, startModels } from "./team-orchestrator.js";
import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type PaneTestEnv,
  finishPaneTest,
  makePaneTestEnv,
  paneRunOptions,
  waitUntil,
} from "./test-helpers/team-pane.js";

if (!MAGMUX) console.warn(NO_MAGMUX_MESSAGE);

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let tempRoot: string;
let panes: PaneTestEnv;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "team-run-settles-once-test-"));
  panes = makePaneTestEnv();
});

afterEach(async () => {
  for (const dir of readdirSync(tempRoot)) {
    try {
      chmodSync(join(tempRoot, dir, "status.json"), 0o644);
    } catch {
      // not a team dir
    }
  }
  rmSync(tempRoot, { recursive: true, force: true });
  const report = await finishPaneTest(panes);
  expect(report).toEqual({ processes: [], files: [] });
});

describe("team run record settles once", () => {
  it.skipIf(!MAGMUX)(
    "never calls onSettled for a failed start whose started slot answers at once",
    async () => {
      const sessionPath = join(tempRoot, "fast-then-throw");
      // fake-answer answers the moment its prompt is accepted.
      setupSession(sessionPath, ["fake-answer", "model-b"], "ping");

      let settledCalls = 0;
      const run = startModels(sessionPath, {
        ...paneRunOptions(panes),
        onSettled: () => {
          settledCalls++;
        },
      }).catch((err: unknown) => err);
      // The fault: slot 1's pane record exists, so status.json turns read-only and slot
      // 2's STARTING write throws (was: slot 2's spawn threw EMFILE).
      await waitUntil(
        () => {
          const recs = join(panes.sockRoot, "panes");
          return existsSync(recs) && readdirSync(recs).length > 0;
        },
        "slot 1's pane record",
        5_000,
        5
      );
      chmodSync(join(sessionPath, "status.json"), 0o444);
      const error = await run;

      expect((error as NodeJS.ErrnoException).code).toBe("EACCES");
      // The started slot is gone — the path that would settle a started run — and a stray
      // settle has had time.
      expect(await waitNoOrphans({ sockRoot: panes.sockRoot }, 5_000)).toEqual({
        processes: [],
        files: [],
      });
      await delay(300);
      expect(settledCalls).toBe(0);
    },
    30_000
  );

  it.skipIf(!MAGMUX)(
    "calls onSettled exactly once, after startModels returned, for a run that settles at once",
    async () => {
      const sessionPath = join(tempRoot, "fast");
      setupSession(sessionPath, ["model-a", "model-b"], "ping");

      const order: string[] = [];
      const settled: TeamStatus[] = [];
      const handle = await startModels(sessionPath, {
        ...paneRunOptions(panes),
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
      for (const model of Object.values(settled[0]?.models ?? {})) {
        expect(["STARTING", "RUNNING", "AWAITING_INPUT", "AWAITING_PERMISSION"]).not.toContain(
          model.state
        );
      }
    },
    30_000
  );

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

  it("does not spend the record's one end on a write that failed", async () => {
    const sessionsDir = join(tempRoot, "sessions");
    const manager = new SessionManager({ hostPid: 1, sessionsDir });
    const outcome = { status: "completed", slots: 1, ok: 1, failed: 0, cancelled: 0 } as const;
    try {
      const record = manager.recordTeamRun({ teamPath: tempRoot, slots: 1 });
      const metaPath = join(sessionsDir, record, "meta.json");
      // A non-empty directory where meta.json goes: the rename onto it fails.
      mkdirSync(join(metaPath, "blocker"), { recursive: true });
      manager.finishTeamRun(record, outcome);
      expect(statSync(metaPath).isDirectory()).toBe(true);

      rmSync(metaPath, { recursive: true, force: true });
      manager.finishTeamRun(record, outcome);
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      expect(meta.status).toBe("completed");
      expect(meta.ok).toBe(1);
    } finally {
      await manager.shutdownAll();
    }
  });
});
