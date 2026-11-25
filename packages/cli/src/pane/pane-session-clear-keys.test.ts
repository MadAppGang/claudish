import { describe, expect, test } from "bun:test";
import { clearKeyCount } from "./pane-session.js";
import { wrapPrompt } from "./test-helpers/repl-wrap.js";

/**
 * Claude Code's ctrl-u deletes ONE wrapped screen row of the input box, not the whole box
 * (measured on Claude Code 2.1.330: a 250-character line in a 200-column pane wraps onto two
 * rows; one ctrl-u removed only the second row, a second ctrl-u emptied the box). Leftover
 * text of a failed send can be up to two copies of the line per gated send made so far (one
 * magmux retype each). So the number of ctrl-u keys sent to empty the box must be at least the
 * number of wrapped rows that leftover can occupy, or the next send types onto the rows left.
 */

/** A single line of `len` characters made of short words, like a typed prompt. */
function wordLine(len: number): string {
  let s = "";
  for (let i = 0; s.length < len; i++) s += `${s ? " " : ""}word${i}`;
  return s.slice(0, len);
}

/** Rows the box shows for `copies` copies of `line` joined end to end, in a `cols` pane. */
function rowsFor(line: string, copies: number, cols: number): number {
  return wrapPrompt(line.repeat(copies), cols).length;
}

describe("clearKeyCount: ctrl-u keys that empty a box holding our leftover text", () => {
  test("the measured case: a 250-character line in a 200-column pane needs at least 2 keys", () => {
    const line = wordLine(250);
    const n = clearKeyCount(line, 1, 200);
    expect(n).toBeGreaterThanOrEqual(2);
    // two copies of a 250-character line occupy three rows at 200 columns
    expect(n).toBeGreaterThanOrEqual(rowsFor(line, 2, 200));
  });

  test("a 512-character line in an 80-column pane covers every wrapped row", () => {
    const line = wordLine(512);
    expect(clearKeyCount(line, 1, 80)).toBeGreaterThanOrEqual(rowsFor(line, 2, 80));
  });

  test("two attempts of a 512-character line in an 80-column pane cover four copies", () => {
    const line = wordLine(512);
    expect(clearKeyCount(line, 2, 80)).toBeGreaterThanOrEqual(rowsFor(line, 4, 80));
  });

  test("a 207-character launch line in a 160-column pane covers two copies", () => {
    const line = wordLine(207);
    expect(clearKeyCount(line, 1, 160)).toBeGreaterThanOrEqual(rowsFor(line, 2, 160));
  });

  test("no attempt made yet still clears at least the rows of one doubled send", () => {
    const line = wordLine(300);
    expect(clearKeyCount(line, 0, 100)).toBeGreaterThanOrEqual(rowsFor(line, 2, 100));
  });

  test("a short line still gets at least one key", () => {
    const line = wordLine(13);
    expect(clearKeyCount(line, 1, 200)).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(clearKeyCount(line, 1, 200))).toBe(true);
  });

  test("a line of wide characters is counted by screen cells, not characters", () => {
    // Each CJK character takes two cells: a 20-character word is 40 cells, so an 80-column box
    // holds one word per row, and the line fills about twice the rows its length says.
    const line = Array.from({ length: 16 }, () => "漢".repeat(20)).join(" ");
    expect(clearKeyCount(line, 1, 80)).toBeGreaterThanOrEqual(rowsFor(line, 2, 80));
  });
});
