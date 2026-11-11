/**
 * A client for herdr's socket API: newline-delimited JSON, `{id, method, params}` in,
 * `{id, result}` or `{id, error:{code, message}}` out (herdr 0.9.5).
 *
 * Two failures look alike and mean opposite things, so they are two classes:
 * - `HerdrApiError`: herdr answered with an error; the call did nothing.
 * - `HerdrNoReply`: the reply never came (timeout, or the socket dropped). herdr may or may not have
 *   run the call, and a caller that created something must find out by reading.
 *
 * Each request opens its own connection: herdr 0.9.5 answers one request and then closes the
 * connection, so a second request written on it is never answered. An event subscription holds a
 * connection of its own, which herdr keeps open for events.
 */

import { type Socket, connect } from "node:net";
import { LineBuffer } from "../view/line-buffer.js";

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

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * Splits a stream into JSON objects, one per line; a malformed line is skipped. Only a line still
 * unterminated after the chunk counts against the cap, in bytes: a chunk of many short lines is fine.
 */
export function lineReader(
  onObject: (o: Record<string, unknown>) => void,
  onOverflow: () => void,
  maxLineBytes = MAX_LINE_BYTES
) {
  const buf = new LineBuffer(maxLineBytes);
  return (chunk: string): void => {
    const { lines, overflow } = buf.push(chunk);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      try {
        onObject(asRecord(JSON.parse(line)));
      } catch {
        // not JSON: herdr never sends one, and one bad line must not end the stream
      }
    }
    if (overflow) onOverflow();
  };
}

export class HerdrSocket implements HerdrApi {
  private nextId = 1;
  private closed = false;
  /** request connections still waiting for their reply */
  private readonly inFlight = new Set<Socket>();
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
    const id = `c${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const sock = connect(this.path);
      sock.setEncoding("utf8");
      this.inFlight.add(sock);
      let settled = false;
      const settle = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.inFlight.delete(sock);
        sock.destroy();
        outcome();
      };
      const timer = setTimeout(
        () => settle(() => reject(new HerdrNoReply(method, "timeout"))),
        timeoutMs
      );
      timer.unref?.();
      sock.on(
        "data",
        lineReader(
          (o) => {
            if (o.id !== id) return;
            settle(() => {
              if (!o.error) {
                resolve(asRecord(o.result) as T);
                return;
              }
              const e = asRecord(o.error);
              reject(
                new HerdrApiError(
                  typeof e.code === "string" ? e.code : "unknown",
                  typeof e.message === "string" ? e.message : "herdr error"
                )
              );
            });
          },
          () => settle(() => reject(new HerdrNoReply(method, "dropped")))
        )
      );
      sock.on("error", () => {});
      // closed before the reply: herdr may or may not have run the call
      sock.on("close", () => settle(() => reject(new HerdrNoReply(method, "dropped"))));
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
    for (const s of [...this.inFlight]) s.destroy();
    this.inFlight.clear();
    for (const s of [...this.subscriptions]) s.destroy();
    this.subscriptions.clear();
  }
}
