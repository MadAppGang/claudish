/**
 * RequestQueue — shared FIFO request queue for provider transports.
 *
 * A provider queue does the same handful of things: cap the backlog, dispatch up
 * to a concurrency limit, optionally pace requests apart, and react to each
 * response (adjust a rate-limit delay, or retry a recoverable failure). Those
 * mechanics are identical across providers; only the policy differs, so the
 * mechanics live here and each transport supplies its policy by overriding the
 * hooks below.
 *
 * Concurrency: `maxParallel` requests run at once (default 1 = strictly serial,
 * which is what a rate-limited API wants; a local GPU queue raises it). A serial
 * queue paces requests with `calculateDelay()` (evaluated before each request,
 * against the time since the last one); a concurrent queue paces dispatches with
 * `dispatchDelayMs`.
 *
 * Policy hooks (all optional, defaulting to a plain pass-through queue):
 * - calculateDelay(): minimum ms between requests, recomputed each time.
 * - onResponse(response): inspect a completed response (update delay state,
 *   parse rate-limit headers); may throw to fail the request.
 * - shouldRetry(response, attempt) + retryDelayMs(): retry a recoverable
 *   response in place before resolving.
 * - onError(error): observe a thrown request (e.g. bump a backoff counter).
 */

import { getLogLevel, log } from "../../logger.js";

export interface QueuedRequest {
  fetchFn: () => Promise<Response>;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  /** Optional log context, e.g. the local provider id ("ollama"). */
  meta?: string;
}

export interface RequestQueueOptions {
  /** Log tag and error-message subject, e.g. "Gemini" -> "[GeminiQueue]". */
  name: string;
  /** Max concurrent in-flight requests. Default 1 (serial). */
  maxParallel?: number;
  /** Backlog cap; enqueue throws when exceeded. Default 100. */
  maxQueueSize?: number;
  /** Delay between successive dispatches within the worker loop. Default 0. */
  dispatchDelayMs?: number;
}

export abstract class RequestQueue {
  protected readonly name: string;
  protected maxParallel: number;
  protected readonly maxQueueSize: number;
  protected readonly dispatchDelayMs: number;

  protected queue: QueuedRequest[] = [];
  protected activeRequests = 0;
  protected lastRequestTime = 0;
  protected totalProcessed = 0;
  protected totalErrors = 0;

  constructor(opts: RequestQueueOptions) {
    this.name = opts.name;
    this.maxParallel = opts.maxParallel ?? 1;
    this.maxQueueSize = opts.maxQueueSize ?? 100;
    this.dispatchDelayMs = opts.dispatchDelayMs ?? 0;
  }

  /**
   * Add a request to the queue and start it when a slot frees up. Throws
   * synchronously if the backlog is already at the cap. Subclasses expose their
   * own `enqueue(...)` with a provider-appropriate signature that calls this.
   */
  protected enqueueInternal(
    fetchFn: () => Promise<Response>,
    meta?: string
  ): Promise<Response> {
    if (this.queue.length >= this.maxQueueSize) {
      this.debug(`Queue full (${this.queue.length}/${this.maxQueueSize}), rejecting request`);
      throw new Error(this.queueFullMessage());
    }
    return new Promise<Response>((resolve, reject) => {
      this.queue.push({ fetchFn, resolve, reject, meta });
      this.debug(
        `Request enqueued${meta ? ` for ${meta}` : ""} (queue length: ${this.queue.length}, active: ${this.activeRequests}/${this.maxParallel})`
      );
      this.processQueue();
    });
  }

  /**
   * Dispatch queued requests while slots remain. `executeRequest` bumps
   * `activeRequests` synchronously before its first await, so the loop condition
   * sees the updated count and never dispatches past `maxParallel`, even when a
   * concurrent enqueue re-enters this loop.
   */
  private async processQueue(): Promise<void> {
    while (this.queue.length > 0 && this.activeRequests < this.maxParallel) {
      const request = this.queue.shift();
      if (!request) break;
      void this.executeRequest(request);
      if (this.dispatchDelayMs > 0) await this.delay(this.dispatchDelayMs);
    }
  }

  private async executeRequest(request: QueuedRequest): Promise<void> {
    this.activeRequests++;
    try {
      await this.waitForNextSlot();

      let response = await request.fetchFn();
      this.lastRequestTime = Date.now();

      let attempt = 0;
      while (await this.shouldRetry(response, attempt)) {
        attempt++;
        const wait = this.retryDelayMs(response, attempt);
        if (wait > 0) await this.delay(wait);
        response = await request.fetchFn();
        this.lastRequestTime = Date.now();
      }

      // May throw to fail the request (e.g. a local OOM that survived its retry).
      await this.onResponse(response);
      this.totalProcessed++;
      request.resolve(response);
    } catch (error) {
      this.totalErrors++;
      this.onError(error);
      this.debug(`Request failed${request.meta ? ` for ${request.meta}` : ""}: ${error}`);
      request.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.activeRequests--;
      if (this.queue.length > 0) this.processQueue();
    }
  }

  /** Enforce `calculateDelay()` against the time since the last request. */
  private async waitForNextSlot(): Promise<void> {
    const delayMs = this.calculateDelay();
    if (delayMs <= 0) return;
    const since = Date.now() - this.lastRequestTime;
    if (since < delayMs) {
      const waitMs = delayMs - since;
      this.debug(`Waiting ${waitMs}ms before next request`);
      await this.delay(waitMs);
    }
  }

  // ─── Policy hooks (override in subclasses) ──────────────────────────────

  /** Minimum ms to leave between requests. Default 0 (no pacing). */
  protected calculateDelay(): number {
    return 0;
  }

  /** React to a completed response. May be async; may throw to fail the request. */
  protected onResponse(_response: Response): void | Promise<void> {}

  /** Whether to re-run the request in place before resolving. Default never. */
  protected shouldRetry(_response: Response, _attempt: number): boolean | Promise<boolean> {
    return false;
  }

  /** Delay before the next retry attempt. Default 0. */
  protected retryDelayMs(_response: Response, _attempt: number): number {
    return 0;
  }

  /** Observe a thrown request (network error). Default no-op. */
  protected onError(_error: unknown): void {}

  /** Message for the error thrown when the backlog is full. */
  protected queueFullMessage(): string {
    return `${this.name} request queue full (${this.queue.length}/${this.maxQueueSize}). Please wait and try again.`;
  }

  // ─── Utilities ──────────────────────────────────────────────────────────

  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  protected debug(message: string): void {
    if (getLogLevel() === "debug") log(`[${this.name}Queue] ${message}`);
  }
}
