/**
 * Where a proxy event's cross-process actions go: `injectUserTurn` and
 * `annotateTurn` returned from `responseEnd`, plus the `stop` / `end`
 * bookkeeping that tells the session owner which responses are still running
 * their `responseEnd` hooks (§2.3).
 *
 * - `InboxFileSink`: a pane child. The owner created `hook-inbox.jsonl` and
 *   named it in `CLAUDISH_HOOK_INBOX`; every line is one synchronous append, so
 *   a `stop` written before the `message_stop` chunk is enqueued is on disk
 *   before Claude Code can read that chunk.
 * - `InProcessSink`: the interactive launcher, where the proxy and the
 *   session driver share one process. The same lines go to a `MemoryInbox`
 *   the driver's binding drains with the owner's rule, so `stop` before
 *   `message_stop` and the bounded wait for `end` hold exactly as in a pane.
 * - `UnavailableSink`: no session driver in this process (`serve`, the MCP
 *   server's own proxy, a no-surface interactive launch). Injections and
 *   annotations are dropped `unavailable`.
 */

import { appendFileSync } from "node:fs";
import { log, logStderr } from "../../logger.js";
import { isPaneChild } from "../../pane/child-env.js";
import type { JsonValue } from "../public.js";
import { type InboxLine, MemoryInbox } from "./inbox.js";

/** The pane-child env var naming the owner-created inbox file. */
export const HOOK_INBOX_ENV = "CLAUDISH_HOOK_INBOX";

/** Payload bytes (`inject` + `annotate` lines) one inbox accepts before it caps. */
export const INBOX_PAYLOAD_CAP_BYTES = 1024 * 1024;

/** What happened to one injection or annotation handed to a sink. */
export type SinkOutcome = "queued" | "unavailable" | "inbox_cap" | "write_failed";

export interface InjectionSink {
  /** False when nothing in this process can deliver an injection. */
  readonly available: boolean;
  /** A response's `message_stop` is about to reach the client. Synchronous. */
  stop(req: string): void;
  inject(req: string, hookId: string, text: string): SinkOutcome;
  annotate(req: string, hookId: string, key: string, value: JsonValue): SinkOutcome;
  /** Every `responseEnd` hook of `req` resolved or timed out, or the stream was aborted. */
  end(req: string, aborted: boolean): void;
  /**
   * The Claude Code session id a proxy request carried. Only the interactive
   * launcher's sink listens: it is how its driver follows `/clear` and learns the
   * session of a `--resume`d launch (§7.5).
   */
  noteSessionId?(sessionId: string): void;
}

/** A pane child's sink: one JSON object per line, appended synchronously. */
export class InboxFileSink implements InjectionSink {
  readonly available = true;
  private payloadBytes = 0;
  private capped = false;

  constructor(
    readonly path: string,
    private readonly capBytes: number = INBOX_PAYLOAD_CAP_BYTES,
    private readonly now: () => Date = () => new Date()
  ) {}

  stop(req: string): void {
    this.append({ v: 1, kind: "stop", req });
  }

  inject(req: string, hookId: string, text: string): SinkOutcome {
    return this.payload({ v: 1, kind: "inject", req, hookId, text, at: this.now().toISOString() });
  }

  annotate(req: string, hookId: string, key: string, value: JsonValue): SinkOutcome {
    return this.payload({
      v: 1,
      kind: "annotate",
      req,
      hookId,
      key,
      value,
      at: this.now().toISOString(),
    });
  }

  end(req: string, aborted: boolean): void {
    this.append(aborted ? { v: 1, kind: "end", req, aborted: true } : { v: 1, kind: "end", req });
  }

  private payload(line: Record<string, unknown>): SinkOutcome {
    if (this.capped) return "inbox_cap";
    const text = `${JSON.stringify(line)}\n`;
    const bytes = Buffer.byteLength(text);
    if (this.payloadBytes + bytes > this.capBytes) {
      // Past the cap the child stops appending payload, says so once, and keeps
      // writing `stop` and `end`, so the owner's settle never waits on a request
      // that will not report.
      this.capped = true;
      this.append({ v: 1, kind: "capped" });
      return "inbox_cap";
    }
    if (!this.appendText(text)) return "write_failed";
    this.payloadBytes += bytes;
    return "queued";
  }

  private append(line: Record<string, unknown>): void {
    this.appendText(`${JSON.stringify(line)}\n`);
  }

