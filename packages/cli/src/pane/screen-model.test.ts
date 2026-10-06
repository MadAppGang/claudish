import { describe, expect, test } from "bun:test";
import {
  type MagmuxFrame,
  applyCapture,
  applyFrame,
  boxTopRow,
  emptyScreen,
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
