import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { wrapPrompt } from "./test-helpers/repl-wrap.js";

function capturedBox(name: string): { cols: number; rows: string[] } {
  const screen = JSON.parse(
    readFileSync(join(import.meta.dir, "test-fixtures", "screens", `${name}.json`), "utf8")
  ) as { cols: number; lines: string[] };
  const first = screen.lines.findIndex((line) => line.startsWith("❯ "));
  const end = screen.lines.findIndex((line, i) => i > first && /^─+$/.test(line));
  return { cols: screen.cols, rows: screen.lines.slice(first, end) };
}
const nonSpace = (rows: string[]) => rows.join("").replace(/[❯\s]/g, "");

describe("fake child prompt reflow (pure)", () => {
  const narrow = capturedBox("size-80x24-repl-typed-long");
  const wide = capturedBox("size-120x40-repl-typed-long");
  const prompt = narrow.rows.map((line) => line.slice(2)).join(" ");

  test("box word wrap matches both real Claude Code captures", () => {
    expect(wrapPrompt(prompt, narrow.cols)).toEqual(narrow.rows);
    expect(wrapPrompt(prompt, wide.cols)).toEqual(wide.rows);
  });

  test("resize reflows the original text, not already wrapped rows", () => {
    for (const cols of [80, 120, 160, 400, 80]) {
      const rows = wrapPrompt(prompt, cols);
      expect(nonSpace(rows)).toBe(prompt.replace(/\s/g, ""));
      expect(rows.every((line) => Bun.stringWidth(line) <= cols)).toBe(true);
    }
    expect(wrapPrompt(prompt, 80)).toEqual(narrow.rows);
  });

  test("a long file pointer and an unbroken token lose no non-space runes", () => {
    for (const text of [
      `Your task is in the file \`/a/long/path/${"segment/".repeat(30)}turn-1.md\`. Read all of it with the Read tool, then do exactly what it says.`,
      "x".repeat(512),
    ]) {
      for (const cols of [80, 120, 160]) {
        const rows = wrapPrompt(text, cols);
        expect(nonSpace(rows)).toBe(text.replace(/\s/g, ""));
        expect(rows.every((line) => Bun.stringWidth(line) <= cols)).toBe(true);
        expect(rows.slice(1).every((line) => line.startsWith("  "))).toBe(true);
      }
    }
  });

  test("history has an ASCII-space prompt and strips the observed markdown markers", () => {
    const text = "Read `task.md` and **keep** *all* ~~words~~ _and_ [links](here)";
    expect(wrapPrompt(text, 80)[0]).toBe(`❯ ${text}`);
    expect(wrapPrompt(text, 80, true)).toEqual([
      "❯ Read task.md and keep all words _and_ [links](here)",
    ]);
    expect(nonSpace(wrapPrompt(prompt, 80, true))).toBe(nonSpace(narrow.rows));
  });

  test("newlines, repeated spaces and wide characters retain their content", () => {
    expect(wrapPrompt("one\n\n  two", 80)).toEqual(["❯ one", "  ", "    two"]);
    const text = "答え 🍐 東京 ✓ ".repeat(30);
    const rows = wrapPrompt(text, 80);
    expect(nonSpace(rows)).toBe(text.replace(/\s/g, ""));
    expect(rows.every((line) => Bun.stringWidth(line) <= 80)).toBe(true);
    expect(wrapPrompt("", 80)).toEqual(["❯ "]);
  });
});
