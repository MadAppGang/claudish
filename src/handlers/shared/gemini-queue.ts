/**
 * Gemini Request Queue
 *
 * Singleton request queue for serializing Gemini API requests to prevent rate limit exhaustion.
 * Implements dynamic rate limiting based on API responses (429 errors with quotaResetDelay).
 *
 * All Gemini requests are processed sequentially through a FIFO queue with:
 * - Minimum delay between requests (default 1000ms = 60 req/min)
 * - Dynamic delay adjustment based on 429 error responses
 * - Exponential backoff for consecutive errors
 * - Automatic queue size management (max 100 requests)
 */

import { log } from "../../logger.js";

/**
 * Queued request with Promise callbacks
 */
interface QueuedRequest {
  fetchFn: () => Promise<Response>;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
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
}

/**
 * Singleton request queue for Gemini API
 *
 * Serializes all Gemini requests to prevent rate limit exhaustion.
 * Implements dynamic rate limiting based on API responses.
 *
 * @example
 * ```typescript
 * const queue = GeminiRequestQueue.getInstance();
 * const response = await queue.enqueue(() => fetch(url, options));
 * ```
 */
export class GeminiRequestQueue {
  private static instance: GeminiRequestQueue | null = null;
  private queue: QueuedRequest[] = [];
  private processing = false;
  private minDelayMs = 1000; // 60 requests/minute
  private lastRequestTime = 0;
  private consecutiveErrors = 0;
  private totalProcessed = 0;
  private totalErrors = 0;

  // Configuration
  private readonly baseDelayMs = 1000;
  private readonly maxDelayMs = 10000;
  private readonly maxQueueSize = 100;

  private constructor() {
    log("[GeminiQueue] Queue initialized with minDelay=1000ms, maxQueueSize=100");
  }

  /**
   * Get singleton instance
   */
  static getInstance(): GeminiRequestQueue {
    if (!GeminiRequestQueue.instance) {
      GeminiRequestQueue.instance = new GeminiRequestQueue();
    }
    return GeminiRequestQueue.instance;
  }

  /**
   * Enqueue a request to be processed
   *
   * @param fetchFn - Function that performs the fetch request
   * @returns Promise that resolves with the response
   * @throws Error if queue is full
   */
  async enqueue(fetchFn: () => Promise<Response>): Promise<Response> {
    // Check queue size limit
    if (this.queue.length >= this.maxQueueSize) {
      log(`[GeminiQueue] Queue full (${this.queue.length}/${this.maxQueueSize}), rejecting request`);
      throw new Error("Gemini request queue full. Please retry later.");
    }

    // Create promise for this request
    return new Promise<Response>((resolve, reject) => {
      const queuedRequest: QueuedRequest = {
        fetchFn,
        resolve,
        reject,
      };

      this.queue.push(queuedRequest);
      log(`[GeminiQueue] Request enqueued (queue length: ${this.queue.length})`);

      // Start processing if not already running
      if (!this.processing) {
        this.processQueue();
      }
    });
  }

