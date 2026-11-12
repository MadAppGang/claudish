import { describe, expect, test } from "bun:test";
import { DARK_PALETTE, LIGHT_PALETTE, inkOn, paletteFor } from "./palette.js";

describe("the panel's badge palette", () => {
  test("follows the theme background: light on a light page, dark otherwise", () => {
    expect(paletteFor("#FFFFFF")).toBe(LIGHT_PALETTE);
    expect(paletteFor("#f6f4ef")).toBe(LIGHT_PALETTE);
    expect(paletteFor("#141519")).toBe(DARK_PALETTE);
    expect(paletteFor(undefined)).toBe(DARK_PALETTE);
    expect(paletteFor("graphite")).toBe(DARK_PALETTE);
  });

  test("a state chip is the band's hue with the ink that reads on it", () => {
    expect(DARK_PALETTE.solid.run).toEqual({ fg: "#0B0B12", bg: "#89B4FA" });
    expect(DARK_PALETTE.solid.fail.bg).toBe("#FF4D5E");
    expect(LIGHT_PALETTE.solid.done).toEqual({ fg: "#FFFFFF", bg: "#166534" });
    expect(inkOn("#5B6CE0")).toBe("#FFFFFF");
  });
});