  private appendText(text: string): boolean {
    try {
      appendFileSync(this.path, text, { mode: 0o600 });
      return true;
    } catch (err) {
      // Fail open: a lost inbox line costs one injection, never the response.
      log(`[hooks] inbox ${this.path}: append failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }
}

let unavailableReported = false;

/**
 * Report, once per process, that an injection could not be delivered: there is no
 * Claude Code session this process can type into (§4.7 rule 8).
 */
export function reportInjectionUnavailable(warn: (line: string) => void = logStderr): void {
  if (unavailableReported) return;
  unavailableReported = true;
  warn("hook injection dropped: this claudish process has no Claude Code session to deliver it to");
}

/** No session driver: injections are dropped, with one stderr line per process. */
export class UnavailableSink implements InjectionSink {
  readonly available = false;

  constructor(private readonly warn: (line: string) => void = logStderr) {}

  stop(): void {}
  end(): void {}

  inject(): SinkOutcome {
    reportInjectionUnavailable(this.warn);
    return "unavailable";
  }

  annotate(): SinkOutcome {
    return "unavailable";
  }
}

/** Test seam: let the next unavailable injection print its stderr line again. */
export function resetUnavailableSinkReportForTests(): void {
  unavailableReported = false;
}

/**
 * The interactive launcher's sink (§2.3, last paragraph). It appends the same lines a
 * pane child writes to its inbox file, in memory, under the same payload cap; the
 * driver's binding drains them with the same rule. `available` turns false when the
 * driver has no pane to type into (an ambient session whose pane was not found, or a
 * driver that stopped), and injections are then dropped `unavailable`.
 */
export class InProcessSink implements InjectionSink {
  readonly inbox = new MemoryInbox();
  private payloadBytes = 0;
  private capped = false;
  private open = true;
  private sessionListeners = new Set<(sessionId: string) => void>();

  constructor(
    private readonly capBytes: number = INBOX_PAYLOAD_CAP_BYTES,
    private readonly now: () => Date = () => new Date(),
    private readonly warn: (line: string) => void = logStderr
  ) {}

  get available(): boolean {
    return this.open;
  }

  /** No driver will drain this sink: later injections are dropped `unavailable`. */
  markUnavailable(): void {
    this.open = false;
  }

  stop(req: string): void {
    // With no driver to drain them, bookkeeping lines would only accumulate.
    if (this.open) this.inbox.append({ v: 1, kind: "stop", req });
  }

  inject(req: string, hookId: string, text: string): SinkOutcome {
    if (!this.open) {
      reportInjectionUnavailable(this.warn);
      return "unavailable";
    }
    return this.payload({ v: 1, kind: "inject", req, hookId, text, at: this.now().toISOString() });
  }

  annotate(req: string, hookId: string, key: string, value: JsonValue): SinkOutcome {
    if (!this.open) return "unavailable";
    return this.payload({
      v: 1,
      kind: "annotate",
      req,
      hookId,
      key,
      value,
      at: this.now().toISOString(),
    });
  }

  end(req: string, aborted: boolean): void {
    if (!this.open) return;
    this.inbox.append(
      aborted ? { v: 1, kind: "end", req, aborted: true } : { v: 1, kind: "end", req }
    );
  }

  noteSessionId(sessionId: string): void {
    for (const fn of this.sessionListeners) {
      try {
        fn(sessionId);
      } catch {
        // a listener's failure never reaches the request
      }
    }
  }

  /** Called with every session id a proxy request carries. Returns the unsubscribe. */
  onSessionId(fn: (sessionId: string) => void): () => void {
    this.sessionListeners.add(fn);
    return () => this.sessionListeners.delete(fn);
  }

  private payload(line: InboxLine): SinkOutcome {
    if (this.capped) return "inbox_cap";
    const bytes = Buffer.byteLength(`${JSON.stringify(line)}\n`);
    if (this.payloadBytes + bytes > this.capBytes) {
      this.capped = true;
      this.inbox.append({ v: 1, kind: "capped" });
      return "inbox_cap";
    }
    this.payloadBytes += bytes;
    this.inbox.append(line);
    return "queued";
  }
}

/** The interactive launcher's sink, when one is installed (`setProcessSink`). */
let processSink: InjectionSink | null = null;

/**
 * Install the sink every proxy request of this process uses when no pane owner named an
 * inbox. The interactive launcher installs its `InProcessSink` before Claude Code starts,
 * so its first request already reports to the driver. `null` uninstalls.
 */
export function setProcessSink(sink: InjectionSink | null): void {
  processSink = sink;
}

/** One sink per inbox file, so the payload cap counts the whole file, not one request. */
const inboxSinks = new Map<string, InboxFileSink>();

/**
 * The sink for this process: the inbox a pane owner named, the launcher's in-process
 * sink, or none. The proxy builds its per-request hooks often; every one of them
 * shares the same sink. Only a pane child has an owner-created inbox, so the variable
 * is ignored anywhere else. Neither it nor the pane marker can come from a cwd env
 * file: both are control variables (`launch-env.ts`), set only by the owner's spawn.
 */
export function sinkFromEnv(env: NodeJS.ProcessEnv = process.env): InjectionSink {
  const path = isPaneChild(env) ? env[HOOK_INBOX_ENV] : undefined;
  if (!path) return processSink ?? new UnavailableSink();
  let sink = inboxSinks.get(path);
  if (!sink) {
    sink = new InboxFileSink(path);
    inboxSinks.set(path, sink);
  }
  return sink;
}
