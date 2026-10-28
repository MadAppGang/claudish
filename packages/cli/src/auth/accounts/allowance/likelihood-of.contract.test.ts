import { describe, expect, test } from "bun:test";
import { quantilesOf } from "./forecast.js";
import { likelihoodOf } from "./trajectory.js";

const HOUR = 60 * 60 * 1000;

describe("likelihoodOf black-box contract", () => {
  test("L8a: peak is exactly one, values are bounded, and empty input is zero", () => {
    const times = [0.25, 1.25, 2.25, 2.25, 3.25, 4.25, 5.25].map((hour) => hour * HOUR);
    const curve = likelihoodOf(times, quantilesOf(times), 0, 8);

    expect(curve).toHaveLength(8);
    expect(Math.max(...curve)).toBe(1);
    for (const value of curve) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }

    const empty: number[] = [];
    expect(likelihoodOf(empty, quantilesOf(empty), 0, 8)).toEqual(Array(8).fill(0));
  });

  test("L8b: zero IQR preserves normalized counts and empty-hour gaps", () => {
    const times = [
      ...Array(5).fill(0.25 * HOUR),
      ...Array(5).fill(2.25 * HOUR),
      ...Array(90).fill(10.25 * HOUR),
    ];
    const curve = likelihoodOf(times, quantilesOf(times), 0, 12);

    expect(curve).toEqual([5 / 90, 0, 5 / 90, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
  });

  test("L8c: broad spread smooths empty hours and peaks near the median", () => {
    const times = Array.from({ length: 21 }, (_, i) => (2 * i + 0.25) * HOUR);
    const curve = likelihoodOf(times, quantilesOf(times), 0, 42);

    expect(curve).toHaveLength(42);
    for (let hour = 1; hour < 40; hour += 2) {
      expect(curve[hour]).toBeGreaterThan(0);
    }
    const peakHour = curve.indexOf(Math.max(...curve));
    const medianHour = times[10]! / HOUR;
    expect(Math.abs(peakHour - medianHour)).toBeLessThanOrEqual(6);
  });

  test("L8d: out-of-window times do not extend the hourly array", () => {
    const h0 = 10 * HOUR;
    const times = [h0 - HOUR, h0, h0 + 0.25 * HOUR, h0 + 2 * HOUR, h0 + 8 * HOUR];
    const curve = likelihoodOf(times, quantilesOf(times), h0, 2);

    expect(curve).toHaveLength(2);
    expect(Object.keys(curve)).toEqual(["0", "1"]);
    expect(curve[-1]).toBeUndefined();
    expect(curve[2]).toBeUndefined();
  });
});
