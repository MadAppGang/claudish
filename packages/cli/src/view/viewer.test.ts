/**
 * The viewer against a fake endpoint and a fake magmux view socket, both real unix sockets: the
 * claim is taken, renewed and released in that order; losing it shows the band and unwatches the
 * frames; no key ever travels down either socket; the viewer exits on `item.remove`, on a
 * terminal row, on `server.closing`, and when the server that owns the endpoint is killed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ViewHolder } from "../pane/contract.js";
import type { ViewItem } from "../pane/view-contract.js";
import { capturedFrames } from "./test-data/captured-frames.js";
import {
  FakeMagmuxView,
  FakeViewEndpoint,
  makeViewRoot,
} from "./test-helpers/fake-view-endpoint.js";
import {
  Viewer,
  type ViewerIo,
  type ViewerOutcome,
  bandText,
  normalizeViewTarget,
} from "./viewer.js";

const T = 20_000;
const FAKE_ENDPOINT_SCRIPT = join(import.meta.dir, "test-helpers", "fake-view-endpoint.ts");

function sessionItem(viewSocket: string | null, extra: Record<string, unknown> = {}): ViewItem {
  return {
    kind: "session",
    target: "s:sess-1",
    session_id: "sess-1",
    state: "AWAITING_INPUT",
    reason: null,
    model: "fake-model",
    view: null,
    prompt_summary: null,
    prompts_sent: 1,
    pending_inputs: 0,
    subagents: [],
    magmux: { pane_id: "pv", view_socket: viewSocket },
    ...extra,
  } as unknown as ViewItem;
}

interface FakeIo extends ViewerIo {
  output: string;
  press(keys: string): void;
  resizeTo(cols: number, rows: number): void;
}

function fakeIo(cols = 80, rows = 25): FakeIo {
  let keyFn: ((s: string) => void) | null = null;
  let resizeFn: (() => void) | null = null;
  const size = { cols, rows };
  const io: FakeIo = {
    output: "",
    write: (s) => {
      io.output += s;
    },
    term: () => ({ ...size }),
    onKeys(fn) {
      keyFn = fn;
      return () => {
        keyFn = null;
      };
    },
    onResize(fn) {
      resizeFn = fn;
      return () => {
        resizeFn = null;
      };
    },
    press: (keys) => keyFn?.(keys),
    resizeTo(c, r) {
      size.cols = c;
      size.rows = r;
      resizeFn?.();
    },
  };
  return io;
}

async function until(probe: () => boolean, what: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > end) throw new Error(`${what} not seen in ${ms} ms`);
    await Bun.sleep(10);
  }
}

interface Rig {
  root: string;
  ep: FakeViewEndpoint;
  mag: FakeMagmuxView;
  io: FakeIo;
  viewer: Viewer;
  run: Promise<ViewerOutcome>;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function newRoot(): string {
  const root = `/tmp/cpv-${randomBytes(4).toString("hex")}`;
  makeViewRoot(root);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function rig(o: { passive?: boolean } = {}): Promise<Rig> {
  const root = newRoot();
  const viewPath = join(root, "magmux-pv.view");
  const mag = await FakeMagmuxView.start({ path: viewPath, frames: capturedFrames("sgr-runs") });
  const ep = await FakeViewEndpoint.start({ root, item: sessionItem(viewPath), label: "TestTerm" });
  const io = fakeIo();
  const viewer = new Viewer({
    root,
    target: "sess-1",
    passive: o.passive,
    io,
    renewMs: 40,
    verdictMs: 20,
    resizeDebounceMs: 5,
  });
  const run = viewer.run();
  cleanups.push(async () => {
    viewer.quit();
    await run;
    await ep.close();
    await mag.close();
  });
  return { root, ep, mag, io, viewer, run };
}

const otherHolder: ViewHolder = {
  holder: "herdr",
  label: "herdr",
  since: new Date().toISOString(),
  claim_id: "someone-else",
};

describe("target spellings", () => {
  test("the six forms normalize to the prefixed one", () => {
    expect(normalizeViewTarget("abc")).toBe("s:abc");
    expect(normalizeViewTarget("s:abc")).toBe("s:abc");
    expect(normalizeViewTarget("run-1/01")).toBe("t:run-1/01");
    expect(normalizeViewTarget("t:run-1/01")).toBe("t:run-1/01");
    expect(normalizeViewTarget("replay-9f3a")).toBe("r:replay-9f3a");
    expect(normalizeViewTarget("r:replay-9f3a")).toBe("r:replay-9f3a");
    expect(normalizeViewTarget("  ")).toBeNull();
    expect(normalizeViewTarget("t:nослот/")).toBeNull();
  });

  test("the band names the holder, or only the key when nobody holds the view", () => {
    expect(bandText(otherHolder)).toBe("viewing in herdr — Enter to view here");
    expect(bandText(null)).toBe("Enter to view here");
  });
});

describe("Viewer", () => {
  test(
    "claims at start, renews while holding, releases on q, in that order",
    async () => {
      const r = await rig();
      await until(() => r.ep.ops().filter((op) => op === "renew").length >= 2, "two renewals");
      await until(() => r.io.output.includes("bold red"), "the session's screen");
      r.io.press("q");
      const outcome = await r.run;
      expect(outcome).toEqual({ code: 0, message: "" });
      const claimOps = r.ep.ops().filter((op) => ["claim", "renew", "release"].includes(op));
      expect(claimOps[0]).toBe("claim");
      expect(claimOps.at(-1)).toBe("release");
      expect(claimOps.slice(1, -1).every((op) => op === "renew")).toBe(true);
      const claim = r.ep.received.find((m) => m.op === "claim");
      // the whole terminal but its status row
      expect(claim?.args).toEqual({ target: "s:sess-1", cols: 80, rows: 24 });
      expect(r.mag.types()).toEqual(["capabilities", "watch", "unwatch"]);
      expect(r.io.output.endsWith("\x1b[0m\x1b[?25h\x1b[?1049l")).toBe(true);
    },
    T
  );

  test(
    "losing the claim shows the band, unwatches, stops renewing; Enter takes it back",
    async () => {
      const r = await rig();
      await until(() => r.io.output.includes("bold red"), "the session's screen");
      r.ep.steal(otherHolder);
      await until(() => r.mag.types().includes("unwatch"), "unwatch");
      await until(() => r.io.output.includes("viewing in herdr — Enter to view here"), "the band");
      const renewsAtLoss = r.ep.ops().filter((op) => op === "renew").length;
      await Bun.sleep(150);
      expect(r.ep.ops().filter((op) => op === "renew").length).toBe(renewsAtLoss);
      // frames that still arrive while unwatched are not painted
      r.io.output = "";
      r.mag.push({ ...capturedFrames("sgr-runs")[0], seq: 99 });
      await Bun.sleep(50);
      expect(r.io.output).not.toContain("bold red");

      r.io.press("\r");
      await until(() => r.ep.ops().filter((op) => op === "claim").length === 2, "a second claim");
      await until(() => r.mag.types().filter((t) => t === "watch").length === 2, "a new watch");
      await until(() => r.io.output.includes("bold red"), "the screen again");
    },
    T
  );

  test(
    "a refused renewal is a lost claim",
    async () => {
      const r = await rig();
      await until(() => r.mag.types().includes("watch"), "watch");
      r.ep.refuseRenew = true;
      await until(() => r.mag.types().includes("unwatch"), "unwatch after view_not_held");
      await until(() => r.io.output.includes("Enter to view here"), "the band");
    },
    T
  );

  test(
    "keys are the viewer's own: nothing typed reaches either socket",
    async () => {
      const r = await rig();
      await until(() => r.mag.types().includes("watch"), "watch");
      r.io.press("hello world\x1b[A\t\x7f123");
      r.io.press("\r");
      r.io.press("ls -la\r");
      await Bun.sleep(100);
      r.io.press("q");
      await r.run;
      const allowedOps = new Set(["hello", "list", "subscribe", "claim", "renew", "release"]);
      expect(r.ep.ops().filter((op) => !allowedOps.has(op))).toEqual([]);
      expect(
        r.mag.types().filter((t) => !["capabilities", "watch", "unwatch"].includes(t))
      ).toEqual([]);
      const wire = JSON.stringify([r.ep.received, r.mag.received]);
      for (const typed of ["hello world", "ls -la", "123", "\\t"])
        expect(wire).not.toContain(typed);
      // Enter while holding takes nothing again
      expect(r.ep.ops().filter((op) => op === "claim")).toHaveLength(1);
    },
    T
  );

  test(
    "a passive viewer does not claim at start and shows the band",
    async () => {
      const r = await rig({ passive: true });
      await until(() => r.io.output.includes("Enter to view here"), "the band");
      await Bun.sleep(100);
      expect(r.ep.ops()).not.toContain("claim");
      expect(r.mag.received).toEqual([]);
      r.io.press("\r");
      await until(() => r.io.output.includes("bold red"), "the screen after Enter");
      expect(r.ep.ops().filter((op) => op === "claim")).toHaveLength(1);
    },
    T
  );

  test(
    "a resized terminal resizes the pane only while this viewer holds the view",
    async () => {
      const r = await rig();
      await until(() => r.mag.types().includes("watch"), "watch");
      r.io.resizeTo(100, 31);
      await until(() => r.ep.ops().includes("resize"), "resize");
      expect(r.ep.received.find((m) => m.op === "resize")?.args).toEqual({
        target: "s:sess-1",
        cols: 100,
        rows: 30,
      });
      r.ep.steal(otherHolder);
      await until(() => r.mag.types().includes("unwatch"), "unwatch");
      r.io.resizeTo(60, 20);
      await Bun.sleep(100);
      expect(r.ep.ops().filter((op) => op === "resize")).toHaveLength(1);
    },
    T
  );

  test(
    "item.remove ends the viewer with the final screen and a verdict",
    async () => {
      const r = await rig();
      await until(() => r.io.output.includes("bold red"), "the session's screen");
      r.ep.remove("evicted");
      const outcome = await r.run;
      expect(outcome).toEqual({ code: 0, message: "s:sess-1 is no longer listed" });
      expect(r.ep.ops().at(-1)).toBe("release");
    },
    T
  );

  test(
    "a terminal row ends the viewer with its state as the verdict",
    async () => {
      const r = await rig();
      await until(() => r.io.output.includes("bold red"), "the session's screen");
      r.ep.upsert({
        ...r.ep.item,
        state: "COMPLETED",
        view: r.ep.item.view,
      } as ViewItem);
      const outcome = await r.run;
      expect(outcome).toEqual({ code: 0, message: "s:sess-1 COMPLETED" });
      expect(r.io.output).toContain("s:sess-1 COMPLETED");
    },
    T
  );

  test(
    "server.closing ends the viewer: claudish server ended",
    async () => {
      const r = await rig();
      await until(() => r.mag.types().includes("watch"), "watch");
      r.ep.closing();
      expect(await r.run).toEqual({ code: 1, message: "claudish server ended" });
    },
    T
  );

  test(
    "a finished target is opened as a replay on the server that lists it; a passive viewer never opens one",
    async () => {
      const root = newRoot();
      const ep = await FakeViewEndpoint.start({
        root,
        item: sessionItem(null, { state: "COMPLETED" }),
      });
      cleanups.push(() => ep.close());
      const io = fakeIo();
      // this fake opens no replays: the viewer asked, on its own connection, and reports the answer
      const outcome = await new Viewer({ root, target: "s:sess-1", io }).run();
      expect(outcome.code).toBe(1);
      expect(ep.ops()).toEqual(["hello", "list", "hello", "replay.open"]);
      const passive = await new Viewer({ root, target: "s:sess-1", io, passive: true }).run();
      expect(passive).toEqual({ code: 1, message: "s:sess-1 has finished" });
    },
    T
  );

  test(
    "no server, and no such target",
    async () => {
      const root = newRoot();
      const io = fakeIo();
      expect(await new Viewer({ root, target: "s:x", io }).run()).toEqual({
        code: 1,
        message: "no claudish MCP server is running; open the session from Claude Code",
      });
      const ep = await FakeViewEndpoint.start({ root, item: sessionItem(null) });
      cleanups.push(() => ep.close());
      expect(await new Viewer({ root, target: "s:other", io }).run()).toEqual({
        code: 1,
        message: "no running claudish MCP server lists s:other",
      });
      expect(await new Viewer({ root, target: "replay-ab12", io }).run()).toEqual({
        code: 1,
        message: "no such replay: r:replay-ab12",
      });
    },
    T
  );

  test(
    "a view socket that does not answer read-only is never watched",
    async () => {
      const root = newRoot();
      const viewPath = join(root, "magmux-pv.view");
      const mag = await FakeMagmuxView.start({ path: viewPath, frames: [], readOnly: false });
      const ep = await FakeViewEndpoint.start({ root, item: sessionItem(viewPath) });
      const io = fakeIo();
      const viewer = new Viewer({ root, target: "s:sess-1", io });
      const run = viewer.run();
      cleanups.push(async () => {
        viewer.quit();
        await run;
        await ep.close();
        await mag.close();
      });
      await until(() => io.output.includes("does not answer read-only"), "the refusal");
      // past the retry interval: a refused socket is not dialed again
      await Bun.sleep(700);
      expect(mag.types()).toEqual(["capabilities"]);
    },
    T
  );

  test(
    "the owner killed: EOF with a dead owner ends the viewer",
    async () => {
      const root = newRoot();
      const viewPath = join(root, "magmux-pv.view");
      const mag = await FakeMagmuxView.start({
        path: viewPath,
        frames: capturedFrames("sgr-runs"),
      });
      cleanups.push(() => mag.close());
      const child = Bun.spawn(
        [process.execPath, FAKE_ENDPOINT_SCRIPT, root, JSON.stringify(sessionItem(viewPath))],
        { stdout: "pipe", stderr: "inherit", env: { ...process.env } }
      );
      cleanups.push(() => {
        child.kill("SIGKILL");
      });
      const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("ready");
      const io = fakeIo();
      const viewer = new Viewer({ root, target: "s:sess-1", io, renewMs: 40 });
      const run = viewer.run();
      cleanups.push(async () => {
        viewer.quit();
        await run;
      });
      await until(() => io.output.includes("bold red"), "the session's screen");
      child.kill("SIGKILL");
      await child.exited;
      expect(await run).toEqual({ code: 1, message: "claudish server ended" });
    },
    T
  );
});
