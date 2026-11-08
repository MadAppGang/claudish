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
 *   - a usage-limit error → `quota`: the subscription window is spent, which a
 *                           backoff cannot fix. The caller marks the account and
 *                           rotates or surfaces the reason.
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

import { parseCodexUsageLimit } from "./codex-usage-limit.js";

/** Wall-clock ceiling on withholding response headers while sniffing. */
export const DEFAULT_SNIFF_BUDGET_MS = 12_000;

/**
 * Events that carry no content and are always emitted before an error verdict.
 * Sniffing continues past these.
 */
const PREAMBLE_EVENTS = new Set(["response.created", "response.in_progress", "response.queued"]);

/**
 * Event types that mean REAL OUTPUT HAS BEGUN.
 *
 * Used only in extended mode, where the rule "any non-preamble event means
 * output began" is replaced by "any CONTENT OR TOOL DELTA means output began".
 * The distinction matters because the Codex backend interleaves metadata events
 * that carry no content, and treating those as output made an in-stream quota
 * frame unreachable the moment one arrived.
 *
 * Everything that can carry model output, a tool call, or the end of the
 * response is listed by prefix/suffix rather than enumerated exhaustively: a
 * NEW delta family the vendor adds must read as output (fail-safe), while an
 * unrecognised metadata event merely continues the sniff and is logged by name.
 */
function isOutputEvent(type: string): boolean {
  if (!type.startsWith("response.")) return false;
  if (PREAMBLE_EVENTS.has(type)) return false;
  return (
    type.endsWith(".delta") ||
    type.endsWith(".done") ||
    type.startsWith("response.output_item.") ||
    type.startsWith("response.content_part.") ||
    type === "response.completed" ||
    type === "response.incomplete"
  );
}

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
  | { kind: "retryable"; code: string; message: string }
  /**
   * Upstream reported that the SUBSCRIPTION WINDOW is spent, before any content.
   *
   * Distinct from `retryable` because the remedy is different in kind: a spent
   * window does not recover on a backoff schedule, so re-issuing the same body
   * on the same account burns 3 s + 15 s + 30 s and then fails anyway. The
   * caller marks the account and either rotates to another one or surfaces the
   * reason. Carries no `response`: the upstream body has been cancelled.
   */
  | {
      kind: "quota";
      code: string;
      message: string;
      resetsInSeconds?: number;
      resetsAt?: number;
    };

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
  opts: {
    budgetMs?: number;
    log?: (message: string) => void;
    /**
     * Widen the watch so an in-stream quota verdict is ACTIONABLE.
     *
     * True only when the caller can actually do something with the verdict —
     * i.e. a pooled OAuth request with at least one other eligible account. It
     * governs ROTATION-shaped behaviour only:
     *
     *  - false (the default, and every non-pooled stream): today's rules, byte
     *    for byte — the 12 s wall-clock budget, the narrow preamble set, "any
     *    other event means output has begun", fail-open on budget / read error /
     *    done. The quota test still runs (see below), so the account is still
     *    CLASSIFIED and can be MARKED; what false mode does not do is rotate.
     *  - true: the budget becomes an IDLE timeout, metadata events keep the
     *    sniff alive, and only a content or tool delta ends it.
     *
     * The classify half is unconditional BY DESIGN: a one-account user's
     * exhaustion must still be recorded, or the all-accounts message can never
     * list its reset. It costs one string test on the error branch of a stream
     * that has already failed.
     */
    extendedQuotaWatch?: boolean;
  } = {}
): Promise<StreamHeadVerdict> {
  const budgetMs = opts.budgetMs ?? DEFAULT_SNIFF_BUDGET_MS;
  const logMsg = opts.log ?? (() => {});
  const extended = opts.extendedQuotaWatch === true;

  // No body to inspect (HEAD-like, or an already-consumed response): pass through.
  if (!response.body) return { kind: "clean", response };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const consumed: Uint8Array[] = [];
  let pending = "";
  /**
   * In DEFAULT mode this is a wall-clock ceiling, exactly as before.
   *
   * In EXTENDED mode it is reset on every event received, making it an IDLE
   * timeout — which is what the module's own rationale actually names ("so a
   * stalled upstream cannot hold the client's headers hostage"). A stream still
   * emitting metadata is not stalled, and a hard ceiling handed such a stream to
   * the parser mid-thought, putting the quota frame that arrived at 31 s into
   * the transcript as assistant text.
   */
  let deadline = Date.now() + budgetMs;
  /**
   * Has a content or tool delta been seen? The quota verdict is UNREACHABLE
   * after one: re-issuing a request whose prefix already reached the client
   * would duplicate that prefix. This guard — not the fallthrough rule — is what
   * makes that true.
   */
  let sawOutput = false;

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
      // Extended mode measures IDLE time: a chunk arrived, so the upstream is
      // not stalled and the clock starts again.
      if (extended) deadline = Date.now() + budgetMs;

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

          // QUOTA IS TESTED FIRST, IN BOTH MODES, AND THE ORDER IS LOAD-BEARING.
          //
          // A spent window does not recover on a backoff schedule. Classifying
          // one as `retryable` burns 3 s + 15 s + 30 s re-issuing the same body
          // against the same exhausted account and then answers 503 — and the
          // vendor's own prose sits close enough to the retryable fallback's
          // vocabulary that the ordering cannot be left to luck.
          //
          // The classification runs even when rotation is off: an unmarked
          // exhaustion cannot appear in the all-accounts message later.
          const limit = sawOutput ? null : parseCodexUsageLimit(event);
          if (limit) {
            void reader.cancel().catch(() => {});
            logMsg(
              `[StreamSniff] in-stream ${limit.code}${
                limit.resetsInSeconds ? ` (resets in ${limit.resetsInSeconds}s)` : ""
              }${extended ? "" : " — classify only, rotation is off for this stream"}`
            );
            return {
              kind: "quota",
              code: limit.code,
              message: limit.message,
              ...(limit.resetsInSeconds === undefined
                ? {}
                : { resetsInSeconds: limit.resetsInSeconds }),
              ...(limit.resetsAt === undefined ? {} : { resetsAt: limit.resetsAt }),
            };
          }

          if (isRetryableStreamError(code, errType, message)) {
            // Drop the dead connection; the caller re-issues the request.
            void reader.cancel().catch(() => {});
            return { kind: "retryable", code: code || errType || "unknown", message };
          }
          // Terminal error — let the parser surface it inline as it does today.
          return { kind: "clean", response: replayResponse() };
        }

        if (!extended) {
          // DEFAULT MODE, UNCHANGED: any other event means real output has begun,
          // so retrying is no longer safe or useful.
          return { kind: "clean", response: replayResponse() };
        }

        // EXTENDED MODE: only a content or tool delta ends the sniff. An
        // unrecognised metadata event keeps it alive and is logged BY NAME, so a
        // vocabulary change shows up in a log rather than as a silent behaviour
        // change.
        if (isOutputEvent(type)) {
          sawOutput = true;
          return { kind: "clean", response: replayResponse() };
        }
        logMsg(`[StreamSniff] non-decisive event "${type}" — still watching`);
      }
    }
  } catch (error) {
    logMsg(`[StreamSniff] read failed (${error}) — handing stream to parser`);
    return { kind: "clean", response: replayResponse() };
  }
}
