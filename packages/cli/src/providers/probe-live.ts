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

import { extractUpstreamStatus } from "../handlers/shared/anthropic-error.js";
import {
  hasActionableLink,
  hasModelUnsupportedWording,
} from "../handlers/shared/model-unsupported.js";
import { hasPlanLimitWording } from "../handlers/shared/quota-exhaustion.js";

export type ProbeState =
  | "live"
  | "key-missing"
  | "auth-failed"
  | "model-not-found"
  | "rate-limited"
  | "out-of-credit"
  /**
   * A flat-rate allowance is spent for this cycle. Distinct from
   * `out-of-credit`: the account CAN be billed, the plan window simply has not
   * reset, so the remedy is to wait or upgrade rather than to top up a balance.
   */
  | "plan-limit"
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
const OAUTH_PROVIDERS = new Set(["vertex", "antigravity", "devin"]);
// Ask for a short paragraph so we can sample streaming throughput (tokens/sec).
// Capped to keep probes quick while leaving room for reasoning models that
// spend hidden reasoning tokens BEFORE any visible text: at 64 tokens, models
// like gpt-5-nano burned the whole budget on reasoning → HTTP 200 with zero
// visible content → false FAIL. 512 leaves visible output for every model
// verified while keeping the probe under ~1-3s of generation.
const PROBE_PROMPT = "Count from one to twenty in words, one per line.";
export const PROBE_MAX_TOKENS = 512;

export interface ProbeLinkInput {
  provider: string;
  modelSpec: string;
  hasCredentials: boolean;
  credentialHint?: string;
}

/**
 * Providers whose API validates `output_config.effort` against an enum that has
 * no "minimal". Anthropic's is `low | medium | high | xhigh | max`, and the
 * native passthrough reaches it directly — no adapter clamp in between — so an
 * unmapped "minimal" is a 400 before the request is ever evaluated.
 *
 * "low" rather than omitting the field: the point of setting effort at all is to
 * stop a reasoning model spending the whole probe cap on hidden reasoning and
 * returning 200 with zero visible text. "low" preserves that intent and is
 * accepted (both verified against the live API).
 */
const MINIMAL_EFFORT_UNSUPPORTED = new Set(["native-anthropic", "anthropic"]);

function effortForProvider(provider: string): string {
  return MINIMAL_EFFORT_UNSUPPORTED.has(provider) ? "low" : "minimal";
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
        // Probe-only: force MINIMAL reasoning. A probe just needs a few visible
        // tokens to prove the link is alive — but a reasoning model (e.g.
        // gpt-5-nano) left to its default budget spends the WHOLE probe cap on
        // hidden reasoning before any visible text (HTTP 200, finish=length, 0
        // chars — intermittent FAIL, ~60% in testing). "minimal" zeroes the
        // reasoning budget → deterministic visible output in ~1s (10/10 vs the
        // default's 2/5). The v7.11.0 effort mapping clamps "minimal" per model
        // family. Real user sessions are unaffected — Claude Code builds its own
        // output_config from the user's effort setting; this field is set ONLY
        // here, on the probe request.
        //
        // "non-reasoning/non-OpenAI providers ignore output_config, so this is
        // safe for every probe target" — that used to be written here and is
        // FALSE. The native-anthropic link reaches api.anthropic.com directly,
        // bypassing the effort clamp, and that API validates the enum:
        // `output_config.effort: Input should be 'low', 'medium', 'high',
        // 'xhigh' or 'max'`. Measured 2026-08-18 — "minimal" 400s, "low" and
        // omitting the field both return 200. So EVERY native-anthropic probe
        // failed on the payload before the model id was even considered, which
        // is why that link could never report `live`.
        output_config: { effort: effortForProvider(link.provider) },
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
 *
 * NOT on a 403. `classifyHttpError` buckets 401 and 403 into the same
 * "auth-failed" state, but they answer different questions: 401 is "I don't
 * know who you are" (a credential problem, which logging in fixes) while 403 is
 * "I know who you are and you are not allowed this" (an entitlement problem,
 * which logging in cannot touch). Prescribing a re-login for the second is an
 * actionably WRONG instruction, and the user burns time on the credential
 * they already hold.
 *
 * Both OAuth providers here follow Google's own status mapping, so the code is
 * a reliable discriminator: an expired/absent ADC token is UNAUTHENTICATED/401,
 * while a missing IAM role, a disabled API, or a region gate is
 * PERMISSION_DENIED/403 — `gcloud auth application-default login` does nothing
 * for any of the latter. We key off the status rather than sniffing the body:
 * prose heuristics are the same class of guess that produced the bug this
 * guards against, and `describeProbeState` now renders the provider's own
 * message anyway, so suppressing the hint leaves the real explanation visible.
 */
function annotateOAuthHint(result: ProbeResult, provider: string, isOAuth: boolean): ProbeResult {
  if (!isOAuth) return result;
  if (result.state === "live") return result;

  const loginCommand =
    provider === "antigravity"
      ? "claudish login antigravity"
      : provider === "vertex"
        ? "gcloud auth application-default login"
        : // Not a claudish command: the Devin CLI mints the token and claudish
          // reads its credentials file. Naming `claudish login devin` here
          // would send the user to a command that does not exist.
          provider === "devin"
          ? "devin login"
          : undefined;

  if (!loginCommand) return result;

  // Entitlement failure — re-authenticating cannot fix it, so no hint.
  if (result.httpStatus === 403) return result;

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

// `extractUpstreamStatus` used to live here as a private copy. It is shared with
// `fallback-handler.ts` now (#148), because both have to read the same field to
// tell a remapped terminal error apart from a real 400, and two private readers
// of one wire field is how they drift.

/**
 * Pull the Anthropic error `type` (e.g. "connection_error") out of a proxy error
 * body so classification can distinguish a local connection failure from a
 * same-status upstream error (a transient upstream 503 is "server_error"/
 * "overloaded_error", a proxy-side reach failure is "connection_error").
 */
function extractErrorType(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body);
    const t = parsed?.error?.type;
    return typeof t === "string" ? t : undefined;
  } catch {
    return undefined;
  }
}

