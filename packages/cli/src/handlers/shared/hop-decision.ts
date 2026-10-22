/**
 * What a routing chain does after one hop failed: move to the next hop, or stop here.
 *
 * ONE function, {@link decideHopFailure}, shared by the two places that must agree:
 * `FallbackHandler.handle` (the runtime walking a routing chain) and the probe
 * (`probe-live.ts`), which preflight uses to say which hop of a chain would serve. A
 * second copy of the rule is how preflight once reported "drop or replace" for a model
 * whose later hop served (model-failures-2026-10-21.md, D6).
 *
 * The order is the runtime's, and it is the whole point. claudish's own recovery hold
 * and stream-failure marker stop the chain before anything else; a credential verdict
 * holds unless it is a terminal one on a subscription hop; a subscription's rejected
 * credential advances; then `isRetryableError`, whose FIRST statement refuses claudish's
 * connection verdict, so a network fault never walks a subscription user onto metered
 * billing (CLAUDE.md, the five auth sites).
 *
 * Kept apart from `fallback-handler.ts` so the probe can import it without loading
 * `composed-handler.ts` and the adapter stack behind it.
 */
import { extractUpstreamStatus } from "./anthropic-error.js";
import { authVerdict, isCredentialRejection } from "./auth-failure.js";
import { hasQuotaExhaustionWording } from "./quota-exhaustion.js";
import {
  hasRecoveryMarker,
  hasStreamFailureMarker,
  isClaudishConnectionVerdict,
} from "./recovery-marker.js";
import { isSubscriptionProvider } from "./remote-provider-types.js";

/**
 * The marker the proxy puts on a 500 that means a handler THREW instead of answering:
 * the `/v1/messages` catch when the resolved handler threw, and `app.onError` for a
 * rejection that escaped it. Inside a routing chain `FallbackHandler` catches a throw
 * and advances; a probe pins ONE hop, so it gets the 500 instead. Read as a response, a
 * plain 500 is non-retryable, so the probe would say "the chain stops here" for a hop
 * the runtime advances past. The marker lets the probe judge it as `thrown`. It changes
 * nothing for Claude Code: the status, body and envelope are the same.
 */
export const UNHANDLED_ERROR_HEADER = "x-claudish-unhandled-error";

/** Why a chain advanced or stopped at a failed hop. */
export type HopFailureReason =
  /** claudish's own recovery hold (`x-claudish-recovery`): stop, response verbatim. */
  | "recovery-hold"
  /** A stream that failed after a 200 (`x-claudish-stream-failure`): stop, verbatim. */
  | "stream-failure"
  /** A credential verdict that is not a subscription's terminal rejection: stop, verbatim. */
  | "credential-hold"
  /** A subscription's terminal verdict, or its credential rejection in the body: advance. */
  | "subscription-credential-rejected"
  /** `isRetryableError` true: advance. */
  | "retryable"
  /** `isRetryableError` false: stop. */
  | "non-retryable"
  /** The hop's handler threw: advance. */
  | "thrown";

export interface HopFailureDecision {
  action: "advance" | "stop";
  reason: HopFailureReason;
}

export type HopFailureInput =
  | {
      kind: "response";
      status: number;
      headers: Headers;
      body: string;
      /** The claudish provider uid (`kimi-coding`); a billing question is asked of it. */
      provider?: string;
      /** The hop's display name, which some wording rules match. */
      name: string;
    }
  | { kind: "thrown" };

/**
 * The decision `FallbackHandler.handle` makes for a hop that did not answer `ok`, as a
 * pure function. A thrown hop advances, exactly as the handler's `catch` always has.
 */
export function decideHopFailure(input: HopFailureInput): HopFailureDecision {
  if (input.kind === "thrown") return { action: "advance", reason: "thrown" };
  const { status, headers, body, provider, name } = input;

  if (hasRecoveryMarker(headers)) return { action: "stop", reason: "recovery-hold" };
  if (hasStreamFailureMarker(headers)) return { action: "stop", reason: "stream-failure" };

  const connectionFault = isClaudishConnectionVerdict(headers);
  const verdict = authVerdict(headers);
  const subscriptionRejected =
    !connectionFault && verdict === "terminal" && !!provider && isSubscriptionProvider(provider);
  if (verdict && !subscriptionRejected) return { action: "stop", reason: "credential-hold" };

  if (
    subscriptionRejected ||
    (!connectionFault && isSubscriptionCredentialRejection(status, body, provider))
  ) {
    return { action: "advance", reason: "subscription-credential-rejected" };
  }

  if (!isRetryableError(status, body, name, headers, provider)) {
    return { action: "stop", reason: "non-retryable" };
  }
  return { action: "advance", reason: "retryable" };
}

