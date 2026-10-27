/**
 * First-useful-event watchdog.
 *
 * Failure class this bounds: a provider admits a request with HTTP 200 and
 * then emits ONLY SSE comments (`: keep-alive`) — or nothing at all —
 * indefinitely. Nothing else in the pipeline bounds the wait for the FIRST
 * useful event, so each admitted-but-mute stream holds its connection open
 * until the client or the provider eventually gives up, while client retries
 * pile on top of the mute stream.
 *
 * Definition: a `: keep-alive` comment, an `event:` line or a blank line is
 * NOT a useful event — only a `data:` line with a non-empty payload is. The
 * window applies to the FIRST useful event only: once seen, the timer is
 * cleared and never rearmed, so a legitimate long thinking phase (whose
 * deltas are themselves data events) can never trip it.
 *
 * On expiry the upstream reader is cancelled (frees the connection) and the
 * wrapper closes. Downstream stream parsers already finalize a stream that
 * ends without message_stop with a synthetic terminal message, so the client
 * gets a clean end-of-turn instead of an indefinite hang.
 *
 * Inert by default: `CLAUDISH_FIRST_EVENT_TIMEOUT_MS` unset, 0, negative or
 * non-numeric disables the watchdog entirely — behavior is unchanged unless
 * the operator arms it. The value is re-read per wrap (per request), so the
 * knob also works as a live crisis lever without a restart.
 */

import { log } from "../../logger.js";

export function firstEventWatchdogWindowMs(): number {
  const raw = process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS;
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

/**
 * Wrap an upstream SSE `Response` so that a stream admitted with 200 but
 * producing no `data:` line within the watchdog window is closed instead of
 * being held open. Byte-for-byte passthrough otherwise; never throws.
 * Unarmed (window <= 0) or bodyless responses pass through as the same
 * object.
 */
export function withFirstUsefulEventWatchdog(response: Response, label: string): Response {
  const windowMs = firstEventWatchdogWindowMs();
  const upstream = response.body;
  if (!upstream || windowMs <= 0) return response;

  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let sawUseful = false;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        if (sawUseful || finished) return;
        finished = true;
        clearTimer();
        log(
          `[FirstEvent] watchdog: no useful event within ${windowMs}ms (${label}) — cancelling upstream; downstream parser finalizes synthetically`,
          true
        );
        try {
          reader.cancel().catch(() => {});
        } catch {
          /* already released */
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }, windowMs);

      (async () => {
        try {
          let scanBuffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (finished) break;

            if (!sawUseful && value) {
              // Any `data:` line with a non-empty payload marks the stream
              // healthy: SSE comments (`: keep-alive`) and `event:` lines
              // never match. Keep the scan bounded — a mute-but-chatty
              // upstream may stream kilobytes of comments.
              scanBuffer += decoder.decode(value, { stream: true });
              if (/^data:\s*\S/m.test(scanBuffer)) {
                sawUseful = true;
                clearTimer();
                scanBuffer = "";
              } else if (scanBuffer.length > 8192) {
                scanBuffer = scanBuffer.slice(-4096);
              }
            }

            controller.enqueue(value);
          }
          controller.close();
        } catch {
          // Never-hang: close cleanly. The parser downstream treats this like
          // an upstream socket error and finalizes with its own graceful path.
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        } finally {
          clearTimer();
          try {
            reader.releaseLock();
          } catch {
            /* already released */
          }
        }
      })();
    },
    cancel(reason) {
      finished = true;
      clearTimer();
      try {
        reader.cancel(reason).catch(() => {});
      } catch {
        /* already released */
      }
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
