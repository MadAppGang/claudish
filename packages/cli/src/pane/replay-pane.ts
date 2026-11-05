/**
 * One read-only replay: a finished session's real interface, `claude --resume … --fork-session
 * --bare`, in a headless magmux pane.
 *
 * Read only by construction. No member takes text destined for the pane: the one `send`
 * carries `planScroll`'s bytes, and `scroll` accepts only the `{by} | {to}` union, so only
 * wheel events and ctrl-End can leave. The other requests are `capabilities`, `watch`,
 * `list`, `resize` and `close_pane`. The pane has no controller and no input gate, because
 * nothing here ever types into it.
 *
 * The box is read BEFORE any dialog, the opposite of `readBoot`: a replayed conversation can
 * quote a dialog's words, and a real dialog replaces the box. A named screen therefore
 * counts only with no box, static for `DIALOG_STABLE_MS`, and never once a box has been seen,
 * because a resize redraw can leave the cursor stale for a frame.
 *
 * Nothing ends a replay for being idle. It ends when its process exits, when the owner
 * closes it, or when the owner's process ends (pane watcher, sweep, shutdown hooks, as for
 * every pane). A finished replay keeps its last screen in memory, and its reservation is
 * already free.
 */

import type { ChildProcess } from "node:child_process";
import { rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeConfigDir } from "../mcp-session/parent-session.js";
import { redactSecrets } from "../redact.js";
import { locateBox } from "./box-locate.js";
import { type CaptureResult, type CaptureUnchanged, ContractErrorException } from "./contract.js";
import { MagmuxClient, type MagmuxConnectError } from "./magmux-client.js";
import {
  FATAL_MAGMUX_STDERR,
  MIN_MAGMUX_VERSION,
  assertMagmuxAvailable,
  buildReplayArgv,
  buildReplayEnv,
  createLaunchDirs,
  ensureSockRoot,
  mintPaneId,
  readUserStatusLine,
  replayLauncherScript,
  replaySettingsJson,
  sockRootFor,
  spawnPaneWatcher,
  spawnReplayMagmux,
  versionAtLeast,
  writeLauncherFiles,
} from "./pane-launch.js";
import { type PaneReapSubject, alive, reapPaneProcesses, retryPaneReap } from "./pane-reap.js";
import {
  type RegisteredPane,
  ensureSwept,
  installPaneShutdownHooks,
  ownerStartOfSelf,
  paneShutdownHooksInstalled,
  refreshGroupOf,
  registerPane,
  reservePanes,
  takePaneReservation,
  updateRecord,
  writeRecord,
} from "./pane-registry.js";
import type { PaneResizeOutcome } from "./pane-session.js";
import { type PaneSize, clampPaneSize, samePaneSize } from "./pane-size.js";
import {
  type GroupSnapshot,
  type PaneIdentity,
  isLaunchDirPath,
  readProcessTableAsync,
  recordPathOf,
  sockPathOf,
} from "./process-identity.js";
import { nameBootScreen } from "./screen-classifier.js";
import { type MagmuxFrame, type ScreenState, applyFrame, emptyScreen } from "./screen-model.js";
import {
  LIVE_BOTTOM,
  type ScrollPosition,
  type ScrollRequest,
  UNKNOWN_POSITION,
  planScroll,
} from "./scroll-input.js";

/** While no box has been seen, the ready reading also runs this often: a static dialog sends no frame. */
const READY_TICK_MS = 250;
/** A named screen must be static this long: a real dialog is, conversation text being drawn is not. */
const DIALOG_STABLE_MS = 1_000;
/** magmux's `exit` event has a backstop in `list`, read this often. */
const LIST_POLL_MS = 2_000;
const LIST_REPLY_MS = 1_000;
const WATCH_FPS = 4;
/** After a pane exit: wait at most this for the frame that shows its last screen. */
const LAST_FRAME_MS = 500;
const RESIZE_REPLY_MS = 10_000;
const RESIZE_SCREEN_MS = 1_000;
const SCROLL_REPLY_MS = 5_000;
const SCROLL_SCREEN_MS = 1_000;
const CONNECT_TIMEOUT_MS = 5_000;
const RECONNECT_FIRST_MS = 50;
const RECONNECT_MAX_MS = 1_000;
/** This many consecutive ENOENT dials: the socket is gone, not busy. */
const RECONNECT_ENOENT_LIMIT = 20;
const STDERR_HEAD_CHARS = 8_192;

