#!/usr/bin/env bun
/**
 * The macOS test gate, run on a Mac before a release tag:
 *
 *   bun run test:macos             # the essential tier, then print a summary
 *   bun run test:macos --full      # every test, the full tier
 *   bun run test:macos --dry-run   # print what a run would fetch and run; fetch and run nothing
 *
 * The default is the essential tier (packages/cli/scripts/test-tiers.json): steps 0-2 with
 * `--tier essential`, and step 3's Antigravity HTTP client tests. A nightly part runs no step 2. The blind hook tests and the S1
 * hook loading tests are hook files outside the hooks category's essential list, so `--full` runs
 * them, and so does the last nightly part, `--part 7/7` (scripts/weekly-macos-tests.ts). Nightly part
 * `ADVISORY_PART` also boots npm's `latest` Claude Code (`LATEST_CANARY_STEP`), an advisory step:
 * a red result is reported and written to `--advisory-out <file>`, and never makes the run red.
 * `--full` runs every test file, the slow and macOS-only ones no pull request runs included:
 *
 *  0. `bun run build:cli`, so the tests that start packages/cli/dist test this commit (a failed
 *     build stops the gate);
 *  1. every hermetic group, sliced (`ci-tests.ts --run idle@1/3,…,pane@1/6,…,rest@1/8,…
 *     --tier <tier>`, `GATE_RUNS`: test.yml's idle shards and pane slices, and `rest` in 8, in
 *     one call), under the Bun test.yml's `rest` job pins;
 *  2. the macos-bridge tests, `scripts/*.test.ts` and the Claude Code boot canary
 *     (scripts/boot-canary.ts: one boot per spawn shape, no credentials, no model call), under
 *     the same Bun. The canary boots the Claude Code .github/claude-code.version pins, fetched
 *     with `npm pack`. No GitHub workflow boots Claude Code: this step is the only boot check that
 *     gates;
 *  3. the blind hook tests and the Antigravity HTTP client tests, under `BLIND_BUN` (two blind
 *     tests fail on the pinned Bun because of bugs in Bun's test client);
 *  4. the S1 hook loading tests (`packages/cli/src/hooks/s1-probe/`, test.yml's hooks-loading
 *     macOS rows) under the Bun release.yml builds the binaries with (`latest`).
 *
 * The hermetic Bun is READ from test.yml's `rest` job and the release Bun from release.yml's
 * `build` job, never copied here: a gate on a different Bun than CI proves something else (pane
 * suites passed on 1.4.0 and failed 118 tests on 1.3.10). The blind Bun is the constant
 * `BLIND_BUN`, for the reason given there. Each pinned Bun comes from `bunx bun@<version>` and
 * is first on PATH for its steps. Everything a run fetches goes into one `mkdtemp` directory of
 * its own, removed when the run exits, so two runs (a `--dry-run` beside a real run included)
 * never touch each other's files. The boot canary writes to a new directory of the run's own
 * too (`canaryOutputDir`), which outlives the run so a red canary can be read.
 *
 * Every step runs under scripts/guard-real-config.ts, as `test:safe` does (a throwaway HOME, no
 * Keychain, no 1Password), with an environment built by allowlist: no provider key from the
 * developer's shell reaches it, so the credential-gated live tests skip as they do on a runner.
 * Every Bun the gate starts runs with `--no-env-file`, and every Bun a package script starts
 * below it inherits `BUN_OPTIONS=--no-env-file`, so a `.env` in a step's directory cannot put a
 * removed key back.
 * Each step is a process group of its own: SIGINT, SIGTERM or SIGHUP to the gate goes to that
 * group, and the gate stops once the step has exited.
 *
 * The pane suites run against the magmux the release ships: the gate downloads the release
 * pinned in .github/magmux.env with `gh` (signed in), checks the pinned SHA-256 and the version,
 * and puts it first on every step's PATH, where the pane suites' lookup (`findMagmuxCandidates`)
 * finds it. The Mac's own magmux is never used or changed. Anything it cannot read or verify
 * stops the gate.
 *
 * Expect a long `--full` run: the hermetic slices run as 17 concurrent processes, each with a
 * `--max-concurrency` scaled to the core count (`sliceConcurrency`), so the whole step runs about
 * twice the core count of tests at once. A red run on a loaded machine is still red: rerun once
 * the Mac is quiet.
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
  writeFileSync,
} from "node:fs";
import { availableParallelism, constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { findMagmuxCandidates } from "../packages/cli/src/launcher/magmux-binary.ts";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "packages", "cli");
const WORKFLOW = join(ROOT, ".github", "workflows", "test.yml");
const RELEASE_WORKFLOW = join(ROOT, ".github", "workflows", "release.yml");
const MAGMUX_ENV = join(ROOT, ".github", "magmux.env");
const PANE_LAUNCH = join(CLI, "src", "pane", "pane-launch.ts");
const CLAUDE_CODE_VERSION = join(ROOT, ".github", "claude-code.version");

/**
 * The Bun the blind hook tests run on, not the pinned one: two of them fail on 1.3.10 because of
 * bugs in Bun's test client, not in claudish, and pass 20 of 20 on 1.4.0 (reproduced on 1.3.10
 * with no claudish code in the loop): C-17, a fetch reader.cancel() that never closes the
 * connection, and X-12, a paused-then-resumed node:child_process reader that drops every byte.
 * The blind typecheck stays under the pinned Bun.
 */
