/**
 * `claudish view <target>`: one session's live screen in this terminal, read only.
 *
 * Three connections make it: the endpoint of the MCP server that owns the target (rows, and the
 * active-view claim), the pane's read-only magmux view socket (frames), and this terminal (the
 * painter and the keys). Only the holder of the view watches frames and sizes the pane; any other
 * viewer shows a band saying where the session is viewed, with frames unwatched.
 *
 * Keys are this viewer's own: Enter takes the view, q quits. No byte typed here reaches the
 * session: neither connection has an op that could carry one.
 */

import type { ViewHolder } from "../pane/contract.js";
import { readProcessTableAsync } from "../pane/process-identity.js";
import {
  ViewError,
  type ViewEvent,
  type ViewFrontEnd,
  type ViewItem,
  type ViewListResult,
  parseViewTarget,
} from "../pane/view-contract.js";
import { AnsiPainter, STATUS_ROWS, type StatusTone, type TermSize } from "./ansi-painter.js";
import {
  endpointOwnerAlive,
  endpointPathOf,
  listEndpoints,
  ownerOfEndpointName,
} from "./endpoints.js";
import { readHistory } from "./history.js";
import { type Screen, cellCols } from "./magmux-frame.js";
import {
  DEFAULT_FPS,
  MagmuxViewClient,
  MagmuxViewRefused,
  type ViewStreamEnd,
} from "./magmux-view-client.js";
import { ViewClient } from "./view-client.js";
import { isFinishedItem } from "./view-directory.js";

/** A viewer's claim lives 15 s on the server; this renews it well inside that. */
export const RENEW_EVERY_MS = 5_000;
/** How long the final screen and its verdict stay up before the viewer exits. */
export const VERDICT_MS = 2_000;
export const RESIZE_DEBOUNCE_MS = 100;
const VIEW_RETRY_MS = 500;

/** What a front end may ask of the viewer: user acts in the host, such as selecting its pane. */
export interface FrontEndHooks {
  take(): void;
}

/**
 * What this viewer tells the terminal it runs in, beyond painting. A plain terminal is told
 * nothing; other front ends report the item's state to their host.
 */
export interface FrontEnd {
  readonly name: ViewFrontEnd;
  report(state: { item: ViewItem | null; holding: boolean; ended: boolean }): void;
  /** called once the viewer follows its target */
  attach?(hooks: FrontEndHooks): void;
  close(): void | Promise<void>;
}

export const PLAIN_TERMINAL: FrontEnd = {
  name: "none",
  report() {},
  close() {},
};

/** The terminal, as the viewer uses it. */
export interface ViewerIo {
  write(s: string): void;
  term(): TermSize;
  /** returns the unsubscribe */
  onKeys(fn: (chunk: string) => void): () => void;
  onResize(fn: () => void): () => void;
}

export interface ViewerOptions {
  root: string;
  /** any of the six accepted spellings */
  target: string;
  /** do not take the view at start: Enter still takes it */
  passive?: boolean;
  fps?: number;
  io: ViewerIo;
  frontEnd?: FrontEnd;
  /** the hello's `term_program`; the server cuts and filters it into the holder label */
  termProgram?: string;
  /** dial only this endpoint (its path), as a placed viewer does */
  endpoint?: string;
  /** whether an endpoint's server may run; default the process table (tests replace it) */
  endpointAlive?: (endpoint: string) => boolean;
  /** a herdr viewer's `<socket hash>/<workspace_id>` */
  workspaceKey?: string;
  /** a placed herdr viewer's `<txn>.<attempt>` */
  placement?: string;
  renewMs?: number;
  verdictMs?: number;
  resizeDebounceMs?: number;
  openView?: (path: string, o: { fps: number }) => Promise<MagmuxViewClient>;
  /** the finished runs in the records; default `readHistory()` */
  history?: () => ViewItem[];
}

export interface ViewerOutcome {
  code: number;
  /** one line for the normal screen once the viewer is gone; empty after `q` */
  message: string;
}

/**
 * The prefixed form of a target: `s:<session_id>`, `t:<run_id>/<slot>` or `r:<replay_id>`.
 * Accepts those and the bare `<session_id>`, `<run_id>/<slot>` and `replay-<hex>`.
 */
