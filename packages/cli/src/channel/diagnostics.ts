// ─── Channel Diagnostics ──────────────────────────────────────────────────────
//
// Optional instrumentation for the channel notification pipeline. Activated by
// setting CLAUDISH_CHANNEL_TRACE=1 in the environment before starting the MCP
// server.
//
// Three checkpoints are exposed so a debugger can pinpoint which layer fails:
//   1. wrapStateChange() — wraps SessionManager.onStateChange. Logs every
//      callback invocation, captures rejections from server.notification(),
//      and re-throws nothing — instrumentation must never break production.
//   2. installWireTap() — wraps process.stdout.write to mirror outbound
//      notifications/claude/channel JSON-RPC frames to stderr. Confirms the
//      wire-level write actually happens.
//   3. traceEnabled() — convenience predicate other modules can branch on.
//
// All output is single-line "[channel-trace] ..." records on stderr so they
// can be greppable from MCP server stderr logs.

import { appendFileSync } from "node:fs";
import type { ChannelEvent } from "./types.js";

const TRACE_ENV = "CLAUDISH_CHANNEL_TRACE";
const TRACE_FILE_ENV = "CLAUDISH_CHANNEL_TRACE_FILE";

export function traceEnabled(): boolean {
  return process.env[TRACE_ENV] === "1";
}

function emit(line: string): void {
  const formatted = `[channel-trace] ${line}\n`;
  process.stderr.write(formatted);
  // Optional file mirror — useful when the MCP server is spawned by a host
  // (like Claude Code) that captures stderr internally and we need to observe
  // trace output from outside the host process.
  const filePath = process.env[TRACE_FILE_ENV];
  if (filePath) {
    try {
      appendFileSync(filePath, formatted);
    } catch {
      // file write failure must never break the server
    }
  }
}

type StateChangeFn = (sessionId: string, event: ChannelEvent) => void;

/**
 * Wrap a SessionManager onStateChange callback so each invocation is logged.
 * Returns the original callback unchanged when tracing is off.
 *
 * Logs:
 *   - "fired sid=… type=… model=… elapsed=…s" on entry
 *   - "callback returned sid=… type=…" on success
 *   - "callback THREW sid=… type=… err=…" on synchronous error (re-thrown)
 */
export function wrapStateChange(fn: StateChangeFn): StateChangeFn {
  if (!traceEnabled()) return fn;
  return (sessionId, event) => {
    emit(
      `fired sid=${sessionId} type=${event.type} model=${event.model} elapsed=${event.elapsedSeconds}s`
    );
    try {
      fn(sessionId, event);
      emit(`callback returned sid=${sessionId} type=${event.type}`);
    } catch (err) {
      emit(
        `callback THREW sid=${sessionId} type=${event.type} err=${(err as Error)?.message ?? err}`
      );
      throw err;
    }
  };
}

/**
 * Capture rejections from server.notification()'s returned Promise so they're
 * visible on stderr. The MCP SDK's notification() returns a Promise that
 * nothing in mcp-server.ts awaits; if it rejects, the error would otherwise
 * be silently swallowed.
 *
 * Pass the value returned by server.notification() — if it's a Promise we
 * attach a catch handler; otherwise we no-op.
 */
export function watchNotificationResult(
  result: unknown,
  context: { sessionId: string; eventType: string }
): void {
  if (!traceEnabled()) return;
  if (result && typeof (result as Promise<unknown>).then === "function") {
    (result as Promise<unknown>).catch((err) => {
      emit(
        `notification REJECTED sid=${context.sessionId} type=${context.eventType} err=${err?.message ?? err}`
      );
    });
  }
}

/**
 * Install a stdout.write wrapper that mirrors outbound JSON-RPC frames
 * containing `notifications/claude/channel` to stderr. Idempotent — calling
 * twice still installs only one wrapper.
 *
 * No-op when tracing is off.
 */
let wireTapInstalled = false;
export function installWireTap(): void {
  if (!traceEnabled()) return;
  if (wireTapInstalled) return;
  wireTapInstalled = true;

  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((
    chunk: string | Uint8Array,
    ...rest: unknown[]
  ): boolean => {
    try {
      const text =
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
      if (text.includes('"notifications/claude/channel"')) {
        emit(`WIRE-OUT ${text.trim()}`);
      }
    } catch {
      // never let logging break the real write
    }
    // @ts-expect-error pass-through to original signature
    return originalWrite(chunk, ...rest);
  }) as typeof process.stdout.write;

  emit("wire tap installed");
}
