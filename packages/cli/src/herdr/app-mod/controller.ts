/**
 * What the Herdr.app mod does, behind a host interface so tests can run it with a fake Herdr.
 *
 * At load it finds the user's claudish (`--version`, `view --print-root`) and stops with an
 * install line when there is none. While its panel is visible it keeps a list of sessions:
 * from the feed file a hidden hc terminal writes (`claudish view --feed`), or, while no relay can
 * run, from `claudish view --list --json` every 2 s. Nothing runs while the panel is hidden.
 *
 * The relay is checked when the panel shows, whenever the feed file is missing, when its hc
 * terminal leaves `terminals()`, and every 15 s while visible. A dead relay empties the list at
 * once, is started again, and the polling path serves until a new relay's file appears.
 *
 * Selecting a session starts `claudish view <target> --front-end herdr-core` in a hidden hc
 * terminal and shows it in a keyed window; selecting another kills the previous viewer, which
 * releases its claim. Selecting a row whose viewer still runs presses Enter in it, which takes the
 * view back. Closing the mod kills the viewers and leaves the relay running.
 */

import type { ViewItem } from "../../pane/view-contract.js";
import {
  type ClaudishInstall,
  type ExecResult,
  FEED_TERMINAL,
  type FeedServer,
  type FeedView,
  LIVENESS_MS,
  PATH_HEAD,
  POLL_MS,
  type TerminalInfo,
  VIEW_TERMINAL_PREFIX,
  claudishArgv,
  feedRunArgs,
  liveTerminal,
  parseFeed,
  parseHcRun,
  parseListing,
  sameRelay,
  viewRunArgs,
  viewTerminalName,
  viewWindowSpec,
} from "./model.js";

export interface ModHost {
  exec(command: string, args: string[], options?: { timeout?: number }): Promise<ExecResult>;
  hc(args: string[]): Promise<ExecResult>;
  readTextFile(path: string): Promise<string | null>;
  terminals(): TerminalInfo[];
  openOverlay(spec: Record<string, unknown>): string;
  /** ends a terminal; at quit this must be a call that leaves before the event loop stops */
  killTerminal(address: string): void;
  home(): string;
  sha256Hex(s: string): string;
  now(): number;
}

export type Phase = "booting" | "missing" | "ready";

export const INSTALL_LINE = "claudish is not installed: bun install -g claudish";

/** An installed claudish that runs but predates `claudish view`: say which one, and how to update. */
export function updateLine(version: string): string {
  return `${version} has no view command: bun install -g claudish@latest`;
}

interface ViewTerminal {
  target: string;
  name: string;
  address: string;
}

export class PanelController {
  phase: Phase = "booting";
  /** one line under the header: why the list is empty or stale */
  message: string | null = null;
  install: ClaudishInstall | null = null;
  items: ViewItem[] = [];
  servers: FeedServer[] = [];
  mode: "relay" | "poll" = "relay";
  selected: string | null = null;
  view: ViewTerminal | null = null;
  visible = false;

  private livenessDueAt = 0;
  /** the relay whose death sent the list to the polling path */
  private deadRelay: FeedView["relay"] = null;
  private sawFeedTerminal = false;
  private waiters: Array<() => void> = [];

  constructor(private readonly host: ModHost) {}

  get feedPath(): string | null {
    return this.install ? `${this.install.root}/feed/feed.json` : null;
  }

  get feedDir(): string | null {
    return this.install ? `${this.install.root}/feed` : null;
  }

  /** Find the user's claudish. Ends in `missing` with the install line when it cannot run. */
  async boot(): Promise<void> {
    const probe = await this.host
      .exec("/bin/sh", [
        "-c",
        `PATH="${PATH_HEAD.join(":")}:$PATH"; export PATH; command -v claudish && printf '%s\\n' "$PATH"`,
      ])
      .catch(() => null);
    const [path, pathEnv] = (probe?.code === 0 ? probe.stdout : "").trim().split("\n");
    if (!path?.startsWith("/") || !pathEnv) return this.missing();
    const partial: ClaudishInstall = { path, pathEnv, root: "", version: "" };
    const version = await this.run(partial, ["--version"], false);
    if (!version) return this.missing();
    const root = await this.run(partial, ["view", "--print-root"], false);
    if (!root) return this.missing(updateLine(version.trim()));
    this.install = { path, pathEnv, root: root.trim(), version: version.trim() };
    this.phase = "ready";
    this.message = "starting";
  }

  /** Called on every render with what the layout says; wakes the loop when the panel appears. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible) this.livenessDueAt = 0;
    this.wake();
  }

  /** Called on every render: the relay's terminal leaving the live list is its exit event. */
  noteTerminals(list: TerminalInfo[]): void {
    const live = liveTerminal(list, FEED_TERMINAL) !== null;
    if (live) this.sawFeedTerminal = true;
    else if (this.sawFeedTerminal) {
      this.sawFeedTerminal = false;
      this.livenessDueAt = 0;
      this.wake();
    }
  }

