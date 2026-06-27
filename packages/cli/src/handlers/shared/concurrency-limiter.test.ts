import { describe, test, expect } from "bun:test";
import { ConcurrencyLimiter } from "./concurrency-limiter.js";

/**
 * ConcurrencyLimiter — per-instance async semaphore for remote transports.
 *
 * Why these tests exist: the limiter replaced LocalModelQueue for the transport
 * maxConcurrency path (LocalModelQueue is a global singleton whose shared
 * maxParallel is mutated per-override — capping a second provider through it
 * would tangle caps). These tests pin the contract that matters for the proxy:
 * cap is respected, release is FIFO, extras queue without rejecting (never-hang).
 */
describe("ConcurrencyLimiter", () => {
  test("rejects construction with non-positive max", () => {
    expect(() => new ConcurrencyLimiter(0, "x")).toThrow();
    expect(() => new ConcurrencyLimiter(-1, "x")).toThrow();
  });

  test("runs tasks concurrently up to the cap", async () => {
    const limiter = new ConcurrencyLimiter(2, "test");
    let active = 0;
    let peak = 0;
    const track = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    };
    await Promise.all(Array.from({ length: 6 }, () => limiter.run(track)));
    expect(peak).toBe(2); // never exceeded the cap
    expect(limiter.activeCount).toBe(0);
    expect(limiter.queuedCount).toBe(0);
  });

  test("never exceeds cap=1 (strict serialization)", async () => {
    const limiter = new ConcurrencyLimiter(1, "serial");
    let active = 0;
    let peak = 0;
    const track = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };
    await Promise.all(Array.from({ length: 5 }, () => limiter.run(track)));
    expect(peak).toBe(1);
  });

  test("queues extras in FIFO order and releases them as slots free", async () => {
    const limiter = new ConcurrencyLimiter(1, "fifo");
    const order: string[] = [];
    const task = (label: string) =>
      limiter.run(async () => {
        order.push(`start:${label}`);
        await new Promise((r) => setTimeout(r, 10));
        order.push(`end:${label}`);
      });

    const p = Promise.all([task("a"), task("b"), task("c")]);
    // Under cap=1, a must fully finish before b starts, b before c.
    await p;
    expect(order).toEqual([
      "start:a",
      "end:a",
      "start:b",
      "end:b",
      "start:c",
      "end:c",
    ]);
  });

  test("never rejects — even many tasks beyond cap all complete", async () => {
    const limiter = new ConcurrencyLimiter(2, "never-reject");
    let completed = 0;
    const task = async () => {
      await new Promise((r) => setTimeout(r, 2));
      completed++;
    };
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => limiter.run(task))
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(completed).toBe(50);
  });

  test("propagates task rejection and still releases the slot", async () => {
    const limiter = new ConcurrencyLimiter(1, "reject-prop");
    let secondRan = false;

    const first = limiter.run(async () => {
      throw new Error("boom");
    });
    await expect(first).rejects.toThrow("boom");

    // Slot must have been released despite the throw.
    await limiter.run(async () => {
      secondRan = true;
    });
    expect(secondRan).toBe(true);
    expect(limiter.activeCount).toBe(0);
  });
});