export const BLIND_BUN = "1.4.0";

/**
 * How many slices the gate cuts each ci-tests.ts group into; every slice is one concurrent
 * `bun test` process.
 *
 * - `idle` runs on test.yml's Linux runners and not on its macOS ones, so without it here a
 *   weekly recovery-contract file would run in no gate a release owner starts. 3 slices, as
 *   test.yml's idle shards.
 * - `pane`: 6 slices.
 * - `rest`: 8 slices. A local essential run (2026-11-17, load about 45 on an 18-core Mac) took
 *   432 s for `rest` as one process, against 15-76 s for each pane slice; 8 slices put each near
 *   54 s, under the longest pane slice, and 3 + 6 + 8 = 17 processes still fit 18 cores.
 */
export const GATE_SLICES = { idle: 3, pane: 6, rest: 8 } as const;

/** How many concurrent `bun test` processes the hermetic step starts. */
export const GATE_SLICE_COUNT = Object.values(GATE_SLICES).reduce((a, b) => a + b, 0);

/**
 * The `--max-concurrency` each slice gets: `max(1, floor(cores * 2 / slices))`, so all slices
 * together run about twice the core count of tests at once (18 cores, 17 slices: 2 each).
 * A fixed 8 per slice let 17 slices run up to 136 tests at once on an 18-core Mac, and
 * time-bound tests failed: two 5000 ms timeouts, a 10 s timeout, a timing-ratio test and a
 * sandbox resource limit, all of which passed with 7 slices of 8.
 */
export function sliceConcurrency(cores: number, slices: number = GATE_SLICE_COUNT): number {
  return Math.max(1, Math.floor((cores * 2) / slices));
}

/** The gate's `--run` list in both tiers: every slice of every group. */
export const GATE_RUNS = Object.entries(GATE_SLICES)
  .flatMap(([group, n]) => Array.from({ length: n }, (_, i) => `${group}@${i + 1}/${n}`))
  .join(",");

/** ci-tests.ts's tiers: `essential` by default, `full` with `--full`, `weekly` for a part. */
export type GateTier = "essential" | "full" | "weekly";

/** Part k of n of the weekly tier: the k-th of n slices of every hermetic group. */
export interface Part {
  k: number;
  n: number;
}

export interface GateArgs {
  dryRun: boolean;
  tier: GateTier;
  part?: Part;
  /** Where the advisory steps' results go as JSON (`advisoryResults`); the nightly part reads it. */
  advisoryOut?: string;
}

const GATE_USAGE =
  "usage: test:macos [--full | --part <k>/<n>] [--dry-run] [--advisory-out <file>]";

