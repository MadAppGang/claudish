/**
 * Local Model Request Queue
 *
 * Singleton queue for controlling concurrency to local models (Ollama, LM Studio, vLLM, MLX, etc.)
 * to prevent GPU overload. Implements configurable parallelism with FIFO ordering.
 *
 * Unlike the OpenRouter queue which focuses on rate limiting (429 errors), this queue
 * focuses on concurrency control to prevent GPU memory exhaustion.
 *
 * All local model requests are processed through this queue with:
 * - Configurable max parallel requests (default 1 = sequential)
 * - FIFO ordering for fairness
 * - OOM error detection and retry logic
 * - Automatic queue size management (max 100 requests)
 * - Minimal delay between dispatches (100ms)
 *
 * New: Concurrency can be specified per-model using the model syntax:
 *   ollama@llama3.2:3    - Allow 3 concurrent requests
 *   ollama@llama3.2:0    - Unlimited concurrency (bypass queue)
 *
 * Environment variables:
 * - CLAUDISH_LOCAL_MAX_PARALLEL: Max concurrent requests (1-8, default: 1)
 * - CLAUDISH_LOCAL_QUEUE_ENABLED: Enable/disable queue (default: true)
 */

import { getLogLevel, log } from "../../logger.js";

/**
 * Queued request with Promise callbacks
 */
interface QueuedRequest {
  fetchFn: () => Promise<Response>;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  providerId: string; // For debugging/stats (e.g., "ollama", "lmstudio")
}

/**
 * Queue statistics for monitoring
 */
export interface QueueStats {
  queueLength: number;
  activeRequests: number;
  maxParallel: number;
  totalProcessed: number;
  totalErrors: number;
  totalOOMErrors: number;
}

/**
 * Singleton request queue for local models
 *
 * Implements concurrency control to prevent GPU overload by limiting
 * the number of simultaneous requests to local models.
 *
 * Concurrency can be overridden per-model using the :N suffix in model spec:
 * - :0 = bypass queue entirely (unlimited)
 * - :N = override max parallel to N for this model
 *
 * @example
 * ```typescript
 * const queue = LocalModelQueue.getInstance();
 * const response = await queue.enqueue(() => fetch(url, options), "ollama");
 *
 * // With custom concurrency (bypasses default)
 * const response = await queue.enqueue(() => fetch(url, options), "ollama", 3);
 * ```
 */
export class LocalModelQueue {
  private static instance: LocalModelQueue | null = null;
  private queue: QueuedRequest[] = [];
  private activeRequests = 0;

  // Configuration
  private readonly defaultMaxParallel: number; // From CLAUDISH_LOCAL_MAX_PARALLEL
  private maxParallel: number; // Current effective max (can be overridden)
  private readonly maxQueueSize = 100;
  private readonly requestDelay = 100; // Small delay between dispatches (ms)

  // Statistics
  private totalProcessed = 0;
  private totalErrors = 0;
  private totalOOMErrors = 0;

  private constructor() {
    this.defaultMaxParallel = this.getMaxParallelFromEnv();
    this.maxParallel = this.defaultMaxParallel;
    if (getLogLevel() === "debug") {
      log(
        `[LocalQueue] Queue initialized with maxParallel=${this.maxParallel}, maxQueueSize=${this.maxQueueSize}`
      );
    }
  }

  /**
   * Get singleton instance
   */
  static getInstance(): LocalModelQueue {
    if (!LocalModelQueue.instance) {
      LocalModelQueue.instance = new LocalModelQueue();
    }
    return LocalModelQueue.instance;
  }

  /**
   * Check if queue is enabled via environment variable
   */
  static isEnabled(): boolean {
    const enabled = process.env.CLAUDISH_LOCAL_QUEUE_ENABLED;
    if (enabled === undefined || enabled === "") return true; // Default: enabled
    return enabled !== "false" && enabled !== "0";
  }

  /**
   * Enqueue a request to be processed
   *
   * @param fetchFn - Function that performs the fetch request
   * @param providerId - Provider identifier for debugging (e.g., "ollama", "lmstudio")
   * @param concurrencyOverride - Optional concurrency override from model spec
   *   - undefined: use default max parallel
   *   - 0: bypass queue entirely (direct execution)
   *   - N: use N as max parallel for this request
   * @returns Promise that resolves with the response
   * @throws Error if queue is full
   */
  async enqueue(
    fetchFn: () => Promise<Response>,
    providerId: string,
    concurrencyOverride?: number
  ): Promise<Response> {
    // Handle concurrency override
    if (concurrencyOverride !== undefined) {
      if (concurrencyOverride === 0) {
        // :0 means bypass queue entirely - execute directly
        if (getLogLevel() === "debug") {
          log(`[LocalQueue] Bypassing queue for ${providerId} (concurrency=0)`);
        }
        return fetchFn();
      }

      // Override max parallel for this session
      if (concurrencyOverride !== this.maxParallel && concurrencyOverride > 0) {
        const newMax = Math.min(concurrencyOverride, 8); // Cap at 8
        if (getLogLevel() === "debug") {
          log(`[LocalQueue] Overriding maxParallel: ${this.maxParallel} -> ${newMax} for ${providerId}`);
        }
        this.maxParallel = newMax;
      }
    }

    // Check queue size limit
    if (this.queue.length >= this.maxQueueSize) {
      if (getLogLevel() === "debug") {
        log(
          `[LocalQueue] Queue full (${this.queue.length}/${this.maxQueueSize}), rejecting request`
        );
      }
      throw new Error(
        `Local model queue full (${this.queue.length}/${this.maxQueueSize}). GPU is overloaded. Please wait for current requests to complete.`
      );
    }

    // Create promise for this request
    return new Promise<Response>((resolve, reject) => {
      const queuedRequest: QueuedRequest = {
        fetchFn,
        resolve,
        reject,
        providerId,
      };

      this.queue.push(queuedRequest);
      if (getLogLevel() === "debug") {
        log(
          `[LocalQueue] Request enqueued for ${providerId} (queue length: ${this.queue.length}, active: ${this.activeRequests}/${this.maxParallel})`
        );
      }

      // Start processing queue if there are available slots
      this.processQueue();
    });
  }

