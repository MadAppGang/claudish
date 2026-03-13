/**
 * Local Model Request Queue
 *
 * Thin wrapper around RequestQueue + ConcurrencyStrategy for GPU concurrency
 * control with OOM detection/retry.
 *
 * Concurrency can be specified per-model using model syntax:
 *   ollama@llama3.2:3    - Allow 3 concurrent requests
 *   ollama@llama3.2:0    - Unlimited concurrency (bypass queue)
 *
 * Environment variables:
 * - CLAUDISH_LOCAL_MAX_PARALLEL: Max concurrent requests (1-8, default: 1)
 * - CLAUDISH_LOCAL_QUEUE_ENABLED: Enable/disable queue (default: true)
 */

import { getLogLevel, log } from "../../logger.js";
import {
  RequestQueue,
  ConcurrencyStrategy,
  type RequestQueueStats,
} from "./request-queue.js";

// ─── OOM detection ──────────────────────────────────────

const OOM_PATTERNS = [
  "failed to allocate memory",
  "cuda out of memory",
  "oom",
  "out of memory",
  "memory allocation failed",
  "insufficient memory",
  "gpu memory",
];

function isOOMError(errorBody: string): boolean {
  const bodyLower = errorBody.toLowerCase();
  return OOM_PATTERNS.some((p) => bodyLower.includes(p));
}

// ─── Singleton wrapper ───────────────────────────────────

export interface QueueStats {
  queueLength: number;
  activeRequests: number;
  maxParallel: number;
  totalProcessed: number;
  totalErrors: number;
  totalOOMErrors: number;
}

export class LocalModelQueue {
  private static instance: LocalModelQueue | null = null;
  private queue: RequestQueue;
  private strategy: ConcurrencyStrategy;

  private constructor() {
    const maxParallel = LocalModelQueue.getMaxParallelFromEnv();
    this.strategy = new ConcurrencyStrategy("LocalQueue", {
      maxParallel,
      dispatchDelay: 100,
      isRetryableError: isOOMError,
      retryDelay: 2000,
    });
    this.queue = new RequestQueue(this.strategy, { logPrefix: "LocalQueue" });
  }

  static getInstance(): LocalModelQueue {
    if (!LocalModelQueue.instance) {
      LocalModelQueue.instance = new LocalModelQueue();
    }
    return LocalModelQueue.instance;
  }

  static isEnabled(): boolean {
    const enabled = process.env.CLAUDISH_LOCAL_QUEUE_ENABLED;
    if (enabled === undefined || enabled === "") return true;
    return enabled !== "false" && enabled !== "0";
  }

  /**
   * Enqueue a request with optional concurrency override.
   *
   * @param concurrencyOverride - 0 = bypass queue, N = override maxParallel
   */
  async enqueue(
    fetchFn: () => Promise<Response>,
    providerId: string,
    concurrencyOverride?: number,
  ): Promise<Response> {
    // :0 means bypass queue entirely
    if (concurrencyOverride === 0) {
      if (getLogLevel() === "debug") {
        log(`[LocalQueue] Bypassing queue for ${providerId} (concurrency=0)`);
      }
      return fetchFn();
    }

    // Override max parallel if requested
    if (concurrencyOverride !== undefined && concurrencyOverride > 0) {
      const newMax = Math.min(concurrencyOverride, 8);
      if (newMax !== this.strategy.getMaxParallel()) {
        if (getLogLevel() === "debug") {
          log(
            `[LocalQueue] Overriding maxParallel: ${this.strategy.getMaxParallel()} -> ${newMax} for ${providerId}`,
          );
        }
        this.strategy.setMaxParallel(newMax);
      }
    }

    return this.queue.enqueue(fetchFn);
  }

  getStats(): QueueStats {
    const base = this.queue.getStats();
    return {
      queueLength: base.queueLength,
      activeRequests: this.strategy.getActiveRequests(),
      maxParallel: this.strategy.getMaxParallel(),
      totalProcessed: base.totalProcessed,
      totalErrors: base.totalErrors,
      totalOOMErrors: this.strategy.getRetryableErrors(),
    };
  }

  private static getMaxParallelFromEnv(): number {
    const envValue = process.env.CLAUDISH_LOCAL_MAX_PARALLEL;
    if (!envValue) return 1;

    const parsed = parseInt(envValue, 10);
    if (isNaN(parsed) || parsed < 1) {
      log(`[LocalQueue] Invalid CLAUDISH_LOCAL_MAX_PARALLEL: ${envValue}, using default: 1`);
      return 1;
    }
    if (parsed > 8) {
      log(`[LocalQueue] CLAUDISH_LOCAL_MAX_PARALLEL too high: ${parsed}, capping at 8`);
      return 8;
    }
    return parsed;
  }
}