export function normalizeViewTarget(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let prefixed: string;
  if (/^[str]:/.test(s)) prefixed = s;
  else if (/^replay-[0-9a-f]+$/i.test(s)) prefixed = `r:${s}`;
  else if (s.includes("/")) prefixed = `t:${s}`;
  else prefixed = `s:${s}`;
  return parseViewTarget(prefixed) ? prefixed : null;
}

export interface LocatedTarget {
  endpoint: string;
  item: ViewItem;
}

/** The live endpoint whose items contain `target`; `servers` counts the endpoints that answered. */
export async function locateTarget(
  root: string,
  target: string,
  only?: string,
  alive?: (endpoint: string) => boolean
): Promise<{ found: LocatedTarget | null; servers: number }> {
  const names = await liveEndpoints(root, only, alive);
  let servers = 0;
  let found: LocatedTarget | null = null;
  for (const name of names) {
    let client: ViewClient | null = null;
    try {
      client = await ViewClient.connect(endpointPathOf(root, name), {
        hello: { name: "claudish view", kind: "viewer" },
      });
      const { items } = await client.request<ViewListResult>("list", { include_finished: true });
      servers += 1;
      const item = items.find((i) => i.target === target);
      if (item && !found) found = { endpoint: name, item };
    } catch {
      // a server that refuses or does not answer lists nothing
    } finally {
      client?.close();
    }
  }
  return { found, servers };
}

/** The boot wait of a replay plus the joiner's extra: a slow boot answers within it. */
export const REPLAY_OPEN_MS = 25_000;

/** The endpoints whose servers may run (`only`: just that path). */
async function liveEndpoints(
  root: string,
  only?: string,
  alive?: (endpoint: string) => boolean
): Promise<string[]> {
  const table = alive ? null : await readProcessTableAsync();
  return listEndpoints(root).filter(
    (n) =>
      (alive ? alive(n) : endpointOwnerAlive(n, table)) &&
      (!only || endpointPathOf(root, n) === only)
  );
}

/** Where a finished target nobody lists is opened: the lowest-pid live server. */
async function lowestLiveEndpoint(
  root: string,
  only?: string,
  alive?: (endpoint: string) => boolean
): Promise<string | null> {
  const names = (await liveEndpoints(root, only, alive)).sort(
    (a, b) => (ownerOfEndpointName(a)?.pid ?? 0) - (ownerOfEndpointName(b)?.pid ?? 0)
  );
  return names[0] ?? null;
}

function stateOf(item: ViewItem): string {
  return item.kind === "replay" ? (item.final ? "FINISHED" : "REPLAY") : item.state;
}

function verdictOf(item: ViewItem): string {
  if (item.kind === "replay") return `${item.target} finished`;
  const why = item.reason ? ` (${item.reason})` : "";
  return `${item.target} ${item.state}${why}`;
}

export function bandText(view: ViewHolder | null): string {
  return view ? `viewing in ${view.label} — Enter to view here` : "Enter to view here";
}

export class Viewer {
  private readonly painter: AnsiPainter;
  private readonly frontEnd: FrontEnd;
  private readonly fps: number;
  private target = "";
  private item: ViewItem | null = null;
  private client: ViewClient | null = null;
  private view: MagmuxViewClient | null = null;
  private viewPath: string | null = null;
  private opening = false;
  private claimId: string | null = null;
  private claiming = false;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private ending = false;
  private finished = false;
  private streamNote = "";
  private readonly stops: Array<() => void> = [];
  private settle: ((o: ViewerOutcome) => void) | null = null;

  constructor(private readonly o: ViewerOptions) {
    this.painter = new AnsiPainter({ write: (s) => o.io.write(s), term: () => o.io.term() });
    this.frontEnd = o.frontEnd ?? PLAIN_TERMINAL;
    this.fps = o.fps ?? DEFAULT_FPS;
  }

  get holding(): boolean {
    return this.claimId !== null;
  }

  /** Leave now: the claim is released and the terminal restored before `run` resolves. */
  quit(): void {
    void this.finish({ code: 0, message: "" });
  }

