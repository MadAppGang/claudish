import { describe, expect, test } from "bun:test";
import { SlotLimiter, outerTimeout } from "./test-helpers/slot-limiter.js";

/**
 * The slot limit a pane test file runs its concurrent tests under: a slot is held until the
 * test body and its cleanup have settled, a test queued past its runner deadline never runs,
 * and the runner's timeout covers the wait behind every test registered before it.
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
    const limiter = new SlotLimiter(1);
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
    const limiter = new SlotLimiter(1);
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
    const limiter = new SlotLimiter(1);
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

describe("outerTimeout", () => {
  test("the first test waits for nothing: its own budget", () => {
    expect(outerTimeout(120_000, 0, 3, 120_000)).toBe(120_000);
  });

  test("a test behind 10 others, 3 slots: four longest budgets of wait, then its own", () => {
    expect(outerTimeout(120_000, 10, 3, 120_000)).toBe(120_000 + 4 * 120_000);
  });

  test("the wait is counted in the longest budget registered before it", () => {
    expect(outerTimeout(60_000, 3, 3, 240_000)).toBe(60_000 + 240_000);
  });
});
