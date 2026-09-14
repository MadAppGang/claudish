/**
 * OpenRouter Request Queue
 *
 * Serializes OpenRouter API requests to prevent rate limit exhaustion, with a
 * dynamic delay driven by OpenRouter's rate-limit headers (proactive throttling
 * as quota runs low, spreading requests until the reset) and by 429 responses
 * (Retry-After + exponential backoff). The FIFO/concurrency mechanics live in
 * the shared RequestQueue base; this class supplies the OpenRouter pacing policy.
 *
 * Rate limit headers parsed:
 * - X-RateLimit-Limit-Requests / X-RateLimit-Remaining-Requests / X-RateLimit-Reset-Requests
 * - X-RateLimit-Limit-Tokens / X-RateLimit-Remaining-Tokens
 * - Retry-After (seconds to wait after a 429)
 */

import { RequestQueue } from "./request-queue.js";

/**
 * Rate limit state tracked from response headers
 */
interface RateLimitState {
  limitRequests: number | null;
  limitTokens: number | null;
  remainingRequests: number | null;
  remainingTokens: number | null;
  resetTime: number | null; // Unix timestamp (seconds)

  consecutiveErrors: number;
  currentDelayMs: number;

  total429Errors: number;
}

/**
 * Queue statistics for monitoring
 */
export interface QueueStats {
  queueLength: number;
  processing: boolean;
  consecutiveErrors: number;
  currentDelayMs: number;
  totalProcessed: number;
  totalErrors: number;
  total429Errors: number;
  remainingRequests: number | null;
  remainingTokens: number | null;
  resetTime: number | null;
}

/**
 * Singleton request queue for OpenRouter API.
 *
 * @example
 * ```typescript
 * const queue = OpenRouterRequestQueue.getInstance();
 * const response = await queue.enqueue(() => fetch(url, options));
 * ```
 */
export class OpenRouterRequestQueue extends RequestQueue {
  private static instance: OpenRouterRequestQueue | null = null;

  private readonly baseDelayMs = 1000; // 60 req/min
  private readonly maxRateDelayMs = 10000; // Max 10s delay

  private rateLimitState: RateLimitState = {
    limitRequests: null,
    limitTokens: null,
    remainingRequests: null,
    remainingTokens: null,
    resetTime: null,
    consecutiveErrors: 0,
    currentDelayMs: 1000,
    total429Errors: 0,
  };

  private constructor() {
    super({ name: "OpenRouter", maxParallel: 1 });
  }

  static getInstance(): OpenRouterRequestQueue {
    if (!OpenRouterRequestQueue.instance) {
      OpenRouterRequestQueue.instance = new OpenRouterRequestQueue();
    }
    return OpenRouterRequestQueue.instance;
  }

  /**
   * Enqueue a request to be processed.
   * @throws Error if the queue is full
   */
  enqueue(fetchFn: () => Promise<Response>): Promise<Response> {
    return this.enqueueInternal(fetchFn);
  }

  protected override queueFullMessage(): string {
    return `OpenRouter request queue full (${this.queue.length}/${this.maxQueueSize}). The API is rate-limited. Please wait and try again.`;
  }

  protected override onError(): void {
    this.rateLimitState.consecutiveErrors++;
  }

  protected override async onResponse(response: Response): Promise<void> {
    this.parseRateLimitHeaders(response);

    if (response.status === 429) {
      this.totalErrors++;
      this.rateLimitState.total429Errors++;
      await this.handleRateLimitError(response);
      this.debug(`Rate limit hit (429), adjusted delay to ${this.rateLimitState.currentDelayMs}ms`);
    } else {
      this.handleSuccessResponse();
    }
  }

