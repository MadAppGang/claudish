/**
 * One replay per Claude session across servers under one root: the kernel lock, the registry as a
 * directory, joins and redirects, and every relayed verb. Each server is in-process; each replay's
 * "magmux" is a real child process holding the real lock at fd 3 (`replay-servers.ts`).
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { ContractErrorException } from "../pane/index.js";
import { ViewError } from "../pane/view-contract.js";
import { endpointPathOf } from "./endpoints.js";
import { flockAvailable, tryAcquire } from "./kernel-lock.js";
import { type ReplayWorld, makeReplayWorld } from "./test-helpers/replay-servers.js";
import { ViewClient } from "./view-client.js";
import { Viewer, type ViewerIo } from "./viewer.js";

// A test that outlives its timeout has its replay processes killed by bun, and the server still
// polling then truthfully reports them gone: the late assertion reads as a wrong answer.
setDefaultTimeout(30_000);

let world: ReplayWorld | null = null;
afterEach(async () => {
  await world?.stop();
  world = null;
});

function newWorld(): ReplayWorld {
  world = makeReplayWorld();
  return world;
}

async function eventually(check: () => void | Promise<void>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      await check();
      return;
    } catch (e) {
      if (Date.now() > deadline) throw e;
    }
    await Bun.sleep(20);
  }
}

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

function codeOf(e: unknown): string {
  if (e instanceof ContractErrorException || e instanceof ViewError) return e.code;
  return String(e);
}

function viewerIo(): ViewerIo {
  return {
    write: () => {},
    term: () => ({ cols: 80, rows: 25 }),
    onKeys: () => () => {},
    onResize: () => () => {},
  };
}

async function viewer(w: ReplayWorld, endpoint: string): Promise<ViewClient> {
  return ViewClient.connect(endpointPathOf(w.root, endpoint), {
    hello: { name: "test viewer", kind: "viewer", front_end: "none" },
  });
}

describe.if(flockAvailable())("replays shared across servers", () => {
  test("two servers racing the lock: one replay process, one replay_id, the loser joined", async () => {
    const w = newWorld();
    const a = await w.server();
    const b = await w.server();
    const [ra, rb] = await Promise.all([a.replays.open(w.target), b.replays.open(w.target)]);
    expect(ra.replay_id).toBe(rb.replay_id);
    expect(w.spawns.panes).toHaveLength(1);
    expect(w.alive()).toHaveLength(1);
    // exactly one server lists it: one replay is one item machine-wide
    const listed = [a, b].filter((s) => s.replays.list().length === 1);
    expect(listed).toHaveLength(1);
  });

  test("negative control: without the kernel lock both servers spawn", async () => {
    const w = newWorld();
    const a = await w.server();
    const b = await w.server();
    // every acquisition gets its own private file, so nothing ever contends
    for (const s of [a, b]) {
      const reg = s.replays.registry;
      reg.tryLock = (uuid: string) => {
        reg.ensure();
        return tryAcquire(`${reg.lockPathOf(uuid)}.${Math.random().toString(16).slice(2)}`);
      };
    }
    await Promise.all([a.replays.open(w.target), b.replays.open(w.target)]);
    expect(w.spawns.panes).toHaveLength(2);
  });

  test("a delayed reap while another server opens: the second spawn starts only after the first process died", async () => {
    const w = newWorld();
    w.ctl.closeDelayMs = 1_200;
    const a = await w.server();
    const b = await w.server({ readyMs: 500, joinExtraMs: 5_000 });
    const first = await a.replays.open(w.target);
    const closing = a.replays.close(first.replay_id);
    await Bun.sleep(100);
    const opened = await b.replays.open(w.target);
    expect(await closing).toEqual({ closed: true });
    expect(opened.replay_id).not.toBe(first.replay_id);
    expect(w.spawns.panes).toHaveLength(2);
    const [old, fresh] = w.spawns.panes;
    expect(old?.diedAt).not.toBeNull();
    expect(fresh?.startedAt).toBeGreaterThanOrEqual(old?.diedAt ?? Number.POSITIVE_INFINITY);
  });

  test("negative control: a lock freed at spawn lets the second spawn overlap the slow reap", async () => {
    const w = newWorld();
    w.ctl.closeDelayMs = 1_200;
    w.ctl.handLock = false;
    const a = await w.server();
    const b = await w.server({ readyMs: 500, joinExtraMs: 5_000 });
    const first = await a.replays.open(w.target);
    const closing = a.replays.close(first.replay_id);
    await Bun.sleep(100);
    await b.replays.open(w.target);
    await closing;
    const [old, fresh] = w.spawns.panes;
    // the overlap the lock exists to prevent
    expect(fresh?.startedAt ?? 0).toBeLessThan(old?.diedAt ?? 0);
  });

  test("owner death with its magmux alive: joined server keeps the final screen; a new open refuses until the process is gone", async () => {
    const w = newWorld();
    const a = await w.server();
    const b = await w.server();
    const opened = await a.replays.open(w.target);
    await b.replays.open(w.target);
    const live = await b.replays.captureMcp(opened.replay_id);
    expect("lines" in live && live.lines[0]).toContain("on c");
    a.kill(); // the owner server dies; its replay process does not
    expect(w.alive()).toHaveLength(1);
    // the joined server learns of the owner's death from its link closing, which is asynchronous
    await eventually(async () => {
      expect((await b.replays.captureMcp(opened.replay_id)).final).toBe(true);
    }, 10_000);
    const fin = await b.replays.captureMcp(opened.replay_id);
    expect("lines" in fin && fin.lines[0]).toContain("replay ");

    const c = await w.server({ readyMs: 200, joinExtraMs: 800 });
    const refused = await errorOf(c.replays.open(w.target));
    expect(codeOf(refused)).toBe("replay_unavailable");
    expect(w.spawns.panes).toHaveLength(1);

    w.spawns.panes[0]?.kill();
    await eventually(() => expect(w.alive()).toHaveLength(0));
    const again = await c.replays.open(w.target);
    expect(again.replay_id).not.toBe(opened.replay_id);
    expect(w.spawns.panes).toHaveLength(2);
  });

  test("owner unreachable on a joined close_replay: reap_unverified while the process lives, closed once it is gone", async () => {
    const w = newWorld();
    const a = await w.server();
    const b = await w.server({ unreachableCloseMs: 600 });
    const opened = await a.replays.open(w.target);
    await b.replays.open(w.target);
    a.kill();
    expect(await b.replays.close(opened.replay_id)).toEqual({
      closed: true,
      reap_unverified: true,
    });

    const c = await w.server({ unreachableCloseMs: 3_000 });
    const d = await w.server({ unreachableCloseMs: 3_000 });
    w.spawns.panes[0]?.kill();
    await eventually(() => expect(w.alive()).toHaveLength(0));
    const second = await c.replays.open(w.target);
    await d.replays.open(w.target);
    const pane = w.spawns.panes[1];
    c.kill();
    setTimeout(() => {
      pane?.kill();
      void pane?.close();
    }, 300);
    expect(await d.replays.close(second.replay_id)).toEqual({ closed: true });
    expect(pane && existsSync(pane.recordPath)).toBe(false);
  });

  test("close_replay from a joined server returns only after the owner's process is gone; owner's MCP keeps final, joined id is unknown", async () => {
    const w = newWorld();
    w.ctl.closeDelayMs = 400;
    const a = await w.server();
    const b = await w.server();
    const opened = await a.replays.open(w.target);
    await b.replays.open(w.target);
    const pane = w.spawns.panes[0];
    expect(await b.replays.close(opened.replay_id)).toEqual({ closed: true });
    expect(pane?.alive).toBe(false);
    expect(pane && existsSync(pane.recordPath)).toBe(false);
    expect(a.replays.registry.read(w.target.claudeSessionId as string)).toBeNull();
    const ownerView = await a.replays.captureMcp(opened.replay_id);
    expect(ownerView.final).toBe(true);
    expect(codeOf(await errorOf(b.replays.captureMcp(opened.replay_id)))).toBe("unknown_session");
  });

  test("the owner's close_replay while another server holds it: the joined capture answers final with the last screen", async () => {
    const w = newWorld();
    const a = await w.server();
    const b = await w.server();
    const opened = await a.replays.open(w.target);
    await b.replays.open(w.target);
    expect(await a.replays.close(opened.replay_id)).toEqual({ closed: true });
    await eventually(() => expect(w.alive()).toHaveLength(0));
    const fin = await b.replays.captureMcp(opened.replay_id);
    expect(fin.final).toBe(true);
    expect("lines" in fin && fin.lines[0]).toContain("replay ");
    expect(codeOf(await errorOf(a.replays.captureMcp(opened.replay_id)))).toBe("unknown_session");
  });

  test("scroll relay: a joined server's scroll_session reaches the owner's pane; a viewer may not scroll", async () => {
    const w = newWorld();
    const a = await w.server();
    const b = await w.server();
    const opened = await a.replays.open(w.target);
    await b.replays.open(w.target);
    const r = await b.replays.scroll(opened.replay_id, { by: -3 });
    expect(r.session_id).toBe(opened.replay_id);
    await b.replays.scroll(opened.replay_id, { to: "end" });
    expect(w.spawns.panes[0]?.scrolls).toEqual([{ by: -3 }, { to: "end" }]);
    const v = await viewer(w, a.name);
    const refused = await errorOf(
      v.request("replay.scroll", { replay_id: opened.replay_id, by: 1 })
    );
    expect(codeOf(refused)).toBe("forbidden");
    v.close();
  });

  test("holder relative to the answering server: B's resize reads claude_code on B and claude_code_other on A, then reversed", async () => {
    const w = newWorld();
    const a = await w.server();
    const b = await w.server();
    const opened = await a.replays.open(w.target);
    await b.replays.open(w.target);
    const rb = await b.replays.resize(opened.replay_id, 100, 30);
    expect(rb.changed).toBe(true);
    expect(rb.view?.holder).toBe("claude_code");
    expect((await b.replays.captureMcp(opened.replay_id)).view?.holder).toBe("claude_code");
    expect((await a.replays.captureMcp(opened.replay_id)).view?.holder).toBe("claude_code_other");
    await a.replays.resize(opened.replay_id, 90, 30);
    expect((await a.replays.captureMcp(opened.replay_id)).view?.holder).toBe("claude_code");
    expect((await b.replays.captureMcp(opened.replay_id)).view?.holder).toBe("claude_code_other");
  });

  test("a viewer opening through a server that holds a remote entry is redirected to the owner, and joins there", async () => {
    const w = newWorld();
    const a = await w.server();
    const b = await w.server();
    const opened = await a.replays.open(w.target);
    await b.replays.open(w.target);
    const vb = await viewer(w, b.name);
    const e = await errorOf(vb.request("replay.open", { session_id: "s1" }));
    expect(e).toBeInstanceOf(ViewError);
    expect((e as ViewError).code).toBe("replay_elsewhere");
    expect((e as ViewError).elsewhere).toEqual({ endpoint: a.name, replay_id: opened.replay_id });
    vb.close();

    const va = await viewer(w, a.name);
    const joined = await va.request<{ replay_id: string }>("replay.open", {
      replay_id: opened.replay_id,
    });
    expect(joined.replay_id).toBe(opened.replay_id);
    const claim = await va.request<{ granted: boolean; view: { holder: string } }>("claim", {
      target: `r:${opened.replay_id}`,
      cols: 70,
      rows: 20,
    });
    expect(claim.granted).toBe(true);
    expect(claim.view.holder).toBe("terminal");
    // the claim and the size live on the owner
    expect((await b.replays.captureMcp(opened.replay_id)).view?.holder).toBe("terminal");
    va.close();
    expect(w.spawns.panes).toHaveLength(1);
  });

  test("a viewer redirected through the registry leaves no provisional entry: that server's next MCP open joins", async () => {
    const w = newWorld();
    const a = await w.server();
    const opened = await a.replays.open(w.target);
    const c = await w.server();
    const vc = await viewer(w, c.name);
    const e = await errorOf(vc.request("replay.open", { session_id: "s1" }));
    expect((e as ViewError).code).toBe("replay_elsewhere");
    expect((e as ViewError).elsewhere?.replay_id).toBe(opened.replay_id);
    vc.close();
    const joined = await c.replays.open(w.target);
    expect(joined.replay_id).toBe(opened.replay_id);
    expect(w.spawns.panes).toHaveLength(1);
  });

  test("viewer holds: release with an MCP hold present keeps the replay; the owner's close with a viewer hold present reaps", async () => {
    const w = newWorld();
    const a = await w.server();
    const opened = await a.replays.open(w.target);
    const v = await viewer(w, a.name);
    await v.request("replay.open", { replay_id: opened.replay_id });
    expect(
      await v.request<{ closed: boolean }>("replay.release", { replay_id: opened.replay_id })
    ).toEqual({
      closed: false,
    });
    expect(w.alive()).toHaveLength(1);
    await v.request("replay.open", { replay_id: opened.replay_id });
    expect(await a.replays.close(opened.replay_id)).toEqual({ closed: true });
    expect(w.alive()).toHaveLength(0);
    // the viewer still holds the closed entry: its capture answers the final screen
    const fin = await v.request<{ final: boolean }>("capture", { target: `r:${opened.replay_id}` });
    expect(fin.final).toBe(true);
    v.close();
  });

  test("a viewer-opened replay ends when its only holder disconnects", async () => {
    const w = newWorld();
    const a = await w.server();
    const v = await viewer(w, a.name);
    const r = await v.request<{ replay_id: string; target: string }>("replay.open", {
      session_id: "s1",
    });
    expect(r.target).toBe(`r:${r.replay_id}`);
    expect(w.alive()).toHaveLength(1);
    v.close();
    await eventually(() => expect(w.alive()).toHaveLength(0));
    expect(a.replays.registry.read(w.target.claudeSessionId as string)).toBeNull();
  });

  test("a shutting-down owner answers joins unknown_session, so a joiner waits and then opens fresh", async () => {
    const w = newWorld();
    const a = await w.server();
    const b = await w.server({ readyMs: 500, joinExtraMs: 5_000 });
    const opened = await a.replays.open(w.target);
    a.replays.beginShutdown();
    const joining = b.replays.open(w.target);
    await Bun.sleep(300);
    expect(w.spawns.panes).toHaveLength(1);
    w.spawns.panes[0]?.kill();
    const fresh = await joining;
    expect(fresh.replay_id).not.toBe(opened.replay_id);
    expect(w.spawns.panes).toHaveLength(2);
  });

  test("a stale entry over a free lock is overwritten, and compare-and-delete leaves the new owner's entry", async () => {
    const w = newWorld();
    const a = await w.server();
    const first = await a.replays.open(w.target);
    w.spawns.panes[0]?.kill();
    await eventually(() => expect(w.alive()).toHaveLength(0));
    const uuid = w.target.claudeSessionId as string;
    const b = await w.server();
    const second = await b.replays.open(w.target);
    expect(b.replays.registry.read(uuid)?.replay_id).toBe(second.replay_id);
    expect(await a.replays.registry.removeIf(uuid, first.replay_id)).toBe(false);
    expect(b.replays.registry.read(uuid)?.replay_id).toBe(second.replay_id);
  });

  test("claudish view <finished session> through a server holding a remote entry: redirected, joined and claimed on the owner", async () => {
    const w = newWorld();
    const a = await w.server();
    const b = await w.server();
    const opened = await a.replays.open(w.target);
    await b.replays.open(w.target);
    const io = viewerIo();
    const v = new Viewer({
      root: w.root,
      target: "s:s1",
      io,
      endpoint: endpointPathOf(w.root, b.name),
      endpointAlive: (n) => w.endpointAlive(n),
    });
    const run = v.run();
    const target = `r:${opened.replay_id}`;
    await eventually(() => expect(a.claims.holder(target)?.holder).toBe("terminal"));
    expect(b.claims.holder(target)).toBeNull();
    expect(w.spawns.panes).toHaveLength(1);
    v.quit();
    expect((await run).code).toBe(0);
    // A's Claude Code still holds it: the viewer's release ends nothing
    await Bun.sleep(100);
    expect(w.alive()).toHaveLength(1);
    expect(a.claims.holder(target)).toBeNull();
  });

  test("claudish view <finished session> with no replay anywhere opens one, held by the viewer alone", async () => {
    const w = newWorld();
    const a = await w.server();
    const io = viewerIo();
    const v = new Viewer({
      root: w.root,
      target: "s1",
      io,
      endpointAlive: (n) => w.endpointAlive(n),
    });
    const run = v.run();
    await eventually(() => expect(w.alive()).toHaveLength(1));
    const [listed] = a.replays.list();
    await eventually(() => expect(a.claims.holder(listed?.target ?? "")?.holder).toBe("terminal"));
    v.quit();
    expect((await run).code).toBe(0);
    await eventually(() => expect(w.alive()).toHaveLength(0));
  });

  test("claudish view r:<replay_id> holds the replay: the first viewer leaving does not reap it under the second", async () => {
    const w = newWorld();
    const a = await w.server();
    const first = new Viewer({
      root: w.root,
      target: "s1",
      io: viewerIo(),
      endpointAlive: (n) => w.endpointAlive(n),
    });
    const firstRun = first.run();
    await eventually(() => expect(w.alive()).toHaveLength(1));
    const [listed] = a.replays.list();
    const target = listed?.target ?? "";
    await eventually(() => expect(a.claims.holder(target)?.holder).toBe("terminal"));
    let secondDone = false;
    const second = new Viewer({
      root: w.root,
      target,
      io: viewerIo(),
      endpointAlive: (n) => w.endpointAlive(n),
    });
    const secondRun = second.run().then((o) => {
      secondDone = true;
      return o;
    });
    await eventually(() => expect(a.claims.holder(target)?.holder).toBe("terminal"));
    await Bun.sleep(100);
    first.quit();
    expect((await firstRun).code).toBe(0);
    await Bun.sleep(300);
    expect(w.alive()).toHaveLength(1);
    expect(secondDone).toBe(false);
    second.quit();
    expect((await secondRun).code).toBe(0);
    await eventually(() => expect(w.alive()).toHaveLength(0));
  });

  test("a viewer that disconnects while the replay boots leaves no hold: open by session, join by id, and the spawning open", async () => {
    const w = newWorld();
    w.ctl.readyDelayMs = 400;
    const a = await w.server();
    // the spawning open's connection stays; two more connect during the boot and leave before it ends
    const owner = await viewer(w, a.name);
    const opening = owner.request<{ replay_id: string }>(
      "replay.open",
      { session_id: "s1" },
      5_000
    );
    await eventually(() => expect(a.replays.list()).toHaveLength(1));
    const replayId = a.replays.list()[0]?.replay_id as string;
    const bySession = await viewer(w, a.name);
    const byId = await viewer(w, a.name);
    void bySession.request("replay.open", { session_id: "s1" }, 5_000).catch(() => {});
    void byId.request("replay.open", { replay_id: replayId }, 5_000).catch(() => {});
    await Bun.sleep(100);
    bySession.close();
    byId.close();
    expect((await opening).replay_id).toBe(replayId);
    await Bun.sleep(200);
    // the only live holder leaves: the replay goes
    expect(
      await owner.request<{ closed: boolean }>("replay.release", { replay_id: replayId })
    ).toEqual({
      closed: true,
    });
    await eventually(() => expect(w.alive()).toHaveLength(0));
    owner.close();
  });

  test("a viewer whose spawning open loses its connection during the boot leaves no replay behind", async () => {
    const w = newWorld();
    w.ctl.readyDelayMs = 400;
    const a = await w.server();
    const v = await viewer(w, a.name);
    void v.request("replay.open", { session_id: "s1" }, 5_000).catch(() => {});
    await eventually(() => expect(w.spawns.panes).toHaveLength(1));
    v.close();
    await Bun.sleep(700);
    await eventually(() => expect(w.alive()).toHaveLength(0));
  });

  test("a peer may place once per workspace: the owner's grant, then place_done gives it back", async () => {
    const w = newWorld();
    const a = await w.server();
    const opened = await a.replays.open(w.target);
    const peer = await ViewClient.connect(endpointPathOf(w.root, a.name), {
      hello: { name: "peer", kind: "peer", endpoint: (await w.server()).name } as never,
    });
    const key = "0123abcd/w1";
    const one = await peer.request<{ place: boolean }>("replay.open", {
      replay_id: opened.replay_id,
      place: { workspace_key: key, txn: "ptxn1" },
    });
    expect(one.place).toBe(true);
    const two = await peer.request<{ place: boolean }>("replay.open", {
      replay_id: opened.replay_id,
      place: { workspace_key: key, txn: "ptxn2" },
    });
    expect(two.place).toBe(false);
    expect(a.grants.workspaces(`r:${opened.replay_id}`)).toEqual([key]);
    await peer.request("replay.place_done", { replay_id: opened.replay_id, workspace_key: key });
    expect(a.grants.workspaces(`r:${opened.replay_id}`)).toEqual([]);
    peer.close();
  });
});
