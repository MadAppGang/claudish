#!/usr/bin/env bun
/**
 * The macOS test gate, run on a Mac before a release tag:
 *
 *   bun run test:macos             # run every step, then print a summary
 *   bun run test:macos --dry-run   # resolve the Buns and magmux, print the steps, run nothing
 *
 * It runs what test.yml's dispatched macOS jobs run, which no pull request runs any more:
 *
 *  1. the hermetic pane and rest groups (`ci-tests.ts --run pane@1/6,…,pane@6/6,rest`, the three
 *     `hermetic` runners' slices in one call), under the Bun the `hermetic` job pins;
 *  2. the macos-bridge tests and `scripts/*.test.ts`, under the same Bun;
 *  3. the blind hook tests and the Antigravity HTTP client tests, under the Bun the
 *     `blind-hooks` job pins (two blind tests fail on 1.3.10 because of bugs in Bun's test
 *     client).
 *
 * The Bun versions are READ from test.yml, never copied here: a gate on a different Bun than CI
 * proves something else (pane suites passed on 1.4.0 and failed 118 tests on 1.3.10). Each pinned
 * Bun comes from `bunx bun@<version>` and is first on PATH for its steps.
 *
 * Every step runs under scripts/guard-real-config.ts, as `test:safe` does (a throwaway HOME, no
 * Keychain, no 1Password), with an environment built by allowlist: no provider key from the
 * developer's shell reaches it, so the credential-gated live tests skip as they do on a runner.
 *
 * The Mac needs magmux on the lookup path the pane suites use (`findMagmuxCandidates`): without
 * it they skip as "not checked" and the gate would be green on nothing, so this fails instead.
 * CI installs the version pinned in .github/magmux.env; a different local version is reported,
 * because that is not the magmux the release ships.
 *
 * Expect a long run: the pane slices run as seven concurrent processes. A red run on a loaded
 * machine is still red: rerun once the Mac is quiet.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findMagmuxCandidates } from "../packages/cli/src/launcher/magmux-binary.ts";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "packages", "cli");
const WORKFLOW = join(ROOT, ".github", "workflows", "test.yml");
const MAGMUX_ENV = join(ROOT, ".github", "magmux.env");
const PANE_LAUNCH = join(CLI, "src", "pane", "pane-launch.ts");

/** The suites of test.yml's three `hermetic` runners. */
export const HERMETIC_RUNS = "pane@1/6,pane@2/6,pane@3/6,pane@4/6,pane@5/6,pane@6/6,rest";

/** The `bun-version: "x.y.z"` of one job in test.yml, or undefined. */
export function bunPinOf(workflow: string, job: string): string | undefined {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${job}:`);
  if (start === -1) return undefined;
  for (const line of lines.slice(start + 1)) {
    // The next key at the jobs' indent ends the job; a comment at that indent does not.
    if (/^ {2}[^\s#]/.test(line)) break;
    const pin = line.match(/^\s*bun-version:\s*"(\d+\.\d+\.\d+)"\s*$/);
    if (pin) return pin[1];
  }
  return undefined;
}

/** -1, 0 or 1 as `a` is older than, equal to or newer than `b` (dotted numbers). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

interface Step {
  name: string;
  bun: string;
  cwd: string;
  args: string[];
}

function fail(message: string): never {
  console.error(`[test:macos] ${message}`);
  process.exit(1);
}

/** The executable of `bun@<version>`, fetched by bunx, linked as `bun` into a directory of its own. */
function pinnedBun(version: string): { exe: string; dir: string } {
  const r = spawnSync("bunx", [`bun@${version}`, "-e", "console.log(process.execPath)"], {
    encoding: "utf8",
    env: { ...process.env },
  });
  const exe = r.stdout?.trim().split("\n").pop() ?? "";
  if (r.status !== 0 || !existsSync(exe)) {
    fail(`could not get Bun ${version} with bunx:\n${r.stderr ?? ""}`);
  }
  const dir = join(tmpdir(), `claudish-test-macos-bun-${version}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  symlinkSync(exe, join(dir, "bun"));
  return { exe, dir };
}

