/**
 * Gemini Request Queue
 *
 * Serializes Gemini API requests to prevent rate limit exhaustion, with dynamic
 * delay adjustment driven by 429 responses (Google returns a `quotaResetDelay`)
 * and exponential backoff on consecutive errors. The FIFO/concurrency mechanics
 * live in the shared RequestQueue base; this class supplies the Gemini pacing
 * policy.
 */

import { RequestQueue } from "./request-queue.js";

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
}

/**
 * Singleton request queue for Gemini API.
 *
 * @example
 * ```typescript
 * const queue = GeminiRequestQueue.getInstance();
 * const response = await queue.enqueue(() => fetch(url, options));
 * ```
 */
export class GeminiRequestQueue extends RequestQueue {
  private static instance: GeminiRequestQueue | null = null;

  private minDelayMs = 1000; // 60 requests/minute
  private consecutiveErrors = 0;
  private readonly baseDelayMs = 1000;
  private readonly maxDelayMs = 10000;

  private constructor() {
    super({ name: "Gemini", maxParallel: 1 });
  }

  static getInstance(): GeminiRequestQueue {
    if (!GeminiRequestQueue.instance) {
      GeminiRequestQueue.instance = new GeminiRequestQueue();
    }
    return GeminiRequestQueue.instance;
  }

  /**
   * Enqueue a request to be processed.
   * @throws Error if the queue is full
   */
  enqueue(fetchFn: () => Promise<Response>): Promise<Response> {
    return this.enqueueInternal(fetchFn);
  }

  protected override queueFullMessage(): string {
    return "Gemini request queue full. Please retry later.";
  }

  protected override calculateDelay(): number {
    if (this.consecutiveErrors > 0) {
      // Exponential backoff: minDelayMs * (1 + consecutiveErrors * 0.5), capped.
      return Math.min(this.minDelayMs * (1 + this.consecutiveErrors * 0.5), this.maxDelayMs);
    }
    return this.minDelayMs;
  }

  protected override async onResponse(response: Response): Promise<void> {
    if (response.status === 429) {
      this.totalErrors++;
      const errorText = await response.clone().text();
      this.handleRateLimitResponse(errorText);
      this.debug(`Rate limit hit (429), adjusted delay to ${this.minDelayMs}ms`);
    } else {
      this.handleSuccessResponse();
    }
  }

  /**
   * Handle a 429: parse Google's `quotaResetDelay` (a protobuf duration like
   * "2.893149709s") and raise the floor delay, then apply exponential backoff.
   */
  private handleRateLimitResponse(errorText: string): void {
    this.consecutiveErrors++;

    try {
      const errorData = JSON.parse(errorText);
      const quotaDetail = errorData?.error?.details?.find((d: any) => d.quotaResetDelay);
      const delaySeconds = quotaDetail
        ? Number.parseFloat(quotaDetail.quotaResetDelay)
        : Number.NaN;
      if (!Number.isNaN(delaySeconds)) {
        const suggestedDelayMs = Math.ceil(delaySeconds * 1000);
        this.minDelayMs = Math.max(suggestedDelayMs, this.minDelayMs, this.baseDelayMs);
        this.minDelayMs = Math.min(this.minDelayMs, this.maxDelayMs);
        this.debug(
          `Parsed quotaResetDelay: ${quotaDetail.quotaResetDelay} (${suggestedDelayMs}ms), new minDelay: ${this.minDelayMs}ms`
        );
      }
    } catch {
      this.debug("Failed to parse rate limit response, using backoff");
    }

    const backoffMultiplier = 1 + this.consecutiveErrors * 0.5;
    this.minDelayMs = Math.min(this.baseDelayMs * backoffMultiplier, this.maxDelayMs);
  }

  /**
   * Handle a successful response: reset the error counter and decay the delay
   * back toward the baseline.
   */
  private handleSuccessResponse(): void {
    if (this.consecutiveErrors > 0) {
      this.debug(`Success after ${this.consecutiveErrors} errors, resetting counter`);
      this.consecutiveErrors = 0;
    }
    if (this.minDelayMs > this.baseDelayMs) {
      this.minDelayMs = Math.max(this.baseDelayMs, this.minDelayMs * 0.9);
      this.debug(`Reducing delay to ${this.minDelayMs}ms`);
    }
  }

  getStats(): QueueStats {
    return {
      queueLength: this.queue.length,
      processing: this.activeRequests > 0,
      consecutiveErrors: this.consecutiveErrors,
      currentDelayMs: this.minDelayMs,
      totalProcessed: this.totalProcessed,
      totalErrors: this.totalErrors,
    };
  }
}
