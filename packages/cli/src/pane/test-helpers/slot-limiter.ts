/**
 * A first-in, first-out limit on how many test bodies run at once. A test file whose tests
 * each drive real panes runs them through it, whatever `--max-concurrency` the runner passes.
 */
export class SlotLimiter {
  private free: number;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly slots: number) {
    this.free = slots;
  }

  /** How many slots are held now. */
  get busy(): number {
    return this.slots - this.free;
  }

  private async take(): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.free++;
  }

  /**
   * Runs `fn` once it holds a slot, failing when it has not settled `ownMs` after taking it.
   * The slot is given back only once `fn` has settled, its cleanup included, even after that
   * failure: a body that timed out still holds its panes. `deadlineAt` is when the runner gives
   * up on the test; a test that gets its slot after it never runs its body.
   */
  async run(fn: () => Promise<void> | void, ownMs: number, deadlineAt: number): Promise<void> {
    await this.take();
    if (Date.now() >= deadlineAt) {
      this.release();
      throw new Error("no slot before its deadline: the body was not run");
    }
    const body = Promise.resolve().then(fn);
    void body.then(
      () => this.release(),
      () => this.release()
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        body,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${ownMs} ms holding a slot`)),
            ownMs
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The runner's timeout for a test with its own budget `ownMs`: that budget plus the wait for a
 * slot behind `ahead` tests registered before it, `slots` at a time, each up to `longestMs`.
 * Counted over the whole file, not one block: bun runs the tests of adjacent
 * `describe.concurrent` blocks at the same time, up to `--max-concurrency`, so a test can
 * queue behind any test registered before it.
 */
export function outerTimeout(
  ownMs: number,
  ahead: number,
  slots: number,
  longestMs: number
): number {
  return ownMs + Math.ceil(ahead / slots) * longestMs;
}
