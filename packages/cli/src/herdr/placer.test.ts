import { afterEach, describe, expect, test } from "bun:test";
import { Held } from "../pane/test-helpers/fake-herdr.js";
import { placementToken } from "./placement-grants.js";
import { CLAUDISH_TAB, SCRATCH_PREFIX } from "./placer.js";
import {
  type Harness,
  eventually,
  replayItem,
  sessionItem,
  startHarness,
} from "./test-helpers/placer-harness.js";

let h: Harness | null = null;
afterEach(async () => {
  await h?.stop();
  h = null;
});

function scratchTabs(x: Harness): string[] {
  return x.fake
    .tabsIn("w1")
    .filter((t) => t.label.startsWith(SCRATCH_PREFIX))
    .map((t) => t.label);
}

function userPanesIntact(x: Harness): void {
  expect(x.fake.panes.get(x.userPane)?.tab_id).toBe(x.userTab);
  expect(x.fake.tabs.get(x.userTab)?.label).toBe("1");
}

function claudishPanes(x: Harness): string[] {
  return x.fake.tabByLabel("w1", CLAUDISH_TAB)?.panes ?? [];
}

describe("HerdrPlacer: placing", () => {
  test("first pane: a scratch tab by layout.apply, renamed claudish; the user's tab untouched", async () => {
    h = await startHarness();
    h.upsert(sessionItem("a"));
    await eventually(() => expect(claudishPanes(h as Harness)).toHaveLength(1));
    const apply = h.fake.callsOf("layout.apply")[0];
    expect(apply?.params.tab_label).toBe(`${SCRATCH_PREFIX}${h.tokens[0]}`);
    expect(apply?.params.focus).toBe(false);
    expect(apply?.params.workspace_id).toBe("w1");
    const root = apply?.params.root as Record<string, unknown>;
    expect(root.type).toBe("pane");
    expect(root.command).toEqual([
      "/usr/bin/claudish",
      "view",
      "s:a",
      "--passive",
      "--front-end",
      "herdr",
    ]);
    expect((root.env as Record<string, string>).CLAUDISH_VIEW_PLACED).toBe("c1-abc.sock");
    expect(h.fake.callsOf("tab.rename")).toHaveLength(1);
    expect(h.fake.focusedTab.get("w1")).toBe(h.userTab);
    expect(h.fake.callsOf("pane.split")).toHaveLength(0);
    expect(h.fake.callsOf("pane.zoom")).toHaveLength(0);
    userPanesIntact(h);
  });

  test("second pane: layout.apply then pane.move into the claudish tab; herdr closes the scratch tab", async () => {
    h = await startHarness();
    h.upsert(sessionItem("a"));
    await eventually(() => expect(claudishPanes(h as Harness)).toHaveLength(1));
    const first = claudishPanes(h)[0];
    h.upsert(sessionItem("b"));
    await eventually(() => expect(claudishPanes(h as Harness)).toHaveLength(2));
    const move = h.fake.callsOf("pane.move")[0];
    const dest = move?.params.destination as Record<string, unknown>;
    expect(dest.tab_id).toBe(h.fake.tabByLabel("w1", CLAUDISH_TAB)?.tab_id);
    expect(dest.target_pane_id).toBe(first);
    expect(move?.params.focus).toBe(false);
    expect(scratchTabs(h)).toEqual([]);
    expect(h.fake.tabsIn("w1").filter((t) => t.label === CLAUDISH_TAB)).toHaveLength(1);
    userPanesIntact(h);
  });

  test("two items at once (a 2-slot team start): one claudish tab, two panes", async () => {
    h = await startHarness();
    h.upsert(sessionItem("a"));
    h.upsert(sessionItem("b"));
    await eventually(() => expect(claudishPanes(h as Harness)).toHaveLength(2));
    expect(h.fake.tabsIn("w1").filter((t) => t.label === CLAUDISH_TAB)).toHaveLength(1);
    expect(scratchTabs(h)).toEqual([]);
  });

  test("an item without a verified view socket gets no pane, and one already placed gets no second", async () => {
    h = await startHarness();
    h.upsert(sessionItem("a", { viewSocket: null }));
    await Bun.sleep(100);
    expect(h.fake.callsOf("layout.apply")).toHaveLength(0);
    h.upsert(sessionItem("a"));
    h.upsert(sessionItem("a"));
    await eventually(() => expect(claudishPanes(h as Harness)).toHaveLength(1));
    await h.placer.whenIdle();
    expect(h.fake.callsOf("layout.apply")).toHaveLength(1);
  });

  test("a zoomed claudish tab: the scratch pane is closed, the placement parked until herdr reports it unzoomed; pane.zoom is never called", async () => {
    h = await startHarness();
    h.upsert(sessionItem("a"));
    await eventually(() => expect(claudishPanes(h as Harness)).toHaveLength(1));
    const tab = h.fake.tabByLabel("w1", CLAUDISH_TAB);
    if (!tab) throw new Error("no claudish tab");
    h.fake.zoom(tab.tab_id, true);
    h.upsert(sessionItem("b"));
    await eventually(() => expect(h?.fake.callsOf("pane.move")[0]?.outcome).toBe("replied"));
    await h.placer.whenIdle();
    expect(claudishPanes(h)).toHaveLength(1);
    expect(scratchTabs(h)).toEqual([]);
    expect(h.fake.placedPanes()).toHaveLength(1);
    h.fake.zoom(tab.tab_id, false);
    await eventually(() => expect(claudishPanes(h as Harness)).toHaveLength(2));
    expect(h.fake.callsOf("pane.zoom")).toHaveLength(0);
  });

  test("a parked replay placement whose item ends gives its reservation back", async () => {
    h = await startHarness();
    h.upsert(sessionItem("a"));
    await eventually(() => expect(claudishPanes(h as Harness)).toHaveLength(1));
    const tab = h.fake.tabByLabel("w1", CLAUDISH_TAB);
    if (!tab) throw new Error("no claudish tab");
    h.fake.zoom(tab.tab_id, true);
    h.items.set("r:replay-1", replayItem("replay-1"));
    h.placer.replayOpened("r:replay-1");
    await eventually(() => expect(h?.fake.callsOf("pane.move")).toHaveLength(1));
    await h.placer.whenIdle();
    expect(h.grants.workspaces("r:replay-1")).toEqual([h.placer.key]);
    h.feed.emit({ event: "remove", target: "r:replay-1", reason: "replay_closed" });
    expect(h.grants.workspaces("r:replay-1")).toEqual([]);
  });

  test("the claudish tab closed between the list and the move: the scratch tab becomes the claudish tab", async () => {
    h = await startHarness();
    h.upsert(sessionItem("a"));
    await eventually(() => expect(claudishPanes(h as Harness)).toHaveLength(1));
    h.fake.script("pane.move", { error: "tab_not_found" });
    h.upsert(sessionItem("b"));
    await eventually(() => expect(h?.fake.callsOf("tab.rename")).toHaveLength(2));
    await h.placer.whenIdle();
    expect(scratchTabs(h)).toEqual([]);
  });

  test("pane.move failing twice, and timing out: no claudish-new tab and no stray pane are left", async () => {
    h = await startHarness();
    h.upsert(sessionItem("a"));
    await eventually(() => expect(claudishPanes(h as Harness)).toHaveLength(1));
    h.fake.script("pane.move", { error: "target_pane_not_found" }, { error: "internal" });
    h.upsert(sessionItem("b"));
    await eventually(() => expect(h?.fake.callsOf("pane.move")).toHaveLength(2));
    await h.placer.whenIdle();
    expect(scratchTabs(h)).toEqual([]);
    expect(h.fake.placedPanes()).toHaveLength(1);
    h.fake.script("pane.move", "drop");
    h.upsert(sessionItem("c"));
    await eventually(() => expect(h?.fake.callsOf("pane.move")).toHaveLength(3));
    await h.placer.whenIdle();
    await eventually(() => expect(scratchTabs(h as Harness)).toEqual([]));
    userPanesIntact(h);
  });

  test("an item that ends: its pane is closed after the grace, not before", async () => {
    h = await startHarness({ graceMs: 300 });
    h.upsert(sessionItem("a"));
    await eventually(() => expect(claudishPanes(h as Harness)).toHaveLength(1));
    h.upsert(sessionItem("a", { state: "COMPLETED" }));
    await Bun.sleep(150);
    expect(h.fake.callsOf("pane.close")).toHaveLength(0);
    await eventually(() => expect(h?.fake.callsOf("pane.close")).toHaveLength(1));
    expect(h.fake.placedPanes()).toHaveLength(0);
    userPanesIntact(h);
  });

  test("a pane the viewer closed itself is forgotten: no pane.close for it", async () => {
    h = await startHarness({ graceMs: 100 });
    h.upsert(sessionItem("a"));
    await eventually(() => expect(claudishPanes(h as Harness)).toHaveLength(1));
    const pane = claudishPanes(h)[0] as string;
    h.fake.exitPane(pane);
    h.upsert(sessionItem("a", { state: "COMPLETED" }));
    await Bun.sleep(250);
    expect(h.fake.callsOf("pane.close")).toHaveLength(0);
  });

  test("a pane the user closes while its item runs stays closed: later upserts place nothing", async () => {
    h = await startHarness();
    h.upsert(sessionItem("a"));
    await eventually(() => expect(claudishPanes(h as Harness)).toHaveLength(1));
    await h.placer.whenIdle();
    const pane = claudishPanes(h)[0] as string;
    h.fake.exitPane(pane);
    // herdr's event reaches the placer over its socket before the next row change
    await Bun.sleep(100);
    h.upsert(sessionItem("a", { state: "AWAITING_INPUT" }));
    h.upsert(sessionItem("a"));
    await Bun.sleep(100);
    await h.placer.whenIdle();
    expect(h.fake.callsOf("layout.apply")).toHaveLength(1);
    expect(h.fake.placedPanes()).toHaveLength(0);
  });

  test("shutdown closes this placer's panes and nothing else", async () => {
    h = await startHarness();
    h.fake.addUserTab("w1", "claudish-like", 2);
    h.upsert(sessionItem("a"));
    h.upsert(sessionItem("b"));
    await eventually(() => expect(claudishPanes(h as Harness)).toHaveLength(2));
    await h.placer.shutdown();
    expect(h.fake.placedPanes()).toHaveLength(0);
    expect(h.fake.callsOf("pane.close")).toHaveLength(2);
    expect(h.fake.tabByLabel("w1", "claudish-like")?.panes).toHaveLength(2);
    userPanesIntact(h);
  });
});

