import { describe, expect, test } from "bun:test";
import { contextWindowChoices } from "./context-window-choices.js";

const DEFAULT_SIZE = 128_000;
const sizes = (max: number) => contextWindowChoices(max, DEFAULT_SIZE).choices.map((c) => c.size);

describe("contextWindowChoices", () => {
  test("offers the common sizes below the model's maximum, then the maximum", () => {
    expect(sizes(1_048_576)).toEqual([32_000, 64_000, 128_000, 256_000, 512_000, 1_048_576]);
  });

  test("never offers more than the model's maximum", () => {
    expect(sizes(100_000)).toEqual([32_000, 64_000, 100_000]);
  });

  test("drops a common size that nearly equals the maximum", () => {
    expect(sizes(262_144)).toEqual([32_000, 64_000, 128_000, 262_144]);
  });

  test("a small model offers only its maximum", () => {
    expect(sizes(32_768)).toEqual([32_768]);
  });

  test("names the maximum on its row", () => {
    const { choices } = contextWindowChoices(262_144, DEFAULT_SIZE);

    expect(choices.at(-1)?.label).toBe("262K (model maximum)");
    expect(choices[2]?.label).toBe("128K");
  });

  test("starts on the default size", () => {
    const { choices, defaultIndex } = contextWindowChoices(262_144, DEFAULT_SIZE);

    expect(choices[defaultIndex]?.size).toBe(128_000);
  });

  test("starts on the maximum when the model cannot reach the default", () => {
    const { choices, defaultIndex } = contextWindowChoices(100_000, DEFAULT_SIZE);

    expect(choices[defaultIndex]?.size).toBe(100_000);
  });
});
