import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover, groupOf } from "../packages/cli/scripts/ci-tests.ts";
import {
  CANARY_STEP,
  GATE_RUNS,
  GATE_SLICE_COUNT,
  HERMETIC_RUNS,
  NO_ENV_FILE,
  bunPinOf,
  bunVersionOf,
  compareVersions,
  launchArgv,
  parseClaudeCodePin,
  parseGateArgs,
  parseMagmuxPin,
  planSteps,
  reportedClaudeCodeVersion,
  runSteps,
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
  const CANARY_WORKFLOW = readFileSync(
    join(import.meta.dir, "..", ".github", "workflows", "boot-canary.yml"),
    "utf8"
  );

  test("no nightly part boots it", () => {
    for (let k = 1; k <= 7; k++) {
      const steps = planSteps({ ...PLAN_INPUT, tier: "weekly", part: { k, n: 7 } }).flatMap(
        (g) => g.steps
      );
      expect(steps.map((s) => s.name)).not.toContain(CANARY_STEP);
    }
  });

  test("boot-canary.yml starts no macOS runner: the gate is the macOS boot check", () => {
    expect(CANARY_WORKFLOW).toMatch(/runs-on: ubuntu-latest/);
    expect(CANARY_WORKFLOW).not.toMatch(/runs-on:.*(macos|matrix\.os)/);
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
  test("the hermetic and blind-hooks jobs each pin an exact Bun", () => {
    expect(bunPinOf(WORKFLOW, "hermetic")).toMatch(/^\d+\.\d+\.\d+$/);
    expect(bunPinOf(WORKFLOW, "blind-hooks")).toMatch(/^\d+\.\d+\.\d+$/);
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

  test("the hermetic runs are the slices test.yml's hermetic runners run", () => {
    const runs = [...WORKFLOW.matchAll(/^\s+runs: (\S+)$/gm)].map((m) => m[1]).join(",");
    expect(runs).toBe(HERMETIC_RUNS);
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

describe("compareVersions", () => {
  test("orders dotted numbers numerically", () => {
    expect(compareVersions("0.19.0", "0.19.0")).toBe(0);
    expect(compareVersions("0.9.0", "0.19.0")).toBe(-1);
    expect(compareVersions("0.20.0", "0.19.0")).toBe(1);
  });
});