describe("HerdrPlacer: a lost creation reply", () => {
  test("layout.apply runs and its reply is dropped: the tab is found by its token and closed, one pane after the retry, no pane.split ever", async () => {
    h = await startHarness();
    h.fake.addUserTab("w1", "user-tab", 1);
    h.fake.script("layout.apply", "drop");
    h.upsert(sessionItem("a"));
    await eventually(() => expect(claudishPanes(h as Harness)).toHaveLength(1));
    await h.placer.whenIdle();
    await eventually(() => expect(scratchTabs(h as Harness)).toEqual([]));
    expect(h.fake.placedPanes()).toHaveLength(1);
    expect(h.fake.callsOf("layout.apply").map((c) => c.params.tab_label)).toEqual([
      `${SCRATCH_PREFIX}${h.tokens[0]}`,
      `${SCRATCH_PREFIX}${h.tokens[1]}`,
    ]);
    expect(h.fake.callsOf("pane.split")).toHaveLength(0);
    expect(h.fake.tabByLabel("w1", "user-tab")?.panes).toHaveLength(1);
    userPanesIntact(h);
  });

  test("a creation herdr finishes late (tab_created after the first list): that tab is closed too", async () => {
    h = await startHarness();
    h.fake.script("layout.apply", "drop-unexecuted");
    h.upsert(sessionItem("a"));
    await eventually(() => expect(claudishPanes(h as Harness)).toHaveLength(1));
    await h.placer.whenIdle();
    const late = h.fake.lateCreate("w1", `${SCRATCH_PREFIX}${h.tokens[0]}`);
    await eventually(() => expect(h?.fake.tabs.has(late.tab_id)).toBe(false));
    expect(h.fake.placedPanes()).toHaveLength(1);
    userPanesIntact(h);
  });

  test("the reply is lost, the tab found, and the cleanup request dropped before it runs: the tab is still closed", async () => {
    h = await startHarness();
    h.fake.script("layout.apply", "drop");
    h.fake.script("tab.close", "drop-unexecuted");
    h.upsert(sessionItem("a"));
    await eventually(() => expect(h?.fake.callsOf("tab.close")[0]?.outcome).toBe("unexecuted"));
    const lost = `${SCRATCH_PREFIX}${h.tokens[0]}`;
    await eventually(() => expect(scratchTabs(h as Harness)).not.toContain(lost));
    expect(h.fake.callsOf("tab.close").length).toBeGreaterThanOrEqual(2);
    await eventually(() => expect(claudishPanes(h as Harness)).toHaveLength(1));
    expect(h.fake.placedPanes()).toHaveLength(1);
    userPanesIntact(h);
  });
});

