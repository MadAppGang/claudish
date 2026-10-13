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
 * - `UnavailableSink`: no session driver in this process (`serve`, the MCP
 *   server's own proxy, a no-surface interactive launch). Injections and
 *   annotations are dropped `unavailable`.
 *
 * The in-process sink of the interactive launcher arrives with its driver.
 */

import { appendFileSync } from "node:fs";
import { log, logStderr } from "../../logger.js";
import type { JsonValue } from "../public.js";

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

/** No session driver: injections are dropped, with one stderr line per process. */
export class UnavailableSink implements InjectionSink {
  readonly available = false;

  constructor(private readonly warn: (line: string) => void = logStderr) {}

  stop(): void {}
  end(): void {}

  inject(): SinkOutcome {
    if (!unavailableReported) {
      unavailableReported = true;
      this.warn(
        "hook injection dropped: this claudish process has no Claude Code session to deliver it to"
      );
    }
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

/** One sink per inbox file, so the payload cap counts the whole file, not one request. */
const inboxSinks = new Map<string, InboxFileSink>();

/**
 * The sink for this process: the inbox a pane owner named, or none. The proxy
 * builds its per-request hooks often; every one of them shares the file's sink.
 */
export function sinkFromEnv(env: NodeJS.ProcessEnv = process.env): InjectionSink {
  const path = env[HOOK_INBOX_ENV];
  if (!path) return new UnavailableSink();
  let sink = inboxSinks.get(path);
  if (!sink) {
    sink = new InboxFileSink(path);
    inboxSinks.set(path, sink);
  }
  return sink;
}
