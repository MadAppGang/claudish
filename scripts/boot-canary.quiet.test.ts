import { describe, expect, test } from "bun:test";
import {
  BOOT_CLOCK_START,
  type BootClock,
  QUIET_MS,
  bootLabel,
  bootSettled,
  noteFrame,
} from "./boot-canary.quiet.ts";

const BLANK = Array.from({ length: 50 }, () => "");
const PAINTED = [...BLANK.slice(0, 10), " ✻ Welcome to Claude Code", ...BLANK.slice(11)];

describe("bootSettled", () => {
  test("a blank keyframe followed by 4.5 s of no change is not settled", () => {
    const clock = noteFrame(BOOT_CLOCK_START, { changed: true, lines: BLANK }, 1_000);
    expect(bootSettled(clock, 1_000 + 4_500)).toBe(false);
  });

  test("a painted frame followed by QUIET_MS of no change is settled", () => {
    let clock: BootClock = noteFrame(BOOT_CLOCK_START, { changed: true, lines: BLANK }, 1_000);
    clock = noteFrame(clock, { changed: true, lines: PAINTED }, 3_000);
    expect(bootSettled(clock, 3_000 + QUIET_MS - 1)).toBe(false);
    expect(bootSettled(clock, 3_000 + QUIET_MS)).toBe(true);
  });

  test("the quiet clock restarts on every change after the first paint", () => {
    let clock: BootClock = noteFrame(BOOT_CLOCK_START, { changed: true, lines: PAINTED }, 1_000);
    clock = noteFrame(clock, { changed: true, lines: BLANK }, 4_000);
    expect(bootSettled(clock, 1_000 + QUIET_MS)).toBe(false);
    expect(bootSettled(clock, 4_000 + QUIET_MS)).toBe(true);
  });

  test("a frame that changes nothing neither paints nor restarts the clock", () => {
    let clock: BootClock = noteFrame(BOOT_CLOCK_START, { changed: true, lines: PAINTED }, 1_000);
    clock = noteFrame(clock, { changed: false, lines: PAINTED }, 3_000);
    expect(bootSettled(clock, 1_000 + QUIET_MS)).toBe(true);
    const unpainted = noteFrame(BOOT_CLOCK_START, { changed: false, lines: PAINTED }, 1_000);
    expect(bootSettled(unpainted, 1_000 + QUIET_MS)).toBe(false);
  });

  test("a row of spaces is not a paint", () => {
    const clock = noteFrame(BOOT_CLOCK_START, { changed: true, lines: ["   ", ""] }, 1_000);
    expect(bootSettled(clock, 1_000 + QUIET_MS)).toBe(false);
  });
});

describe("bootLabel", () => {
  const painted = noteFrame(BOOT_CLOCK_START, { changed: true, lines: PAINTED }, 1_000);
  const blank = noteFrame(BOOT_CLOCK_START, { changed: true, lines: BLANK }, 1_000);

  test("a screen never painted reads no-paint", () => {
    expect(bootLabel({ kind: "booting" }, false, blank)).toBe("no-paint");
    expect(bootLabel({ kind: "booting" }, false, BOOT_CLOCK_START)).toBe("no-paint");
  });

  test("a child that exited before painting reads exited", () => {
    expect(bootLabel({ kind: "booting" }, true, BOOT_CLOCK_START)).toBe("exited");
  });

  test("a painted screen reads as the classifier reads it", () => {
    expect(bootLabel({ kind: "repl" }, false, painted)).toBe("repl");
    expect(bootLabel({ kind: "booting" }, false, painted)).toBe("booting");
    expect(bootLabel({ kind: "booting" }, true, painted)).toBe("exited");
    expect(bootLabel({ kind: "dialog", name: "trust" }, false, painted)).toBe("dialog:trust");
    expect(bootLabel({ kind: "choice" }, false, painted)).toBe("choice");
  });
});
