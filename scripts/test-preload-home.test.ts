/**
 * The preload's home guard (MTL-372 review round 4, R4-0).
 *
 * A plain `bun test` once ran the legacy Codex file move against the developer's real
 * home. Each case here spawns `bun test` on a check file, from each directory that
 * carries a bunfig.toml, and asserts what that file sees once the preload has run.
 *
 * The inherited `HOME` is a path that does not exist and is not under a temporary
 * directory: it stands in for a real home without ever naming or touching one.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const ROOTS: Array<[string, string]> = [
  ["repo root", repoRoot],
  ["packages/cli", resolve(repoRoot, "packages/cli")],
  ["packages/macos-bridge", resolve(repoRoot, "packages/macos-bridge")],
];

interface Seen {
  envHome: string | undefined;
  named: string;
  moduleConst: string;
  namespace: string;
  required: string;
  userInfo: string;
  disableKeychain: string | undefined;
  disableOp: string | undefined;
  disableCatalogWarm: string | undefined;
}

/** Run a check file under `bun test` and return what it saw. */
function seenUnderPreload(cwd: string, env: Record<string, string>): Seen {
  const dir = mkdtempSync(resolve(tmpdir(), "r4-preload-home-"));
  try {
    const constModule = resolve(dir, "home-const.ts");
    writeFileSync(
      constModule,
      'import { homedir } from "node:os";\nexport const HOME_AT_LOAD = homedir();\n'
    );
    const outPath = resolve(dir, "seen.json");
    // Outside the tree and without a .test. name: only this explicit run discovers it.
    const checkPath = resolve(dir, "home-check.ts");
    writeFileSync(
      checkPath,
      `
      import { test } from "bun:test";
      import { writeFileSync } from "node:fs";
      import { createRequire } from "node:module";
      import * as os from "node:os";
      import { homedir, userInfo } from "node:os";
      import { HOME_AT_LOAD } from ${JSON.stringify(constModule)};
      test("record", () => {
        writeFileSync(${JSON.stringify(outPath)}, JSON.stringify({
          envHome: process.env.HOME,
          named: homedir(),
          moduleConst: HOME_AT_LOAD,
          namespace: os.homedir(),
          required: createRequire(import.meta.url)("os").homedir(),
          userInfo: userInfo().homedir,
          disableKeychain: process.env.CLAUDISH_DISABLE_KEYCHAIN,
          disableOp: process.env.CLAUDISH_DISABLE_OP,
          disableCatalogWarm: process.env.CLAUDISH_DISABLE_CATALOG_WARM,
        }));
      });
    `
    );
    const child = Bun.spawnSync([process.execPath, "test", checkPath], {
      cwd,
      // Match the parent assertions without relying on inherited temp settings.
      env: { PATH: process.env.PATH ?? "", ...env, TMPDIR: tmpdir() },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    });
    const output = child.stdout.toString() + child.stderr.toString();
    expect({ exitCode: child.exitCode, output }).toEqual({
      exitCode: 0,
      output: expect.stringContaining("1 pass"),
    });
    return JSON.parse(readFileSync(outPath, "utf8")) as Seen;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function homesOf(seen: Seen): string[] {
  return [
    seen.envHome ?? "",
    seen.named,
    seen.moduleConst,
    seen.namespace,
    seen.required,
    seen.userInfo,
  ];
}

describe("R4-0 the test preload isolates HOME and the Keychain", () => {
  for (const [label, cwd] of ROOTS) {
    test(`a non-temporary inherited HOME is replaced everywhere (${label})`, () => {
      const standIn = `/nonexistent-claudish-real-home-${process.pid}`;
      const seen = seenUnderPreload(cwd, { HOME: standIn });
      const homes = homesOf(seen);
      for (const home of homes) expect(home).not.toBe(standIn);
      // One home, a fresh temporary directory, seen by every route to it.
      expect(new Set(homes).size).toBe(1);
      expect(seen.envHome).toContain("claudish-test-home-");
      // The three prevention flags `test:safe` sets.
      expect(seen.disableKeychain).toBe("1");
      expect(seen.disableOp).toBe("1");
      expect(seen.disableCatalogWarm).toBe("1");
    }, 20_000);
  }

  test("a temporary HOME a parent test chose is kept, and follows to os.homedir()", () => {
    const parentHome = mkdtempSync(resolve(tmpdir(), "r4-parent-home-"));
    try {
      const seen = seenUnderPreload(repoRoot, { HOME: parentHome });
      for (const home of homesOf(seen)) expect(home).toBe(parentHome);
    } finally {
      rmSync(parentHome, { recursive: true, force: true });
    }
  }, 20_000);

  for (const [label, cwd] of ROOTS) {
    test(`creates a fresh home when inherited HOME is unset (${label})`, () => {
      const seen = seenUnderPreload(cwd, {});

      expect(new Set(homesOf(seen)).size).toBe(1);
      for (const home of homesOf(seen)) {
        expect(dirname(home)).toBe(resolve(tmpdir()));
        expect(basename(home)).toStartWith("claudish-test-home-");
      }
    }, 20_000);

    test(`replaces the marked run HOME with a fresh home for every process (${label})`, () => {
      const runHome = mkdtempSync(resolve(tmpdir(), "claudish-guard-home-"));
      try {
        const env = { HOME: runHome, CLAUDISH_GUARD_RUN_HOME: runHome };
        const first = seenUnderPreload(cwd, env);
        const second = seenUnderPreload(cwd, env);

        for (const seen of [first, second]) {
          expect(new Set(homesOf(seen)).size).toBe(1);
          for (const home of homesOf(seen)) {
            expect(home).not.toBe(runHome);
            expect(dirname(home)).toBe(resolve(tmpdir()));
            expect(basename(home)).toStartWith("claudish-test-home-");
          }
          expect(seen.disableKeychain).toBe("1");
          expect(seen.disableOp).toBe("1");
          expect(seen.disableCatalogWarm).toBe("1");
        }
        expect(first.envHome).not.toBe(second.envHome);
      } finally {
        rmSync(runHome, { recursive: true, force: true });
      }
    }, 40_000);

    test(`preserves a different temporary HOME when the run-home marker is set (${label})`, () => {
      const parentHome = mkdtempSync(resolve(tmpdir(), "preload-parent-home-"));
      const runHome = mkdtempSync(resolve(tmpdir(), "claudish-guard-home-"));
      try {
        const seen = seenUnderPreload(cwd, {
          HOME: parentHome,
          CLAUDISH_GUARD_RUN_HOME: runHome,
        });

        for (const home of homesOf(seen)) expect(home).toBe(parentHome);
      } finally {
        rmSync(parentHome, { recursive: true, force: true });
        rmSync(runHome, { recursive: true, force: true });
      }
    }, 20_000);
  }

  test("an explicit prevention flag is left as the environment states it", () => {
    const seen = seenUnderPreload(repoRoot, {
      HOME: `/nonexistent-claudish-real-home-${process.pid}`,
      CLAUDISH_DISABLE_KEYCHAIN: "0",
      CLAUDISH_DISABLE_CATALOG_WARM: "0",
    });
    expect(seen.disableKeychain).toBe("0");
    expect(seen.disableCatalogWarm).toBe("0");
    expect(seen.disableOp).toBe("1");
  }, 20_000);
});
