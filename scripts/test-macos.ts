#!/usr/bin/env bun
/**
 * The macOS test gate, run on a Mac before a release tag:
 *
 *   bun run test:macos             # run every step, then print a summary
 *   bun run test:macos --dry-run   # print what a run would fetch and run; fetch and run nothing
 *
 * It runs what test.yml's dispatched macOS jobs run, which no pull request runs any more:
 *
 *  0. `bun run build:cli`, so the tests that start packages/cli/dist test this commit (a failed
 *     build stops the gate);
 *  1. the hermetic pane and rest groups (`ci-tests.ts --run pane@1/6,…,pane@6/6,rest`, the three
 *     `hermetic` runners' slices in one call), under the Bun the `hermetic` job pins;
 *  2. the macos-bridge tests and `scripts/*.test.ts`, under the same Bun;
 *  3. the blind hook tests and the Antigravity HTTP client tests, under the Bun the
 *     `blind-hooks` job pins (two blind tests fail on 1.3.10 because of bugs in Bun's test
 *     client);
 *  4. the S1 hook loading tests (`packages/cli/src/hooks/s1-probe/`, test.yml's hooks-loading
 *     macOS rows) under the Bun release.yml builds the binaries with (`latest`).
 *
 * The Bun versions are READ from test.yml, never copied here: a gate on a different Bun than CI
 * proves something else (pane suites passed on 1.4.0 and failed 118 tests on 1.3.10). Each pinned
 * Bun comes from `bunx bun@<version>` and is first on PATH for its steps. Everything a run
 * fetches goes into one `mkdtemp` directory of its own, removed when the run exits, so two runs
 * (a `--dry-run` beside a real run included) never touch each other's files.
 *
 * Every step runs under scripts/guard-real-config.ts, as `test:safe` does (a throwaway HOME, no
 * Keychain, no 1Password), with an environment built by allowlist: no provider key from the
 * developer's shell reaches it, so the credential-gated live tests skip as they do on a runner.
 * Every Bun the gate starts runs with `--no-env-file`, so a `.env` in a step's directory cannot
 * put a removed key back. Each step is a process group of its own: SIGINT, SIGTERM or SIGHUP to the gate goes to that
 * group, and the gate stops once the step has exited.
 *
 * The pane suites run against the magmux the release ships: the gate downloads the release
 * pinned in .github/magmux.env with `gh` (signed in), checks the pinned SHA-256 and the version,
 * and puts it first on every step's PATH, where the pane suites' lookup (`findMagmuxCandidates`)
 * finds it. The Mac's own magmux is never used or changed. Anything it cannot read or verify
 * stops the gate.
 *
 * Expect a long run: the pane slices run as seven concurrent processes. A red run on a loaded
 * machine is still red: rerun once the Mac is quiet.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { findMagmuxCandidates } from "../packages/cli/src/launcher/magmux-binary.ts";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "packages", "cli");
const WORKFLOW = join(ROOT, ".github", "workflows", "test.yml");
const RELEASE_WORKFLOW = join(ROOT, ".github", "workflows", "release.yml");
const MAGMUX_ENV = join(ROOT, ".github", "magmux.env");
const PANE_LAUNCH = join(CLI, "src", "pane", "pane-launch.ts");

/** The suites of test.yml's three `hermetic` runners. */
export const HERMETIC_RUNS = "pane@1/6,pane@2/6,pane@3/6,pane@4/6,pane@5/6,pane@6/6,rest";

