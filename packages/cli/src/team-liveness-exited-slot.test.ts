/**
 * A terminal slot carries no liveness: its row has `idle_seconds:null` and
 * `activity:null`, and it is absent from the `*_by_slot` maps, while a sibling still
 * works. Never `waiting_for_input`: a team slot cannot wait for input.
 */

// REGRESSION: team status reported exited slots as `waiting_for_input` with a growing idle clock — Fixed in /dev:fix session dev-fix-20260912-213141-f1fb0c1c

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type TeamHandle,
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

let t: PaneTestEnv;
let handles: TeamHandle[];

beforeEach(() => {
  t = makePaneTestEnv();
  handles = [];
});

afterEach(async () => {
  for (const h of handles) {
    await cancelTeamRun(h.sessionPath, undefined, h.runId).catch(() => undefined);
    await h.done;
  }
  const report = await finishPaneTest(t);
  expect(report).toEqual({ processes: [], files: [] });
});

describe.skipIf(!MAGMUX)("team slot liveness", () => {
  it("omits a terminal slot's liveness while another slot is still running", async () => {
    const sessionPath = teamDirOf(t);
    // fake-answer answers at once; the marker-mode slot hangs on @@HANG@@.
    setupSession(
      sessionPath,
      ["fake-answer", "contract-fake-model"],
      "@@HANG@@ keep the slow slot alive"
    );
    const handle = await startModels(sessionPath, paneRunOptions(t));
    handles.push(handle);

    const fastSlot = handle.slots["fake-answer"] as string;
    const slowSlot = handle.slots["contract-fake-model"] as string;
    await waitUntil(
      () => getStatus(sessionPath).models[fastSlot]?.state === "COMPLETED",
      "the fast slot to complete"
    );
    expect(getStatus(sessionPath).models[slowSlot]?.state).toBe("RUNNING");

    await Bun.sleep(1_100);
    expect(getStatus(sessionPath).models[slowSlot]?.state).toBe("RUNNING");

    const live = teamLiveMaps(sessionPath);
    if (live === null) throw new Error("live slot telemetry disappeared while a slot works");
    const { activity, idle, liveBytes } = live;

    expect(activity).not.toHaveProperty(fastSlot);
    expect(idle).not.toHaveProperty(fastSlot);
    expect(liveBytes).not.toHaveProperty(fastSlot);
    expect(activity).toHaveProperty(slowSlot);
    expect(idle).toHaveProperty(slowSlot);
    expect(liveBytes).toHaveProperty(slowSlot);
    expect(Object.keys(idle)).toEqual(Object.keys(activity));
    expect(Object.keys(liveBytes)).toEqual(Object.keys(activity));
    expect(Object.values(activity)).not.toContain("waiting_for_input");

    const rows = teamRunRow(sessionPath)?.slots ?? [];
    const fast = rows.find((r) => r.slot === fastSlot);
    const slow = rows.find((r) => r.slot === slowSlot);
    expect(fast).toMatchObject({ state: "COMPLETED", idle_seconds: null, activity: null });
    expect(slow?.state).toBe("RUNNING");
    expect(slow?.idle_seconds).toBeGreaterThanOrEqual(1);
    expect(slow?.activity).toBe("thinking");
  }, 30_000);
});
