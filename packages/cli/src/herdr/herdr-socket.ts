/**
 * A client for herdr's socket API: newline-delimited JSON, `{id, method, params}` in,
 * `{id, result}` or `{id, error:{code, message}}` out (herdr 0.9.5).
 *
 * Two failures look alike and mean opposite things, so they are two classes:
 * - `HerdrApiError`: herdr answered with an error; the call did nothing.
 * - `HerdrNoReply`: the reply never came (timeout, or the socket dropped). herdr may or may not have
 *   run the call, and a caller that created something must find out by reading.
 *
 * Requests share one connection, opened on first use and again after a drop. An event subscription
 * holds a connection of its own, because herdr keeps a subscribed connection for events.
 */

import { type Socket, connect } from "node:net";

export const HERDR_REQUEST_TIMEOUT_MS = 2_000;
/** a reply line longer than this ends the connection instead of growing memory */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

export class HerdrApiError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export class HerdrNoReply extends Error {
  constructor(
    readonly method: string,
    readonly why: "timeout" | "dropped"
  ) {
    super(`herdr ${method}: no reply (${why})`);
  }
}

/** One pushed event: `{event: "pane_closed", data: {...}}`. */
export interface HerdrEvent {
  event: string;
  data: Record<string, unknown>;
}

/** What the placer and the reporter need from herdr; the fake in tests implements the same socket. */
export interface HerdrApi {
  request<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<T>;
  /** `onEnd` fires once when the subscription connection ends, with herdr's error code if any */
  subscribe(
    types: string[],
    onEvent: (e: HerdrEvent) => void,
    onEnd: (code: string | null) => void
  ): () => void;
  close(): void;
}

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** Splits a stream into JSON objects, one per line; a malformed line is skipped. */
function lineReader(onObject: (o: Record<string, unknown>) => void, onOverflow: () => void) {
  let buf = "";
  return (chunk: string): void => {
    buf += chunk;
    if (buf.length > MAX_LINE_BYTES) {
      buf = "";
      onOverflow();
      return;
    }
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (!line) continue;
      try {
        onObject(asRecord(JSON.parse(line)));
      } catch {
        // not JSON: herdr never sends one, and one bad line must not end the stream
      }
    }
  };
}

export class HerdrSocket implements HerdrApi {
  private sock: Socket | null = null;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private closed = false;
  private readonly subscriptions = new Set<Socket>();

  constructor(
    readonly path: string,
    private readonly timeoutMs: number = HERDR_REQUEST_TIMEOUT_MS
  ) {}

  request<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number = this.timeoutMs
  ): Promise<T> {
    if (this.closed) return Promise.reject(new HerdrNoReply(method, "dropped"));
    const sock = this.connection();
    const id = `c${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HerdrNoReply(method, "timeout"));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      sock.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  subscribe(
    types: string[],
    onEvent: (e: HerdrEvent) => void,
    onEnd: (code: string | null) => void
  ): () => void {
    const sock = connect(this.path);
    sock.setEncoding("utf8");
    this.subscriptions.add(sock);
    let ended = false;
    let code: string | null = null;
    const end = (): void => {
      if (ended) return;
      ended = true;
      this.subscriptions.delete(sock);
      onEnd(code);
    };
    const read = lineReader(
      (o) => {
        if (o.error) {
          code =
            typeof asRecord(o.error).code === "string" ? (asRecord(o.error).code as string) : "";
          sock.destroy();
          return;
        }
        if (typeof o.event === "string") onEvent({ event: o.event, data: asRecord(o.data) });
      },
      () => sock.destroy()
    );
    sock.on("data", read);
    sock.on("error", () => {});
    sock.on("close", end);
    const subscriptions = types.map((type) => ({ type }));
    sock.write(
      `${JSON.stringify({ id: "sub", method: "events.subscribe", params: { subscriptions } })}\n`
    );
    return () => {
      ended = true;
      this.subscriptions.delete(sock);
      sock.destroy();
    };
  }

  close(): void {
    this.closed = true;
    this.sock?.destroy();
    this.sock = null;
    for (const s of [...this.subscriptions]) s.destroy();
    this.subscriptions.clear();
  }

  private connection(): Socket {
    if (this.sock) return this.sock;
    const sock = connect(this.path);
    sock.setEncoding("utf8");
    this.sock = sock;
    sock.on(
      "data",
      lineReader(
        (o) => this.onReply(o),
        () => sock.destroy()
      )
    );
    sock.on("error", () => {});
    sock.on("close", () => {
      if (this.sock === sock) this.sock = null;
      // every call still waiting on this connection has lost its reply
      for (const [id, p] of [...this.pending]) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new HerdrNoReply(p.method, "dropped"));
      }
    });
    return sock;
  }

  private onReply(o: Record<string, unknown>): void {
    const id = typeof o.id === "string" ? o.id : "";
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (o.error) {
      const e = asRecord(o.error);
      p.reject(
        new HerdrApiError(
          typeof e.code === "string" ? e.code : "unknown",
          typeof e.message === "string" ? e.message : "herdr error"
        )
      );
      return;
    }
    p.resolve(asRecord(o.result));
  }
}
