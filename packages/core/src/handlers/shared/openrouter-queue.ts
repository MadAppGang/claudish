/**
 * OpenRouter Request Queue
 *
 * Singleton request queue for serializing OpenRouter API requests to prevent rate limit exhaustion.
 * Implements dynamic rate limiting based on OpenRouter rate limit headers and 429 error responses.
 *
 * All OpenRouter requests are processed sequentially through a FIFO queue with:
 * - Minimum delay between requests (default 1000ms = 60 req/min)
 * - Dynamic delay adjustment based on rate limit headers
 * - Proactive throttling when quota is low
 * - Exponential backoff for consecutive errors
 * - Automatic queue size management (max 100 requests)
 *
 * Rate limit headers parsed:
 * - X-RateLimit-Limit-Requests: Total requests allowed
 * - X-RateLimit-Remaining-Requests: Remaining requests in current window
 * - X-RateLimit-Reset-Requests: Unix timestamp when limit resets
 * - X-RateLimit-Remaining-Tokens: Remaining tokens in current window
 * - Retry-After: Seconds to wait after 429 error
 */

import { getLogLevel, log } from "../../logger.js";

/**
 * Queued request with Promise callbacks
 */
interface QueuedRequest {
  fetchFn: () => Promise<Response>;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

/**
 * Rate limit state tracked from response headers
 */
interface RateLimitState {
  // From response headers
  limitRequests: number | null;
  limitTokens: number | null;
  remainingRequests: number | null;
  remainingTokens: number | null;
  resetTime: number | null; // Unix timestamp (seconds)

  // Internal tracking
  lastRequestTime: number;
  consecutiveErrors: number;
  currentDelayMs: number;

  // Statistics
  totalProcessed: number;
  totalErrors: number;
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
 * Singleton request queue for OpenRouter API
 *
 * Serializes all OpenRouter requests to prevent rate limit exhaustion.
 * Implements dynamic rate limiting based on response headers and 429 errors.
 *
 * @example
 * ```typescript
 * const queue = OpenRouterRequestQueue.getInstance();
 * const response = await queue.enqueue(() => fetch(url, options));
 * ```
 */
export class OpenRouterRequestQueue {
  private static instance: OpenRouterRequestQueue | null = null;
  private queue: QueuedRequest[] = [];
  private processing = false;

  // Rate limit state
  private rateLimitState: RateLimitState = {
    limitRequests: null,
    limitTokens: null,
    remainingRequests: null,
    remainingTokens: null,
    resetTime: null,
    lastRequestTime: 0,
    consecutiveErrors: 0,
    currentDelayMs: 1000,
    totalProcessed: 0,
    totalErrors: 0,
    total429Errors: 0,
  };

  // Configuration constants
  private readonly baseDelayMs = 1000; // 60 req/min
  private readonly maxDelayMs = 10000; // Max 10s delay
  private readonly maxQueueSize = 100;

  private constructor() {
    if (getLogLevel() === "debug") {
      log("[OpenRouterQueue] Queue initialized with baseDelay=1000ms, maxQueueSize=100");
    }
  }

  /**
   * Get singleton instance
   */
  static getInstance(): OpenRouterRequestQueue {
    if (!OpenRouterRequestQueue.instance) {
      OpenRouterRequestQueue.instance = new OpenRouterRequestQueue();
    }
    return OpenRouterRequestQueue.instance;
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
      if (getLogLevel() === "debug") {
        log(
          `[OpenRouterQueue] Queue full (${this.queue.length}/${this.maxQueueSize}), rejecting request`
        );
      }
      throw new Error(
        `OpenRouter request queue full (${this.queue.length}/${this.maxQueueSize}). The API is rate-limited. Please wait and try again.`
      );
    }

