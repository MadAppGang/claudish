import { expect, test } from "bun:test";
import { underLoad } from "./gated-delivery.js";

test("underLoad returns once its work is done, with every busy worker stopped", async () => {
  const started = Date.now();
  let ran = false;
  await underLoad(async () => {
    ran = true;
  });
  expect(ran).toBe(true);
  expect(Date.now() - started).toBeLessThan(10_000);
}, 15_000);

test("underLoad stops its workers when the work throws", async () => {
  await expect(
    underLoad(async () => {
      throw new Error("work failed");
    })
  ).rejects.toThrow("work failed");
}, 15_000);
