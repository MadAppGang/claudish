/**
 * The band's badge colours, as the claudish band in the magus plugin draws them (its
 * `hooks/status/palette.ts`, madbench's stops): one hue per meaning, a solid half (the hue with
 * whichever of white or ink reads better on it) and a quiet half (the hue sunk toward the page),
 * and two greens for the tokens badge. Light or dark follows Herdr's theme background.
 */

import type { Tone } from "./runs.js";

export type Hue = Tone | "model" | "tools" | "loops" | "cost";
export interface Ink {
  fg: `#${string}`;
  bg: `#${string}`;
}

export interface Palette {
  solid: Readonly<Record<Hue, Ink>>;
  quiet: Readonly<Record<Hue, Ink>>;
  text: Readonly<Record<Hue, `#${string}`>>;
  tokensIn: Ink;
  tokensOut: Ink;
  /** the claudish mark in the run header */
  mark: `#${string}`;
}

const LIGHT: Readonly<Record<Hue, `#${string}`>> = {
  run: "#1D4ED8",
  ask: "#92400E",
  done: "#166534",
  fail: "#B91C1C",
  stopped: "#8F94AC",
  model: "#4338CA",
  tools: "#0D9488",
  loops: "#7C3AED",
  cost: "#A16207",
};
const DARK: Readonly<Record<Hue, `#${string}`>> = {
  run: "#89B4FA",
  ask: "#FFB454",
  done: "#22E06B",
  fail: "#FF4D5E",
  stopped: "#5A5E78",
  model: "#5B6CE0",
  tools: "#4FD6BE",
  loops: "#B794F6",
  cost: "#FFD479",
};
const SNOW = "#FFFFFF";
const INK = "#0B0B12";

type Rgb = readonly [number, number, number];

function rgb(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{6})/i.exec(hex);
  if (!m) return null;
  const n = Number.parseInt(m[1] as string, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function hex([r, g, b]: Rgb): `#${string}` {
  return `#${[r, g, b]
    .map((v) => Math.round(v).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

function mix(a: string, b: string, t: number): `#${string}` {
  const x = rgb(a) ?? [0, 0, 0];
  const y = rgb(b) ?? [0, 0, 0];
  return hex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

function luminance(c: string): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(c) ?? [0, 0, 0];
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** White or ink, whichever reads better on the fill. */
export function inkOn(fill: string): `#${string}` {
  return contrast(SNOW, fill) >= contrast(INK, fill) ? SNOW : INK;
}

function build(hues: Readonly<Record<Hue, `#${string}`>>, light: boolean): Palette {
  const solid = {} as Record<Hue, Ink>;
  const quiet = {} as Record<Hue, Ink>;
  for (const [k, h] of Object.entries(hues) as [Hue, `#${string}`][]) {
    solid[k] = { fg: inkOn(h), bg: h };
    quiet[k] = light
      ? { fg: mix(h, "#000000", 0.38), bg: mix(h, SNOW, 0.82) }
      : { fg: SNOW, bg: mix(h, "#000000", 0.55) };
  }
  return {
    solid,
    quiet,
    text: hues,
    tokensIn: light ? { fg: INK, bg: "#CDFFD3" } : { fg: SNOW, bg: "#0F592A" },
    tokensOut: light ? { fg: INK, bg: "#95FFA6" } : { fg: SNOW, bg: "#16803D" },
    mark: light ? "#C2410C" : "#E0875A",
  };
}

export const LIGHT_PALETTE: Palette = build(LIGHT, true);
export const DARK_PALETTE: Palette = build(DARK, false);

/** The light palette on a light theme background, the dark one otherwise (and when unreadable). */
export function paletteFor(background: string | undefined): Palette {
  return background && rgb(background) && luminance(background) > 0.4
    ? LIGHT_PALETTE
    : DARK_PALETTE;
}
