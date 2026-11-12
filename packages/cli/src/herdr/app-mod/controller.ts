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
 * once, is started again, and the polling path serves until a new relay's file appears. A live
 * relay whose stamp names another version than the checking claudish (an older build started it
 * and still runs that build's code) is killed and started again the same way.
 *
 * Beside the servers' items the list carries their `history`: finished runs read from their
 * records that no server holds any more, so earlier runs stay after a server evicts them, exits
 * or restarts. A run read only from its records has no viewer to show; its screen area says so,
 * and Text reads its transcript from the records. The run on screen is kept while a refresh
 * drops it, so a click never blanks the panel.
 *
 * Selecting a session starts `claudish view <target> --front-end herdr-core` in a hidden hc
 * terminal and shows it in a keyed window; selecting another kills the previous viewer, which
 * releases its claim. Selecting a row whose viewer still runs presses Enter in it, which takes the
 * view back. Closing the mod kills the viewers and leaves the relay running.
 *
 * The panel shows runs (`runs.ts`): the latest is selected until the person picks one. Picking a
 * run or a slot shows that slot's screen in the keyed window; a slot that failed before Claude Code
 * started has none, so the panel shows its reason instead and no viewer starts. The Text tab reads
 * the slot's transcript with `claudish view --transcript`, following it every 2 s while the panel is
 * visible and the transcript is not final. Only one copy of the mod is the panel (`PanelSeat`).
 */

import type { TranscriptLine } from "../../pane/contract.js";

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
  type RelayStamp,
  type TerminalInfo,
  VIEW_TERMINAL_PREFIX,
  claudishArgv,
  feedRunArgs,
  liveTerminal,
  parseFeed,
  parseHcRun,
  parseListing,
  parseRelayStamp,
  parseTranscriptRun,
  sameRelay,
  viewRunArgs,
  viewTerminalName,
  viewWindowSpec,
} from "./model.js";
import {
  type PanelRow,
  type PanelRun,
  type ScreenMode,
  maxRunTabs,
  runsOf,
  transcriptText,
} from "./runs.js";

/** how often an open, unfinished transcript is read again while the panel is visible */
export const TRANSCRIPT_MS = 2_000;
/** pages read in one go when an answer says `more` */
const TRANSCRIPT_PAGES = 10;
/** after a relay was replaced, the next check comes this soon */
export const RELAY_RESTART_MS = 2_000;

/**
 * Which copy of the mod is the panel. Herdr docks one copy from `mod.json` the first time it sees
 * the folder, and a `pane.split {mod}` adds another; every copy runs `init`. The first to take the
 * seat is the panel; another shows a one-line note and waits until the seat is released.
 */
export class PanelSeat {
  private owner: object | null = null;
  private waiters: Array<() => void> = [];

  /** true when `who` holds the seat now (taken, or already its own) */
  take(who: object): boolean {
    if (this.owner === null) this.owner = who;
    return this.owner === who;
  }

