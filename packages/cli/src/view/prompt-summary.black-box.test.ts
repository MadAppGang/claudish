import { expect, test } from "bun:test";
import { promptSummaryOf } from "./prompt-summary.js";

test.each([
  ["", null],
  [" \n\t\r\n", null],
  ["\n\nfirst line\nsecond line", "first line"],
] as const)(
  "TEST-12 REQ-5 REQ-28 REQ-34 summary of %j is first nonblank line within 100 chars",
  (prompt, expected) => {
    expect(promptSummaryOf(prompt)).toBe(expected);
  }
);

test("TEST-12 REQ-5 REQ-28 REQ-34 long summary remains within 100 characters without exposing later lines", () => {
  const summary = promptSummaryOf("a".repeat(101) + "\nprivate second line");

  expect(summary).not.toBeNull();
  expect(summary?.startsWith("a")).toBe(true);
  expect(summary?.length).toBeLessThanOrEqual(100);
  expect(summary).not.toContain("private second line");
});
