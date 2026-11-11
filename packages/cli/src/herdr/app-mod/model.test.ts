import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ViewItem } from "../../pane/view-contract.js";
import { replayItem, sessionItem } from "../test-helpers/placer-harness.js";
import {
  type ClaudishInstall,
  FEED_TERMINAL,
  VIEW_WINDOW_KEY,
  feedRunArgs,
  isPanelVisible,
  panelNodeId,
  parseFeed,
  parseHcRun,
  rowsOf,
  viewRunArgs,
  viewTerminalName,
  viewWindowSpec,
} from "./model.js";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const INSTALL: ClaudishInstall = {
  path: "/Users/u/.bun/bin/claudish",
  pathEnv: "/Users/u/.bun/bin:/usr/bin:/bin",
  root: "/tmp/claudish-mux-501",
  version: "claudish version 14.16.1",
};

function withFields(item: ViewItem, fields: Record<string, unknown>): ViewItem {
  return { ...item, ...fields } as ViewItem;
}

function slotItem(run: string, slot: string): ViewItem {
  return withFields(sessionItem(slot), {
    kind: "team_slot",
    target: `t:${run}/${slot}`,
    run_id: run,
    run_path: `/tmp/${run}`,
    run_kind: "run",
    slot,
  });
}

describe("rowsOf", () => {
  test("rows come from the shared state map: title, model, state word, and where it is viewed", () => {
    const rows = rowsOf(
      [
        withFields(sessionItem("a", { model: "openai-codex@gpt-6.1-sol" }), { activity: "Bash" }),
        withFields(sessionItem("b"), {
          state: "AWAITING_PERMISSION",
          activity: "Edit",
          view: { holder: "claude_code", label: "Claude Code", since: "x", claim_id: "c" },
        }),
      ],
      "s:b"
    );
    expect(rows).toEqual([
      {
        target: "s:a",
        title: "say hi",
        detail: "gpt-6.1-sol · Bash",
        state: "working",
        finished: false,
        selected: false,
      },
      {
        target: "s:b",
        title: "say hi",
        detail: "gpt-6 · permission: Edit · viewed in Claude Code",
        state: "blocked",
        finished: false,
        selected: true,
      },
    ]);
  });

  test("finished items and ended replays go after the running ones, in feed order", () => {
    const rows = rowsOf(
      [
        withFields(sessionItem("done1"), { state: "COMPLETED" }),
        slotItem("run-1", "gpt"),
        replayItem("r1", true),
        withFields(sessionItem("bad"), { state: "FAILED", reason: "api_error" }),
        replayItem("r2", false),
      ],
      null
    );
    expect(rows.map((r) => [r.target, r.state, r.finished])).toEqual([
      ["t:run-1/gpt", "working", false],
      ["r:r2", "idle", false],
      ["s:done1", "done", true],
      ["r:r1", "idle", true],
      ["s:bad", "error", true],
    ]);
    expect(rows[0]?.detail).toBe("run-1/gpt · gpt-6 · running");
    expect(rows.find((r) => r.target === "s:bad")?.detail).toBe("gpt-6 · FAILED (api_error)");
  });
});