  /** Resolves when the viewer is done and the terminal is back on its normal screen. */
  run(): Promise<ViewerOutcome> {
    return new Promise<ViewerOutcome>((resolve) => {
      this.settle = resolve;
      this.start().catch((e) =>
        this.finish({ code: 1, message: e instanceof Error ? e.message : String(e) })
      );
    });
  }

  private async start(): Promise<void> {
    const target = normalizeViewTarget(this.o.target);
    if (!target) {
      this.done({ code: 2, message: `not a session, team slot or replay: ${this.o.target}` });
      return;
    }
    this.target = target;
    const { found, servers } = await locateTarget(
      this.o.root,
      target,
      this.o.endpoint,
      this.o.endpointAlive
    );
    const isReplay = parseViewTarget(target)?.kind === "replay";
    if (servers === 0) {
      this.done({
        code: 1,
        message: "no claudish MCP server is running; open the session from Claude Code",
      });
      return;
    }
    if (isReplay && !found) {
      this.done({ code: 1, message: `no such replay: ${target}` });
      return;
    }
    const finished = !found || isFinishedItem(found.item);
    // a run no live server keeps any more is still in the records, which name its run path
    const recorded = found
      ? null
      : ((this.o.history ?? readHistory)().find((i) => i.target === target) ?? null);
    if (finished && (isReplay || this.o.passive)) {
      this.done({ code: 1, message: `${target} has finished` });
      return;
    }
    const endpoint =
      found?.endpoint ??
      (await lowestLiveEndpoint(this.o.root, this.o.endpoint, this.o.endpointAlive));
    if (!endpoint) {
      this.done({ code: 1, message: `no running claudish MCP server lists ${target}` });
      return;
    }
    let client = await this.connectTo(endpoint);
    if (finished) {
      // a finished session or slot: open its replay, or join the one some server already runs
      let opened: { client: ViewClient; target: string };
      try {
        opened = await this.openReplay(client, target, found?.item ?? recorded);
      } catch (e) {
        // nobody lists it and no server knows it: it is not a session at all
        const unknown =
          e instanceof ViewError && (e.code === "unknown_session" || e.code === "unknown_op");
        if (!found && !recorded && unknown) {
          this.done({ code: 1, message: `no running claudish MCP server lists ${target}` });
          return;
        }
        throw e;
      }
      client = opened.client;
      this.target = opened.target;
      const { items } = await client.request<ViewListResult>("list", { include_finished: true });
      const item = items.find((i) => i.target === this.target);
      if (!item) {
        client.close();
        this.done({ code: 1, message: `${this.target} has finished` });
        return;
      }
      this.item = item;
    } else {
      this.item = (found as LocatedTarget).item;
      if (isReplay) {
        // a running replay is joined on this connection, so it is not reaped while this viewer looks
        try {
          await this.joinReplay(client);
        } catch (e) {
          client.close();
          if (e instanceof ViewError && e.code === "unknown_session") {
            this.done({ code: 1, message: `${target} has finished` });
            return;
          }
          throw e;
        }
      }
    }
    this.client = client;
    client.on("event", (e) => this.onEvent(e));
    client.on("closed", (why) => {
      if (why === "server_gone") void this.finish({ code: 1, message: "claudish server ended" });
    });
    client.on("reconnected", () => void this.onReconnected());
    this.stops.push(this.o.io.onKeys((chunk) => this.onKeys(chunk)));
    this.stops.push(this.o.io.onResize(() => this.onResize()));
    await this.subscribe();
    this.frontEnd.attach?.({ take: () => void this.takeIfNotHolding() });
    if (this.o.passive) this.render();
    else await this.take();
  }

  private connectTo(endpoint: string): Promise<ViewClient> {
    return ViewClient.connect(endpointPathOf(this.o.root, endpoint), {
      reconnect: true,
      hello: {
        name: "claudish view",
        kind: "viewer",
        front_end: this.frontEnd.name,
        ...(this.o.termProgram ? { term_program: this.o.termProgram } : {}),
        ...(this.o.workspaceKey ? { workspace_key: this.o.workspaceKey } : {}),
        ...(this.o.placement ? { placement: this.o.placement } : {}),
      },
    });
  }

