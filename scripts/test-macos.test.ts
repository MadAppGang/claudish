import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover, groupOf } from "../packages/cli/scripts/ci-tests.ts";
import { SCENARIOS, removeCanaryOutput } from "./boot-canary.output.ts";
import {
  ADVISORY_PART,
  BLIND_BUN,
  CANARY_STEP,
  GATE_RUNS,
  GATE_SLICE_COUNT,
  LATEST_CANARY_STEP,
  NO_ENV_FILE,
  advisoryResults,
  binaryKindOf,
  bunPinOf,
  bunVersionOf,
  bunxCacheDir,
  bunxCachePlaceholder,
  canaryOutputDir,
  compareVersions,
  fetchPinnedBun,
  gateRed,
  launchArgv,
  parseClaudeCodePin,
  parseGateArgs,
  parseMagmuxPin,
  planSteps,
  reportedClaudeCodeVersion,
  runSteps,
  runsCanary,
  runsPackageScript,
  sliceConcurrency,
  startStep,
  stepEnv,
  verifySha256,
} from "./test-macos.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "test-macos-test-"));
}

const WORKFLOW = readFileSync(
  join(import.meta.dir, "..", ".github", "workflows", "test.yml"),
  "utf8"
);

const PLAN_INPUT = {
  root: "/repo",
  hermetic: { version: "1.3.10", exe: "/b/1.3.10/bun" },
  blind: { version: "1.4.0", exe: "/b/1.4.0/bun" },
  release: { version: "latest", exe: "/b/latest/bun" },
  scriptTests: ["./scripts/a.test.ts"],
  canary: { claude: "/cc/claude", out: "/out/canary" },
};
const STEPS = planSteps({ ...PLAN_INPUT, tier: "full" }).flatMap((g) => g.steps);
const ESSENTIAL = planSteps({ ...PLAN_INPUT, tier: "essential" });