  /**
   * Worker loop that processes queued requests with concurrency control
   * Processes requests while:
   * 1. Queue has items
   * 2. Active requests < maxParallel
   */
  private async processQueue(): Promise<void> {
    // Process requests while queue has items AND slots available
    while (this.queue.length > 0 && this.activeRequests < this.maxParallel) {
      const request = this.queue.shift();
      if (!request) break;

      if (getLogLevel() === "debug") {
        log(
          `[LocalQueue] Processing request for ${request.providerId} (${this.queue.length} remaining in queue, ${this.activeRequests + 1}/${this.maxParallel} active)`
        );
      }

      // Execute in parallel (don't await here) to allow concurrent processing
      this.executeRequest(request).catch((err) => {
        if (getLogLevel() === "debug") {
          log(`[LocalQueue] Request execution failed: ${err}`);
        }
      });

      // Small delay between dispatches to avoid race conditions
      await this.delay(this.requestDelay);
    }
  }

  /**
   * Execute a single request with OOM error handling
   */
  private async executeRequest(request: QueuedRequest): Promise<void> {
    this.activeRequests++;

    try {
      const response = await request.fetchFn();

      // Check for OOM error (GPU out of memory)
      if (response.status === 500) {
        const errorBody = await response.clone().text();
        if (this.isOOMError(errorBody)) {
          this.totalOOMErrors++;
          if (getLogLevel() === "debug") {
            log(
              `[LocalQueue] GPU out-of-memory detected for ${request.providerId}. Consider reducing CLAUDISH_LOCAL_MAX_PARALLEL (current: ${this.maxParallel})`
            );
          }

          // Retry once after a delay
          await this.delay(2000); // 2-second delay before retry
          const retryResponse = await request.fetchFn();

          // Check retry response
          if (retryResponse.status === 500) {
            const retryErrorBody = await retryResponse.clone().text();
            if (this.isOOMError(retryErrorBody)) {
              // OOM persisted after retry - fail with helpful message
              throw new Error(
                `GPU out-of-memory error persisted after retry. Try setting CLAUDISH_LOCAL_MAX_PARALLEL=1 for sequential processing.`
              );
            }
          }

          // Retry succeeded
          this.totalProcessed++;
          request.resolve(retryResponse);
          return;
        }
      }

      // Success (no OOM)
      this.totalProcessed++;
      request.resolve(response);
    } catch (error) {
      // Network error or other exception
      this.totalErrors++;
      if (getLogLevel() === "debug") {
        log(`[LocalQueue] Request failed for ${request.providerId}: ${error}`);
      }
      request.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.activeRequests--;

      // Trigger next batch if queue still has items
      if (this.queue.length > 0) {
        this.processQueue();
      }
    }
  }

  /**
   * Detect GPU out-of-memory errors from response body
   * Checks for common OOM error messages from various providers
   */
  private isOOMError(errorBody: string): boolean {
    const oomPatterns = [
      "failed to allocate memory",
      "CUDA out of memory",
      "OOM",
      "out of memory",
      "memory allocation failed",
      "insufficient memory",
      "GPU memory",
    ];

    const bodyLower = errorBody.toLowerCase();
    return oomPatterns.some((pattern) => bodyLower.includes(pattern.toLowerCase()));
  }

  /**
   * Read and validate CLAUDISH_LOCAL_MAX_PARALLEL environment variable
   * Returns max parallel requests (1-8 range, default: 1)
   */
  private getMaxParallelFromEnv(): number {
    const envValue = process.env.CLAUDISH_LOCAL_MAX_PARALLEL;
    if (!envValue) return 1; // Default: sequential

    const parsed = Number.parseInt(envValue, 10);
    if (Number.isNaN(parsed) || parsed < 1) {
      log(
        `[LocalQueue] Invalid CLAUDISH_LOCAL_MAX_PARALLEL: ${envValue}, using default: 1`
      );
      return 1;
    }

    if (parsed > 8) {
      log(`[LocalQueue] CLAUDISH_LOCAL_MAX_PARALLEL too high: ${parsed}, capping at 8`);
      return 8;
    }

    return parsed;
  }

  /**
   * Utility: delay for specified milliseconds
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get current queue statistics for monitoring
   */
  getStats(): QueueStats {
    return {
      queueLength: this.queue.length,
      activeRequests: this.activeRequests,
      maxParallel: this.maxParallel,
      totalProcessed: this.totalProcessed,
      totalErrors: this.totalErrors,
      totalOOMErrors: this.totalOOMErrors,
    };
  }
}
