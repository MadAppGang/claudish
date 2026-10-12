import { expect, test } from "bun:test";
import { parseModelChain, parseModelSpec } from "./model-parser.js";

test.each([
  ["cx@gpt-6-sol+pro", ["cx@gpt-6-sol+pro"]],
  ["a@x+pro#fast+b@y", ["a@x+pro#fast", "b@y"]],
  ["a@x+standard:3+b@y", ["a@x+standard:3", "b@y"]],
  ["a@x+b@y", ["a@x", "b@y"]],
  [" a@x + b@y + ", ["a@x", "b@y"]],
  ["a@x", ["a@x"]],
  ["", [""]],
] as const)("parses chain %s", (input, expected) =>
  expect(parseModelChain(input)).toEqual([...expected])
);
test("parses provider shortcut and strips mode and speed", () => {
  expect(parseModelSpec("oai@gpt-6-sol+pro#fast")).toMatchObject({
    provider: "openai",
    model: "gpt-6-sol",
    mode: "pro",
    speed: "fast",
  });
});
test("invalid marker remains part of the model", () => {
  const parsed = parseModelSpec("oai@gpt-6-sol+typo");
  expect(parsed.model).toBe("gpt-6-sol+typo");
  expect(parsed.mode).toBeUndefined();
  expect(parsed.speed).toBeUndefined();
});
