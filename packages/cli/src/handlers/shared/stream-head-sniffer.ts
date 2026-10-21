/**
 * Stream-head sniffer for the OpenAI Responses SSE wire format.
 *
 * The Codex backend (`chatgpt.com/backend-api/codex/responses`) reports capacity
 * failures INSIDE an HTTP 200 stream, not via the status code:
 *
 *   200 OK
 *   data: {"type":"response.created", ...}
 *   data: {"type":"response.in_progress", ...}
 *   data: {"type":"error","error":{"code":"server_is_overloaded", ...}}
 *
 * Every retry hook in claudish keys off the HTTP status (see anthropic-compat's
 * 429 loop and antigravity's 429 classifier), so an overload arriving this
 * way bypassed all of them: the parser turned it into an assistant text block and
 * ended the turn `end_turn`. A transient, textbook-retryable failure became a
 * permanent, successful-looking answer reading "[API Error: server_is_overloaded]".
 *
 * This module peeks at the head of the stream BEFORE the handler returns a
 * Response, which is the only window in which the status code is still ours to
 * choose (once Hono flushes the 200, a 503 is no longer expressible).
 *
 * Sniffing stops at the first DECISIVE event:
 *   - a retryable error   → caller retries the upstream request
 *   - anything else       → `clean`, and the consumed bytes are replayed so the
 *                           real parser sees a byte-identical stream
 *
 * `response.created` / `response.in_progress` are preamble: they carry no content
 * and always precede the error, so they are not decisive.
 *
 * The budget bounds how long headers may be withheld. Observed error latencies on
 * the Codex backend ranged 0.85s–7.7s, so the default leaves margin above that
 * while still capping the delay for a slow-thinking healthy turn. Past the budget
 * we flush and let the in-stream text-block path handle whatever arrives — a
 * graceful degradation to the previous behaviour, never a hang.
 */

/** Wall-clock ceiling on withholding response headers while sniffing. */
export const DEFAULT_SNIFF_BUDGET_MS = 12_000;

/**
 * Events that carry no content and are always emitted before an error verdict.
 * Sniffing continues past these.
 */
const PREAMBLE_EVENTS = new Set(["response.created", "response.in_progress"]);

/**
 * Error codes worth retrying: upstream capacity/transient faults. Deliberately
 * narrow — `context_length_exceeded`, `invalid_request_error` and friends are
 * terminal and must keep their existing inline-text treatment, because retrying
 * them burns the backoff budget and still fails.
 */
const RETRYABLE_ERROR_CODES = new Set([
  "server_is_overloaded",
  "server_error",
  "internal_error",
  "internal_server_error",
  "rate_limit_exceeded",
  "overloaded",
  "slow_down",
]);

/** Error `type` values that are retryable regardless of the code field. */
const RETRYABLE_ERROR_TYPES = new Set([
  "service_unavailable_error",
  "overloaded_error",
  "api_error",
]);

export type StreamHeadVerdict =
  /** Nothing retryable at the head. `response` replays the consumed bytes. */
  | { kind: "clean"; response: Response }
  /** Upstream reported a transient fault before emitting any content. */
  | { kind: "retryable"; code: string; message: string };

/**
 * Decide whether an in-stream error code/type/message is worth a retry.
 *
 * Exported for the retry-policy tests and so callers can classify an error they
 * discovered by other means.
 */
export function isRetryableStreamError(code: string, type: string, message: string): boolean {
  if (RETRYABLE_ERROR_CODES.has(code)) return true;
  if (RETRYABLE_ERROR_TYPES.has(type)) return true;
  // Message-shaped fallback: these backends are not consistent about which of
  // code/type carries the meaning, and an overload phrased only in prose should
  // still retry rather than land in the transcript as the model's answer.
  return /overloaded|try again later|temporarily unavailable|please retry/i.test(message);
}

/**
 * Read the head of an SSE response, looking for a retryable error before any
 * content is produced.
 *
 * On `clean` the returned Response streams the buffered head followed by the
 * untouched remainder, so the caller can hand it to the real parser unchanged.
 * On `retryable` the upstream body is cancelled — the caller is expected to
 * re-issue the request, and leaving the old connection open would leak it.
 */
export async function sniffResponsesStreamHead(
  response: Response,
  opts: { budgetMs?: number; log?: (message: string) => void } = {}
): Promise<StreamHeadVerdict> {
  const budgetMs = opts.budgetMs ?? DEFAULT_SNIFF_BUDGET_MS;
  const logMsg = opts.log ?? (() => {});

  // No body to inspect (HEAD-like, or an already-consumed response): pass through.
  if (!response.body) return { kind: "clean", response };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const consumed: Uint8Array[] = [];
  let pending = "";
  const deadline = Date.now() + budgetMs;

  /** Rebuild a Response that replays `consumed`, then drains `reader`. */
  const replayResponse = (): Response => {
    const buffered = consumed.slice();
    const body = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          for (const chunk of buffered) controller.enqueue(chunk);
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) controller.enqueue(value);
          }
          controller.close();
        } catch (error) {
          // Mirror the upstream failure into the replayed stream so the parser's
          // own error handling runs, rather than seeing a silent truncation.
          try {
            controller.error(error);
          } catch {}
        }
      },
      // Downstream went away — release the upstream connection, and resolve
      // only once it is released, so the parser's cancel can wait for it.
      cancel: () => reader.cancel().catch(() => {}),
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        logMsg(`[StreamSniff] budget ${budgetMs}ms elapsed with no verdict — streaming through`);
        return { kind: "clean", response: replayResponse() };
      }

      // Race the read against the remaining budget so a stalled upstream cannot
      // hold the client's headers hostage.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), remaining);
      });
      let result: Awaited<ReturnType<typeof reader.read>> | "timeout";
      try {
        result = await Promise.race([reader.read(), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }

      if (result === "timeout") {
        logMsg(`[StreamSniff] budget ${budgetMs}ms elapsed mid-read — streaming through`);
        return { kind: "clean", response: replayResponse() };
      }
      if (result.done) return { kind: "clean", response: replayResponse() };
      if (!result.value) continue;

      consumed.push(result.value);
      pending += decoder.decode(result.value, { stream: true });

      // Consume whole lines only; a partial trailing line stays in `pending`.
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        let event: any;
        try {
          event = JSON.parse(payload);
        } catch {
          // A split JSON payload is not a verdict; keep reading.
          continue;
        }

        const type = String(event?.type ?? "");
        if (PREAMBLE_EVENTS.has(type)) continue;

        if (type === "error" || type === "response.failed") {
          const err = event.error ?? event.response?.error ?? {};
          const code = String(err.code ?? event.code ?? "");
          const errType = String(err.type ?? event.error_type ?? "");
          const message = String(err.message ?? event.message ?? "Unknown API error");

          if (isRetryableStreamError(code, errType, message)) {
            // Drop the dead connection; the caller re-issues the request.
            void reader.cancel().catch(() => {});
            return { kind: "retryable", code: code || errType || "unknown", message };
          }
          // Terminal error — let the parser surface it inline as it does today.
          return { kind: "clean", response: replayResponse() };
        }

        // Any other event means real output has begun: retrying is no longer
        // safe or useful.
        return { kind: "clean", response: replayResponse() };
      }
    }
  } catch (error) {
    logMsg(`[StreamSniff] read failed (${error}) — handing stream to parser`);
    return { kind: "clean", response: replayResponse() };
  }
}
