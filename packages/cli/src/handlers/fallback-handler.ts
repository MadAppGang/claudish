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
import { hasQuotaExhaustionWording } from "./shared/quota-exhaustion.js";
import type { ModelHandler } from "./types.js";

export interface FallbackCandidate {
  /** Human-readable provider name for logging */
  name: string;
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
      const { name, handler } = this.candidates[idx];
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

        // Clone before reading body so we can still return the original if needed
        const errorBody = await response.clone().text();

        // Non-retryable error (rate limit, server error, bad format) — stop trying
        if (!isRetryableError(response.status, errorBody)) {
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
      502 as any
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
 * Auth errors, billing errors, rate limits, and model-not-found errors
 * warrant trying a different provider. True server errors (500 without
 * billing context) do NOT — they'd likely fail on any provider.
 */
function isRetryableError(status: number, errorBody: string): boolean {
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

  // Auth errors — different provider might have valid credentials
  if (status === 401 || status === 403) return true;

  // Payment required — billing/credit issue specific to this provider
  if (status === 402) return true;

  // Not found — model doesn't exist on this provider
  if (status === 404) return true;

  // Rate limited — per-provider limit, a different provider may have capacity
  if (status === 429) return true;

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
      // surface it inline for an EXPLICIT go@/ag@ selection). But this handler
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
