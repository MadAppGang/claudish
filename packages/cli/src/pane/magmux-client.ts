/**
 * One NDJSON connection to one headless magmux (architecture §2.4).
 *
 * One connection is one subscriber: the first line is always the aggregate `snapshot`,
 * every request carries a string id (`r<n>`) and gets exactly one `reply`, and
 * everything else is a pushed event (research-magmux §1–2). One reader buffers partial
 * lines across chunks and never awaits inside the data handler, so magmux's per-
 * subscriber limits (1024 messages / 8 MB / 2 s write deadline) are never hit by a
 * stall of ours.
 *
 * EOF is NOT a death signal: magmux keeps its panes when a client leaves, and closes slow
 * subscribers on its own. `disconnected` reports `sawShutdown` and the owner decides
 * (`PaneSession`'s reconnect, §2.9).
 */

import { Socket } from "node:net";

export type MagmuxReply<T = Record<string, unknown>> =
  | { ok: true; result: T }
  | { ok: false; code: string; error: string };

export type MagmuxEventName =
  | "snapshot"
  | "exit"
  | "pane_closed"
  | "results"
  | "shutdown"
  | "frame"
  | "disconnected";

// Events are untyped JSON from magmux; listeners narrow the fields they read.
// biome-ignore lint/suspicious/noExplicitAny: raw protocol events
type Listener = (e: any) => void;

export class MagmuxConnectError extends Error {
  constructor(
    message: string,
    readonly errno: string | null
  ) {
    super(message);
  }
}

/**
 * One dial. The listeners go on BEFORE `connect`: Bun 1.3.10 emits a missing socket's
 * ENOENT synchronously inside `connect()`, so with `net.connect(path)` the error fired
 * before any listener existed and `bun test` reported it as an unhandled error (Bun 1.4.0
 * defers it).
 */
function dialOnce(sockPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = new Socket();
    const onError = (e: NodeJS.ErrnoException) => {
      s.destroy();
      reject(new MagmuxConnectError(e.message, e.code ?? null));
    };
    s.once("error", onError);
    s.once("connect", () => {
      s.off("error", onError);
      resolve(s);
    });
    s.connect(sockPath);
  });
}

export class MagmuxClient {
  private buf = "";
  private nextId = 1;
  private pending = new Map<
    string,
    { resolve: (r: MagmuxReply) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private listeners = new Map<string, Set<Listener>>();
  private closed = false;
  private sawShutdown = false;

  private constructor(private readonly sock: Socket) {
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => this.onData(chunk));
    sock.on("error", () => {});
    sock.on("close", () => this.onClose());
  }

  /** Dial `sockPath`, retrying every `retryMs` (50) for up to `timeoutMs` (5000). */
  static async connect(
    sockPath: string,
    opts: { retryMs?: number; timeoutMs?: number; alive?: () => boolean } = {}
  ): Promise<MagmuxClient> {
    const retry = opts.retryMs ?? 50;
    const end = Date.now() + (opts.timeoutMs ?? 5000);
    let last: MagmuxConnectError | null = null;
    for (;;) {
      try {
        return new MagmuxClient(await dialOnce(sockPath));
      } catch (e) {
        last = e as MagmuxConnectError;
      }
      if (Date.now() >= end || (opts.alive && !opts.alive())) break;
      await Bun.sleep(retry);
    }
    throw last ?? new MagmuxConnectError(`cannot connect to ${sockPath}`, null);
  }

  /** One dial, no retry. */
  static async dial(sockPath: string): Promise<MagmuxClient> {
    return new MagmuxClient(await dialOnce(sockPath));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  request<T = Record<string, unknown>>(
    msg: Record<string, unknown>,
    timeoutMs = 10_000
  ): Promise<MagmuxReply<T>> {
    if (this.closed)
      return Promise.resolve({ ok: false, code: "client_closed", error: "connection closed" });
    const id = `r${this.nextId++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, code: "client_timeout", error: `no reply in ${timeoutMs} ms` });
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (r: MagmuxReply) => void, timer });
      try {
        this.sock.write(`${JSON.stringify({ ...msg, id })}\n`);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, code: "client_closed", error: "write failed" });
      }
    });
  }

  on(ev: MagmuxEventName | string, fn: Listener): void {
    let set = this.listeners.get(ev);
    if (!set) {
      set = new Set();
      this.listeners.set(ev, set);
    }
    set.add(fn);
  }

  off(ev: string, fn: Listener): void {
    this.listeners.get(ev)?.delete(fn);
  }

  close(): void {
    if (this.closed) return;
    try {
      this.sock.destroy();
    } catch {
      // already gone
    }
  }

  private emit(ev: string, e: unknown): void {
    for (const fn of this.listeners.get(ev) ?? []) {
      try {
        fn(e);
      } catch {
        // a listener's bug must not kill the reader
      }
    }
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl = this.buf.indexOf("\n");
    while (nl >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      nl = this.buf.indexOf("\n");
      if (line.trim()) this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    if (m.type === "reply" && typeof m.id === "string") {
      const p = this.pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      p.resolve(
        m.ok === true
          ? { ok: true, result: (m.result ?? {}) as Record<string, unknown> }
          : { ok: false, code: String(m.code ?? "error"), error: String(m.error ?? "") }
      );
      return;
    }
    if (m.type === "shutdown") this.sawShutdown = true;
    // Unknown event types (control, overlay, changed, …) reach no listener.
    if (typeof m.type === "string") this.emit(m.type, m);
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, code: "client_closed", error: "connection closed" });
      this.pending.delete(id);
    }
    this.emit("disconnected", { sawShutdown: this.sawShutdown });
  }
}