  /**
   * `replay.open` on this connection, so the hold is this viewer's. A replay owned by another
   * server answers `replay_elsewhere`: the viewer joins it on that server by its id.
   */
  private async openReplay(
    client: ViewClient,
    target: string,
    item: ViewItem | null
  ): Promise<{ client: ViewClient; target: string }> {
    const t = parseViewTarget(target);
    const args =
      t?.kind === "team_slot"
        ? {
            run_id: t.runId,
            slot: t.slot,
            ...(item?.kind === "team_slot" ? { path: item.run_path } : {}),
          }
        : { session_id: t?.kind === "session" ? t.sessionId : target };
    try {
      const r = await client.request<{ target: string }>("replay.open", args, REPLAY_OPEN_MS);
      return { client, target: r.target };
    } catch (e) {
      if (!(e instanceof ViewError) || e.code !== "replay_elsewhere" || !e.elsewhere) {
        client.close();
        throw e;
      }
      client.close();
      const there = await this.connectTo(e.elsewhere.endpoint);
      try {
        const r = await there.request<{ target: string }>(
          "replay.open",
          { replay_id: e.elsewhere.replay_id },
          REPLAY_OPEN_MS
        );
        return { client: there, target: r.target };
      } catch (e2) {
        there.close();
        throw e2;
      }
    }
  }

  /** `replay.open {replay_id}`: this connection's hold on a replay that is already running. */
  private async joinReplay(client: ViewClient): Promise<void> {
    const t = parseViewTarget(this.target);
    if (t?.kind !== "replay") return;
    await client.request("replay.open", { replay_id: t.replayId }, REPLAY_OPEN_MS);
  }

  private async takeIfNotHolding(): Promise<void> {
    if (!this.holding) await this.take();
  }

  private async subscribe(): Promise<void> {
    await this.client?.request("subscribe", { targets: [this.target], include_finished: true });
  }

  /* ───────────────────────────── the claim ───────────────────────────── */

  /** A user act: the latest one wins on the server. */
  private async take(): Promise<void> {
    if (!this.client || this.ending || this.claiming) return;
    this.claiming = true;
    try {
      const size = this.paneSize();
      const r = await this.client.request<{ granted: boolean; view: ViewHolder | null }>("claim", {
        target: this.target,
        cols: size.cols,
        rows: size.rows,
      });
      if (r.granted && r.view) this.claimId = r.view.claim_id;
      else this.claimId = null;
    } catch (e) {
      this.streamNote = `could not take the view: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      this.claiming = false;
    }
    this.holdingChanged();
  }

  private async renew(): Promise<void> {
    if (!this.client || !this.claimId || this.ending) return;
    try {
      const r = await this.client.request<{ view: ViewHolder | null }>("renew", {
        target: this.target,
      });
      if (r.view?.claim_id !== this.claimId) this.lose();
    } catch (e) {
      if (e instanceof ViewError && e.code === "view_not_held") this.lose();
    }
  }

  private lose(): void {
    if (!this.claimId) return;
    this.claimId = null;
    this.holdingChanged();
  }

  private holdingChanged(): void {
    if (this.ending) return;
    if (this.holding) {
      if (!this.renewTimer) {
        this.renewTimer = setInterval(() => void this.renew(), this.o.renewMs ?? RENEW_EVERY_MS);
      }
      void this.ensureWatch();
    } else {
      if (this.renewTimer) clearInterval(this.renewTimer);
      this.renewTimer = null;
      void this.view?.unwatch();
    }
    this.render();
  }

  /** The pane size this terminal can show whole: everything but the status row. */
  private paneSize(): TermSize {
    const t = this.o.io.term();
    return { cols: Math.max(1, t.cols), rows: Math.max(1, t.rows - STATUS_ROWS) };
  }

  /* ───────────────────────────── the frames ───────────────────────────── */

  private async ensureWatch(): Promise<void> {
    if (!this.holding || this.ending || this.opening) return;
    const path = this.item?.magmux?.view_socket ?? null;
    if (!path) {
      this.streamNote = "waiting for the pane's view socket";
      this.render();
      return;
    }
    if (this.view && !this.view.isEnded && this.viewPath === path) {
      await this.view.watch();
      return;
    }
    this.view?.close();
    this.view = null;
    this.opening = true;
    let opened: MagmuxViewClient;
    try {
      const open = this.o.openView ?? ((p, o) => MagmuxViewClient.open(p, o));
      opened = await open(path, { fps: this.fps });
    } catch (e) {
      this.opening = false;
      this.streamNote = `cannot open the pane's view: ${e instanceof Error ? e.message : String(e)}`;
      this.render();
      // a socket that is not read-only stays refused; one that could not be reached may come up
      if (!(e instanceof MagmuxViewRefused)) this.retryWatch();
      return;
    }
    this.opening = false;
    if (this.ending) {
      opened.close();
      return;
    }
    this.view = opened;
    this.viewPath = path;
    this.streamNote = "";
    opened.setListener({
      frame: (screen, changed, keyframe) => this.onFrame(screen, changed, keyframe),
      ended: (why) => this.onStreamEnded(opened, why),
    });
    if (this.holding) await opened.watch();
  }

