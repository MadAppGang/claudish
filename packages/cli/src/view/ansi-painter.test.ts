/**
 * The painter's exact bytes: one full SGR per span, clipping in cells with wide glyphs dropped
 * whole at the edge, rows past the terminal not painted, and the status row's colours read from
 * the theme at paint time.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetThemeModeForTests, setThemeMode } from "../theme/theme-mode.js";
import { ALT_ON, AnsiPainter, type TermSize, clipSpan, sgr } from "./ansi-painter.js";
import { type Line, applyFrame, cellCols, newScreen, rowSpans } from "./magmux-frame.js";
import { capturedFrames } from "./test-data/captured-frames.js";

const E = "\x1b[";

function painterOn(term: TermSize): { painter: AnsiPainter; out: () => string } {
  let buf = "";
  const painter = new AnsiPainter({
    write: (s) => {
      buf += s;
    },
    term: () => term,
  });
  return {
    painter,
    out: () => {
      painter.flush();
      const s = buf;
      buf = "";
      return s;
    },
  };
}

let savedNoColor: string | undefined;
beforeEach(() => {
  savedNoColor = process.env.NO_COLOR;
  // an empty string would still count as set
  delete process.env.NO_COLOR;
  resetThemeModeForTests();
});
afterEach(() => {
  if (savedNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = savedNoColor;
  resetThemeModeForTests();
});

describe("sgr", () => {
  test("a reset first, then attributes, then each colour class", () => {
    expect(sgr({ col: 0, width: 1, text: "x", fg: 1, bg: -1, attr: 1 })).toBe(`${E}0;1;31m`);
    expect(sgr({ col: 0, width: 1, text: "x", fg: 9, bg: 12, attr: 0 })).toBe(`${E}0;91;104m`);
    expect(sgr({ col: 0, width: 1, text: "x", fg: 208, bg: 17, attr: 0 })).toBe(
      `${E}0;38;5;208;48;5;17m`
    );
    expect(
      sgr({ col: 0, width: 1, text: "x", fg: 17483806, bg: 16777296, attr: 16 | 2 | 128 | 256 })
    ).toBe(`${E}0;2;7;9;53;38;2;10;200;30;48;2;0;0;80m`);
    expect(sgr({ col: 0, width: 1, text: "x", fg: -1, bg: -1, attr: 0 })).toBe(`${E}0m`);
  });
});

describe("clipSpan", () => {
  const line: Line = { y: 0, t: "a漢字b", wd: [1, 2] };
  const cells = cellCols(line);
  const [span] = rowSpans(line, cells, 6);

  test("a span that fits is returned whole", () => {
    expect(clipSpan(span!, 6, cells)).toBe("a漢字b");
  });

  test("a wide glyph cut by the edge is dropped, never half painted", () => {
    expect(clipSpan(span!, 4, cells)).toBe("a漢");
    expect(clipSpan(span!, 5, cells)).toBe("a漢字");
    expect(clipSpan(span!, 2, cells)).toBe("a");
    expect(clipSpan(span!, 0, cells)).toBe("");
  });
});

describe("control code points in cell and status text", () => {
  // CSI as one C1 code point, DEL, and an ESC: none may reach the terminal as a control
  const hostile = "\u009b31mX\u007fY\u001b]52;c;Zm9v\u0007";
  const controlIn = (s: string): string | null => {
    for (const ch of s) {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return ch;
    }
    return null;
  };

  test("a row's span text is written with every control replaced, one cell each", () => {
    const line: Line = { y: 0, t: hostile };
    const cells = cellCols(line);
    const [span] = rowSpans(line, cells, 40);
    const text = clipSpan(span!, 40, cells);
    expect(controlIn(text)).toBeNull();
    expect(text.trimEnd()).toBe(" 31mX Y ]52;c;Zm9v");
  });

  test("band and status text are written with no control code point", () => {
    const { painter, out } = painterOn({ cols: 60, rows: 25 });
    painter.band(hostile);
    painter.status(hostile, "live");
    // the painter's own sequences start with ESC; nothing else may
    const esc = String.fromCharCode(0x1b);
    const written = out().replace(new RegExp(`${esc}\\[[0-9;?]*[A-Za-z]`, "g"), "");
    expect(controlIn(written)).toBeNull();
  });
});

describe("AnsiPainter", () => {
  const [frame] = capturedFrames("sgr-runs");
  const screen = newScreen(24, 80);
  applyFrame(screen, frame!);

  test("a real row, golden bytes", () => {
    const { painter, out } = painterOn({ cols: 80, rows: 25 });
    painter.size(24, 80);
    expect(out()).toBe(`${ALT_ON}${E}?25l${E}2J`);
    painter.row(0, screen.lines[0]!, cellCols(screen.lines[0]!));
    expect(out()).toBe(
      `${E}1;1H${E}0;1;31mbold red${E}0m plain ${E}0;38;5;208mindexed${E}0m ` +
        `${E}0;38;2;10;200;30;48;2;0;0;80mtruecolor${E}0m${" ".repeat(48)}${E}0m${E}K`
    );
  });

  test("a wide glyph row on a background, clipped to a narrow terminal", () => {
    const { painter, out } = painterOn({ cols: 7, rows: 25 });
    painter.size(24, 80);
    out();
    painter.row(2, screen.lines[2]!, cellCols(screen.lines[2]!));
    // 漢字 fill four cells, then " wi" the last three
    expect(out()).toBe(`${E}3;1H${E}0;44m漢字 wi${E}0m${E}K`);
    expect(painter.clipped()).toBe(true);
  });

  test("an edge that would split a wide glyph drops it whole", () => {
    const { painter, out } = painterOn({ cols: 3, rows: 25 });
    painter.size(24, 80);
    out();
    painter.row(2, screen.lines[2]!, cellCols(screen.lines[2]!));
    expect(out()).toBe(`${E}3;1H${E}0;44m漢${E}0m${E}K`);
  });

  test("rows past the terminal, and the status row, are never painted over", () => {
    const { painter, out } = painterOn({ cols: 80, rows: 3 });
    painter.size(24, 80);
    out();
    painter.row(2, screen.lines[2]!, cellCols(screen.lines[2]!));
    painter.row(10, screen.lines[3]!, cellCols(screen.lines[3]!));
    expect(out()).toBe("");
    painter.cursor({ y: 2, x: 0, vis: true });
    expect(out()).toBe(`${E}?25l`);
    painter.cursor({ y: 1, x: 4, vis: true });
    expect(out()).toBe(`${E}2;5H${E}?25h`);
  });

  test("one write per paint: the rows of a frame are flushed together", async () => {
    let writes = 0;
    const painter = new AnsiPainter({
      write: () => writes++,
      term: () => ({ cols: 80, rows: 25 }),
    });
    painter.size(24, 80);
    for (let y = 0; y < 4; y++) painter.row(y, screen.lines[y]!, cellCols(screen.lines[y]!));
    await Promise.resolve();
    expect(writes).toBe(1);
  });

  test("the status row fills the bottom line in reverse video", () => {
    const { painter, out } = painterOn({ cols: 20, rows: 5 });
    painter.size(4, 20);
    out();
    painter.status("s:abc · RUNNING", "live");
    expect(out()).toBe(`${E}5;1H${E}0m${E}7m${E}32m ●${E}0m${E}7m s:abc · RUNNING  ${E}0m${E}?25l`);
  });

  test("the status colour is read when it is painted, not when the painter was made", () => {
    const { painter, out } = painterOn({ cols: 20, rows: 5 });
    painter.size(4, 20);
    out();
    setThemeMode("light");
    painter.status("x", "live");
    expect(out()).toContain(`${E}38;2;21;128;61m ●`);
    process.env.NO_COLOR = "1";
    painter.status("x", "live");
    expect(out()).toBe(`${E}5;1H${E}0m${E}7m ●${E}0m${E}7m x${" ".repeat(16)}${E}0m${E}?25l`);
  });

  test("the band replaces the picture with one line", () => {
    const { painter, out } = painterOn({ cols: 30, rows: 5 });
    painter.band("viewing in herdr — Enter to view here");
    const s = out();
    expect(s.startsWith(`${ALT_ON}${E}?25l${E}2J${E}2J${E}1;1H`)).toBe(true);
    expect(s).toContain(" viewing in herdr — Enter to v");
    expect(s).not.toContain("Enter to view here");
  });

  test("end leaves the alternate screen and shows the cursor", () => {
    const { painter, out } = painterOn({ cols: 30, rows: 5 });
    painter.size(4, 30);
    out();
    painter.end();
    expect(out()).toBe(`${E}0m${E}?25h${E}?1049l`);
  });
});
