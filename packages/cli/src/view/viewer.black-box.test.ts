import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { eventually, sessionItem } from "../herdr/test-helpers/view-items.js";
import type { ViewHolder } from "../pane/contract.js";
import { capturedFrames } from "./test-data/captured-frames.js";
import {
  FakeMagmuxView,
  FakeViewEndpoint,
  makeViewRoot,
} from "./test-helpers/fake-view-endpoint.js";
import { Viewer, type ViewerIo } from "./viewer.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const stop of cleanups.splice(0).reverse()) await stop();
});

function terminal() {
  let key: ((s: string) => void) | undefined;
  let resize: (() => void) | undefined;
  let size = { cols: 80, rows: 25 };
  let output = "";
  const io: ViewerIo = {
    write: (s) => {
      output += s;
    },
    term: () => ({ ...size }),
    onKeys: (fn) => {
      key = fn;
      return () => {
        key = undefined;
      };
    },
    onResize: (fn) => {
      resize = fn;
      return () => {
        resize = undefined;
      };
    },
  };
  return {
    io,
    text: () => output,
    clear: () => {
      output = "";
    },
    press: (s: string) => key?.(s),
    resizeTo: (cols: number, rows: number) => {
      size = { cols, rows };
      resize?.();
    },
  };
}
async function rig() {
  const root = `/tmp/wbb-${randomBytes(4).toString("hex")}`;
  makeViewRoot(root);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "magmux-test.view");
  const frames = capturedFrames("sgr-runs");
  const mag = await FakeMagmuxView.start({ path, frames });
  cleanups.push(() => mag.close());
  const ep = await FakeViewEndpoint.start({
    root,
    item: { ...sessionItem("a"), magmux: { pane_id: "test", view_socket: path } },
  });
  cleanups.push(() => ep.close());
  const term = terminal();
  const viewer = new Viewer({
    root,
    target: "s:a",
    io: term.io,
    endpoint: ep.path,
    endpointAlive: () => true,
    verdictMs: 5,
    resizeDebounceMs: 5,
  });
  const run = viewer.run();
  cleanups.push(async () => {
    viewer.quit();
    await run;
  });
  return { root, frames, mag, ep, term, viewer, run };
}

describe("read-only viewer over both real Unix connections", () => {
  test("TEST-33 REQ-9 REQ-10 REQ-11 REQ-12 another holder changes nothing: frames keep painting, Enter takes nothing", async () => {
    const r = await rig();
    await eventually(() => expect(r.term.text()).toContain("bold red"));
    const other: ViewHolder = {
      holder: "claude_code",
      label: "Claude Code",
      since: "2026-11-10T00:00:00.000Z",
      claim_id: "another-view",
    };

    r.ep.steal(other);
    r.term.clear();
    r.mag.push({ ...r.frames[0], seq: 999 });
    await eventually(() => expect(r.term.text()).toContain("bold red"));
    r.term.press("\r");
    r.term.resizeTo(90, 28);
    await Bun.sleep(30);

    expect(r.mag.types()).not.toContain("unwatch");
    expect(r.ep.ops().filter((op) => ["claim", "renew", "release", "resize"].includes(op))).toEqual(
      []
    );
    expect(r.ep.item.view).toEqual(other);
  });

  test("TEST-35 REQ-10 REQ-28 typed, pasted and navigation bytes remain local and q exits", async () => {
    const r = await rig();
    await eventually(() => expect(r.term.text()).toContain("bold red"));

    r.term.press("never-deliver-7319");
    r.term.press("\u001b[A\u001b[B\t\u007f");
    r.term.press("\u001b[200~pasted-text-7319\u001b[201~");
    r.term.press("q");
    const outcome = await r.run;

    expect(outcome).toEqual({ code: 0, message: "" });
    const endpointAllowed = new Set(["hello", "list", "subscribe", "unsubscribe"]);
    const magmuxAllowed = new Set(["capabilities", "watch", "unwatch", "resync"]);
    expect(r.ep.ops().filter((op) => !endpointAllowed.has(op))).toEqual([]);
    expect(r.mag.types().filter((type) => !magmuxAllowed.has(type))).toEqual([]);
    const wire = JSON.stringify([r.ep.received, r.mag.received]);
    expect(wire).not.toContain("never-deliver-7319");
    expect(wire).not.toContain("pasted-text-7319");
  });
});