describe("hc terminals the mod starts", () => {
  test("a view terminal's name is claudish-view- and 12 hex of the target's sha256, always valid", () => {
    const longest = `t:${"r".repeat(64)}/${"s".repeat(64)}`;
    for (const target of ["s:abc", "r:replay-0123456789abcdef", longest]) {
      const name = viewTerminalName(target, sha256);
      expect(name).toBe(`claudish-view-${sha256(target).slice(0, 12)}`);
      expect(name).toMatch(/^[a-z0-9_-]{1,32}$/);
      expect(name).toHaveLength(26);
    }
    expect(() => viewTerminalName("s:a", () => "NOT-HEX")).toThrow();
  });

  test("selection starts a hidden, self-removing viewer that takes the view, with PATH and root given", () => {
    expect(viewRunArgs(INSTALL, "s:abc", "claudish-view-0123456789ab", "/Users/u")).toEqual([
      "run",
      "--bg",
      "--json",
      "--no-parent",
      "--no-notify",
      "--rm",
      "--name",
      "claudish-view-0123456789ab",
      "--cwd",
      "/Users/u",
      "--",
      "/usr/bin/env",
      "PATH=/Users/u/.bun/bin:/usr/bin:/bin",
      "CLAUDISH_PANE_ROOT=/tmp/claudish-mux-501",
      "/Users/u/.bun/bin/claudish",
      "view",
      "s:abc",
      "--front-end",
      "herdr-core",
    ]);
  });

  test("the feed relay runs under the one name hc keeps unique, with no herdr label", () => {
    const args = feedRunArgs(INSTALL, "/Users/u");
    expect(args.slice(0, 8)).toEqual([
      "run",
      "--bg",
      "--json",
      "--no-parent",
      "--no-notify",
      "--rm",
      "--name",
      FEED_TERMINAL,
    ]);
    expect(args.slice(-3)).toEqual(["/Users/u/.bun/bin/claudish", "view", "--feed"]);
    expect(args).not.toContain("--label");
    expect(args).not.toContain("--passive");
  });

  test("hc's answers: started, the name taken (hc 0.1.19's own reply), and a failure", () => {
    expect(
      parseHcRun({
        code: 0,
        stdout:
          '{"address":"t2","agent":"sh","cwd":"/x","name":"claudish-feed","state":"live","turn":0}\n',
        stderr: "",
      })
    ).toEqual({ kind: "started", address: "t2" });
    expect(
      parseHcRun({
        code: 1,
        stdout:
          '{"error":{"hint":"pick another name, or kill the one holding it","kind":"name_taken","message":"a live terminal is already named \\"claudish-feed\\""}}\n',
        stderr: "",
      })
    ).toEqual({ kind: "name_taken" });
    expect(parseHcRun({ code: 127, stdout: "", stderr: "hc: command not found\n" })).toEqual({
      kind: "failed",
      message: "hc: command not found",
    });
  });

  test("the window shows the viewer's terminal under this mod's title bar, keyed so it is replaced", () => {
    const spec = viewWindowSpec("t9", "s:abc", "gpt-6");
    expect(spec).toMatchObject({ kind: "window", key: VIEW_WINDOW_KEY });
    expect(spec.layout.children[0]?.content).toEqual({
      mod: "claudish",
      props: { role: "titlebar", terminal: "t9", target: "s:abc", title: "gpt-6" },
    });
    expect(spec.layout.children[1]?.content).toEqual({ terminal: "t9" });
  });
});

describe("parseFeed", () => {
  test("a relay's file, a listing without a stamp, and anything else", () => {
    const items = [sessionItem("a")];
    expect(
      parseFeed(
        JSON.stringify({ relay: { pid: 4, start36: "ab", started_at: "x" }, servers: [], items })
      )
    ).toEqual({ relay: { pid: 4, start36: "ab" }, servers: [], items });
    expect(parseFeed(JSON.stringify({ servers: [], items: [] }))).toEqual({
      relay: null,
      servers: [],
      items: [],
    });
    for (const bad of [null, "", "{", "[]", '{"items":[]}', '{"servers":{},"items":[]}'])
      expect(parseFeed(bad)).toBeNull();
  });
});

describe("where the panel sits", () => {
  const panel = { id: "claudish-col", type: "block", content: { mod: "claudish" } };
  const toggle = {
    id: "tbtn",
    type: "block",
    content: { mod: "claudish", props: { role: "toggle" } },
  };

  test("visible unless a node on its way is hidden or another stack child is active", () => {
    expect(isPanelVisible({ type: "row", children: [toggle, panel] })).toBe(true);
    expect(isPanelVisible({ type: "row", children: [{ ...panel, hidden: true }] })).toBe(false);
    expect(
      isPanelVisible({
        type: "row",
        children: [{ type: "column", hidden: true, children: [panel] }],
      })
    ).toBe(false);
    expect(
      isPanelVisible({
        type: "stack",
        id: "s",
        active: "other",
        children: [{ id: "other" }, panel],
      })
    ).toBe(false);
    expect(
      isPanelVisible({ type: "stack", id: "s", active: "claudish-col", children: [panel] })
    ).toBe(true);
    // a copy the layout does not hold (an overlay) is shown
    expect(isPanelVisible({ type: "row", children: [toggle] })).toBe(true);
    expect(isPanelVisible(null)).toBe(true);
  });

  test("the toggle targets the panel's node, never itself", () => {
    expect(panelNodeId({ type: "row", children: [toggle, panel] })).toBe("claudish-col");
    expect(panelNodeId({ type: "row", children: [toggle] })).toBeNull();
    expect(
      panelNodeId({
        type: "row",
        floating: [{ id: "f", type: "block", content: { mod: "claudish" } }],
      })
    ).toBe("f");
  });
});