describe("tiers", () => {
  const hermeticArgs = (steps: { args: string[] }[]) =>
    steps.find((s) => s.args.includes("scripts/ci-tests.ts"))?.args ?? [];

  test("the default gate runs the essential tier of the hermetic groups", () => {
    const args = hermeticArgs(ESSENTIAL.flatMap((g) => g.steps));
    expect(args.slice(args.indexOf("--tier"), args.indexOf("--tier") + 2)).toEqual([
      "--tier",
      "essential",
    ]);
    expect(args.indexOf("--tier")).toBeLessThan(args.indexOf("--"));
  });

  test("--full runs the full tier of the hermetic groups", () => {
    const args = hermeticArgs(STEPS);
    expect(args.slice(args.indexOf("--tier"), args.indexOf("--tier") + 2)).toEqual([
      "--tier",
      "full",
    ]);
  });

  test("both tiers run every group ci-tests.ts knows, idle included", () => {
    const groups = new Set(discover().map(groupOf));
    expect([...groups].sort()).toEqual(["idle", "pane", "rest"]);
    for (const plan of [STEPS, ESSENTIAL.flatMap((g) => g.steps)]) {
      const args = hermeticArgs(plan);
      const runs = args[args.indexOf("--run") + 1] ?? "";
      const planned = new Set(runs.split(",").map((spec) => spec.split("@")[0]));
      expect([...planned].sort()).toEqual([...groups].sort());
    }
  });

  test("the gate slices idle in 3, pane in 6 and rest in 8, each slice once", () => {
    const slicesOf = (group: string, n: number) =>
      Array.from({ length: n }, (_, i) => `${group}@${i + 1}/${n}`);
    expect(GATE_RUNS.split(",")).toEqual([
      ...slicesOf("idle", 3),
      ...slicesOf("pane", 6),
      ...slicesOf("rest", 8),
    ]);
    for (const plan of [STEPS, ESSENTIAL.flatMap((g) => g.steps)]) {
      const args = hermeticArgs(plan);
      expect(args[args.indexOf("--run") + 1]).toBe(GATE_RUNS);
    }
  });

  test("each slice's --max-concurrency keeps the total near twice the core count", () => {
    expect(GATE_SLICE_COUNT).toBe(17);
    const concurrencyOf = (cores: number, tier: "essential" | "full") => {
      const plan = planSteps({ ...PLAN_INPUT, tier, cores }).flatMap((g) => g.steps);
      return hermeticArgs(plan).filter((a) => a.startsWith("--max-concurrency"));
    };
    for (const tier of ["essential", "full"] as const) {
      expect(concurrencyOf(18, tier)).toEqual(["--max-concurrency=2"]);
      expect(concurrencyOf(4, tier)).toEqual(["--max-concurrency=1"]);
      expect(concurrencyOf(64, tier)).toEqual(["--max-concurrency=7"]);
    }
    expect(sliceConcurrency(1, 17)).toBe(1);
    expect(sliceConcurrency(18, 17)).toBe(2);
    expect(sliceConcurrency(64, 17)).toBe(7);
  });

  test("the gate's idle slices are test.yml's idle shards", () => {
    const job = WORKFLOW.slice(WORKFLOW.indexOf("\n  idle:\n"));
    const shards = job
      .match(/slice: \[([\d, ]+)\]/)?.[1]
      ?.split(",")
      .map((s) => Number(s));
    const count = job.match(/--run idle@\$\{\{ matrix\.slice \}\}\/(\d+)/)?.[1];
    expect(shards).toBeDefined();
    expect(count).toBeDefined();
    const idle = GATE_RUNS.split(",").filter((spec) => spec.startsWith("idle"));
    expect(idle).toEqual((shards ?? []).map((i) => `idle@${i}/${count}`));
  });

  test("the blind hook tests and S1 hook loading are weekly; the rest runs in both tiers", () => {
    const names = ESSENTIAL.flatMap((g) => g.steps.map((s) => s.name));
    expect(names).toEqual([
      "build:cli",
      `hermetic ${GATE_RUNS}`,
      "macos-bridge tests",
      "script tests",
      CANARY_STEP,
      "Antigravity HTTP client tests",
    ]);
    expect(STEPS.map((s) => s.name)).toEqual([
      ...names.slice(0, 5),
      "blind hook tests",
      names[5],
      "S1 hook loading",
    ]);
  });

  test("both tiers boot the given Claude Code under the hermetic Bun, from the repo root", () => {
    for (const plan of [STEPS, ESSENTIAL.flatMap((g) => g.steps)]) {
      const canary = plan.find((s) => s.name === CANARY_STEP);
      expect(canary?.cwd).toBe("/repo");
      expect(canary?.args).toEqual([
        "/b/1.3.10/bun",
        NO_ENV_FILE,
        "scripts/boot-canary.ts",
        "--bin",
        "/cc/claude",
        "--out",
        "/out/canary",
      ]);
    }
  });

  test("the essential gate plans no step under the release Bun, so it fetches none", () => {
    expect(ESSENTIAL.map((g) => g.bun.version)).toEqual(["1.3.10", "1.4.0"]);
  });

  test("parseGateArgs reads --dry-run and --full, and refuses anything else", () => {
    expect(parseGateArgs([])).toEqual({ dryRun: false, tier: "essential" });
    expect(parseGateArgs(["--full", "--dry-run"])).toEqual({ dryRun: true, tier: "full" });
    expect(() => parseGateArgs(["--ful"])).toThrow(/--ful/);
  });

  test("parseGateArgs reads --part k/n and refuses a bad part or --part with --full", () => {
    expect(parseGateArgs(["--part", "3/7"])).toEqual({
      dryRun: false,
      tier: "weekly",
      part: { k: 3, n: 7 },
    });
    for (const bad of [[], ["0/7"], ["8/7"], ["3"], ["a/7"], ["--dry-run"]]) {
      expect(() => parseGateArgs(["--part", ...bad])).toThrow(/--part/);
    }
    expect(() => parseGateArgs(["--part", "1/7", "--full"])).toThrow(/--full/);
  });
});

