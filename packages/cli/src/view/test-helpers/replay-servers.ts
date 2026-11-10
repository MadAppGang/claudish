/**
 * Several claudish "servers" in one test process, sharing one socket root: each is a
 * `ReplayManager` with its own `ViewServer` endpoint, claims, feed and grants. Their replay panes
 * are fakes whose "magmux" is a real child process (`/bin/sleep`) handed the replay lock as fd 3,
 * so the kernel lock is the real one: it is held exactly while that child lives.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PlacementGrants } from "../../herdr/placement-grants.js";
import { ReplayManager, type ReplayPaneLike } from "../../mcp-session/replay-manager.js";
import type {
  CaptureResult,
  CaptureUnchanged,
  ReplayTarget,
  ScrollRequest,
} from "../../pane/index.js";
import type { ReplayPaneOptions, ReplayReady } from "../../pane/replay-pane.js";
import { PeerLinks } from "../peer-link.js";
import { ViewClaims } from "../view-claims.js";
import { ViewDirectory } from "../view-directory.js";
import { ViewFeed } from "../view-feed.js";
import { ViewServer } from "../view-server.js";
import { makeViewRoot } from "./fake-view-endpoint.js";

export interface PaneControl {
  /** ms the fake waits before its "magmux" dies on close (a slow reap) */
  closeDelayMs: number;
  /** false: the fake frees the lock at spawn instead of handing it on (the negative control) */
  handLock: boolean;
  /** ms the fake's boot takes before it reports ready (a slow replay start) */
  readyDelayMs?: number;
}

/** Every fake replay process any server started, in spawn order. */
export interface SpawnLog {
  panes: FakeReplayPane[];
}

export class FakeReplayPane implements ReplayPaneLike {
  readonly paneId: string;
  readonly viewSockPath = null;
  readonly proc: ChildProcess;
  readonly scrolls: ScrollRequest[] = [];
  readonly startedAt = Date.now();
  diedAt: number | null = null;
  private s = 1;
  private cols = 80;
  private rows = 24;
  private fin = false;
  private closing: Promise<boolean> | null = null;
  private readonly exited: Promise<void>;

  constructor(
    private readonly o: ReplayPaneOptions,
    private readonly root: string,
    private readonly ctl: PaneControl,
    readonly server: string
  ) {
    this.paneId = o.paneId ?? `c${process.pid}-x-rfake-${randomBytes(3).toString("hex")}`;
    const lockFd = ctl.handLock && o.holdLock ? o.holdLock.fd : "ignore";
    this.proc = spawn("/bin/sleep", ["600"], {
      stdio: ["ignore", "ignore", "ignore", lockFd],
      detached: true,
    });
    // the opener's copy goes on the line after the spawn, as `ReplayPane.start` does
    o.holdLock?.close();
    this.exited = new Promise((resolve) => this.proc.once("exit", () => resolve()));
    void this.exited.then(() => {
      this.diedAt = Date.now();
      this.finish();
    });
    mkdirSync(join(root, "panes"), { recursive: true, mode: 0o700 });
    writeFileSync(this.recordPath, "{}\n");
  }

  get recordPath(): string {
    return join(this.root, "panes", `${this.paneId}.json`);
  }

  get alive(): boolean {
    return this.diedAt === null;
  }

  seq(): number {
    return this.s;
  }

  finished(): boolean {
    return this.fin;
  }

  async ready(_ms: number): Promise<ReplayReady> {
    if (this.ctl.readyDelayMs) await Bun.sleep(this.ctl.readyDelayMs);
    return { kind: "box" };
  }

  capture(sinceSeq?: number, opts: { spans?: boolean } = {}): CaptureResult | CaptureUnchanged {
    if (sinceSeq !== undefined && sinceSeq === this.s)
      return { unchanged: true, seq: this.s, final: this.fin };
    return {
      seq: this.s,
      cols: this.cols,
      rows: this.rows,
      cursor: { x: 0, y: 0 },
      lines: [`replay ${this.paneId} on ${this.server}`],
      final: this.fin,
      ...(opts.spans ? { spans: [[]] } : {}),
    };
  }

  async resize(cols: number, rows: number) {
    if (this.fin) return { cols: this.cols, rows: this.rows, changed: false, seq: this.s };
    const changed = cols !== this.cols || rows !== this.rows;
    this.cols = cols;
    this.rows = rows;
    if (changed) this.s += 1;
    return { cols, rows, changed, seq: this.s };
  }

  async scroll(req: ScrollRequest) {
    this.scrolls.push(req);
    this.s += 1;
    return { seq: this.s };
  }

  close(): Promise<boolean> {
    this.finish();
    if (!this.closing)
      this.closing = (async () => {
        if (this.ctl.closeDelayMs > 0) await Bun.sleep(this.ctl.closeDelayMs);
        this.kill();
        await this.exited;
        rmSync(this.recordPath, { force: true });
        this.o.onReaped?.(true);
        return true;
      })();
    return this.closing;
  }