/** The gate's own flags. Anything else is refused, so a misspelt `--full` never runs less. */
export function parseGateArgs(argv: string[]): GateArgs {
  const outAt = argv.indexOf("--advisory-out");
  if (outAt === -1) return parseTierArgs(argv);
  const advisoryOut = argv[outAt + 1];
  if (!advisoryOut || advisoryOut.startsWith("-"))
    throw new Error(`--advisory-out needs a file; ${GATE_USAGE}`);
  const args = parseTierArgs([...argv.slice(0, outAt), ...argv.slice(outAt + 2)]);
  return { ...args, advisoryOut };
}

function parseTierArgs(argv: string[]): GateArgs {
  const at = argv.indexOf("--part");
  const own = at === -1 ? argv : [...argv.slice(0, at), ...argv.slice(at + 2)];
  const unknown = own.filter((a) => a !== "--dry-run" && a !== "--full");
  if (unknown.length > 0) throw new Error(`unknown argument ${unknown.join(" ")}; ${GATE_USAGE}`);
  const dryRun = own.includes("--dry-run");
  if (at === -1) return { dryRun, tier: own.includes("--full") ? "full" : "essential" };
  const m = (argv[at + 1] ?? "").match(/^(\d+)\/(\d+)$/);
  const k = Number(m?.[1]);
  const n = Number(m?.[2]);
  if (!m || k < 1 || k > n) throw new Error(`--part needs <k>/<n> with 1 <= k <= n; ${GATE_USAGE}`);
  if (own.includes("--full"))
    throw new Error(`--part and --full exclude each other; ${GATE_USAGE}`);
  return { dryRun, tier: "weekly", part: { k, n } };
}

/** A part's `--run` list: the k-th of n slices of each group. */
export function partRuns(part: Part): string {
  return Object.keys(GATE_SLICES)
    .map((group) => `${group}@${part.k}/${part.n}`)
    .join(",");
}

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
 * Bun that loads them again, so test steps start `bun test` directly, and a step that runs a
 * package script also gets `BUN_OPTIONS=--no-env-file` (`stepEnv`).
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
  /** Its result is reported (`advisoryResults`) and never makes the gate red (`gateRed`). */
  advisory?: true;
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

export const CANARY_STEP = "Claude Code boot canary";

/**
 * The boot canary on npm's `latest` Claude Code (scripts/boot-canary-latest.ts), an advisory step
 * of one nightly part, `ADVISORY_PART`: it warns of a Claude Code release that breaks a spawn
 * shape before the pin moves to it, and a red result never fails the part.
 */
export const LATEST_CANARY_STEP = "Claude Code boot canary, npm latest";
export const ADVISORY_PART = 1;

/** True when the plan has a step that writes boot canary output (`CANARY_STEP`, `LATEST_CANARY_STEP`). */
export function runsCanary(groups: readonly StepGroup[]): boolean {
  return groups.some((g) =>
    g.steps.some((s) => s.name === CANARY_STEP || s.name === LATEST_CANARY_STEP)
  );
}

/**
 * A boot canary output directory of this run's own, made under `root` with `mkdtemp`, so it is
 * new and empty and no other run writes there. A `dryRun` names a placeholder and makes nothing.
 */
export function canaryOutputDir(root: string, dryRun: boolean): string {
  if (dryRun) return join(root, "claudish-boot-canary-<run>");
  return mkdtempSync(join(root, "claudish-boot-canary-"));
}

/**
 * Every step of one tier, grouped by the Bun it runs under; a Bun with no step in the tier is
 * left out, so it is never fetched. Pure, so `--dry-run` prints the steps a run runs, with
 * placeholders for the executables it has not fetched.
 */