/**
 * A subscription candidate's dead or rejected login, answered WITHOUT the
 * verdict header. The header covers every 401 a ComposedHandler places; this
 * covers a candidate that answers one without it, so the rule holds for every
 * subscription provider and not only for the code paths that mint the header.
 * Asked of the uid — a display name is never a subscription.
 */
export function isSubscriptionCredentialRejection(
  status: number,
  errorBody: string,
  providerId?: string
): boolean {
  if (!providerId || !isSubscriptionProvider(providerId)) return false;
  const recovered = status === 400 ? extractUpstreamStatus(errorBody) : undefined;
  // A credential rejection only: a 401 that says the MODEL is not carried
  // (OpenCode Zen Go's "Model <id> is not supported") is a per-model miss and
  // advances, as it always did (`isCredentialRejection`).
  if ((status === 401 || recovered === 401) && isCredentialRejection(401, errorBody)) {
    return true;
  }
  // A RAW 403 credential rejection counts too (measured: `403
  // {"error":{"type":"invalid_api_key"}}` from a subscription hop advanced
  // onto the metered `meta@`). Raw only: the upstream body still carries the
  // provider's own `error.type`, so `isCredentialRejection` can tell Zen Go's
  // `403 RegionError` (a model opt-in, which advances) from a dead login. A
  // RECOVERED 403 cannot be told apart that way — claudish's remapped 400
  // body says `invalid_request_error` — so it keeps advancing; a 403 the
  // ComposedHandler placed already carries the terminal verdict header.
  return status === 403 && isCredentialRejection(403, errorBody);
}

/**
 * Determine if an HTTP error is retryable (should try next provider).
 * Auth errors, billing errors, rate limits, model-not-found errors and an
 * unavailable endpoint (502/503/504) warrant trying a different provider. A
 * plain 500 does NOT: it may carry account state, and it is the one 5xx a
 * request's own payload can provoke on every provider alike.
 */
