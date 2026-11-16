import { expect, test } from "bun:test";
import { parseModelChain, parseModelFlags, parseModelSpec } from "./model-parser.js";

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

test.each([
  [
    "a pinned raw URL",
    ["https://user:USERINFO-SECRET@gw.example/PATH-SECRET/m?key=QUERY-SECRET", "or@x", "or@"],
  ],
  [
    "a custom-url@ pinned URL",
    [
      "custom-url@https://user:USERINFO-SECRET@gw.example/PATH-SECRET/m?key=QUERY-SECRET",
      "or@x",
      "or@",
    ],
  ],
  [
    "a routing chain holding a URL",
    ["https://user:USERINFO-SECRET@gw.example/PATH-SECRET/m?key=QUERY-SECRET+or@x", "or@"],
  ],
] as const)("a refused --model keeps %s out of the message", (_label, values) => {
  const result = parseModelFlags([...values]);
  expect(result.ok).toBe(false);
  const message = result.ok ? "" : result.message;
  expect(message).toContain("raw URL");
  for (const secret of ["USERINFO-SECRET", "PATH-SECRET", "QUERY-SECRET", "user:"]) {
    expect(message).not.toContain(secret);
  }
});
