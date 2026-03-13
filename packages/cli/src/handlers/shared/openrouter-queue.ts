/**
 * OpenRouter Request Queue
 *
 * Thin wrapper around RequestQueue + RateLimitStrategy with OpenRouter-specific
 * rate limit handling (X-RateLimit-* headers, Retry-After, proactive throttling).
 */

import { getLogLevel, log } from "../../logger.js";
import {
  RequestQueue,
  RateLimitStrategy,
  type RateLimitHandler,
  type RequestQueueStats,
} from "./request-queue.js";

// ─── OpenRouter-specific rate limit handler ──────────────

class OpenRouterRateLimitHandler implements RateLimitHandler {
  private currentDelayMs = 1000;
  private readonly baseDelayMs = 1000;
  private readonly maxDelayMs = 10000;

  // Rate limit state from headers
  private limitRequests: number | null = null;
  private remainingRequests: number | null = null;
  private resetTime: number | null = null; // Unix timestamp (seconds)
  private remainingTokens: number | null = null;

  // Extended stats (exposed via getExtendedStats)
  total429Errors = 0;

  getDelay(consecutiveErrors: number): number {
    let delayMs = this.baseDelayMs;

    // Proactive throttling based on remaining quota
    if (this.remainingRequests !== null && this.limitRequests !== null && this.limitRequests > 0) {
      const quotaPercent = this.remainingRequests / this.limitRequests;
      if (quotaPercent < 0.2) {
        delayMs = Math.max(delayMs, 3000);
      } else if (quotaPercent < 0.5) {
        delayMs = Math.max(delayMs, 2000);
      }
    }

    // Spread requests evenly until reset
    if (this.resetTime !== null && this.remainingRequests !== null) {
      const timeUntilReset = this.resetTime - Date.now() / 1000;
      if (timeUntilReset > 0 && this.remainingRequests > 0) {
        const optimalDelay = (timeUntilReset * 1000) / Math.max(this.remainingRequests, 1);
        delayMs = Math.max(delayMs, Math.min(optimalDelay, this.maxDelayMs));
      }
    }

    // Exponential backoff for consecutive errors
    if (consecutiveErrors > 0) {
      const backoffMultiplier = 1 + consecutiveErrors * 0.5;
      delayMs = delayMs * backoffMultiplier;
    }

    this.currentDelayMs = Math.min(delayMs, this.maxDelayMs);
    return this.currentDelayMs;
  }

  onResponse(response: Response, consecutiveErrors: number): void {
    this.parseRateLimitHeaders(response);

    if (response.status === 429) {
      this.total429Errors++;
      this.remainingRequests = 0;

      // Parse Retry-After header
      const retryAfter = response.headers.get("Retry-After");
      if (retryAfter) {
        const retryAfterSeconds = parseInt(retryAfter, 10);
        if (!isNaN(retryAfterSeconds)) {
          this.currentDelayMs = Math.min(retryAfterSeconds * 1000, this.maxDelayMs);
        }
      }

      // Apply exponential backoff
      const backoffMultiplier = 1 + (consecutiveErrors + 1) * 0.5;
      const backoffDelay = Math.min(this.baseDelayMs * backoffMultiplier, this.maxDelayMs);
      this.currentDelayMs = Math.max(this.currentDelayMs, backoffDelay);
    }
  }

  onSuccess(): void {
    if (this.currentDelayMs > this.baseDelayMs) {
      this.currentDelayMs = Math.max(this.baseDelayMs, this.currentDelayMs * 0.9);
    }
  }

  private parseRateLimitHeaders(response: Response): void {
    const limitReq = response.headers.get("X-RateLimit-Limit-Requests");
    if (limitReq) this.limitRequests = parseInt(limitReq, 10);

    const remainingReq = response.headers.get("X-RateLimit-Remaining-Requests");
    if (remainingReq) this.remainingRequests = parseInt(remainingReq, 10);

    const resetReq = response.headers.get("X-RateLimit-Reset-Requests");
    if (resetReq) this.resetTime = parseFloat(resetReq);

    const remainingTok = response.headers.get("X-RateLimit-Remaining-Tokens");
    if (remainingTok) this.remainingTokens = parseInt(remainingTok, 10);

    if (getLogLevel() === "debug") {
      log(
        `[OpenRouterQueue] Rate limit headers: remaining=${this.remainingRequests}/${this.limitRequests}, ` +
          `tokens=${this.remainingTokens}, reset=${this.resetTime ? new Date(this.resetTime * 1000).toISOString() : "null"}`,
      );
    }
  }

  /** Extra stats beyond RequestQueueStats */
  getExtendedStats() {
    return {
      total429Errors: this.total429Errors,
      remainingRequests: this.remainingRequests,
      remainingTokens: this.remainingTokens,
      resetTime: this.resetTime,
      currentDelayMs: this.currentDelayMs,
    };
  }
}

// ─── Singleton wrapper ───────────────────────────────────

export interface QueueStats extends RequestQueueStats {
  total429Errors: number;
  remainingRequests: number | null;
  remainingTokens: number | null;
  resetTime: number | null;
  currentDelayMs: number;
  consecutiveErrors: number;
}

export class OpenRouterRequestQueue {
  private static instance: OpenRouterRequestQueue | null = null;
  private queue: RequestQueue;
  private handler: OpenRouterRateLimitHandler;

  private constructor() {
    this.handler = new OpenRouterRateLimitHandler();
    const strategy = new RateLimitStrategy("OpenRouterQueue", this.handler);
    this.queue = new RequestQueue(strategy, { logPrefix: "OpenRouterQueue" });
  }

  static getInstance(): OpenRouterRequestQueue {
    if (!OpenRouterRequestQueue.instance) {
      OpenRouterRequestQueue.instance = new OpenRouterRequestQueue();
    }
    return OpenRouterRequestQueue.instance;
  }

  enqueue(fetchFn: () => Promise<Response>): Promise<Response> {
    return this.queue.enqueue(fetchFn);
  }

  getStats(): QueueStats {
    const base = this.queue.getStats();
    const ext = this.handler.getExtendedStats();
    return {
      ...base,
      ...ext,
      consecutiveErrors: 0, // not tracked at this level anymore
    };
  }
}
