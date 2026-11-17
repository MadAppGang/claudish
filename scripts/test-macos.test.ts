import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HERMETIC_RUNS, bunPinOf, compareVersions } from "./test-macos.ts";

const WORKFLOW = readFileSync(
  join(import.meta.dir, "..", ".github", "workflows", "test.yml"),
  "utf8"
);

describe("test:macos reads its Buns from test.yml", () => {
  test("the hermetic and blind-hooks jobs each pin an exact Bun", () => {
    expect(bunPinOf(WORKFLOW, "hermetic")).toMatch(/^\d+\.\d+\.\d+$/);
    expect(bunPinOf(WORKFLOW, "blind-hooks")).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("a pin is read from its own job, not the next one", () => {
    const yml = [
      "jobs:",
      "  a:",
      "    steps:",
      "      - uses: oven-sh/setup-bun@v2",
      "        with:",
      "          bun-version: latest",
      "  b:",
      "    steps:",
      "      - uses: oven-sh/setup-bun@v2",
      "        with:",
      '          bun-version: "1.2.3"',
    ].join("\n");
    expect(bunPinOf(yml, "a")).toBeUndefined();
    expect(bunPinOf(yml, "b")).toBe("1.2.3");
    expect(bunPinOf(yml, "missing")).toBeUndefined();
  });

  test("a two-space comment inside a job does not end the job", () => {
    const yml = [
      "jobs:",
      "  a:",
      "    runs-on: macos-latest",
      "  # a comment at the job key's indent",
      "    steps:",
      "      - uses: oven-sh/setup-bun@v2",
      "        with:",
      '          bun-version: "1.2.3"',
      "  b:",
      "    steps: []",
    ].join("\n");
    expect(bunPinOf(yml, "a")).toBe("1.2.3");
  });

  test("the hermetic runs are the slices test.yml's hermetic runners run", () => {
    const runs = [...WORKFLOW.matchAll(/^\s+runs: (\S+)$/gm)].map((m) => m[1]).join(",");
    expect(runs).toBe(HERMETIC_RUNS);
  });
});

describe("compareVersions", () => {
  test("orders dotted numbers numerically", () => {
    expect(compareVersions("0.19.0", "0.19.0")).toBe(0);
    expect(compareVersions("0.9.0", "0.19.0")).toBe(-1);
    expect(compareVersions("0.20.0", "0.19.0")).toBe(1);
  });
});
