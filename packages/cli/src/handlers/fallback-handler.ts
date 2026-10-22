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
import { log, logStderr } from "../logger.js";
import { redactForClient } from "../redact.js";
import { ComposedHandler, getRecoveryHint } from "./composed-handler.js";
import { extractUpstreamStatus } from "./shared/anthropic-error.js";
import { authVerdict } from "./shared/auth-failure.js";
import { abortedResponse, callAborted } from "./shared/call-context.js";
import { decideHopFailure } from "./shared/hop-decision.js";
import { hasQuotaExhaustionWording } from "./shared/quota-exhaustion.js";
import { isSubscriptionProvider } from "./shared/remote-provider-types.js";
import type { ModelHandler } from "./types.js";

// Moved to `hop-decision.ts`, which the probe shares; re-exported for the
// existing importers and tests.
export {
  isProvider,
  isRetryableError,
  isSubscriptionCredentialRejection,
} from "./shared/hop-decision.js";

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
    // The first subscription candidate whose credential was rejected. The chain
    // moves past it like any retryable failure; this is kept because its
    // message (log in again, renew the key) is the one a user can act on, so
    // an exhausted chain still shows it.
    let firstRejection: { name: string; response: Response; body: string } | undefined;

    for (let attempt = 0; attempt < this.candidates.length; attempt++) {
      const idx = (startIndex + attempt) % this.candidates.length;
      const { name, handler, provider } = this.candidates[idx];
      const isLast = attempt === this.candidates.length - 1;
      // An internal call whose deadline passed (call-context.ts) never reaches
      // another hop. Never true for a request from Claude Code.
      if (callAborted(c)) return abortedResponse();

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
        // The caller stopped waiting while this hop ran: its answer goes back
        // as it is, before any retry decision or stderr line.
        if (callAborted(c)) return response;

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

        // Clone before reading body so we can still return the original if needed.
        // Read BEFORE the decision, also for a recovery hold, a stream failure and
        // a credential verdict: all three are claudish's own small JSON bodies,
        // and each is still returned verbatim below.
        const errorBody = await response.clone().text();

        // ONE decision, shared with the probe (`hop-decision.ts`, which carries
        // the reasons for its order). Each reason maps onto exactly the branch
        // this handler has always taken for it.
        const decision = decideHopFailure({
          kind: "response",
          status: response.status,
          headers: response.headers,
          body: errorBody,
          provider,
          name,
        });

        switch (decision.reason) {
          // ── THE RECOVERY MARKER ─────────────────────────────────────────────
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
          // Returning it verbatim answers both at once.
          case "recovery-hold":
            logStderr(
              `[Fallback] ${name} is unreachable and claudish is still retrying it — ` +
                "holding the chain here rather than switching providers mid-outage."
            );
            return response;

          // ── THE STREAM-FAILURE MARKER, SAME REASONS ─────────────────────────
          //
          // A non-streamed turn whose stream ended on an SSE `error` (the provider
          // answered 200, then the stream failed) is answered by the JSON collector
          // with an error response. In streaming mode the same failure never comes
          // back through here as an error, so neither may this one: it is not the
          // provider's verdict on the request. Neither advanced past nor folded.
          case "stream-failure":
            return response;

          // A CREDENTIAL VERDICT leaves this handler untouched too, for the
          // recovery hold's second reason: folded into `formatCombinedError`, a
          // transient 503 behind an earlier candidate's 404 became a terminal 400,
          // so Claude Code stopped instead of retrying the same hop, and the
          // verdict header was dropped. A terminal verdict keeps its exact message
          // and `upstream_status` the same way (`auth-failure.ts`).
          case "credential-hold":
            if (errors.length > 0) {
              const verdict = authVerdict(response.headers);
              logStderr(
                `[Fallback] ${name}: credential ${verdict === "terminal" ? "rejected" : "temporarily unavailable"} — stopping the chain here.`
              );
            }
            return response;

          // A TERMINAL verdict on a subscription (an expired, wrong or revoked
          // credential) moves to the next hop, metered included (project owner,
          // 2026-10-21): an expired key must not block the chain, and a metered
          // key the user configured is consent to be billed by it. The move is
          // announced, once per provider and status.
          case "subscription-credential-rejected": {
            errors.push({ provider: name, status: response.status, message: errorBody });
            if (!firstRejection) firstRejection = { name, response, body: errorBody };
            if (!isLast) {
              const next = this.candidates[(idx + 1) % this.candidates.length];
              announceCredentialRejection({ name, provider }, response.status, errorBody, next);
            }
            continue;
          }

          // Non-retryable error (rate limit, server error, bad format) — stop trying
          case "non-retryable":
            if (errors.length > 0) {
              // We had previous fallback attempts; show combined error
              errors.push({ provider: name, status: response.status, message: errorBody });
              return this.formatCombinedError(c, errors, payload.model, firstRejection);
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
        if (callAborted(c)) return abortedResponse();
        // A thrown hop advances (`decideHopFailure({kind: "thrown"})`), as it
        // always has; the probe judges a thrown hop by the same rule.
        if (decideHopFailure({ kind: "thrown" }).action === "advance") {
          errors.push({
            provider: name,
            status: 0,
            message: redactForClient(String(err?.message)),
          });
          if (!isLast) {
            logStderr(`[Fallback] ${name} error: ${err.message}, trying next provider...`);
          }
        }
      }
    }

    // The rejected credential was the only failure (a chain whose other hops
    // were never reached): answered as a chain of one would be, with its own
    // message, status and verdict.
    if (firstRejection && errors.length === 1) return firstRejection.response;

    // All providers failed
    return this.formatCombinedError(c, errors, payload.model, firstRejection);
  }

  /**
   * The combined answer of an exhausted chain. When a subscription's
   * credential was rejected on the way, its message leads: the later hops'
   * failures (a missing key, a model they do not carry) are not what the user
   * can fix, and the per-attempt list clips each message at 200 characters,
   * which cut the `claudish login …` line off.
   */
  private formatCombinedError(
    c: Context,
    errors: Array<{ provider: string; status: number; message: string }>,
    modelName?: string,
    firstRejection?: { name: string; body: string }
  ): Response {
    const summary = errors
      .map(
        (e) =>
          `  ${e.provider}: HTTP ${e.status || "ERR"} — ${truncate(parseErrorMessage(redactForClient(e.message)), 150)}`
      )
      .join("\n");

    const rejection = firstRejection
      ? ` First, ${firstRejection.name} rejected its credential: ${parseErrorMessage(redactForClient(firstRejection.body))}`
      : "";

    logStderr(
      `[Fallback] All ${errors.length} provider(s) failed for ${modelName || "model"}:\n${summary}` +
        (rejection ? `\n ${rejection.trim()}` : "")
    );

    return c.json(
      {
        error: {
          type: "all_providers_failed",
          message: `All ${errors.length} providers failed for model '${modelName || "unknown"}'${rejection ? `.${rejection}` : ""}`,
          attempts: errors.map((e) => ({
            provider: e.provider,
            status: e.status,
            error: truncate(parseErrorMessage(redactForClient(e.message)), 200),
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

/** `<provider uid>|<upstream status>` of every rejection already announced on stderr. */
const announcedRejections = new Set<string>();

/** Test seam: forget which credential rejections were announced. */
export function _resetCredentialRejectionNotices(): void {
  announcedRejections.clear();
}

/** The billing words for a hop the chain moves to; a hop of unknown billing reads metered. */
function hopBillingWords(provider: string | undefined): string {
  return provider && isSubscriptionProvider(provider)
    ? "subscription"
    : "metered, billed per token";
}

/**
 * Say that a subscription's credential was rejected and which hop the chain
 * moves to, and how that hop bills. The user did not choose the move (claudish
 * assembled the chain), and the next hop may bill per token, so it is said on
 * stderr, once per provider and upstream status per process; every occurrence
 * is written to the log. The provider message has already been redacted for
 * the client by `ComposedHandler`; it is redacted again here, and `logStderr`
 * redacts the request's signing values.
 */
export function announceCredentialRejection(
  rejected: { name: string; provider?: string },
  status: number,
  errorBody: string,
  next: { name: string; provider?: string }
): void {
  const upstreamStatus = (status === 400 ? extractUpstreamStatus(errorBody) : undefined) ?? status;
  const providerMessage = truncate(
    parseProviderMessage(redactForClient(errorBody)).replace(/\s+/g, " ").trim(),
    300
  );
  const hint = getRecoveryHint(
    upstreamStatus,
    errorBody,
    rejected.name,
    undefined,
    rejected.provider
  );
  const line =
    `${rejected.name} rejected its credential (${upstreamStatus}: ${providerMessage}) — ` +
    `moving to ${next.name} (${hopBillingWords(next.provider)}). ${hint}`;
  const key = `${rejected.provider ?? rejected.name}|${upstreamStatus}`;
  if (announcedRejections.has(key)) {
    log(`[Fallback] ${line}`);
    return;
  }
  announcedRejections.add(key);
  logStderr(line);
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
 * The upstream's own words from a claudish error body (`provider_message`,
 * which carries no hint, provider name or status), else its message.
 */
function parseProviderMessage(body: string): string {
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.error?.provider_message === "string" && parsed.error.provider_message) {
      return parsed.error.provider_message;
    }
  } catch {
    // Not JSON — fall through
  }
  return parseErrorMessage(body);
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