export interface ReplayPaneOptions {
  claudeSessionId: string;
  forkUuid: string;
  claudeBinary: string;
  /** realpath */
  cwd: string;
  /** the exact file a fork of this replay could write */
  forkPath: string;
  /** this replay's start created the project directory, so a removal of the fork may remove it */
  removeProjectDir: boolean;
  configDir: string;
  /** already clamped */
  size: PaneSize;
  parentEnv: Record<string, string | undefined>;
  sockRoot?: string;
  magmuxBinary?: string;
  label: string;
  /** called once, when the replay finishes for any reason */
  onFinish?: () => void;
  /** read just before the pane is counted: true refuses the start (a server shutting down) */
  refused?: () => boolean;
}

export type ReplayReady =
  | { kind: "box" }
  | { kind: "slow" }
  | { kind: "dialog"; name: string }
  | { kind: "ended"; detail: string };

async function waitUntil(pred: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await Bun.sleep(25);
}

/**
 * The fork's one possible record, by exact path, and its project directory only when this
 * replay's start created it: `rmdir` refuses a directory that holds anything else, and
 * nothing here is recursive or lists a directory.
 */
function removeForkRecord(forkPath: string, removeProjectDir: boolean): void {
  try {
    rmSync(forkPath, { force: true });
    if (removeProjectDir) rmdirSync(dirname(forkPath));
  } catch {
    // a sibling's record keeps the directory, or it is already gone
  }
}

export class ReplayPane implements RegisteredPane {
  readonly paneId: string;
  readonly root: string;
  readonly identity: PaneIdentity;
  group: GroupSnapshot | null = null;
  reapFailed = false;

  private readonly o: ReplayPaneOptions;
  private readonly sockPath: string;
  private readonly ctlDir: string;
  private readonly turnDir: string;
  private screen: ScreenState;
  private isFinal = false;
  private boxSeen = false;
  private readonly readyAnswer = Promise.withResolvers<ReplayReady>();

  private magmuxProc: ChildProcess | null = null;
  private watcherProc: ChildProcess | null = null;
  private conn: MagmuxClient | null = null;
  private panePidValue: number | null = null;
  private stderrHead = "";
  private paneClosed = false;
  private paneExited = false;
  private reconnecting = false;
  private reaping = false;
  private fastReap = false;
  private reapPromise: Promise<void> | null = null;
  private readyTicker: ReturnType<typeof setInterval> | null = null;
  private listTicker: ReturnType<typeof setInterval> | null = null;
  private listInFlight = false;

  /** the size the viewer asked for last (clamped); the drain worker always sends this one */
  private desiredSize: PaneSize;
  /** the pane's size as magmux last confirmed it; null = unknown (a lost or timed-out reply) */
  private appliedSize: PaneSize | null;
  private supportsResize = false;
  private resizeWaiters: Array<{
    resolve: (r: PaneResizeOutcome) => void;
    reject: (e: ContractErrorException) => void;
  }> = [];
  private resizeDraining = false;
  /** the size of the worker's last send on this connection; null = none since the attach */
  private lastSentSize: PaneSize | null = null;
  private scrollPos: ScrollPosition = LIVE_BOTTOM;

  constructor(
    o: ReplayPaneOptions,
    ids: { paneId: string; sockPath: string; root: string; ctlDir: string; turnDir: string }
  ) {
    this.o = o;
    this.paneId = ids.paneId;
    this.sockPath = ids.sockPath;
    this.root = ids.root;
    this.ctlDir = ids.ctlDir;
    this.turnDir = ids.turnDir;
    this.identity = { paneId: ids.paneId, sessionUuid: o.forkUuid, ctlDir: ids.ctlDir };
    this.desiredSize = { ...o.size };
    // magmux sizes the pane from COLUMNS/LINES at launch, so the launch size is applied
    this.appliedSize = { ...o.size };
    this.screen = emptyScreen(o.size.cols, o.size.rows);
  }

  /* ───────────────────────────── RegisteredPane ───────────────────────────── */

  panePid(): number | null {
    return this.panePidValue;
  }

  async shutdownReap(_reason: string): Promise<void> {
    this.fastReap = true;
    this.finish({ kind: "ended", detail: "the server is shutting down" });
    await this.reapPromise;
  }

  retryReap(): Promise<boolean> {
    return retryPaneReap(this.reapSubject);
  }

