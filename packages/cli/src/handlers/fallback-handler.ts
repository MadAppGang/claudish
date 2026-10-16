/**
 * FallbackHandler — tries multiple providers in priority order.
 *
 * When the primary provider fails with a retryable error (auth, not found),
 * it falls through to the next provider in the chain.
 *
 * Used for auto-routed models (no explicit provider@ prefix) where multiple
 * providers might serve the same model. Priority order:
 *   LiteLLM → Subscription (Zen) → Native API → OpenRouter
 */

import type { Context } from "hono";
import { logStderr } from "../logger.js";
import { ComposedHandler } from "./composed-handler.js";
import { extractUpstreamStatus } from "./shared/anthropic-error.js";
import { authVerdict, isCredentialRejection } from "./shared/auth-failure.js";
import { hasQuotaExhaustionWording } from "./shared/quota-exhaustion.js";
import { isClaudishConnectionVerdict, isRecoveryHoldResponse } from "./shared/recovery-marker.js";
import { isSubscriptionProvider } from "./shared/remote-provider-types.js";
import type { ModelHandler } from "./types.js";

export interface FallbackCandidate {
  /** Human-readable provider name for logging */
  name: string;
  /**
   * The claudish provider uid (`kimi-coding`), when the caller knows it. `name`
   * is a DISPLAY name, so a billing question asked of it answers for nobody:
   * `isSubscriptionProvider("Kimi Coding")` is false.
   */
  provider?: string;
  /** The handler to try */
  handler: ModelHandler;
}

export class FallbackHandler implements ModelHandler {
  private candidates: FallbackCandidate[];
  /** Index of the last provider that successfully handled a request. */
  private lastSuccessIndex = 0;

  constructor(candidates: FallbackCandidate[]) {
    this.candidates = candidates;
  }

  // INVARIANT: Each candidate handler (ComposedHandler) must NOT mutate the Hono
  // Context `c` (e.g., c.header()) before returning a non-ok Response. Currently
  // ComposedHandler only calls c.header() in the success path (after response.ok),
  // so passing the same `c` to multiple handlers is safe. If ComposedHandler ever
  // changes to set headers before checking response.ok, this would need revisiting.
  async handle(c: Context, payload: any): Promise<Response> {
    const errors: Array<{ provider: string; status: number; message: string }> = [];
    const startIndex = this.lastSuccessIndex;

    for (let attempt = 0; attempt < this.candidates.length; attempt++) {
      const idx = (startIndex + attempt) % this.candidates.length;
      const { name, handler, provider } = this.candidates[idx];
      const isLast = attempt === this.candidates.length - 1;

      try {
        // If previous attempts failed, signal the winning handler to include fallback metadata
        // in its own stats event. This avoids a duplicate stats event with incomplete data.
        if (errors.length > 0 && handler instanceof ComposedHandler) {
          try {
            handler.setFallbackMeta(
              this.candidates.map((c) => c.name),
              errors.length
            );
          } catch {
            // Stats must never crash claudish
          }
        }

        const response = await handler.handle(c, payload);

        // Success — cache the working provider index and return immediately
        if (response.ok) {
          this.lastSuccessIndex = idx;
          if (errors.length > 0) {
            logStderr(`[Fallback] ${name} succeeded after ${errors.length} failed attempt(s)`);
            // Update status bar to show the actual provider used
            if (handler instanceof ComposedHandler) {
              handler.getTokenTracker()?.setProviderDisplayName(name);
            }
          }
          return response;
        }

        // ── THE RECOVERY MARKER, CHECKED BEFORE THE BODY IS EVEN READ ─────────
        //
        // A recovery-exhaustion 503 is OUR status, not an upstream one. It says
        // "claudish held this request for its whole deadline, could not reach
        // the host, and a surface is painting that fact" — so it must leave
        // this handler UNTOUCHED, for two separate reasons:
        //
        //   1. It is not a reason to advance the chain. During a network outage
        //      the next candidate is unreachable for the same reason, so the
        //      chain would burn every candidate — and per the standing CLAUDE.md
        //      invariant, advancing off a SUBSCRIPTION_PROVIDERS candidate onto
        //      a metered one quotes the user a real per-token price for a fault
        //      that had nothing to do with any provider.
        //   2. It must not be FOLDED into a combined error either. Below,
        //      `formatCombinedError` emits `exhaustedChainStatus(errors)`, which
        //      returns 503 only if EVERY accumulated error is transient — so one
        //      earlier auth/404 failure would turn our 503 into a terminal 400,
        //      Claude Code would never re-POST, and tier 2 would never begin.
        //
        // Returning it verbatim answers both at once. This is a HEADER and not a
        // status, so the "read the upstream status via `extractUpstreamStatus`,
        // never the wire status" doctrine is untouched. It cannot be forged by
        // an upstream — see `recovery-marker.ts` for the two source facts that
        // make that structural rather than hopeful.
        //
        // NOT a wording rule, and that is the whole point: `isRetryableError`'s
        // first statement is a status-agnostic phrase match whose list contains
        // the bare substring "quota", so a 503 whose message merely MENTIONED a
        // quota would have advanced the chain and spent the user's money.
        if (isRecoveryHoldResponse(response)) {
          logStderr(
            `[Fallback] ${name} is unreachable and claudish is still retrying it — ` +
              "holding the chain here rather than switching providers mid-outage."
          );
          return response;
        }

        // Clone before reading body so we can still return the original if needed
        const errorBody = await response.clone().text();

        // Non-retryable error (rate limit, server error, bad format) — stop trying
        if (!isRetryableError(response.status, errorBody, name, response.headers, provider)) {
          if (errors.length > 0) {
            // We had previous fallback attempts; show combined error
            errors.push({ provider: name, status: response.status, message: errorBody });
            return this.formatCombinedError(c, errors, payload.model);
          }
          // First and only attempt — return original response as-is
          return response;
        }

        // Retryable (auth/not-found) — log and try next provider
        errors.push({ provider: name, status: response.status, message: errorBody });
        if (!isLast) {
          // Advancing past a SPENT SUBSCRIPTION is not the same event as
          // advancing past a bad credential, even though both are retryable: the
          // next candidate bills per token, so the user's cost model just
          // changed. They did not choose that — claudish assembled this chain —
          // so it is said out loud rather than buried in a generic line.
          // Wording, not status — same reason as the retryability check: by here
          // a terminal 429 has been remapped to 400, so a status-gated test
          // would advance SILENTLY and lose exactly the notice this exists for.
          if (hasQuotaExhaustionWording(errorBody)) {
            logStderr(
              `[Fallback] ${name} subscription allowance is spent — falling through to the next provider, which is billed PER TOKEN. Use a provider prefix (e.g. \`zgo@model\`) to fail instead of switching.`
            );
          } else {
            logStderr(
              `[Fallback] ${name} failed (HTTP ${response.status}), trying next provider...`
            );
          }
        }
      } catch (err: any) {
        errors.push({ provider: name, status: 0, message: err.message });
        if (!isLast) {
          logStderr(`[Fallback] ${name} error: ${err.message}, trying next provider...`);
        }
      }
    }

    // All providers failed
    return this.formatCombinedError(c, errors, payload.model);
  }