  private retryWatch(): void {
    if (this.retryTimer || this.ending) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.ensureWatch();
    }, VIEW_RETRY_MS);
  }

  private onFrame(screen: Screen, changed: number[], keyframe: boolean): void {
    if (!this.holding || this.ending) return;
    if (keyframe) {
      this.painter.size(screen.rows, screen.cols);
      this.painter.clear();
    }
    for (const y of changed) {
      const line = screen.lines[y];
      if (line) this.painter.row(y, line, cellCols(line));
    }
    this.painter.cursor(screen.cur);
    this.paintStatus();
  }

  private onStreamEnded(client: MagmuxViewClient, why: ViewStreamEnd): void {
    if (this.view !== client) return;
    this.view = null;
    this.viewPath = null;
    if (this.ending) return;
    if (why === "disconnected") {
      // the pane's magmux may come back on the same path; the endpoint says when it is gone
      this.streamNote = "the pane's view socket closed; reconnecting";
      this.retryWatch();
    } else {
      this.streamNote = why === "pane_closed" ? "the pane closed" : "the pane's magmux shut down";
    }
    this.render();
  }

  /* ───────────────────────────── the endpoint ───────────────────────────── */

  private onEvent(e: ViewEvent): void {
    if (this.ending) return;
    switch (e.event) {
      case "snapshot": {
        const item = e.items.find((i) => i.target === this.target) ?? null;
        if (!item) {
          void this.end(`${this.target} is no longer listed`);
          return;
        }
        this.onItem(item);
        return;
      }
      case "item.upsert":
        if (e.item.target === this.target) this.onItem(e.item);
        return;
      case "item.remove":
        if (e.target === this.target) void this.end(`${this.target} is no longer listed`);
        return;
      case "server.closing":
        void this.finish({ code: 1, message: "claudish server ended" });
        return;
    }
  }

  private onItem(item: ViewItem): void {
    const pathBefore = this.item?.magmux?.view_socket ?? null;
    this.item = item;
    if (isFinishedItem(item)) {
      void this.end(verdictOf(item));
      return;
    }
    // while a claim is on its way, the row may already carry its grant: the reply decides
    if (!this.claiming && this.claimId && item.view?.claim_id !== this.claimId) {
      this.lose();
      return;
    }
    if (this.holding && (item.magmux?.view_socket ?? null) !== pathBefore) void this.ensureWatch();
    this.frontEnd.report({ item, holding: this.holding, ended: false });
    if (!this.holding) this.render();
    else this.paintStatus();
  }

  private async onReconnected(): Promise<void> {
    if (this.ending) return;
    // the server released this connection's claim when it dropped; a held view is taken again
    const held = this.holding;
    this.claimId = null;
    // the dropped connection's hold went with it. A replay that is gone ends through the new
    // subscription's snapshot, which no longer lists it: a remove sent while the connection was
    // down never reaches this one
    if (this.client) await this.joinReplay(this.client).catch(() => {});
    await this.subscribe().catch(() => {});
    if (held) await this.take();
    else this.holdingChanged();
  }

  /* ───────────────────────────── the terminal ───────────────────────────── */

  private onKeys(chunk: string): void {
    for (const ch of chunk) {
      if (ch === "q" || ch === "Q" || ch === "\x03") {
        void this.finish({ code: 0, message: "" });
        return;
      }
      if ((ch === "\r" || ch === "\n") && !this.holding) void this.take();
    }
  }

  private onResize(): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      void this.applyResize();
    }, this.o.resizeDebounceMs ?? RESIZE_DEBOUNCE_MS);
  }

  private async applyResize(): Promise<void> {
    if (this.ending) return;
    this.render();
    if (!this.holding || !this.client) return;
    const size = this.paneSize();
    try {
      await this.client.request("resize", {
        target: this.target,
        cols: size.cols,
        rows: size.rows,
      });
    } catch (e) {
      if (e instanceof ViewError && e.code === "view_not_held") this.lose();
    }
  }

  /** Paint what this viewer shows now: the picture for the holder, the band for anyone else. */
  private render(): void {
    if (this.finished) return;
    if (!this.holding) {
      this.painter.band(bandText(this.item?.view ?? null));
      this.paintStatus();
      return;
    }
    const screen = this.view?.isWatching ? this.view.screen : null;
    if (screen && screen.frames > 0) this.painter.repaint(screen);
    this.paintStatus();
  }

  /** The status row, most important first: a narrow terminal cuts it from the right. */
  private paintStatus(tone?: StatusTone, verdict?: string): void {
    const screen = this.shownScreen();
    const head = verdict
      ? [verdict]
      : [this.target, this.streamNote, this.item ? stateOf(this.item) : ""];
    const bits = [...head, this.item?.model ?? "", ...this.geometryBits(screen)];
    if (!verdict) bits.push(this.holding ? "q quit" : "Enter view · q quit");
    const live = screen !== null && !this.streamNote;
    this.painter.status(bits.filter(Boolean).join(" · "), tone ?? (live ? "live" : "waiting"));
  }

  /** The screen on display: only the holder's, and only once a frame has arrived. */
  private shownScreen(): Screen | null {
    const screen = this.holding && this.view?.isWatching ? this.view.screen : null;
    return screen && screen.frames > 0 ? screen : null;
  }

  private geometryBits(screen: Screen | null): string[] {
    if (!screen) return [];
    const bits = [`${screen.cols}x${screen.rows}`];
    if (this.painter.clipped()) {
      const t = this.o.io.term();
      bits.push(`CLIPPED to ${t.cols}x${Math.max(0, t.rows - STATUS_ROWS)}`);
    }
    return bits;
  }

  /* ───────────────────────────── the end ───────────────────────────── */

  /** The final screen stays up with its verdict, then the viewer exits. */
  private async end(verdict: string): Promise<void> {
    if (this.ending) return;
    this.ending = true;
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
    this.frontEnd.report({ item: this.item, holding: this.holding, ended: true });
    this.paintStatus("ended", verdict);
    this.painter.flush();
    await Bun.sleep(this.o.verdictMs ?? VERDICT_MS);
    await this.finish({ code: 0, message: verdict });
  }

  private async finish(outcome: ViewerOutcome): Promise<void> {
    if (this.finished) return;
    this.ending = true;
    this.finished = true;
    for (const t of [this.resizeTimer, this.retryTimer]) if (t) clearTimeout(t);
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
    for (const stop of this.stops.splice(0)) stop();
    const client = this.client;
    if (client && this.claimId) {
      this.claimId = null;
      await client.request("release", { target: this.target }).catch(() => {});
    }
    const view = this.view;
    this.view = null;
    if (view) {
      await view.unwatch().catch(() => {});
      view.close();
    }
    client?.close();
    await this.frontEnd.close();
    this.painter.end();
    this.done(outcome);
  }

  private done(outcome: ViewerOutcome): void {
    this.finished = true;
    const settle = this.settle;
    this.settle = null;
    settle?.(outcome);
  }
}
