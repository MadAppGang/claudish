/**
 * Pins the preset-mode sandbox guard (`test-sandbox.ts`). Each branch that can
 * let a real home through has a test here; the preload calls the same function,
 * so a mutation of a guard turns exactly its pin red.
 */
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { presetRefusal } from "./test-sandbox";

const base = {
  sandbox: "/tmp/claudish-test-home-abc",
  tmpDir: "/tmp",
  githubActions: false,
};

describe("preset-mode sandbox guard", () => {
  test("accepts a throwaway sandbox with the conventional basename", () => {
    expect(presetRefusal(base)).toBeNull();
  });

  test("accepts a sandbox under RUNNER_TEMP", () => {
    expect(
      presetRefusal({
        ...base,
        sandbox: "/home/runner/work/_temp/claudish-test-home",
        runnerTemp: "/home/runner/work/_temp",
      }),
    ).toBeNull();
  });

  test("under GitHub Actions, the basename rule is relaxed but throwaway is not", () => {
    // CI may pick its own temp dir name; it may not point at a non-throwaway path.
    expect(presetRefusal({ ...base, sandbox: "/tmp/home", githubActions: true })).toBeNull();
    expect(presetRefusal({ ...base, sandbox: "/mnt/ci/home", githubActions: true })).toContain(
      "neither under",
    );
  });

  test("refuses the real home (inherited preset on a seat)", () => {
    const msg = presetRefusal({ ...base, sandbox: "/home/runner" });
    expect(msg).toContain("neither under");
  });

  test("refuses a directory that is not throwaway, outside CI", () => {
    expect(presetRefusal({ ...base, sandbox: "/home/runner/claudish" })).toContain("neither under");
  });

  test("refuses a throwaway directory that is not a test sandbox", () => {
    // /tmp/home is throwaway but has no sandbox basename: a preset HOME may be
    // a real home that happens to live under /tmp.
    const msg = presetRefusal({ ...base, sandbox: "/tmp/home" });
    expect(msg).toContain("does not look like a test sandbox");
  });

  test("does not treat a sibling directory as under tmpdir", () => {
    expect(presetRefusal({ ...base, sandbox: "/tmpfoo/claudish-test-home" })).toContain(
      "neither under",
    );
  });

  test("resolves dot segments before comparing", () => {
    expect(presetRefusal({ ...base, sandbox: "/tmp/claudish-test-home-x/../home" })).toContain(
      "does not look like a test sandbox",
    );
  });

  test("refusal names the offending path", () => {
    expect(presetRefusal({ ...base, sandbox: "/home/runner" })).toContain(resolve("/home/runner"));
    expect(presetRefusal({ ...base, sandbox: "/mnt/elsewhere" })).toContain(resolve("/mnt/elsewhere"));
  });
});