  private formatCombinedError(
    c: Context,
    errors: Array<{ provider: string; status: number; message: string }>,
    modelName?: string
  ): Response {
    const summary = errors
      .map(
        (e) =>
          `  ${e.provider}: HTTP ${e.status || "ERR"} — ${truncate(parseErrorMessage(e.message), 150)}`
      )
      .join("\n");

    logStderr(
      `[Fallback] All ${errors.length} provider(s) failed for ${modelName || "model"}:\n${summary}`
    );

    return c.json(
      {
        error: {
          type: "all_providers_failed",
          message: `All ${errors.length} providers failed for model '${modelName || "unknown"}'`,
          attempts: errors.map((e) => ({
            provider: e.provider,
            status: e.status,
            error: truncate(parseErrorMessage(e.message), 200),
          })),
        },
      },
      exhaustedChainStatus(errors) as any
    );
  }

  async shutdown(): Promise<void> {
    for (const { handler } of this.candidates) {
      if (typeof handler.shutdown === "function") {
        await handler.shutdown();
      }
    }
  }
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

  // ── A CREDENTIAL VERDICT IS NEVER A REASON TO ADVANCE EITHER ──────────────
  //
  // `ComposedHandler` marks its answer to a credential failure it could place
  // (`auth-failure.ts`): `terminal` — a subscription login that cannot succeed
  // on retry, answered 400 so the message lands inline — or `transient` — a
  // 5xx/429 on the credential path, which the SAME hop answers on Claude Code's
  // own retry. Either way the next candidate is the wrong remedy, and for a
  // subscription it is a metered one (project owner, 2026-10-16). Above the
  // quota wording and the `upstream_status` recovery below, because a terminal
  // 400 carries `upstream_status: 401`, which that recovery reads as retryable.
  if (authVerdict(headers)) return false;

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