export function isRetryableError(
  status: number,
  errorBody: string,
  provider?: string,
  headers?: Headers,
  providerId?: string
): boolean {
  // ── CLAUDISH'S OWN "CANNOT REACH THE HOST" IS NEVER A REASON TO ADVANCE ────
  //
  // FIRST, above the quota wording check, and the ORDER is the whole point.
  // The next statement is `hasQuotaExhaustionWording(errorBody)`, which is
  // deliberately status-agnostic and whose phrase list contains the bare
  // substring "quota" — so one of our own connection verdicts that merely
  // mentioned one would be read as a spent subscription and walk the user onto
  // metered billing in the middle of a network outage. The error text quotes
  // the endpoint HOST and URL, so "merely mentioned" is not hypothetical: a
  // host named `quota-…` reproduced it, and only that word did.
  //
  // BOTH arms, via one predicate. The 503 handoff carries `x-claudish-recovery`
  // and is already returned verbatim by `handle()` above, so for that arm this
  // branch is a second independent mechanism. The 400 arm — every headless run,
  // where no banner can exist — carries `x-claudish-connection-error`, and for
  // IT this branch is the only mechanism there is. Asking the combined
  // predicate rather than either half is what stops chain-safety from being a
  // property of which arm happened to answer.
  if (isClaudishConnectionVerdict(headers)) return false;
  // A stream that failed after a 200 is not a provider's verdict either; see
  // `STREAM_FAILURE_HEADER` in recovery-marker.ts. Above the wording match for
  // the same reason as the line above.
  if (hasStreamFailureMarker(headers)) return false;

  // ── A CREDENTIAL VERDICT: TERMINAL ON A SUBSCRIPTION ADVANCES, ELSE HOLDS ──
  //
  // `ComposedHandler` marks its answer to a credential failure it could place
  // (`auth-failure.ts`): `terminal` — a credential that cannot succeed on
  // retry, answered 400 so the message lands inline — or `transient` — a
  // 5xx/429 on the credential path, which the SAME hop answers on Claude Code's
  // own retry, so the next candidate is the wrong remedy for it. A terminal
  // verdict on a SUBSCRIPTION hop (an expired, wrong or revoked credential)
  // advances to the next hop, metered included (project owner, 2026-10-21:
  // an expired key must not block the chain). A terminal verdict on any other
  // hop still holds. Above the quota wording and the `upstream_status`
  // recovery below, because a terminal 400 carries `upstream_status: 401`,
  // which that recovery reads as retryable whatever the hop.
  const verdict = authVerdict(headers);
  if (verdict) return verdict === "terminal" && !!providerId && isSubscriptionProvider(providerId);

  // A spent subscription allowance is retryable AT THE CHAIN LEVEL: this
  // provider cannot serve, but the next one can.
  //
  // Checked FIRST, and on wording rather than status, because the transport has
  // already decided this is terminal for itself and surfaced it as 400 (see the
  // "terminal errors become 400" doctrine). 400 is otherwise non-retryable, so a
  // status-based check here would stop the chain dead — which is exactly the
  // regression that showed up as a bare `minimax-m2.5` hard-failing while Zen
  // Go's 5-hour window was spent and metered MiniMax stood ready.
  //
  // The billing change this causes is announced rather than prevented — see the
  // warning at the advance site below.
  //
  // A first attempt made them terminal, to stop a user being moved from their
  // subscription onto per-token billing without being told. That was the wrong
  // lever, for two measured reasons:
  //
  //   1. It was unnecessary for the case it was meant to protect. An explicit
  //      `kc@k3` / `zgo@model` spec resolves to exactly ONE candidate, so there
  //      is nothing to advance to and the "Out of quota" error surfaces whatever
  //      this function returns. Terminal only ever affected chains claudish
  //      assembled on the user's behalf.
  //   2. In those chains it cost availability outright. With `opencode-zen-go`
  //      now sitting ahead of the metered APIs, a bare `minimax-m2.5` hard-failed
  //      whenever the Go plan's rolling 5-hour window was spent — a request that
  //      had worked a moment earlier via the metered provider. Verified live:
  //      Zen Go answers `429 GoUsageLimitError "5-hour usage limit reached.
  //      Resets in 3hr 17min"`, and treating that as terminal stopped the chain
  //      dead instead of falling through to a provider that was ready to serve.
  //
  // So the chain advances, and the billing change is made LOUD instead of being
  // prevented at the cost of the request.
  if (hasQuotaExhaustionWording(errorBody)) return true;

  // A SUBSCRIPTION's rejected credential, answered without the verdict header,
  // advances like the terminal verdict above (`handle()` announces it).
  if (isSubscriptionCredentialRejection(status, errorBody, providerId)) return true;

  // ── Recover the ORIGINAL status from a remapped terminal error (#148) ──────
  //
  // `composed-handler` remaps terminal upstream failures (401/403/terminal-429)
  // to 400 BEFORE this handler ever sees them, because a 400 is what makes
  // Claude Code render the reason inline instead of looping on "API error ·
  // Retrying". Each candidate in the chain IS a ComposedHandler, so by the time
  // the status reaches here it is 400, falls into the model-not-found branch
  // below, matches none of its phrases, and the chain STOPS at the first
  // provider.
  //
  // Which inverts the intent exactly. "Terminal" means THIS provider will not
  // recover on retry, and that is precisely when the next one should be tried.
  // The errors that most warrant a fallback were the only ones that could no
  // longer trigger one.
  //
  // The quota half of this was fixed first, by the wording check above — that
  // covers a spent plan, which is the common case. What is left is a genuine
  // credential failure: a revoked or rotated key hard-fails a model that three
  // other credentialed providers in the same chain would have served.
  //
  // Deliberately ADDITIVE. It only ever turns a `false` into a `true`, using
  // the status the upstream actually returned, and falls through to the
  // unchanged status logic when there is no `upstream_status` to recover. A
  // remapped 400 that carries something non-retryable (say an upstream 400) is
  // left to the existing branches, so nothing that used to surface now hides.
  const upstream = status === 400 ? extractUpstreamStatus(errorBody) : undefined;
  if (upstream === 401 || upstream === 403 || upstream === 402 || upstream === 429) {
    return true;
  }

  // Auth errors — different provider might have valid credentials
  if (status === 401 || status === 403) return true;

  // Payment required — billing/credit issue specific to this provider
  if (status === 402) return true;

  // Not found — model doesn't exist on this provider
  if (status === 404) return true;

  // Rate limited — per-provider limit, a different provider may have capacity
  if (status === 429) return true;

  // Unavailable — a gateway or overload answer is about THIS endpoint, not about
  // the model anywhere else. A bare `grok-4.7` stopped at its first candidate on
  // Zen Go's `503 Upstream request failed: Endpoint is unavailable.` while the
  // five candidates behind it answered (`--probe grok-4.7`, 2026-09-24), and
  // Claude Code's retry loop re-sent the same chain to the same dead hop.
  //
  // The old exclusion argued a 503 "cannot silently switch the user off the model
  // they pinned". A pinned `provider@model` builds no FallbackHandler at all
  // (proxy-server: one candidate → its handler directly), so inside a chain that
  // protected nothing. claudish's OWN "cannot reach the host" 503 still holds the
  // chain: the connection-verdict check at the top of this function answers first,
  // and `handle()` returns a recovery-hold response before it gets here.
  if (status === 502 || status === 503 || status === 504) return true;

  const lower = errorBody.toLowerCase();

  // Unprocessable (422) — some providers (OpenRouter) use this for model unavailability
  if (status === 422) {
    if (
      lower.includes("not available") ||
      lower.includes("model not found") ||
      lower.includes("not supported")
    ) {
      return true;
    }
  }

  // Bad request — only retryable if it's a model-not-found variant
  if (status === 400) {
    if (
      lower.includes("model not found") ||
      lower.includes("not registered") ||
      lower.includes("does not exist") ||
      lower.includes("unknown model") ||
      lower.includes("unsupported model") ||
      lower.includes("no healthy deployment") ||
      // Gemini Code Assist config-terminal error (the F1-F7 path returns 400 to
      // surface it inline for an EXPLICIT ag@ selection). But this handler
      // only runs for BARE-NAME auto-routing, where Gemini is just the first
      // candidate — a missing project / revoked-client verdict must advance the
      // chain to the next provider (e.g. OpenRouter), not abort it. When Gemini
      // is the LAST candidate the caller returns this same 400 anyway, so the
      // inline-surface behavior is preserved for the single-provider case.
      lower.includes("requires a google cloud project") ||
      lower.includes("unsupported_client")
    ) {
      return true;
    }

    // Antigravity rejects some SERVED variants at generation time with a
    // generic "Request contains an invalid argument" — `gemini-3.1-pro-high`
    // is in both the account's dynamic models catalog and the cloud models
    // catalog (marked the family default), yet 400s on every call. Without
    // this, a bare `gemini-3.1-pro-*` aborts the whole chain instead of
    // advancing to a provider that works, which is strictly worse than the 404
    // it used to produce.
    //
    // Deliberately scoped to this provider: "invalid argument" is generic
    // enough that a blanket rule would mask real payload bugs elsewhere by
    // silently advancing instead of surfacing them. Still bare-name only — an
    // explicit `ag@` selection has no next candidate, so the caller returns
    // this same 400 and the message reaches the user inline.
    if (provider?.toLowerCase().includes("antigravity") && lower.includes("invalid argument")) {
      return true;
    }

    // An AGGREGATOR reporting that its UPSTREAM rejected the request is terminal
    // for this candidate and says nothing about the next one — the two claims are
    // different, and conflating them costs the chain a provider that works.
    //
    // Zen Go fronts other vendors' models, so a rejection here is the upstream's
    // verdict on the request SHAPE, not on the model's availability anywhere:
    //
    //   {"error":{"type":"server_error","message":"Error from provider (Console
    //    Go): Upstream request failed: [bad_request_error] invalid params,
    //    invalid tool type:  (2013)"}}
    //
    // That wording matches none of the model-not-found tests above, so a bare
    // `minimax-m2.5` died at the first candidate while the metered MiniMax API and
    // OpenRouter sat behind it, credentialed and ready. Same defect class as the
    // spent-subscription case at the top of this function, one axis over: that one
    // separated "exhausted for this provider" from "exhausted for the chain", this
    // one separates "can't serve this request" from "nobody can serve it".
    //
    // Keyed on the aggregator's own framing (`Upstream request failed` / `Error
    // from provider (`) rather than on the upstream's message, which is
    // vendor-specific and unbounded. Provider-scoped for the same reason the
    // Antigravity rule above is: a blanket "advance on any 400" would silently
    // paper over real payload bugs in providers that speak for themselves.
    // NOTE ON THE PROVIDER STRING: what arrives here is the candidate's DISPLAY
    // name ("OpenCode Zen Go"), not the canonical id ("opencode-zen-go") —
    // proxy-server builds candidates as `{ name: candidate.displayName }`. So the
    // match is made on a punctuation-stripped form, which accepts both. The
    // Antigravity rule above only works because its display name happens to be a
    // single word; do not copy its literal shape for a hyphenated provider.
    if (
      isProvider(provider, "opencodezen") &&
      (lower.includes("upstream request failed") || lower.includes("error from provider ("))
    ) {
      return true;
    }
  }

  // Server errors (500) — only retryable if it's a billing/credit issue
  // (some providers misuse 500 for account-level problems)
  if (status === 500) {
    if (
      lower.includes("insufficient balance") ||
      lower.includes("insufficient credit") ||
      lower.includes("quota exceeded") ||
      lower.includes("billing")
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Match a candidate against a provider family, tolerating the two spellings the
 * same provider reaches this file under: the canonical id (`opencode-zen-go`) and
 * the display name (`OpenCode Zen Go`). Both normalize to `opencodezengo`, so a
 * `needle` of `opencodezen` matches either, and both Zen tiers.
 *
 * Exported for tests — the display-name-vs-id distinction is exactly the kind of
 * thing that silently disables a rule.
 */
export function isProvider(provider: string | undefined, needle: string): boolean {
  if (!provider) return false;
  return provider
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .includes(needle);
}
