// packages/cli/src/team-run-summary.contract.test.ts
/**
 * Black-box contract tests for `summarise` and `readTeamStatus` (design §3.3 "Team record";
 * §8.1 test 16). Written from the specification only.
 *
 * `summarise(status)` counts over `Object.values(status.models)` by `state`:
 *   COMPLETED → ok; FAILED/EMPTY/TIMEOUT with error.reason "cancelled" → cancelled;
 *   FAILED/EMPTY/TIMEOUT otherwise → failed; PENDING/RUNNING → failed.
 *   status = "completed" when ok ≥ 1; "cancelled" when cancelled === slots; else "failed".
 *   A `reason` key is present only for start-failed, which summarise never produces.
 *
 * INFERRED: a TeamStatus needs only `models` for summarise; `ModelState` values come from the
 * module when it is a runtime enum (adapter `modelStates()`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTeamStatus, summarise } from "./team-orchestrator.js";
import { modelStates } from "./test-helpers/contract-adapters.js";
import { type TempLayout, makeTempLayout } from "./test-helpers/contract-records.js";

type TeamStatusArg = Parameters<typeof summarise>[0];
const S = modelStates();

interface Slot {
  state: string;
  reason?: string;
}

function status(slots: Slot[]): TeamStatusArg {
  const models: Record<string, unknown> = {};
  slots.forEach((slot, i) => {
    models[`model-${i}`] =
      slot.reason === undefined
        ? { state: slot.state }
        : { state: slot.state, error: { reason: slot.reason, message: slot.reason } };
  });
  return { models } as unknown as TeamStatusArg;
}

const cancelledSlot = (state: string): Slot => ({ state, reason: "cancelled" });
const failedSlot = (state: string, reason = "exit-1"): Slot => ({ state, reason });

describe("REQ-19 summarise counts every ModelState as the table says", () => {
  test("one slot in each of the six states: COMPLETED is ok, the five others are failed", () => {
    const outcome = summarise(
      status([
        { state: S.COMPLETED },
        failedSlot(S.FAILED),
        failedSlot(S.EMPTY),
        failedSlot(S.TIMEOUT),
        { state: S.PENDING },
        { state: S.RUNNING },
      ])
    );

    expect(outcome).toEqual({ status: "completed", slots: 6, ok: 1, failed: 5, cancelled: 0 });
  });

  test.each([S.FAILED, S.EMPTY, S.TIMEOUT])(
    "%s with error.reason 'cancelled' counts as cancelled",
    (state) => {
      const outcome = summarise(status([cancelledSlot(state), { state: S.COMPLETED }]));

      expect(outcome).toEqual({ status: "completed", slots: 2, ok: 1, failed: 0, cancelled: 1 });
    }
  );

  test.each([S.PENDING, S.RUNNING])(
    "%s counts as failed (a slot never started, or just killed)",
    (state) => {
      const outcome = summarise(status([{ state }, { state }]));

      expect(outcome).toEqual({ status: "failed", slots: 2, ok: 0, failed: 2, cancelled: 0 });
    }
  );
});

describe("REQ-19 summarise derives the run's status", () => {
  test("every slot completed → completed", () => {
    expect(
      summarise(status([{ state: S.COMPLETED }, { state: S.COMPLETED }, { state: S.COMPLETED }]))
    ).toEqual({
      status: "completed",
      slots: 3,
      ok: 3,
      failed: 0,
      cancelled: 0,
    });
  });

  test("every slot cancelled → cancelled", () => {
    expect(
      summarise(status([cancelledSlot(S.FAILED), cancelledSlot(S.TIMEOUT), cancelledSlot(S.EMPTY)]))
    ).toEqual({
      status: "cancelled",
      slots: 3,
      ok: 0,
      failed: 0,
      cancelled: 3,
    });
  });

  test("none completed, some failed, some cancelled → failed", () => {
    expect(summarise(status([failedSlot(S.FAILED), cancelledSlot(S.FAILED)]))).toEqual({
      status: "failed",
      slots: 2,
      ok: 0,
      failed: 1,
      cancelled: 1,
    });
  });

  test("one completed among failures and cancellations → completed", () => {
    expect(
      summarise(status([{ state: S.COMPLETED }, failedSlot(S.TIMEOUT), cancelledSlot(S.FAILED)]))
    ).toEqual({
      status: "completed",
      slots: 3,
      ok: 1,
      failed: 1,
      cancelled: 1,
    });
  });

  test("its result never carries a reason key", () => {
    const outcome = summarise(status([failedSlot(S.FAILED)])) as unknown as Record<string, unknown>;

    expect(outcome.reason).toBeUndefined();
  });
});

describe("REQ-20 readTeamStatus reads <path>/status.json and degrades to an empty models map", () => {
  let layout: TempLayout;
  beforeEach(() => {
    layout = makeTempLayout("teamstatus");
  });
  afterEach(() => layout.cleanup());

  test("a readable status.json → its models", () => {
    const models = { "model-a": { state: S.COMPLETED }, "model-b": { state: S.RUNNING } };
    writeFileSync(join(layout.root, "status.json"), JSON.stringify({ models }));

    expect(readTeamStatus(layout.root).models as unknown).toEqual(models);
  });

  test("no status.json → an empty models map, and summarise yields zero slots", () => {
    const read = readTeamStatus(layout.root);

    expect(read.models).toEqual({});
    expect(summarise(read)).toMatchObject({ slots: 0, ok: 0, failed: 0, cancelled: 0 });
  });

  test("a torn status.json (rewritten in place, read mid-write) → an empty models map, not a throw", () => {
    writeFileSync(join(layout.root, "status.json"), '{"models": {"model-a": {"state": "COMP');

    expect(readTeamStatus(layout.root).models).toEqual({});
  });
});
