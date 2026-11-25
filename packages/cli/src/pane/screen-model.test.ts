import { describe, expect, test } from "bun:test";
import { locateBox } from "./box-locate.js";
import {
  type MagmuxFrame,
  applyCapture,
  applyFrame,
  boxTopRow,
  emptyScreen,
  isBoxRule,
} from "./screen-model.js";
import { loadFrames, loadScreen } from "./test-helpers/fixtures.js";

function replayFrames(frames: MagmuxFrame[]) {
  let s = emptyScreen(160, 50);
  let t = 1000;
  for (const f of frames) {
    t += 250;
    s = applyFrame(s, f, t);
  }
  return s;
}

describe("screen-model over real magmux frames (phase-2 s01)", () => {
  const frames = loadFrames("boot-keylog-turn");

  test("seq is 0 before the first frame and 1 after the first keyframe", () => {
    const s0 = emptyScreen(160, 50);
    expect(s0.seq).toBe(0);
    expect(s0.lines).toHaveLength(50);
    expect(frames[0]?.key).toBe(true);
    const s1 = applyFrame(s0, frames[0]!, 5);
    expect(s1.seq).toBe(1);
    expect(s1.changedAt).toBe(5);
  });

  test("re-applying the same frame is not a visible change", () => {
    const s1 = applyFrame(emptyScreen(160, 50), frames[0]!, 5);
    const s2 = applyFrame(s1, frames[0]!, 9);
    expect(s2.seq).toBe(1);
    expect(s2.changedAt).toBe(5);
  });

  test("the replayed frames reproduce the captured settled screen", () => {
    const s = replayFrames(frames);
    const settled = loadScreen("repl-settled");
    expect(s.lines).toHaveLength(50);
    // The settled snapshot was taken mid-run; the last frame is the idle screen after it.
    expect(s.lines.slice(0, 11)).toEqual(settled.lines.slice(0, 11));
    expect(s.lines[46]).toBe("❯");
    expect(boxTopRow(s.lines, s.cols)).toBe(45);
    expect(s.seq).toBeGreaterThan(5);
    expect(s.seq).toBeLessThanOrEqual(frames.length);
  });

  test("a spans-only change bumps seq; a cursor move bumps seq", () => {
    const base = replayFrames(frames);
    const row = 46;
    const styled: MagmuxFrame = {
      rows: 50,
      cols: 160,
      alt: base.alt,
      cur: { y: base.cursor.y, x: base.cursor.x },
      key: false,
      lines: [{ y: row, t: base.lines[row], r: [[0, 1, 1, -1, 1]] }],
    };
    const s1 = applyFrame(base, styled, 1);
    expect(s1.lines[row]).toBe(base.lines[row]);
    expect(s1.seq).toBe(base.seq + 1);
    const moved = applyFrame(
      s1,
      { rows: 50, cols: 160, alt: base.alt, cur: { y: 0, x: 0 }, key: false, lines: [] },
      2
    );
    expect(moved.seq).toBe(s1.seq + 1);
  });

  test("an alt-screen flip alone bumps seq", () => {
    const base = replayFrames(frames);
    const flipped = applyFrame(
      base,
      { rows: 50, cols: 160, alt: !base.alt, cur: base.cursor, key: false, lines: [] },
      3
    );
    expect(flipped.seq).toBe(base.seq + 1);
  });
});

describe("isBoxRule", () => {
  test("accepts the agent-labelled top rule from the live capture", () => {
    const s = loadScreen("repl-boot-agent");
    expect(isBoxRule(s.lines[45], s.cols)).toBe(true);
  });

  test("rejects a labelled rule shorter than cols minus one", () => {
    const { cols } = loadScreen("repl-boot-agent");
    const tail = " Explore ─";
    const line = "─".repeat(cols - 2 - tail.length) + tail;
    expect(line.length).toBe(cols - 2);
    expect(isBoxRule(line, cols)).toBe(false);
  });

  test("rejects text without a trailing rule", () => {
    expect(isBoxRule("─".repeat(152) + " Explore", 160)).toBe(false);
  });

  test("rejects a line starting with text", () => {
    expect(isBoxRule("Explore " + "─".repeat(155), 160)).toBe(false);
  });

  test("rejects a rule with two labels", () => {
    expect(isBoxRule("─".repeat(150) + " Explore ─ Plan ─", 160)).toBe(false);
  });
});

describe("boxTopRow", () => {
  test("finds row 45 under --agent in the live capture", () => {
    const s = loadScreen("repl-boot-agent");
    expect(boxTopRow(s.lines, s.cols)).toBe(45);
  });
});

describe("aboveBoxChangedAt", () => {
  test("ignores the status rows under the box but moves for the working row above it", () => {
    let s = emptyScreen(160, 50);
    const screen = loadScreen("stop-hook-running");
    s = applyFrame(
      s,
      {
        rows: 50,
        cols: 160,
        alt: true,
        key: true,
        cur: screen.cursor,
        lines: screen.lines.map((t, y) => ({ y, t, r: screen.spans[y] })),
      },
      100
    );
    expect(s.aboveBoxChangedAt).toBe(100);
    const top = boxTopRow(s.lines, s.cols);
    expect(top).toBeGreaterThan(0);
    // status line under the box ticks
    const status = applyFrame(
      s,
      {
        rows: 50,
        cols: 160,
        alt: true,
        key: false,
        cur: s.cursor,
        lines: [{ y: 48, t: "  cwd • haiku • $0.001 • N/A" }],
      },
      200
    );
    expect(status.seq).toBe(s.seq + 1);
    expect(status.aboveBoxChangedAt).toBe(100);
    // the working row above the box ticks (captured every second during a Stop hook)
    const workingRow = s.lines.findIndex((l) => l.includes("running Stop hook"));
    expect(workingRow).toBeGreaterThan(-1);
    expect(workingRow).toBeLessThan(top);
    const tick = applyFrame(
      status,
      {
        rows: 50,
        cols: 160,
        alt: true,
        key: false,
        cur: s.cursor,
        lines: [{ y: workingRow, t: s.lines[workingRow]!.replace("· Processing", "✽ Processing") }],
      },
      300
    );
    expect(tick.aboveBoxChangedAt).toBe(300);
  });
});