  /** Resolves on the next visibility change or relay exit. */
  changed(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** How long the loop may sleep before the next tick. */
  nextWaitMs(): number {
    if (this.mode === "poll") return POLL_MS;
    return Math.max(0, this.livenessDueAt - this.host.now());
  }

  /** Whether the loop should follow the feed directory now. */
  get watching(): boolean {
    return this.phase === "ready" && this.visible && this.mode === "relay";
  }

  /** One refresh. Does nothing while the panel is hidden or claudish is missing. */
  async tick(): Promise<void> {
    if (this.phase !== "ready" || !this.visible) return;
    let checked = false;
    if (this.host.now() >= this.livenessDueAt) {
      await this.checkRelay();
      checked = true;
    }
    if (this.mode === "relay" && !(await this.readFeed()) && !checked) await this.checkRelay();
    if (this.mode === "poll" && !(await this.readFreshFeed())) await this.pollList();
  }

  /** Show `target`'s live screen: its viewer terminal, started when it is not running. */
  async select(target: string): Promise<void> {
    if (!this.install) return;
    const name = viewTerminalName(target, (s) => this.host.sha256Hex(s));
    const prev = this.view;
    if (prev && prev.name !== name) {
      this.host.killTerminal(prev.address);
      this.view = null;
    }
    let address = liveTerminal(this.host.terminals(), name)?.address ?? null;
    if (address) {
      // a running viewer claimed only at its start; Enter takes the view back from wherever it went
      await this.host.hc(["keys", address, "enter"]).catch(() => null);
    } else address = await this.startViewer(target, name);
    if (!address) return;
    this.view = { target, name, address };
    this.selected = target;
    const item = this.items.find((i) => i.target === target);
    const title = item ? (item.model ?? target) : target;
    this.host.openOverlay(viewWindowSpec(address, target, title));
  }

  /** The viewers this mod started, ended; the relay stays. */
  closeViews(): void {
    const killed = new Set<string>();
    if (this.view) {
      this.host.killTerminal(this.view.address);
      killed.add(this.view.address);
    }
    for (const t of this.host.terminals())
      if (t.name?.startsWith(VIEW_TERMINAL_PREFIX) && !killed.has(t.address))
        this.host.killTerminal(t.address);
    this.view = null;
  }

  private missing(message: string = INSTALL_LINE): void {
    this.phase = "missing";
    this.message = message;
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  /** stdout of a claudish call, or null when it failed */
  private async run(
    install: ClaudishInstall,
    args: string[],
    withRoot = true
  ): Promise<string | null> {
    const argv = withRoot
      ? claudishArgv(install, args)
      : ["/usr/bin/env", `PATH=${install.pathEnv}`, install.path, ...args];
    const r = await this.host.exec(argv[0] as string, argv.slice(1)).catch(() => null);
    return r && r.code === 0 ? r.stdout : null;
  }

  private async checkRelay(): Promise<void> {
    if (!this.install) return;
    this.livenessDueAt = this.host.now() + LIVENESS_MS;
    const argv = claudishArgv(this.install, ["view", "--feed-check"]);
    const r = await this.host.exec(argv[0] as string, argv.slice(1)).catch(() => null);
    let check: { alive?: unknown; relay?: FeedView["relay"] } = {};
    try {
      check = JSON.parse(r?.stdout ?? "") as typeof check;
    } catch {
      check = {};
    }
    if (check.alive === true) return;
    if (this.mode === "relay") {
      this.items = [];
      this.servers = [];
      this.message = "reconnecting";
    }
    this.deadRelay = check.relay ?? null;
    this.mode = "poll";
    await this.startRelay();
  }

  private async startRelay(): Promise<void> {
    if (!this.install) return;
    const r = await this.host
      .hc(feedRunArgs(this.install, this.host.home()))
      .catch((e: unknown) => ({ code: 1, stdout: "", stderr: String(e) }));
    const out = parseHcRun(r);
    if (out.kind === "failed") this.message = `feed relay did not start: ${out.message}`;
  }

  /** Read the relay's file; false when it is missing or unreadable. */
  private async readFeed(): Promise<boolean> {
    const feed = await this.loadFeed();
    if (!feed) return false;
    this.apply(feed);
    return true;
  }

  /** On the polling path: a file from a relay other than the dead one ends the polling. */
  private async readFreshFeed(): Promise<boolean> {
    const feed = await this.loadFeed();
    if (!feed?.relay || sameRelay(feed.relay, this.deadRelay)) return false;
    this.mode = "relay";
    this.deadRelay = null;
    this.apply(feed);
    return true;
  }

  private async loadFeed(): Promise<FeedView | null> {
    const path = this.feedPath;
    if (!path) return null;
    return parseFeed(await this.host.readTextFile(path).catch(() => null));
  }

  private async pollList(): Promise<void> {
    if (!this.install) return;
    const out = await this.run(this.install, ["view", "--list", "--json"]);
    const listing = out ? parseListing(out) : null;
    if (!listing) return;
    this.servers = listing.servers;
    this.items = listing.items;
    this.message = this.emptyMessage();
  }

  private apply(feed: Pick<FeedView, "servers" | "items">): void {
    this.servers = feed.servers;
    this.items = feed.items;
    this.message = this.emptyMessage();
  }

  private emptyMessage(): string | null {
    if (this.items.length > 0) return null;
    return this.servers.length === 0 ? "no claudish MCP server is running" : "no sessions";
  }

  private async startViewer(target: string, name: string): Promise<string | null> {
    if (!this.install) return null;
    const r = await this.host
      .hc(viewRunArgs(this.install, target, name, this.host.home()))
      .catch((e: unknown) => ({ code: 1, stdout: "", stderr: String(e) }));
    const out = parseHcRun(r);
    if (out.kind === "started") return out.address;
    if (out.kind === "name_taken") {
      // started by another copy of this mod a moment ago: show that one
      const got = await this.host.hc(["get", name, "--json"]).catch(() => null);
      try {
        const address = (JSON.parse(got?.stdout ?? "") as { address?: unknown }).address;
        if (typeof address === "string") return address;
      } catch {
        // fall through to the message
      }
    }
    this.message = `could not open ${target}: ${out.kind === "failed" ? out.message : "name taken"}`;
    return null;
  }
}
