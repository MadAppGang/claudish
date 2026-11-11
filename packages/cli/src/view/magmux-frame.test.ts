/**
 * The copied frame decoder against frames a real magmux 0.19.0 pane sent: whole-row deltas,
 * keyframes, wide glyphs placed in cells from `wd`, and runs that outlive the right-trimmed text.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ATTR_BOLD,
  ATTR_DIM,
  ATTR_REVERSE,
  ATTR_STRIKE,
  COLOR_DEFAULT,
  applyFrame,
  cellCols,
  classifyColour,
  newScreen,
  rowSpans,
  rowText,
  screenText,
} from "./magmux-frame.js";
import { capturedFrames, capturedWatchReply } from "./test-data/captured-frames.js";

const PROMPT_ROW = "❯ say 日本語の文字 and ｗｉｄｅ now";

describe("magmux-frame copy", () => {
  test("carries its provenance header", () => {
    const head = readFileSync(join(import.meta.dir, "magmux-frame.ts"), "utf8").slice(0, 400);
    expect(head).toContain("demo/rc/frame.ts");
    expect(head).toContain("9c45e07");
  });
});

describe("decoding a real claudish pane", () => {
  const [key, delta, resynced] = capturedFrames("fake-child-session");

  test("the keyframe fills every row and places the wide glyphs from wd", () => {
    const geom = capturedWatchReply("fake-child-session");
    const screen = newScreen(geom.rows, geom.cols);
    const changed = applyFrame(screen, key!);
    expect(screen.cleared).toBe(true);
    expect(changed).toHaveLength(geom.rows);
    expect(screen.lines[4]?.t).toBe(PROMPT_ROW);

    const cells = cellCols(screen.lines[4]!);
    // "❯ say " is six cells; each of the six CJK glyphs then takes two
    expect(Array.from(cells.colOf.slice(6, 13))).toEqual([6, 8, 10, 12, 14, 16, 18]);
    expect(cells.cpAt[7]).toBe(-1);
    // the fullwidth latin letters are wide too: ｗ starts at cell 23
    expect(cells.colOf[17]).toBe(23);
    expect(rowText(screen.lines[4]!, 40).trimEnd()).toBe(PROMPT_ROW);
    const spans = rowSpans(screen.lines[4]!, cells, geom.cols);
    expect(spans.reduce((n, s) => n + s.width, 0)).toBe(geom.cols);
  });

  test("a delta replaces only the rows it names", () => {
    const screen = newScreen(50, 160);
    applyFrame(screen, key!);
    const before = screen.lines[1];
    const changed = applyFrame(screen, delta!);
    expect(screen.cleared).toBe(false);
    expect(changed).toEqual([5, 6]);
    expect(screen.lines[5]?.t).toBe("⏺ ANSWER fake-answer 751f9a8b");
    expect(screen.lines[1]).toBe(before);
  });

  test("the keyframe after a resync reproduces the screen the deltas built", () => {
    const built = newScreen(50, 160);
    applyFrame(built, key!);
    applyFrame(built, delta!);
    const fresh = newScreen(50, 160);
    applyFrame(fresh, resynced!);
    expect(screenText(fresh)).toBe(screenText(built));
    expect(fresh.seq).toBeGreaterThan(built.seq);
  });

  test("a keyframe onto a screen of another size takes the frame's geometry", () => {
    const screen = newScreen(0, 0);
    applyFrame(screen, key!);
    expect([screen.rows, screen.cols]).toEqual([50, 160]);
    expect(screen.cur).toEqual({ y: 46, x: 2, vis: true });
  });
});

describe("decoding real SGR runs", () => {
  const [frame] = capturedFrames("sgr-runs");
  const screen = newScreen(24, 80);
  applyFrame(screen, frame!);
  const spansOf = (y: number) => rowSpans(screen.lines[y]!, cellCols(screen.lines[y]!), 80);

  test("indexed, bold and truecolor runs keep their cells", () => {
    const [bold, plain, indexed, gap, truecolor, rest] = spansOf(0);
    expect(bold).toMatchObject({ col: 0, width: 8, text: "bold red", fg: 1, attr: ATTR_BOLD });
    expect(plain).toMatchObject({ col: 8, text: " plain ", fg: COLOR_DEFAULT });
    expect(indexed).toMatchObject({ col: 15, text: "indexed", fg: 208 });
    expect(gap?.text).toBe(" ");
    expect(truecolor?.text).toBe("truecolor");
    expect(classifyColour(truecolor!.fg)).toEqual({ kind: "rgb", r: 10, g: 200, b: 30 });
    expect(classifyColour(truecolor!.bg)).toEqual({ kind: "rgb", r: 0, g: 0, b: 80 });
    expect(rest).toMatchObject({ col: 32, width: 48 });
  });

  test("attribute bits arrive as magmux numbers them", () => {
    const attrs = spansOf(1).map((s) => [s.text.trim(), s.attr]);
    expect(attrs).toContainEqual(["reverse", ATTR_REVERSE]);
    expect(attrs).toContainEqual(["dim", ATTR_DIM]);
    expect(attrs).toContainEqual(["strike", ATTR_STRIKE]);
  });

  test("a wide glyph on a background is one span counted in cells", () => {
    const [blue] = spansOf(2);
    expect(blue).toMatchObject({ col: 0, width: 17, text: "漢字 wide on blue", bg: 4 });
  });

  test("a styled blank row survives the right trim", () => {
    const [green, rest] = spansOf(3);
    expect(screen.lines[3]?.t).toBe("");
    expect(green).toMatchObject({ col: 0, width: 10, text: " ".repeat(10), bg: 2 });
    expect(rest?.bg).toBe(COLOR_DEFAULT);
  });
});
