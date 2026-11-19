import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "boot-canary.ts");

/** Runs the canary with a binary that does not exist: a usage error must leave before it is read. */
function canary(...args: string[]): { status: number | null; stderr: string; outMade: boolean } {
  const dir = mkdtempSync(join(tmpdir(), "canary-usage-"));
  const out = join(dir, "out");
  try {
    const run = spawnSync(
      process.execPath,
      [SCRIPT, "--bin", join(dir, "no-such-claude"), "--out", out, ...args],
      { encoding: "utf8" }
    );
    return { status: run.status, stderr: run.stderr, outMade: existsSync(out) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("boot-canary usage errors exit 2 before anything boots", () => {
  test("a scenario named twice", () => {
    const run = canary("--scenarios", "boot,agent,boot", "--jobs", "2");
    expect(run.stderr).toContain("scenario boot is named twice");
    expect(run.status).toBe(2);
    expect(run.outMade).toBe(false);
  });

  test("an unknown scenario", () => {
    const run = canary("--scenarios", "boot,nope");
    expect(run.stderr).toContain("unknown scenario nope");
    expect(run.status).toBe(2);
  });

  test("--jobs with no value", () => {
    const run = canary("--scenarios", "boot", "--jobs");
    expect(run.stderr).toContain("--jobs needs a value");
    expect(run.status).toBe(2);
    expect(run.outMade).toBe(false);
  });

  test("a flag followed by another flag", () => {
    const run = canary("--scenarios", "--jobs", "2");
    expect(run.stderr).toContain("--scenarios needs a value");
    expect(run.status).toBe(2);
  });

  for (const bad of ["0", "1.5"]) {
    test(`--jobs ${bad}`, () => {
      const run = canary("--scenarios", "boot", "--jobs", bad);
      expect(run.stderr).toContain("--jobs takes a whole number, 1 or more");
      expect(run.status).toBe(2);
    });
  }
});
