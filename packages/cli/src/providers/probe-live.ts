/**
 * probe-live — send real 1-token chat requests through the running proxy
 * to validate that each link in a model's fallback chain actually works.
 *
 * The probe goes through the same proxy that serves real traffic, so it
 * exercises every layer: API key resolution (env/.env/config.json),
 * routing rules, transport classes, adapter format, and stream parser.
 *
 * Each link is pinned to a single provider by passing its `provider@model`
 * spec as the request body. The runtime router sees `isExplicitProvider`
 * and skips fallback — so a failure here is a real failure for that link,
 * not a silent failover to something else.
 */

export type ProbeState =
  | "live"
  | "key-missing"
  | "auth-failed"
  | "model-not-found"
  | "rate-limited"
  | "server-error"
  | "timeout"
  | "network-error"
  | "error";

export interface ProbeResult {
  state: ProbeState;
  /** Total wall-clock from request start to finished reading the response. */
  latencyMs: number;
  httpStatus?: number;
  errorMessage?: string;
  /** Hint shown after the error message (e.g. "run: claudish login gemini"). */
  actionHint?: string;
  /**
   * Granular timing breakdown, present on successful ("live") probes. The three
   * stages are sequential and sum to ~latencyMs:
   *   network   = ttfbMs                 (connect + proxy + provider accept)
   *   server    = ttftMs - ttfbMs        (provider thinking before first token)
   *   streaming = latencyMs - ttftMs     (token generation)
   */
  timing?: ProbeTiming;
}

/**
 * Minimum streaming window (ms) used when deriving tokens/sec. A response whose
 * whole (token-capped) body lands in ~one chunk has TTFT ≈ total, so the raw
 * streaming window collapses toward zero and `tokens / streamMs` explodes into a
 * nonsense rate (e.g. 49000 t/s). Flooring the window to this constant bounds the
 * rate to a defensible "tokens over a floored window" value. BOTH the displayed
 * value (here) and the bar SCALE (computeBarScales / probe-tui-app.tsx) floor by
 * this same constant so the number you read and the bar you see derive from one
 * window and never disagree. Lives here (the canonical timing module) so the TUI
 * theme can reference it without the network path depending on @opentui/core.
 */
export const STREAM_MS_FLOOR = 50;

export interface ProbeTiming {
  /** Time to response headers (ms from request start). */
  ttfbMs: number;
  /** Time to first content token (ms from request start). */
  ttftMs: number;
  /** Time reading the full (capped) response (ms from request start) = total. */
  totalMs: number;
  /** Output tokens observed in the streamed response. */
  tokens: number;
  /** Streaming throughput = tokens / (streaming seconds). 0 if unmeasurable. */
  tokensPerSec: number;
}

/**
 * Providers that authenticate via OAuth rather than a static env-var key.
 * Their static credential check is unreliable (no env var to test), so the
 * probe must treat the live request as the source of truth: if it returns a
 * token-related failure, we surface a login hint instead of masking the link
 * as "skipped".
 */
const OAUTH_PROVIDERS = new Set(["vertex", "gemini-codeassist"]);
// Ask for a short paragraph so we can sample streaming throughput (tokens/sec).
// Capped small so probes stay quick (~0.3-1s of generation for most models)
// while still giving a stable tok/s estimate.
const PROBE_PROMPT = "Count from one to twenty in words, one per line.";
const PROBE_MAX_TOKENS = 64;

export interface ProbeLinkInput {
  provider: string;
  modelSpec: string;
  hasCredentials: boolean;
  credentialHint?: string;
}

