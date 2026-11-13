/**
 * The local view transport: one owner-only unix socket per MCP server, JSON Lines. It reads the
 * owners through `ViewDirectory` and pushes rows from `ViewFeed`. It logs op names and target ids
 * only, because rows and screens are the user's.
 *
 * A viewer only watches: no op lets it hold the view or size a pane. The one claim on this socket
 * is a peer server's `replay.resize`, relaying its own Claude Code's resize of a shared replay.
 * Nothing here can reach a child's input: no op sends text, cancels, scrolls or starts anything.
 */

import type { Socket } from "node:net";
import { log } from "../logger.js";
import {
  CAPABILITIES,
  CONTRACT_VERSION,
  ContractErrorException,
  type ReplayTarget,
  type ScrollRequest,
} from "../pane/index.js";
import { readProcessTableAsync } from "../pane/process-identity.js";
import {
  VIEW_PROTOCOL,
  type ViewClientKind,
  ViewError,
  type ViewErrorBody,
  type ViewFrontEnd,
  type ViewItem,
  type ViewRemoveReason,
  targetOfReplay,
} from "../pane/view-contract.js";
import { redactSecrets } from "../redact.js";
import { type BoundEndpoint, bindEndpoint, endpointOwnerAlive } from "./endpoints.js";
import type { ClaimCaller, ViewClaims } from "./view-claims.js";
import { type ViewDirectory, isFinishedItem } from "./view-directory.js";
import type { ViewFeed, ViewFeedEvent } from "./view-feed.js";

export const MAX_CONNECTIONS = 64;
export const MAX_INBOUND_LINE_BYTES = 64 * 1024;
export const MAX_OUTBOUND_QUEUE_BYTES = 4 * 1024 * 1024;

/** Verbs of the MCP surface that change a session. Named here so they are refused, not unknown. */
const MUTATORS: ReadonlySet<string> = new Set([
  "send_input",
  "cancel",
  "cancel_session",
  "scroll",
  "scroll_session",
  "create_session",
  "team",
  "run_prompt",
  "close_replay",
]);
const PEER_ONLY_OPS: ReadonlySet<string> = new Set([
  "replay.scroll",
  "replay.close",
  "replay.resize",
]);

const CLIENT_KINDS: ReadonlySet<string> = new Set(["viewer", "relay", "peer"]);
const FRONT_ENDS: ReadonlySet<string> = new Set(["herdr", "herdr-core", "none"]);

interface Subscription {
  id: number;
  targets: Set<string> | null;
  includeFinished: boolean;
  /** the items of this subscription the client currently shows */
  visible: Set<string>;
}

interface Connection {
  id: string;
  sock: Socket;
  role: ViewClientKind;
  greeted: boolean;
  subs: Map<number, Subscription>;
  inbound: string;
  outbound: string[];
  outboundBytes: number;
  blocked: boolean;
  seq: number;
  closed: boolean;
}

/** The replay side of the transport: `ReplayManager`. */
export interface ViewReplayOps {
  openForViewer(target: ReplayTarget, connId: string): Promise<unknown>;
  join(
    replayId: string,
    opener: { kind: "conn"; connId: string; role: "viewer" | "peer" }
  ): Promise<unknown>;
  release(replayId: string, connId: string): Promise<{ closed: boolean }>;
  scroll(replayId: string, req: ScrollRequest, caller: ClaimCaller): Promise<unknown>;
  closeBy(
    replayId: string,
    closer: { kind: "conn"; connId: string; role: "viewer" | "peer" }
  ): Promise<unknown>;
  connectionGone(connId: string): void;
}

/** What a viewer's `replay.open {session_id}` or `{run_id, slot, path}` opens. */
export type ReplayTargetResolver = (
  of: { session_id: string } | { run_id: string; slot: string; path?: string }
) => ReplayTarget;

export interface ViewServerOptions {
  root: string;
  replays?: ViewReplayOps;
  resolveReplayTarget?: ReplayTargetResolver;
  /** tests run two servers in one process: the endpoint name, and the peer gate's liveness */
  endpointName?: string;
  peerAlive?: (endpoint: string) => boolean;
  directory: ViewDirectory;
  claims: ViewClaims;
  feed: ViewFeed;
  version: string;
  /** what `hello` answers as this server's front end */
  frontEnd?: ViewFrontEnd;
}

