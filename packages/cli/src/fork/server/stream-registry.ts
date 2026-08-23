/**
 * Stream registry (fork extension) — counts in-flight SSE responses so an
 * operator can DRAIN before restarting the proxy.
 *
 * Why this exists. A `docker restart` kills every in-flight SSE stream
 * mid-body, and the client reports:
 *
 *     API Error: Connection lost mid-response. The response above may be
 *     incomplete.
 *
 * The agent turn is lost. The proxy itself never breaks a stream — there is not
 * a single `controller.error()` in the codebase, and every terminating path
 * (including `finalizeWithError` on an upstream socket death) emits the terminal
 * `message_stop`. So a client-visible drop means the socket died UNDER us: the
 * process went away, or the network reset.
 *
 * The main source of process death is our own operator tooling
 * (`scripts/claudish-watchdog.ps1`): a periodic proactive restart plus a restart
 * on a failed liveness probe. It restarts blind because it has no way to see
 * in-flight work. This registry is that missing signal — `/health` reports the
 * count, and the watchdog waits for it to reach zero.
 *
 * NEVER-HANG: the wrapper is a pure passthrough. No parsing, no buffering, and
 * it never calls `controller.error()` — a counting wrapper must not become a new
 * way for a stream to break. On a read exception it closes cleanly (the parsers
 * have already emitted their terminal events by then).
 */

import type { Context, MiddlewareHandler } from "hono";

export interface StreamTracker {
  /** Hono middleware — mount with `app.use("*", tracker.middleware)`. */
  middleware: MiddlewareHandler;
  /** Number of SSE responses currently streaming to clients. */
  getActiveStreams: () => number;
}

const SSE_CONTENT_TYPE = "text/event-stream";

export function createStreamTracker(): StreamTracker {
  let activeStreams = 0;

  const middleware: MiddlewareHandler = async (c: Context, next) => {
    await next();

    const res = c.res;
    const body = res.body;
    if (!body) return;
    if (!(res.headers.get("content-type") || "").includes(SSE_CONTENT_TYPE)) return;

    activeStreams++;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      activeStreams--;
    };

    const reader = body.getReader();
    const counted = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            finish();
            return;
          }
          controller.enqueue(value);
        } catch {
          controller.close();
          finish();
        }
      },
      cancel(reason) {
        try {
          void reader.cancel(reason);
        } catch {}
        finish();
      },
    });

    c.res = new Response(counted, { status: res.status, headers: res.headers });
  };

  return { middleware, getActiveStreams: () => activeStreams };
}
