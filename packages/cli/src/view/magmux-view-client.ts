/**
 * The viewer's connection to one pane's read-only magmux view socket (`magmux-<pane>.view`).
 *
 * It reads the aggregate `snapshot` every magmux connection starts with, asks `capabilities` and
 * refuses the socket unless it answers `readOnly: true`, then watches pane 0 as frames and keeps
 * a screen model from them. It only ever reads: the read-only socket refuses input anyway, and no
 * method here sends any.
 *
 * Only a `.view` path is dialed, never a control socket. The dial is a plain connect with the
 * absolute path, no `chdir`: the MCP server publishes a `.view` path only after its own plain
 * dial of that path answered read-only, so a published path is one a plain dial reaches.
 */

import { MagmuxClient, type MagmuxReply } from "../pane/magmux-client.js";
import { type FrameMessage, type Screen, applyFrame, newScreen } from "./magmux-frame.js";

export const VIEW_SOCKET_SUFFIX = ".view";
export const DEFAULT_FPS = 15;
const SNAPSHOT_WAIT_MS = 2_000;
const REQUEST_MS = 2_000;
/** claudish's panes hold one pane, and it is pane 0 */
const PANE = 0;

/** Why the stream stopped: the pane closed, magmux shut down, or the connection dropped. */
export type ViewStreamEnd = "pane_closed" | "shutdown" | "disconnected";

export interface MagmuxViewListener {
  /** After every frame; `changed` names the rows to repaint, all of them on a keyframe. */
  frame(screen: Screen, changed: number[], keyframe: boolean): void;
  ended(why: ViewStreamEnd): void;
}

export class MagmuxViewRefused extends Error {}

type Dial = (path: string) => Promise<MagmuxClient>;

export interface MagmuxViewOpenOptions {
  fps?: number;
  dial?: Dial;
}

export class MagmuxViewClient {
  private screenModel: Screen = newScreen(0, 0);
  private watching = false;
  private ended = false;
  private sawShutdown = false;
  private listener: MagmuxViewListener | null = null;

  private constructor(
    private readonly client: MagmuxClient,
    private readonly fps: number
  ) {
    client.on("frame", (f: FrameMessage) => this.onFrame(f));
    client.on("pane_closed", (e: { pane?: unknown }) => {
      if (e?.pane === PANE) this.finish("pane_closed");
    });
    client.on("shutdown", () => {
      this.sawShutdown = true;
    });
    client.on("disconnected", () => this.finish(this.sawShutdown ? "shutdown" : "disconnected"));
  }

  /**
   * Dial a `.view` path and prove it read-only. Throws `MagmuxViewRefused` for a path that is not
   * a view socket, a socket that does not answer read-only, or one that lists no pane 0.
   */
  static async open(path: string, o: MagmuxViewOpenOptions = {}): Promise<MagmuxViewClient> {
    if (!path.endsWith(VIEW_SOCKET_SUFFIX))
      throw new MagmuxViewRefused("only a pane's read-only view socket is dialed");
    const dial = o.dial ?? ((p: string) => MagmuxClient.dial(p));
    const client = await dial(path);
    try {
      const panes = await firstSnapshot(client);
      const caps = await client.request<{ readOnly?: unknown }>(
        { type: "capabilities" },
        REQUEST_MS
      );
      if (!caps.ok) throw new MagmuxViewRefused(`capabilities: ${caps.code}: ${caps.error}`);
      if (caps.result.readOnly !== true)
        throw new MagmuxViewRefused("the socket does not answer read-only");
      if (!panes.includes(PANE)) throw new MagmuxViewRefused("the socket lists no session pane");
    } catch (e) {
      client.close();
      throw e;
    }
    return new MagmuxViewClient(client, o.fps ?? DEFAULT_FPS);
  }

  get screen(): Screen {
    return this.screenModel;
  }

  get isWatching(): boolean {
    return this.watching;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  setListener(listener: MagmuxViewListener): void {
    this.listener = listener;
  }

  /** Frames follow the reply, the first of them a keyframe. Idempotent. */
  async watch(): Promise<MagmuxReply> {
    if (this.watching || this.ended) return { ok: true, result: {} };
    // Set before the request: the reply and the first frame can arrive in one read, and the
    // frame is handled before this function resumes. That first frame is a keyframe by
    // construction and carries the geometry, so nothing is reset here.
    this.watching = true;
    const r = await this.client.request(
      { type: "watch", pane: PANE, mode: "frames", fps: this.fps },
      REQUEST_MS
    );
    if (!r.ok) this.watching = false;
    return r;
  }

  /** magmux keeps no framer for a pane nobody watches; frames that still arrive are dropped. */
  async unwatch(): Promise<void> {
    if (!this.watching || this.ended) return;
    this.watching = false;
    await this.client.request({ type: "unwatch", pane: PANE }, REQUEST_MS);
  }

  /** Ask for a keyframe now, for example after this terminal was cleared. */
  async resync(): Promise<void> {
    if (!this.watching || this.ended) return;
    await this.client.request({ type: "resync", pane: PANE }, REQUEST_MS);
  }

  close(): void {
    this.client.close();
  }

  private onFrame(f: FrameMessage): void {
    if (!this.watching || this.ended || f?.pane !== PANE) return;
    const changed = applyFrame(this.screenModel, f);
    this.listener?.frame(this.screenModel, changed, this.screenModel.cleared);
  }

  private finish(why: ViewStreamEnd): void {
    if (this.ended) return;
    this.ended = true;
    this.watching = false;
    this.client.close();
    this.listener?.ended(why);
  }
}

/** The pane ids of the aggregate `snapshot` that opens every magmux connection. */
function firstSnapshot(client: MagmuxClient): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new MagmuxViewRefused(`no snapshot in ${SNAPSHOT_WAIT_MS} ms`));
    }, SNAPSHOT_WAIT_MS);
    const onSnapshot = (e: { panes?: Array<{ pane?: unknown }> }): void => {
      if (!Array.isArray(e?.panes)) return;
      cleanup();
      resolve(e.panes.map((p) => p?.pane).filter((p): p is number => typeof p === "number"));
    };
    const onGone = (): void => {
      cleanup();
      reject(new MagmuxViewRefused("the view socket closed before its snapshot"));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      client.off("snapshot", onSnapshot);
      client.off("disconnected", onGone);
    };
    client.on("snapshot", onSnapshot);
    client.on("disconnected", onGone);
  });
}
