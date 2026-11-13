/**
 * This server's links to the servers that own replays its Claude Code joined: one connection per
 * owner endpoint, `hello {kind:"peer"}`, one subscription per joined replay, and the relayed
 * replay verbs. A link that ends (the owner's `item.remove`, its `server.closing`, EOF) tells
 * each joined replay once; the replay manager turns that into a finished remote entry.
 */

import type { CaptureResult, CaptureUnchanged, ReplayCloseResult } from "../pane/contract.js";
import type { ViewHolder } from "../pane/contract.js";
import type { ScrollRequest, ScrollResult } from "../pane/index.js";
import {
  type ViewClaimResult,
  ViewError,
  type ViewEvent,
  type ViewMagmux,
  targetOfReplay,
} from "../pane/view-contract.js";
import { endpointPathOf } from "./endpoints.js";
import { ViewClient } from "./view-client.js";

/** `replay.close` waits for the owner's reap and registry removal. */
export const PEER_CLOSE_MS = 30_000;

export interface ReplayOpenWire {
  replay_id: string;
  target: string;
  seq: number;
  magmux: ViewMagmux | null;
  view: ViewHolder | null;
}

/** Why a joined replay stopped being served by its owner. */
export type PeerEnd = "closed" | "server_closing" | "server_gone";

export interface PeerLinksOptions {
  root: string;
  /** this server's endpoint name; a peer hello must name it */
  self: () => string | null;
  /** tests replace the dial */
  connect?: (path: string, hello: Record<string, unknown>) => Promise<ViewClient>;
}

export class PeerLink {
  private readonly follows = new Map<
    string,
    { sub: number | null; onEnd: (why: PeerEnd) => void }
  >();
  private ended = false;

  constructor(
    readonly endpoint: string,
    private readonly client: ViewClient,
    private readonly gone: () => void
  ) {
    client.on("event", (e) => this.onEvent(e));
    client.on("closed", () => this.end("server_gone"));
  }

  get isOpen(): boolean {
    return !this.ended;
  }

  open(replayId: string, timeoutMs: number): Promise<ReplayOpenWire> {
    return this.client.request<ReplayOpenWire>("replay.open", { replay_id: replayId }, timeoutMs);
  }

  capture(
    replayId: string,
    sinceSeq: number | undefined,
    spans: boolean
  ): Promise<CaptureResult | CaptureUnchanged> {
    return this.client.request("capture", {
      target: targetOfReplay(replayId),
      ...(sinceSeq === undefined ? {} : { since_seq: sinceSeq }),
      spans,
    });
  }

  /** This server's Claude Code resizes the replay, which takes the view on the owner. */
  resize(replayId: string, cols: number, rows: number): Promise<ViewClaimResult> {
    return this.client.request("replay.resize", { replay_id: replayId, cols, rows }, 15_000);
  }

  scroll(replayId: string, req: ScrollRequest): Promise<ScrollResult> {
    const how = "by" in req ? { by: req.by } : { to: "bottom" };
    return this.client.request("replay.scroll", { replay_id: replayId, ...how }, 10_000);
  }

  close(replayId: string, timeoutMs = PEER_CLOSE_MS): Promise<ReplayCloseResult> {
    return this.client.request("replay.close", { replay_id: replayId }, timeoutMs);
  }

  release(replayId: string): Promise<{ closed: boolean }> {
    return this.client.request("replay.release", { replay_id: replayId });
  }

  /** Subscribe to the replay's target on the owner; `onEnd` fires once, when it stops. */
  async follow(replayId: string, onEnd: (why: PeerEnd) => void): Promise<void> {
    const target = targetOfReplay(replayId);
    if (this.ended) {
      onEnd("server_gone");
      return;
    }
    const f = { sub: null as number | null, onEnd };
    this.follows.set(target, f);
    try {
      const r = await this.client.request<{ sub: number }>("subscribe", {
        targets: [target],
        include_finished: true,
      });
      f.sub = r.sub;
    } catch {
      this.fire(target, "server_gone");
    }
  }

  /** Stop following without being told. The connection stays for the other joined replays. */
  unfollow(replayId: string): void {
    const target = targetOfReplay(replayId);
    const f = this.follows.get(target);
    this.follows.delete(target);
    if (f?.sub != null) void this.client.request("unsubscribe", { sub: f.sub }).catch(() => {});
  }

  /** Drop the connection: the owner releases this server's holds and claims on it. */
  disconnect(): void {
    this.client.close();
    this.end("server_gone");
  }

  private onEvent(e: ViewEvent): void {
    if (e.event === "server.closing") {
      for (const target of [...this.follows.keys()]) this.fire(target, "server_closing");
      return;
    }
    if (e.event === "item.remove") this.fire(e.target, "closed");
  }

  private fire(target: string, why: PeerEnd): void {
    const f = this.follows.get(target);
    if (!f) return;
    this.follows.delete(target);
    try {
      f.onEnd(why);
    } catch {
      // a listener must not stop the others
    }
  }

  private end(why: PeerEnd): void {
    if (this.ended) return;
    this.ended = true;
    for (const target of [...this.follows.keys()]) this.fire(target, why);
    this.gone();
  }
}

export class PeerLinks {
  private readonly links = new Map<string, Promise<PeerLink>>();

  constructor(private readonly o: PeerLinksOptions) {}

  /** The open link to `endpoint`, dialed once and shared by every replay joined there. */
  async link(endpoint: string): Promise<PeerLink> {
    const cached = this.links.get(endpoint);
    if (cached) {
      const l = await cached.catch(() => null);
      if (l?.isOpen) return l;
      if (this.links.get(endpoint) === cached) this.links.delete(endpoint);
    }
    const self = this.o.self();
    if (!self) throw new ViewError("forbidden", "this server has no endpoint to name as a peer");
    const hello = { name: "claudish peer", kind: "peer", endpoint: self };
    const path = endpointPathOf(this.o.root, endpoint);
    const made = (async () => {
      const client = this.o.connect
        ? await this.o.connect(path, hello)
        : await ViewClient.connect(path, { hello: hello as never });
      const link: PeerLink = new PeerLink(endpoint, client, () => {
        if (this.links.get(endpoint) === made) this.links.delete(endpoint);
      });
      return link;
    })();
    this.links.set(endpoint, made);
    try {
      return await made;
    } catch (e) {
      if (this.links.get(endpoint) === made) this.links.delete(endpoint);
      throw e;
    }
  }

  closeAll(): void {
    for (const l of this.links.values()) void l.then((x) => x.disconnect()).catch(() => {});
    this.links.clear();
  }
}
