/**
 * RequestQueue — shared FIFO queue with pluggable processing strategy.
 *
 * Handles: enqueue, queue size limit, stats, processing lifecycle.
 * Does NOT handle: rate limiting, concurrency, backoff — those are
 * delegated to a RequestQueueStrategy.
 *
 * Two built-in strategies:
 * - RateLimitStrategy: sequential processing with delay/backoff (Gemini, OpenRouter)
 * - ConcurrencyStrategy: parallel slot management with OOM retry (local models)
 */

import { getLogLevel, log } from "../../logger.js";

// ─── Types ───────────────────────────────────────────────

interface QueuedRequest {
  fetchFn: () => Promise<Response>;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

export interface RequestQueueStats {
  queueLength: number;
  processing: boolean;
  totalProcessed: number;
  totalErrors: number;
}

/**
 * Strategy that controls how the queue processes requests.
 */
export interface RequestQueueStrategy {
  /** Human-readable name for logging */
  name: string;

  /**
   * Process all queued requests. Called when items are enqueued
   * and the queue is not already processing.
   *
   * The strategy controls sequencing (sequential vs parallel),
   * timing (delays, backoff), and error handling (retry, OOM).
   *
   * Must call request.resolve() or request.reject() for each item.
   */
  processQueue(
    queue: QueuedRequest[],
    stats: { totalProcessed: number; totalErrors: number },
  ): Promise<void>;
}

// ─── RequestQueue ────────────────────────────────────────

export class RequestQueue {
  private queue: QueuedRequest[] = [];
  private processing = false;
  private strategy: RequestQueueStrategy;
  private logPrefix: string;

  // Stats
  totalProcessed = 0;
  totalErrors = 0;

  // Configuration
  private readonly maxQueueSize: number;

  constructor(strategy: RequestQueueStrategy, opts?: { maxQueueSize?: number; logPrefix?: string }) {
    this.strategy = strategy;
    this.maxQueueSize = opts?.maxQueueSize ?? 100;
    this.logPrefix = opts?.logPrefix ?? strategy.name;
  }

  async enqueue(fetchFn: () => Promise<Response>): Promise<Response> {
    if (this.queue.length >= this.maxQueueSize) {
      if (getLogLevel() === "debug") {
        log(`[${this.logPrefix}] Queue full (${this.queue.length}/${this.maxQueueSize}), rejecting`);
      }
      throw new Error(`${this.logPrefix} request queue full. Please retry later.`);
    }

    return new Promise<Response>((resolve, reject) => {
      this.queue.push({ fetchFn, resolve, reject });
      if (getLogLevel() === "debug") {
        log(`[${this.logPrefix}] Enqueued (queue length: ${this.queue.length})`);
      }
      if (!this.processing) {
        this.startProcessing();
      }
    });
  }

  private async startProcessing(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    if (getLogLevel() === "debug") {
      log(`[${this.logPrefix}] Worker started`);
    }

    await this.strategy.processQueue(this.queue, this);

    this.processing = false;
    if (getLogLevel() === "debug") {
      log(`[${this.logPrefix}] Worker stopped (queue empty)`);
    }
  }

  /** Re-enter processing loop (used by concurrent strategies after a request completes) */
  scheduleProcessing(): void {
    if (this.queue.length > 0 && !this.processing) {
      this.startProcessing();
    }
  }

  getStats(): RequestQueueStats {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      totalProcessed: this.totalProcessed,
      totalErrors: this.totalErrors,
    };
  }
}

// ─── RateLimitStrategy ───────────────────────────────────

export interface RateLimitHandler {
  /** Calculate delay (ms) before the next request. */
  getDelay(consecutiveErrors: number): number;
  /** Called after each response. Update internal state (parse headers, adjust delays). */
  onResponse(response: Response, consecutiveErrors: number): void | Promise<void>;
  /** Called on success to allow gradual delay reduction. */
  onSuccess(): void;
}

/**
 * Sequential processing with delay between requests and error backoff.
 * Provider-specific rate limit parsing is delegated to a RateLimitHandler.
 */
export class RateLimitStrategy implements RequestQueueStrategy {
  name: string;
  private handler: RateLimitHandler;
  private consecutiveErrors = 0;
  private lastRequestTime = 0;

  constructor(name: string, handler: RateLimitHandler) {
    this.name = name;
    this.handler = handler;
  }

