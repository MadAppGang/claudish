/**
 * The client of a server's view endpoint. It reconnects only while the server that bound the
 * endpoint may still run; a dead owner ends the client with `server_gone` instead of a retry loop.
 */

import { type Socket, connect } from "node:net";
import { basename } from "node:path";
import { readProcessTableAsync } from "../pane/process-identity.js";
import {
  type ViewClientHello,
  ViewError,
  type ViewErrorBody,
  type ViewEvent,
  type ViewHelloResult,
} from "../pane/view-contract.js";
import { endpointOwnerAlive } from "./endpoints.js";

export const REQUEST_TIMEOUT_MS = 2_000;
const RECONNECT_FIRST_MS = 200;
const RECONNECT_MAX_MS = 5_000;
/** an answer line still unterminated past this is not a server of ours: the connection drops */
export const MAX_INBOUND_LINE_BYTES = 16 * 1024 * 1024;

export type ViewClientListener = {
  event: (event: ViewEvent) => void;
  reconnected: () => void;
  closed: (reason: "client" | "server_gone") => void;
};

export interface ViewClientOptions {
  /** redial after a dropped connection while the endpoint's owner may still run */
  reconnect?: boolean;
  /** repeated on every connection, so the server knows the role after a redial */
  hello?: ViewClientHello;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function dial(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    sock.once("connect", () => {
      sock.removeAllListeners("error");
      resolve(sock);
    });
    sock.once("error", (e) => {
      sock.destroy();
      reject(e);
    });
  });
}

export class ViewClient {
  private sock: Socket | null = null;
  private nextId = 1;
  private inbound = "";
  private readonly pending = new Map<number, Pending>();
  private readonly listeners: { [K in keyof ViewClientListener]: Set<ViewClientListener[K]> } = {
    event: new Set(),
    reconnected: new Set(),
    closed: new Set(),
  };
  private ended = false;
  /** the server's answer to the most recent `hello` of this client */
  helloResult: ViewHelloResult | null = null;

  private constructor(
    private readonly path: string,
    private readonly options: ViewClientOptions
  ) {}

  /** Throws when the endpoint cannot be reached or refuses the `hello`. */
  static async connect(path: string, options: ViewClientOptions = {}): Promise<ViewClient> {
    const client = new ViewClient(path, options);
    client.adopt(await dial(path));
    if (options.hello) {
      try {
        await client.greet(options.hello);
      } catch (e) {
        client.close();
        throw e;
      }
    }
    return client;
  }

  on<K extends keyof ViewClientListener>(name: K, listener: ViewClientListener[K]): void {
    this.listeners[name].add(listener);
  }

  /** The server's error as a `ViewError`; `server_gone` when the connection ends first. */
  request<T>(
    op: string,
    args: Record<string, unknown> = {},
    timeoutMs: number = REQUEST_TIMEOUT_MS
  ): Promise<T> {
    const sock = this.sock;
    if (!sock || this.ended)
      return Promise.reject(new ViewError("server_gone", "the connection is closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ViewError("server_gone", `no answer to '${op}' in ${timeoutMs} ms`));
      }, timeoutMs);
      // a request in flight never keeps a process alive that is otherwise done
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      sock.write(`${JSON.stringify({ id, op, args })}\n`);
    });
  }

  close(): void {
    this.end("client");
  }

  private async greet(hello: ViewClientHello): Promise<void> {
    this.helloResult = await this.request<ViewHelloResult>("hello", { client: hello });
  }

  private adopt(sock: Socket): void {
    this.sock = sock;
    this.inbound = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => this.onData(chunk));
    sock.on("error", () => {});
    sock.on("close", () => void this.onDropped(sock));
  }

  private onData(chunk: string): void {
    this.inbound += chunk;
    let nl = this.inbound.indexOf("\n");
    while (nl >= 0) {
      const line = this.inbound.slice(0, nl);
      this.inbound = this.inbound.slice(nl + 1);
      nl = this.inbound.indexOf("\n");
      if (line.trim()) this.onLine(line);
    }
    // a string's length is at most its UTF-8 byte count, so only a long one is measured
    if (
      this.inbound.length > MAX_INBOUND_LINE_BYTES / 3 &&
      Buffer.byteLength(this.inbound) > MAX_INBOUND_LINE_BYTES
    ) {
      this.inbound = "";
      this.sock?.destroy();
    }
  }

  private onLine(line: string): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (m.type === "event") {
      for (const fn of this.listeners.event) fn(m as unknown as ViewEvent);
      return;
    }
    const p = typeof m.id === "number" ? this.pending.get(m.id) : undefined;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(m.id as number);
    if (m.ok === true) p.resolve(m.result);
    else {
      const body = m.error as ViewErrorBody | undefined;
      p.reject(
        new ViewError(
          body?.code ?? "invalid_args",
          body?.message ?? "request failed",
          body?.reason,
          body?.endpoint && body.replay_id
            ? { endpoint: body.endpoint, replay_id: body.replay_id }
            : undefined
        )
      );
    }
  }

  private failPending(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new ViewError("server_gone", "the connection closed before the answer"));
      this.pending.delete(id);
    }
  }

  private async onDropped(sock: Socket): Promise<void> {
    if (this.sock !== sock || this.ended) return;
    this.sock = null;
    this.failPending();
    if (!this.options.reconnect) {
      this.end("server_gone");
      return;
    }
    let wait = RECONNECT_FIRST_MS;
    const name = basename(this.path);
    while (!this.ended) {
      if (!endpointOwnerAlive(name, await readProcessTableAsync())) {
        this.end("server_gone");
        return;
      }
      await Bun.sleep(wait);
      wait = Math.min(wait * 2, RECONNECT_MAX_MS);
      if (this.ended) return;
      let dialed: Socket | null = null;
      try {
        dialed = await dial(this.path);
        this.adopt(dialed);
        if (this.options.hello) await this.greet(this.options.hello);
        for (const fn of this.listeners.reconnected) fn();
        return;
      } catch {
        // the owner may be between restarts of its listener: judged again on the next pass. A
        // socket dialed for a refused hello is closed; its close event is not a new drop
        if (dialed && this.sock === dialed) this.sock = null;
        dialed?.destroy();
      }
    }
  }

  private end(reason: "client" | "server_gone"): void {
    if (this.ended) return;
    this.ended = true;
    this.failPending();
    this.sock?.destroy();
    this.sock = null;
    for (const fn of this.listeners.closed) fn(reason);
  }
}