export async function probeLink(
  proxyUrl: string,
  link: ProbeLinkInput,
  timeoutMs: number
): Promise<ProbeResult> {
  const isOAuth = OAUTH_PROVIDERS.has(link.provider);

  if (!link.hasCredentials && !isOAuth) {
    return {
      state: "key-missing",
      latencyMs: 0,
      errorMessage: link.credentialHint,
    };
  }

  const startedAt = Date.now();
  let response: Response;

  try {
    response = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: link.modelSpec,
        // Include a system field so Codex-family providers (which require
        // `instructions` derived from system) accept the request. Other
        // providers tolerate the extra field.
        system: "You are a helpful assistant.",
        messages: [{ role: "user", content: PROBE_PROMPT }],
        max_tokens: PROBE_MAX_TOKENS,
        stream: true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: any) {
    const latencyMs = Date.now() - startedAt;
    const name = e?.name || "";
    const msg = String(e?.message || e);
    if (name === "TimeoutError" || name === "AbortError" || /timeout/i.test(msg)) {
      return { state: "timeout", latencyMs, errorMessage: msg };
    }
    return { state: "network-error", latencyMs, errorMessage: msg };
  }

  // TTFB: response headers are back. Stages before this are network/connect +
  // proxy + provider accepting the request.
  const ttfbMs = Date.now() - startedAt;

  if (!response.ok) {
    const body = await safeReadBody(response);
    return annotateOAuthHint(
      classifyHttpError(response.status, body, ttfbMs),
      link.provider,
      isOAuth
    );
  }

  const streamResult = await consumeProbeStream(response, timeoutMs, startedAt);
  const totalMs = Date.now() - startedAt;

  // Build the granular timing only for a successful read. ttftMs/tokens come
  // from the stream consumer; derive streaming time + throughput here.
  let timing: ProbeTiming | undefined;
  if (
    streamResult.state === "live" &&
    streamResult.ttftMs !== undefined &&
    !streamResult.truncated
  ) {
    const ttftMs = streamResult.ttftMs;
    const tokens = streamResult.tokens ?? 0;
    // Floor the streaming window to STREAM_MS_FLOOR so a near-instant response
    // (TTFT ≈ total) can't produce a nonsense rate. Matches the scale floor.
    const streamMs = Math.max(STREAM_MS_FLOOR, totalMs - ttftMs);
    const tokensPerSec = tokens > 0 ? (tokens / streamMs) * 1000 : 0;
    timing = { ttfbMs, ttftMs, totalMs, tokens, tokensPerSec };
  }

  // Strip the internal stream-only fields (ttftMs/tokens/truncated) before
  // returning the public ProbeResult; the surviving data lives on `timing`.
  const { ttftMs: _ttft, tokens: _tok, truncated: _trunc, ...rest } = streamResult;
  return annotateOAuthHint(
    {
      ...rest,
      latencyMs: totalMs,
      timing,
    },
    link.provider,
    isOAuth
  );
}

/**
 * Attach a login hint when an OAuth provider failed authentication. The
 * `gemini` / `vertex` transports authenticate via cached tokens, so a 401 or
 * a parser error that mentions OAuth usually means the user needs to
 * re-authenticate — surface the exact command instead of leaving them to
 * guess.
 */
function annotateOAuthHint(
  result: ProbeResult,
  provider: string,
  isOAuth: boolean
): ProbeResult {
  if (!isOAuth) return result;
  if (result.state === "live") return result;

  const loginCommand =
    provider === "gemini-codeassist"
      ? "claudish login gemini"
      : provider === "vertex"
        ? "gcloud auth application-default login"
        : undefined;

  if (!loginCommand) return result;

  const looksLikeAuthFailure =
    result.state === "auth-failed" ||
    /auth|token|login|credential|unauthor/i.test(result.errorMessage || "");
  if (!looksLikeAuthFailure) return result;

  return {
    ...result,
    state: "auth-failed",
    actionHint: `run: ${loginCommand}`,
  };
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return "";
  }
}

function classifyHttpError(
  status: number,
  body: string,
  latencyMs: number
): ProbeResult {
  const lowered = body.toLowerCase();
  if (status === 401 || status === 403) {
    return {
      state: "auth-failed",
      latencyMs,
      httpStatus: status,
      errorMessage: extractErrorMessage(body) || `HTTP ${status}`,
    };
  }
  if (status === 404 || /model[_ ]not[_ ]found|no such model|unknown model/.test(lowered)) {
    return {
      state: "model-not-found",
      latencyMs,
      httpStatus: status,
      errorMessage: extractErrorMessage(body) || `HTTP ${status}`,
    };
  }
  if (status === 429) {
    return {
      state: "rate-limited",
      latencyMs,
      httpStatus: status,
      errorMessage: extractErrorMessage(body) || "Rate limited",
    };
  }
  // 402 Payment Required: the credential reached the provider but the
  // account/plan can't be billed — typically an expired subscription or no
  // credit (e.g. a lapsed Kimi Coding plan). NOT an auth bug: the request was
  // authenticated, just not entitled. Keep the generic "error" state but, when
  // the provider sends no message, default to a clear cause instead of a bare
  // "HTTP 402" (the provider's own message still wins when present).
  if (status === 402) {
    return {
      state: "error",
      latencyMs,
      httpStatus: status,
      errorMessage:
        extractErrorMessage(body) || "Payment required — subscription expired or no credit",
    };
  }
  if (status >= 500) {
    return {
      state: "server-error",
      latencyMs,
      httpStatus: status,
      errorMessage: extractErrorMessage(body) || `HTTP ${status}`,
    };
  }
  return {
    state: "error",
    latencyMs,
    httpStatus: status,
    errorMessage: extractErrorMessage(body) || `HTTP ${status}`,
  };
}

