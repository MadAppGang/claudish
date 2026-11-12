import { describe, expect, test } from "bun:test";
import { TASK_TYPE_PATTERN, taskTypeArg } from "./mcp-server.js";

describe("taskTypeArg: team and create_session's task_type", () => {
  test("absent or null is null", () => {
    expect(taskTypeArg(undefined)).toBeNull();
    expect(taskTypeArg(null)).toBeNull();
  });

  test("a short lower-case word with digits and dashes is kept as given", () => {
    for (const ok of ["research", "plan", "debug", "judge", "implement", "a", "code-review-2"])
      expect(taskTypeArg(ok)).toBe(ok);
    expect(taskTypeArg("a".repeat(24))).toBe("a".repeat(24));
  });

  test("anything else is the caller's error, worded as invalid_args", () => {
    for (const bad of [
      "",
      "Research",
      "1st",
      "-plan",
      "two words",
      "a".repeat(25),
      "plan\n",
      3,
      {},
    ])
      expect(() => taskTypeArg(bad)).toThrow(/^invalid_args: 'task_type' must match/);
  });

  test("the published pattern is the one the description names", () => {
    expect(TASK_TYPE_PATTERN.source).toBe("^[a-z][a-z0-9-]{0,23}$");
  });
});
