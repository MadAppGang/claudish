import { describe, expect, test } from "bun:test";
import { sessionItem } from "../herdr/test-helpers/view-items.js";
import type { ViewItem } from "../pane/view-contract.js";
import { ViewFeed, type ViewFeedEvent } from "./view-feed.js";

function upserts(events: ViewFeedEvent[]): ViewItem[] {
  return events.flatMap((e) => (e.event === "upsert" ? [e.item] : []));
}

describe("ViewFeed: a snapshot sent during the debounce", () => {
  test("a subscriber's snapshot inside the window does not swallow the pending upsert for the others", async () => {
    const feed = new ViewFeed({ debounceMs: 30 });
    const item = sessionItem("a");
    feed.setBuilder((t) => (t === item.target ? item : null));
    const seen: ViewFeedEvent[] = [];
    feed.subscribe((e) => seen.push(e));
    feed.changed(item.target);
    // a second connection subscribes before the timer fires; its snapshot already shows the row
    feed.subscribe(() => {});
    feed.noteDelivered([item]);
    await Bun.sleep(80);
    expect(upserts(seen).map((i) => i.target)).toEqual([item.target]);
  });

  test("a snapshot with no change pending still spares the next identical flush", async () => {
    const feed = new ViewFeed({ debounceMs: 30 });
    const item = sessionItem("a");
    feed.setBuilder((t) => (t === item.target ? item : null));
    const seen: ViewFeedEvent[] = [];
    feed.subscribe((e) => seen.push(e));
    feed.noteDelivered([item]);
    feed.changed(item.target);
    await Bun.sleep(80);
    expect(upserts(seen)).toEqual([]);
  });
});

describe("ViewFeed: the activity clock", () => {
  test("a change only in last_activity_at inside the window is published when the window ends", async () => {
    const feed = new ViewFeed({ debounceMs: 10, activityPublishMs: 100 });
    let item = {
      ...sessionItem("a"),
      last_activity_at: "2026-11-11T00:00:00.000Z",
    } as ViewItem;
    feed.setBuilder(() => item);
    const seen: ViewFeedEvent[] = [];
    feed.subscribe((e) => seen.push(e));
    feed.changed(item.target, true);
    item = { ...item, last_activity_at: "2026-11-11T00:00:01.000Z" } as ViewItem;
    feed.changed(item.target, true);
    expect(upserts(seen)).toHaveLength(1);
    await Bun.sleep(250);
    expect(upserts(seen).map((i) => (i as { last_activity_at: string }).last_activity_at)).toEqual([
      "2026-11-11T00:00:00.000Z",
      "2026-11-11T00:00:01.000Z",
    ]);
  });

  test("a real change while the trailing activity flush waits still goes out within the debounce", async () => {
    const feed = new ViewFeed({ debounceMs: 20, activityPublishMs: 1_000 });
    let item = {
      ...sessionItem("a"),
      last_activity_at: "2026-11-11T00:00:00.000Z",
    } as ViewItem;
    feed.setBuilder(() => item);
    const seen: ViewFeedEvent[] = [];
    feed.subscribe((e) => seen.push(e));
    feed.changed(item.target, true);
    // activity only: the trailing flush is armed for the end of the window
    item = { ...item, last_activity_at: "2026-11-11T00:00:01.000Z" } as ViewItem;
    feed.changed(item.target, true);
    expect(upserts(seen)).toHaveLength(1);
    item = { ...item, tool_calls: 3 } as ViewItem;
    feed.changed(item.target);
    await Bun.sleep(200);
    expect(upserts(seen).map((i) => (i as { tool_calls: number }).tool_calls)).toEqual([0, 3]);
  });
});