function extractErrorMessage(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body);
    const msg =
      parsed?.error?.message ||
      parsed?.error?.error?.message ||
      parsed?.message ||
      parsed?.detail;
    if (typeof msg === "string" && msg.length > 0) {
      return msg.length > 160 ? `${msg.slice(0, 157)}...` : msg;
    }
  } catch {
    // not JSON, fall through
  }
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
}

/**
 * Read the SSE stream just long enough to confirm a valid first content event.
 * We don't accumulate the full response — a single valid data chunk is proof
 * that the entire stack (auth, routing, adapter, transport, parser) works.
 */
/** Internal stream result — carries the extra timing fields that probeLink
 *  folds into ProbeResult.timing. Not part of the public ProbeResult. */
type StreamResult = Omit<ProbeResult, "latencyMs" | "timing"> & {
  /** ms from request start to first content token (only on "live"). */
  ttftMs?: number;
  /** output tokens observed (only on "live"). */
  tokens?: number;
  /** True when the read hit the deadline before the stream closed — totalMs is
   *  the timeout cap, not a real completion, so timing must be omitted. */
  truncated?: boolean;
};

async function consumeProbeStream(
  response: Response,
  timeoutMs: number,
  startedAt: number
): Promise<StreamResult> {
  const body = response.body;
  if (!body) {
    return { state: "error", errorMessage: "empty response body" };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const deadline = Date.now() + timeoutMs;

  // Throughput instrumentation. Unlike before, we now read the FULL (capped)
  // stream so we can measure tokens/sec — we don't bail at the first token.
  let ttftMs: number | undefined;
  let sawContent = false;
  let textChars = 0; // accumulated streamed text length (token estimate fallback)
  let reportedTokens: number | undefined; // exact count from usage, if provided
  let errorVerdict: StreamResult | null = null;
  let completed = false; // true when the stream closed cleanly (not deadline-truncated)

  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      buffered += decoder.decode(value, { stream: true });

      const events = buffered.split("\n\n");
      buffered = events.pop() ?? "";

      for (const event of events) {
        const verdict = interpretSseEvent(event);
        if (verdict && typeof verdict === "object" && verdict.state !== "live") {
          // A hard error event mid-stream — surface it immediately.
          errorVerdict = verdict;
          break;
        }
        // Token accounting from the parsed event.
        const acct = accountStreamEvent(event);
        if (acct.contentDelta) {
          if (ttftMs === undefined) ttftMs = Date.now() - startedAt;
          sawContent = true;
        }
        if (acct.textChars) textChars += acct.textChars;
        if (acct.outputTokens !== undefined) reportedTokens = acct.outputTokens;
      }
      if (errorVerdict) break;
    }
  } catch (e: any) {
    // If we already saw content, a mid-stream read error is non-fatal — the
    // link IS live; we just stop measuring. Otherwise it's a real failure.
    if (!sawContent) {
      return { state: "network-error", errorMessage: String(e?.message || e) };
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }

  if (errorVerdict) return errorVerdict;

  if (sawContent) {
    // Prefer the provider-reported token count; otherwise estimate from text
    // length (~4 chars/token is the common rough heuristic).
    const tokens = reportedTokens ?? Math.max(1, Math.round(textChars / 4));
    // The link IS live (it produced tokens). But if we hit the deadline before
    // the stream closed, totalMs == the timeout cap, NOT a real completion time
    // — building timing from it would poison the shared bar scale with a bogus
    // 40s "slowest". Mark it truncated so probeLink omits the timing breakdown.
    return { state: "live", ttftMs, tokens, truncated: !completed };
  }

  return { state: "error", errorMessage: "stream ended without content" };
}

/**
 * Token-accounting view of one SSE event (Claude `/v1/messages` format — the
 * proxy normalizes every provider to this). Returns whether the event carried
 * a content delta (for TTFT), how much text it added (token estimate), and any
 * exact `output_tokens` usage figure if the provider reported one.
 */