export function planSteps(p: {
  root: string;
  hermetic: PlannedBun;
  blind: PlannedBun;
  release: PlannedBun;
  scriptTests: string[];
  /** The pinned Claude Code binary the boot canary boots, and where it writes what it read. */
  canary: { claude: string; out: string };
  tier: GateTier;
  /** A nightly part of the weekly tier; see `partSteps`. */
  part?: Part;
  /** The machine's core count; `os.availableParallelism()` unless given. */
  cores?: number;
}): StepGroup[] {
  if (p.part) return partSteps({ ...p, part: p.part });
  const cli = join(p.root, "packages", "cli");
  const maxConcurrency = sliceConcurrency(p.cores ?? availableParallelism());
  const full = p.tier === "full";
  const groups: StepGroup[] = [
    {
      bun: p.hermetic,
      steps: [
        {
          // Tests that start dist/ (host-pid.contract.test.ts runs `node bin/claudish.cjs`)
          // build it only when it is missing, so a Mac's dist/ from an older commit would be
          // what they test.
          name: "build:cli",
          cwd: p.root,
          args: [p.hermetic.exe, NO_ENV_FILE, "run", "build:cli"],
          stopOnFailure: true,
        },
        {
          name: `hermetic ${GATE_RUNS}`,
          cwd: cli,
          args: [
            p.hermetic.exe,
            NO_ENV_FILE,
            "scripts/ci-tests.ts",
            "--run",
            GATE_RUNS,
            "--tier",
            p.tier,
            "--",
            NO_ENV_FILE,
            `--max-concurrency=${maxConcurrency}`,
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
        {
          // Starts `magmux` by name: the pinned one, first on the step's PATH.
          name: CANARY_STEP,
          cwd: p.root,
          args: [
            p.hermetic.exe,
            NO_ENV_FILE,
            "scripts/boot-canary.ts",
            "--bin",
            p.canary.claude,
            "--out",
            p.canary.out,
          ],
        },
      ],
    },
    {
      bun: p.blind,
      steps: [
        ...(full
          ? [
              {
                name: "blind hook tests",
                cwd: cli,
                args: [p.blind.exe, NO_ENV_FILE, "test", "src/hooks/blind"],
              },
            ]
          : []),
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
      steps: full
        ? [
            {
              // test.yml's hooks-loading macOS rows: a user hook module loads from a dist bundle
              // and a compiled binary built by the Bun release.yml builds with.
              name: "S1 hook loading",
              cwd: p.root,
              args: [p.release.exe, NO_ENV_FILE, "test", "packages/cli/src/hooks/s1-probe/"],
            },
          ]
        : [],
    },
  ];
  return groups.filter((g) => g.steps.length > 0);
}

/**
 * One nightly part: the build, then the k-th of n slices of every group on the weekly tier (the
 * files the essential tier leaves out), as three concurrent processes. The essential gate on the
 * release commit runs the rest of the full tier: the essential files, macos-bridge, the script
 * tests and the Antigravity HTTP client tests. The last part also runs the two suites only
 * `--full` runs otherwise: the blind hook tests and S1 hook loading. Part `ADVISORY_PART` also
 * runs the advisory `LATEST_CANARY_STEP`.
 */
function partSteps(p: {
  root: string;
  hermetic: PlannedBun;
  blind: PlannedBun;
  release: PlannedBun;
  canary: { out: string };
  part: Part;
  cores?: number;
}): StepGroup[] {
  const cli = join(p.root, "packages", "cli");
  const runs = partRuns(p.part);
  const groupCount = Object.keys(GATE_SLICES).length;
  const maxConcurrency = sliceConcurrency(p.cores ?? availableParallelism(), groupCount);
  const last = p.part.k === p.part.n;
  const groups: StepGroup[] = [
    {
      bun: p.hermetic,
      steps: [
        {
          name: "build:cli",
          cwd: p.root,
          args: [p.hermetic.exe, NO_ENV_FILE, "run", "build:cli"],
          stopOnFailure: true,
        },
        {
          name: `hermetic ${runs}`,
          cwd: cli,
          args: [
            p.hermetic.exe,
            NO_ENV_FILE,
            "scripts/ci-tests.ts",
            "--run",
            runs,
            "--tier",
            "weekly",
            "--",
            NO_ENV_FILE,
            `--max-concurrency=${maxConcurrency}`,
          ],
        },
        ...(p.part.k === ADVISORY_PART
          ? [
              {
                // Starts `magmux` by name: the pinned one, first on the step's PATH.
                name: LATEST_CANARY_STEP,
                cwd: p.root,
                args: [
                  p.hermetic.exe,
                  NO_ENV_FILE,
                  "scripts/boot-canary-latest.ts",
                  "--out",
                  join(p.canary.out, "latest"),
                ],
                advisory: true as const,
              },
            ]
          : []),
      ],
    },
    {
      bun: p.blind,
      steps: last
        ? [
            {
              name: "blind hook tests",
              cwd: cli,
              args: [p.blind.exe, NO_ENV_FILE, "test", "src/hooks/blind"],
            },
          ]
        : [],
    },
    {
      bun: p.release,
      steps: last
        ? [
            {
              name: "S1 hook loading",
              cwd: p.root,
              args: [p.release.exe, NO_ENV_FILE, "test", "packages/cli/src/hooks/s1-probe/"],
            },
          ]
        : [],
    },
  ];
  return groups.filter((g) => g.steps.length > 0);
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
 * Installs the pinned magmux into `magmux/` under this run's directory: `gh release download`
 * of the pinned tag's asset, the pinned SHA-256, untar, and `--version` must print the pinned
 * version. The
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

/** The Claude Code release .github/claude-code.version pins, as its package for one darwin arch. */
export interface ClaudeCodePin {
  version: string;
  pkg: string;
}

/** Fails closed: a file that is not exactly one `x.y.z` line throws. */
export function parseClaudeCodePin(versionFile: string, arch: "arm64" | "x64"): ClaudeCodePin {
  const version = versionFile.trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("no x.y.z version in .github/claude-code.version");
  }
  return { version, pkg: `@anthropic-ai/claude-code-darwin-${arch}` };
}

export function claudeCodePinOfThisMac(): ClaudeCodePin {
  if (process.arch !== "arm64" && process.arch !== "x64") {
    fail(`no Claude Code darwin package for arch ${process.arch}`);
  }
  try {
    return parseClaudeCodePin(readFileSync(CLAUDE_CODE_VERSION, "utf8"), process.arch);
  } catch (err) {
    fail((err as Error).message);
  }
}

/** The version `claude --version` printed: its whole first token, so `2.1.296-beta.1` is not `2.1.296`. */
export function reportedClaudeCodeVersion(stdout: string): string {
  return stdout.trim().split(/\s+/)[0] ?? "";
}

/**
 * Fetches the pinned Claude Code into `claude-code/` under this run's directory: `npm pack` of
 * the per-platform package (the binary alone, never the installer, never signed in), untar, and
 * `--version` must print the pinned version.
 * The Mac's own Claude Code is never used or changed. Returns the binary's path.
 */
export function installPinnedClaudeCode(pin: ClaudeCodePin, runDir: string): string {
  const dir = join(runDir, "claude-code");
  mkdirSync(dir);
  const spec = `${pin.pkg}@${pin.version}`;
  const pack = spawnSync("npm", ["pack", spec, "--silent"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env },
  });
  const archive = pack.stdout?.trim().split("\n").pop() ?? "";
  if (pack.status !== 0 || !archive.endsWith(".tgz") || !existsSync(join(dir, archive))) {
    fail(`npm pack ${spec} failed:\n${pack.stderr ?? pack.error?.message ?? ""}`);
  }
  const tar = spawnSync("tar", ["xzf", join(dir, archive), "-C", dir], {
    encoding: "utf8",
    env: { ...process.env },
  });
  const exe = join(dir, "package", "claude");
  if (tar.status !== 0 || !existsSync(exe)) {
    fail(`could not unpack ${exe} from ${spec}:\n${tar.stderr ?? ""}`);
  }
  chmodSync(exe, 0o755);
  const version = spawnSync(exe, ["--version"], { encoding: "utf8", env: { ...process.env } });
  if (version.status !== 0 || reportedClaudeCodeVersion(version.stdout ?? "") !== pin.version) {
    fail(
      `${exe} --version printed ${JSON.stringify(version.stdout?.trim() ?? "")}, not ${pin.version}`
    );
  }
  return exe;
}

/** True when the step's Bun runs a package script (`bun --no-env-file run build:cli`). */
export function runsPackageScript(step: Pick<Step, "args">): boolean {
  return step.args.slice(1).find((arg) => !arg.startsWith("-")) === "run";
}

/**
 * The environment a step starts with, built by allowlist.
 *
 * A package script's Buns (`bun run build:cli` → `bun run build` → `bun build`) get no
 * `--no-env-file` from the step's argv, so such a step also gets `BUN_OPTIONS=--no-env-file`:
 * Bun prepends it to its own argv, and every Bun below inherits it. A test step does not: it
 * starts `bun test` directly, and its tests decide their children's environment. One of them
 * (meta-muse-code.test.ts T2) asserts that a child Bun loads the `.env` the test wrote, which
 * an inherited `BUN_OPTIONS` would turn red here and leave green on CI.
 */
export function stepEnv(
  step: Pick<Step, "args">,
  binDir: string,
  magmuxDir: string
): Record<string, string> {
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
  if (runsPackageScript(step)) env.BUN_OPTIONS = NO_ENV_FILE;
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

type Planned = { name: string; advisory?: true };
type Ran = { name: string; code: number };

/** Red when a step did not run, or a step that is not advisory ended non-zero. */
export function gateRed(steps: readonly Planned[], results: readonly Ran[]): boolean {
  if (results.length < steps.length) return true;
  return results.some((r, i) => r.code !== 0 && !steps[i]?.advisory);
}

/** The result of every advisory step that ran, as `--advisory-out` writes it. */
export function advisoryResults(
  steps: readonly Planned[],
  results: readonly Ran[]
): { name: string; pass: boolean; code: number }[] {
  return results
    .filter((_, i) => steps[i]?.advisory)
    .map((r) => ({ name: r.name, pass: r.code === 0, code: r.code }));
}

if (import.meta.main) {
  let args: GateArgs;
  try {
    args = parseGateArgs(process.argv.slice(2));
  } catch (err) {
    fail((err as Error).message);
  }
  const { dryRun, tier, part } = args;
  if (process.platform !== "darwin") fail(`runs on macOS only, not ${process.platform}`);

  const workflow = readFileSync(WORKFLOW, "utf8");
  const hermeticPin = bunPinOf(workflow, "rest");
  if (!hermeticPin) fail(`no bun-version pin for the rest job in ${WORKFLOW}`);
  const blindPin = BLIND_BUN;
  // The Bun the release binaries are built with (`latest`), as test.yml's hooks-loading uses.
  const releaseBunVersion = bunVersionOf(readFileSync(RELEASE_WORKFLOW, "utf8"), "build");
  if (!releaseBunVersion) fail(`no bun-version in the build job of ${RELEASE_WORKFLOW}`);
  const scriptTests = [...new Bun.Glob("scripts/*.test.ts").scanSync({ cwd: ROOT })]
    .sort()
    .map((f) => `./${f}`);
  const planFor = (exeOf: (version: string) => string, claude = "", canaryOut = "") =>
    planSteps({
      root: ROOT,
      hermetic: { version: hermeticPin, exe: exeOf(hermeticPin) },
      blind: { version: blindPin, exe: exeOf(blindPin) },
      release: { version: releaseBunVersion, exe: exeOf(releaseBunVersion) },
      scriptTests,
      canary: { claude, out: canaryOut },
      tier,
      part,
    });
  // Only the Buns this tier runs a step under are fetched, and Claude Code only for the canary.
  const unfetched = planFor(() => "");
  const versions = [...new Set(unfetched.map((g) => g.bun.version))];
  const bootsClaudeCode = unfetched.some((g) => g.steps.some((s) => s.name === CANARY_STEP));
  const magmuxPin = magmuxPinOfThisMac();
  const claudePin = bootsClaudeCode ? claudeCodePinOfThisMac() : undefined;

  if (dryRun) {
    // Fetches nothing: the executables are placeholders for what a run would fetch.
    for (const version of versions)
      console.log(`[test:macos] would fetch bun@${version} with bunx into a new temp directory`);
    console.log(
      `[test:macos] would download magmux ${magmuxPin.tag} (${magmuxPin.asset}, sha256 ${magmuxPin.sha256}) with gh into a new temp directory, first on PATH`
    );
    if (claudePin)
      console.log(
        `[test:macos] would fetch Claude Code ${claudePin.version} (${claudePin.pkg}) with npm pack into a new temp directory`
      );
    console.log(`[test:macos] tier ${tier}`);
    const plan = planFor(
      (version) => `<bun@${version}>`,
      claudePin ? `<claude@${claudePin.version}>` : "",
      canaryOutputDir(tmpdir(), true)
    );
    for (const { steps } of plan)
      for (const s of steps) {
        const env = runsPackageScript(s) ? `BUN_OPTIONS=${NO_ENV_FILE} ` : "";
        console.log(`[test:macos] would run (${s.cwd}): ${env}${s.args.join(" ")}`);
      }
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
  const claude = claudePin ? installPinnedClaudeCode(claudePin, runDir) : "";
  // What the canary reads (one screen per spawn shape, results.json) goes to a new directory of
  // this run's own, made only when the plan has a canary step. It outlives the run directory, so
  // a red canary can be read after the gate exits; old ones are left to macOS's $TMPDIR purge.
  const canaryOut = runsCanary(unfetched) ? canaryOutputDir(tmpdir(), false) : "";
  const groups = planFor((version) => buns.get(version)?.exe ?? "", claude, canaryOut);
  const binDirOf = new Map([...buns].map(([v, bun]) => [v, bun.dir] as const));

  console.log(`[test:macos] tier ${tier}`);
  console.log(`[test:macos] magmux ${magmuxPin.tag}: ${join(magmuxDir, "magmux")}`);
  for (const [version, bun] of buns)
    console.log(`[test:macos] bun@${version}: Bun ${bun.resolved}, ${bun.exe}`);
  if (claudePin) console.log(`[test:macos] Claude Code ${claudePin.version}: ${claude}`);
  if (canaryOut) console.log(`[test:macos] canary output: ${canaryOut}`);

  const steps = groups.flatMap(({ bun, steps }) => steps.map((step) => ({ ...step, bun })));
  const results = await runSteps(steps, async (step) => {
    console.log(`\n[test:macos] ▶ ${step.name}  (bun ${step.bun.version}, ${step.cwd})`);
    const started = performance.now();
    running = startStep(launchArgv(step), {
      cwd: step.cwd,
      env: stepEnv(step, binDirOf.get(step.bun.version) ?? "", magmuxDir),
    });
    const result = await running.exited;
    running = null;
    const secs = ((performance.now() - started) / 1000).toFixed(0);
    const how = result.signal ? `signal ${result.signal}` : `exit ${result.code}`;
    console.log(`[test:macos] ◀ ${step.name}: ${how}, ${secs} s`);
    return interrupted ? { code: result.code, signal: result.signal ?? interrupted } : result;
  });

  console.log("\n[test:macos] summary");
  results.forEach((r, i) => {
    const verdict = r.code === 0 ? "PASS" : "FAIL";
    const label = steps[i]?.advisory ? `ADVISORY ${verdict}` : verdict;
    console.log(`  ${label}  ${r.name}`);
  });
  for (const s of steps.slice(results.length)) console.log(`  SKIP  ${s.name}`);
  if (args.advisoryOut) {
    writeFileSync(
      args.advisoryOut,
      `${JSON.stringify(advisoryResults(steps, results), null, 2)}\n`
    );
  }
  if (interrupted) {
    console.log(`[test:macos] stopped by ${interrupted}: do not tag.`);
    process.exit(128 + (osConstants.signals[interrupted] ?? 0));
  }
  const red = gateRed(steps, results);
  if (red)
    console.log("[test:macos] RED: do not tag. Rerun once the Mac is quiet if it was loaded.");
  process.exit(red ? 1 : 0);
}