/** The first `bun-version:` of one job in a workflow (`latest`, `1.3.10`), or undefined. */
export function bunVersionOf(workflow: string, job: string): string | undefined {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${job}:`);
  if (start === -1) return undefined;
  for (const line of lines.slice(start + 1)) {
    // The next key at the jobs' indent ends the job; a comment at that indent does not.
    if (/^ {2}[^\s#]/.test(line)) break;
    const version = line.match(/^\s*bun-version:\s*("?)([^"\s#]+)\1\s*(#.*)?$/);
    if (version) return version[2];
  }
  return undefined;
}

/** The exact `bun-version: "x.y.z"` one job in test.yml pins, or undefined. */
export function bunPinOf(workflow: string, job: string): string | undefined {
  const version = bunVersionOf(workflow, job);
  return version && /^\d+\.\d+\.\d+$/.test(version) ? version : undefined;
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

/**
 * On every Bun the gate starts. Bun loads `.env` (and `.env.local`, `.env.<NODE_ENV>`) from its
 * working directory by default, which would put a key the allowlisted environment removed back
 * into a step. The flag reaches only the Bun it is given to: a `bun run <script>` starts a second
 * Bun that loads them again, so test steps start `bun test` directly.
 */
export const NO_ENV_FILE = "--no-env-file";

const GUARD = join(ROOT, "scripts", "guard-real-config.ts");

/** How the gate starts a step: under the guard, which hands its own environment to the step. */
export function launchArgv(step: Step, guard: string = GUARD): string[] {
  return [process.execPath, NO_ENV_FILE, guard, "--", ...step.args];
}

export interface Step {
  name: string;
  cwd: string;
  args: string[];
  /** A failure here makes every later step meaningless, so the gate stops. */
  stopOnFailure?: boolean;
}

/** One Bun the gate runs steps under: the version asked of bunx, and its executable. */
export interface PlannedBun {
  version: string;
  exe: string;
}

export interface StepGroup {
  bun: PlannedBun;
  steps: Step[];
}

/**
 * Every step, grouped by the Bun it runs under. Pure, so `--dry-run` prints the steps a run
 * runs, with placeholders for the executables it has not fetched.
 */
export function planSteps(p: {
  root: string;
  hermetic: PlannedBun;
  blind: PlannedBun;
  release: PlannedBun;
  scriptTests: string[];
}): StepGroup[] {
  const cli = join(p.root, "packages", "cli");
  return [
    {
      bun: p.hermetic,
      steps: [
        {
          // Tests that start dist/ (host-pid.contract.test.ts runs `node bin/claudish.cjs`)
          // build it only when it is missing, so a Mac's dist/ from an older commit would be
          // what they test. The build reads no credential, so its nested Buns may load .env.
          name: "build:cli",
          cwd: p.root,
          args: [p.hermetic.exe, NO_ENV_FILE, "run", "build:cli"],
          stopOnFailure: true,
        },
        {
          name: `hermetic ${HERMETIC_RUNS}`,
          cwd: cli,
          args: [
            p.hermetic.exe,
            NO_ENV_FILE,
            "scripts/ci-tests.ts",
            "--run",
            HERMETIC_RUNS,
            "--",
            NO_ENV_FILE,
            "--max-concurrency=8",
          ],
        },
        {
          // The package's `test` script is `bun test`, started here directly.
          name: "macos-bridge tests",
          cwd: join(p.root, "packages", "macos-bridge"),
          args: [p.hermetic.exe, NO_ENV_FILE, "test"],
        },
        {
          name: "script tests",
          cwd: p.root,
          args: [p.hermetic.exe, NO_ENV_FILE, "test", ...p.scriptTests],
        },
      ],
    },
    {
      bun: p.blind,
      steps: [
        {
          name: "blind hook tests",
          cwd: cli,
          args: [p.blind.exe, NO_ENV_FILE, "test", "src/hooks/blind"],
        },
        {
          name: "Antigravity HTTP client tests",
          cwd: cli,
          args: [
            p.blind.exe,
            NO_ENV_FILE,
            "test",
            "src/providers/transport/antigravity-fetch.test.ts",
          ],
        },
      ],
    },
    {
      bun: p.release,
      steps: [
        {
          // test.yml's hooks-loading macOS rows: a user hook module loads from a dist bundle
          // and a compiled binary built by the Bun release.yml builds with.
          name: "S1 hook loading",
          cwd: p.root,
          args: [p.release.exe, NO_ENV_FILE, "test", "packages/cli/src/hooks/s1-probe/"],
        },
      ],
    },
  ];
}

function fail(message: string): never {
  console.error(`[test:macos] ${message}`);
  process.exit(1);
}

/**
 * The executable of `bun@<version>`, fetched by bunx, linked as `bun` into `bun-<version>` under
 * this run's own directory.
 */
function pinnedBun(
  version: string,
  runDir: string
): { exe: string; dir: string; resolved: string } {
  const r = spawnSync(
    "bunx",
    [`bun@${version}`, NO_ENV_FILE, "-e", 'console.log(Bun.version + "\\t" + process.execPath)'],
    {
      cwd: runDir,
      encoding: "utf8",
      env: { ...process.env },
    }
  );
  const [resolved = "", exe = ""] = (r.stdout?.trim().split("\n").pop() ?? "").split("\t");
  if (r.status !== 0 || !existsSync(exe)) {
    fail(`could not get Bun ${version} with bunx:\n${r.stderr ?? ""}`);
  }
  if (/^\d+\.\d+\.\d+$/.test(version) && resolved !== version) {
    fail(`bunx bun@${version} ran Bun ${resolved}`);
  }
  const dir = join(runDir, `bun-${version}`);
  mkdirSync(dir);
  symlinkSync(exe, join(dir, "bun"));
  return { exe, dir, resolved };
}

/** The magmux release .github/magmux.env pins, for one darwin arch. */
export interface MagmuxPin {
  tag: string;
  version: string;
  asset: string;
  sha256: string;
}

/**
 * The pinned magmux, read the way release.yml reads it, failing closed: a value that cannot be
 * read, a release off the 0.x line or one below `MIN_MAGMUX_VERSION` throws, never passes.
 */
export function parseMagmuxPin(
  magmuxEnv: string,
  paneLaunch: string,
  arch: "arm64" | "amd64"
): MagmuxPin {
  const min = paneLaunch.match(/^export const MIN_MAGMUX_VERSION = "(\d+\.\d+\.\d+)";$/m)?.[1];
  if (!min) throw new Error('no MIN_MAGMUX_VERSION = "x.y.z" in pane-launch.ts');
  const tag = magmuxEnv.match(/^MAGMUX_TAG=(v\d+\.\d+\.\d+)$/m)?.[1];
  if (!tag) throw new Error("no MAGMUX_TAG=v<x.y.z> in .github/magmux.env");
  const key = `MAGMUX_SHA256_darwin_${arch}`;
  const sha256 = magmuxEnv.match(new RegExp(`^${key}=([0-9a-f]{64})$`, "m"))?.[1];
  if (!sha256) throw new Error(`no 64-hex-digit ${key} in .github/magmux.env`);
  const version = tag.slice(1);
  if (!/^0\./.test(version)) throw new Error(`pinned magmux ${tag} is not a 0.x release`);
  if (compareVersions(version, min) < 0) {
    throw new Error(`pinned magmux ${tag} is older than MIN_MAGMUX_VERSION ${min}`);
  }
  return { tag, version, asset: `magmux_darwin_${arch}.tar.gz`, sha256 };
}

/** Throws unless `file`'s SHA-256 is `want`: the PINNED sum, never the release's checksums.txt. */
export function verifySha256(file: string, want: string): void {
  const have = new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex");
  if (have !== want) {
    throw new Error(`sha256 of ${file} is ${have}; .github/magmux.env pins ${want}`);
  }
}

export function magmuxPinOfThisMac(): MagmuxPin {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : undefined;
  if (!arch) fail(`no magmux darwin asset for arch ${process.arch}`);
  try {
    return parseMagmuxPin(
      readFileSync(MAGMUX_ENV, "utf8"),
      readFileSync(PANE_LAUNCH, "utf8"),
      arch
    );
  } catch (err) {
    fail((err as Error).message);
  }
}

/**
 * Installs the pinned magmux into `magmux/` under this run's directory, as
 * .github/actions/install-magmux does on a runner: `gh release download` of the pinned tag's
 * asset, the pinned SHA-256, untar, and `--version` must print the pinned version. The
 * directory goes first on every step's PATH. The Mac's own magmux (Homebrew) is never used
 * or changed. Needs `gh` signed in.
 */
export function installPinnedMagmux(pin: MagmuxPin, runDir: string): string {
  const download = join(runDir, "magmux-download");
  const binDir = join(runDir, "magmux");
  mkdirSync(download);
  mkdirSync(binDir);
  const gh = spawnSync(
    "gh",
    [
      "release",
      "download",
      pin.tag,
      "--repo",
      "MadAppGang/magmux",
      "--pattern",
      pin.asset,
      "--dir",
      download,
    ],
    { cwd: runDir, encoding: "utf8", env: { ...process.env } }
  );
  if (gh.status !== 0) {
    fail(
      `gh release download ${pin.tag} ${pin.asset} from MadAppGang/magmux failed (is gh signed in? gh auth login):\n${gh.stderr ?? gh.error?.message ?? ""}`
    );
  }
  const archive = join(download, pin.asset);
  try {
    verifySha256(archive, pin.sha256);
  } catch (err) {
    fail((err as Error).message);
  }
  const tar = spawnSync("tar", ["xzf", archive, "-C", binDir], {
    encoding: "utf8",
    env: { ...process.env },
  });
  const exe = join(binDir, "magmux");
  if (tar.status !== 0 || !existsSync(exe)) {
    fail(`could not unpack magmux from ${archive}:\n${tar.stderr ?? ""}`);
  }
  chmodSync(exe, 0o755);
  const version = spawnSync(exe, ["--version"], { encoding: "utf8", env: { ...process.env } });
  const have = version.stdout?.match(/(\d+\.\d+\.\d+)/)?.[1];
  if (version.status !== 0 || have !== pin.version) {
    fail(
      `${exe} --version printed ${JSON.stringify(version.stdout?.trim() ?? "")}, not ${pin.tag}`
    );
  }
  // The pane suites take the first candidate (bundled, npm package, then PATH); with the pinned
  // directory first on PATH that must be it, or they would test another magmux.
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDir}:${savedPath ?? ""}`;
  const first = findMagmuxCandidates()[0];
  process.env.PATH = savedPath;
  if (first !== exe) {
    fail(`the pane suites would use ${first}, not the pinned ${exe}: remove ${first}`);
  }
  return binDir;
}

