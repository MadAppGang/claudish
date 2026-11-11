import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { eventually } from "../herdr/test-helpers/placer-harness.js";
import type { CaptureResult } from "../pane/contract.js";
import type { ViewClaimResult, ViewListResult } from "../pane/view-contract.js";
import { flockAvailable } from "./kernel-lock.js";
import { type ReplayWorld, makeReplayWorld } from "./test-helpers/replay-servers.js";
import { ViewClient } from "./view-client.js";

let world: ReplayWorld | undefined;
const clients: ViewClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  if (world) {
    const w = world;
    world = undefined;
    await w.stop();
    await eventually(() => expect(w.alive()).toEqual([]));
    expect(existsSync(w.root)).toBe(false);
  }
});
function setup() {
  world = makeReplayWorld();
  return world;
}
async function viewer(path: string) {
  const c = await ViewClient.connect(path, {
    hello: { name: "herdr read-only test viewer", kind: "viewer", front_end: "herdr" },
  });
  clients.push(c);
  return c;
}
const supported = flockAvailable();
describe.skipIf(!supported)(
  supported ? "shared replay public behaviour" : "shared replay — flock unavailable, not checked",
  () => {
    test("TEST-36 REQ-1 REQ-22 REQ-23 three concurrent opens share one replay process and one listed row", async () => {
      const w = setup();
      w.ctl.readyDelayMs = 50;
      const servers = await Promise.all([w.server(), w.server(), w.server()]);

      const opened = await Promise.all(servers.map((s) => s.replays.open(w.target)));

      expect(new Set(opened.map((r) => r.replay_id)).size).toBe(1);
      expect(w.alive()).toHaveLength(1);
      const lists = await Promise.all(
        servers.map(async (s) => {
          const c = await viewer(s.view.endpointPath);
          return c.request<ViewListResult>("list", { include_finished: true });
        })
      );
      expect(lists.flatMap((l) => l.items).filter((i) => i.kind === "replay")).toHaveLength(1);
      for (const s of servers) {
        expect(await s.replays.captureMcp(opened[0]!.replay_id)).toMatchObject({ final: false });
      }
    }, 15_000);

    test("TEST-37 REQ-23 viewer release drops only its hold while MCP replay remains live", async () => {
      const w = setup();
      const a = await w.server();
      const opened = await a.replays.open(w.target);
      const c = await viewer(a.view.endpointPath);
      await c.request("replay.open", { replay_id: opened.replay_id });
      await c.request("replay.open", { replay_id: opened.replay_id });

      expect(
        await c.request<{ closed: boolean }>("replay.release", { replay_id: opened.replay_id })
      ).toEqual({ closed: false });

      expect(w.alive()).toHaveLength(1);
      expect(await a.replays.captureMcp(opened.replay_id)).toMatchObject({ final: false });
      const b = await w.server();
      expect((await b.replays.open(w.target)).replay_id).toBe(opened.replay_id);
      expect(w.alive()).toHaveLength(1);
    }, 15_000);

    test("TEST-38 REQ-22 REQ-23 joined close waits for reap; owner retains final screen and closer loses id", async () => {
      const w = setup();
      w.ctl.closeDelayMs = 75;
      const a = await w.server();
      const b = await w.server();
      const opened = await a.replays.open(w.target);
      await b.replays.open(w.target);
      const before = (await a.replays.captureMcp(opened.replay_id)) as CaptureResult;
      expect(before.final).toBe(false);
      expect(before.lines.length).toBeGreaterThan(0);
      const record = w.alive()[0]!.recordPath;
      expect(existsSync(record)).toBe(true);

      expect(await b.replays.close(opened.replay_id)).toEqual({ closed: true });

      expect(w.alive()).toEqual([]);
      expect(existsSync(record)).toBe(false);
      const after = (await a.replays.captureMcp(opened.replay_id)) as CaptureResult;
      expect(after.final).toBe(true);
      expect(after.lines).toEqual(before.lines);
      await expect(b.replays.captureMcp(opened.replay_id)).rejects.toMatchObject({
        code: "unknown_session",
      });
    }, 15_000);

    test("TEST-39 REQ-11 REQ-12 REQ-23 REQ-25 replay size and relative holders agree through peer, herdr, owner handover", async () => {
      const w = setup();
      const a = await w.server();
      const b = await w.server();
      const opened = await a.replays.open(w.target);
      await b.replays.open(w.target);
      const c = await viewer(a.view.endpointPath);
      await c.request("replay.open", { replay_id: opened.replay_id });
      const target = `r:${opened.replay_id}`;

      expect(await b.replays.resize(opened.replay_id, 100, 30)).toMatchObject({
        cols: 100,
        rows: 30,
        changed: true,
        view: { holder: "claude_code" },
      });
      expect(await b.replays.captureMcp(opened.replay_id)).toMatchObject({
        cols: 100,
        rows: 30,
        view: { holder: "claude_code" },
      });
      expect(await a.replays.captureMcp(opened.replay_id)).toMatchObject({
        view: { holder: "claude_code_other", label: "another Claude Code" },
      });

      const grant = await c.request<ViewClaimResult>("claim", { target, cols: 110, rows: 32 });
      expect(grant.view?.holder).toBe("herdr");
      for (const s of [a, b]) {
        expect(await s.replays.captureMcp(opened.replay_id)).toMatchObject({
          cols: 110,
          rows: 32,
          view: { holder: "herdr", claim_id: grant.view?.claim_id },
        });
      }

      // Even an unchanged size is a new user act and must take the view.
      expect(await a.replays.resize(opened.replay_id, 110, 32)).toMatchObject({
        cols: 110,
        rows: 32,
        changed: false,
        view: { holder: "claude_code" },
      });
      expect(await b.replays.captureMcp(opened.replay_id)).toMatchObject({
        view: { holder: "claude_code_other" },
      });
      await expect(c.request("resize", { target, cols: 120, rows: 35 })).rejects.toMatchObject({
        code: "view_not_held",
      });
      expect(w.alive()).toHaveLength(1);
    }, 15_000);
  }
);
