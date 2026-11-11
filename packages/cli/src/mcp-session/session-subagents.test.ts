/**
 * A session's subagents reach the status stream: files Claude Code writes beside the transcript
 * become `subagents` on the session's ViewItem, the feed publishes an upsert when they change, and
 * the herdr metadata counts the running ones. Real magmux, the fake interactive child.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { herdrMetadata } from "../herdr/state-map.js";
import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type PaneTestEnv,
  killLeftovers,
  makePaneTestEnv,
  waitNoOrphans,
} from "../pane/test-helpers/hermetic-env.js";
import type { SessionViewItem, ViewItem } from "../pane/view-contract.js";
import { ViewClaims } from "../view/view-claims.js";
import { ViewDirectory } from "../view/view-directory.js";
import { ViewFeed, type ViewFeedEvent } from "../view/view-feed.js";
import { SessionManager } from "./session-manager.js";

function waitFor<T>(probe: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const v = probe();
      if (v !== undefined) return resolve(v);
      if (Date.now() > deadline) return reject(new Error("timed out"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

const unused = () => {
  throw new Error("unused");
};

describe.skipIf(!MAGMUX)(
  `session subagents on the status stream (${MAGMUX ? "magmux" : NO_MAGMUX_MESSAGE})`,
  () => {
    let t: PaneTestEnv;
    let manager: SessionManager;

    beforeEach(() => {
      t = makePaneTestEnv();
    });

    afterEach(async () => {
      await manager?.shutdownAll();
      const report = await waitNoOrphans({ sockRoot: t.sockRoot }, 10_000);
      killLeftovers({ sockRoot: t.sockRoot });
      t.cleanup();
      expect(report).toEqual({ processes: [], files: [] });
    });

    test("a subagent file and its meta publish an upsert; its end publishes another", async () => {
      const feed = new ViewFeed();
      const claims = new ViewClaims();
      manager = new SessionManager({
        maxSessions: 4,
        sessionsDir: join(t.tmp, "sessions"),
        hostPid: 1,
        parentEnv: t.env,
        paneTimings: { replStableMs: 200 },
        feed,
        claims,
      });
      const directory = new ViewDirectory({
        sessions: manager,
        team: {
          listSlots: () => [],
          slot: () => null,
          capture: unused,
          transcript: unused,
          resize: unused,
        },
        replays: { list: () => [], capture: unused, resize: unused },
        claims,
      });
      feed.setBuilder((target) => directory.item(target));
      const events: ViewFeedEvent[] = [];
      feed.subscribe((e) => events.push(e));

      const id = await manager.createSession({ model: "fake-answer", cwd: t.cwd });
      await waitFor(() => (manager.getSession(id).state === "AWAITING_INPUT" ? true : undefined));
      const transcript = manager.getSession(id).transcriptPath;
      if (!transcript) throw new Error("no transcript path");
      const sub = join(transcript.replace(/\.jsonl$/, ""), "subagents");
      mkdirSync(sub, { recursive: true });

      const upserts = () =>
        events.flatMap((e) =>
          e.event === "upsert" && e.item.target === `s:${id}` ? [e.item as SessionViewItem] : []
        );
      expect(upserts().every((i) => i.subagents.length === 0)).toBe(true);
      const quiet = upserts().length;

      const agent = "a1b2c3d4e5f6a7b8c";
      const meta = join(sub, `agent-${agent}.meta.json`);
      writeFileSync(
        meta,
        JSON.stringify({
          agentType: "Explore",
          description: "map the parser",
          toolUseId: "toolu_x",
          requestShape: "background",
        })
      );
      appendFileSync(
        join(sub, `agent-${agent}.jsonl`),
        `${JSON.stringify({ type: "user", isSidechain: true, agentId: agent, timestamp: "2026-11-10T08:00:00.000Z", message: { role: "user", content: "<prompt>" } })}\n`
      );

      const running = await waitFor(() =>
        upserts()
          .slice(quiet)
          .find((i) => i.subagents.length === 1)
      );
      expect(running.subagents[0]).toEqual({
        id: agent,
        description: "map the parser",
        subagent_type: "Explore",
        mode: "background",
        state: "running",
        started_at: "2026-11-10T08:00:00.000Z",
        tool_calls: 0,
        tokens_out: null,
      });
      expect(herdrMetadata(running as ViewItem).tokens.subagents).toBe("1");

      // Claude Code replaces the meta with `finished: true` when the subagent ends
      writeFileSync(
        meta,
        JSON.stringify({
          agentType: "Explore",
          description: "map the parser",
          toolUseId: "toolu_x",
          finished: true,
        })
      );
      const done = await waitFor(() =>
        upserts().find((i) => i.subagents.length === 1 && i.subagents[0]?.state === "done")
      );
      expect(herdrMetadata(done as ViewItem).tokens.subagents).toBeNull();
      expect(manager.viewDetail(id)?.subagents.map((s) => s.state)).toEqual(["done"]);
    }, 60_000);
  }
);
