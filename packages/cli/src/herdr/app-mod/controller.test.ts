import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ViewItem } from "../../pane/view-contract.js";
import { sessionItem } from "../test-helpers/placer-harness.js";
import { INSTALL_LINE, type ModHost, PanelController } from "./controller.js";
import {
  type ExecResult,
  FEED_TERMINAL,
  LIVENESS_MS,
  POLL_MS,
  type TerminalInfo,
  VIEW_WINDOW_KEY,
  viewTerminalName,
} from "./model.js";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const CLAUDISH = "/Users/u/.bun/bin/claudish";
const ROOT = "/tmp/claudish-mux-501";
const FEED = `${ROOT}/feed/feed.json`;

interface Call {
  via: "exec" | "hc";
  argv: string[];
}

/** A Herdr host with scripted answers; records every call the controller makes. */
class FakeHost implements ModHost {
  calls: Call[] = [];
  overlays: Record<string, unknown>[] = [];
  killed: string[] = [];
  files = new Map<string, string>();
  live: TerminalInfo[] = [];
  clock = 1_000_000;
  installed = true;
  relayAlive: { alive: boolean; reason?: string; relay?: unknown } = {
    alive: false,
    reason: "missing",
  };
  listing: { servers: unknown[]; items: ViewItem[] } = { servers: [], items: [] };
  nextAddress = 10;
  hcAnswer: ((argv: string[]) => ExecResult) | null = null;

  async exec(command: string, args: string[]): Promise<ExecResult> {
    const argv = [command, ...args];
    this.calls.push({ via: "exec", argv });
    if (command === "/bin/sh")
      return this.installed
        ? { code: 0, stdout: `${CLAUDISH}\n/Users/u/.bun/bin:/usr/bin\n`, stderr: "" }
        : { code: 1, stdout: "", stderr: "" };
    const at = argv.indexOf(CLAUDISH);
    const rest = argv.slice(at + 1).join(" ");
    if (rest === "--version") return { code: 0, stdout: "claudish version 14.16.1\n", stderr: "" };
    if (rest === "view --print-root") return { code: 0, stdout: `${ROOT}\n`, stderr: "" };
    if (rest === "view --feed-check")
      return {
        code: this.relayAlive.alive ? 0 : 1,
        stdout: `${JSON.stringify(this.relayAlive)}\n`,
        stderr: "",
      };
    if (rest === "view --list --json")
      return { code: 0, stdout: `${JSON.stringify(this.listing)}\n`, stderr: "" };
    return { code: 2, stdout: "", stderr: `unexpected ${rest}` };
  }

