import { expect, test } from "bun:test";
import { readCompactionBlock } from "./config.js";

test("history.policy defaults to threshold at 0.6 / 0.75", () => {
  const { settings } = readCompactionBlock({});
  expect(settings.history).toEqual({
    enabled: true,
    policy: "threshold",
    precomputeAt: 0.6,
    applyAt: 0.75,
  });
});

test("history.policy early prepares at 0.5 and applies at 0.7", () => {
  const { settings, warning } = readCompactionBlock({ history: { policy: "early" } });
  expect(warning).toBeUndefined();
  expect(settings.history).toMatchObject({ policy: "early", precomputeAt: 0.5, applyAt: 0.7 });
});

test("history.policy cost prepares at 0.5", () => {
  const { settings } = readCompactionBlock({ history: { policy: "cost" } });
  expect(settings.history).toMatchObject({ policy: "cost", precomputeAt: 0.5 });
});

test("a threshold written in the block wins over the policy's default", () => {
  const { settings } = readCompactionBlock({ history: { policy: "early", applyAt: 0.8 } });
  expect(settings.history).toMatchObject({ policy: "early", precomputeAt: 0.5, applyAt: 0.8 });
});

test("an unknown policy is refused with a warning naming the key", () => {
  const { settings, warning } = readCompactionBlock({ history: { policy: "sometimes" } });
  expect(warning).toContain("compaction.history.policy");
  expect(settings.history.policy).toBe("threshold");
});