describe("HerdrPlacer: a replay placement transaction", () => {
  test("a viewer of the abandoned attempt subscribes and disconnects, a second opener arrives before the retry: one pane", async () => {
    h = await startHarness();
    const target = "r:replay-1";
    h.items.set(target, replayItem("replay-1"));
    const held = new Held();
    h.fake.script("layout.apply", { hold: held });
    h.placer.replayOpened(target);
    await held.executed;
    const first = h.fake.callsOf("layout.apply")[0];
    const placement = (first?.params.root as { env: Record<string, string> }).env
      .CLAUDISH_VIEW_PLACEMENT as string;
    expect(placement).toEndWith(`.${h.tokens[0]}`);
    // the first attempt's pane runs its viewer: it subscribes, then its tab is closed under it
    h.grants.viewerSubscribed(target, "conn-v1", h.placer.key, placement);
    h.grants.connectionGone("conn-v1");
    // another opener in the same workspace, before the retry
    const c = await h.second();
    c.replayOpened(target);
    await c.whenIdle();
    held.drop();
    await eventually(() => expect(claudishPanes(h as Harness)).toHaveLength(1));
    await h.placer.whenIdle();
    const retry = h.fake.callsOf("layout.apply")[1];
    const retryPlacement = (retry?.params.root as { env: Record<string, string> }).env
      .CLAUDISH_VIEW_PLACEMENT as string;
    const txn = placement.split(".")[0] as string;
    expect(retryPlacement).toBe(placementToken(txn, h.tokens[1] as string));
    // the retry's viewer connects: the reservation becomes its presence
    h.grants.viewerSubscribed(target, "conn-v2", h.placer.key, retryPlacement);
    expect(h.grants.pending(txn)).toBe(false);
    await eventually(() => expect(scratchTabs(h as Harness)).toEqual([]));
    expect(h.fake.callsOf("layout.apply")).toHaveLength(2);
    expect(h.fake.placedPanes()).toHaveLength(1);
  });

  test("one grant per workspace: the same server's second open of a replay places nothing", async () => {
    h = await startHarness();
    const target = "r:replay-2";
    h.items.set(target, replayItem("replay-2"));
    h.placer.replayOpened(target);
    h.placer.replayOpened(target);
    await eventually(() => expect(claudishPanes(h as Harness)).toHaveLength(1));
    await h.placer.whenIdle();
    expect(h.fake.callsOf("layout.apply")).toHaveLength(1);
  });

  test("a herdr viewer already on the replay in this workspace: no pane is placed", async () => {
    h = await startHarness();
    const target = "r:replay-3";
    h.items.set(target, replayItem("replay-3"));
    h.grants.viewerSubscribed(target, "conn-hand", h.placer.key, null);
    h.placer.replayOpened(target);
    await h.placer.whenIdle();
    expect(h.fake.callsOf("layout.apply")).toHaveLength(0);
  });
});
