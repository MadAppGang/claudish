/**
 * Every child-process spawn in test code passes an `env` option.
 *
 * The bun test preload deletes the claudish session-identity variables from
 * `process.env`, and a child spawned with no `env` option gets them back (Bun.spawn on
 * 1.3.10 and 1.4.0; node:child_process on 1.3.10, the CI pin). See spawn-env-scan.ts.
 *
 * A site whose options cannot be read statically (a variable, a spread-only literal)
 * goes in ALLOWLIST with the file, the trimmed line text and the reason it is safe.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type AllowlistEntry, scanRepo, scanSource } from "./spawn-env-scan.ts";

const REPO_ROOT = join(import.meta.dir, "..");

const ALLOWLIST: AllowlistEntry[] = [];

describe("spawn env rule", () => {
  test("every Bun.spawn / node:child_process spawn in test code passes env", () => {
    const violations = scanRepo(REPO_ROOT, ALLOWLIST).map(
      (v) => `${v.file}:${v.line} ${v.callee} (${v.problem}): ${v.text}`
    );
    expect(violations).toEqual([]);
  });

  test("the scanner reports a spawn without env, with its file and line", () => {
    const src = [
      'import { execFileSync as run } from "node:child_process";',
      'Bun.spawn(["a"], { cwd: "/" });',
      'Bun.spawnSync(["a"], { env: { ...process.env } });',
      'run("ps", ["-o", "pid="]);',
      'const o = { env: {} }; Bun.spawn(["a"], o);',
      "// Bun.spawn(['in a comment'])",
    ].join("\n");
    const found = scanSource("x.test.ts", src).map((v) => [v.line, v.callee, v.problem]);
    expect(found).toEqual([
      [2, "Bun.spawn", "no env key"],
      [4, "run", "no options"],
      [5, "Bun.spawn", "options not an object literal"],
    ]);
  });
});
