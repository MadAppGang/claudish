/**
 * The one header that makes recovery chain-safety STRUCTURAL rather than a
 * wording rule.
 *
 * ## What it is for
 *
 * When a tier-1 hold exhausts its deadline with a surface still painting the
 * reason, `ComposedHandler` answers **503 `overloaded_error`** instead of
 * today's terminal 400, so Claude Code re-POSTs and the turn survives into
 * tier 2. That status then has to travel past `FallbackHandler`, and the
 * fallback chain is where a mistake here costs the user real money rather than
 * time: advancing off a `SUBSCRIPTION_PROVIDERS` candidate onto a metered one
 * quotes a per-token price for a fault that had nothing to do with the
 * provider.
 *
 * ## Why a header and not a status, and not a wording rule
 *
 * The status cannot carry it: `fallback-handler.ts`'s `isRetryableError`
 * ADVANCES the chain on a 503 (an upstream "endpoint unavailable" is about one
 * endpoint), so this marker is the only thing that holds the chain for a
 * recovery 503. Before that branch existed a 503 stopped the chain on status
 * alone, and even then that was NOT enough, twice over:
 *
 * 1. **The FIRST statement in its body is `hasQuotaExhaustionWording(errorBody)`,
 *    which is deliberately status-agnostic** — it exists because the transport
 *    has already remapped terminal errors to 400, so a status-gated test there
 *    would miss a spent plan. Its phrase list contains the **bare substring
 *    `"quota"`**, plus `"usage limit"`, `"plan limit"`, `"daily limit"`,
 *    `"billing cycle"`, `"credit balance"`, `"out of credits"` and
 *    `"exceeded your current"`. A 503 whose MESSAGE happens to trip that list
 *    advances the chain and spends the user's money. Checking the marker FIRST
 *    removes the message from the decision entirely.
 * 2. **A 503 does not necessarily reach the client.** When a candidate's error
 *    is not retryable and earlier candidates already failed, `handle()` pushes
 *    it and calls `formatCombinedError`, whose status comes from
 *    `exhaustedChainStatus(errors)` — 503 only if EVERY accumulated error is
 *    transient. One earlier auth/404 failure turns our 503 into a terminal 400
 *    and tier 2 never begins. The marker makes the response return VERBATIM
 *    before it can be folded into a combined one.
 *
 * ## Why it cannot be forged by an upstream provider
 *
 * The marker is only ever minted on a `Response` this process constructs, and
 * verified at source (2026-09-11):
 *
 * - every non-ok exit from `ComposedHandler` is `c.json(...)` — Hono builds
 *   those headers from nothing, so an upstream's headers are never copied onto
 *   a failure response. The single `c.header()` call in that file
 *   (`X-Dropped-Params`) sits AFTER the `!response.ok` early returns;
 * - the one path that DOES copy upstream headers verbatim,
 *   `stream-head-sniffer.ts`'s `replayResponse()`, is reachable only from step
 *   7b, which runs after `!response.ok` has already returned — i.e. on a 200.
 *   `FallbackHandler` returns an ok response as success before it ever looks at
 *   the marker, so a forged one on a 200 changes nothing.
 *
 * Keep both properties true. If a future edit returns an upstream `Response`
 * object on a non-ok path, the markers must be stripped there.
 *
 * Both markers below rest on exactly this argument, and both are minted at a
 * `c.json(...)` call whose headers Hono builds from nothing.
 */

/** The header name. Referenced by name in no other file — import this. */
export const RECOVERY_MARKER_HEADER = "x-claudish-recovery";

/** The only value that counts. Anything else is not our response. */
export const RECOVERY_MARKER_VALUE = "1";

/**
 * The SECOND marker, and the reason it exists rather than the first one being
 * reused.
 *
 * ── THE DEFECT IT CLOSES (found by a black-box contract test, F-2) ──────────
 *
 * `x-claudish-recovery` is minted on ONE arm: the 503 handoff, which requires a
 * valid UI lease. When a hold exhausts with no banner — `-p`, `--no-recovery`,
 * CI, any machine without magmux, i.e. EVERY headless run — the answer is a 400
 * `connection_error` and there was no marker at all. `isRetryableError` then
 * fell through to its first real statement, `hasQuotaExhaustionWording`, whose
 * phrase list contains the bare substring `"quota"` — and the error text of a
 * connection failure quotes the ENDPOINT HOST AND URL verbatim. A host named
 * `quota-exceeded…` (or any URL containing the word) was therefore read as a
 * spent subscription, and the chain ADVANCED off a possibly-subscription
 * candidate onto a metered one in the middle of a network outage. Measured:
 * candidate 2's own socket served the client; `insufficient-credits` and
 * `rate-limit` in the same position did not reproduce it, so the variable
 * really was the word.
 *
 * The guarantee the two markers hold together, and the shape of it matters:
 *
 * > **A connection-failure response from this feature never advances the
 * > fallback chain — regardless of its STATUS, its MESSAGE, or whether a banner
 * > was attached.**
 *
 * Chain-safety must not be a property of the arm that happened to answer. The
 * 503 arm's marker made it structural in one arm only, which is worse than
 * obvious to review: the guard reads as present, and it is present, but exactly
 * where the money is at stake — a run with no surface — it is not minted.
 *
 * ── WHY NOT SIMPLY MINT `x-claudish-recovery` ON BOTH ARMS ──────────────────
 *
 * Because the two facts are different, and one of them is load-bearing
 * elsewhere. `x-claudish-recovery` means "the retry was HANDED BACK; re-POST
 * and you will rejoin the same episode" — `FallbackHandler` returns such a
 * response VERBATIM, before reading the body, so `formatCombinedError` cannot
 * demote its 503 to a terminal 400. A 400 has nothing handed back and must
 * still be foldable into a combined chain error, which is where the user reads
 * what every candidate did. Same guarantee, two facts, two headers.
 */