function stepEnv(binDir: string, magmuxDir: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: `${binDir}:${magmuxDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
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
export async function runSteps<S extends { name: string; stopOnFailure?: boolean }>(
  steps: readonly S[],
  run: (step: S) => Promise<StepResult>
): Promise<{ name: string; code: number }[]> {
  const results: { name: string; code: number }[] = [];
  for (const step of steps) {
    const result = await run(step);
    const code = codeOf(result);
    results.push({ name: step.name, code });
    if (result.signal) break;
    if (code !== 0 && step.stopOnFailure) break;
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
  // The Bun the release binaries are built with (`latest`), as test.yml's hooks-loading uses.
  const releaseBunVersion = bunVersionOf(readFileSync(RELEASE_WORKFLOW, "utf8"), "build");
  if (!releaseBunVersion) fail(`no bun-version in the build job of ${RELEASE_WORKFLOW}`);
  const versions = [...new Set([hermeticPin, blindPin, releaseBunVersion])];
  const scriptTests = [...new Bun.Glob("scripts/*.test.ts").scanSync({ cwd: ROOT })]
    .sort()
    .map((f) => `./${f}`);
  const magmuxPin = magmuxPinOfThisMac();

  if (dryRun) {
    // Fetches nothing: the executables are placeholders for what a run would fetch.
    for (const version of versions)
      console.log(`[test:macos] would fetch bun@${version} with bunx into a new temp directory`);
    console.log(
      `[test:macos] would download magmux ${magmuxPin.tag} (${magmuxPin.asset}, sha256 ${magmuxPin.sha256}) with gh into a new temp directory, first on PATH`
    );
    const placeholder = (version: string) => ({ version, exe: `<bun@${version}>` });
    const plan = planSteps({
      root: ROOT,
      hermetic: placeholder(hermeticPin),
      blind: placeholder(blindPin),
      release: placeholder(releaseBunVersion),
      scriptTests,
    });
    for (const { steps } of plan)
      for (const s of steps) console.log(`[test:macos] would run (${s.cwd}): ${s.args.join(" ")}`);
    process.exit(0);
  }

  // Everything this run fetches lives under one directory of its own, removed when it exits.
  const runDir = mkdtempSync(join(tmpdir(), "claudish-test-macos-"));
  process.on("exit", () => rmSync(runDir, { recursive: true, force: true }));

  // A signal to the gate goes to the running step's process group; the gate waits for that
  // step to exit (the guard restores what it guards), then stops with no further step. Between
  // steps it exits at once.
  let interrupted: NodeJS.Signals | null = null;
  let running: RunningStep | null = null;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      interrupted ??= sig;
      if (running) running.signal(sig);
      else process.exit(128 + (osConstants.signals[sig] ?? 0));
    });
  }

  const magmuxDir = installPinnedMagmux(magmuxPin, runDir);
  const buns = new Map(versions.map((v) => [v, pinnedBun(v, runDir)] as const));
  const planned = (version: string) => ({ version, exe: buns.get(version)?.exe ?? "" });
  const groups = planSteps({
    root: ROOT,
    hermetic: planned(hermeticPin),
    blind: planned(blindPin),
    release: planned(releaseBunVersion),
    scriptTests,
  });
  const binDirOf = new Map([...buns].map(([v, bun]) => [v, bun.dir] as const));

  console.log(`[test:macos] magmux ${magmuxPin.tag}: ${join(magmuxDir, "magmux")}`);
  for (const [version, bun] of buns)
    console.log(`[test:macos] bun@${version}: Bun ${bun.resolved}, ${bun.exe}`);

  const steps = groups.flatMap(({ bun, steps }) => steps.map((step) => ({ ...step, bun })));
  const results = await runSteps(steps, async (step) => {
    console.log(`\n[test:macos] ▶ ${step.name}  (bun ${step.bun.version}, ${step.cwd})`);
    const started = performance.now();
    running = startStep(launchArgv(step), {
      cwd: step.cwd,
      env: stepEnv(binDirOf.get(step.bun.version) ?? "", magmuxDir),
    });
    const result = await running.exited;
    running = null;
    const secs = ((performance.now() - started) / 1000).toFixed(0);
    const how = result.signal ? `signal ${result.signal}` : `exit ${result.code}`;
    console.log(`[test:macos] ◀ ${step.name}: ${how}, ${secs} s`);
    return interrupted ? { code: result.code, signal: result.signal ?? interrupted } : result;
  });

  console.log("\n[test:macos] summary");
  for (const r of results) console.log(`  ${r.code === 0 ? "PASS" : "FAIL"}  ${r.name}`);
  for (const s of steps.slice(results.length)) console.log(`  SKIP  ${s.name}`);
  if (interrupted) {
    console.log(`[test:macos] stopped by ${interrupted}: do not tag.`);
    process.exit(128 + (osConstants.signals[interrupted] ?? 0));
  }
  const red = results.length < steps.length || results.some((r) => r.code !== 0);
  if (red)
    console.log("[test:macos] RED: do not tag. Rerun once the Mac is quiet if it was loaded.");
  process.exit(red ? 1 : 0);
}
