import { describe, expect, test } from "bun:test";
import { SlotLimiter, outerTimeout } from "./test-helpers/slot-limiter.js";

/**
 * The slot limit a pane test file runs its concurrent tests under: a slot is held until the
 * test body and its cleanup have settled, but never longer than its budget plus the overrun
 * allowance; a test queued past its runner deadline never runs, and the runner's timeout covers
 * the wait behind every test registered before it.
 */

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const far = () => Date.now() + 60_000;

describe("SlotLimiter", () => {
  test("a body still running at its own timeout keeps its slot until it settles", async () => {
    const limiter = new SlotLimiter(1, 60_000);
    const body = deferred();
    let cleaned = false;
    const first = limiter.run(
      async () => {
        await body.promise;
        cleaned = true;
      },
      20,
      far()
    );
    await expect(first).rejects.toThrow("timed out after 20 ms");
    expect(limiter.busy).toBe(1);
    let secondStarted = false;
    const second = limiter.run(
      () => {
        secondStarted = true;
      },
      1_000,
      far()
    );
    await Bun.sleep(30);
    expect(secondStarted).toBe(false);
    body.resolve();
    await second;
    expect(cleaned).toBe(true);
    expect(secondStarted).toBe(true);
    expect(limiter.busy).toBe(0);
  });

  test("a test queued past its runner deadline never runs its body", async () => {
    const limiter = new SlotLimiter(1, 60_000);
    const hold = deferred();
    const first = limiter.run(() => hold.promise, 1_000, far());
    let ran = false;
    const late = limiter.run(
      () => {
        ran = true;
      },
      1_000,
      Date.now() + 10
    );
    await Bun.sleep(30);
    hold.resolve();
    await first;
    await expect(late).rejects.toThrow("no slot before its deadline");
    expect(ran).toBe(false);
    expect(limiter.busy).toBe(0);
  });

  test("a body that throws gives its slot to the next test", async () => {
    const limiter = new SlotLimiter(1, 60_000);
    await expect(
      limiter.run(
        () => {
          throw new Error("boom");
        },
        1_000,
        far()
      )
    ).rejects.toThrow("boom");
    expect(limiter.busy).toBe(0);
  });
});

describe("SlotLimiter: a body that overruns its slot", () => {
  test("a body that never settles gives its slot back ownMs + overrunMs after it started, loudly", async () => {
    const warnings: string[] = [];
    const limiter = new SlotLimiter(1, 40, (m) => warnings.push(m));
    const never = new Promise<void>(() => {});
    const started = Date.now();
    await expect(limiter.run(() => never, 20, far())).rejects.toThrow("timed out after 20 ms");
    expect(limiter.busy).toBe(1);
    let secondAt = 0;
    await limiter.run(
      () => {
        secondAt = Date.now();
      },
      1_000,
      far()
    );
    expect(secondAt - started).toBeGreaterThanOrEqual(60);
    expect(secondAt - started).toBeLessThan(1_000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("still running 60 ms after it started");
    expect(limiter.busy).toBe(0);
  });

  test("a body that settles after its forced release does not free a second slot", async () => {
    const limiter = new SlotLimiter(1, 10, () => {});
    const body = deferred();
    await expect(limiter.run(() => body.promise, 10, far())).rejects.toThrow("timed out");
    await Bun.sleep(40);
    expect(limiter.busy).toBe(0);
    const hold = deferred();
    const holder = limiter.run(() => hold.promise, 1_000, far());
    await Bun.sleep(5);
    body.resolve();
    await Bun.sleep(5);
    expect(limiter.busy).toBe(1);
    hold.resolve();
    await holder;
    expect(limiter.busy).toBe(0);
  });

  test("holdMs is the longest a body can keep its slot: its budget plus the overrun", () => {
    expect(new SlotLimiter(3, 60_000).holdMs(120_000)).toBe(180_000);
  });
});

describe("outerTimeout", () => {
  test("the first test waits for nothing: its own budget", () => {
    expect(outerTimeout(120_000, 0, 3, 120_000)).toBe(120_000);
  });

  test("a test behind 10 others, 3 slots: four longest budgets of wait, then its own", () => {
    expect(outerTimeout(120_000, 10, 3, 120_000)).toBe(120_000 + 4 * 120_000);
  });

  test("the wait is counted in the longest hold registered before it", () => {
    expect(outerTimeout(60_000, 3, 3, 240_000)).toBe(60_000 + 240_000);
  });
});
