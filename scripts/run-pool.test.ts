import { expect, test } from "bun:test";
import { runPool } from "./run-pool.ts";

test("at most `jobs` runs are in progress, and the results keep the order of the items", async () => {
  let active = 0;
  let most = 0;
  // the first items take the longest, so they end last
  const results = await runPool([40, 30, 20, 10, 5], 2, async (ms) => {
    most = Math.max(most, ++active);
    await Bun.sleep(ms);
    active--;
    return ms * 2;
  });
  expect(most).toBe(2);
  expect(results).toEqual([80, 60, 40, 20, 10]);
});

test("more jobs than items starts every item at once", async () => {
  let active = 0;
  let most = 0;
  await runPool(["a", "b", "c"], 10, async () => {
    most = Math.max(most, ++active);
    await Bun.sleep(10);
    active--;
  });
  expect(most).toBe(3);
});

test("a throw leaves only after a run in progress has ended", async () => {
  let slowEnded = false;
  const pool = runPool(["throws", "slow"], 2, async (item) => {
    if (item === "throws") throw new Error("boot failed");
    await Bun.sleep(40);
    slowEnded = true;
  });
  await expect(pool).rejects.toThrow("boot failed");
  expect(slowEnded).toBe(true);
});
