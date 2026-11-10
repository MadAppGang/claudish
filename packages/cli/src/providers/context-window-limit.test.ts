import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { contextWindowLimit, parseContextWindow } from "./context-window-limit.js";

describe("parseContextWindow", () => {
  for (const [text, size] of [
    ["128000", 128_000],
    ["128k", 128_000],
    ["64K", 64_000],
    ["1m", 1_000_000],
    ["1.5m", 1_500_000],
  ] as const) {
    test(`${text} is ${size} tokens`, () => {
      expect(parseContextWindow(text)).toBe(size);
    });
  }

  for (const text of ["", "abc", "0", "-5", "12x", "k"]) {
    test(`"${text}" is refused`, () => {
      expect(parseContextWindow(text)).toBeUndefined();
    });
  }
});

describe("contextWindowLimit", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.CLAUDISH_CONTEXT_WINDOW;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDISH_CONTEXT_WINDOW;
    else process.env.CLAUDISH_CONTEXT_WINDOW = saved;
  });

  test("reads the limit from the environment", () => {
    process.env.CLAUDISH_CONTEXT_WINDOW = "48k";
    expect(contextWindowLimit()).toBe(48_000);
  });

  test("no value means no limit", () => {
    delete process.env.CLAUDISH_CONTEXT_WINDOW;
    expect(contextWindowLimit()).toBeUndefined();
  });

  test("a value that is not a size means no limit", () => {
    process.env.CLAUDISH_CONTEXT_WINDOW = "lots";
    expect(contextWindowLimit()).toBeUndefined();
  });
});
