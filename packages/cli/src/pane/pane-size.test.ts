import { describe, expect, test } from "bun:test";
import { MAX_PANE_COLS, clampPaneSize, samePaneSize } from "./pane-size.js";

describe("clampPaneSize", () => {
  test.each([
    [80, 24, 80, 24],
    [120, 40, 120, 40],
    [250, 60, 250, 60],
    [500, 200, 250, 200],
    [1, 1, 80, 24],
    [501, 201, 250, 200],
    [79, 60, 80, 60],
    [501, 60, 250, 60],
    [250, 23, 250, 24],
    [250, 201, 250, 200],
    [79, 201, 80, 200],
    [501, 23, 250, 24],
  ])("%i × %i clamps to %i × %i", (cols, rows, expectedCols, expectedRows) => {
    expect(clampPaneSize(cols, rows)).toEqual({ cols: expectedCols, rows: expectedRows });
  });
});

describe("M3: classifier-verified width cap", () => {
  test("clamps 1000 columns to 250 and preserves 250 columns", () => {
    expect(clampPaneSize(250, 50).cols).toBe(250);
    expect(clampPaneSize(1000, 50).cols).toBe(250);
  });

  test("MAX_PANE_COLS is 250", () => {
    expect(MAX_PANE_COLS).toBe(250);
  });
});

describe("samePaneSize", () => {
  test("equal dimensions match, each differing axis does not", () => {
    const size = { cols: 120, rows: 40 };
    expect(samePaneSize(size, { ...size })).toBe(true);
    expect(samePaneSize(size, { cols: 121, rows: 40 })).toBe(false);
    expect(samePaneSize(size, { cols: 120, rows: 41 })).toBe(false);
  });

  test("null means unknown, including when both sizes are null", () => {
    const size = { cols: 120, rows: 40 };
    expect(samePaneSize(null, size)).toBe(false);
    expect(samePaneSize(size, null)).toBe(false);
    expect(samePaneSize(null, null)).toBe(false);
  });
});