  /**
   * Worker loop that processes queued requests sequentially
   */
  private async processQueue(): Promise<void> {
    if (this.processing) {
      return; // Already processing
    }

    this.processing = true;
    log("[GeminiQueue] Worker started");

    while (this.queue.length > 0) {
      const request = this.queue.shift();
      if (!request) break;

      log(`[GeminiQueue] Processing request (${this.queue.length} remaining in queue)`);

      try {
        // Wait for next available slot
        await this.waitForNextSlot();

        // Execute the request
        const response = await request.fetchFn();
        this.lastRequestTime = Date.now();

        // Check for rate limit response
        if (response.status === 429) {
          this.totalErrors++;
          const errorText = await response.clone().text();
          this.handleRateLimitResponse(errorText);
          log(`[GeminiQueue] Rate limit hit (429), adjusted delay to ${this.minDelayMs}ms`);
        } else {
          // Success - reset error tracking
          this.handleSuccessResponse();
        }

        this.totalProcessed++;
        request.resolve(response);
      } catch (error) {
        // Network error or other exception
        this.totalErrors++;
        log(`[GeminiQueue] Request failed with error: ${error}`);
        request.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }

    this.processing = false;
    log("[GeminiQueue] Worker stopped (queue empty)");
  }

  /**
   * Wait for the next available request slot
   * Enforces minimum delay between requests with exponential backoff for errors
   */
  private async waitForNextSlot(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    // Calculate delay with exponential backoff for consecutive errors
    let delayMs = this.minDelayMs;
    if (this.consecutiveErrors > 0) {
      // Exponential backoff: minDelayMs * (1 + consecutiveErrors * 0.5)
      const backoffMultiplier = 1 + this.consecutiveErrors * 0.5;
      delayMs = Math.min(this.minDelayMs * backoffMultiplier, this.maxDelayMs);
      log(`[GeminiQueue] Applying backoff (${this.consecutiveErrors} errors): ${delayMs}ms`);
    }

    // Wait if needed
    if (timeSinceLastRequest < delayMs) {
      const waitMs = delayMs - timeSinceLastRequest;
      log(`[GeminiQueue] Waiting ${waitMs}ms before next request`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  /**
   * Handle rate limit response (429 error)
   * Parse quotaResetDelay and adjust delays accordingly
   */
  private handleRateLimitResponse(errorText: string): void {
    this.consecutiveErrors++;

    try {
      const errorData = JSON.parse(errorText);

      // Look for quotaResetDelay in error details
      // Format: "2.893149709s" or "3s"
      const quotaDetail = errorData?.error?.details?.find((d: any) => d.quotaResetDelay);
      if (quotaDetail?.quotaResetDelay) {
        const delayStr = quotaDetail.quotaResetDelay;
        const match = delayStr.match(/(\d+(?:\.\d+)?)/);
        if (match) {
          const delaySeconds = parseFloat(match[1]);
          const suggestedDelayMs = Math.ceil(delaySeconds * 1000);

          // Use the larger of suggested delay or current delay
          this.minDelayMs = Math.max(
            suggestedDelayMs,
            this.minDelayMs,
            this.baseDelayMs
          );

          // Cap at maxDelayMs
          this.minDelayMs = Math.min(this.minDelayMs, this.maxDelayMs);

          log(
            `[GeminiQueue] Parsed quotaResetDelay: ${delayStr} (${suggestedDelayMs}ms), ` +
            `new minDelay: ${this.minDelayMs}ms`
          );
        }
      }
    } catch {
      // JSON parse failed, just increment error counter
      log(`[GeminiQueue] Failed to parse rate limit response, using backoff`);
    }

    // Apply exponential backoff
    const backoffMultiplier = 1 + this.consecutiveErrors * 0.5;
    this.minDelayMs = Math.min(
      this.baseDelayMs * backoffMultiplier,
      this.maxDelayMs
    );
  }

  /**
   * Handle successful response
   * Reset error counter and gradually reduce delay back to baseline
   */
  private handleSuccessResponse(): void {
    if (this.consecutiveErrors > 0) {
      log(`[GeminiQueue] Success after ${this.consecutiveErrors} errors, resetting counter`);
      this.consecutiveErrors = 0;
    }

    // Gradually reduce delay back to baseline
    if (this.minDelayMs > this.baseDelayMs) {
      this.minDelayMs = Math.max(
        this.baseDelayMs,
        this.minDelayMs * 0.9 // Reduce by 10%
      );
      log(`[GeminiQueue] Reducing delay to ${this.minDelayMs}ms`);
    }
  }

  /**
   * Get current queue statistics for monitoring
   */
  getStats(): QueueStats {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      consecutiveErrors: this.consecutiveErrors,
      currentDelayMs: this.minDelayMs,
      totalProcessed: this.totalProcessed,
      totalErrors: this.totalErrors,
    };
  }
}