  async processQueue(
    queue: QueuedRequest[],
    stats: { totalProcessed: number; totalErrors: number },
  ): Promise<void> {
    while (queue.length > 0) {
      const request = queue.shift();
      if (!request) break;

      if (getLogLevel() === "debug") {
        log(`[${this.name}] Processing request (${queue.length} remaining)`);
      }

      try {
        // Wait for rate limit delay
        const delayMs = this.handler.getDelay(this.consecutiveErrors);
        const elapsed = Date.now() - this.lastRequestTime;
        if (elapsed < delayMs) {
          const waitMs = delayMs - elapsed;
          if (getLogLevel() === "debug") {
            log(`[${this.name}] Waiting ${waitMs}ms`);
          }
          await new Promise((r) => setTimeout(r, waitMs));
        }

        const response = await request.fetchFn();
        this.lastRequestTime = Date.now();

        // Let handler parse headers / adjust state
        await this.handler.onResponse(response, this.consecutiveErrors);

        if (response.status === 429) {
          stats.totalErrors++;
          this.consecutiveErrors++;
        } else {
          this.consecutiveErrors = 0;
          this.handler.onSuccess();
        }

        stats.totalProcessed++;
        request.resolve(response);
      } catch (error) {
        stats.totalErrors++;
        this.consecutiveErrors++;
        if (getLogLevel() === "debug") {
          log(`[${this.name}] Request failed: ${error}`);
        }
        request.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}

// ─── ConcurrencyStrategy ─────────────────────────────────

export interface ConcurrencyStrategyOptions {
  maxParallel: number;
  /** Delay between dispatches to prevent races (ms). Default: 100. */
  dispatchDelay?: number;
  /** Called on 500 responses to detect OOM. Return true to retry. */
  isRetryableError?: (responseBody: string) => boolean;
  /** Delay before OOM retry (ms). Default: 2000. */
  retryDelay?: number;
}

/**
 * Parallel processing with configurable concurrency slots.
 * Supports OOM detection and single retry.
 */
export class ConcurrencyStrategy implements RequestQueueStrategy {
  name: string;
  private activeRequests = 0;
  private maxParallel: number;
  private dispatchDelay: number;
  private isRetryableError: ((body: string) => boolean) | undefined;
  private retryDelay: number;
  private retryableErrors = 0;
  private ownerQueue: RequestQueue | null = null;

  constructor(name: string, opts: ConcurrencyStrategyOptions) {
    this.name = name;
    this.maxParallel = opts.maxParallel;
    this.dispatchDelay = opts.dispatchDelay ?? 100;
    this.isRetryableError = opts.isRetryableError;
    this.retryDelay = opts.retryDelay ?? 2000;
  }

  getActiveRequests(): number { return this.activeRequests; }
  getMaxParallel(): number { return this.maxParallel; }
  setMaxParallel(n: number): void { this.maxParallel = n; }
  getRetryableErrors(): number { return this.retryableErrors; }

  async processQueue(
    queue: QueuedRequest[],
    stats: { totalProcessed: number; totalErrors: number },
  ): Promise<void> {
    // Stash stats ref so executeRequest can update it
    const ctx = { queue, stats };

    while (queue.length > 0 && this.activeRequests < this.maxParallel) {
      const request = queue.shift();
      if (!request) break;

      if (getLogLevel() === "debug") {
        log(`[${this.name}] Processing (${queue.length} queued, ${this.activeRequests + 1}/${this.maxParallel} active)`);
      }

      // Fire without awaiting to allow parallelism
      this.executeRequest(request, ctx).catch((err) => {
        if (getLogLevel() === "debug") {
          log(`[${this.name}] Execution failed: ${err}`);
        }
      });

      if (this.dispatchDelay > 0) {
        await new Promise((r) => setTimeout(r, this.dispatchDelay));
      }
    }
  }

  private async executeRequest(
    request: QueuedRequest,
    ctx: { queue: QueuedRequest[]; stats: { totalProcessed: number; totalErrors: number } },
  ): Promise<void> {
    this.activeRequests++;

    try {
      const response = await request.fetchFn();

      // Check for retryable error (e.g. OOM)
      if (response.status === 500 && this.isRetryableError) {
        const body = await response.clone().text();
        if (this.isRetryableError(body)) {
          this.retryableErrors++;
          if (getLogLevel() === "debug") {
            log(`[${this.name}] Retryable error detected, waiting ${this.retryDelay}ms`);
          }
          await new Promise((r) => setTimeout(r, this.retryDelay));

          const retry = await request.fetchFn();
          if (retry.status === 500 && this.isRetryableError) {
            const retryBody = await retry.clone().text();
            if (this.isRetryableError(retryBody)) {
              throw new Error(`Retryable error persisted after retry. Reduce concurrency.`);
            }
          }
          ctx.stats.totalProcessed++;
          request.resolve(retry);
          return;
        }
      }

      ctx.stats.totalProcessed++;
      request.resolve(response);
    } catch (error) {
      ctx.stats.totalErrors++;
      if (getLogLevel() === "debug") {
        log(`[${this.name}] Request failed: ${error}`);
      }
      request.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.activeRequests--;
      // Re-enter processing loop if more items are waiting
      if (ctx.queue.length > 0 && this.activeRequests < this.maxParallel) {
        this.processQueue(ctx.queue, ctx.stats);
      }
    }
  }
}
