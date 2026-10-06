/**
 * Cancelling a team run on panes (contract C): the transition is synchronous, the reap is
 * asynchronous, a second call returns `changed:false`, and nothing of a cancelled pane
 * survives — no process, socket, record or launcher dir in the test's sockRoot.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ContractErrorException } from "./pane/index.js";
import {
  type TeamHandle,
  type TeamStatus,
  cancelTeamRun,
  getStatus,
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

const HANG = "@@HANG@@ Wait until the caller cancels this run.";
const T = 30_000;

let t: PaneTestEnv;
let handles: TeamHandle[];

function makeSession(name: string, models: string[]): string {
  const sessionPath = teamDirOf(t, name);
  setupSession(sessionPath, models, HANG);
  return sessionPath;
}

async function startSlowTeam(sessionPath: string): Promise<TeamHandle> {
  const handle = await startModels(sessionPath, paneRunOptions(t));
  handles.push(handle);
  return handle;
}

async function waitForSlotToStop(sessionPath: string, slotId: string): Promise<TeamStatus> {
  await waitUntil(
    () => getStatus(sessionPath).models[slotId]?.state === "CANCELLED",
    `slot ${slotId} CANCELLED in status.json`,
    3_000
  );
  return getStatus(sessionPath);
}

beforeEach(() => {
  t = makePaneTestEnv();
  handles = [];
});

afterEach(async () => {
  for (const handle of handles) {
    await cancelTeamRun(handle.sessionPath, undefined, handle.runId).catch(() => undefined);
    await handle.done;
  }
  const report = await finishPaneTest(t);
  expect(report).toEqual({ processes: [], files: [] });
});

describe.skipIf(!MAGMUX)("team run cancellation", () => {
  it(
    "reports live bytes for a zero-output slot, and none once the run settled",
    async () => {
      const sessionPath = makeSession("live-bytes", ["contract-fake-model"]);
      const handle = await startSlowTeam(sessionPath);
      const slotId = handle.slots["contract-fake-model"] as string;

      const live = teamLiveMaps(sessionPath);
      expect(live).not.toBeNull();
      expect(live?.liveBytes).toHaveProperty(slotId, 0);
      expect(Object.keys(live?.liveBytes ?? {})).toEqual(Object.keys(live?.idle ?? {}));
      expect(live?.activity[slotId]).toBe("thinking");

      await cancelTeamRun(sessionPath);
      await handle.done;
      expect(teamLiveMaps(sessionPath)).toEqual({
        idle: {},
        activity: {},
        liveBytes: {},
        endRecordMissing: [],
      });
    },
    T
  );

  it(
    "returns once the prompt is accepted; cancel is synchronous and idempotent",
    async () => {
      const sessionPath = makeSession("live", ["contract-fake-model"]);
      const handle = await startSlowTeam(sessionPath);
      const slotId = handle.slots["contract-fake-model"] as string;

      expect(slotId).toMatch(/^\d{2,}$/);
      expect(getStatus(sessionPath).models[slotId]?.state).toBe("RUNNING");
      expect(teamRunRow(sessionPath)?.slots[0]?.state).toBe("RUNNING");

      const cancelled = await cancelTeamRun(sessionPath);
      expect(cancelled).toEqual({
        run_id: handle.runId,
        path: sessionPath,
        results: [{ slot: slotId, state: "CANCELLED", changed: true }],
      });
      // The state is CANCELLED when cancel returns, before the reap finished.
      expect(teamRunRow(sessionPath)?.slots[0]?.state).toBe("CANCELLED");
      const again = await cancelTeamRun(sessionPath, undefined, handle.runId);
      expect(again.results).toEqual([{ slot: slotId, state: "CANCELLED", changed: false }]);
      await handle.done;
    },
    T
  );

  it(
    "cancels one slot while leaving the other slot running",
    async () => {
      const sessionPath = makeSession("one-slot", ["contract-fake-a", "contract-fake-b"]);
      const handle = await startSlowTeam(sessionPath);
      const cancelledSlot = handle.slots["contract-fake-a"] as string;
      const survivingSlot = handle.slots["contract-fake-b"] as string;

      const result = await cancelTeamRun(sessionPath, cancelledSlot);
      expect(result.results).toEqual([{ slot: cancelledSlot, state: "CANCELLED", changed: true }]);

      const status = await waitForSlotToStop(sessionPath, cancelledSlot);
      expect(status.models[cancelledSlot]?.error?.reason).toBe("cancelled");
      expect(status.models[survivingSlot]?.state).toBe("RUNNING");
      expect(typeof teamLiveMaps(sessionPath)?.idle[survivingSlot]).toBe("number");
      expect(teamRunRow(sessionPath)?.state).toBe("ACTIVE");

      await cancelTeamRun(sessionPath, survivingSlot);
      await handle.done;
    },
    T
  );

  it(
    "cancels every slot when no slot id is supplied; the run settles all-failed",
    async () => {
      const sessionPath = makeSession("all-slots", ["contract-fake-a", "contract-fake-b"]);
      const handle = await startSlowTeam(sessionPath);
      const expectedSlots = Object.values(handle.slots).sort();

      const result = await cancelTeamRun(sessionPath);
      expect(result.results.map((r) => r.slot)).toEqual(expectedSlots);
      expect(result.results.every((r) => r.changed && r.state === "CANCELLED")).toBe(true);

      const settled = await handle.done;
      for (const slotId of expectedSlots) {
        expect(settled.models[slotId]?.state).toBe("CANCELLED");
        expect(settled.models[slotId]?.error?.reason).toBe("cancelled");
      }
      const row = teamRunRow(sessionPath);
      expect(row?.state).toBe("SETTLED");
      expect(row?.outcome).toBe("all-failed");
      expect(row?.slots.every((s) => s.reason === "cancelled" && s.idle_seconds === null)).toBe(
        true
      );
    },
    T
  );

  it("answers an unknown run and an unknown slot as contract errors", async () => {
    const unknown = await cancelTeamRun(teamDirOf(t, "never-started")).catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(ContractErrorException);
    expect((unknown as ContractErrorException).code).toBe("unknown_run");

    const byId = await cancelTeamRun(undefined, undefined, "nope-0-000000").catch((e) => e);
    expect((byId as ContractErrorException).code).toBe("unknown_run");
  });

  it(
    "answers an unknown slot of a known run as unknown_slot",
    async () => {
      const sessionPath = makeSession("bad-slot", ["contract-fake-model"]);
      const handle = await startSlowTeam(sessionPath);
      const err = await cancelTeamRun(sessionPath, "99").catch((e: unknown) => e);
      expect((err as ContractErrorException).code).toBe("unknown_slot");
      await cancelTeamRun(sessionPath, undefined, handle.runId);
      await handle.done;
    },
    T
  );
});