function magmuxVersion(path: string): string | undefined {
  const r = spawnSync(path, ["--version"], { encoding: "utf8", env: { ...process.env } });
  return r.stdout?.match(/(\d+\.\d+\.\d+)/)?.[1];
}

function checkMagmux(): string {
  const magmux = findMagmuxCandidates()[0];
  if (!magmux) {
    fail(
      "magmux not found: the pane suites would skip as not checked. Install it:\n" +
        "  brew install MadAppGang/tap/magmux"
    );
  }
  const have = magmuxVersion(magmux);
  const min = readFileSync(PANE_LAUNCH, "utf8").match(
    /^export const MIN_MAGMUX_VERSION = "(.*)";$/m
  )?.[1];
  const pin = readFileSync(MAGMUX_ENV, "utf8")
    .match(/^MAGMUX_TAG=v?(\S+)$/m)?.[1]
    ?.trim();
  if (!have) fail(`${magmux} --version printed no version`);
  if (min && compareVersions(have, min) < 0) {
    fail(`${magmux} is magmux ${have}; the pane suites need >= ${min}`);
  }
  if (pin && have !== pin) {
    console.warn(
      `[test:macos] WARNING: ${magmux} is magmux ${have}; CI and the release use ${pin} (.github/magmux.env)`
    );
  }
  return `${magmux} (${have})`;
}

function stepEnv(binDir: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    USER: process.env.USER ?? "test",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "test",
    HOME: process.env.HOME ?? tmpdir(),
    LANG: process.env.LANG ?? "en_US.UTF-8",
    SHELL: process.env.SHELL ?? "/bin/zsh",
    TERM: process.env.TERM ?? "xterm-256color",
    CLAUDISH_SKIP_LIVE_E2E: "1",
    CLAUDISH_DISABLE_CATALOG_WARM: "1",
  };
  return env;
}

/** How a step's process ended: an exit code, or the signal that ended it. */
export interface StepResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface RunningStep {
  exited: Promise<StepResult>;
  /** Sends `sig` to the step's whole process group: the guard, every Bun under it, their children. */
  signal(sig: NodeJS.Signals): void;
}

/**
 * Starts `argv` as the leader of a process group of its own (`detached`), so a signal the gate
 * forwards reaches every process of the step and not only the first. The terminal's Ctrl-C goes
 * to the gate alone, which forwards it. Stdin is closed: no step reads it.
 */
export function startStep(
  argv: string[],
  opts: { cwd: string; env: Record<string, string> }
): RunningStep {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error("startStep: empty argv");
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
  const exited = new Promise<StepResult>((resolve) => {
    child.on("error", (err) => {
      console.error(`[test:macos] could not start ${cmd}: ${err.message}`);
      resolve({ code: 127, signal: null });
    });
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    exited,
    signal(sig) {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        /* the group has already exited */
      }
    },
  };
}

/** The exit code a step counts as: its own, or 128 + the number of the signal that ended it. */
function codeOf(result: StepResult): number {
  if (result.signal) return 128 + (osConstants.signals[result.signal] ?? 0);
  return result.code ?? 1;
}

/**
 * Runs the steps in order. A step ended by a signal ends the run: the gate was interrupted, or a
 * child was killed, and every later step would be red for the same reason or tell nothing.
 */
export async function runSteps<S extends { name: string }>(
  steps: readonly S[],
  run: (step: S) => Promise<StepResult>
): Promise<{ name: string; code: number }[]> {
  const results: { name: string; code: number }[] = [];
  for (const step of steps) {
    const result = await run(step);
    const code = codeOf(result);
    results.push({ name: step.name, code });
    if (result.signal) break;
  }
  return results;
}