describe("a nightly part", () => {
  const partSteps = (k: number) =>
    planSteps({ ...PLAN_INPUT, tier: "weekly", part: { k, n: 7 }, cores: 18 }).flatMap(
      (g) => g.steps
    );

  test("runs the k-th of n slices of every group on the weekly tier, after the build", () => {
    const steps = partSteps(3);
    expect(steps.map((s) => s.name)).toEqual(["build:cli", "hermetic idle@3/7,pane@3/7,rest@3/7"]);
    const args = steps[1]?.args ?? [];
    expect(args[args.indexOf("--run") + 1]).toBe("idle@3/7,pane@3/7,rest@3/7");
    expect(args[args.indexOf("--tier") + 1]).toBe("weekly");
    expect(args).toContain(`--max-concurrency=${sliceConcurrency(18, 3)}`);
  });

  test("exactly one part runs the advisory boot canary on npm's latest Claude Code", () => {
    const withIt = [1, 2, 3, 4, 5, 6, 7].filter((k) =>
      partSteps(k).some((s) => s.name === LATEST_CANARY_STEP)
    );
    expect(withIt).toEqual([ADVISORY_PART]);
    const step = partSteps(ADVISORY_PART).find((s) => s.name === LATEST_CANARY_STEP);
    expect(step?.advisory).toBe(true);
    expect(step?.args).toEqual([
      PLAN_INPUT.hermetic.exe,
      NO_ENV_FILE,
      "scripts/boot-canary-latest.ts",
      "--out",
      join(PLAN_INPUT.canary.out, "latest"),
    ]);
  });

  test("the advisory canary writes inside the canary directory the gate reserved and prints", () => {
    const step = partSteps(ADVISORY_PART).find((s) => s.name === LATEST_CANARY_STEP);
    const args = step?.args ?? [];
    const out = args[args.indexOf("--out") + 1] ?? "";
    expect(out.startsWith(`${PLAN_INPUT.canary.out}/`)).toBe(true);
  });

  test("a red advisory step does not make the gate red; any other red step does", () => {
    const steps = [{ name: "a" }, { name: "b", advisory: true as const }];
    expect(
      gateRed(steps, [
        { name: "a", code: 0 },
        { name: "b", code: 1 },
      ])
    ).toBe(false);
    expect(
      gateRed(steps, [
        { name: "a", code: 1 },
        { name: "b", code: 0 },
      ])
    ).toBe(true);
    // a step that never ran is red, advisory or not
    expect(gateRed(steps, [{ name: "a", code: 0 }])).toBe(true);
    expect(
      advisoryResults(steps, [
        { name: "a", code: 0 },
        { name: "b", code: 1 },
      ])
    ).toEqual([{ name: "b", pass: false, code: 1 }]);
  });

  test("--advisory-out names the file the advisory results go to", () => {
    expect(parseGateArgs(["--part", "1/7", "--advisory-out", "/l/a.json"])).toEqual({
      dryRun: false,
      tier: "weekly",
      part: { k: 1, n: 7 },
      advisoryOut: "/l/a.json",
    });
    expect(() => parseGateArgs(["--part", "1/7", "--advisory-out"])).toThrow(/--advisory-out/);
  });

  test("the last part also runs the blind hook tests and S1 hook loading", () => {
    expect(partSteps(7).map((s) => s.name)).toEqual([
      "build:cli",
      "hermetic idle@7/7,pane@7/7,rest@7/7",
      "blind hook tests",
      "S1 hook loading",
    ]);
  });
});

describe("the Claude Code boot canary", () => {
  test("no nightly part boots it", () => {
    for (let k = 1; k <= 7; k++) {
      const steps = planSteps({ ...PLAN_INPUT, tier: "weekly", part: { k, n: 7 } }).flatMap(
        (g) => g.steps
      );
      expect(steps.map((s) => s.name)).not.toContain(CANARY_STEP);
    }
  });

  test("the pin is the version file's one x.y.z line, as the darwin package of the arch", () => {
    expect(parseClaudeCodePin("2.1.296\n", "arm64")).toEqual({
      version: "2.1.296",
      pkg: "@anthropic-ai/claude-code-darwin-arm64",
    });
    expect(parseClaudeCodePin("2.1.296", "x64").pkg).toBe("@anthropic-ai/claude-code-darwin-x64");
  });

  test("a version file that is not one x.y.z line is refused", () => {
    for (const bad of ["", "latest", "2.1", "v2.1.296", "2.1.296\n2.1.297", "2.1.296 --tag x"]) {
      expect(() => parseClaudeCodePin(bad, "arm64")).toThrow(/claude-code\.version/);
    }
  });

  test("the fetched binary's version is the whole first token of --version", () => {
    expect(reportedClaudeCodeVersion("2.1.296 (Claude Code)\n")).toBe("2.1.296");
    // a prerelease of the pinned number is another version
    expect(reportedClaudeCodeVersion("2.1.296-beta.1 (Claude Code)\n")).toBe("2.1.296-beta.1");
    expect(reportedClaudeCodeVersion("")).toBe("");
  });
});

describe("the release Bun", () => {
  const RELEASE = readFileSync(
    join(import.meta.dir, "..", ".github", "workflows", "release.yml"),
    "utf8"
  );

  test("bunVersionOf reads an unquoted version such as latest", () => {
    expect(bunVersionOf("jobs:\n  a:\n    with:\n      bun-version: latest\n", "a")).toBe("latest");
    expect(bunVersionOf('jobs:\n  a:\n    with:\n      bun-version: "1.2.3"\n', "a")).toBe("1.2.3");
  });

  test("test.yml's hooks-loading runs the Bun release.yml builds the binaries with", () => {
    const release = bunVersionOf(RELEASE, "build");
    expect(release).toBeDefined();
    expect(bunVersionOf(WORKFLOW, "hooks-loading")).toBe(release as string);
  });

  test("the s1 hook loading tests run under the release Bun, from the repo root", () => {
    const s1 = STEPS.find((s) => s.args.includes("packages/cli/src/hooks/s1-probe/"));
    expect(s1?.cwd).toBe("/repo");
    expect(s1?.args).toEqual([
      "/b/latest/bun",
      NO_ENV_FILE,
      "test",
      "packages/cli/src/hooks/s1-probe/",
    ]);
  });
});

