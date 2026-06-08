/**
 * Stream start peek — classify the first bytes of an SSE response without
 * consuming the stream the parser will later read.
 *
 * Motivation: Z.AI (anthropic-sse transport) frequently delivers its burst /
 * RPM limit as **HTTP 200** followed by an in-stream SSE error ([1302]) that
 * carries no message envelope. That is invisible to `response.ok` and to
 * FallbackHandler (both key off HTTP status), so it used to flow straight to
 * the client as a bare error and crash the turn. By peeking the first bytes we
 * can detect the rate-limit before handing the body to the parser, temporize
 * (retry the same provider — the sustained quota has headroom, only the
 * instantaneous burst limit is hit), and on persistence fall back to the next
 * provider in the chain.
 *
 * Mechanism: `ReadableStream.tee()` splits the body into two independent
 * branches. We sniff branch A and hand branch B (a pristine, full copy
 * including the prefix we read) downstream. Tee buffers internally, so no bytes
 * are lost for branch B even though we consumed branch A.
 *
 * Timing: the rate-limit errors we target arrive in 0-4ms. A short bounded
 * window therefore catches them while leaving slow-but-healthy responses (a
 * big-context cache-miss can have a multi-second TTFB) to proceed untouched.
 *
 * Fail-open: any unexpected condition (no body, tee unsupported, read error,
 * timeout) resolves to "healthy" with a usable Response, so this never makes
 * things worse than the parser-level safety net already guarantees.
 */

export type StreamStartClass = "healthy" | "rate-limit" | "other-error";

export interface PeekResult {
  cls: StreamStartClass;
  /**
   * Response to hand downstream.
   * - healthy / other-error: a tee'd branch carrying the FULL original stream
   *   (prefix included). Always use this — the original body is locked by tee().
   * - rate-limit: the original Response (its body is already cancelled and must
   *   not be read; the caller retries or falls back instead).
   */
  response: Response;
  /** Best-effort human-readable error message extracted from the sniffed bytes. */
  detail?: string;
}

export interface PeekOptions {
  /**
   * Max time to wait for the first classifiable bytes before assuming healthy.
   * Rate-limit errors arrive in 0-4ms, so the default is generous.
   */
  timeoutMs?: number;
  /** Max bytes to sniff before giving up and assuming healthy. */
  maxSniffBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_MAX_SNIFF_BYTES = 64 * 1024;

/** Extract the first `"message":"..."` value from sniffed SSE text. */
function extractErrMsg(sniff: string): string | undefined {
  const m = sniff.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return undefined;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
}

const RATE_LIMIT_RE = /rate.?limit|\b1302\b|\b1305\b|\b429\b|too many requests|overloaded|quota/i;

/**
 * Classify what we've sniffed so far. Returns null when the bytes are still
 * ambiguous (need to read more), a concrete class once we can decide.
 */
function classifyPartial(sniff: string): { cls: StreamStartClass; detail?: string } | null {
  // A message envelope means the provider is streaming a real answer — healthy.
  if (/"type"\s*:\s*"message_start"/.test(sniff) || /(^|\n)event:\s*message_start/.test(sniff)) {
    return { cls: "healthy" };
  }
  // Any content delta before an error likewise means a real answer is flowing.
  if (/"type"\s*:\s*"content_block_start"/.test(sniff)) {
    return { cls: "healthy" };
  }
  // Error signatures: an `event: error`, a top-level error type, or an error object.
  const hasError =
    /(^|\n)event:\s*error/.test(sniff) ||
    /"type"\s*:\s*"error"/.test(sniff) ||
    /"error"\s*:\s*\{/.test(sniff);
  if (hasError) {
    const detail = extractErrMsg(sniff);
    const isRateLimit = RATE_LIMIT_RE.test(sniff);
    return { cls: isRateLimit ? "rate-limit" : "other-error", detail };
  }
  return null;
}

/**
 * Peek the start of an SSE response and classify it without disturbing the
 * stream handed downstream. See module docs for the full rationale.
 */
export async function peekStreamStart(
  response: Response,
  opts: PeekOptions = {}
): Promise<PeekResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxSniffBytes = opts.maxSniffBytes ?? DEFAULT_MAX_SNIFF_BYTES;

  if (!response.body) {
    return { cls: "healthy", response };
  }

  // Typed as `any`: `response.body.tee()` returns Node's stream/web
  // ReadableStream, which is a distinct declaration from the global DOM
  // ReadableStream and won't unify across the two type roots. The branches are
  // only used locally (getReader / new Response), so erasing the type here is
  // safe and avoids a cross-lib cast.
  let branchA: any;
  let branchB: any;
  try {
    [branchA, branchB] = response.body.tee();
  } catch {
    // tee() unsupported or failed — original body untouched, fail open.
    return { cls: "healthy", response };
  }

  const reader = branchA.getReader();
  const decoder = new TextDecoder();
  let sniff = "";
  let cls: StreamStartClass | null = null;
  let detail: string | undefined;

  const deadline = Date.now() + timeoutMs;
  try {
    while (cls === null) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        cls = "healthy";
        break;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), remaining);
      });
      let res: { done?: boolean; value?: any } | "timeout";
      try {
        res = await Promise.race([reader.read(), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (res === "timeout") {
        cls = "healthy";
        break;
      }
      if (res.done) {
        // Stream ended within the window — classify whatever we saw.
        cls = classifyPartial(sniff)?.cls ?? "healthy";
        detail = classifyPartial(sniff)?.detail;
        break;
      }
      if (res.value) {
        sniff += decoder.decode(res.value, { stream: true });
      }
      const partial = classifyPartial(sniff);
      if (partial) {
        cls = partial.cls;
        detail = partial.detail;
        break;
      }
      if (sniff.length > maxSniffBytes) {
        cls = "healthy";
        break;
      }
    }
  } catch {
    cls = "healthy"; // read error — fail open
  } finally {
    reader.cancel().catch(() => {});
  }

  if (cls === "rate-limit") {
    // Caller will retry / fall back — discard the unused full-stream branch.
    branchB.cancel().catch(() => {});
    return { cls, response, detail };
  }

  // healthy OR other-error: hand the FULL stream (branch B) downstream. An
  // other-error still flows to the parser, whose graceful finalizer surfaces it
  // as a clean terminal message rather than a crash.
  const downstream = new Response(branchB, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  return { cls, response: downstream, detail };
}
