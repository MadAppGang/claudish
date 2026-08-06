/**
 * Stream-head sniffer for the Devin Connect-protobuf wire format.
 *
 * Devin has precisely the failure mode `stream-head-sniffer.ts` was written for,
 * in a different encoding: the transport returns **HTTP 200** and the fault
 * arrives as a `flags = 2` frame whose JSON body carries
 * `{"error":{"code","message"}}`. The status code alone NEVER signals failure on
 * this backend.
 *
 * Every retry hook in claudish keys off the HTTP status, so without this a
 * retryable capacity fault would become an assistant text block ending
 * `end_turn` — a transient failure frozen into the transcript as a successful
 * answer.
 *
 * Sniffing happens in the only window where the status code is still ours to
 * choose (once Hono flushes the 200, a 503 is no longer expressible), and stops
 * at the first DECISIVE frame:
 *
 * - a message frame (`flags = 0`)  → `clean`; real output has begun
 * - `flags = 2` with body `{}`     → `clean`; an empty but successful stream
 * - `flags = 2` with an error body → classified `retryable` or `terminal`
 *
 * The consumed bytes are replayed BYTE-IDENTICALLY on `clean`, so the real
 * parser sees an unchanged stream. Past the budget we flush and degrade to the
 * in-stream path — never a hang.
 *
 * ## Why the classification is split three ways
 *
 * `stream-head-sniffer.ts` only needed `clean`/`retryable` because its terminal
 * codes already had a working inline-text treatment. Here the terminal case
 * carries information the user needs (an unserved uid, a revoked entitlement),
 * so it is surfaced as an HTTP **400 `invalid_request_error`** — a status Claude
 * Code renders verbatim and inline — rather than buried under "API error ·
 * Retrying · attempt N/10". Retryable-after-our-own-retries becomes **503**,
 * which is safe specifically because `fallback-handler.isRetryableError` does
 * NOT list 503: it cannot silently switch the user off a pinned model, and it
 * reaches Claude Code, which runs its own retry loop.
 *
 * `permission_denied` deserves a note. It was caused, in every reproduction
 * during protocol work, SOLELY by encoding a message with the wrong role enum
 * (3 instead of 2) — not by tool fingerprinting. If it shows up in the field
 * that is the first hypothesis, which is why the upstream message is surfaced
 * verbatim.
 */

import { FRAME_FLAG_END_OF_STREAM, createFrameReader } from "../../providers/devin/proto-codec.js";

/**
 * Wall-clock ceiling on withholding response headers while sniffing.
 *
 * Shared with the Responses sniffer's rationale and value: the GLM capture's
 * time-to-first-token was 2.5s, comfortably below this, so the budget leaves
 * margin above the observed decision latency while still capping the delay for a
 * slow-thinking healthy turn.
 */
export const DEVIN_SNIFF_BUDGET_MS = 12_000;

/**
 * Connect/gRPC status codes worth retrying: upstream capacity and transient
 * faults. Deliberately narrow — retrying a terminal fault burns the backoff
 * budget and still fails.
 *
 * `resource_exhausted` is NOT here: it means "rate limit" for a transient
 * window and "you are out of quota" for a subscription cap, and the two are
 * only distinguishable from the message. It is classified below.
 */
const RETRYABLE_CODES = new Set(["unavailable", "internal", "deadline_exceeded", "aborted"]);

/**
 * Codes that cannot succeed on retry: credentials, entitlement, a malformed
 * request, or an unserved model uid.
 */
const TERMINAL_CODES = new Set([
  "permission_denied",
  "unauthenticated",
  "invalid_argument",
  "not_found",
  "failed_precondition",
  "unimplemented",
]);

/** Prose that marks an upstream capacity fault regardless of the code field. */
const RETRYABLE_MESSAGE_RE =
  /third-party model provider is experiencing issues|overloaded|temporarily unavailable|try again|please retry/i;

/** Prose that marks a quota cap — a `resource_exhausted` that will not recover. */
const QUOTA_MESSAGE_RE = /quota|out of credits|credit balance|billing|plan limit|exceeded your/i;