  /** The "magmux" dies by itself (SIGKILL from outside). */
  kill(): void {
    try {
      this.proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  }

  private finish(): void {
    if (this.fin) return;
    this.fin = true;
    this.o.onFinish?.();
  }
}

export interface TestServer {
  name: string;
  replays: ReplayManager;
  view: ViewServer;
  claims: ViewClaims;
  feed: ViewFeed;
  grants: PlacementGrants;
  /** the server dies: its sockets drop, nothing of it is reaped */
  kill(): void;
}

export interface ReplayWorld {
  root: string;
  target: ReplayTarget;
  spawns: SpawnLog;
  ctl: PaneControl;
  server(opts?: {
    readyMs?: number;
    joinExtraMs?: number;
    unreachableCloseMs?: number;
  }): Promise<TestServer>;
  /** fake processes alive right now */
  alive(): FakeReplayPane[];
  /** whether a test server's endpoint is up (it has not been killed) */
  endpointAlive(name: string): boolean;
  stop(): Promise<void>;
}

const stubSessions = {
  sessionRow: () => null,
  viewDetail: () => null,
  listSessionRows: () => [],
  captureSession: (): never => {
    throw new Error("unused");
  },
  transcriptSession: (): never => {
    throw new Error("unused");
  },
  resizeSession: async (): Promise<never> => {
    throw new Error("unused");
  },
};

const stubTeam = {
  listSlots: () => [],
  slot: () => null,
  capture: (): never => {
    throw new Error("unused");
  },
  transcript: (): never => {
    throw new Error("unused");
  },
  resize: async (): Promise<never> => {
    throw new Error("unused");
  },
};

/** One root, one finished session to replay, and a factory of servers under that root. */
export function makeReplayWorld(): ReplayWorld {
  const root = `/tmp/rpw-${randomBytes(4).toString("hex")}`;
  makeViewRoot(root);
  const uuid = randomUUID();
  const projectsRoot = join(root, "cfg", "projects");
  const project = join(projectsRoot, "-tmp-proj");
  mkdirSync(project, { recursive: true });
  const transcriptPath = join(project, `${uuid}.jsonl`);
  writeFileSync(transcriptPath, `${JSON.stringify({ type: "user", message: "hi" })}\n`);
  const target: ReplayTarget = {
    claudeSessionId: uuid,
    transcriptPath,
    writerGone: true,
    cwd: root,
    projectsRoot,
    of: { session_id: "s1" },
    model: "fake-model",
  };
  const spawns: SpawnLog = { panes: [] };
  const ctl: PaneControl = { closeDelayMs: 0, handLock: true };
  const servers: TestServer[] = [];
  const names = new Set<string>();
  let n = 0;

  async function server(
    opts: { readyMs?: number; joinExtraMs?: number; unreachableCloseMs?: number } = {}
  ): Promise<TestServer> {
    n += 1;
    const name = `c${process.pid}-t${n}${randomBytes(2).toString("hex")}.sock`;
    names.add(name);
    const feed = new ViewFeed();
    const claims = new ViewClaims({ notify: (t) => feed.changed(t, true) });
    const grants = new PlacementGrants({ notify: (t) => feed.changed(t, true) });
    let endpointName: string | null = null;
    const replays = new ReplayManager({
      sockRoot: root,
      claudeBinary: "/bin/false",
      readyMs: opts.readyMs ?? 500,
      joinExtraMs: opts.joinExtraMs ?? 2_000,
      unreachableCloseMs: opts.unreachableCloseMs ?? 1_000,
      shared: true,
      peers: new PeerLinks({ root, self: () => endpointName }),
      startPane: async (o) => {
        const pane = new FakeReplayPane(o, root, ctl, name);
        spawns.panes.push(pane);
        return pane;
      },
    });
    replays.setViewServices({
      feed,
      claims,
      grants: {
        grant: (t, k, owner, txn) => grants.grant(t, k, owner, txn),
        doneFor: (t, k, owner) => grants.doneFor(t, k, owner),
        workspaces: (t) => grants.workspaces(t),
      },
    });
    replays.setEndpoint(() => endpointName);
    const directory = new ViewDirectory({
      sessions: stubSessions,
      team: stubTeam,
      replays,
      claims,
      herdrWorkspaces: (t) => grants.workspaces(t),
    });
    feed.setBuilder((t) => directory.item(t));
    const view = await ViewServer.start({
      root,
      directory,
      claims,
      feed,
      version: "test",
      endpointName: name,
      peerAlive: (e) => names.has(e),
      herdrViewers: grants,
      replays,
      resolveReplayTarget: () => target,
    });
    if (!view) throw new Error("no endpoint");
    endpointName = view.endpointName;
    const s: TestServer = {
      name,
      replays,
      view,
      claims,
      feed,
      grants,
      kill: () => {
        names.delete(name);
        replays.closePeerLinks();
        view.close();
      },
    };
    servers.push(s);
    return s;
  }

  return {
    root,
    target,
    spawns,
    ctl,
    server,
    alive: () => spawns.panes.filter((p) => p.alive),
    endpointAlive: (name) => names.has(name),
    async stop() {
      for (const s of servers) s.kill();
      for (const p of spawns.panes) p.kill();
      await Bun.sleep(50);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
