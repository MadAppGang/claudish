/**
 * ConcurrencyLimiter — per-instance async semaphore for remote provider transports.
 *
 * WHY THIS EXISTS (not LocalModelQueue):
 * LocalModelQueue is a process-wide singleton with a SINGLE shared maxParallel that
 * a concurrency override MUTATES (local-queue.ts). Capping a second provider through
 * it would tangle the two: vllm-myia's override:1 would also clamp gc@glm-5.2 to 1
 * (collapsing the primary model's throughput). It is built for local single-GPU
 * backends (ollama/lmstudio/vllm-local).
 *
 * This limiter is owned by ONE transport instance. Because the handler (and thus its
 * transport) is cached as a singleton per provider+model (proxy-server.ts
 * remoteProviderHandlers), one limiter instance gates ALL requests to that provider —
 * independent of every other provider's cap.
 *
 * Semantics:
 *  - max > 0: at most `max` tasks run concurrently; extras QUEUE (FIFO) and resume
 *    as slots free. Never rejects — preserves the never-hang priority.
 *  - The caller decides whether to construct a limiter at all (max=0/undefined → no
 *    limiter, unbounded, unchanged default behavior).
 */
export class ConcurrencyLimiter {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(
    private readonly max: number,
    private readonly label: string
  ) {
    if (max <= 0) throw new Error(`ConcurrencyLimiter("${label}"): max must be > 0, got ${max}`);
  }

  /**
   * Run `task` under the cap. If at capacity, waits for a slot (FIFO order) before
   * starting. Resolves/rejects with whatever `task` produces.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      const next = this.waiting.shift();
      if (next) next();
    }
  }

  /** For tests/diagnostics: current in-flight count. */
  get activeCount(): number {
    return this.active;
  }

  /** For tests/diagnostics: current queued count. */
  get queuedCount(): number {
    return this.waiting.length;
  }
}
