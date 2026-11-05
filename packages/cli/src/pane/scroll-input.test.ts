import { describe, expect, test } from "bun:test";
import {
  CTRL_END,
  LIVE_BOTTOM,
  MAX_SCROLL_ROWS,
  type ScrollPosition,
  UNKNOWN_POSITION,
  WHEEL_DOWN,
  WHEEL_UP,
  isLiveBottom,
  planScroll,
  scrollRowsOf,
} from "./scroll-input.js";

// Literal expectations from spec §4, never derived from the exported token constants.
const UP = "\x1b[<64;1;1M";
const DOWN = "\x1b[<65;1;1M";
const END = "\x1b[1;5F";
const positions: Array<{ name: string; pos: ScrollPosition; up: number; down: number }> = [
  { name: "live bottom", pos: { atBottom: true, lastDirection: null }, up: 4, down: 4 },
  {
    name: "bottom with stale up direction",
    pos: { atBottom: true, lastDirection: "up" },
    up: 4,
    down: 4,
  },
  {
    name: "bottom with stale down direction",
    pos: { atBottom: true, lastDirection: "down" },
    up: 4,
    down: 4,
  },
  { name: "unknown", pos: { atBottom: false, lastDirection: null }, up: 4, down: 4 },
  { name: "last up", pos: { atBottom: false, lastDirection: "up" }, up: 3, down: 4 },
  { name: "last down", pos: { atBottom: false, lastDirection: "down" }, up: 4, down: 3 },
];

describe("scroll input planner", () => {
  // REQ: 4
  test("exports exact tokens, row cap and initial position beliefs", () => {
    expect({ WHEEL_UP, WHEEL_DOWN, CTRL_END, MAX_SCROLL_ROWS }).toEqual({
      WHEEL_UP: UP,
      WHEEL_DOWN: DOWN,
      CTRL_END: END,
      MAX_SCROLL_ROWS: 200,
    });
    expect(LIVE_BOTTOM).toEqual({ atBottom: true, lastDirection: null });
    expect(UNKNOWN_POSITION).toEqual({ atBottom: false, lastDirection: null });
  });

  for (const { name, pos, up, down } of positions) {
    for (const c of [
      { by: -3, direction: "up", token: UP, events: up },
      { by: 3, direction: "down", token: DOWN, events: down },
    ] as const) {
      // REQ: 4
      test(`from ${name}, by ${c.by} sends ${c.events} ${c.direction} events`, () => {
        const frozen = Object.freeze({ ...pos });
        expect(planScroll(frozen, { by: c.by })).toEqual({
          bytes: c.token.repeat(c.events),
          events: c.events,
          next: { atBottom: false, lastDirection: c.direction },
        });
        expect(frozen).toEqual(pos);
      });
    }

    // REQ: 4
    test(`to end from ${name} always emits ctrl-End and restores live bottom`, () => {
      expect(planScroll(Object.freeze({ ...pos }), { to: "end" })).toEqual({
        bytes: END,
        events: 1,
        next: { atBottom: true, lastDirection: null },
      });
    });
  }

  for (const by of [
    -1,
    1,
    -199,
    199,
    -200,
    200,
    -201,
    201,
    -Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
  ]) {
    // REQ: 4
    test(`by ${by} clamps rows before adding the one compensation event`, () => {
      const rows = Math.abs(by) > 200 ? 200 : Math.abs(by);
      const token = by < 0 ? UP : DOWN;
      const first = planScroll(LIVE_BOTTOM, { by });
      expect(first.bytes).toBe(token.repeat(rows + 1));
      expect(first.events).toBe(rows + 1);
      const next = planScroll(first.next, { by });
      expect(next.bytes).toBe(token.repeat(rows));
      expect(next.events).toBe(rows);
      expect(Buffer.byteLength(first.bytes)).toBeLessThanOrEqual(2010);
    });
  }

  // REQ: 4
  test("continuation, direction reversal and return to end keep compensation state", () => {
    let pos: ScrollPosition = LIVE_BOTTOM;
    const steps = [
      {
        req: { by: -2 },
        bytes: UP.repeat(3),
        events: 3,
        next: { atBottom: false, lastDirection: "up" },
      },
      {
        req: { by: -2 },
        bytes: UP.repeat(2),
        events: 2,
        next: { atBottom: false, lastDirection: "up" },
      },
      {
        req: { by: 2 },
        bytes: DOWN.repeat(3),
        events: 3,
        next: { atBottom: false, lastDirection: "down" },
      },
      { req: { to: "end" }, bytes: END, events: 1, next: { atBottom: true, lastDirection: null } },
      {
        req: { by: 2 },
        bytes: DOWN.repeat(3),
        events: 3,
        next: { atBottom: false, lastDirection: "down" },
      },
    ] as const;
    for (const step of steps) {
      const result = planScroll(pos, step.req);
      expect(result).toEqual({ bytes: step.bytes, events: step.events, next: step.next });
      pos = result.next;
    }
  });

  // REQ: 4
  test("plans contain only complete allowed tokens, no submit, text or paste markers", () => {
    for (const { pos } of positions) {
      for (const req of [{ by: -9999 }, { by: 9999 }, { to: "end" }] as const) {
        const { bytes } = planScroll(pos, req);
        expect(bytes.replaceAll(UP, "").replaceAll(DOWN, "").replaceAll(END, "")).toBe("");
        for (const forbidden of ["\r", "\n", "\x1b[F", "\x1b[200~", "\x1b[201~"])
          expect(bytes).not.toContain(forbidden);
      }
    }
    expect(Buffer.byteLength(planScroll(LIVE_BOTTOM, { by: -200 }).bytes)).toBe(2010);
  });

  // REQ: 4 (supplementary exported helper contract)
  test("isLiveBottom requires both bottom and a null direction", () => {
    for (const { pos } of positions)
      expect(isLiveBottom(pos)).toBe(pos.atBottom && pos.lastDirection === null);
  });

  // REQ: 4 (supplementary exported helper contract; MCP still rejects zero/fractions)
  test("scrollRowsOf handles zero, non-finite values, truncation and the cap", () => {
    for (const [input, rows] of [
      [0, 0],
      [-0, 0],
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, 0],
      [Number.NEGATIVE_INFINITY, 0],
      [0.9, 0],
      [-0.9, 0],
      [2.9, 2],
      [-2.9, 2],
      [200.9, 200],
      [-900, 200],
    ])
      expect(scrollRowsOf(input!)).toBe(rows!);
    expect(planScroll(UNKNOWN_POSITION, { by: 0 })).toEqual({
      bytes: "",
      events: 0,
      next: { atBottom: false, lastDirection: null },
    });
  });
});