function accountStreamEvent(rawEvent: string): {
  contentDelta: boolean;
  textChars: number;
  outputTokens?: number;
} {
  let dataPayload = "";
  for (const line of rawEvent.split("\n")) {
    if (line.startsWith("data:")) dataPayload += line.slice(5).trim();
  }
  if (!dataPayload || dataPayload === "[DONE]") {
    return { contentDelta: false, textChars: 0 };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(dataPayload);
  } catch {
    return { contentDelta: false, textChars: 0 };
  }

  let textChars = 0;
  let contentDelta = false;

  // Claude content_block_delta: { delta: { type: "text_delta", text: "..." } }
  const text =
    parsed?.delta?.text ??
    (Array.isArray(parsed?.choices) ? parsed.choices[0]?.delta?.content : undefined);
  if (typeof text === "string" && text.length > 0) {
    contentDelta = true;
    textChars = text.length;
  } else if (
    parsed?.type === "content_block_delta" ||
    parsed?.type === "content_block_start"
  ) {
    contentDelta = true;
  }

  // Exact usage: Claude reports cumulative output_tokens on message_delta /
  // message_start.usage; OpenAI-shaped streams put it on a trailing usage chunk.
  const outputTokens =
    parsed?.usage?.output_tokens ??
    parsed?.message?.usage?.output_tokens ??
    parsed?.usage?.completion_tokens;

  return {
    contentDelta,
    textChars,
    outputTokens: typeof outputTokens === "number" ? outputTokens : undefined,
  };
}

type SseVerdict = "live" | Omit<ProbeResult, "latencyMs"> | null;

function interpretSseEvent(rawEvent: string): SseVerdict {
  const lines = rawEvent.split("\n");
  let eventType = "";
  let dataPayload = "";
  for (const line of lines) {
    if (line.startsWith("event:")) eventType = line.slice(6).trim();
    else if (line.startsWith("data:")) dataPayload += line.slice(5).trim();
  }
  if (!dataPayload) return null;
  if (dataPayload === "[DONE]") return null;

  let parsed: any;
  try {
    parsed = JSON.parse(dataPayload);
  } catch {
    return null;
  }

  if (parsed?.type === "error" || eventType === "error" || parsed?.error) {
    const message =
      parsed?.error?.message ||
      parsed?.error?.error?.message ||
      parsed?.message ||
      "provider returned error event";
    const status = parsed?.error?.status || parsed?.status;
    if (typeof status === "number") {
      return {
        state: status === 401 || status === 403 ? "auth-failed" : "error",
        httpStatus: status,
        errorMessage: message,
      };
    }
    return { state: "error", errorMessage: message };
  }

  if (isContentEvent(parsed, eventType)) {
    return "live";
  }
  return null;
}

function isContentEvent(parsed: any, eventType: string): boolean {
  if (eventType === "content_block_start" || eventType === "content_block_delta") return true;
  if (eventType === "message_start") return true;
  if (parsed?.type === "content_block_start") return true;
  if (parsed?.type === "content_block_delta") return true;
  if (parsed?.type === "message_start") return true;
  if (parsed?.type === "message_delta") return true;
  if (Array.isArray(parsed?.choices) && parsed.choices.length > 0) {
    const choice = parsed.choices[0];
    if (choice?.delta || choice?.message || choice?.text || choice?.finish_reason) return true;
  }
  if (parsed?.candidates) return true;
  return false;
}

export function describeProbeState(result: ProbeResult): string {
  switch (result.state) {
    case "live":
      return `live · ${result.latencyMs}ms`;
    case "key-missing":
      return result.errorMessage
        ? `missing (${result.errorMessage})`
        : "missing";
    case "auth-failed":
      return `auth failed · ${result.httpStatus ?? ""}${result.latencyMs ? ` · ${result.latencyMs}ms` : ""}`.trim();
    case "model-not-found":
      return `model not found · ${result.httpStatus ?? ""}${result.latencyMs ? ` · ${result.latencyMs}ms` : ""}`.trim();
    case "rate-limited":
      return `rate limited · ${result.latencyMs}ms`;
    case "server-error":
      return `server error · ${result.httpStatus ?? ""} · ${result.latencyMs}ms`;
    case "timeout":
      return `timeout · ${result.latencyMs}ms`;
    case "network-error":
      return `network error · ${result.latencyMs}ms`;
    case "error":
      return `error${result.httpStatus ? ` · ${result.httpStatus}` : ""}${result.latencyMs ? ` · ${result.latencyMs}ms` : ""}`;
  }
}

export function isReadyState(state: ProbeState): boolean {
  return state === "live";
}

export function isFailureState(state: ProbeState): boolean {
  return (
    state === "auth-failed" ||
    state === "model-not-found" ||
    state === "rate-limited" ||
    state === "server-error" ||
    state === "timeout" ||
    state === "network-error" ||
    state === "error"
  );
}
