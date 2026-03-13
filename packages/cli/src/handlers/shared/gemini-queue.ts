/**
 * Gemini Request Queue
 *
 * Thin wrapper around RequestQueue + RateLimitStrategy with Gemini-specific
 * rate limit handling (quotaResetDelay parsing, exponential backoff).
 */

import { getLogLevel, log } from "../../logger.js";
import {
  RequestQueue,
  RateLimitStrategy,
  type RateLimitHandler,
  type RequestQueueStats,
} from "./request-queue.js";

// ─── Gemini-specific rate limit handler ──────────────────

class GeminiRateLimitHandler implements RateLimitHandler {
  private minDelayMs = 1000;
  private readonly baseDelayMs = 1000;
  private readonly maxDelayMs = 10000;

  getDelay(consecutiveErrors: number): number {
    let delayMs = this.minDelayMs;
    if (consecutiveErrors > 0) {
      const backoffMultiplier = 1 + consecutiveErrors * 0.5;
      delayMs = Math.min(this.minDelayMs * backoffMultiplier, this.maxDelayMs);
      if (getLogLevel() === "debug") {
        log(`[GeminiQueue] Applying backoff (${consecutiveErrors} errors): ${delayMs}ms`);
      }
    }
    return delayMs;
  }

  async onResponse(response: Response, consecutiveErrors: number): Promise<void> {
    if (response.status !== 429) return;

    // Parse quotaResetDelay from Gemini 429 error body
    try {
      const errorText = await response.clone().text();
      const errorData = JSON.parse(errorText);
      const quotaDetail = errorData?.error?.details?.find((d: any) => d.quotaResetDelay);
      if (quotaDetail?.quotaResetDelay) {
        const match = quotaDetail.quotaResetDelay.match(/(\d+(?:\.\d+)?)/);
        if (match) {
          const suggestedDelayMs = Math.ceil(parseFloat(match[1]) * 1000);
          this.minDelayMs = Math.min(
            Math.max(suggestedDelayMs, this.minDelayMs, this.baseDelayMs),
            this.maxDelayMs,
          );
          if (getLogLevel() === "debug") {
            log(
              `[GeminiQueue] Parsed quotaResetDelay: ${quotaDetail.quotaResetDelay} ` +
                `(${suggestedDelayMs}ms), new minDelay: ${this.minDelayMs}ms`,
            );
          }
        }
      }
    } catch {
      if (getLogLevel() === "debug") {
        log(`[GeminiQueue] Failed to parse rate limit response, using backoff`);
      }
    }

    // Apply exponential backoff (consecutiveErrors will be incremented by strategy after this)
    const backoffMultiplier = 1 + (consecutiveErrors + 1) * 0.5;
    this.minDelayMs = Math.min(this.baseDelayMs * backoffMultiplier, this.maxDelayMs);
  }

  onSuccess(): void {
    if (this.minDelayMs > this.baseDelayMs) {
      this.minDelayMs = Math.max(this.baseDelayMs, this.minDelayMs * 0.9);
      if (getLogLevel() === "debug") {
        log(`[GeminiQueue] Reducing delay to ${this.minDelayMs}ms`);
      }
    }
  }
}

// ─── Singleton wrapper ───────────────────────────────────

export { type RequestQueueStats as QueueStats };

export class GeminiRequestQueue {
  private static instance: GeminiRequestQueue | null = null;
  private queue: RequestQueue;

  private constructor() {
    const handler = new GeminiRateLimitHandler();
    const strategy = new RateLimitStrategy("GeminiQueue", handler);
    this.queue = new RequestQueue(strategy, { logPrefix: "GeminiQueue" });
  }

  static getInstance(): GeminiRequestQueue {
    if (!GeminiRequestQueue.instance) {
      GeminiRequestQueue.instance = new GeminiRequestQueue();
    }
    return GeminiRequestQueue.instance;
  }

  enqueue(fetchFn: () => Promise<Response>): Promise<Response> {
    return this.queue.enqueue(fetchFn);
  }

  getStats(): RequestQueueStats {
    return this.queue.getStats();
  }
}