  release(who: object): void {
    if (this.owner !== who) return;
    this.owner = null;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  /** resolves when the holder releases the seat */
  freed(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

interface TranscriptState {
  lines: TranscriptLine[];
  cursor: string | null;
  final: boolean;
  error: string | null;
  readAt: number;
}

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
  /** what the running servers hold */
  items: ViewItem[] = [];
  /** finished runs from their records that no server holds */
  history: ViewItem[] = [];
  servers: FeedServer[] = [];
  feedMode: "relay" | "poll" = "relay";
  selected: string | null = null;
  view: ViewTerminal | null = null;
  visible = false;
  /** the run the person picked; null follows the latest */
  pickedRun: string | null = null;
  /** the slot the person picked in the run; null is its first row */
  focus: string | null = null;
  mode: ScreenMode = "screen";
  earlierOpen = false;
  /** the panel's width in px, from its last size change */
  width = 320;

  private transcripts = new Map<string, TranscriptState>();
  /** the shown run's items a refresh no longer lists, kept so the panel does not lose them */
  private kept: ViewItem[] = [];
  /** why the list polls while a relay is being replaced; shown over the empty-list line */
  private relayNotice: string | null = null;

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
    const base =
      this.feedMode === "poll" ? POLL_MS : Math.max(0, this.livenessDueAt - this.host.now());
    return this.followingTranscript() ? Math.min(base, TRANSCRIPT_MS) : base;
  }

  /** The servers' items, then the records' runs, then the kept ones; one item per target. */
  allItems(): ViewItem[] {
    const seen = new Set<string>();
    const out: ViewItem[] = [];
    for (const item of [...this.items, ...this.history, ...this.kept]) {
      if (seen.has(item.target)) continue;
      seen.add(item.target);
      out.push(item);
    }
    return out;
  }

  /** Every run, newest first. */
  runs(): PanelRun[] {
    const held = new Set(this.items.map((i) => i.target));
    const recordOnly = new Set(
      this.allItems()
        .map((i) => i.target)
        .filter((t) => !held.has(t))
    );
    return runsOf(this.allItems(), this.host.now(), recordOnly);
  }

  /** The run shown: the one picked while it exists, else the latest. */
  currentRun(): PanelRun | null {
    const runs = this.runs();
    return runs.find((r) => r.key === this.pickedRun) ?? runs[0] ?? null;
  }

  /** The slot shown: the one picked in the current run, else its first row. */
  currentRow(): PanelRow | null {
    const run = this.currentRun();
    return run?.rows.find((r) => r.target === this.focus) ?? run?.rows[0] ?? null;
  }

  /** How many run tabs fit the panel's width. */
  maxTabs(): number {
    return maxRunTabs(this.width);
  }

  /** Show `key`'s run, its first slot, and that slot's screen or transcript. */
  async selectRun(key: string): Promise<void> {
    this.pickedRun = key;
    this.earlierOpen = false;
    this.focus = this.runs().find((r) => r.key === key)?.rows[0]?.target ?? null;
    await this.show();
  }

  /** Show one slot of the current run. */
  async selectSlot(target: string): Promise<void> {
    const run = this.runs().find((r) => r.rows.some((row) => row.target === target));
    if (run) this.pickedRun = run.key;
    this.focus = target;
    await this.show();
  }

  async setMode(mode: ScreenMode): Promise<void> {
    this.mode = mode;
    await this.show();
  }

  toggleEarlier(): void {
    this.earlierOpen = !this.earlierOpen;
  }

  /** The Text tab's lines for the current slot. */
  transcriptLines(): string[] {
    const row = this.currentRow();
    if (!row) return [];
    const t = this.transcripts.get(row.target);
    if (t?.error) return [t.error];
    if (t && t.lines.length > 0) return transcriptText(t.lines);
    if (row.noScreen) return ["no transcript: the session ended before Claude Code started"];
    return [t?.final ? "no transcript: nothing was recorded" : "reading the transcript…"];
  }

  /** What the current mode shows for the current slot; opens nothing for a slot with no screen. */
  private async show(): Promise<void> {
    const row = this.currentRow();
    if (!row) return;
    if (this.mode === "text") {
      await this.readTranscript(row.target);
      return;
    }
    if (row.noScreen || row.recordOnly) {
      if (this.view) this.host.killTerminal(this.view.address);
      this.view = null;
      this.selected = null;
      return;
    }
    await this.select(row.target);
  }

  private followingTranscript(): boolean {
    if (this.mode !== "text" || !this.visible || this.phase !== "ready") return false;
    const row = this.currentRow();
    const t = row ? this.transcripts.get(row.target) : undefined;
    return Boolean(row && !row.noScreen && !row.recordOnly && !t?.final && !t?.error);
  }

  /** Read the target's transcript from where the last read stopped. */
  private async readTranscript(target: string): Promise<void> {
    if (!this.install) return;
    const t: TranscriptState = this.transcripts.get(target) ?? {
      lines: [],
      cursor: null,
      final: false,
      error: null,
      readAt: 0,
    };
    this.transcripts.set(target, t);
    t.readAt = this.host.now();
    for (let page = 0; page < TRANSCRIPT_PAGES; page++) {
      const args = ["view", "--transcript", target, ...(t.cursor ? ["--since", t.cursor] : [])];
      const argv = claudishArgv(this.install, args);
      const r = await this.host.exec(argv[0] as string, argv.slice(1)).catch(() => null);
      const answer = parseTranscriptRun(r, this.install.version);
      if (answer.kind === "error") {
        t.error = answer.message;
        return;
      }
      t.error = null;
      t.lines.push(...answer.lines);
      t.cursor = answer.cursor ?? t.cursor;
      t.final = answer.final;
      if (!answer.more) return;
    }
  }

  /** Whether the loop should follow the feed directory now. */
  get watching(): boolean {
    return this.phase === "ready" && this.visible && this.feedMode === "relay";
  }

  /** One refresh. Does nothing while the panel is hidden or claudish is missing. */
  async tick(): Promise<void> {
    if (this.phase !== "ready" || !this.visible) return;
    let checked = false;
    if (this.host.now() >= this.livenessDueAt) {
      await this.checkRelay();
      checked = true;
    }
    if (this.feedMode === "relay" && !(await this.readFeed()) && !checked) await this.checkRelay();
    if (this.feedMode === "poll" && !(await this.readFreshFeed())) await this.pollList();
    const row = this.currentRow();
    const t = row ? this.transcripts.get(row.target) : undefined;
    if (row && this.followingTranscript() && this.host.now() - (t?.readAt ?? 0) >= TRANSCRIPT_MS)
      await this.readTranscript(row.target);
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
    const run = this.runs().find((r) => r.rows.some((row) => row.target === target));
    const row = run?.rows.find((r) => r.target === target);
    const item = this.allItems().find((i) => i.target === target);
    const fallback = item ? (item.model ?? target) : target;
    const title = run && row ? `${run.name} · ${row.slot} · ${row.model}` : fallback;
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
    let check: { alive?: unknown; relay?: unknown; version?: unknown } = {};
    try {
      check = JSON.parse(r?.stdout ?? "") as typeof check;
    } catch {
      check = {};
    }
    const stamp = parseRelayStamp(check.relay);
    if (check.alive === true) {
      // a checker that names no version runs relays that stamp none: nothing to compare
      const want = typeof check.version === "string" ? check.version : null;
      if (want && stamp && stamp.version !== want) await this.replaceRelay(stamp, want);
      return;
    }
    if (this.feedMode === "relay") {
      this.items = [];
      this.servers = [];
      this.message = "reconnecting";
    }
    this.deadRelay = stamp;
    this.feedMode = "poll";
    await this.startRelay();
  }

  /**
   * A live relay an older build started: kill its hc terminal and start one from this claudish.
   * Its file is not trusted from here on; the list polls until the new relay's file appears.
   */
  private async replaceRelay(stamp: RelayStamp, want: string): Promise<void> {
    this.deadRelay = stamp;
    this.feedMode = "poll";
    const term = liveTerminal(this.host.terminals(), FEED_TERMINAL);
    if (!term) {
      // not ours to end (started by hand), or already ending: poll until it exits
      this.relayNotice = `an older feed relay (pid ${stamp.pid}) still runs; polling until it exits`;
      this.message = this.relayNotice;
      return;
    }
    this.host.killTerminal(term.address);
    this.relayNotice = `restarting the feed relay for claudish ${want}`;
    this.message = this.relayNotice;
    this.livenessDueAt = this.host.now() + RELAY_RESTART_MS;
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
    this.feedMode = "relay";
    this.deadRelay = null;
    this.relayNotice = null;
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
    // a claudish from before --include-finished refuses it with a usage error
    const out =
      (await this.run(this.install, ["view", "--list", "--json", "--include-finished"])) ??
      (await this.run(this.install, ["view", "--list", "--json"]));
    const listing = out ? parseListing(out) : null;
    if (!listing) return;
    this.apply(listing);
  }

  /** Take a refresh; the shown run's items it no longer lists are kept. */
  private apply(feed: Pick<FeedView, "servers" | "items" | "history">): void {
    const shown = new Set(this.currentRun()?.rows.map((r) => r.target) ?? []);
    const before = this.allItems().filter((i) => shown.has(i.target));
    this.servers = feed.servers;
    this.items = feed.items;
    this.history = feed.history;
    const listed = new Set([...this.items, ...this.history].map((i) => i.target));
    this.kept = before.filter((i) => !listed.has(i.target));
    this.message = this.relayNotice ?? this.emptyMessage();
  }

  private emptyMessage(): string | null {
    if (this.servers.length === 0)
      return this.history.length > 0
        ? "no claudish MCP server is running · runs shown from their records"
        : "no claudish MCP server is running";
    return this.allItems().length > 0 ? null : "no sessions";
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