export function classifyHttpError(status: number, body: string, latencyMs: number): ProbeResult {
  const lowered = body.toLowerCase();
  // A proxy-side connection failure (DNS unresolved, connection refused, host
  // unreachable) is tagged by composed-handler as a 503 connection_error. That's
  // a LOCAL network problem, not an upstream server error — classify it as
  // network-error so the row reads "network error" with the proxy's actionable
  // message ("check your network/DNS") instead of a generic "server error · 503".
  if (extractErrorType(body) === "connection_error") {
    return {
      state: "network-error",
      latencyMs,
      httpStatus: status,
      errorMessage: extractErrorMessage(body) || "Cannot reach provider",
    };
  }
  // A remapped terminal error carries the real upstream code — classify (and
  // display) by THAT, not the proxy's 400 wrapper.
  const upstream = status === 400 ? extractUpstreamStatus(body) : undefined;
  if (status === 401 || status === 403 || upstream === 401 || upstream === 403) {
    const authStatus = upstream ?? status;
    // An auth-shaped status does NOT prove an auth problem. OpenCode Zen Go
    // answers 401 with "Model <id> is not supported" for models it does not
    // carry — measured with a real key, where `zgo@deepseek-v4-pro-0813` 401s
    // while `zgo@kimi-k3` on the SAME key returns 200. Reporting that as
    // `auth-failed` sent the user to check a credential that was working, and
    // buried the live OpenRouter hop sitting further down the same chain.
    //
    // Classified from the BODY, using the same predicate composed-handler's hint
    // uses, so the state and the explanation cannot disagree about one response.
    // The status is preserved: it is what the provider really said, and rewriting
    // it would hide the provider's misuse of 401 rather than explain it.
    if (hasModelUnsupportedWording(body)) {
      return {
        state: "model-not-found",
        latencyMs,
        httpStatus: authStatus,
        errorMessage: extractErrorMessage(body) || `HTTP ${authStatus}`,
      };
    }
    // Nor is it an auth failure when the provider handed back a link to act on.
    // Measured: Zen Go answers a model the account has not opted into with
    // `403 RegionError … requires explicit opt in: <url>` — the credential is
    // fine, the model IS in its live roster, and the fix is a click. Reporting
    // `auth-failed` there points the user at a working key. `error` keeps the
    // failure semantics (it is in `isFailureState`) without the false cause.
    if (hasActionableLink(body)) {
      return {
        state: "error",
        latencyMs,
        httpStatus: authStatus,
        errorMessage: extractErrorMessage(body) || `HTTP ${authStatus}`,
      };
    }
    return {
      state: "auth-failed",
      latencyMs,
      httpStatus: authStatus,
      errorMessage: extractErrorMessage(body) || `HTTP ${authStatus}`,
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
    // A 429 is the channel for BOTH transient throttling and a spent flat-rate
    // allowance, so the status alone cannot tell them apart — only the body can.
    // MiniMax Coding answers `429 "Token Plan usage limit reached: Upgrade your
    // Token Plan or purchase Credits for more usage. (2056)"`, which is a plan
    // window, not throttling: retrying in a second cannot help, and the TUI
    // treats throttling as healthy. Wording-gated, so an ordinary throttle with
    // no allowance vocabulary still reads as "rate limited".
    if (hasPlanLimitWording(body)) {
      return {
        state: "plan-limit",
        latencyMs,
        httpStatus: status,
        errorMessage: extractErrorMessage(body) || "Plan allowance spent for this cycle",
      };
    }
    return {
      state: "rate-limited",
      latencyMs,
      httpStatus: status,
      errorMessage: extractErrorMessage(body) || "Rate limited",
    };
  }
  // Out-of-credit, two wire shapes with the same meaning:
  //  - upstream 429 remapped by the proxy: the proxy only remaps TERMINAL 429s
  //    (quota/balance exhaustion per isTerminalError — e.g. Moonshot "suspended
  //    due to insufficient balance", Z.AI code 1113); transient throttling 429s
  //    pass through unremapped and stay "rate-limited" above.
  //  - a direct 402 Payment Required (e.g. a lapsed Kimi Coding plan).
  // NOT an auth bug: the request authenticated fine, the account just can't be
  // billed. Distinct from "rate-limited" because the TUI treats throttling as
  // healthy ("throttled" note) — an exhausted account must read as a failure
  // with an honest cause instead of an opaque "error · 400".
  if (upstream === 429 || status === 402) {
    // Same fork as the raw 429 above, on the remapped shape. This is the path a
    // TUI probe takes, because the proxy turns a terminal 429 into a 400 that
    // carries the real upstream status. A spent SUBSCRIPTION reaching the user
    // as "out of credit" is actively misleading: it sends a flat-rate user to a
    // billing page to fix a plan that is working and resets on its own.
    //
    // 402 is deliberately NOT forked. It means Payment Required, which is a
    // balance fact whatever wording rides along with it.
    if (status !== 402 && hasPlanLimitWording(body)) {
      return {
        state: "plan-limit",
        latencyMs,
        httpStatus: upstream ?? status,
        errorMessage: extractErrorMessage(body) || "Plan allowance spent for this cycle",
      };
    }
    return {
      state: "out-of-credit",
      latencyMs,
      httpStatus: upstream ?? status,
      errorMessage:
        extractErrorMessage(body) || "Out of credit — account balance or plan exhausted",
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

/**
 * Shorten a provider message WITHOUT severing a URL.
 *
 * A cap is necessary — but a blind cut removed the only actionable part of Zen
 * Go's region error, leaving "…requires explicit opt in:
 * https://opencode.ai/workspa..." on screen. The user is told there is a
 * specific fix and then denied the address of it. So the link is kept whole and
 * the PROSE around it absorbs the cut instead.
 *
 * The cap is sized for the WIDEST consumer, not the narrowest. It was 160,
 * chosen when the only consumer was a one-line probe row — but every consumer
 * now bounds itself (the row clips to its column, the TUI detail panel wraps to
 * 2 lines, `probe-results-printer` word-wraps to `MAX_ERROR_LINES` 4), so 160
 * was no longer protecting a layout, only deleting text. It cut MiniMax
 * Coding's `429 "Token Plan usage limit reached: Upgrade your Token Plan or
 * purchase Credits for more usage. (2056)"` at "Upgrade you..." — losing the
 * remedy, which is the only part of the sentence the user can act on.
 */
function truncateKeepingLink(text: string, max = 400): string {
  if (text.length <= max) return text;
  const url = text.match(/https?:\/\/\S+/i)?.[0];
  if (!url) return `${text.slice(0, max - 3)}...`;
  // Reserve room for the link plus the ellipsis joining it to the trimmed prose.
  const room = max - url.length - 4;
  if (room <= 0) return url;
  // Cut at a word boundary — the prose is being sacrificed for the link, so it
  // should at least end on a whole word rather than "follow the l...".
  const head = text.slice(0, room);
  const lastSpace = head.lastIndexOf(" ");
  const prose = (lastSpace > room * 0.5 ? head.slice(0, lastSpace) : head).trimEnd();
  return `${prose}... ${url}`;
}

function extractErrorMessage(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body);
    const msg =
      parsed?.error?.message || parsed?.error?.error?.message || parsed?.message || parsed?.detail;
    if (typeof msg === "string" && msg.length > 0) {
      return truncateKeepingLink(msg);
    }
  } catch {
    // not JSON, fall through
  }
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  return truncateKeepingLink(trimmed);
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
  let stopReason: string | undefined; // last stop/finish reason seen on the stream
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
        if (acct.stopReason) stopReason = acct.stopReason;
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

  // Contentless 200: distinguish token-budget exhaustion from a genuinely dead
  // stream. Reasoning models can burn the whole probe budget on hidden
  // reasoning — the stream signals it either with an explicit truncation stop
  // reason ("max_tokens"/"length") or with usage that consumed the full cap.
  //
  // The explicit reason is now the normal path: openai-sse and gemini-sse both
  // map upstream truncation to "max_tokens" (they previously hardcoded
  // "end_turn", which is why the usage-based fallback below was written). Keep
  // the fallback — it still covers providers that report usage but no
  // finish_reason. A self-explaining message beats a bare "stream ended without
  // content" for what is really a budget artifact, not a dead link.
  const truncationReason =
    stopReason === "max_tokens" || stopReason === "length" ? stopReason : undefined;
  if (truncationReason || (reportedTokens !== undefined && reportedTokens >= PROBE_MAX_TOKENS)) {
    const cause = truncationReason
      ? `finish: ${truncationReason}`
      : `${reportedTokens} tokens consumed, none visible`;
    return {
      state: "error",
      errorMessage: `no visible output within probe budget (${cause})`,
    };
  }

  return { state: "error", errorMessage: "stream ended without content" };
}

/**
 * Token-accounting view of one SSE event (Claude `/v1/messages` format — the
 * proxy normalizes every provider to this). Returns whether the event carried
 * a content delta (for TTFT), how much text it added (token estimate), any
 * exact `output_tokens` usage figure, and any stop/finish reason the provider
 * reported (used to explain contentless budget-truncated streams).
 */
function accountStreamEvent(rawEvent: string): {
  contentDelta: boolean;
  textChars: number;
  outputTokens?: number;
  stopReason?: string;
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
  } else if (parsed?.type === "content_block_delta" || parsed?.type === "content_block_start") {
    contentDelta = true;
  }

  // Exact usage: Claude reports cumulative output_tokens on message_delta /
  // message_start.usage; OpenAI-shaped streams put it on a trailing usage chunk.
  const outputTokens =
    parsed?.usage?.output_tokens ??
    parsed?.message?.usage?.output_tokens ??
    parsed?.usage?.completion_tokens;

  // Claude message_delta carries delta.stop_reason; OpenAI-shaped streams put
  // finish_reason on the choice.
  const stopReason =
    parsed?.delta?.stop_reason ??
    (Array.isArray(parsed?.choices) ? parsed.choices[0]?.finish_reason : undefined);

  return {
    contentDelta,
    textChars,
    outputTokens: typeof outputTokens === "number" ? outputTokens : undefined,
    stopReason: typeof stopReason === "string" ? stopReason : undefined,
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

/**
 * Append the upstream's own explanation to a status line when we have one.
 *
 * Every failure state carries the provider's `errorMessage`, but only "error"
 * used to render it — the status-bearing states printed the code and threw the
 * message away. That silently hid the one sentence that says what to DO: an
 * OpenCode Zen Go probe against a region-locked model answered 403 with
 * "only available hosted in China and requires explicit opt in: <url>", and the
 * row read a bare "auth failed · 403" on a key that was working fine. A 4xx is
 * a bucket, not a diagnosis; the body is the diagnosis.
 */
function withDetail(base: string, message?: string): string {
  return message ? `${base} — ${message}` : base;
}

export function describeProbeState(result: ProbeResult): string {
  const status = result.httpStatus ?? "";
  const latency = result.latencyMs ? ` · ${result.latencyMs}ms` : "";
  switch (result.state) {
    case "live":
      return `live · ${result.latencyMs}ms`;
    case "key-missing":
      return result.errorMessage ? `missing (${result.errorMessage})` : "missing";
    case "auth-failed":
      return withDetail(`auth failed · ${status}${latency}`.trim(), result.errorMessage);
    case "model-not-found":
      return withDetail(`model not found · ${status}${latency}`.trim(), result.errorMessage);
    case "rate-limited":
      return withDetail(`rate limited · ${result.latencyMs}ms`, result.errorMessage);
    case "out-of-credit":
      return withDetail(`out of credit · ${status}${latency}`.trim(), result.errorMessage);
    case "plan-limit":
      // "plan limit reached", not "out of credit": the account can be billed,
      // the allowance simply has not reset. The provider's own sentence follows,
      // and it is the part that names the plan and the way out.
      return withDetail(`plan limit reached · ${status}${latency}`.trim(), result.errorMessage);
    case "server-error":
      return withDetail(`server error · ${status} · ${result.latencyMs}ms`, result.errorMessage);
    case "timeout":
      return withDetail(`timeout · ${result.latencyMs}ms`, result.errorMessage);
    case "network-error":
      return withDetail(`network error · ${result.latencyMs}ms`, result.errorMessage);
    case "error": {
      // Append the specific cause when present. Without this, a contentless
      // stream (e.g. a reasoning model that spent its whole budget before any
      // visible text — HTTP 200, so no status code) rendered as a bare
      // "error · Nms" with the explanatory errorMessage silently dropped.
      const base = `error${result.httpStatus ? ` · ${result.httpStatus}` : ""}${latency}`;
      return withDetail(base, result.errorMessage);
    }
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
    state === "out-of-credit" ||
    state === "plan-limit" ||
    state === "server-error" ||
    state === "timeout" ||
    state === "network-error" ||
    state === "error"
  );
}
