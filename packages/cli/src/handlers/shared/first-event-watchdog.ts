/**
 * First-useful-event watchdog (#108).
 *
 * Incident 14/09: a provider lane (deepseek-flash scheduler) admitted requests
 * with HTTP 200 and then emitted ONLY SSE comments (`: keep-alive`, 14-28
 * bytes) for ~900s before an empty response. Nothing in the pipeline bounds
 * the wait for the FIRST useful event, so each admitted-but-mute stream held a
 * hub slot open for the full ~900s and client retries piled on top — 46
 * streams / 19 pending at peak. This is confinement, not repair: the upstream
 * outage is the provider's, but the embolism is ours.
 *
 * Definition (per the issue): a `: keep-alive` comment, an `event:` line or a
 * blank line is NOT a useful event — only a `data:` line with a non-empty
 * payload is. The window applies to the FIRST useful event only: once seen,
 * the timer is cleared and never rearmed, so a legitimate long thinking phase
 * (whose deltas are themselves data events) can never trip it.
 *
 * On expiry the upstream reader is cancelled (frees the provider slot and the
 * socket) and the wrapper closes. The downstream stream parsers already
 * finalize a stream that ends without message_stop with a synthetic terminal
 * message (see anthropic-sse.ts "emitting synthetic finalization"), so the
 * client gets a clean end-of-turn instead of a 900s hang — never-hang holds.
 *
 * Window: CLAUDISH_FIRST_EVENT_TIMEOUT_MS, re-read per request (crisis lever,
 * same rationale as CLAUDISH_QWEN_THINKING), default 300000ms — deliberately
 * conservative (healthy lanes emit their first data event in seconds; big
 * cache-miss prompts may take a while before the first token; the
 * pathological streams held ~900s). 0 or negative disables the watchdog.
 */

import { log } from "../../logger.js";

const DEFAULT_WINDOW_MS = 300_000;

export function firstEventWatchdogWindowMs(): number {
  const raw = process.env.CLAUDISH_FIRST_EVENT_TIMEOUT_MS;
  if (!raw) return DEFAULT_WINDOW_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_WINDOW_MS;
  return n;
}

/**
 * Wrap an upstream SSE `Response` so that a stream admitted with 200 but
 * producing no `data:` line within the watchdog window is closed instead of
 * being held open. Byte-for-byte passthrough otherwise; never throws.
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
