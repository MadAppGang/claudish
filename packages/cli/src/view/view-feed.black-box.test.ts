import { describe, expect, test } from "bun:test";
import { eventually, sessionItem } from "../herdr/test-helpers/view-items.js";
import type { SessionViewItem, ViewItem } from "../pane/view-contract.js";
import { ViewFeed, type ViewFeedEvent } from "./view-feed.js";

describe("full-row change stream", () => {
  test("TEST-13 REQ-7 REQ-27 REQ-37 equal rows and clock-only changes stay silent", async () => {
    let item = sessionItem("idle") as SessionViewItem;
    const feed = new ViewFeed({ debounceMs: 5 });
    feed.setBuilder(() => item);
    const events: ViewFeedEvent[] = [];
    const stop = feed.subscribe((e) => events.push(e));
    try {
      feed.noteDelivered([item]);

      for (let i = 1; i <= 10; i++) {
        item = { ...item, idle_seconds: i, elapsed_seconds: i };
        feed.changed(item.target, true);
      }
      await Bun.sleep(30);

      expect(events).toEqual([]);
    } finally {
      stop();
    }
  });

  test.each([
    { tokens_in: 120, tokens_out: 24, cost_usd: 0.25 },
    { prompts_sent: 2, pending_inputs: 1, prompt_summary: "next prompt" },
    { state: "AWAITING_PERMISSION", activity: "Bash" },
    { agent: "researcher", agent_requested: "researcher" },
    {
      subagents: [
        {
          id: "a",
          description: "review",
          subagent_type: "general",
          mode: "background",
          state: "running",
          started_at: "2026-11-10T00:00:00.000Z",
          tool_calls: 1,
          tokens_out: 3,
        },
      ],
    },
    {
      view: { holder: "herdr", label: "herdr", since: "2026-11-10T00:00:00.000Z", claim_id: "new" },
    },
    { magmux: { pane_id: "c1-new", view_socket: "/test-only/new.view" } },
  ])("TEST-14 REQ-5 REQ-7 REQ-37 changed detail %j publishes a complete row", (patch) => {
    let item: ViewItem = sessionItem("live");
    const feed = new ViewFeed();
    const seen: ViewFeedEvent[] = [];
    feed.setBuilder(() => item);
    const stop = feed.subscribe((e) => seen.push(e));
    try {
      feed.noteDelivered([item]);

      item = { ...item, ...patch } as ViewItem;
      feed.changed(item.target, true);

      expect(seen).toEqual([{ event: "upsert", item }]);
    } finally {
      stop();
    }
  });

  test("TEST-15 REQ-7 removal cancels pending update but not another target's update", async () => {
    const a = sessionItem("a");
    const b = sessionItem("b");
    const feed = new ViewFeed({ debounceMs: 10 });
    const seen: ViewFeedEvent[] = [];
    feed.setBuilder((t) => (t === a.target ? a : t === b.target ? b : null));
    const stop = feed.subscribe((e) => seen.push(e));
    try {
      feed.changed(a.target);
      feed.changed(b.target);

      feed.removed(a.target, "evicted");
      await eventually(() => expect(seen).toHaveLength(2));
      await Bun.sleep(30);

      expect(seen).toEqual([
        { event: "remove", target: a.target, reason: "evicted" },
        { event: "upsert", item: b },
      ]);
    } finally {
      stop();
    }
  });
});
