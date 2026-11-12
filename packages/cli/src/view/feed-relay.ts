/**
 * `claudish view --feed`: one file that lists every claudish MCP server's items, for a reader that
 * cannot open a unix socket (the Herdr.app mod reads files and runs programs, nothing else).
 *
 * The relay follows `<root>/endpoints/` (`EndpointWatch`), subscribes to each live server as a
 * `relay` client, and writes the merged set to `<root>/feed/feed.json`: 0600, by atomic rename,
 * only when the set changed, and at most `1000 / minIntervalMs` times a second. The file is
 * stamped with the relay's own pid and start, so a reader can tell a dead relay's file
 * (`checkFeed`), and it is removed when the relay exits.
 *
 * A server's items go when it says `server.closing`, when its connection ends and its owner is
 * gone, or when its endpoint file is removed.
 *
 * Beside the servers' items the file carries `history`: the newest runs from their records
 * (`history.ts`) that no server holds, so a run a server evicted, or one whose server exited,
 * stays listed. The records are read at start and whenever a server lets items go (an item
 * removed, a snapshot replacing its set, the server gone), at most once per
 * `historyMinIntervalMs`; never on a timer of their own, and never for an item that only changed.
 *
 * The stamp names the relay's claudish version, so a reader can tell a relay an older build
 * started and replace it.
 */

import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OWNER_START36, ensurePrivateSubdir, ensureSockRoot } from "../pane/pane-launch.js";
import { type ProcessTable, readProcessTableAsync } from "../pane/process-identity.js";
import type {
  ViewEvent,
  ViewItem,
  ViewListResult,
  ViewSubscribeResult,
} from "../pane/view-contract.js";
import { VERSION } from "../version.js";
import { EndpointWatch } from "./endpoint-watch.js";
import { endpointNameOf, endpointOwnerAlive, endpointPathOf } from "./endpoints.js";
import { readHistory } from "./history.js";
import { ViewClient } from "./view-client.js";

export const FEED_DIR = "feed";
export const FEED_FILE = "feed.json";
/** at most four writes a second */
export const FEED_MIN_INTERVAL_MS = 250;
/** the records are read at most this often (one read stats every run directory, about 60 ms) */
export const HISTORY_MIN_INTERVAL_MS = 2_000;

export function defaultFeedPath(root: string): string {
  return join(root, FEED_DIR, FEED_FILE);
}

export interface FeedStamp {
  pid: number;
  start36: string;
  started_at: string;
  /** the relay's claudish version; absent in a file an older relay wrote */
  version?: string;
}

export interface FeedServer {
  endpoint: string;
  pid: number;
  version: string;
}

export interface FeedFile {
  relay: FeedStamp;
  written_at: string;
  servers: FeedServer[];
  items: ViewItem[];
  /** the records' newest runs that no server holds; absent in a file an older relay wrote */
  history?: ViewItem[];
}

export class FeedRelayBusy extends Error {
  constructor(readonly relay: FeedStamp) {
    super(`a feed relay already writes this file (pid ${relay.pid})`);
  }
}

/** The connection to one server, as the relay uses it; `ViewClient` in production. */
export interface RelayConnection {
  readonly helloResult: { server: { pid: number; version: string } } | null;
  on(name: "event", fn: (e: ViewEvent) => void): void;
  on(name: "reconnected", fn: () => void): void;
  on(name: "closed", fn: (reason: "client" | "server_gone") => void): void;
  request<T>(op: string, args?: Record<string, unknown>): Promise<T>;
  close(): void;
}

export interface FeedRelayOptions {
  root: string;
  /** default `<root>/feed/feed.json` */
  path?: string;
  stamp?: FeedStamp;
  minIntervalMs?: number;
  /** whether each named endpoint's owner may run; default the process table */
  endpointsAlive?: (names: string[]) => Promise<Set<string>>;
  connect?: (path: string) => Promise<RelayConnection>;
  backstopMs?: number;
  now?: () => number;
  /** the records' runs; default `readHistory` on `~/.claudish/sessions` */
  history?: () => ViewItem[];
  historyMinIntervalMs?: number;
}

interface ServerState {
  conn: RelayConnection;
  info: FeedServer;
  items: Map<string, ViewItem>;
}

function ownStamp(): FeedStamp {
  return {
    pid: process.pid,
    start36: OWNER_START36,
    started_at: new Date(Number.parseInt(OWNER_START36, 36)).toISOString(),
    version: VERSION,
  };
}

async function liveByProcessTable(names: string[]): Promise<Set<string>> {
  const table: ProcessTable = await readProcessTableAsync();
  return new Set(names.filter((n) => endpointOwnerAlive(n, table)));
}

function connectAsRelay(path: string): Promise<RelayConnection> {
  return ViewClient.connect(path, {
    reconnect: true,
    hello: { name: "claudish view --feed", kind: "relay" },
  });
}

