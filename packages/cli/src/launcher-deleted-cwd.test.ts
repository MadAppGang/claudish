/**
 * The npm launcher started from a working directory deleted under the shell.
 *
 * Each row copies the real launcher into a throwaway package whose `dist/index.js` is a
 * stub printing its own cwd, argv and two environment values, then starts it through
 * `/bin/sh`, which enters a directory, removes it, and execs the runtime there. Only an
 * argument list that is exactly one of the commands needing no project directory starts
 * the child in HOME; every other argument list is refused with one line.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dir, "..", "bin");
const REFUSAL =
  "[claudish] the current directory no longer exists (it was deleted or moved). cd to a folder that exists and run claudish again.";

const root = realpathSync(mkdtempSync(join(tmpdir(), "claudish-deleted-cwd-")));
const home = join(root, "home");
const pkg = join(root, "pkg");
const launcher = join(pkg, "bin", "claudish.cjs");
mkdirSync(home);
mkdirSync(join(pkg, "bin"), { recursive: true });
mkdirSync(join(pkg, "dist"));
copyFileSync(join(BIN, "claudish.cjs"), launcher);
copyFileSync(join(BIN, "env-files.cjs"), join(pkg, "bin", "env-files.cjs"));
writeFileSync(
  join(pkg, "dist", "index.js"),
  [
    "console.log(JSON.stringify({",
    "  cwd: process.cwd(),",
    "  argv: process.argv.slice(2),",
    "  shared: process.env.CLAUDISH_TEST_SHARED ?? null,",
    "  dropped: process.env.CLAUDISH_LAUNCHER_DROPPED ?? null,",
    "}));",
    "",
  ].join("\n")
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ENV = { PATH: process.env.PATH ?? "", HOME: home, NO_COLOR: "1" };
const NODE = Bun.which("node", { PATH: ENV.PATH });
const RUNTIMES: [string, string | null][] = [
  ["node", NODE],
  ["bun", process.execPath],
];

let goneCount = 0;
/** Runs `argv` through `/bin/sh` after it has entered a fresh directory and removed it. */
function spawnInDeletedCwd(argv: string[], env: Record<string, string>) {
  const gone = join(root, `gone-${goneCount++}`);
  mkdirSync(gone);
  const script = 'cd "$1" && rmdir "$1" && shift && exec "$@"';
  const proc = Bun.spawnSync(["/bin/sh", "-c", script, "sh", gone, ...argv], {
    cwd: root,
    env,
    stdin: "ignore",
    timeout: 10_000,
  });
  return {
    code: proc.exitCode,
    signal: proc.signalCode ?? null,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function runFromDeletedCwd(runtime: string, args: string[], env: Record<string, string> = ENV) {
  return spawnInDeletedCwd([runtime, launcher, ...args], env);
}

/**
 * Some Bun releases refuse to start at all in a deleted working directory: the runtime
 * prints this line and exits 1 before any script code runs, so the launcher never sees
 * the arguments. Others start and leave the case to the launcher.
 */
const BUN_STARTUP_REFUSAL = "The current working directory was deleted";
const bunStartsInDeletedCwd = spawnInDeletedCwd([process.execPath, "-e", "0"], ENV).code === 0;

const CWD_FREE: string[][] = [["--version"], ["--help"], ["-h"], ["update"]];
const REFUSED: string[][] = [
  ["-v"],
  ["config"],
  ["--model", "x", "hi"],
  [],
  ["--help", "hooks", "list"],
  ["-h", "init", "--local"],
  ["--version", "--config", "./file.json"],
  ["--help", "--mcp"],
  ["update", "--force"],
  ["-y", "update"],
];

/**
 * A home whose `.env` sets a name the shell also sets. Bun started from a deleted
 * directory loads no env file, so the child must see the shell's value and no
 * dropped-names marker; probing this home for env files would remove the shell's value.
 */
const dotenvHome = join(root, "dotenv-home");
mkdirSync(dotenvHome);
writeFileSync(join(dotenvHome, ".env"), "CLAUDISH_TEST_SHARED=from-dotenv\n");
const DOTENV_ENV = { ...ENV, HOME: dotenvHome, CLAUDISH_TEST_SHARED: "from-shell" };

type ChildReport = { cwd: string; argv: string[]; shared: string | null; dropped: string | null };

describe.skipIf(process.platform === "win32")("launcher from a deleted working directory", () => {
  for (const [name, runtime] of RUNTIMES) {
    describe.skipIf(runtime === null)(`under ${name}`, () => {
      if (name === "bun" && !bunStartsInDeletedCwd) {
        test.each([...CWD_FREE, ...REFUSED].map((args) => [args]))(
          "%p is refused by Bun's own startup with one line before the launcher runs",
          (args) => {
            const r = runFromDeletedCwd(runtime as string, args);
            expect(r.signal).toBeNull();
            expect(r.code).toBe(1);
            expect(r.stdout).toBe("");
            expect(r.stderr).toContain(BUN_STARTUP_REFUSAL);
            expect(r.stderr.trimEnd().split("\n")).toHaveLength(1);
          }
        );

        test("a HOME with a .env does not change Bun's own startup refusal", () => {
          const r = runFromDeletedCwd(runtime as string, ["--version"], DOTENV_ENV);
          expect(r.signal).toBeNull();
          expect(r.code).toBe(1);
          expect(r.stdout).toBe("");
          expect(r.stderr).toContain(BUN_STARTUP_REFUSAL);
        });
      } else {
        test.each(CWD_FREE.map((args) => [args]))(
          "%p starts the child in HOME with argv unchanged",
          (args) => {
            const r = runFromDeletedCwd(runtime as string, args);
            expect(r.signal).toBeNull();
            expect(r.stderr).not.toContain("uv_cwd");
            expect(r.code).toBe(0);
            const out = JSON.parse(r.stdout) as ChildReport;
            expect(realpathSync(out.cwd)).toBe(realpathSync(home));
            expect(out.argv).toEqual(args);
          }
        );

        test.each(REFUSED.map((args) => [args]))(
          "%p is refused by the launcher with one line",
          (args) => {
            const r = runFromDeletedCwd(runtime as string, args);
            expect(r.signal).toBeNull();
            expect(r.stderr).not.toContain("uv_cwd");
            expect(r.stderr).toBe(`${REFUSAL}\n`);
            expect(r.stdout).toBe("");
            expect(r.code).toBe(1);
          }
        );

        test.skipIf(name !== "bun")(
          "a Bun started without --no-env-file keeps the shell's values over HOME's .env",
          () => {
            const r = runFromDeletedCwd(runtime as string, ["--version"], DOTENV_ENV);
            expect(r.signal).toBeNull();
            expect(r.stderr).toBe("");
            expect(r.code).toBe(0);
            const out = JSON.parse(r.stdout) as ChildReport;
            expect(realpathSync(out.cwd)).toBe(realpathSync(dotenvHome));
            expect(out.shared).toBe("from-shell");
            expect(out.dropped).toBeNull();
          }
        );
      }

      test("from an existing directory the child keeps that directory", () => {
        const here = mkdtempSync(join(root, "here-"));
        const proc = Bun.spawnSync([runtime as string, launcher, "--version"], {
          cwd: here,
          env: ENV,
          stdin: "ignore",
          timeout: 10_000,
        });
        expect(proc.signalCode ?? null).toBeNull();
        expect(proc.exitCode).toBe(0);
        const out = JSON.parse(proc.stdout.toString()) as { cwd: string };
        expect(realpathSync(out.cwd)).toBe(realpathSync(here));
      });
    });
  }
});