    // Create promise for this request
    return new Promise<Response>((resolve, reject) => {
      const queuedRequest: QueuedRequest = {
        fetchFn,
        resolve,
        reject,
      };

      this.queue.push(queuedRequest);
      if (getLogLevel() === "debug") {
        log(`[OpenRouterQueue] Request enqueued (queue length: ${this.queue.length})`);
      }

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
    if (getLogLevel() === "debug") {
      log("[OpenRouterQueue] Worker started");
    }

    while (this.queue.length > 0) {
      const request = this.queue.shift();
      if (!request) break;

      if (getLogLevel() === "debug") {
        log(`[OpenRouterQueue] Processing request (${this.queue.length} remaining in queue)`);
      }

      try {
        // Wait for next available slot
        await this.waitForNextSlot();

        // Execute the request
        const response = await request.fetchFn();
        this.rateLimitState.lastRequestTime = Date.now();

        // Parse rate limit headers
        this.parseRateLimitHeaders(response);

        // Check for rate limit response
        if (response.status === 429) {
          this.rateLimitState.totalErrors++;
          this.rateLimitState.total429Errors++;
          await this.handleRateLimitError(response);
          if (getLogLevel() === "debug") {
            log(
              `[OpenRouterQueue] Rate limit hit (429), adjusted delay to ${this.rateLimitState.currentDelayMs}ms`
            );
          }
        } else {
          // Success - reset error tracking
          this.handleSuccessResponse();
        }

        this.rateLimitState.totalProcessed++;
        request.resolve(response);
      } catch (error) {
        // Network error or other exception
        this.rateLimitState.totalErrors++;
        this.rateLimitState.consecutiveErrors++;
        if (getLogLevel() === "debug") {
          log(`[OpenRouterQueue] Request failed with error: ${error}`);
        }
        request.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }

    this.processing = false;
    if (getLogLevel() === "debug") {
      log("[OpenRouterQueue] Worker stopped (queue empty)");
    }
  }

  /**
   * Wait for the next available request slot
   * Enforces minimum delay between requests with dynamic adjustment
   */
  private async waitForNextSlot(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.rateLimitState.lastRequestTime;

    // Calculate delay based on current state
    const delayMs = this.calculateDelay();
    this.rateLimitState.currentDelayMs = delayMs;

    // Wait if needed
    if (timeSinceLastRequest < delayMs) {
      const waitMs = delayMs - timeSinceLastRequest;
      if (getLogLevel() === "debug") {
        log(`[OpenRouterQueue] Waiting ${waitMs}ms before next request`);
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  /**
   * Calculate dynamic delay based on rate limit state
   * Considers remaining quota, reset time, and error backoff
   */
  private calculateDelay(): number {
    let delayMs = this.baseDelayMs;

    // Factor 1: Remaining requests (proactive throttling)
    if (
      this.rateLimitState.remainingRequests !== null &&
      this.rateLimitState.limitRequests !== null &&
      this.rateLimitState.limitRequests > 0
    ) {
      const quotaPercent =
        this.rateLimitState.remainingRequests / this.rateLimitState.limitRequests;
      if (quotaPercent < 0.2) {
        // Less than 20% quota remaining - slow down significantly
        delayMs = Math.max(delayMs, 3000);
        if (getLogLevel() === "debug") {
          log(
            `[OpenRouterQueue] Low quota (${(quotaPercent * 100).toFixed(1)}%), increasing delay to ${delayMs}ms`
          );
        }
      } else if (quotaPercent < 0.5) {
        // Less than 50% quota remaining - moderate slowdown
        delayMs = Math.max(delayMs, 2000);
        if (getLogLevel() === "debug") {
          log(
            `[OpenRouterQueue] Medium quota (${(quotaPercent * 100).toFixed(1)}%), increasing delay to ${delayMs}ms`
          );
        }
      }
    }

    // Factor 2: Time until reset (spread requests evenly)
    if (this.rateLimitState.resetTime !== null && this.rateLimitState.remainingRequests !== null) {
      const now = Date.now() / 1000; // Convert to Unix timestamp
      const timeUntilReset = this.rateLimitState.resetTime - now;
      if (timeUntilReset > 0 && this.rateLimitState.remainingRequests > 0) {
        // Spread remaining requests evenly until reset
        const optimalDelay =
          (timeUntilReset * 1000) / Math.max(this.rateLimitState.remainingRequests, 1);
        delayMs = Math.max(delayMs, Math.min(optimalDelay, this.maxDelayMs));
        if (getLogLevel() === "debug") {
          log(
            `[OpenRouterQueue] Spreading ${this.rateLimitState.remainingRequests} requests ` +
              `over ${timeUntilReset.toFixed(1)}s, optimal delay: ${optimalDelay.toFixed(0)}ms`
          );
        }
      }
    }

    // Factor 3: Consecutive errors (exponential backoff)
    if (this.rateLimitState.consecutiveErrors > 0) {
      const backoffMultiplier = 1 + this.rateLimitState.consecutiveErrors * 0.5;
      delayMs = delayMs * backoffMultiplier;
      if (getLogLevel() === "debug") {
        log(
          `[OpenRouterQueue] Applying backoff (${this.rateLimitState.consecutiveErrors} errors): ${delayMs.toFixed(0)}ms`
        );
      }
    }

    // Cap at maximum
    return Math.min(delayMs, this.maxDelayMs);
  }

  /**
   * Parse rate limit headers from response
   * Updates internal rate limit state
   */
  private parseRateLimitHeaders(response: Response): void {
    // Parse request limits
    const limitRequests = response.headers.get("X-RateLimit-Limit-Requests");
    if (limitRequests) {
      this.rateLimitState.limitRequests = Number.parseInt(limitRequests, 10);
    }

    const remainingRequests = response.headers.get("X-RateLimit-Remaining-Requests");
    if (remainingRequests) {
      this.rateLimitState.remainingRequests = Number.parseInt(remainingRequests, 10);
    }

    const resetRequests = response.headers.get("X-RateLimit-Reset-Requests");
    if (resetRequests) {
      this.rateLimitState.resetTime = Number.parseFloat(resetRequests);
    }

    // Parse token limits
    const limitTokens = response.headers.get("X-RateLimit-Limit-Tokens");
    if (limitTokens) {
      this.rateLimitState.limitTokens = Number.parseInt(limitTokens, 10);
    }

    const remainingTokens = response.headers.get("X-RateLimit-Remaining-Tokens");
    if (remainingTokens) {
      this.rateLimitState.remainingTokens = Number.parseInt(remainingTokens, 10);
    }

    // Debug log headers
    if (getLogLevel() === "debug") {
      const headers = {
        limitRequests: this.rateLimitState.limitRequests,
        remainingRequests: this.rateLimitState.remainingRequests,
        resetTime: this.rateLimitState.resetTime
          ? new Date(this.rateLimitState.resetTime * 1000).toISOString()
          : null,
        limitTokens: this.rateLimitState.limitTokens,
        remainingTokens: this.rateLimitState.remainingTokens,
      };
      log(`[OpenRouterQueue] Rate limit headers: ${JSON.stringify(headers)}`);
    }
  }

  /**
   * Handle 429 rate limit error
   * Parse Retry-After header and apply exponential backoff
   */
  private async handleRateLimitError(response: Response): Promise<void> {
    this.rateLimitState.consecutiveErrors++;

    // Set remaining requests to 0 (quota exhausted)
    this.rateLimitState.remainingRequests = 0;

    // Parse Retry-After header (seconds to wait)
    const retryAfter = response.headers.get("Retry-After");
    if (retryAfter) {
      const retryAfterSeconds = Number.parseInt(retryAfter, 10);
      if (!Number.isNaN(retryAfterSeconds)) {
        const retryAfterMs = retryAfterSeconds * 1000;
        this.rateLimitState.currentDelayMs = Math.min(retryAfterMs, this.maxDelayMs);
        if (getLogLevel() === "debug") {
          log(`[OpenRouterQueue] Retry-After header: ${retryAfterSeconds}s (${retryAfterMs}ms)`);
        }
      }
    }

    // Try to parse error response body for additional info
    try {
      const errorText = await response.clone().text();
      const errorData = JSON.parse(errorText);
      if (errorData?.error?.message) {
        if (getLogLevel() === "debug") {
          log(`[OpenRouterQueue] 429 error message: ${errorData.error.message}`);
        }
      }
    } catch {
      // Ignore JSON parse errors
    }

    // Apply exponential backoff
    const backoffMultiplier = 1 + this.rateLimitState.consecutiveErrors * 0.5;
    const backoffDelay = Math.min(this.baseDelayMs * backoffMultiplier, this.maxDelayMs);
    this.rateLimitState.currentDelayMs = Math.max(this.rateLimitState.currentDelayMs, backoffDelay);

    if (getLogLevel() === "debug") {
      log(
        `[OpenRouterQueue] Applied exponential backoff: ${this.rateLimitState.currentDelayMs}ms ` +
          `(${this.rateLimitState.consecutiveErrors} consecutive errors)`
      );
    }
  }

  /**
   * Handle successful response
   * Reset error counter and gradually reduce delay back to baseline
   */
  private handleSuccessResponse(): void {
    if (this.rateLimitState.consecutiveErrors > 0) {
      if (getLogLevel() === "debug") {
        log(
          `[OpenRouterQueue] Success after ${this.rateLimitState.consecutiveErrors} errors, resetting counter`
        );
      }
      this.rateLimitState.consecutiveErrors = 0;
    }

    // Gradually reduce delay back to baseline
    if (this.rateLimitState.currentDelayMs > this.baseDelayMs) {
      this.rateLimitState.currentDelayMs = Math.max(
        this.baseDelayMs,
        this.rateLimitState.currentDelayMs * 0.9 // Reduce by 10%
      );
      if (getLogLevel() === "debug") {
        log(`[OpenRouterQueue] Reducing delay to ${this.rateLimitState.currentDelayMs}ms`);
      }
    }
  }

  /**
   * Get current queue statistics for monitoring
   */
  getStats(): QueueStats {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      consecutiveErrors: this.rateLimitState.consecutiveErrors,
      currentDelayMs: this.rateLimitState.currentDelayMs,
      totalProcessed: this.rateLimitState.totalProcessed,
      totalErrors: this.rateLimitState.totalErrors,
      total429Errors: this.rateLimitState.total429Errors,
      remainingRequests: this.rateLimitState.remainingRequests,
      remainingTokens: this.rateLimitState.remainingTokens,
      resetTime: this.rateLimitState.resetTime,
    };
  }
}
