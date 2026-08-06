/**
 * Detecting "your subscription allowance is spent" from an error response.
 *
 * ## Why this needs its own module
 *
 * Providers do not agree on how to report an exhausted plan. A 429 is the
 * obvious channel, but Kimi's coding plan answers with
 * `403 permission_error: "You've reached your usage limit for this billing
 * cycle"` — a status code otherwise reserved for authorization failures. Two
 * separate places in the codebase have to tell those apart, and they must not
 * drift:
 *
 * 1. `composed-handler.ts` picks the user-facing hint. Classifying an exhausted
 *    plan as an auth failure told users to "Check API key / OAuth credentials"
 *    while the provider's own explanation sat in the same message — sending
 *    them to debug a credential that was working perfectly.
 *
 * 2. `fallback-handler.ts` warns when the chain advances past a spent plan. The
 *    next candidate in a chain like `["kimi-coding", "opencode-zen-go", "kimi",
 *    "openrouter"]` is billed per token, so the user's cost model changes on a
 *    hop they never asked for. The chain still advances — availability wins —
 *    but the change is announced instead of silent.
 *
 *    It deliberately does NOT make exhaustion terminal. That was tried and
 *    reverted: an explicit `kc@k3` spec resolves to ONE candidate, so its error
 *    already surfaces with nothing to advance to, and inside a claudish-built
 *    chain terminality only cost availability — a bare `minimax-m2.5` hard-failed
 *    whenever Zen Go's rolling 5-hour window was spent, despite a metered
 *    provider standing by. Users who want failure instead of a billing switch
 *    have a precise tool already: name the provider (`zgo@model`).
 *
 * Sharing one predicate keeps the CLI's explanation and the warning from
 * disagreeing about what happened.
 */

/**
 * Phrases that indicate a spent allowance rather than a bad credential.
 *
 * Deliberately narrow. A false positive here is not harmless in the other
 * direction: it would tell a user with genuinely broken credentials to go and
 * check their billing. So this matches only wording about limits, cycles and
 * balances — never bare "permission", "denied", "forbidden" or "invalid",
 * which are the vocabulary of real auth failures.
 */
const EXHAUSTION_PHRASES = [
  "usage limit",
  "billing cycle",
  "quota",
  "insufficient balance",
  "insufficient_quota",
  "upgrade your plan",
  "exceeded your current",
  "out of credits",
  "credit balance",
  // Rolling-window wording. Zen Go says "5-hour usage limit reached" (caught by
  // "usage limit"), but "daily limit" / "plan limit" are the same event in other
  // vendors' phrasing and share no vocabulary with an auth failure.
  "daily limit",
  "plan limit",
] as const;

/**
 * Wording-only check: does this body say the allowance is spent?
 *
 * Status-agnostic ON PURPOSE, and that is the whole reason it is separate from
 * `isQuotaExhaustionError`. By the time the fallback chain inspects an error,
 * the transport may have REMAPPED the status — a terminal 429 is surfaced as
 * 400 by the "terminal errors become 400" doctrine in `composed-handler.ts`, so
 * a status-gated check would stop recognising it precisely where the most
 * expensive decision is made.
 *
 * The distinction that matters:
 *
 *   terminal for THIS PROVIDER  → don't retry it (the allowance refills on a
 *                                 clock; backoff inside one request is waste).
 *                                 `isTerminal429` uses this.
 *   terminal for THE CHAIN      → NO. Another provider can serve. The chain
 *                                 must advance. `fallback-handler` uses this.
 *
 * Collapsing those two produced a real regression in both directions: treating
 * exhaustion as chain-terminal hard-failed a bare `minimax-m2.5` that a metered
 * provider was ready to serve, while treating it as transient burned a 60s
 * timeout retrying a window that resets in three hours.
 */
export function hasQuotaExhaustionWording(errorBody: string): boolean {
  const lower = (errorBody || "").toLowerCase();
  return EXHAUSTION_PHRASES.some((phrase) => lower.includes(phrase));
}

/**
 * True when this response says the plan/allowance is spent.
 *
 * Scoped to the statuses providers actually use for it, for callers that see the
 * ORIGINAL upstream status. 402 is excluded on purpose: it already means
 * "payment required" and is handled as its own case by the callers.
 */
export function isQuotaExhaustionError(status: number, errorBody: string): boolean {
  if (status !== 401 && status !== 403 && status !== 429) return false;
  return hasQuotaExhaustionWording(errorBody);
}