export const CONNECTION_FAULT_HEADER = "x-claudish-connection-error";

/**
 * The headers a tier-1 exhaustion 503 carries.
 *
 * `x-should-retry` is read by the Anthropic TS SDK's `shouldRetry` before it
 * looks at the status at all, so it survives a future change to Claude Code's
 * status classification. It is set ONLY on this arm.
 */
export function recoveryHoldHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-should-retry": "true",
    [RECOVERY_MARKER_HEADER]: RECOVERY_MARKER_VALUE,
  };
}

/**
 * The headers claudish's own "could not reach the host" 400 carries.
 *
 * Deliberately NOT `recoveryHoldHeaders()`: no `x-should-retry`, because
 * nothing was handed back, and no `x-claudish-recovery`, because that header
 * means "handed back" and `FallbackHandler` returns anything wearing it
 * verbatim — which would silently drop the other candidates' reasons out of a
 * combined chain error.
 *
 * `content-type` is left to the caller's `c.json`, which sets it.
 */
export function connectionFaultHeaders(): Record<string, string> {
  return { [CONNECTION_FAULT_HEADER]: RECOVERY_MARKER_VALUE };
}

/** Does this header bag carry the marker? Tolerates `undefined` for callers that have none. */
export function hasRecoveryMarker(headers: Headers | undefined | null): boolean {
  try {
    return headers?.get(RECOVERY_MARKER_HEADER) === RECOVERY_MARKER_VALUE;
  } catch {
    // A synthesised response with a non-Headers `headers` field. Not ours.
    return false;
  }
}

/** Does this header bag carry the connection-fault marker? */
export function hasConnectionFaultMarker(headers: Headers | undefined | null): boolean {
  try {
    return headers?.get(CONNECTION_FAULT_HEADER) === RECOVERY_MARKER_VALUE;
  } catch {
    return false;
  }
}

/**
 * Is this claudish's own verdict that it could not reach the host — on EITHER
 * arm?
 *
 * The one predicate the chain-safety rule is written in terms of, so the rule
 * cannot again be true of one arm and false of the other. A caller asking "may
 * I advance past this?" must ask THIS, never one of the two halves.
 */
export function isClaudishConnectionVerdict(headers: Headers | undefined | null): boolean {
  return hasRecoveryMarker(headers) || hasConnectionFaultMarker(headers);
}

/** Is this response claudish's own recovery-exhaustion 503? */
export function isRecoveryHoldResponse(
  response: { headers?: Headers } | null | undefined
): boolean {
  return hasRecoveryMarker(response?.headers);
}

/**
 * The THIRD marker: a stream that failed AFTER claudish flushed a 200.
 *
 * Once a stream parser has sent `message_start`, the only way left to report a
 * failure is an SSE `error` event; Claude Code then discards the message and
 * retries the turn. A NON-streamed request (`stream` absent or false) has no
 * SSE: `sseResponseToJson` folds the parser's events into one JSON answer, and
 * it answers such a failure with the Anthropic error body for the event's own
 * error type. That answer must behave like the streamed form of the same
 * failure, which never reaches `FallbackHandler` as an error at all:
 *
 * - it is not a provider's verdict on the request (the provider already
 *   answered 200), so it must never ADVANCE a routing chain. A status rule
 *   cannot hold it: a leg error quotes the upstream body, and
 *   `isRetryableError` reads quota wording before any status;
 * - it must not be FOLDED by `formatCombinedError` with earlier candidates'
 *   errors either, which would replace its status.
 *
 * So `FallbackHandler.handle` returns a response carrying this header verbatim
 * before reading the body, and `isRetryableError` answers `false` for it as its
 * first statement. Unforgeable by the argument at the top of this file:
 * `sseResponseToJson` builds a new `Response` whose headers start empty, and no
 * upstream header is ever copied onto it.
 */
export const STREAM_FAILURE_HEADER = "x-claudish-stream-failure";

/** The headers the collector's stream-failure answer carries. */
export function streamFailureHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    [STREAM_FAILURE_HEADER]: RECOVERY_MARKER_VALUE,
  };
}

/** Does this header bag carry the stream-failure marker? */
export function hasStreamFailureMarker(headers: Headers | undefined | null): boolean {
  try {
    return headers?.get(STREAM_FAILURE_HEADER) === RECOVERY_MARKER_VALUE;
  } catch {
    return false;
  }
}

/** Is this response a non-streamed turn whose stream ended on an SSE `error`? */
export function isStreamFailureResponse(
  response: { headers?: Headers } | null | undefined
): boolean {
  return hasStreamFailureMarker(response?.headers);
}
