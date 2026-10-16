import { describe, expect, test } from "bun:test";
import { ScrollbackBuffer } from "./scrollback-buffer.js";

describe("ScrollbackBuffer", () => {
  test("appends and retrieves lines", () => {
    const buf = new ScrollbackBuffer(10);
    buf.append("line 1\nline 2\nline 3\n");
    expect(buf.getLines()).toEqual(["line 1", "line 2", "line 3"]);
    expect(buf.size).toBe(3);
    expect(buf.totalLines).toBe(3);
  });

  test("returns last N lines with getLines(n)", () => {
    const buf = new ScrollbackBuffer(10);
    buf.append("a\nb\nc\nd\ne\n");
    expect(buf.getLines(3)).toEqual(["c", "d", "e"]);
    expect(buf.getLines(1)).toEqual(["e"]);
  });

  test("wraps at capacity (ring buffer)", () => {
    const buf = new ScrollbackBuffer(3);
    buf.append("a\nb\nc\nd\ne\n");
    // Capacity is 3, so only last 3 lines survive
    expect(buf.getLines()).toEqual(["c", "d", "e"]);
    expect(buf.size).toBe(3);
    expect(buf.totalLines).toBe(5);
  });

  test("handles multiple appends", () => {
    const buf = new ScrollbackBuffer(5);
    buf.append("line 1\n");
    buf.append("line 2\nline 3\n");
    buf.append("line 4\n");
    expect(buf.getLines()).toEqual(["line 1", "line 2", "line 3", "line 4"]);
  });

  test("strips ANSI escape codes", () => {
    const buf = new ScrollbackBuffer(10);
    buf.append("\x1b[32mgreen text\x1b[0m\n\x1b[1mbold\x1b[0m\n");
    expect(buf.getLines()).toEqual(["green text", "bold"]);
  });

  test("empty buffer returns empty array", () => {
    const buf = new ScrollbackBuffer(10);
    expect(buf.getLines()).toEqual([]);
    expect(buf.getLines(5)).toEqual([]);
    expect(buf.size).toBe(0);
    expect(buf.totalLines).toBe(0);
  });

  test("clear resets all state", () => {
    const buf = new ScrollbackBuffer(10);
    buf.append("a\nb\nc\n");
    buf.clear();
    expect(buf.getLines()).toEqual([]);
    expect(buf.size).toBe(0);
    expect(buf.totalLines).toBe(0);
  });

  test("handles text without trailing newline", () => {
    const buf = new ScrollbackBuffer(10);
    buf.append("no newline at end");
    expect(buf.getLines()).toEqual(["no newline at end"]);
  });

  test("getLines(n) with n > size returns all lines", () => {
    const buf = new ScrollbackBuffer(10);
    buf.append("a\nb\n");
    expect(buf.getLines(100)).toEqual(["a", "b"]);
  });

  test("handles double newlines correctly", () => {
    const buf = new ScrollbackBuffer(10);
    buf.append("a\n\nb\n");
    expect(buf.getLines()).toEqual(["a", "", "b"]);
  });

  test("ring buffer correctness after multiple wraps", () => {
    const buf = new ScrollbackBuffer(3);
    // First fill
    buf.append("1\n2\n3\n");
    expect(buf.getLines()).toEqual(["1", "2", "3"]);
    // Overwrite
    buf.append("4\n5\n");
    expect(buf.getLines()).toEqual(["3", "4", "5"]);
    // Overwrite again
    buf.append("6\n7\n8\n9\n");
    expect(buf.getLines()).toEqual(["7", "8", "9"]);
    expect(buf.totalLines).toBe(9);
  });
});
