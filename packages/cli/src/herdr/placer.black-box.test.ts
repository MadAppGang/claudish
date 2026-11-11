import { afterEach, describe, expect, test } from "bun:test";
import type { TeamSlotViewItem } from "../pane/view-contract.js";
import {
  type Harness,
  eventually,
  sessionItem,
  startHarness,
} from "./test-helpers/placer-harness.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});
function callerIntact(r: Harness) {
  expect(r.fake.panes.get(r.userPane)).toMatchObject({ tab_id: r.userTab, user: true });
  expect(r.fake.focusedTab.get("w1")).toBe(r.userTab);
}
function noScratch(r: Harness) {
  expect(r.fake.tabsIn("w1").filter((t) => t.label.startsWith("claudish-new-"))).toEqual([]);
}

describe("herdr placement observable layout", () => {
  test("TEST-29 REQ-15 two simultaneous team slots share one background tab without changing caller focus", async () => {
    h = await startHarness({ kernelLock: false });
    const slots = ["01", "02"].map(
      (slot) =>
        ({
          ...sessionItem(slot),
          kind: "team_slot",
          target: `t:team-run/${slot}`,
          run_id: "team-run",
          run_path: h!.root,
          run_kind: "run",
          slot,
        }) as TeamSlotViewItem
    );

    for (const row of slots) h.upsert(row);
    await eventually(() => expect(h!.fake.placedPanes()).toHaveLength(2));
    await h.placer.whenIdle();

    const tabs = h.fake.tabsIn("w1").filter((t) => t.label === "claudish");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.panes).toHaveLength(2);
    expect(
      h.fake
        .placedPanes()
        .map((p) => p.command?.[2])
        .sort()
    ).toEqual(slots.map((s) => s.target).sort());
    for (const pane of h.fake.placedPanes()) {
      expect(pane.command).toContain("--passive");
      expect(pane.command?.slice(-2)).toEqual(["--front-end", "herdr"]);
      expect(pane.env.CLAUDISH_VIEW_PLACED).toBeTruthy();
      expect(pane.env.CLAUDISH_PANE_ROOT).toBe(h.root);
    }
    callerIntact(h);
    noScratch(h);
  });

  test("TEST-30 REQ-6 REQ-9 REQ-28 unverified socket never produces a viewer; verification places exactly once", async () => {
    h = await startHarness({ kernelLock: false });
    h.upsert(sessionItem("a", { viewSocket: null }));
    await h.placer.whenIdle();

    expect(h.fake.placedPanes()).toEqual([]);
    h.upsert(sessionItem("a"));
    h.upsert(sessionItem("a"));
    await eventually(() => expect(h!.fake.placedPanes()).toHaveLength(1));
    await h.placer.whenIdle();

    expect(h.fake.placedPanes()).toHaveLength(1);
    callerIntact(h);
    noScratch(h);
  });

  test("TEST-31 REQ-18 closed viewer is not replaced by later row changes and does not cancel running item", async () => {
    h = await startHarness({ kernelLock: false, graceMs: 40 });
    const row = sessionItem("a");
    h.upsert(row);
    await eventually(() => expect(h!.fake.placedPanes()).toHaveLength(1));
    const pane = h.fake.placedPanes()[0]!;
    h.fake.exitPane(pane.pane_id);
    // Observation window allows the host's pane-exited event to arrive on its socket.
    await Bun.sleep(50);

    h.upsert({ ...row, tokens_out: 42 } as typeof row);
    await h.placer.whenIdle();
    await Bun.sleep(100);

    expect(h.fake.placedPanes()).toEqual([]);
    expect(h.items.get(row.target)).toMatchObject({ state: "RUNNING", tokens_out: 42 });
    callerIntact(h);
  });

  test("TEST-32 REQ-17 terminal item closes only owned pane after grace", async () => {
    h = await startHarness({ kernelLock: false, graceMs: 40 });
    h.upsert(sessionItem("a"));
    await eventually(() => expect(h!.fake.placedPanes()).toHaveLength(1));

    h.upsert(sessionItem("a", { state: "COMPLETED" }));
    expect(h.fake.placedPanes()).toHaveLength(1);
    await eventually(() => expect(h!.fake.placedPanes()).toEqual([]));

    callerIntact(h);
    noScratch(h);
  });
});
