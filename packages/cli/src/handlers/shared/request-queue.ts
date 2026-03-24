/**
 * RequestQueue — unified request handler for all transports.
 *
 * One config covers timeout, rate limiting, concurrency, and retry.
 * Hooks are optional functions on the config, not separate strategy objects.
 */

import { getLogLevel, log } from "../../logger.js";

// ---- Config ----

export interface QueueState {
  consecutiveErrors: number;
  baseDelayMs: number;
  maxDelayMs: number;
  currentDelayMs: number;
}

export interface RequestQueueConfig {
  /** Max parallel requests. 1 = serial. Default: 1. */
  maxParallel?: number;
  /** Max queued requests. Default: 100. */
  maxQueueSize?: number;
  /** Per-request timeout in ms. 0 = no timeout. */
  timeoutMs?: number;
  /** Base inter-request delay in ms. 0 = no delay. */
  baseDelayMs?: number;
  /** Max inter-request delay in ms. Default: 10000. */
  maxDelayMs?: number;
  /** Delay before retry in ms. Default: 2000. */
  retryDelayMs?: number;
  /** Override delay calculation. */
  calculateDelay?(state: QueueState): number;
  /** Called after each response. Return true if rate limited. */
  onResponse?(response: Response, state: QueueState): boolean;
  /** Called on 5xx. Return true to retry once. */
  shouldRetry?(response: Response, errorBody: string): boolean;
}

export interface RequestQueueStats {
  queueLength: number;
  processing: boolean;
  activeRequests: number;
  maxParallel: number;
  consecutiveErrors: number;
  currentDelayMs: number;
  totalProcessed: number;
  totalErrors: number;
}

// ---- RequestQueue ----

interface QueuedRequest {
  fetchFn: () => Promise<Response>;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

function defaultCalculateDelay(state: QueueState): number {
  let d = state.baseDelayMs;
  if (state.consecutiveErrors > 0) d = Math.min(d * (1 + state.consecutiveErrors * 0.5), state.maxDelayMs);
  return d;
}

export class RequestQueue {
  private queue: QueuedRequest[] = [];
  private processing = false;
  private activeRequests = 0;
  private lastRequestTime = 0;
  private totalProcessed = 0;
  private totalErrors = 0;

  private readonly label: string;
  private readonly maxQueueSize: number;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly calculateDelay: (state: QueueState) => number;
  private readonly onResponse: (response: Response, state: QueueState) => boolean;
  private readonly shouldRetry?: (response: Response, errorBody: string) => boolean;
  private state: QueueState;
  maxParallel: number;

  constructor(label: string, config: RequestQueueConfig = {}) {
    this.label = label;
    this.maxQueueSize = config.maxQueueSize ?? 100;
    this.maxParallel = config.maxParallel ?? 1;
    this.timeoutMs = config.timeoutMs ?? 0;
    this.retryDelayMs = config.retryDelayMs ?? 2000;
    this.calculateDelay = config.calculateDelay ?? defaultCalculateDelay;
    this.onResponse = config.onResponse ?? ((r, _s) => r.status === 429);
    this.shouldRetry = config.shouldRetry;
    this.state = {
      consecutiveErrors: 0,
      baseDelayMs: config.baseDelayMs ?? 0,
      maxDelayMs: config.maxDelayMs ?? 10000,
      currentDelayMs: config.baseDelayMs ?? 0,
    };
  }

  async enqueue(fetchFn: () => Promise<Response>): Promise<Response> {
    if (this.queue.length >= this.maxQueueSize) {
      throw new Error(`${this.label} queue full (${this.queue.length}/${this.maxQueueSize}).`);
    }
    return new Promise<Response>((resolve, reject) => {
      this.queue.push({ fetchFn, resolve, reject });
      if (!this.processing) this.processQueue();
    });
  }

  getStats(): RequestQueueStats {
    return {
      queueLength: this.queue.length, processing: this.processing,
      activeRequests: this.activeRequests, maxParallel: this.maxParallel,
      consecutiveErrors: this.state.consecutiveErrors, currentDelayMs: this.state.currentDelayMs,
      totalProcessed: this.totalProcessed, totalErrors: this.totalErrors,
    };
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length > 0 && this.activeRequests < this.maxParallel) {
      const request = this.queue.shift()!;
      this.activeRequests++;
      if (this.maxParallel === 1) {
        await this.executeRequest(request);
      } else {
        this.executeRequest(request).catch(() => {});
        if (this.queue.length > 0) await new Promise(r => setTimeout(r, 100));
      }
    }
    this.processing = false;
  }

  private async executeRequest(request: QueuedRequest): Promise<void> {
    try {
      await this.waitForNextSlot();
      const doFetch = this.timeoutMs > 0
        ? () => Promise.race([
            request.fetchFn(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Request timed out after ${this.timeoutMs}ms`)), this.timeoutMs)
            ),
          ])
        : request.fetchFn;
      const response = await doFetch();
      this.lastRequestTime = Date.now();

      if (this.onResponse(response, this.state)) {
        this.totalErrors++;
        this.state.consecutiveErrors++;
      } else {
        if (this.state.consecutiveErrors > 0) this.state.consecutiveErrors = 0;
        if (this.state.currentDelayMs > this.state.baseDelayMs) {
          this.state.currentDelayMs = Math.max(this.state.baseDelayMs, this.state.currentDelayMs * 0.9);
        }
      }

      if (this.shouldRetry && response.status >= 500) {
        const errorBody = await response.clone().text();
        if (this.shouldRetry(response, errorBody)) {
          await new Promise(r => setTimeout(r, this.retryDelayMs));
          const retryResponse = await doFetch();
          this.totalProcessed++;
          request.resolve(retryResponse);
          return;
        }
      }

      this.totalProcessed++;
      request.resolve(response);
    } catch (error) {
      this.totalErrors++;
      this.state.consecutiveErrors++;
      request.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.activeRequests--;
      if (this.maxParallel > 1 && this.queue.length > 0) this.processQueue();
    }
  }

  private async waitForNextSlot(): Promise<void> {
    const delayMs = this.calculateDelay(this.state);
    this.state.currentDelayMs = delayMs;
    if (delayMs <= 0) return;
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < delayMs) {
      await new Promise(resolve => setTimeout(resolve, delayMs - elapsed));
    }
  }
}