describe("the build", () => {
  test("build:cli runs first, under the hermetic Bun, and a failed build stops the gate", () => {
    const first = STEPS[0];
    expect(first?.cwd).toBe("/repo");
    expect(first?.args).toEqual(["/b/1.3.10/bun", NO_ENV_FILE, "run", "build:cli"]);
    expect(first?.stopOnFailure).toBe(true);
    const hermetic = STEPS.findIndex((s) => s.args.includes("scripts/ci-tests.ts"));
    expect(hermetic).toBe(1);
  });

  test("a failed stop-on-failure step runs no further step", async () => {
    const ran: string[] = [];
    const steps = [
      { name: "build", cwd: "/", args: ["build"], stopOnFailure: true },
      { name: "tests", cwd: "/", args: ["tests"] },
    ];
    const results = await runSteps(steps, async (step) => {
      ran.push(step.name);
      return { code: 1, signal: null };
    });
    expect(ran).toEqual(["build"]);
    expect(results).toEqual([{ name: "build", code: 1 }]);
  });
});

describe("no step loads a .env file", () => {
  test("every Bun a step starts, and the guard, run with --no-env-file", () => {
    for (const step of STEPS) {
      expect(step.args[1]).toBe(NO_ENV_FILE);
      // ci-tests.ts starts one `bun test` per slice; the flag reaches them through `--`.
      if (step.args.includes("scripts/ci-tests.ts")) {
        expect(step.args.slice(step.args.indexOf("--") + 1)).toContain(NO_ENV_FILE);
      }
    }
    // A package script (`bun run test`) starts a second Bun the flag does not reach.
    const bridge = STEPS.find((s) => s.name === "macos-bridge tests");
    expect(bridge?.cwd).toBe("/repo/packages/macos-bridge");
    expect(bridge?.args).toEqual(["/b/1.3.10/bun", NO_ENV_FILE, "test"]);
    const first = STEPS[0] as (typeof STEPS)[number];
    expect(launchArgv(first, "/guard.ts")).toEqual([
      process.execPath,
      NO_ENV_FILE,
      "/guard.ts",
      "--",
      ...first.args,
    ]);
  });

  test("a .env in the step's cwd does not reach the command", async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, ".env"), "TEST_MACOS_SYNTHETIC_KEY=sk-synthetic\n");
      // Stands in for guard-real-config.ts, which hands its own environment to the command.
      const wrapper = join(dir, "wrapper.ts");
      writeFileSync(
        wrapper,
        // Bun drops the `--` from process.argv; argv[2] onward is the command.
        'const argv = process.argv.slice(process.argv[2] === "--" ? 3 : 2);\n' +
          "const r = Bun.spawnSync(argv, { env: process.env, stdout: 'inherit' });\n" +
          "process.exit(r.exitCode ?? 1);\n"
      );
      const out = join(dir, "seen.txt");
      const print = `require("fs").writeFileSync(${JSON.stringify(out)}, process.env.TEST_MACOS_SYNTHETIC_KEY ?? "absent")`;
      const step = { name: "probe", cwd: dir, args: [process.execPath, NO_ENV_FILE, "-e", print] };
      const run = startStep(launchArgv(step, wrapper), {
        cwd: dir,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir },
      });
      expect((await run.exited).code).toBe(0);
      expect(readFileSync(out, "utf8")).toBe("absent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a step that runs a package script turns env-file loading off in every Bun below it", () => {
    const build = STEPS.find((s) => s.name === "build:cli") as (typeof STEPS)[number];
    expect(runsPackageScript(build)).toBe(true);
    expect(stepEnv(build, "/b", "/m").BUN_OPTIONS).toBe(NO_ENV_FILE);
    // Test steps start `bun test` (or ci-tests.ts) directly; their tests own their children's env.
    for (const step of STEPS.filter((s) => s !== build)) {
      expect(runsPackageScript(step)).toBe(false);
      expect(stepEnv(step, "/b", "/m").BUN_OPTIONS).toBeUndefined();
    }
  });

  test("a .env does not reach a Bun that a package script starts, two levels down", async () => {
    const dir = tempDir();
    try {
      // The build step's shape: `bun run build:cli` → `cd packages/cli && bun run build` →
      // `bun run <file>`, each nested Bun found on PATH.
      const sub = join(dir, "sub");
      const bin = join(dir, "bin");
      mkdirSync(sub);
      mkdirSync(bin);
      symlinkSync(process.execPath, join(bin, "bun"));
      for (const d of [dir, sub]) {
        writeFileSync(join(d, ".env"), "TEST_MACOS_SYNTHETIC_KEY=sk-synthetic\n");
        writeFileSync(join(d, ".env.local"), "TEST_MACOS_SYNTHETIC_LOCAL=sk-synthetic\n");
      }
      const out = join(dir, "seen.txt");
      writeFileSync(
        join(dir, "print.ts"),
        `require("fs").writeFileSync(${JSON.stringify(out)}, ` +
          "`${process.env.TEST_MACOS_SYNTHETIC_KEY ?? 'absent'} " +
          "${process.env.TEST_MACOS_SYNTHETIC_LOCAL ?? 'absent'}`);\n"
      );
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          private: true,
          scripts: { outer: "bun run inner", inner: "cd sub && bun run ../print.ts" },
        })
      );
      const wrapper = join(dir, "wrapper.ts");
      writeFileSync(
        wrapper,
        'const argv = process.argv.slice(process.argv[2] === "--" ? 3 : 2);\n' +
          "const r = Bun.spawnSync(argv, { env: process.env, stdout: 'inherit' });\n" +
          "process.exit(r.exitCode ?? 1);\n"
      );
      const step = { name: "probe", cwd: dir, args: ["bun", NO_ENV_FILE, "run", "outer"] };
      const run = startStep(launchArgv(step, wrapper), {
        cwd: dir,
        env: { ...stepEnv(step, bin, bin), HOME: dir },
      });
      expect((await run.exited).code).toBe(0);
      expect(readFileSync(out, "utf8")).toBe("absent absent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("test:macos reads its Buns from test.yml", () => {
  test("the rest job pins an exact Bun, and the blind Bun is an exact version", () => {
    expect(bunPinOf(WORKFLOW, "rest")).toMatch(/^\d+\.\d+\.\d+$/);
    expect(BLIND_BUN).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("no Bun is read from a macOS job of test.yml", () => {
    const source = readFileSync(join(import.meta.dir, "test-macos.ts"), "utf8");
    expect(source).not.toContain('bunPinOf(workflow, "hermetic")');
    expect(source).not.toContain('bunPinOf(workflow, "blind-hooks")');
    expect(source).toContain('bunPinOf(workflow, "rest")');
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
});

describe("signals", () => {
  test("a forwarded signal reaches the step's whole process group", async () => {
    const dir = tempDir();
    try {
      const pidFile = join(dir, "grandchild.pid");
      const script =
        `const g = require("child_process").spawn("sleep", ["30"], { stdio: "ignore" });\n` +
        `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));\n` +
        "setInterval(() => {}, 1000);\n";
      const run = startStep([process.execPath, "-e", script], {
        cwd: dir,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir },
      });
      const deadline = Date.now() + 10_000;
      while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(25);
      const grandchild = Number(readFileSync(pidFile, "utf8"));
      run.signal("SIGTERM");
      const result = await run.exited;
      expect(result.signal).toBe("SIGTERM");
      let alive = true;
      for (let i = 0; i < 40 && alive; i++) {
        try {
          process.kill(grandchild, 0);
          await Bun.sleep(25);
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the gate stops after a signaled step and reports it red", async () => {
    const ran: string[] = [];
    const steps = ["a", "b", "c"].map((name) => ({ name, cwd: "/", args: [name] }));
    const results = await runSteps(steps, async (step) => {
      ran.push(step.name);
      return step.name === "b" ? { code: null, signal: "SIGINT" } : { code: 0, signal: null };
    });
    expect(ran).toEqual(["a", "b"]);
    expect(results.map((r) => r.code)).toEqual([0, 130]);
  });
});

describe("the pinned magmux", () => {
  const ROOT = join(import.meta.dir, "..");
  const MAGMUX_ENV = readFileSync(join(ROOT, ".github", "magmux.env"), "utf8");
  const PANE_LAUNCH = readFileSync(
    join(ROOT, "packages", "cli", "src", "pane", "pane-launch.ts"),
    "utf8"
  );

  test("reads the tag, the version, this arch's asset and its pinned sum", () => {
    const pin = parseMagmuxPin(MAGMUX_ENV, PANE_LAUNCH, "arm64");
    const tag = MAGMUX_ENV.match(/^MAGMUX_TAG=(\S+)$/m)?.[1] as string;
    expect(pin.tag).toBe(tag);
    expect(pin.version).toBe(tag.replace(/^v/, ""));
    expect(pin.asset).toBe("magmux_darwin_arm64.tar.gz");
    expect(pin.sha256).toBe(MAGMUX_ENV.match(/^MAGMUX_SHA256_darwin_arm64=(\S+)$/m)?.[1] as string);
    expect(parseMagmuxPin(MAGMUX_ENV, PANE_LAUNCH, "amd64").asset).toBe(
      "magmux_darwin_amd64.tar.gz"
    );
  });

  const env = (tag: string, sum = "a".repeat(64)) =>
    `MAGMUX_TAG=${tag}\nMAGMUX_SHA256_darwin_arm64=${sum}\n`;
  const min = (v: string) => `export const MIN_MAGMUX_VERSION = "${v}";\n`;

  test("fails closed on a value it cannot read, or a pin panes cannot use", () => {
    expect(() => parseMagmuxPin(env("v0.19.0"), "no constant here", "arm64")).toThrow(
      /MIN_MAGMUX_VERSION/
    );
    expect(() =>
      parseMagmuxPin(`MAGMUX_SHA256_darwin_arm64=${"a".repeat(64)}\n`, min("0.19.0"), "arm64")
    ).toThrow(/MAGMUX_TAG/);
    expect(() => parseMagmuxPin(env("latest"), min("0.19.0"), "arm64")).toThrow(/MAGMUX_TAG/);
    expect(() => parseMagmuxPin(env("v0.19.0"), min("0.19.0"), "amd64")).toThrow(
      /MAGMUX_SHA256_darwin_amd64/
    );
    expect(() => parseMagmuxPin(env("v0.19.0", "short"), min("0.19.0"), "arm64")).toThrow(
      /MAGMUX_SHA256_darwin_arm64/
    );
    expect(() => parseMagmuxPin(env("v0.18.0"), min("0.19.0"), "arm64")).toThrow(/older than/);
    expect(() => parseMagmuxPin(env("v3.4.2"), min("0.19.0"), "arm64")).toThrow(/0\.x/);
    expect(parseMagmuxPin(env("v0.19.0"), min("0.19.0"), "arm64").version).toBe("0.19.0");
  });

  test("verifySha256 accepts the pinned sum and rejects any other", () => {
    const dir = tempDir();
    try {
      const file = join(dir, "asset");
      writeFileSync(file, "magmux");
      const sum = new Bun.CryptoHasher("sha256").update("magmux").digest("hex");
      expect(() => verifySha256(file, sum)).not.toThrow();
      expect(() => verifySha256(file, "0".repeat(64))).toThrow(/sha256/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("--dry-run", () => {
  test.skipIf(process.platform !== "darwin")(
    "prints the plan with no bunx on PATH, so it fetches nothing",
    () => {
      const dir = tempDir();
      try {
        const r = Bun.spawnSync(
          [process.execPath, join(import.meta.dir, "test-macos.ts"), "--dry-run"],
          { cwd: dir, env: { PATH: "/nonexistent", HOME: dir, TMPDIR: dir } }
        );
        const out = r.stdout.toString();
        expect(r.stderr.toString()).toBe("");
        expect(r.exitCode).toBe(0);
        expect(out).toContain("would fetch bun@");
        expect(out).toMatch(/would download magmux v\d+\.\d+\.\d+ \(magmux_darwin_(arm64|amd64)/);
        expect(out).toContain("scripts/ci-tests.ts");
        expect(out).toContain("--tier essential");
        expect(out).not.toContain("src/hooks/blind");

        const full = Bun.spawnSync(
          [process.execPath, join(import.meta.dir, "test-macos.ts"), "--full", "--dry-run"],
          { cwd: dir, env: { PATH: "/nonexistent", HOME: dir, TMPDIR: dir } }
        );
        expect(full.exitCode).toBe(0);
        expect(full.stdout.toString()).toContain("--tier full");
        expect(full.stdout.toString()).toContain("src/hooks/blind");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});

describe("removeCanaryOutput", () => {
  test("removes the report and the screens, and keeps every other file", () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, "results.json"), "{}\n");
      for (const s of SCENARIOS) writeFileSync(join(dir, `${s}.screen.txt`), "screen\n");
      writeFileSync(join(dir, "comparison.screen.txt"), "mine\n");
      writeFileSync(join(dir, "notes.txt"), "mine\n");
      mkdirSync(join(dir, "kept"));
      removeCanaryOutput(dir);
      expect(existsSync(join(dir, "results.json"))).toBe(false);
      for (const s of SCENARIOS) expect(existsSync(join(dir, `${s}.screen.txt`))).toBe(false);
      expect(readFileSync(join(dir, "comparison.screen.txt"), "utf8")).toBe("mine\n");
      expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("mine\n");
      expect(existsSync(join(dir, "kept"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does nothing when the directory does not exist", () => {
    const dir = tempDir();
    rmSync(dir, { recursive: true, force: true });
    removeCanaryOutput(dir);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("canaryOutputDir", () => {
  test("each run gets a new empty directory of its own", () => {
    const root = tempDir();
    try {
      const a = canaryOutputDir(root, false);
      const b = canaryOutputDir(root, false);
      expect(a).not.toBe(b);
      for (const dir of [a, b]) {
        expect(dir.startsWith(join(root, "claudish-boot-canary-"))).toBe(true);
        expect(existsSync(dir)).toBe(true);
        expect(readdirSync(dir)).toEqual([]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a dry run names a directory and makes nothing", () => {
    const root = tempDir();
    try {
      const dir = canaryOutputDir(root, true);
      expect(dir.startsWith(join(root, "claudish-boot-canary-"))).toBe(true);
      expect(existsSync(dir)).toBe(false);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("only a plan with a canary step needs the directory", () => {
    const part = (k: number) => planSteps({ ...PLAN_INPUT, tier: "weekly", part: { k, n: 7 } });
    expect(runsCanary(ESSENTIAL)).toBe(true);
    expect(runsCanary(planSteps({ ...PLAN_INPUT, tier: "full" }))).toBe(true);
    expect(runsCanary(part(ADVISORY_PART))).toBe(true);
    for (const k of [2, 3, 4, 5, 6, 7]) expect(runsCanary(part(k))).toBe(false);
  });
});

describe("compareVersions", () => {
  test("orders dotted numbers numerically", () => {
    expect(compareVersions("0.19.0", "0.19.0")).toBe(0);
    expect(compareVersions("0.9.0", "0.19.0")).toBe(-1);
    expect(compareVersions("0.20.0", "0.19.0")).toBe(1);
  });
});

describe("the pinned Bun from bunx", () => {
  // The first bytes of a 64-bit arm64 Mach-O, the way the real 60 MB bun.exe starts.
  const MACH_O = {
    head: Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]),
    size: 60_953_744,
  };
  // The npm package's bun.exe before its postinstall replaces it: a 450-byte shell script.
  const SCRIPT = {
    head: new TextEncoder().encode('echo "Error: Bun\'s postinstall script was not run." >&2\n'),
    size: 450,
  };
  const SHEBANG = { head: new TextEncoder().encode("#!/bin/sh\n"), size: 450 };

  test("a Mach-O header is a real binary", () => {
    expect(binaryKindOf(MACH_O)).toBe("mach-o");
    // A universal (fat) binary and the big-endian magic are Mach-O too.
    expect(binaryKindOf({ head: Uint8Array.from([0xca, 0xfe, 0xba, 0xbe]), size: 1 << 26 })).toBe(
      "mach-o"
    );
    expect(binaryKindOf({ head: Uint8Array.from([0xfe, 0xed, 0xfa, 0xcf]), size: 1 << 26 })).toBe(
      "mach-o"
    );
  });

  test("the 450-byte script, a #! script or a far too small file is a placeholder", () => {
    expect(binaryKindOf(SCRIPT)).toBe("placeholder");
    expect(binaryKindOf(SHEBANG)).toBe("placeholder");
    expect(binaryKindOf({ head: MACH_O.head, size: 450 })).toBe("placeholder");
    expect(binaryKindOf({ head: new Uint8Array(0), size: 0 })).toBe("placeholder");
  });

  test("a missing file is not a real binary", () => {
    expect(binaryKindOf(null)).toBe("missing");
  });

  test("the cache folder is bunx-<uid>-bun@<version> under the temp directory", () => {
    expect(bunxCacheDir("/var/folders/x/T", 501, "1.3.10")).toBe(
      "/var/folders/x/T/bunx-501-bun@1.3.10"
    );
    expect(bunxCacheDir("/tmp", 0, "latest")).toBe("/tmp/bunx-0-bun@latest");
  });

  const CACHE = "/T/bunx-501-bun@1.3.10";
  const BIN = `${CACHE}/node_modules/bun/bin`;

  test("bunxCachePlaceholder names a placeholder bun.exe or bunx.exe, and nothing else", () => {
    const files =
      (f: Record<string, typeof MACH_O>) =>
      (path: string): typeof MACH_O | null =>
        f[path] ?? null;
    expect(bunxCachePlaceholder(CACHE, files({}))).toBeNull();
    expect(
      bunxCachePlaceholder(
        CACHE,
        files({ [`${BIN}/bun.exe`]: MACH_O, [`${BIN}/bunx.exe`]: MACH_O })
      )
    ).toBeNull();
    expect(bunxCachePlaceholder(CACHE, files({ [`${BIN}/bun.exe`]: SCRIPT }))).toBe(
      `${BIN}/bun.exe`
    );
    expect(
      bunxCachePlaceholder(
        CACHE,
        files({ [`${BIN}/bun.exe`]: MACH_O, [`${BIN}/bunx.exe`]: SCRIPT })
      )
    ).toBe(`${BIN}/bunx.exe`);
  });

  /**
   * A bunx whose cache holds the placeholder for its first `placeholderRuns` runs. On a
   * placeholder run it exits 1 like the script does, or, with `reportsSuccess`, exits 0 and
   * reports the placeholder as its executable.
   */
  function fakeBunx(placeholderRuns: number, reportsSuccess = false) {
    const exe = `${BIN}/bun.exe`;
    let runs = 0;
    const removed: string[] = [];
    const logged: string[] = [];
    const placeholder = () => runs <= placeholderRuns;
    const io = {
      cacheDir: CACHE,
      runBunx: () => {
        runs++;
        if (!placeholder() || reportsSuccess) {
          return { status: 0, stdout: `1.3.10\t${exe}\n`, stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "Error: Bun's postinstall script was not run.\n" };
      },
      readHead: (path: string) =>
        path === exe || path === `${BIN}/bunx.exe` ? (placeholder() ? SCRIPT : MACH_O) : null,
      removeDir: (path: string) => {
        removed.push(path);
      },
      log: (line: string) => {
        logged.push(line);
      },
    };
    return { io, exe, removed, logged, runs: () => runs };
  }

  test("a real Bun on the first run is returned with no removal", () => {
    const f = fakeBunx(0);
    expect(fetchPinnedBun("1.3.10", f.io)).toEqual({ exe: f.exe, resolved: "1.3.10" });
    expect(f.removed).toEqual([]);
    expect(f.logged).toEqual([]);
    expect(f.runs()).toBe(1);
  });

  test("a placeholder on the first run removes the cache folder and fetches once more", () => {
    const f = fakeBunx(1);
    expect(fetchPinnedBun("1.3.10", f.io)).toEqual({ exe: f.exe, resolved: "1.3.10" });
    expect(f.removed).toEqual([CACHE]);
    expect(f.runs()).toBe(2);
    expect(f.logged).toHaveLength(1);
    expect(f.logged[0]).toContain(CACHE);
    expect(f.logged[0]).toContain("placeholder bun.exe");
    expect(f.logged[0]).toContain("postinstall never ran");
    expect(f.logged[0]).toContain("bun@1.3.10");
  });

  test("a placeholder behind a run that exits 0 is caught before its exe is trusted", () => {
    const f = fakeBunx(1, true);
    expect(fetchPinnedBun("1.3.10", f.io)).toEqual({ exe: f.exe, resolved: "1.3.10" });
    expect(f.removed).toEqual([CACHE]);
    expect(f.runs()).toBe(2);
  });

  test("a placeholder on both runs stops with the cause and the folder, after one retry", () => {
    const f = fakeBunx(99);
    let message = "";
    try {
      fetchPinnedBun("1.3.10", f.io);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("placeholder bun.exe");
    expect(message).toContain("postinstall never ran");
    expect(message).toContain(CACHE);
    expect(message).not.toContain("could not get Bun");
    expect(f.runs()).toBe(2);
    expect(f.removed).toEqual([CACHE]);
  });

  test("a failure that is not a placeholder keeps the bunx error and does not retry", () => {
    const f = fakeBunx(0);
    let runs = 0;
    const io = {
      ...f.io,
      runBunx: () => {
        runs++;
        return { status: 1, stdout: "", stderr: "error: no such version\n" };
      },
      readHead: () => null,
    };
    expect(() => fetchPinnedBun("9.9.9", io)).toThrow(
      "could not get Bun 9.9.9 with bunx:\nerror: no such version"
    );
    expect(runs).toBe(1);
    expect(f.removed).toEqual([]);
  });
});
