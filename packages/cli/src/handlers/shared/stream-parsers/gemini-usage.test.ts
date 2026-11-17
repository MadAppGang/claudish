import { describe, expect, test } from "bun:test";
import { geminiOutputTokens } from "./gemini-usage.js";

describe("geminiOutputTokens", () => {
  test("adds thought tokens the answer count leaves out", () => {
    // Recorded on Antigravity, 2026-11-15: 11145 + 37 + 27 = 11209.
    expect(
      geminiOutputTokens({
        promptTokenCount: 11145,
        candidatesTokenCount: 37,
        thoughtsTokenCount: 27,
        totalTokenCount: 11209,
      })
    ).toBe(64);
  });

  test("counts a turn that only thought", () => {
    expect(
      geminiOutputTokens({
        promptTokenCount: 11484,
        thoughtsTokenCount: 96,
        totalTokenCount: 11580,
      })
    ).toBe(96);
  });

  test("does not add thought tokens the answer count already holds", () => {
    expect(
      geminiOutputTokens({
        promptTokenCount: 100,
        candidatesTokenCount: 60,
        thoughtsTokenCount: 50,
        totalTokenCount: 160,
      })
    ).toBe(60);
  });

  test("adds thought tokens when no total is reported", () => {
    expect(geminiOutputTokens({ candidatesTokenCount: 10, thoughtsTokenCount: 50 })).toBe(60);
  });

  test("is the answer count when there are no thought tokens", () => {
    expect(
      geminiOutputTokens({
        promptTokenCount: 22456,
        candidatesTokenCount: 38,
        totalTokenCount: 22494,
      })
    ).toBe(38);
  });

  test("is zero for no usage record", () => {
    expect(geminiOutputTokens(null)).toBe(0);
  });
});