describe("boxChangedAt", () => {
  /** A delta frame at `now` that rewrites `rows` and puts the cursor at `cur`. */
  const delta = (
    s: ReturnType<typeof emptyScreen>,
    rows: Array<{ y: number; t: string }>,
    now: number,
    cur = s.cursor
  ) => applyFrame(s, { rows: 50, cols: 160, alt: true, key: false, cur, lines: rows }, now);

  test("moves only when the box's rows, its place or the cursor change", () => {
    const screen = loadScreen("stop-hook-running");
    const s = applyFrame(
      emptyScreen(160, 50),
      {
        rows: 50,
        cols: 160,
        alt: true,
        key: true,
        cur: screen.cursor,
        lines: screen.lines.map((t, y) => ({ y, t, r: screen.spans[y] })),
      },
      100
    );
    expect(s.boxChangedAt).toBe(100);
    const top = boxTopRow(s.lines, s.cols);
    // the status line under the box and the working row above it tick: the box did not change
    const status = delta(s, [{ y: 48, t: "  cwd • haiku • $0.001 • N/A" }], 200);
    expect(status.seq).toBe(s.seq + 1);
    expect(status.boxChangedAt).toBe(100);
    const workingRow = s.lines.findIndex((l) => l.includes("running Stop hook"));
    const tick = delta(
      status,
      [{ y: workingRow, t: s.lines[workingRow]!.replace("· Processing", "✽ Processing") }],
      300
    );
    expect(tick.aboveBoxChangedAt).toBe(300);
    expect(tick.boxChangedAt).toBe(100);
    // text drawn in the box moves it
    const typed = delta(tick, [{ y: top + 1, t: "❯ hello" }], 400);
    expect(typed.boxChangedAt).toBe(400);
    // the cursor alone moving moves it: the cursor proves which cells were drawn
    const moved = delta(typed, [], 500, { x: typed.cursor.x + 1, y: typed.cursor.y });
    expect(moved.seq).toBe(typed.seq + 1);
    expect(moved.boxChangedAt).toBe(500);
    // a frame with no box located is no evidence about the box
    const gone = delta(moved, [{ y: top, t: "" }], 600);
    expect(gone.boxChangedAt).toBe(600);
  });

  /** A keyframe at `now` of a screen whose box (rules `cols` wide) holds `box`, styled `r`. */
  const boxKeyframe = (
    cols: number,
    box: string,
    now: number,
    s = emptyScreen(cols, 24),
    r: Array<[number, number, number, number, number]> = []
  ) => {
    const rule = "─".repeat(cols);
    const rows: NonNullable<MagmuxFrame["lines"]> = Array.from({ length: 24 }, (_, y) => ({
      y,
      t: "",
    }));
    rows[14] = { y: 14, t: rule };
    rows[15] = { y: 15, t: box ? `❯\u00a0${box}` : "❯", r };
    rows[16] = { y: 16, t: rule };
    rows[17] = { y: 17, t: "  ? for shortcuts" };
    return applyFrame(
      s,
      { rows: 24, cols, key: true, cur: { x: 2 + box.length, y: 15 }, lines: rows },
      now
    );
  };

  test("a change of the box row's cell attributes alone moves it", () => {
    const s = boxKeyframe(80, "hello", 100);
    expect(s.boxChangedAt).toBe(100);
    expect(locateBox(s)).not.toBeNull();
    const faint = boxKeyframe(80, "hello", 200, s, [[2, 5, -1, -1, 2]]);
    expect(faint.lines).toEqual(s.lines);
    expect(faint.seq).toBe(s.seq + 1);
    expect(faint.boxChangedAt).toBe(200);
  });

  test("a change of width moves it, the box redrawn at the new width", () => {
    const s = boxKeyframe(80, "hello", 100);
    const wider = boxKeyframe(100, "hello", 200, s);
    expect(wider.cols).toBe(100);
    // located on both sides: the width itself, not a lost box, moves it
    expect(locateBox(s)).not.toBeNull();
    expect(locateBox(wider)).not.toBeNull();
    expect(wider.boxChangedAt).toBe(200);
  });

  test("a keyframe identical to the screen keeps it", () => {
    const s = boxKeyframe(80, "hello", 100);
    const again = boxKeyframe(80, "hello", 200, s);
    expect(again).toBe(s);
    expect(again.boxChangedAt).toBe(100);
  });
});

describe("applyCapture", () => {
  test("pads a capture's text back to rows and keeps seq monotonic", () => {
    const s0 = applyFrame(emptyScreen(160, 50), loadFrames("agent-rejected")[0]!, 1);
    const s1 = applyCapture(
      s0,
      { rows: 50, cols: 160, alt: false, cursor: { x: 0, y: 4 }, text: "a\nb" },
      2
    );
    expect(s1.lines).toHaveLength(50);
    expect(s1.lines.slice(0, 3)).toEqual(["a", "b", ""]);
    expect(s1.seq).toBe(s0.seq + 1);
  });
});
