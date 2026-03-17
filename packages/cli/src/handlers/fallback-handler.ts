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
import type { ModelHandler } from "./types.js";
import { logStderr } from "../logger.js";
import { ComposedHandler } from "./composed-handler.js";

export interface FallbackCandidate {
  /** Human-readable provider name for logging */
  name: string;
  /** The handler to try */
  handler: ModelHandler;
}

export class FallbackHandler implements ModelHandler {
  private candidates: FallbackCandidate[];

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

    for (let i = 0; i < this.candidates.length; i++) {
      const { name, handler } = this.candidates[i];
      const isLast = i === this.candidates.length - 1;

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

        // Success — return immediately
        if (response.ok) {
          if (errors.length > 0) {
            logStderr(`[Fallback] ${name} succeeded after ${errors.length} failed attempt(s)`);
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
          logStderr(`[Fallback] ${name} failed (HTTP ${response.status}), trying next provider...`);
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
      lower.includes("no healthy deployment")
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
  return s.length > max ? s.slice(0, max) + "..." : s;
}
