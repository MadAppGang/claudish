/**
 * Local Model Request Queue
 *
 * Controls concurrency to local models (Ollama, LM Studio, vLLM, MLX, etc.) to
 * prevent GPU overload. Unlike the rate-limit queues, this one focuses on
 * concurrency: a configurable number of parallel requests, a small delay between
 * dispatches, and a one-shot retry when the GPU reports out-of-memory. The
 * FIFO/concurrency mechanics live in the shared RequestQueue base; this class
 * supplies the local-GPU policy.
 *
 * Concurrency can be specified per-model with the model syntax:
 *   ollama@llama3.2:3    - allow 3 concurrent requests
 *   ollama@llama3.2:0    - unlimited concurrency (bypass queue)
 *
 * Environment variables:
 * - CLAUDISH_LOCAL_MAX_PARALLEL: max concurrent requests (1-8, default: 1)
 * - CLAUDISH_LOCAL_QUEUE_ENABLED: enable/disable queue (default: true)
 */

import { log } from "../../logger.js";
import { RequestQueue, toAbortError } from "./request-queue.js";

const OOM_PATTERNS = [
  "failed to allocate memory",
  "cuda out of memory",
  "oom",
  "out of memory",
  "memory allocation failed",
  "insufficient memory",
  "gpu memory",
];

/**
 * Read and validate CLAUDISH_LOCAL_MAX_PARALLEL. Returns max parallel requests
 * (1-8 range, default: 1).
 */
function maxParallelFromEnv(): number {
  const envValue = process.env.CLAUDISH_LOCAL_MAX_PARALLEL;
  if (!envValue) return 1; // Default: sequential

  const parsed = Number.parseInt(envValue, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    log(`[LocalQueue] Invalid CLAUDISH_LOCAL_MAX_PARALLEL: ${envValue}, using default: 1`);
    return 1;
  }
  if (parsed > 8) {
    log(`[LocalQueue] CLAUDISH_LOCAL_MAX_PARALLEL too high: ${parsed}, capping at 8`);
    return 8;
  }
  return parsed;
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
 * Singleton request queue for local models.
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
export class LocalModelQueue extends RequestQueue {
  private static instance: LocalModelQueue | null = null;
  private totalOOMErrors = 0;

  private constructor() {
    super({ name: "Local", maxParallel: maxParallelFromEnv(), dispatchDelayMs: 100 });
    this.debug(`Queue initialized with maxParallel=${this.maxParallel}, maxQueueSize=${this.maxQueueSize}`);
  }

  static getInstance(): LocalModelQueue {
    if (!LocalModelQueue.instance) {
      LocalModelQueue.instance = new LocalModelQueue();
    }
    return LocalModelQueue.instance;
  }

  /**
   * Check if the queue is enabled via environment variable.
   */
  static isEnabled(): boolean {
    const enabled = process.env.CLAUDISH_LOCAL_QUEUE_ENABLED;
    if (enabled === undefined || enabled === "") return true; // Default: enabled
    return enabled !== "false" && enabled !== "0";
  }

  /**
   * Enqueue a request to be processed.
   *
   * @param concurrencyOverride - from the model spec's `:N` suffix:
   *   undefined = use the default max parallel; 0 = bypass the queue entirely
   *   (direct execution); N = raise max parallel to N (capped at 8).
   * @param signal - cancels the request while it waits for a slot; once it is
   *   running, the fetch that was handed the same signal ends itself.
   * @throws Error if the queue is full, or an AbortError if `signal` has
   *   already aborted
   */
  enqueue(
    fetchFn: () => Promise<Response>,
    providerId: string,
    concurrencyOverride?: number,
    signal?: AbortSignal
  ): Promise<Response> {
    // Already cancelled before we even got here, bypass included, which never
    // reaches the queue's own check: never occupy a slot or start a fetch for it.
    if (signal?.aborted) {
      throw toAbortError(signal.reason);
    }
    if (concurrencyOverride !== undefined) {
      if (concurrencyOverride === 0) {
        this.debug(`Bypassing queue for ${providerId} (concurrency=0)`);
        return fetchFn();
      }
      if (concurrencyOverride !== this.maxParallel && concurrencyOverride > 0) {
        const newMax = Math.min(concurrencyOverride, 8); // Cap at 8
        this.debug(`Overriding maxParallel: ${this.maxParallel} -> ${newMax} for ${providerId}`);
        this.maxParallel = newMax;
      }
    }
    return this.enqueueInternal(fetchFn, providerId, signal);
  }

  protected override queueFullMessage(): string {
    return `Local model queue full (${this.queue.length}/${this.maxQueueSize}). GPU is overloaded. Please wait for current requests to complete.`;
  }

  protected override async shouldRetry(response: Response, attempt: number): Promise<boolean> {
    // Retry a GPU out-of-memory failure exactly once.
    if (attempt !== 0) return false;
    if (!(await this.isOOMResponse(response))) return false;
    this.totalOOMErrors++;
    this.debug(
      `GPU out-of-memory detected. Consider reducing CLAUDISH_LOCAL_MAX_PARALLEL (current: ${this.maxParallel})`
    );
    return true;
  }

  protected override retryDelayMs(): number {
    return 2000; // 2-second delay before the OOM retry
  }

  protected override async onResponse(response: Response): Promise<void> {
    // If OOM survived the retry, fail with an actionable message.
    if (await this.isOOMResponse(response)) {
      throw new Error(
        "GPU out-of-memory error persisted after retry. Try setting CLAUDISH_LOCAL_MAX_PARALLEL=1 for sequential processing."
      );
    }
  }

  /** Detect a GPU out-of-memory failure from a 500 response body. */
  private async isOOMResponse(response: Response): Promise<boolean> {
    if (response.status !== 500) return false;
    try {
      const body = (await response.clone().text()).toLowerCase();
      return OOM_PATTERNS.some((pattern) => body.includes(pattern));
    } catch {
      return false;
    }
  }

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
