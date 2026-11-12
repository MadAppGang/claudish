import { beforeEach, describe, expect, test } from "bun:test";
import { _resetRepeatWindowForTest, firstInWindow, REPEAT_WINDOW_MS } from "./repeat-window.js";

describe("firstInWindow", () => {
  beforeEach(() => _resetRepeatWindowForTest());

  test("the first line prints and an identical line inside the window does not", () => {
    expect(firstInWindow("Error [Qwen-payg]: HTTP 401", 1_000)).toBe(true);
    // Claude Code's 400 recovery re-sends the request five times within ~3 s.
    for (const t of [1_280, 1_710, 2_230, 2_740, 3_200]) {
      expect(firstInWindow("Error [Qwen-payg]: HTTP 401", t)).toBe(false);
    }
  });

  test("a different line prints", () => {
    expect(firstInWindow("Error [Qwen-payg]: HTTP 401", 1_000)).toBe(true);
    expect(firstInWindow("Error [OpenRouter]: HTTP 402", 1_100)).toBe(true);
  });

  test("the same line prints again once the window has passed", () => {
    expect(firstInWindow("Error [Qwen-payg]: HTTP 401", 1_000)).toBe(true);
    expect(firstInWindow("Error [Qwen-payg]: HTTP 401", 1_000 + REPEAT_WINDOW_MS)).toBe(true);
  });

  test("a suppressed repeat does not extend the window", () => {
    expect(firstInWindow("x", 0)).toBe(true);
    expect(firstInWindow("x", REPEAT_WINDOW_MS - 1)).toBe(false);
    expect(firstInWindow("x", REPEAT_WINDOW_MS)).toBe(true);
  });
});