  killMagmuxSync(): void {
    if (alive(this.magmuxProc)) this.magmuxProc?.kill("SIGKILL");
  }

  /* ───────────────────────────── lifecycle ───────────────────────────── */

  /** Spawn order: record (already written) → watcher → magmux → magmux.pid and record → dial. */
  async start(input: {
    magmuxBinary: string;
    env: Record<string, string>;
    cwd: string;
  }): Promise<void> {
    const failed = (e: unknown): void => {
      const msg = e instanceof Error ? e.message : String(e);
      this.finish({ kind: "ended", detail: `magmux spawn failed: ${msg}` });
    };
    try {
      this.watcherProc = spawnPaneWatcher({
        paneId: this.paneId,
        sessionUuid: this.o.forkUuid,
        ctlDir: this.ctlDir,
        sockPath: this.sockPath,
        recordPath: recordPathOf(this.root, this.paneId),
        turnDir: this.turnDir,
        sockRoot: this.root,
      });
    } catch (e) {
      return failed(e);
    }
    updateRecord(this.root, this.paneId, { watcherPid: this.watcherProc.pid ?? null });
    let proc: ChildProcess;
    try {
      proc = spawnReplayMagmux({
        binary: input.magmuxBinary,
        paneId: this.paneId,
        sockRoot: this.root,
        ctlDir: this.ctlDir,
        cwd: input.cwd,
        env: input.env,
      });
    } catch (e) {
      return failed(e);
    }
    if (!proc.pid) return failed(new Error("magmux did not start"));
    this.magmuxProc = proc;
    try {
      writeFileSync(join(this.ctlDir, "magmux.pid"), `${proc.pid}\n`, { mode: 0o600 });
    } catch {
      // the record carries it too
    }
    updateRecord(this.root, this.paneId, { magmuxPid: proc.pid });
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (d: string) => {
      if (this.stderrHead.length < STDERR_HEAD_CHARS)
        this.stderrHead += d.slice(0, STDERR_HEAD_CHARS - this.stderrHead.length);
      const fatal = d.split("\n").find((l) => FATAL_MAGMUX_STDERR.test(l));
      if (fatal) this.finish({ kind: "ended", detail: redactSecrets(fatal.trim()) });
    });
    proc.on("exit", (code, sig) => this.onMagmuxExit(code, sig));
    this.readyTicker = setInterval(() => this.evaluateReady(), READY_TICK_MS);
    this.listTicker = setInterval(this.pollList, LIST_POLL_MS);
    let client: MagmuxClient;
    try {
      client = await MagmuxClient.connect(this.sockPath, {
        timeoutMs: CONNECT_TIMEOUT_MS,
        alive: () => alive(this.magmuxProc),
      });
    } catch (e) {
      const stderr = this.stderrHead ? `; magmux: ${this.stderrHead.trim()}` : "";
      this.finish({
        kind: "ended",
        detail: redactSecrets(
          `cannot connect to ${this.sockPath}: ${(e as MagmuxConnectError).message}${stderr}`
        ),
      });
      return;
    }
    await this.attach(client, false);
  }

  /**
   * The first of: the box located, a stable dialog, the end of the replay, or `ms` elapsed.
   * On `slow` the watch goes on: a later dialog still closes the pane.
   */
  ready(ms: number): Promise<ReplayReady> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<ReplayReady>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "slow" }), ms);
    });
    return Promise.race([this.readyAnswer.promise, slow]).finally(() => clearTimeout(timer));
  }

  /** Finish, await the one reap. True when the process is verified gone. */
  async close(): Promise<boolean> {
    this.finish({ kind: "ended", detail: "the replay was closed" });
    await this.reapPromise;
    return !this.reapFailed;
  }

  seq(): number {
    return this.screen.seq;
  }

  finished(): boolean {
    return this.isFinal;
  }

  /* ───────────────────────────── the three reads ───────────────────────────── */

  capture(sinceSeq?: number, opts: { spans?: boolean } = {}): CaptureResult | CaptureUnchanged {
    const s = this.screen;
    if (sinceSeq !== undefined && sinceSeq === s.seq)
      return { unchanged: true, seq: s.seq, final: this.isFinal };
    const out: CaptureResult = {
      seq: s.seq,
      cols: s.cols,
      rows: s.rows,
      cursor: { ...s.cursor },
      lines: [...s.lines],
      final: this.isFinal,
    };
    if (opts.spans) out.spans = s.spans.map((r) => r.map((x) => [...x] as typeof x));
    return out;
  }

  async resize(cols: number, rows: number): Promise<PaneResizeOutcome> {
    const size = clampPaneSize(cols, rows);
    if (this.isFinal) return this.lastSizeOutcome();
    if (!this.conn) return this.pendingOutcome(size);
    if (!this.supportsResize)
      throw new ContractErrorException(
        "resize_unsupported",
        'this magmux has no resize op (capabilities.verbs lacks "resize"); a newer magmux is needed'
      );
    if (
      samePaneSize(this.appliedSize, size) &&
      samePaneSize(this.desiredSize, size) &&
      !this.resizeDraining
    )
      return { ...size, changed: false, seq: this.screen.seq };
    this.desiredSize = size;
    return new Promise<PaneResizeOutcome>((resolve, reject) => {
      this.resizeWaiters.push({ resolve, reject });
      this.kickResize();
    });
  }

  /** The only `send` a replay makes: `planScroll`'s bytes, one request, no Enter, no gate. */
  async scroll(req: ScrollRequest): Promise<{ seq: number }> {
    if (this.isFinal) throw new ContractErrorException("scroll_unavailable", "the replay finished");
    if (this.screen.seq === 0)
      throw new ContractErrorException("scroll_unavailable", "the replay is still starting");
    const c = this.conn;
    if (!c || c.isClosed)
      throw new ContractErrorException("scroll_unavailable", "the pane's socket is reconnecting");
    const plan = planScroll(this.scrollPos, req);
    if (plan.bytes === "") return { seq: this.screen.seq };
    // before any await: a concurrent scroll plans from where this one leaves the view
    this.scrollPos = plan.next;
    const seq0 = this.screen.seq;
    const r = await c.request(
      { type: "send", pane: 0, text: plan.bytes, enter: false, noGate: true },
      SCROLL_REPLY_MS
    );
    if (!r.ok) {
      this.scrollPos = UNKNOWN_POSITION;
      throw new ContractErrorException(
        "scroll_unavailable",
        `magmux did not confirm the scroll: ${r.code}${r.error ? `: ${r.error}` : ""}`
      );
    }
    await waitUntil(() => this.isFinal || this.screen.seq !== seq0, SCROLL_SCREEN_MS);
    return { seq: this.screen.seq };
  }

  /* ───────────────────────────── magmux ───────────────────────────── */

  /** Subscribe a fresh connection: capabilities, a stored size, watch, list (a dead pane?). */
  private async attach(client: MagmuxClient, reconnect: boolean): Promise<void> {
    if (this.isFinal) {
      client.close();
      return;
    }
    client.on("snapshot", (e: { panes?: Array<{ pane?: number; pid?: number }> }) => {
      const p0 = e?.panes?.find((p) => p.pane === 0);
      if (p0?.pid && !this.panePidValue) this.setPanePid(p0.pid);
    });
    client.on("frame", (f: MagmuxFrame) => this.onFrame(f));
    client.on("exit", (e) => void this.onPaneExit(e));
    client.on("pane_closed", (e) => {
      if (e?.pane === 0) this.paneClosed = true;
    });
    client.on("disconnected", () => {
      if (this.conn === client) this.conn = null;
      if (this.reaping || this.isFinal || !alive(this.magmuxProc)) return;
      void this.reconnect();
    });
    const caps = await client.request<{ version?: string; protocol?: number; verbs?: unknown }>({
      type: "capabilities",
    });
    this.supportsResize =
      caps.ok && Array.isArray(caps.result.verbs) && caps.result.verbs.includes("resize");
    // dropped while asking: `disconnected` has already started the redial
    if (client.isClosed) return;
    this.conn = client;
    if (caps.ok) {
      const v = String(caps.result.version ?? "");
      if (caps.result.protocol !== 1 || !versionAtLeast(v, MIN_MAGMUX_VERSION)) {
        this.finish({
          kind: "ended",
          detail: `magmux ${v || "?"} protocol ${caps.result.protocol ?? "?"}; panes need >= ${MIN_MAGMUX_VERSION}, protocol 1`,
        });
        return;
      }
    }
    // a size set while disconnected, or one whose reply was lost, is applied now
    this.lastSentSize = null;
    if (this.supportsResize && !samePaneSize(this.appliedSize, this.desiredSize)) this.kickResize();
    await client.request({ type: "watch", pane: 0, mode: "frames", fps: WATCH_FPS });
    // an `exit` pushed before this connection subscribed is only visible in `list`
    const list = await client.request<{ panes?: Array<Record<string, unknown>> }>({ type: "list" });
    const p0 = list.ok ? list.result.panes?.find((p) => p.pane === 0) : undefined;
    if (typeof p0?.pid === "number" && !this.panePidValue) this.setPanePid(p0.pid);
    if (p0?.dead === true) {
      if (!reconnect) {
        const seq = this.screen.seq;
        await waitUntil(() => this.screen.seq !== seq, LAST_FRAME_MS);
      }
      void this.onPaneExit({ exitCode: p0.exitCode ?? null, lastLine: "" });
    }
  }

  private onFrame(f: MagmuxFrame): void {
    if (f.pane !== undefined && f.pane !== 0) return;
    // a finished replay's last screen stays what it was when it finished
    if (this.isFinal) return;
    this.screen = applyFrame(this.screen, f);
    this.evaluateReady();
  }

  /** One ready reading; see the module comment for why the box comes first. */
  private evaluateReady(): void {
    if (this.isFinal || this.boxSeen) return;
    if (locateBox(this.screen)) {
      this.boxSeen = true;
      if (this.readyTicker) clearInterval(this.readyTicker);
      this.readyTicker = null;
      this.readyAnswer.resolve({ kind: "box" });
      return;
    }
    if (this.screen.seq === 0) return;
    const named = nameBootScreen(this.screen);
    if (named.kind === "booting") return;
    if (Date.now() - this.screen.changedAt < DIALOG_STABLE_MS) return;
    this.finish({ kind: "dialog", name: named.kind === "dialog" ? named.name : "choice" });
  }

  /** `list`'s `dead` is the `exit` event's backstop, and names the pane's pid if nothing else did. */
  private readonly pollList = (): void => {
    const c = this.conn;
    if (!c || this.listInFlight || this.isFinal) return;
    this.listInFlight = true;
    void c
      .request<{ panes?: Array<Record<string, unknown>> }>({ type: "list" }, LIST_REPLY_MS)
      .then((r) => {
        this.listInFlight = false;
        if (!r.ok) return;
        const p0 = r.result.panes?.find((p) => p.pane === 0);
        if (typeof p0?.pid === "number" && !this.panePidValue) this.setPanePid(p0.pid);
        if (p0?.dead === true)
          void this.onPaneExit({ exitCode: p0.exitCode ?? null, lastLine: "" });
      });
  };

  /** The pane's child exited: the frame showing its last screen, then the end of the replay. */
  private async onPaneExit(e: { exitCode?: unknown; lastLine?: unknown }): Promise<void> {
    if (this.paneExited || this.isFinal) return;
    this.paneExited = true;
    const code = typeof e?.exitCode === "number" ? e.exitCode : null;
    const lastLine = typeof e?.lastLine === "string" ? e.lastLine.trim() : "";
    const seq = this.screen.seq;
    await waitUntil(() => this.screen.seq !== seq, LAST_FRAME_MS);
    const tail = lastLine ? `: ${redactSecrets(lastLine)}` : "";
    this.finish({ kind: "ended", detail: `claude exited (code ${code ?? "unknown"})${tail}` });
  }

  private onMagmuxExit(code: number | null, sig: NodeJS.Signals | null): void {
    if (this.reaping || this.isFinal) return;
    const stderr = this.stderrHead ? `; stderr: ${this.stderrHead.trim().slice(0, 500)}` : "";
    this.finish({
      kind: "ended",
      detail: redactSecrets(`magmux exited (${sig ?? `code ${code}`})${stderr}`),
    });
  }

  /** magmux keeps its panes when a client leaves: redial with backoff while it lives. */
  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    let delay = RECONNECT_FIRST_MS;
    let enoent = 0;
    try {
      while (alive(this.magmuxProc) && !this.reaping && !this.isFinal) {
        try {
          const c = await MagmuxClient.dial(this.sockPath);
          await this.attach(c, true);
          return;
        } catch (e) {
          enoent = (e as MagmuxConnectError).errno === "ENOENT" ? enoent + 1 : 0;
          if (enoent >= RECONNECT_ENOENT_LIMIT) {
            this.finish({ kind: "ended", detail: "the pane's socket is gone" });
            return;
          }
        }
        await Bun.sleep(delay);
        delay = Math.min(RECONNECT_MAX_MS, delay * 2);
      }
    } finally {
      this.reconnecting = false;
    }
  }

  private setPanePid(pid: number): void {
    this.panePidValue = pid;
    updateRecord(this.root, this.paneId, { panePid: pid });
    // never a synchronous ps on the event loop: a stalled loop gets our socket dropped
    void readProcessTableAsync().then((t) => {
      if (t) refreshGroupOf(this, t);
    });
  }

  /* ───────────────────────────── resize ───────────────────────────── */

  private readonly pendingOutcome = (size: PaneSize): PaneResizeOutcome => {
    this.desiredSize = { ...size };
    return { ...size, changed: true, seq: this.screen.seq, pending: true };
  };

  private readonly lastSizeOutcome = (): PaneResizeOutcome => ({
    cols: this.screen.cols,
    rows: this.screen.rows,
    changed: false,
    seq: this.screen.seq,
  });

  /** A size no waiter carries is still owed only when the worker has not sent it on this connection. */
  private readonly resizeOwed = (): boolean =>
    !!this.conn &&
    this.supportsResize &&
    !this.isFinal &&
    !samePaneSize(this.appliedSize, this.desiredSize) &&
    !samePaneSize(this.lastSentSize, this.desiredSize);

  private readonly kickResize = (): void => {
    if (this.resizeDraining) return;
    this.resizeDraining = true;
    void this.drainResize().finally(() => {
      this.resizeDraining = false;
      if (this.resizeWaiters.length > 0 || this.resizeOwed()) this.kickResize();
    });
  };

  /**
   * The pane's single resize worker: one request at a time, always the latest desired size,
   * so the sizes of a drag coalesce. A send answers every waiter queued before it.
   */
  private async drainResize(): Promise<void> {
    let first = true;
    while (first || this.resizeWaiters.length > 0 || this.resizeOwed()) {
      first = false;
      const batch = this.resizeWaiters.splice(0);
      const answer = (r: PaneResizeOutcome) => {
        for (const w of batch) w.resolve(r);
      };
      const fail = (e: ContractErrorException) => {
        for (const w of batch) w.reject(e);
      };
      if (this.isFinal) {
        answer(this.lastSizeOutcome());
        continue;
      }
      const want = { ...this.desiredSize };
      const c = this.conn;
      if (!c) {
        answer(this.pendingOutcome(want));
        continue;
      }
      if (!this.supportsResize) {
        fail(new ContractErrorException("resize_unsupported", "this magmux has no resize op"));
        continue;
      }
      this.lastSentSize = want;
      const r = await c.request<{ cols?: number; rows?: number; changed?: boolean }>(
        { type: "resize", pane: 0, cols: want.cols, rows: want.rows },
        RESIZE_REPLY_MS
      );
      if (this.isFinal) {
        answer(this.lastSizeOutcome());
        continue;
      }
      if (!r.ok) {
        // magmux may have applied a request whose reply was lost: the size is unknown
        if (r.code === "client_lost" || r.code === "client_timeout") this.appliedSize = null;
        // the connection is gone: the redial's attach re-applies desiredSize
        if (r.code === "client_lost" || r.code === "client_closed") {
          answer(this.pendingOutcome(this.desiredSize));
          continue;
        }
        fail(
          new ContractErrorException(
            "delivery_unavailable",
            `magmux did not resize the pane: ${r.code}${r.error ? `: ${r.error}` : ""}`
          )
        );
        continue;
      }
      const set = {
        cols: typeof r.result.cols === "number" ? r.result.cols : want.cols,
        rows: typeof r.result.rows === "number" ? r.result.rows : want.rows,
      };
      this.appliedSize = set;
      if (r.result.changed !== true) {
        answer({ ...set, changed: false, seq: this.screen.seq });
        continue;
      }
      // the answer's seq is the first screen at the new size (magmux's forced keyframe)
      await waitUntil(
        () => this.isFinal || (this.screen.cols === set.cols && this.screen.rows === set.rows),
        RESIZE_SCREEN_MS
      );
      if (this.isFinal) {
        answer(this.lastSizeOutcome());
        continue;
      }
      answer({ ...set, changed: true, seq: this.screen.seq });
    }
  }

  /* ───────────────────────────── the end ───────────────────────────── */

  /** The replay ends here, once. The screen stops changing and the one reap starts. */
  private finish(why: ReplayReady): void {
    if (this.isFinal) return;
    this.isFinal = true;
    this.readyAnswer.resolve(why);
    try {
      this.o.onFinish?.();
    } catch {
      // an owner's callback must not stop the reap
    }
    this.reapPromise = this.reap();
  }

  private async reap(): Promise<void> {
    await Promise.resolve(); // let the step that finished the replay end first
    this.reaping = true;
    if (this.readyTicker) clearInterval(this.readyTicker);
    this.readyTicker = null;
    if (this.listTicker) clearInterval(this.listTicker);
    this.listTicker = null;
    await reapPaneProcesses(this.reapSubject);
  }

  private get reapSubject(): PaneReapSubject {
    const pane = this;
    return {
      paneId: this.paneId,
      root: this.root,
      identity: this.identity,
      get group() {
        return pane.group;
      },
      set group(g) {
        pane.group = g;
      },
      get reapFailed() {
        return pane.reapFailed;
      },
      set reapFailed(v) {
        pane.reapFailed = v;
      },
      panePid: () => this.panePidValue,
      adoptPanePid: (pid) => {
        this.panePidValue = pid;
      },
      client: () => this.conn,
      paneClosed: () => this.paneClosed,
      magmux: () => this.magmuxProc,
      watcher: () => this.watcherProc,
      files: () => ({
        paneId: this.paneId,
        sockPath: this.sockPath,
        launcherDir: this.ctlDir,
        turnDir: this.turnDir,
      }),
      fast: () => this.fastReap,
      // after the process is verified gone, never while a dying `claude` could rewrite the file
      onVerified: () => removeForkRecord(this.o.forkPath, this.o.removeProjectDir),
      onUnverified: () => {},
    };
  }
}