  async hc(args: string[]): Promise<ExecResult> {
    this.calls.push({ via: "hc", argv: args });
    if (this.hcAnswer) return this.hcAnswer(args);
    if (args[0] === "run") {
      const name = args[args.indexOf("--name") + 1] as string;
      const address = `t${this.nextAddress++}`;
      this.live.push({ address, name, state: "live" });
      return { code: 0, stdout: JSON.stringify({ address, name, state: "live" }), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  }

  async readTextFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  terminals(): TerminalInfo[] {
    return this.live;
  }

  openOverlay(spec: Record<string, unknown>): string {
    this.overlays.push(spec);
    return `o${this.overlays.length}`;
  }

  killTerminal(address: string): void {
    this.killed.push(address);
    this.live = this.live.filter((t) => t.address !== address);
  }

  home(): string {
    return "/Users/u";
  }

  sha256Hex(s: string): string {
    return sha256(s);
  }

  now(): number {
    return this.clock;
  }

  /** the claudish subcommands run so far, e.g. "view --feed-check" */
  claudishRuns(): string[] {
    return this.calls
      .filter((c) => c.via === "exec" && c.argv.includes(CLAUDISH))
      .map((c) => c.argv.slice(c.argv.indexOf(CLAUDISH) + 1).join(" "));
  }

  hcRuns(): string[][] {
    return this.calls.filter((c) => c.via === "hc").map((c) => c.argv);
  }

  writeFeed(relay: { pid: number; start36: string }, items: ViewItem[]): void {
    this.files.set(
      FEED,
      JSON.stringify({
        relay: { ...relay, started_at: "x" },
        written_at: "x",
        servers: [{}],
        items,
      })
    );
  }
}

async function ready(host: FakeHost): Promise<PanelController> {
  const ctl = new PanelController(host);
  await ctl.boot();
  expect(ctl.phase).toBe("ready");
  return ctl;
}

describe("PanelController", () => {
  test("without claudish it shows the install line and starts nothing", async () => {
    const host = new FakeHost();
    host.installed = false;
    const ctl = new PanelController(host);
    await ctl.boot();
    ctl.setVisible(true);
    await ctl.tick();
    expect(ctl.phase).toBe("missing");
    expect(ctl.message).toBe(INSTALL_LINE);
    expect(host.hcRuns()).toEqual([]);
    expect(host.claudishRuns()).toEqual([]);
  });

  test("at load it asks claudish for its version and socket root, through the PATH it found", async () => {
    const host = new FakeHost();
    const ctl = await ready(host);
    expect(ctl.install).toEqual({
      path: CLAUDISH,
      pathEnv: "/Users/u/.bun/bin:/usr/bin",
      root: ROOT,
      version: "claudish version 14.16.1",
    });
    expect(host.claudishRuns()).toEqual(["--version", "view --print-root"]);
    expect(ctl.feedPath).toBe(FEED);
  });

  test("while the panel is hidden nothing runs at all", async () => {
    const host = new FakeHost();
    const ctl = await ready(host);
    const before = host.calls.length;
    for (let i = 0; i < 5; i++) {
      host.clock += LIVENESS_MS;
      await ctl.tick();
    }
    expect(host.calls.length).toBe(before);
    expect(ctl.watching).toBe(false);
  });

  test("first show: no relay → it is started under its name, and the list polls until its file appears", async () => {
    const host = new FakeHost();
    const ctl = await ready(host);
    host.listing = {
      servers: [{ endpoint: "c1-a.sock", pid: 1, version: "v" }],
      items: [sessionItem("a")],
    };
    ctl.setVisible(true);
    await ctl.tick();
    const runs = host.hcRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.slice(runs[0].indexOf("--name"), runs[0].indexOf("--name") + 2)).toEqual([
      "--name",
      FEED_TERMINAL,
    ]);
    expect(runs[0]?.slice(-2)).toEqual(["view", "--feed"]);
    expect(ctl.mode).toBe("poll");
    expect(ctl.items.map((i) => i.target)).toEqual(["s:a"]);
    expect(ctl.nextWaitMs()).toBe(POLL_MS);
    expect(ctl.watching).toBe(false);

    host.relayAlive = { alive: true, relay: { pid: 7, start36: "b" } };
    host.writeFeed({ pid: 7, start36: "b" }, [sessionItem("a"), sessionItem("b")]);
    await ctl.tick();
    expect(ctl.mode).toBe("relay");
    expect(ctl.items.map((i) => i.target)).toEqual(["s:a", "s:b"]);
    expect(ctl.watching).toBe(true);
    expect(host.claudishRuns().filter((r) => r === "view --list --json")).toHaveLength(1);
  });

  test("a relay found dead empties the list at once, restarts it, and ignores its stale file", async () => {
    const host = new FakeHost();
    host.relayAlive = { alive: true, relay: { pid: 7, start36: "b" } };
    host.writeFeed({ pid: 7, start36: "b" }, [sessionItem("a")]);
    const ctl = await ready(host);
    ctl.setVisible(true);
    await ctl.tick();
    expect(ctl.mode).toBe("relay");
    expect(ctl.items).toHaveLength(1);
    expect(host.hcRuns()).toEqual([]);

    // the 15 s check finds the stamped relay gone; its file is still there
    host.relayAlive = { alive: false, reason: "relay_gone", relay: { pid: 7, start36: "b" } };
    host.listing = { servers: [], items: [] };
    host.clock += LIVENESS_MS;
    expect(ctl.nextWaitMs()).toBe(0);
    await ctl.tick();
    expect(ctl.mode).toBe("poll");
    expect(host.hcRuns()).toHaveLength(1);
    expect(ctl.items).toEqual([]);
    expect(ctl.message).toBe("no claudish MCP server is running");
    await ctl.tick();
    expect(ctl.mode).toBe("poll");

    host.writeFeed({ pid: 8, start36: "c" }, [sessionItem("z")]);
    await ctl.tick();
    expect(ctl.mode).toBe("relay");
    expect(ctl.items.map((i) => i.target)).toEqual(["s:z"]);
  });

  test("the relay's terminal leaving terminals() wakes the loop and makes the check due", async () => {
    const host = new FakeHost();
    host.relayAlive = { alive: true, relay: { pid: 7, start36: "b" } };
    host.writeFeed({ pid: 7, start36: "b" }, []);
    const ctl = await ready(host);
    ctl.setVisible(true);
    await ctl.tick();
    expect(ctl.nextWaitMs()).toBe(LIVENESS_MS);
    ctl.noteTerminals([{ address: "t3", name: FEED_TERMINAL, state: "live" }]);
    let woke = false;
    void ctl.changed().then(() => {
      woke = true;
    });
    ctl.noteTerminals([]);
    await Bun.sleep(0);
    expect(woke).toBe(true);
    expect(ctl.nextWaitMs()).toBe(0);
  });

  test("selecting starts one viewer per target, shows it in the keyed window, and kills the previous", async () => {
    const host = new FakeHost();
    host.relayAlive = { alive: true, relay: { pid: 7, start36: "b" } };
    host.writeFeed({ pid: 7, start36: "b" }, [sessionItem("a"), sessionItem("b")]);
    const ctl = await ready(host);
    ctl.setVisible(true);
    await ctl.tick();

    await ctl.select("s:a");
    const nameA = viewTerminalName("s:a", sha256);
    const runA = host.hcRuns()[0] as string[];
    expect(runA[runA.indexOf("--name") + 1]).toBe(nameA);
    expect(runA.slice(-4)).toEqual(["view", "s:a", "--front-end", "herdr-core"]);
    expect(host.overlays).toHaveLength(1);
    expect(host.overlays[0]).toMatchObject({ kind: "window", key: VIEW_WINDOW_KEY });
    expect(JSON.stringify(host.overlays[0])).toContain('"terminal":"t10"');
    expect(ctl.selected).toBe("s:a");

    // the same target again: its live viewer is shown, no second one starts
    await ctl.select("s:a");
    const starts = (): string[][] => host.hcRuns().filter((a) => a[0] === "run");
    expect(starts()).toHaveLength(1);
    expect(host.overlays).toHaveLength(2);

    await ctl.select("s:b");
    expect(host.killed).toEqual(["t10"]);
    expect(starts()).toHaveLength(2);
    expect(ctl.view).toEqual({
      target: "s:b",
      name: viewTerminalName("s:b", sha256),
      address: "t11",
    });

    // closing the mod ends the viewers, never the relay
    host.live.push({ address: "t3", name: FEED_TERMINAL, state: "live" });
    ctl.closeViews();
    expect(host.killed).toEqual(["t10", "t11"]);
    expect(host.live.map((t) => t.name)).toEqual([FEED_TERMINAL]);
  });

  test("reselecting a row whose viewer runs takes the view back: Enter is pressed in that viewer", async () => {
    const host = new FakeHost();
    host.relayAlive = { alive: true, relay: { pid: 7, start36: "b" } };
    host.writeFeed({ pid: 7, start36: "b" }, [sessionItem("a")]);
    const ctl = await ready(host);
    ctl.setVisible(true);
    await ctl.tick();
    await ctl.select("s:a");
    // a fresh viewer claims at its own start: no key is needed
    expect(host.hcRuns().filter((a) => a[0] === "keys")).toEqual([]);
    // the view went elsewhere meanwhile; the user selects the row again
    await ctl.select("s:a");
    expect(host.hcRuns().filter((a) => a[0] !== "run")).toEqual([["keys", "t10", "enter"]]);
    expect(host.overlays).toHaveLength(2);
  });

  test("a viewer name another copy just took is followed to its terminal", async () => {
    const host = new FakeHost();
    const ctl = await ready(host);
    host.hcAnswer = (argv) =>
      argv[0] === "run"
        ? { code: 1, stdout: '{"error":{"kind":"name_taken","message":"taken"}}', stderr: "" }
        : { code: 0, stdout: '{"address":"t42","name":"x"}', stderr: "" };
    await ctl.select("s:a");
    expect(host.hcRuns().map((a) => a[0])).toEqual(["run", "get"]);
    expect(ctl.view?.address).toBe("t42");
    expect(JSON.stringify(host.overlays[0])).toContain('"terminal":"t42"');
  });

  test("a viewer hc refuses to start leaves a message and opens no window", async () => {
    const host = new FakeHost();
    const ctl = await ready(host);
    host.hcAnswer = () => ({ code: 1, stdout: "", stderr: "core not running" });
    await ctl.select("s:a");
    expect(host.overlays).toEqual([]);
    expect(ctl.view).toBeNull();
    expect(ctl.message).toBe("could not open s:a: core not running");
  });
});