const REPLAY_ID = /^replay-[0-9a-f]{16}$/;

function replayIdArg(args: Record<string, unknown>): string {
  const id = stringArg(args, "replay_id");
  if (!REPLAY_ID.test(id)) throw new ViewError("invalid_args", "'replay_id' is not a replay id");
  return id;
}

/** What a handler answers, and what to send once the reply is on its way. */
interface Handled {
  result: unknown;
  after?: () => void;
}

function asObject(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== "string" || !v)
    throw new ViewError("invalid_args", `'${name}' must be a non-empty string`);
  return v;
}

function integerArg(args: Record<string, unknown>, name: string): number {
  const v = args[name];
  if (typeof v !== "number" || !Number.isInteger(v))
    throw new ViewError("invalid_args", `'${name}' must be an integer`);
  return v;
}

function optionalInteger(args: Record<string, unknown>, name: string): number | undefined {
  return args[name] === undefined ? undefined : integerArg(args, name);
}

function errorBody(e: unknown): ViewErrorBody {
  if (e instanceof ViewError)
    return {
      code: e.code,
      message: redactSecrets(e.message),
      ...(e.reason ? { reason: e.reason } : {}),
      ...(e.elsewhere ? e.elsewhere : {}),
    };
  if (e instanceof ContractErrorException)
    return {
      code: e.code,
      message: redactSecrets(e.message),
      ...(e.reason ? { reason: e.reason } : {}),
    };
  return {
    code: "invalid_args",
    message: redactSecrets(e instanceof Error ? e.message : String(e)),
  };
}

export class ViewServer {
  private readonly connections = new Set<Connection>();
  private endpoint: BoundEndpoint | null = null;
  private unsubscribe: (() => void) | null = null;
  private nextConn = 1;
  private nextSub = 1;
  private closing = false;
  private readonly startedAt = new Date().toISOString();

  private constructor(private readonly o: ViewServerOptions) {}

  /** Null when the transport is off for this process; sessions never depend on it. */
  static async start(o: ViewServerOptions): Promise<ViewServer | null> {
    const server = new ViewServer(o);
    const bound = await bindEndpoint(o.root, (sock) => server.accept(sock), o.endpointName);
    if (!bound) return null;
    server.endpoint = bound;
    return server;
  }

  get endpointName(): string {
    return this.endpoint?.name ?? "";
  }

  get endpointPath(): string {
    return this.endpoint?.path ?? "";
  }

  /** Tell every client the server is going, while the socket can still answer a last capture. */
  announceClosing(): void {
    if (this.closing) return;
    this.closing = true;
    for (const c of this.connections) this.sendEvent(c, 0, { event: "server.closing" });
  }

  /** Close the transport and remove the endpoint; the last step of a shutdown. */
  close(): void {
    this.closing = true;
    for (const c of [...this.connections]) c.sock.destroy();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.endpoint?.close();
    this.endpoint = null;
  }

  private accept(sock: Socket): void {
    sock.setEncoding("utf8");
    if (this.connections.size >= MAX_CONNECTIONS) {
      sock.on("error", () => {});
      const body: ViewErrorBody = {
        code: "too_many_connections",
        message: `this server already has ${MAX_CONNECTIONS} clients`,
      };
      sock.end(`${JSON.stringify({ id: 0, ok: false, error: body })}\n`);
      return;
    }
    const conn: Connection = {
      id: `conn-${this.nextConn++}`,
      sock,
      role: "viewer",
      greeted: false,
      subs: new Map(),
      inbound: "",
      outbound: [],
      outboundBytes: 0,
      blocked: false,
      seq: 0,
      closed: false,
    };
    this.connections.add(conn);
    sock.on("data", (chunk: string) => this.onData(conn, chunk));
    sock.on("drain", () => {
      conn.blocked = false;
      this.pump(conn);
    });
    sock.on("error", () => {});
    sock.on("close", () => this.onClose(conn));
  }

