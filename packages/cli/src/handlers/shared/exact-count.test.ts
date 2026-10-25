/**
 * #674 — unit pins for the exact-count band and the transport probe.
 *
 * The band is one-sided on purpose: below `window / band` even the worst
 * measured over-count (×3.18) cannot reach the window, so a probe there would
 * buy nothing. Inside, the estimate may only NOMINATE — the engine's own
 * tokenizer decides, because `real/est` spans 0.57–3.18 and any threshold on
 * the estimate is wrong in one direction or the other.
 *
 * The probe's contract (types.ts) is the other half: never throws, never hangs,
 * and a route that does not exist turns itself off for the process — a 404 must
 * cost exactly one request, forever.
 */

import { describe, expect, test } from "bun:test";
import {
  EXACT_COUNT_DEFAULT_BAND,
  exactCountDisabled,
  inExactCountBand,
  readExactCountBand,
} from "./exact-count.js";

describe("readExactCountBand / exactCountDisabled (#674)", () => {
  test("default band is 1.15 and an absent variable means the default", () => {
    expect(readExactCountBand({})).toBe(EXACT_COUNT_DEFAULT_BAND);
    expect(EXACT_COUNT_DEFAULT_BAND).toBe(1.15);
  });

  test("strict parse: a unit suffix or garbage falls back to the DEFAULT, never NaN", () => {
    // A NaN band would silently disarm the whole feature: `est >= window / NaN`
    // is false for every request, and nothing else would report it.
    for (const raw of ["1.2x", "2s", "", " ", "abc", "NaN", "Infinity", "-1"]) {
      expect(readExactCountBand({ CLAUDISH_EXACT_COUNT_BAND: raw })).toBe(EXACT_COUNT_DEFAULT_BAND);
    }
  });

  test("clamped to [1, 2]: below 1 would probe every request, above 2 is unreachable", () => {
    expect(readExactCountBand({ CLAUDISH_EXACT_COUNT_BAND: "0.5" })).toBe(1);
    expect(readExactCountBand({ CLAUDISH_EXACT_COUNT_BAND: "9" })).toBe(2);
    expect(readExactCountBand({ CLAUDISH_EXACT_COUNT_BAND: "1.4" })).toBe(1.4);
  });

  test("the kill switch is exact: only an explicit 0 disarms", () => {
    expect(exactCountDisabled({ CLAUDISH_EXACT_COUNT: "0" })).toBe(true);
    expect(exactCountDisabled({ CLAUDISH_EXACT_COUNT: " 0 " })).toBe(true);
    for (const raw of ["1", "", "false", "off", "no"]) {
      expect(exactCountDisabled({ CLAUDISH_EXACT_COUNT: raw })).toBe(false);
    }
    expect(exactCountDisabled({})).toBe(false);
  });
});

describe("inExactCountBand (#674)", () => {
  test("nominates from window / band, ceiled — 262 144 → 227 952 at the default", () => {
    expect(inExactCountBand(227_951, 262_144)).toBe(false);
    expect(inExactCountBand(227_952, 262_144)).toBe(true);
    expect(inExactCountBand(262_144, 262_144)).toBe(true); // the old gate's region is included
    expect(inExactCountBand(300_000, 262_144)).toBe(true); // above the window: still probed
  });

  test("a band of 1 nominates only at/above the window — today's exact threshold", () => {
    expect(inExactCountBand(262_143, 262_144, 1)).toBe(false);
    expect(inExactCountBand(262_144, 262_144, 1)).toBe(true);
  });

  test("nonsense inputs nominate NOTHING — no probe on a value we cannot reason about", () => {
    expect(inExactCountBand(Number.NaN, 262_144)).toBe(false);
    expect(inExactCountBand(500_000, 0)).toBe(false);
    expect(inExactCountBand(500_000, -1)).toBe(false);
    expect(inExactCountBand(500_000, 262_144, 0)).toBe(false);
    expect(inExactCountBand(500_000, 262_144, Number.NaN)).toBe(false);
  });
});
