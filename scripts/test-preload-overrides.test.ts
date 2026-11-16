/**
 * The preload's path-override guard.
 *
 * A claudish launched with `--config <file>` exports `CLAUDISH_CONFIG=<file>` to every
 * process it starts, so that nested claudish children read the same file. A plain
 * `bun test` run inside such a session inherits it. The preload moves `HOME` to a
 * temporary directory, but `CLAUDISH_CONFIG` outranks `HOME`, so without this guard the
 * suite reads that file, real `apiKeys` included. The other three overrides point past
 * `HOME` the same way: the account list, and the dynamic models catalog and its key.
 *
 * Each case spawns `bun test` on a check file, from each directory that carries a
 * bunfig.toml, with all four overrides set, and asserts the check file sees none.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { HOME_BYPASS_OVERRIDES } from "./home-bypass-overrides.ts";

const repoRoot = resolve(import.meta.dir, "..");
const ROOTS: Array<[string, string]> = [
  ["repo root", repoRoot],
  ["packages/cli", resolve(repoRoot, "packages/cli")],
  ["packages/macos-bridge", resolve(repoRoot, "packages/macos-bridge")],
];

describe("preload path-override guard", () => {
  test("lists exactly the four overrides that point past HOME", () => {
    expect([...HOME_BYPASS_OVERRIDES].sort()).toEqual([
      "CLAUDISH_ACCOUNTS_DIR",
      "CLAUDISH_CONFIG",
      "CLAUDISH_DYNAMIC_CATALOG_DIR",
      "CLAUDISH_DYNAMIC_CATALOG_KEY",
    ]);
  });

  for (const [label, cwd] of ROOTS) {
    test(`a bun test run from ${label} does not inherit an override`, () => {
      const dir = mkdtempSync(resolve(tmpdir(), "preload-overrides-"));
      try {
        const configPath = resolve(dir, "override-config.json");
        writeFileSync(
          configPath,
          JSON.stringify({ apiKeys: { ANTHROPIC_API_KEY: "sk-ant-preload-guard-test-value" } })
        );
        const overrides: Record<string, string> = {
          CLAUDISH_ACCOUNTS_DIR: resolve(dir, "override-accounts"),
          CLAUDISH_CONFIG: configPath,
          CLAUDISH_DYNAMIC_CATALOG_DIR: resolve(dir, "override-dynamic-models-catalog"),
          CLAUDISH_DYNAMIC_CATALOG_KEY: resolve(dir, "override-dynamic-models-catalog.key"),
        };
        const outPath = resolve(dir, "seen.json");
        // Outside the tree and without a .test. name: only this explicit run discovers it.
        const checkPath = resolve(dir, "override-check.ts");
        writeFileSync(
          checkPath,
          `
          import { test } from "bun:test";
          import { writeFileSync } from "node:fs";
          const names = ${JSON.stringify(Object.keys(overrides))};
          test("record", () => {
            writeFileSync(${JSON.stringify(outPath)}, JSON.stringify(
              Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]))
            ));
          });
        `
        );
        const child = Bun.spawnSync([process.execPath, "test", checkPath], {
          cwd,
          env: { PATH: process.env.PATH ?? "", ...overrides, TMPDIR: tmpdir() },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 15_000,
        });
        const output = child.stdout.toString() + child.stderr.toString();
        expect({ exitCode: child.exitCode, output }).toEqual({
          exitCode: 0,
          output: expect.stringContaining("1 pass"),
        });
        const seen = JSON.parse(readFileSync(outPath, "utf8")) as Record<string, string | null>;
        // No inherited value survives. The preload then points the two catalog paths
        // into its own temporary home (test-preload.ts), so those two are set again.
        for (const [name, inherited] of Object.entries(overrides)) {
          expect({ name, value: seen[name] }).not.toEqual({ name, value: inherited });
        }
        expect(seen.CLAUDISH_CONFIG).toBeNull();
        expect(seen.CLAUDISH_ACCOUNTS_DIR).toBeNull();
        for (const name of ["CLAUDISH_DYNAMIC_CATALOG_DIR", "CLAUDISH_DYNAMIC_CATALOG_KEY"]) {
          expect(seen[name]).toContain(`${tmpdir()}/claudish-test-home-`.replace("//", "/"));
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 20_000);
  }
});