  private onClose(conn: Connection): void {
    if (conn.closed) return;
    conn.closed = true;
    this.connections.delete(conn);
    conn.outbound = [];
    conn.outboundBytes = 0;
    this.o.claims.releaseConnection(conn.id);
    this.o.replays?.connectionGone(conn.id);
    this.followFeed();
  }

  /** The feed builds rows only for a listener, so this server listens only while a client does. */
  private followFeed(): void {
    const wanted = [...this.connections].some((c) => c.subs.size > 0);
    if (wanted && !this.unsubscribe) {
      this.unsubscribe = this.o.feed.subscribe((e) => this.publish(e));
    } else if (!wanted && this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  private onData(conn: Connection, chunk: string): void {
    conn.inbound += chunk;
    let nl = conn.inbound.indexOf("\n");
    while (nl >= 0) {
      const line = conn.inbound.slice(0, nl);
      conn.inbound = conn.inbound.slice(nl + 1);
      nl = conn.inbound.indexOf("\n");
      if (Buffer.byteLength(line) > MAX_INBOUND_LINE_BYTES) {
        this.refuseLine(conn);
        return;
      }
      if (line.trim()) void this.onLine(conn, line);
      if (conn.closed) return;
    }
    if (conn.inbound.length > MAX_INBOUND_LINE_BYTES) this.refuseLine(conn);
  }

  private refuseLine(conn: Connection): void {
    conn.inbound = "";
    this.send(conn, {
      id: 0,
      ok: false,
      error: { code: "line_too_long", message: "a request line is limited to 64 KiB" },
    });
    conn.sock.end();
  }

  private async onLine(conn: Connection, line: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = asObject(JSON.parse(line));
    } catch {
      this.send(conn, {
        id: 0,
        ok: false,
        error: { code: "invalid_args", message: "not a JSON object" },
      });
      return;
    }
    const id = typeof msg.id === "number" ? msg.id : 0;
    const op = typeof msg.op === "string" ? msg.op : "";
    let handled: Handled;
    try {
      handled = await this.dispatch(conn, op, asObject(msg.args));
    } catch (e) {
      const error = errorBody(e);
      log(`[view] ${conn.id} ${op}: ${error.code}`);
      this.send(conn, { id, ok: false, error });
      return;
    }
    this.send(conn, { id, ok: true, result: handled.result });
    handled.after?.();
  }

  private dispatch(
    conn: Connection,
    op: string,
    args: Record<string, unknown>
  ): Handled | Promise<Handled> {
    if (MUTATORS.has(op)) throw new ViewError("forbidden", `'${op}' is not available here`);
    if (PEER_ONLY_OPS.has(op) && conn.role !== "peer")
      throw new ViewError("forbidden", `'${op}' is for peer servers`);
    switch (op) {
      case "replay.open":
        return this.replayOpen(conn, args);
      case "replay.release":
        return this.replayRelease(conn, args);
      case "replay.scroll":
        return this.replayScroll(conn, args);
      case "replay.close":
        return this.replayClose(conn, args);
      case "replay.resize":
        return this.replayResize(conn, args);
      case "hello":
        return this.hello(conn, args);
      case "list":
        return { result: { items: this.o.directory.items(args.include_finished === true) } };
      case "subscribe":
        return this.subscribe(conn, args);
      case "unsubscribe":
        conn.subs.delete(integerArg(args, "sub"));
        this.followFeed();
        return { result: {} };
      case "capture":
        return {
          result: this.o.directory.capture(
            stringArg(args, "target"),
            optionalInteger(args, "since_seq"),
            args.spans === true,
            this.callerOf(conn)
          ),
        };
      case "transcript":
        return {
          result: this.o.directory.transcript(
            stringArg(args, "target"),
            args.since === undefined ? undefined : stringArg(args, "since")
          ),
        };
      default:
        throw new ViewError("unknown_op", `unknown op ${JSON.stringify(op)}`);
    }
  }

  private async hello(conn: Connection, args: Record<string, unknown>): Promise<Handled> {
    if (conn.greeted) throw new ViewError("invalid_args", "this connection already said hello");
    const client = asObject(args.client);
    const kind = client.kind ?? "viewer";
    if (typeof kind !== "string" || !CLIENT_KINDS.has(kind))
      throw new ViewError("invalid_args", `unknown client kind ${JSON.stringify(kind)}`);
    const frontEnd = client.front_end;
    if (frontEnd !== undefined && (typeof frontEnd !== "string" || !FRONT_ENDS.has(frontEnd)))
      throw new ViewError("forbidden", `unknown front end ${JSON.stringify(frontEnd)}`);
    if (kind === "peer") {
      // a correctness gate: the boundary is the uid and the 0700 root
      const named = client.endpoint;
      const alive =
        typeof named === "string" &&
        (this.o.peerAlive
          ? this.o.peerAlive(named)
          : endpointOwnerAlive(named, await readProcessTableAsync()));
      if (typeof named !== "string" || named === this.endpointName || !alive)
        throw new ViewError("forbidden", "a peer must name another live server's endpoint");
    }
    conn.role = kind as ViewClientKind;
    conn.greeted = true;
    return {
      result: {
        protocol: VIEW_PROTOCOL,
        server: {
          pid: process.pid,
          version: this.o.version,
          started_at: this.startedAt,
          endpoint: this.endpointName,
          front_end: this.o.frontEnd ?? "none",
        },
        contract_version: CONTRACT_VERSION,
        capabilities: [...CAPABILITIES],
      },
    };
  }

  private subscribe(conn: Connection, args: Record<string, unknown>): Handled {
    const targets = Array.isArray(args.targets)
      ? new Set(args.targets.filter((t): t is string => typeof t === "string"))
      : null;
    const sub: Subscription = {
      id: this.nextSub++,
      targets,
      includeFinished: args.include_finished === true,
      visible: new Set(),
    };
    conn.subs.set(sub.id, sub);
    this.followFeed();
    return {
      result: { sub: sub.id },
      after: () => {
        const items = this.o.directory
          .items(sub.includeFinished)
          .filter((i) => !sub.targets || sub.targets.has(i.target));
        for (const item of items) sub.visible.add(item.target);
        this.o.feed.noteDelivered(items);
        this.sendEvent(conn, sub.id, { event: "snapshot", items });
      },
    };
  }

  private callerOf(conn: Connection): ClaimCaller {
    return {
      kind: "conn",
      connId: conn.id,
      role: conn.role === "peer" ? "peer" : "viewer",
    };
  }

  /* ───────────────────────────── replays ───────────────────────────── */

  private replayOps(): ViewReplayOps {
    if (!this.o.replays) throw new ViewError("unknown_op", "this server opens no replays");
    return this.o.replays;
  }

  private replayOpener(conn: Connection): {
    kind: "conn";
    connId: string;
    role: "viewer" | "peer";
  } {
    if (conn.role === "relay") throw new ViewError("forbidden", "a relay opens no replay");
    return { kind: "conn", connId: conn.id, role: conn.role };
  }

  /**
   * A join of a live replay by id (viewer or peer), or a viewer's open
   * of a finished session or slot. A replay owned elsewhere answers `replay_elsewhere`.
   */
  private async replayOpen(conn: Connection, args: Record<string, unknown>): Promise<Handled> {
    try {
      return await this.replayOpenOn(conn, args);
    } finally {
      // the connection closed while the open waited for the boot: what the open added on its
      // behalf (a hold) is released now, as the close would have
      if (conn.closed) this.o.replays?.connectionGone(conn.id);
    }
  }

  private async replayOpenOn(conn: Connection, args: Record<string, unknown>): Promise<Handled> {
    const ops = this.replayOps();
    const opener = this.replayOpener(conn);
    if (args.replay_id !== undefined) {
      return { result: await ops.join(replayIdArg(args), opener) };
    }
    if (opener.role === "peer")
      throw new ViewError("invalid_args", "a peer joins a replay by its replay_id");
    const resolve = this.o.resolveReplayTarget;
    if (!resolve) throw new ViewError("unknown_op", "this server opens no replays");
    const of =
      args.session_id !== undefined
        ? { session_id: stringArg(args, "session_id") }
        : {
            run_id: stringArg(args, "run_id"),
            slot: stringArg(args, "slot"),
            ...(args.path === undefined ? {} : { path: stringArg(args, "path") }),
          };
    return { result: await ops.openForViewer(resolve(of), conn.id) };
  }

  private async replayRelease(conn: Connection, args: Record<string, unknown>): Promise<Handled> {
    const ops = this.replayOps();
    this.replayOpener(conn);
    return { result: await ops.release(replayIdArg(args), conn.id) };
  }

  /** `scroll` is input bytes to the child, so only a peer relaying its own Claude Code sends it. */
  private async replayScroll(conn: Connection, args: Record<string, unknown>): Promise<Handled> {
    const ops = this.replayOps();
    const id = replayIdArg(args);
    let req: ScrollRequest;
    if (args.by !== undefined) {
      const by = integerArg(args, "by");
      if (by === 0 || args.to !== undefined)
        throw new ViewError("invalid_args", "give exactly one of 'by' (non-zero) and 'to'");
      req = { by };
    } else if (args.to === "bottom" || args.to === "end") req = { to: "end" };
    else throw new ViewError("invalid_args", "one of 'by' and 'to' is required");
    return { result: await ops.scroll(id, req, this.callerOf(conn)) };
  }

  /** A joined server's `close_replay`, answered only after the reap and the registry removal. */
  private async replayClose(conn: Connection, args: Record<string, unknown>): Promise<Handled> {
    const ops = this.replayOps();
    return { result: await ops.closeBy(replayIdArg(args), this.replayOpener(conn)) };
  }

  /** A joined server's `resize_session` of a shared replay: its Claude Code takes the view. */
  private async replayResize(conn: Connection, args: Record<string, unknown>): Promise<Handled> {
    const target = targetOfReplay(replayIdArg(args));
    const cols = integerArg(args, "cols");
    const rows = integerArg(args, "rows");
    const caller = this.callerOf(conn);
    const resize = await this.o.directory.resize(target, cols, rows, caller);
    return {
      result: {
        granted: this.o.claims.holds(target, caller),
        view: this.o.claims.viewFor(target, caller),
        resize,
      },
    };
  }

  private publish(e: ViewFeedEvent): void {
    for (const conn of this.connections) {
      for (const sub of conn.subs.values()) {
        if (e.event === "upsert") this.deliverUpsert(conn, sub, e.item);
        else this.deliverRemove(conn, sub, e.target, e.reason);
      }
    }
  }

  private deliverUpsert(conn: Connection, sub: Subscription, item: ViewItem): void {
    if (sub.targets && !sub.targets.has(item.target)) return;
    if (isFinishedItem(item) && !sub.includeFinished) {
      // the client sees the end of an item it was showing, and hears nothing after that
      if (!sub.visible.delete(item.target)) return;
    } else {
      sub.visible.add(item.target);
    }
    this.sendEvent(conn, sub.id, { event: "item.upsert", item });
  }

  private deliverRemove(
    conn: Connection,
    sub: Subscription,
    target: string,
    reason: ViewRemoveReason
  ): void {
    if (sub.targets && !sub.targets.has(target)) return;
    if (!sub.visible.delete(target) && !sub.includeFinished) return;
    this.sendEvent(conn, sub.id, { event: "item.remove", target, reason });
  }

  private sendEvent(conn: Connection, sub: number, body: Record<string, unknown>): void {
    conn.seq += 1;
    this.send(conn, { type: "event", sub, seq: conn.seq, ...body });
  }

  /** Lossless, or the connection is dropped: a reconnect gets a fresh snapshot. */
  private send(conn: Connection, message: unknown): void {
    if (conn.closed) return;
    const line = `${JSON.stringify(message)}\n`;
    const bytes = Buffer.byteLength(line);
    if (conn.outboundBytes > 0 && conn.outboundBytes + bytes > MAX_OUTBOUND_QUEUE_BYTES) {
      log(`[view] ${conn.id} slow_consumer`);
      conn.sock.destroy();
      return;
    }
    conn.outbound.push(line);
    conn.outboundBytes += bytes;
    this.pump(conn);
  }

  private pump(conn: Connection): void {
    while (!conn.blocked && conn.outbound.length > 0) {
      const line = conn.outbound.shift() as string;
      conn.outboundBytes -= Buffer.byteLength(line);
      try {
        if (!conn.sock.write(line)) conn.blocked = true;
      } catch {
        conn.sock.destroy();
        return;
      }
    }
  }
}