  /**
   * Compute the dynamic delay from remaining quota, time until reset, and error
   * backoff. Records the result as the current delay for stats.
   */
  protected override calculateDelay(): number {
    const state = this.rateLimitState;
    let delayMs = this.baseDelayMs;

    // Factor 1: remaining requests (proactive throttling).
    if (
      state.remainingRequests !== null &&
      state.limitRequests !== null &&
      state.limitRequests > 0
    ) {
      const quotaPercent = state.remainingRequests / state.limitRequests;
      if (quotaPercent < 0.2) {
        delayMs = Math.max(delayMs, 3000);
        this.debug(`Low quota (${(quotaPercent * 100).toFixed(1)}%), increasing delay to ${delayMs}ms`);
      } else if (quotaPercent < 0.5) {
        delayMs = Math.max(delayMs, 2000);
        this.debug(`Medium quota (${(quotaPercent * 100).toFixed(1)}%), increasing delay to ${delayMs}ms`);
      }
    }

    // Factor 2: time until reset (spread requests evenly).
    if (state.resetTime !== null && state.remainingRequests !== null) {
      const now = Date.now() / 1000;
      const timeUntilReset = state.resetTime - now;
      if (timeUntilReset > 0 && state.remainingRequests > 0) {
        const optimalDelay = (timeUntilReset * 1000) / Math.max(state.remainingRequests, 1);
        delayMs = Math.max(delayMs, Math.min(optimalDelay, this.maxRateDelayMs));
        this.debug(
          `Spreading ${state.remainingRequests} requests over ${timeUntilReset.toFixed(1)}s, optimal delay: ${optimalDelay.toFixed(0)}ms`
        );
      }
    }

    // Factor 3: consecutive errors (exponential backoff).
    if (state.consecutiveErrors > 0) {
      delayMs = delayMs * (1 + state.consecutiveErrors * 0.5);
      this.debug(`Applying backoff (${state.consecutiveErrors} errors): ${delayMs.toFixed(0)}ms`);
    }

    const capped = Math.min(delayMs, this.maxRateDelayMs);
    state.currentDelayMs = capped;
    return capped;
  }

  /** Parse rate-limit headers into the tracked state. */
  private parseRateLimitHeaders(response: Response): void {
    const state = this.rateLimitState;

    const limitRequests = response.headers.get("X-RateLimit-Limit-Requests");
    if (limitRequests) state.limitRequests = Number.parseInt(limitRequests, 10);

    const remainingRequests = response.headers.get("X-RateLimit-Remaining-Requests");
    if (remainingRequests) state.remainingRequests = Number.parseInt(remainingRequests, 10);

    const resetRequests = response.headers.get("X-RateLimit-Reset-Requests");
    if (resetRequests) state.resetTime = Number.parseFloat(resetRequests);

    const limitTokens = response.headers.get("X-RateLimit-Limit-Tokens");
    if (limitTokens) state.limitTokens = Number.parseInt(limitTokens, 10);

    const remainingTokens = response.headers.get("X-RateLimit-Remaining-Tokens");
    if (remainingTokens) state.remainingTokens = Number.parseInt(remainingTokens, 10);
  }

  /** Handle a 429: apply Retry-After and exponential backoff. */
  private async handleRateLimitError(response: Response): Promise<void> {
    const state = this.rateLimitState;
    state.consecutiveErrors++;
    state.remainingRequests = 0; // quota exhausted

    const retryAfter = response.headers.get("Retry-After");
    if (retryAfter) {
      const retryAfterSeconds = Number.parseInt(retryAfter, 10);
      if (!Number.isNaN(retryAfterSeconds)) {
        state.currentDelayMs = Math.min(retryAfterSeconds * 1000, this.maxRateDelayMs);
      }
    }

    try {
      const errorData = JSON.parse(await response.clone().text());
      if (errorData?.error?.message) this.debug(`429 error message: ${errorData.error.message}`);
    } catch {
      // Ignore JSON parse errors.
    }

    const backoffDelay = Math.min(
      this.baseDelayMs * (1 + state.consecutiveErrors * 0.5),
      this.maxRateDelayMs
    );
    state.currentDelayMs = Math.max(state.currentDelayMs, backoffDelay);
  }

  /** Reset the error counter and decay the delay back toward baseline. */
  private handleSuccessResponse(): void {
    const state = this.rateLimitState;
    if (state.consecutiveErrors > 0) state.consecutiveErrors = 0;
    if (state.currentDelayMs > this.baseDelayMs) {
      state.currentDelayMs = Math.max(this.baseDelayMs, state.currentDelayMs * 0.9);
    }
  }

  getStats(): QueueStats {
    return {
      queueLength: this.queue.length,
      processing: this.activeRequests > 0,
      consecutiveErrors: this.rateLimitState.consecutiveErrors,
      currentDelayMs: this.rateLimitState.currentDelayMs,
      totalProcessed: this.totalProcessed,
      totalErrors: this.totalErrors,
      total429Errors: this.rateLimitState.total429Errors,
      remainingRequests: this.rateLimitState.remainingRequests,
      remainingTokens: this.rateLimitState.remainingTokens,
      resetTime: this.rateLimitState.resetTime,
    };
  }
}
