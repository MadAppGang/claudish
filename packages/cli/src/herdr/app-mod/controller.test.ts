import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ViewItem } from "../../pane/view-contract.js";
import { sessionItem } from "../test-helpers/view-items.js";
import { INSTALL_LINE, type ModHost, PanelController, PanelSeat } from "./controller.js";
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
  /** what `view --list --json --include-finished` adds: runs from their records */
  history: ViewItem[] = [];
  /** a claudish whose `view --list` predates `--include-finished` */
  noIncludeFinished = false;
  /** the version a relay stamps; undefined = a relay from before stamps carried one */
  relayVersion: string | undefined = "14.16.1";
  /** the version `--feed-check` names as its own; undefined = a claudish that names none */
  checkerVersion: string | undefined = "14.16.1";
  nextAddress = 10;
  /** an installed claudish from before `claudish view` existed */
  noView = false;
  hcAnswer: ((argv: string[]) => ExecResult) | null = null;
  /** `view --transcript <target> [--since <cursor>]`: the answer per target */
  transcript: ((target: string, since: string | undefined) => ExecResult) | null = null;

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
    if (rest === "view --print-root")
      return this.noView
        ? { code: 1, stdout: "", stderr: "unknown command: view\n" }
        : { code: 0, stdout: `${ROOT}\n`, stderr: "" };
    if (rest === "view --feed-check") {
      const r = this.relayAlive.relay as Record<string, unknown> | undefined;
      const relay =
        r && !("version" in r) && this.relayVersion ? { ...r, version: this.relayVersion } : r;
      return {
        code: this.relayAlive.alive ? 0 : 1,
        stdout: `${JSON.stringify({
          ...this.relayAlive,
          ...(relay ? { relay } : {}),
          ...(this.checkerVersion ? { version: this.checkerVersion } : {}),
        })}\n`,
        stderr: "",
      };
    }
    if (rest.startsWith("view --transcript ")) {
      const words = rest.split(" ");
      const target = words[2] as string;
      const since = words[3] === "--since" ? words[4] : undefined;
      return this.transcript
        ? this.transcript(target, since)
        : { code: 2, stdout: "", stderr: "unknown option --transcript" };
    }
    if (rest === "view --list --json")
      return { code: 0, stdout: `${JSON.stringify(this.listing)}\n`, stderr: "" };
    if (rest === "view --list --json --include-finished")
      return this.noIncludeFinished
        ? { code: 2, stdout: "", stderr: "unknown option --include-finished" }
        : {
            code: 0,
            stdout: `${JSON.stringify({ ...this.listing, history: this.history })}\n`,
            stderr: "",
          };
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

  writeFeed(
    relay: { pid: number; start36: string },
    items: ViewItem[],
    history: ViewItem[] | undefined = undefined
  ): void {
    this.files.set(
      FEED,
      JSON.stringify({
        relay: { ...relay, started_at: "x" },
        written_at: "x",
        servers: [{}],
        items,
        ...(history ? { history } : {}),
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

  test("the mod's settings.json names another claudish command; an unsafe name is ignored", async () => {
    const settings = "/Users/u/.config/herdr-app/mods/claudish/settings.json";
    const probeOf = (host: FakeHost): string =>
      host.calls.find((c) => c.argv[0] === "/bin/sh")?.argv[2] ?? "";
    const dev = new FakeHost();
    dev.files.set(settings, '{ "command": "claudishD" }');
    await ready(dev);
    expect(probeOf(dev)).toContain("command -v claudishD &&");
    const unsafe = new FakeHost();
    unsafe.files.set(settings, '{ "command": "x; rm -rf ~" }');
    await ready(unsafe);
    expect(probeOf(unsafe)).toContain("command -v claudish &&");
    expect(probeOf(unsafe)).not.toContain("rm -rf");
    const none = new FakeHost();
    await ready(none);
    expect(probeOf(none)).toContain("command -v claudish &&");
  });

  test("a claudish without the view command is named with its version and an update line, not as missing", async () => {
    const host = new FakeHost();
    host.noView = true;
    const ctl = new PanelController(host);
    await ctl.boot();
    ctl.setVisible(true);
    await ctl.tick();
    expect(ctl.phase).toBe("missing");
    expect(ctl.message).not.toBe(INSTALL_LINE);
    expect(ctl.message).toBe(
      "claudish version 14.16.1 has no view command: bun install -g claudish@latest"
    );
    expect(host.hcRuns()).toEqual([]);
    expect(host.claudishRuns()).toEqual(["--version", "view --print-root"]);
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
    expect(ctl.feedMode).toBe("poll");
    expect(ctl.items.map((i) => i.target)).toEqual(["s:a"]);
    expect(ctl.nextWaitMs()).toBe(POLL_MS);
    expect(ctl.watching).toBe(false);

    host.relayAlive = { alive: true, relay: { pid: 7, start36: "b" } };
    host.writeFeed({ pid: 7, start36: "b" }, [sessionItem("a"), sessionItem("b")]);
    await ctl.tick();
    expect(ctl.feedMode).toBe("relay");
    expect(ctl.items.map((i) => i.target)).toEqual(["s:a", "s:b"]);
    expect(ctl.watching).toBe(true);
    expect(
      host.claudishRuns().filter((r) => r === "view --list --json --include-finished")
    ).toHaveLength(1);
  });

  test("a relay found dead empties the list at once, restarts it, and ignores its stale file", async () => {
    const host = new FakeHost();
    host.relayAlive = { alive: true, relay: { pid: 7, start36: "b" } };
    host.writeFeed({ pid: 7, start36: "b" }, [sessionItem("a")]);
    const ctl = await ready(host);
    ctl.setVisible(true);
    await ctl.tick();
    expect(ctl.feedMode).toBe("relay");
    expect(ctl.items).toHaveLength(1);
    expect(host.hcRuns()).toEqual([]);

    // the 15 s check finds the stamped relay gone; its file is still there
    host.relayAlive = { alive: false, reason: "relay_gone", relay: { pid: 7, start36: "b" } };
    host.listing = { servers: [], items: [] };
    host.clock += LIVENESS_MS;
    expect(ctl.nextWaitMs()).toBe(0);
    await ctl.tick();
    expect(ctl.feedMode).toBe("poll");
    expect(host.hcRuns()).toHaveLength(1);
    expect(ctl.items).toEqual([]);
    expect(ctl.message).toBe("no claudish MCP server is running");
    await ctl.tick();
    expect(ctl.feedMode).toBe("poll");

    host.writeFeed({ pid: 8, start36: "c" }, [sessionItem("z")]);
    await ctl.tick();
    expect(ctl.feedMode).toBe("relay");
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

  test("reselecting a row whose viewer runs shows it again and sends that viewer no key", async () => {
    const host = new FakeHost();
    host.relayAlive = { alive: true, relay: { pid: 7, start36: "b" } };
    host.writeFeed({ pid: 7, start36: "b" }, [sessionItem("a")]);
    const ctl = await ready(host);
    ctl.setVisible(true);
    await ctl.tick();
    await ctl.select("s:a");
    await ctl.select("s:a");
    // a viewer only watches: nothing is typed into it to take the view
    expect(host.hcRuns().filter((a) => a[0] !== "run")).toEqual([]);
    expect(host.hcRuns().filter((a) => a[0] === "run")).toHaveLength(1);
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

function withFields(item: ViewItem, fields: Record<string, unknown>): ViewItem {
  return { ...item, ...fields } as ViewItem;
}

const CLOCK = 1_700_000_000_000;
/** a run id as `mintRunId` writes it, for a run that started `agoMs` before CLOCK */
const runIdOf = (name: string, agoMs: number): string =>
  `${name}-${(CLOCK - agoMs).toString(36)}-aaaaaa`;
const OLD_RUN = runIdOf("older", 600_000);

function teamSlot(run: string, slot: string, fields: Record<string, unknown> = {}): ViewItem {
  return withFields(sessionItem(slot), {
    kind: "team_slot",
    target: `t:${run}/${slot}`,
    run_id: run,
    run_path: `/Users/u/proj/${run.split("-")[0]}`,
    run_kind: "run",
    slot,
    ...fields,
  });
}

async function withRuns(host: FakeHost, items: ViewItem[]): Promise<PanelController> {
  host.clock = CLOCK;
  host.relayAlive = { alive: true, relay: { pid: 7, start36: "b" } };
  host.writeFeed({ pid: 7, start36: "b" }, items);
  const ctl = await ready(host);
  ctl.setVisible(true);
  await ctl.tick();
  return ctl;
}

describe("PanelController: runs, the session view and the Text tab", () => {
  test("the latest run is selected by default and follows a newer run until one is picked", async () => {
    const host = new FakeHost();
    const ctl = await withRuns(host, [teamSlot(OLD_RUN, "01"), teamSlot(OLD_RUN, "02")]);
    expect(ctl.currentRun()?.name).toBe("older");
    expect(ctl.currentRow()?.slot).toBe("01");
    // nothing opens a window by itself
    expect(host.overlays).toEqual([]);

    host.writeFeed({ pid: 7, start36: "b" }, [
      ...ctl.items,
      teamSlot(runIdOf("newer", 60_000), "01"),
    ]);
    await ctl.tick();
    expect(ctl.currentRun()?.name).toBe("newer");

    await ctl.selectRun(OLD_RUN);
    expect(ctl.currentRun()?.name).toBe("older");
    host.writeFeed({ pid: 7, start36: "b" }, [
      ...ctl.items,
      teamSlot(runIdOf("newest", 1_000), "01"),
    ]);
    await ctl.tick();
    expect(ctl.currentRun()?.name).toBe("older");
  });

  test("picking a run or a slot shows its screen in the keyed window", async () => {
    const host = new FakeHost();
    const ctl = await withRuns(host, [teamSlot(OLD_RUN, "01"), teamSlot(OLD_RUN, "02")]);
    await ctl.selectSlot(`t:${OLD_RUN}/02`);
    expect(ctl.selected).toBe(`t:${OLD_RUN}/02`);
    expect(ctl.currentRow()?.slot).toBe("02");
    expect(host.overlays).toHaveLength(1);
    expect(host.hcRuns()[0]?.slice(-4)).toEqual([
      "view",
      `t:${OLD_RUN}/02`,
      "--front-end",
      "herdr-core",
    ]);
    await ctl.selectRun(OLD_RUN);
    expect(ctl.currentRow()?.slot).toBe("01");
    expect(host.overlays).toHaveLength(2);
  });

  test("a slot that failed before Claude Code started opens no viewer and closes the previous one", async () => {
    const host = new FakeHost();
    const ctl = await withRuns(host, [
      teamSlot(OLD_RUN, "01"),
      teamSlot(OLD_RUN, "02", {
        state: "FAILED",
        reason: "child_exited",
        reason_detail: "pane child exited with code 1",
        turns_completed: 0,
        tool_calls: 0,
        tokens_in: null,
      }),
    ]);
    await ctl.selectSlot(`t:${OLD_RUN}/01`);
    expect(host.overlays).toHaveLength(1);
    await ctl.selectSlot(`t:${OLD_RUN}/02`);
    expect(ctl.currentRow()?.noScreen).toBe(true);
    expect(host.overlays).toHaveLength(1);
    expect(host.killed).toEqual(["t10"]);
    expect(host.hcRuns().filter((a) => a[0] === "run")).toHaveLength(1);
  });

  test("Text reads the transcript through claudish view --transcript and follows it with --since", async () => {
    const host = new FakeHost();
    const first = {
      session_id: "a",
      cursor: "v1.1.0.aaaaaaaa",
      lines: [{ kind: "user", text: "hello" }],
      more: false,
      final: false,
    };
    const next = {
      session_id: "a",
      cursor: "v1.2.0.aaaaaaaa",
      lines: [{ kind: "assistant", text: "hi there" }],
      more: false,
      final: true,
    };
    host.transcript = (_target, since) => ({
      code: 0,
      stdout: `${JSON.stringify(since ? next : first)}\n`,
      stderr: "",
    });
    const ctl = await withRuns(host, [sessionItem("a")]);
    await ctl.setMode("text");
    expect(host.overlays).toEqual([]);
    expect(ctl.transcriptLines()).toEqual(["user  hello"]);
    host.clock += 5_000;
    await ctl.tick();
    expect(ctl.transcriptLines()).toEqual(["user  hello", "asst  hi there"]);
    const reads = (): string[] =>
      host.claudishRuns().filter((r) => r.startsWith("view --transcript"));
    expect(reads()).toEqual([
      "view --transcript s:a",
      "view --transcript s:a --since v1.1.0.aaaaaaaa",
    ]);
    // final: no more reads, and nothing at all while hidden
    host.clock += 5_000;
    await ctl.tick();
    ctl.setVisible(false);
    await ctl.tick();
    expect(reads()).toHaveLength(2);
  });

  test("a claudish without view --transcript says how to update instead of a blank Text tab", async () => {
    const host = new FakeHost();
    const ctl = await withRuns(host, [sessionItem("a")]);
    await ctl.setMode("text");
    expect(ctl.transcriptLines()).toEqual([
      "claudish version 14.16.1 cannot read transcripts: bun install -g claudish@latest",
    ]);
  });
});

describe("PanelSeat: one copy of the mod is the panel", () => {
  test("the first copy takes the seat; another waits until it is released", async () => {
    const seat = new PanelSeat();
    const a = {};
    const b = {};
    expect(seat.take(a)).toBe(true);
    expect(seat.take(a)).toBe(true);
    expect(seat.take(b)).toBe(false);
    let freed = false;
    const waiting = seat.freed().then(() => {
      freed = true;
    });
    seat.release(b);
    await Promise.resolve();
    expect(freed).toBe(false);
    seat.release(a);
    await waiting;
    expect(freed).toBe(true);
    expect(seat.take(b)).toBe(true);
  });
});

/** A session that failed before Claude Code started, as its records read. */
function failedEarly(id: string): ViewItem {
  return withFields(sessionItem(id, { state: "FAILED" }), {
    reason: "child_exited",
    reason_detail: "pane child exited with code 1; last line: error: unknown option",
    task_type: "explain",
    magmux: null,
    started_at: new Date(CLOCK - 60_000).toISOString(),
  });
}

describe("PanelController: earlier runs stay after their server lets them go", () => {
  test("polling lists the records' runs beside the servers' items, newest first", async () => {
    const host = new FakeHost();
    host.clock = CLOCK;
    host.listing = { servers: [{ endpoint: "c1-a.sock", pid: 1, version: "v" }], items: [] };
    host.history = [failedEarly("f3517773")];
    const ctl = await ready(host);
    ctl.setVisible(true);
    await ctl.tick();
    expect(ctl.feedMode).toBe("poll");
    expect(ctl.runs().map((r) => r.key)).toEqual(["s:f3517773"]);
    expect(ctl.currentRow()).toMatchObject({ noScreen: true, reason: "child_exited" });
    expect(ctl.message).toBeNull();

    // the server exits: the run stays, and the line says where it is read from
    host.listing = { servers: [], items: [] };
    await ctl.tick();
    expect(ctl.runs().map((r) => r.key)).toEqual(["s:f3517773"]);
    expect(ctl.message).toBe("no claudish MCP server is running · runs shown from their records");
  });

  test("an older claudish without --include-finished is polled the old way", async () => {
    const host = new FakeHost();
    host.noIncludeFinished = true;
    host.listing = {
      servers: [{ endpoint: "c1-a.sock", pid: 1, version: "v" }],
      items: [sessionItem("a")],
    };
    const ctl = await ready(host);
    ctl.setVisible(true);
    await ctl.tick();
    expect(ctl.runs().map((r) => r.key)).toEqual(["s:a"]);
    expect(host.claudishRuns()).toContain("view --list --json");
  });

  test("the relay's history is listed; a run only the records hold opens no viewer", async () => {
    const host = new FakeHost();
    host.clock = CLOCK;
    host.relayAlive = { alive: true, relay: { pid: 7, start36: "b" } };
    const done = withFields(sessionItem("d0ne0000", { state: "COMPLETED" }), {
      turns_completed: 2,
      tool_calls: 5,
      started_at: new Date(CLOCK - 120_000).toISOString(),
    });
    host.writeFeed({ pid: 7, start36: "b" }, [], [done]);
    const ctl = await ready(host);
    ctl.setVisible(true);
    await ctl.tick();
    expect(ctl.runs().map((r) => r.key)).toEqual(["s:d0ne0000"]);
    const row = ctl.currentRow();
    expect(row).toMatchObject({ recordOnly: true, noScreen: false });
    await ctl.selectSlot("s:d0ne0000");
    expect(host.overlays).toEqual([]);
    expect(host.hcRuns().filter((a) => a[0] === "run")).toEqual([]);
    expect(ctl.message).toBeNull();
  });

  test("Text on a run the server evicts mid-switch keeps the rows and tabs; only the area changes", async () => {
    const host = new FakeHost();
    host.transcript = () => ({
      code: 1,
      stdout: `${JSON.stringify({ error: { code: "unknown_session", message: "no session a" } })}\n`,
      stderr: "",
    });
    const ctl = await withRuns(host, [sessionItem("a")]);
    expect(ctl.runs()).toHaveLength(1);
    // the server lets the session go while Text is being clicked; this relay writes no history
    host.writeFeed({ pid: 7, start36: "b" }, []);
    await ctl.setMode("text");
    await ctl.tick();
    expect(ctl.runs().map((r) => r.key)).toEqual(["s:a"]);
    expect(ctl.currentRow()?.target).toBe("s:a");
    expect(ctl.transcriptLines()).toEqual(["no transcript: no session a"]);
  });

  test("Text on a run with no transcript says why, the rows staying", async () => {
    const host = new FakeHost();
    host.transcript = () => ({
      code: 0,
      stdout: `${JSON.stringify({ session_id: "f", cursor: null, lines: [], more: false, final: true })}\n`,
      stderr: "",
    });
    const ctl = await withRuns(host, [failedEarly("f3517773")]);
    await ctl.setMode("text");
    expect(ctl.runs()).toHaveLength(1);
    expect(ctl.transcriptLines()).toEqual([
      "no transcript: the session ended before Claude Code started",
    ]);
  });
});

describe("PanelController: a relay an older build started is replaced", () => {
  test("a live relay whose stamp names another version is killed and started again", async () => {
    const host = new FakeHost();
    host.relayVersion = undefined;
    host.live = [{ address: "t3", name: FEED_TERMINAL, state: "live" }];
    host.relayAlive = { alive: true, relay: { pid: 7, start36: "b" } };
    host.writeFeed({ pid: 7, start36: "b" }, [sessionItem("a")]);
    const ctl = await ready(host);
    ctl.setVisible(true);
    await ctl.tick();
    expect(host.killed).toEqual(["t3"]);
    const runs = host.hcRuns().filter((a) => a[0] === "run");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.slice(-2)).toEqual(["view", "--feed"]);
    // the old relay's file is not trusted; the list polls until the new relay writes
    expect(ctl.feedMode).toBe("poll");
    expect(ctl.message).toBe("restarting the feed relay for claudish 14.16.1");

    host.relayVersion = "14.16.1";
    host.relayAlive = { alive: true, relay: { pid: 8, start36: "c" } };
    host.writeFeed({ pid: 8, start36: "c" }, [sessionItem("a")]);
    host.clock += LIVENESS_MS;
    await ctl.tick();
    expect(ctl.feedMode).toBe("relay");
    expect(host.killed).toEqual(["t3"]);
    expect(ctl.runs().map((r) => r.key)).toEqual(["s:a"]);
  });

  test("an older claudish whose --feed-check names no version never restarts its own relay", async () => {
    const host = new FakeHost();
    host.relayVersion = undefined;
    host.checkerVersion = undefined;
    host.live = [{ address: "t3", name: FEED_TERMINAL, state: "live" }];
    host.relayAlive = { alive: true, relay: { pid: 7, start36: "b" } };
    host.writeFeed({ pid: 7, start36: "b" }, [sessionItem("a")]);
    const ctl = await ready(host);
    ctl.setVisible(true);
    for (let i = 0; i < 3; i++) {
      await ctl.tick();
      host.clock += LIVENESS_MS;
    }
    expect(host.killed).toEqual([]);
    expect(host.hcRuns()).toEqual([]);
    expect(ctl.feedMode).toBe("relay");
  });

  test("a relay with the same version is left alone", async () => {
    const host = new FakeHost();
    host.live = [{ address: "t3", name: FEED_TERMINAL, state: "live" }];
    host.relayAlive = { alive: true, relay: { pid: 7, start36: "b", version: "14.16.1" } };
    host.writeFeed({ pid: 7, start36: "b" }, [sessionItem("a")]);
    const ctl = await ready(host);
    ctl.setVisible(true);
    await ctl.tick();
    expect(host.killed).toEqual([]);
    expect(host.hcRuns()).toEqual([]);
    expect(ctl.feedMode).toBe("relay");
  });
});