/** The relay stamp in a feed file, or null when the file is missing or not a feed file. */
export function readFeedStamp(path: string): FeedStamp | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FeedFile>;
    const r = parsed.relay;
    if (r && typeof r.pid === "number" && typeof r.start36 === "string") return r as FeedStamp;
  } catch {
    // missing, half-written by another program, or not JSON
  }
  return null;
}

/** Whether the process stamped in `stamp` may still run (the endpoint naming carries the same pair). */
export function stampAlive(stamp: FeedStamp, table: ProcessTable): boolean {
  return endpointOwnerAlive(endpointNameOf(stamp.pid, stamp.start36), table);
}

export interface FeedCheck {
  alive: boolean;
  /** why it is not alive */
  reason?: "missing" | "relay_gone";
  relay?: FeedStamp;
}

/** `claudish view --feed-check`: is the relay that wrote `path` still running? */
export async function checkFeed(path: string, table?: ProcessTable): Promise<FeedCheck> {
  const stamp = readFeedStamp(path);
  if (!stamp) return { alive: false, reason: "missing" };
  const alive = stampAlive(stamp, table === undefined ? await readProcessTableAsync() : table);
  return alive ? { alive, relay: stamp } : { alive, reason: "relay_gone", relay: stamp };
}

export class FeedRelay {
  readonly path: string;
  /** how many times the file was written; for tests and the relay's own status line */
  writes = 0;
  private readonly stamp: FeedStamp;
  private readonly servers = new Map<string, ServerState>();
  /** connections being opened, by endpoint name */
  private readonly opening = new Set<string>();
  /** endpoints whose server said it is closing or went away; forgotten when the file goes */
  private readonly retired = new Set<string>();
  private watch: EndpointWatch | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastWriteAt = Number.NEGATIVE_INFINITY;
  private lastKey: string | null = null;
  private stopped = false;
  private readonly now: () => number;
  private onWritten: (() => void) | null = null;
  private history: ViewItem[] = [];
  private historyDirty = true;
  private historyReadAt = Number.NEGATIVE_INFINITY;
  private historyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly o: FeedRelayOptions) {
    this.path = o.path ?? defaultFeedPath(o.root);
    this.stamp = o.stamp ?? ownStamp();
    this.now = o.now ?? Date.now;
  }

  /** Throws `FeedRelayBusy` when another live relay already writes the file. */
  async start(): Promise<void> {
    ensureSockRoot(this.o.root);
    if (dirname(this.path) === join(this.o.root, FEED_DIR))
      ensurePrivateSubdir(this.o.root, FEED_DIR);
    const other = readFeedStamp(this.path);
    if (other && !this.isOwn(other) && stampAlive(other, await readProcessTableAsync()))
      throw new FeedRelayBusy(other);
    this.flush();
    this.watch = new EndpointWatch({
      root: this.o.root,
      backstopMs: this.o.backstopMs,
      onChange: (names) => void this.follow(names),
    });
    this.watch.start();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.watch?.close();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.historyTimer) clearTimeout(this.historyTimer);
    this.historyTimer = null;
    for (const s of this.servers.values()) s.conn.close();
    this.servers.clear();
    rmSync(this.tmpPath(), { force: true });
    const stamp = readFeedStamp(this.path);
    if (stamp && this.isOwn(stamp)) rmSync(this.path, { force: true });
  }

  /** Resolves after the next write of the file. For tests. */
  nextWrite(): Promise<void> {
    return new Promise((resolve) => {
      this.onWritten = resolve;
    });
  }

  /** The merged view the file carries, without the stamp and time. */
  snapshot(): Required<Pick<FeedFile, "servers" | "items" | "history">> {
    const names = [...this.servers.keys()].sort();
    const servers: FeedServer[] = [];
    const items: ViewItem[] = [];
    for (const name of names) {
      const s = this.servers.get(name);
      if (!s) continue;
      servers.push(s.info);
      items.push(...s.items.values());
    }
    const held = new Set(items.map((i) => i.target));
    return { servers, items, history: this.history.filter((i) => !held.has(i.target)) };
  }

  /** A server let items go: the records may now hold runs the file lacks. */
  private recordsChanged(): void {
    this.historyDirty = true;
    this.schedule();
  }

  /**
   * Read the records when they may have changed and the interval allows; when it does not, the
   * next write comes at the end of the interval. Never throws.
   */
  private refreshHistory(): void {
    if (!this.historyDirty) return;
    const interval = this.o.historyMinIntervalMs ?? HISTORY_MIN_INTERVAL_MS;
    const due = this.historyReadAt + interval - this.now();
    if (due > 0) {
      // the items are written now; the records' read waits on its own timer
      this.historyTimer ??= setTimeout(() => {
        this.historyTimer = null;
        this.schedule();
      }, due);
      return;
    }
    try {
      this.history = (this.o.history ?? (() => readHistory()))();
    } catch {
      // unreadable records keep the last list
    }
    this.historyDirty = false;
    this.historyReadAt = this.now();
  }

  private isOwn(stamp: FeedStamp): boolean {
    return stamp.pid === this.stamp.pid && stamp.start36 === this.stamp.start36;
  }

  private async follow(names: string[]): Promise<void> {
    const present = new Set(names);
    for (const name of [...this.retired]) if (!present.has(name)) this.retired.delete(name);
    for (const name of [...this.servers.keys()]) if (!present.has(name)) this.drop(name);
    const fresh = names.filter(
      (n) => !this.servers.has(n) && !this.opening.has(n) && !this.retired.has(n)
    );
    if (fresh.length === 0) return;
    const alive = await (this.o.endpointsAlive ?? liveByProcessTable)(fresh);
    for (const name of fresh) if (alive.has(name)) void this.open(name);
  }

  private async open(name: string): Promise<void> {
    if (this.stopped) return;
    this.opening.add(name);
    let conn: RelayConnection;
    try {
      conn = await (this.o.connect ?? connectAsRelay)(endpointPathOf(this.o.root, name));
    } catch {
      // not listening yet or refused: the next directory event or the backstop tries again
      this.opening.delete(name);
      return;
    }
    this.opening.delete(name);
    if (this.stopped) {
      conn.close();
      return;
    }
    const state: ServerState = {
      conn,
      info: {
        endpoint: name,
        pid: conn.helloResult?.server.pid ?? 0,
        version: conn.helloResult?.server.version ?? "",
      },
      items: new Map(),
    };
    this.servers.set(name, state);
    conn.on("event", (e) => this.onEvent(name, state, e));
    conn.on("reconnected", () => void this.subscribe(name, state));
    conn.on("closed", () => {
      if (this.servers.get(name) === state) this.retire(name);
    });
    await this.subscribe(name, state);
  }

  private async subscribe(name: string, state: ServerState): Promise<void> {
    try {
      await state.conn.request<ViewSubscribeResult>("subscribe", { include_finished: true });
    } catch {
      // the connection's own close or reconnect decides what happens to this server
      if (this.servers.get(name) !== state) return;
      const listed = await state.conn
        .request<ViewListResult>("list", { include_finished: true })
        .catch(() => null);
      if (listed) this.replaceItems(state, listed.items);
    }
  }

  private onEvent(name: string, state: ServerState, e: ViewEvent): void {
    if (this.servers.get(name) !== state) return;
    switch (e.event) {
      case "snapshot":
        this.replaceItems(state, e.items);
        return;
      case "item.upsert":
        state.items.set(e.item.target, e.item);
        this.schedule();
        return;
      case "item.remove":
        if (state.items.delete(e.target)) this.recordsChanged();
        return;
      case "server.closing":
        this.retire(name);
        return;
    }
  }

  private replaceItems(state: ServerState, items: ViewItem[]): void {
    state.items = new Map(items.map((i) => [i.target, i]));
    this.recordsChanged();
  }

  /** The server is going: drop its items and never dial this endpoint file again. */
  private retire(name: string): void {
    this.retired.add(name);
    this.drop(name);
  }

  private drop(name: string): void {
    const s = this.servers.get(name);
    if (!s) return;
    this.servers.delete(name);
    s.conn.close();
    this.recordsChanged();
  }

  private schedule(): void {
    this.scheduleIn(this.lastWriteAt + (this.o.minIntervalMs ?? FEED_MIN_INTERVAL_MS) - this.now());
  }

  private scheduleIn(ms: number): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.flush();
      },
      Math.max(0, ms)
    );
  }

  private tmpPath(): string {
    return `${this.path}.${this.stamp.pid}.tmp`;
  }

  /** Write the file when the merged set differs from what it holds. */
  private flush(): void {
    if (this.stopped) return;
    this.refreshHistory();
    const body = this.snapshot();
    const key = JSON.stringify(body);
    if (key === this.lastKey) return;
    const file: FeedFile = {
      relay: this.stamp,
      written_at: new Date(this.now()).toISOString(),
      ...body,
    };
    const tmp = this.tmpPath();
    writeFileSync(tmp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
    this.lastKey = key;
    this.lastWriteAt = this.now();
    this.writes += 1;
    const done = this.onWritten;
    this.onWritten = null;
    done?.();
  }
}

/** Runs the relay until SIGTERM, SIGINT or SIGHUP. Exit code 3 when another relay owns the file. */
export async function runFeedRelay(o: { root: string; path: string }): Promise<number> {
  const relay = new FeedRelay({ root: o.root, path: o.path });
  try {
    await relay.start();
  } catch (e) {
    process.stderr.write(`claudish view --feed: ${e instanceof Error ? e.message : String(e)}\n`);
    return e instanceof FeedRelayBusy ? 3 : 1;
  }
  process.stdout.write(`claudish ${VERSION} feed relay: ${relay.path}\n`);
  await new Promise<void>((resolve) => {
    const done = (): void => resolve();
    process.once("SIGTERM", done);
    process.once("SIGINT", done);
    process.once("SIGHUP", done);
  });
  await relay.stop();
  return 0;
}