if (import.meta.main) {
  const dryRun = process.argv.includes("--dry-run");
  if (process.platform !== "darwin") fail(`runs on macOS only, not ${process.platform}`);

  const workflow = readFileSync(WORKFLOW, "utf8");
  const hermeticPin = bunPinOf(workflow, "hermetic");
  const blindPin = bunPinOf(workflow, "blind-hooks");
  if (!hermeticPin || !blindPin) {
    fail(`no bun-version pin for the hermetic or blind-hooks job in ${WORKFLOW}`);
  }

  const magmux = checkMagmux();
  const hermeticBun = pinnedBun(hermeticPin);
  const blindBun = pinnedBun(blindPin);
  const scriptTests = [...new Bun.Glob("scripts/*.test.ts").scanSync({ cwd: ROOT })]
    .sort()
    .map((f) => `./${f}`);

  const groups: { bin: { exe: string; dir: string }; steps: Step[] }[] = [
    {
      bin: hermeticBun,
      steps: [
        {
          name: `hermetic ${HERMETIC_RUNS}`,
          bun: hermeticPin,
          cwd: CLI,
          args: [
            hermeticBun.exe,
            "scripts/ci-tests.ts",
            "--run",
            HERMETIC_RUNS,
            "--",
            "--max-concurrency=8",
          ],
        },
        {
          name: "macos-bridge tests",
          bun: hermeticPin,
          cwd: ROOT,
          args: [hermeticBun.exe, "run", "--cwd", "packages/macos-bridge", "test"],
        },
        {
          name: "script tests",
          bun: hermeticPin,
          cwd: ROOT,
          args: [hermeticBun.exe, "test", ...scriptTests],
        },
      ],
    },
    {
      bin: blindBun,
      steps: [
        {
          name: "blind hook tests",
          bun: blindPin,
          cwd: CLI,
          args: [blindBun.exe, "test", "src/hooks/blind"],
        },
        {
          name: "Antigravity HTTP client tests",
          bun: blindPin,
          cwd: CLI,
          args: [blindBun.exe, "test", "src/providers/transport/antigravity-fetch.test.ts"],
        },
      ],
    },
  ];

  console.log(`[test:macos] magmux: ${magmux}`);
  console.log(`[test:macos] bun ${hermeticPin}: ${hermeticBun.exe}`);
  console.log(`[test:macos] bun ${blindPin}: ${blindBun.exe}`);

  if (dryRun) {
    for (const { steps } of groups)
      for (const s of steps) console.log(`[test:macos] would run (${s.cwd}): ${s.args.join(" ")}`);
    process.exit(0);
  }

  // A signal to the gate goes to the running step's process group; the gate waits for that
  // step to exit (the guard restores what it guards), then stops with no further step.
  let interrupted: NodeJS.Signals | null = null;
  let running: RunningStep | null = null;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      interrupted ??= sig;
      running?.signal(sig);
    });
  }
  const binOf = new Map(
    groups.flatMap(({ bin, steps }) => steps.map((s) => [s, bin.dir] as const))
  );
  const results = await runSteps(
    groups.flatMap((g) => g.steps),
    async (step) => {
      console.log(`\n[test:macos] ▶ ${step.name}  (bun ${step.bun}, ${step.cwd})`);
      const started = performance.now();
      running = startStep(
        [process.execPath, join(ROOT, "scripts", "guard-real-config.ts"), "--", ...step.args],
        { cwd: step.cwd, env: stepEnv(binOf.get(step) ?? "") }
      );
      const result = await running.exited;
      running = null;
      const secs = ((performance.now() - started) / 1000).toFixed(0);
      const how = result.signal ? `signal ${result.signal}` : `exit ${result.code}`;
      console.log(`[test:macos] ◀ ${step.name}: ${how}, ${secs} s`);
      return interrupted ? { code: result.code, signal: result.signal ?? interrupted } : result;
    }
  );

  console.log("\n[test:macos] summary");
  for (const r of results) console.log(`  ${r.code === 0 ? "PASS" : "FAIL"}  ${r.name}`);
  if (interrupted) {
    console.log(`[test:macos] stopped by ${interrupted}: do not tag.`);
    process.exit(128 + (osConstants.signals[interrupted] ?? 0));
  }
  const red =
    results.length < groups.flatMap((g) => g.steps).length || results.some((r) => r.code !== 0);
  if (red)
    console.log("[test:macos] RED: do not tag. Rerun once the Mac is quiet if it was loaded.");
  process.exit(red ? 1 : 0);
}
