import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { SessionViewItem } from "../../pane/view-contract.js";
import { sessionItem } from "../test-helpers/placer-harness.js";
import {
  claudishArgv,
  feedRunArgs,
  parseFeed,
  rowsOf,
  viewRunArgs,
  viewTerminalName,
} from "./model.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const install = {
  path: "/test-only/with space/claudish",
  pathEnv: "/test-only/bin:/usr/bin",
  root: "/test-only/view-root",
  version: "test",
};

describe("Herdr.app session model", () => {
  test("TEST-24 REQ-20 REQ-21 list stably groups running before terminal and retains selected row", () => {
    const done = sessionItem("done", { state: "COMPLETED" });
    const working = sessionItem("working");
    const failed = sessionItem("failed", { state: "FAILED" });
    const waiting = sessionItem("waiting", { state: "AWAITING_INPUT" });
    const items = [done, working, failed, waiting];

    const rows = rowsOf(items, waiting.target);

    expect(rows.map((r) => r.target)).toEqual([
      working.target,
      waiting.target,
      done.target,
      failed.target,
    ]);
    expect(rows.map((r) => r.finished)).toEqual([false, false, true, true]);
    expect(rows.filter((r) => r.selected).map((r) => r.target)).toEqual([waiting.target]);
    expect(rows.find((r) => r.target === failed.target)?.state).toBe("error");
    expect(rows.find((r) => r.target === done.target)?.state).toBe("done");
    expect(items.map((r) => r.target)).toEqual([
      done.target,
      working.target,
      failed.target,
      waiting.target,
    ]);
  });

  test.each([null, "", "{", "null", "[]", "{}", '{"items":[]}'])(
    "TEST-26 REQ-20 malformed/absent feed %j is not a usable feed",
    (raw) => {
      expect(parseFeed(raw)).toBeNull();
    }
  );

  test("TEST-26 REQ-20 complete stamped feed retains server and item data", () => {
    const item = sessionItem("a") as SessionViewItem;
    const stamp = { pid: 123, start36: "abc", started_at: "2026-11-10T00:00:00.000Z" };
    const servers = [{ endpoint: "c123-abc.sock", pid: 123, version: "test" }];

    const feed = parseFeed(
      JSON.stringify({
        relay: stamp,
        written_at: stamp.started_at,
        servers,
        items: [item],
      })
    );

    expect(feed).not.toBeNull();
    expect(feed?.relay).toMatchObject({ pid: 123, start36: "abc" });
    expect(feed?.servers).toEqual(servers);
    expect(feed?.items).toEqual([item]);
  });

  test("TEST-27 REQ-19 REQ-20 viewer and relay argv carry resolved install environment and literal target", () => {
    const target = "s:target with spaces";
    const base = claudishArgv(install, ["view", target, "--front-end", "herdr-core"]);
    const view = viewRunArgs(install, target, "claudish-view-test", "/test-only/home");
    const feed = feedRunArgs(install, "/test-only/home");

    expect(base).toContain(install.path);
    expect(base).toContain(`PATH=${install.pathEnv}`);
    expect(base).toContain(`CLAUDISH_PANE_ROOT=${install.root}`);
    expect(base.slice(-4)).toEqual(["view", target, "--front-end", "herdr-core"]);
    expect(view).toContain("run");
    expect(view).toContain("--bg");
    expect(view).toContain("claudish-view-test");
    expect(view).toContain(target);
    expect(view).toContain("--front-end");
    expect(view).toContain("herdr-core");
    expect(view).not.toContain("--passive");
    for (const args of [view, feed]) {
      expect(args).toContain(install.path);
      expect(args).toContain(`CLAUDISH_PANE_ROOT=${install.root}`);
      expect(args).toContain(`PATH=${install.pathEnv}`);
    }
    expect(feed).toContain("claudish-feed");
    expect(feed).toContain("--feed");
  });

  test.each(["s:" + "x".repeat(500), "t:run/01", "r:replay-abcd"])(
    "TEST-28 REQ-20 REQ-35 hc viewer name is bounded hash of %s",
    (target) => {
      const name = viewTerminalName(target, sha);

      expect(name).toBe(`claudish-view-${sha(target).slice(0, 12)}`);
      expect(name).toMatch(/^[a-z0-9_-]{1,32}$/);
      expect(name).toHaveLength(26);
      expect(viewTerminalName(target, sha)).toBe(name);
      expect(viewTerminalName(target + "-other", sha)).not.toBe(name);
    }
  );
});