export type DevinStreamHeadVerdict =
  /** Nothing decisive at the head. `response` replays the consumed bytes. */
  | { kind: "clean"; response: Response }
  /** Upstream reported a transient fault before emitting any content. */
  | { kind: "retryable"; code: string; message: string }
  /** Upstream reported a fault that retrying cannot fix. */
  | { kind: "terminal"; code: string; message: string };

/**
 * Classify an in-stream Devin error.
 *
 * Exported for the retry-policy tests and so callers can classify an error they
 * discovered by other means.
 *
 * An UNRECOGNIZED code is terminal, not retryable. The asymmetry is deliberate:
 * misclassifying a terminal fault as retryable costs the user 48s of backoff and
 * still fails with the real reason hidden behind a retry banner, while
 * misclassifying a transient fault as terminal costs one visible, accurate
 * error the user (or Claude Code) can immediately retry.
 */
export function classifyDevinStreamError(code: string, message: string): "retryable" | "terminal" {
  const lowerCode = code.toLowerCase();
  if (RETRYABLE_CODES.has(lowerCode)) return "retryable";
  if (TERMINAL_CODES.has(lowerCode)) return "terminal";
  if (lowerCode === "resource_exhausted") {
    return QUOTA_MESSAGE_RE.test(message) ? "terminal" : "retryable";
  }
  // The backends behind Devin are not consistent about which of code/message
  // carries the meaning, so an overload phrased only in prose still retries.
  if (RETRYABLE_MESSAGE_RE.test(message)) return "retryable";
  return "terminal";
}

/**
 * Read the head of a Devin Connect stream, looking for an error frame before any
 * content is produced.
 *
 * On `clean` the returned Response streams the buffered head followed by the
 * untouched remainder. On a verdict the upstream body is cancelled — the caller
 * either re-issues or gives up, and leaving the old connection open would leak it.
 */
export async function sniffDevinStreamHead(
  response: Response,
  opts: { budgetMs?: number; log?: (message: string) => void } = {}
): Promise<DevinStreamHeadVerdict> {
  const budgetMs = opts.budgetMs ?? DEVIN_SNIFF_BUDGET_MS;
  const logMsg = opts.log ?? (() => {});

  // No body to inspect (HEAD-like, or an already-consumed response): pass through.
  if (!response.body) return { kind: "clean", response };

  const reader = response.body.getReader();
  const consumed: Uint8Array[] = [];
  const nextFrames = createFrameReader();
  const decoder = new TextDecoder();
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
      cancel: () => {
        // Downstream went away — release the upstream connection.
        void reader.cancel().catch(() => {});
      },
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
        logMsg(`[DevinSniff] budget ${budgetMs}ms elapsed with no verdict — streaming through`);
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
        logMsg(`[DevinSniff] budget ${budgetMs}ms elapsed mid-read — streaming through`);
        return { kind: "clean", response: replayResponse() };
      }
      if (result.done) return { kind: "clean", response: replayResponse() };
      if (!result.value) continue;

      consumed.push(result.value);

      for (const frame of nextFrames(result.value)) {
        if (frame.flags !== FRAME_FLAG_END_OF_STREAM) {
          // A message frame: real output has begun, retrying is neither safe
          // nor useful.
          return { kind: "clean", response: replayResponse() };
        }

        const raw = decoder.decode(frame.payload).trim();
        if (!raw || raw === "{}") {
          // Successful (if empty) stream — let the parser finalise it normally.
          return { kind: "clean", response: replayResponse() };
        }

        let code = "unknown";
        let message = raw;
        try {
          const parsed = JSON.parse(raw);
          code = String(parsed?.error?.code ?? parsed?.code ?? "unknown");
          message = String(parsed?.error?.message ?? parsed?.message ?? raw);
        } catch {
          // Not JSON — surface the body verbatim rather than inventing a code.
        }

        const kind = classifyDevinStreamError(code, message);
        logMsg(`[DevinSniff] in-stream error ${code} classified ${kind}: ${message.slice(0, 200)}`);
        // Drop the dead connection; the caller re-issues or surfaces the error.
        void reader.cancel().catch(() => {});
        return { kind, code, message };
      }
    }
  } catch (error) {
    logMsg(`[DevinSniff] read failed (${error}) — handing stream to parser`);
    return { kind: "clean", response: replayResponse() };
  }
}
