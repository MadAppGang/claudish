/**
 * Process shutdown with team runs in flight (§20.3 item 8): `shutdownAllTeamRuns` ends
 * every run's RECORD before it resolves — including a run still in its D9 window and one
 * still in its staggered spawn loop, which is not in the registry yet.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { livePaneCount } from "./pane/pane-registry.js";
import {
  type TeamStatus,
  getStatus,
  setupSession,
  shutdownAllTeamRuns,
  startModels,
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

const T = 30_000;
let t: PaneTestEnv;

beforeEach(() => {
  t = makePaneTestEnv();
});

afterEach(async () => {
  await shutdownAllTeamRuns();
  const report = await finishPaneTest(t);
  expect(report).toEqual({ processes: [], files: [] });
});

describe.skipIf(!MAGMUX)("shutdownAllTeamRuns", () => {
  it(
    "a run in its D9 window: every slot CANCELLED and onSettled has run before shutdown resolves",
    async () => {
      const sessionPath = teamDirOf(t);
      setupSession(sessionPath, ["fake-slow_boot-1", "fake-slow_boot-2"], "Answer.");
      let settled: TeamStatus | null = null;
      const start = startModels(
        sessionPath,
        paneRunOptions(
          t,
          {
            onSettled: (s) => {
              settled = structuredClone(s);
            },
          },
          { FAKE_GAP_MS_BOOT: "8000" }
        )
      );
      // registered (both panes exist) but still STARTING: start has not returned yet (D9)
      await waitUntil(() => teamRunRow(sessionPath) !== null, "the run registered", 10_000);
      await shutdownAllTeamRuns();
      expect(settled).not.toBeNull();
      const s = settled as unknown as TeamStatus;
      for (const m of Object.values(s.models)) {
        expect(m.state).toBe("CANCELLED");
        expect(m.error?.reason).toBe("cancelled");
      }
      await start;
    },
    T
  );

  it(
    "a run still in its spawn loop: no further pane starts, the start rejects, nothing is left",
    async () => {
      const sessionPath = teamDirOf(t);
      const models = ["fake-hang-1", "fake-hang-2", "fake-hang-3", "fake-hang-4"];
      setupSession(sessionPath, models, "Answer.");
      const start = startModels(sessionPath, paneRunOptions(t));
      const outcome = start.then(
        () => "resolved",
        (e: unknown) => String(e)
      );
      // the first slot is up; the loop is staggering towards the second
      await waitUntil(
        () => Object.values(getStatus(sessionPath).models).some((m) => m.startedAt !== null),
        "the first slot spawned",
        10_000
      );
      await shutdownAllTeamRuns();
      expect(await outcome).toMatch(/cancelled: the server is shutting down/);
      expect(teamRunRow(sessionPath)).toBeNull();
      // a slot that was spawned has a startedAt; the unwind leaves its row as it was
      const started = Object.values(getStatus(sessionPath).models).filter(
        (m) => m.startedAt !== null
      ).length;
      expect(started).toBeGreaterThan(0);
      expect(started).toBeLessThan(models.length);
      await waitUntil(() => livePaneCount(t.sockRoot) === 0, "every started pane reaped", 10_000);
    },
    T
  );
});