  // A SUBSCRIPTION's 401 stops the chain whatever its transport answered. The
  // verdict header above covers every 401 a ComposedHandler places; this covers
  // a candidate that answers one without it, so the rule holds for every
  // subscription provider and not only for the code paths that mint the header.
  // AFTER the quota wording: a spent allowance still advances, with its warning.
  // Asked of the uid — a display name is never a subscription.
  if (providerId && isSubscriptionProvider(providerId)) {
    const recovered = status === 400 ? extractUpstreamStatus(errorBody) : undefined;
    // A credential rejection only: a 401 that says the MODEL is not carried
    // (OpenCode Zen Go's "Model <id> is not supported") is a per-model miss and
    // advances, as it always did (`isCredentialRejection`).
    if ((status === 401 || recovered === 401) && isCredentialRejection(401, errorBody)) {
      return false;
    }
  }

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
 * The status an EXHAUSTED chain reports — terminal 400, or transient 503.
 *
 * This used to be a flat 502, which reads to Claude Code as a retryable transport
 * fault: it shows "API error · Retrying · attempt N/10" and the turn ends with NO
 * visible text. A chain of ONE never took this path at all — the single candidate's
 * response is returned as-is, so a 400 reached the client and Claude Code rendered
 * the reason inline (`API Error: 400 Error from provider (Console Go): …`, captured
 * verbatim in a real session's output.log). Measured side by side against a stub
 * replaying that 400: single candidate → HTTP 400 with the message; two candidates
 * → HTTP 502 with no usable text.
 *
 * That gap did not matter much while chains were built only for interactive
 * bare-name routing. Pinned chains hand it to every spawned child, so the WORST
 * case of a `team` run would have become "the model reported nothing" instead of
 * "the model reported why". Reporting a reason is the whole value of the failure.
 *
 * The split follows the same doctrine as the stream-head sniffer: terminal faults
 * are 400 so the reason surfaces inline, and only genuinely transient ones get a
 * retryable status, because retrying is the actual remedy there. Every candidate
 * being rate-limited or overloaded IS transient — Claude Code's retry loop is
 * correct for it — while an exhausted chain of capability/auth/model errors is not
 * going to fix itself, and burying it behind ten silent retries is what the
 * 400-not-5xx rule exists to prevent.
 *
 * ── The remap has to be undone HERE too (#148) ──────────────────────────────
 *
 * The transient test reads `e.status`, and by the time a candidate's error lands
 * in this array `composed-handler` may already have rewritten that status to 400.
 * So the question "was every candidate transient?" was being asked of a number
 * that no longer says. `hasQuotaExhaustionWording` covered the common case by
 * accident — a spent plan says so in words that survive the remap — but a bare
 * `Too Many Requests`, or an upstream 503 remapped for some other reason, came out
 * as a terminal 400 and Claude Code rendered a dead end where a retry was the
 * actual remedy.
 *
 * This became reachable BECAUSE of the sibling fix in `isRetryableError`. Before
 * it, a remapped 429 with no quota wording stopped the chain at the first
 * candidate, so a full chain of them never reached this function at all. Making
 * the chain advance is what surfaced the second half of the same defect.
 *
 * Scoped to 429, 502, 503 and 504 deliberately: exactly the set treated as
 * transient for un-remapped statuses, so the rule stays independent of whether a
 * remap happened rather than gaining a new one. A remapped 401/403/402 stays terminal
 * and still surfaces inline, which is the whole point of the 400 doctrine.
 *
 * ── A RECOVERY 503 CAN NEVER REACH THIS FUNCTION, BY CONSTRUCTION ────────────
 *
 * This was the sharper half of the marker-header finding, and it is worth
 * stating where the trap is rather than where the fix is. If claudish's tier-1
 * exhaustion 503 were pushed into `errors`, one EARLIER candidate failing with
 * auth/404 would make `errors.every(isTransient)` false and this function would
 * answer a terminal **400** — Claude Code would render the reason inline and
 * never re-POST, so tier 2 would never begin and the feature would fail exactly
 * in the case it was built for (an auto-routed chain during an outage).
 *
 * Nothing here is fixed to prevent that, because the upstream guard already
 * makes it unreachable: `handle()` returns a marked response VERBATIM before
 * any `errors.push`, and the only other push is the `catch`, which takes a
 * thrown error rather than a Response. Widening `isTransient` to look for the
 * marker would therefore be dead code that reads like a live guarantee. What
 * pins it instead is a test that drives the real shape — candidate 1 failing
 * with a retryable auth error, candidate 2 answering the marked 503 — and
 * asserts the client receives 503 with the marker intact, never a combined 400.
 */
export function exhaustedChainStatus(
  errors: Array<{ provider: string; status: number; message: string }>
): number {
  if (errors.length === 0) return 400;
  // 502 and 504 joined 429/503 when `isRetryableError` began advancing on them:
  // a chain in which every hop was unavailable must still end retryable, as the
  // single 502 that used to be returned as-is did.
  const TRANSIENT = new Set([429, 502, 503, 504]);
  const isTransient = (e: { status: number; message: string }): boolean => {
    if (TRANSIENT.has(e.status)) return true;
    if (hasQuotaExhaustionWording(e.message)) return true;
    const upstream = e.status === 400 ? extractUpstreamStatus(e.message) : undefined;
    return upstream !== undefined && TRANSIENT.has(upstream);
  };
  return errors.every(isTransient) ? 503 : 400;
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

/** Extract a human-readable message from a JSON error body */
function parseErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed.error === "string") return parsed.error;
    if (typeof parsed.error?.message === "string") return parsed.error.message;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Not JSON — return raw
  }
  return body;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}
