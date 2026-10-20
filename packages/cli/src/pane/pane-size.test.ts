import { describe, expect, test } from "bun:test";
import {
  MAX_PANE_CELLS,
  MAX_PANE_COLS,
  MAX_PANE_ROWS,
  MIN_PANE_COLS,
  MIN_PANE_ROWS,
  clampPaneSize,
  samePaneSize,
} from "./pane-size.js";

describe("clampPaneSize", () => {
  test.each([
    [80, 24, 80, 24],
    [120, 40, 120, 40],
    [250, 60, 250, 60],
    [500, 200, 500, 200],
    [1, 1, 80, 24],
    [501, 201, 501, 201],
    [79, 60, 80, 60],
    [501, 60, 501, 60],
    [250, 23, 250, 24],
    [250, 201, 250, 201],
    [79, 201, 80, 201],
    [501, 23, 501, 24],
    [400, 100, 400, 100],
    [10_000, 50, 9_999, 50],
    [9_999, 9_999, 9_999, 400],
    [50, 10, 80, 24],
    [2_000, 2_001, 2_000, 2_000],
    [9_999, 50, 9_999, 50],
    [80, 9_999, 80, 9_999],
    [80, 10_000, 80, 9_999],
    [10_000, 10_000, 9_999, 400],
    [2_000, 2_000, 2_000, 2_000],
    [8_000, 500, 8_000, 500],
    [8_000, 501, 8_000, 500],
    [2_001, 2_000, 2_001, 1_999],
    [0, 0, 80, 24],
    [-1, -1, 80, 24],
    [-1, 60, 80, 60],
    [120, -1, 120, 24],
  ])("%i × %i clamps to %i × %i", (cols, rows, expectedCols, expectedRows) => {
    expect(clampPaneSize(cols, rows)).toEqual({ cols: expectedCols, rows: expectedRows });
  });

  test.each([
    [120.9, 40.9, 120, 40],
    [79.9, 23.9, 80, 24],
    [9_999.9, 50.9, 9_999, 50],
    [80.9, 9_999.9, 80, 9_999],
    [-120.9, -40.9, 80, 24],
  ])("%s × %s truncates and clamps to %s × %s", (cols, rows, expectedCols, expectedRows) => {
    expect(clampPaneSize(cols, rows)).toEqual({ cols: expectedCols, rows: expectedRows });
  });

  test("lowers a fractional 4,000,001-cell request to 4,000,000 cells", () => {
    expect(2_000 * 2_000.0005).toBe(4_000_001);
    const size = clampPaneSize(2_000, 2_000.0005);
    expect(size).toEqual({ cols: 2_000, rows: 2_000 });
    expect(size.cols * size.rows).toBe(MAX_PANE_CELLS);
  });
});

describe("U9: magmux size bounds", () => {
  test("preserves 250 columns and widths above 250", () => {
    expect(clampPaneSize(250, 50).cols).toBe(250);
    expect(clampPaneSize(1_000, 50).cols).toBe(1_000);
  });

  test("exports magmux limits and the 80 × 24 minimum", () => {
    expect(MAX_PANE_COLS).toBe(9_999);
    expect(MAX_PANE_ROWS).toBe(9_999);
    expect(MAX_PANE_CELLS).toBe(4_000_000);
    expect(MIN_PANE_COLS).toBe(80);
    expect(MIN_PANE_ROWS).toBe(24);
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