/**
 * Start one replay pane. Throws `MagmuxUnavailableError`, `PaneLimitError`, `PaneRootError` or a
 * plain error BEFORE anything is spawned; a failure after that ends the replay, and `ready`
 * answers `ended`. Installs the shutdown hooks (idempotent).
 */
export async function startReplayPane(o: ReplayPaneOptions): Promise<ReplayPane> {
  const magmux = await assertMagmuxAvailable(o.magmuxBinary);
  const root = ensureSockRoot(o.sockRoot ?? sockRootFor(o.parentEnv));
  await ensureSwept(root);
  if (!paneShutdownHooksInstalled()) installPaneShutdownHooks();
  if (o.refused?.()) throw new Error("the server is shutting down");
  // the record is written before the next await, so the pane is never uncounted
  reservePanes(1, root);
  takePaneReservation();

  let dirs: { ctlDir: string; turnDir: string } | null = null;
  let paneId: string;
  let sockPath: string;
  let env: Record<string, string>;
  try {
    paneId = mintPaneId("r", o.label);
    sockPath = sockPathOf(root, paneId);
    dirs = createLaunchDirs(root);
    const argv = buildReplayArgv(
      o.claudeSessionId,
      o.forkUuid,
      replaySettingsJson(readUserStatusLine(o.configDir))
    );
    writeLauncherFiles(
      dirs.ctlDir,
      replayLauncherScript(
        o.parentEnv.SHELL || "/bin/sh",
        o.cwd,
        { command: o.claudeBinary, prefixArgs: [] },
        argv
      )
    );
    env = buildReplayEnv({
      parentEnv: o.parentEnv,
      ctlDir: dirs.ctlDir,
      cols: o.size.cols,
      rows: o.size.rows,
      ...(o.configDir !== claudeConfigDir(o.parentEnv) ? { configDirOverride: o.configDir } : {}),
    });
    writeRecord(root, {
      paneId,
      ownerPid: process.pid,
      ownerStart: ownerStartOfSelf(),
      watcherPid: null,
      magmuxPid: null,
      panePid: null,
      sessionUuid: o.forkUuid,
      sockPath,
      launcherDir: dirs.ctlDir,
      turnDir: dirs.turnDir,
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    for (const d of dirs ? [dirs.ctlDir, dirs.turnDir] : [])
      if (isLaunchDirPath(root, d)) rmSync(d, { recursive: true, force: true });
    throw e;
  }
  const pane = new ReplayPane(o, {
    paneId,
    sockPath,
    root,
    ctlDir: dirs.ctlDir,
    turnDir: dirs.turnDir,
  });
  registerPane(pane);
  await pane.start({ magmuxBinary: magmux.binary, env, cwd: o.cwd });
  return pane;
}
