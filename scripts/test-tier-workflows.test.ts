/**
 * Which test tier each workflow runs: pull requests and pushes run the essential tier, a manual
 * dispatch and the weekly run take the github tier (packages/cli/scripts/ci-tests.ts,
 * test-tiers.json), and how the rest slices are spread over jobs.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  discover,
  filesInTier,
  forPlatform,
  groupOf,
  loadTiers,
  slices,
} from "../packages/cli/scripts/ci-tests.ts";
import { bunPinOf } from "./test-macos.ts";

const WORKFLOWS = join(import.meta.dir, "..", ".github", "workflows");
const read = (name: string) => readFileSync(join(WORKFLOWS, name), "utf8");

/**
 * The heaviest slice a GitHub job may hold, in ci-test-times.json seconds. A slice's real time
 * on ubuntu-latest has run near its weight (weights of 25 took 21-30 s), and a job adds 10-20 s
 * of setup, so 22 keeps a job well under the 50 s CI budget.
 */
const SLICE_BUDGET_SECONDS = 22;

/**
 * The most slices one rest job runs. Each is a concurrent `bun test` process, and the public
 * repository's ubuntu-latest runner has 4 vCPUs; a fourth process would share a core with the
 * runner's own work and stretch every slice of its job.
 */
const MAX_SLICES_PER_JOB = 3;

/** The `rest` matrix: one entry per job, each naming its slices (`rest@1/18,rest@7/18,…`). */
type RestJob = { job: number; slices: string };

const restJobs = (workflow: string): RestJob[] =>
  // biome-ignore lint/suspicious/noExplicitAny: a parsed workflow is untyped YAML
  (Bun.YAML.parse(workflow) as any).jobs.rest.strategy.matrix.include;

/** `rest@1/18,rest@7/18` → its slice numbers and the slice count. */
function parseSlices(specs: string): { i: number; n: number }[] {
  return specs.split(",").map((spec) => {
    const m = /^rest@(\d+)\/(\d+)$/.exec(spec);
    if (!m) throw new Error(`"${spec}" is not a rest slice`);
    return { i: Number(m[1]), n: Number(m[2]) };
  });
}

/** The lines of one job (`  <job>:` up to the next job key). */
function jobBlock(workflow: string, job: string): string {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${job}:`);
  if (start === -1) return "";
  const end = lines.findIndex((line, i) => i > start && /^ {2}[^\s#]/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

/** Every `ci-tests.ts --run` command line of one job. */
function ciTestsRuns(block: string): string[] {
  return block.split("\n").filter((line) => line.includes("scripts/ci-tests.ts --run"));
}

/**
 * The jobs of a workflow that run `ci-tests.ts --run` on a Linux runner. A `runs-on` of
 * `${{ matrix.<key> }}` is resolved through the job's matrix: the job counts when any value is
 * an Ubuntu runner.
 */
function linuxTieredJobs(workflow: string): string[] {
  // biome-ignore lint/suspicious/noExplicitAny: a parsed workflow is untyped YAML
  const jobs = (Bun.YAML.parse(workflow) as any).jobs as Record<string, any>;
  const runners = (job: string): string[] => {
    const runsOn = String(jobs[job]["runs-on"]);
    const key = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(runsOn)?.[1];
    if (!key) return [runsOn];
    const values = jobs[job].strategy?.matrix?.[key];
    return Array.isArray(values) ? values.map(String) : [runsOn];
  };
  return Object.keys(jobs).filter(
    (job) =>
      runners(job).some((r) => r.startsWith("ubuntu")) &&
      ciTestsRuns(jobBlock(workflow, job)).length > 0
  );
}

describe("test.yml", () => {
  const yml = read("test.yml");
  /** The job's slice matrix, which must be 1..n: its length is the `/n` of the run line. */
  const slicesOf = (job: string): number[] => {
    // biome-ignore lint/suspicious/noExplicitAny: a parsed workflow is untyped YAML
    const matrix = (Bun.YAML.parse(yml) as any).jobs[job].strategy.matrix.slice as number[];
    expect(matrix.length).toBeGreaterThan(0);
    expect(matrix).toEqual(matrix.map((_, i) => i + 1));
    return matrix;
  };

  test("the Linux idle slices run the essential tier, and the github tier on a dispatch", () => {
    const runs = ciTestsRuns(jobBlock(yml, "idle"));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain(`--run idle@\${{ matrix.slice }}/${slicesOf("idle").length}`);
    expect(runs[0]).toContain(
      "--tier ${{ github.event_name == 'workflow_dispatch' && 'github' || 'essential' }}"
    );
  });

  test("the Linux rest jobs run on every pull request: essential tier, github on a dispatch", () => {
    const block = jobBlock(yml, "rest");
    expect(block).toContain("runs-on: ubuntu-latest");
    expect(block).not.toMatch(/^ {4}if:/m);
    const runs = ciTestsRuns(block);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain("--run ${{ matrix.slices }} ");
    expect(runs[0]).toContain(
      "--tier ${{ github.event_name == 'workflow_dispatch' && 'github' || 'essential' }}"
    );
    expect(bunPinOf(yml, "rest")).toBe(bunPinOf(yml, "idle") as string);
  });

  test("the rest jobs take every slice exactly once, the heaviest three in three jobs", () => {
    const jobs = restJobs(yml);
    expect(jobs.map((j) => j.job)).toEqual(jobs.map((_, i) => i + 1));
    const specs = jobs.map((j) => parseSlices(j.slices));
    for (const s of specs) expect(s.length).toBeLessThanOrEqual(MAX_SLICES_PER_JOB);
    const n = specs[0]?.[0]?.n ?? 0;
    expect(n).toBeGreaterThan(0);
    const taken = specs.flat();
    expect(taken.every((s) => s.n === n)).toBe(true);
    expect(taken.map((s) => s.i).sort((a, b) => a - b)).toEqual(
      Array.from({ length: n }, (_, i) => i + 1)
    );
    // The planner hands the heaviest files to slices 1, 2 and 3 first.
    const jobOf = (i: number) => specs.findIndex((ss) => ss.some((s) => s.i === i));
    expect(new Set([jobOf(1), jobOf(2), jobOf(3)]).size).toBe(3);
  });

  test(`no rest or idle slice weighs over ${SLICE_BUDGET_SECONDS} s in a tier a GitHub job runs`, () => {
    const data = loadTiers();
    const times = JSON.parse(
      readFileSync(
        join(import.meta.dir, "..", "packages", "cli", "scripts", "ci-test-times.json"),
        "utf8"
      )
    ) as Record<string, number>;
    const files = forPlatform(discover(), data, "linux");
    const restCount = parseSlices(restJobs(yml)[0]?.slices ?? "")[0]?.n ?? 0;
    const counts = { rest: restCount, idle: slicesOf("idle").length };
    const heavy: string[] = [];
    for (const tier of ["essential", "github"] as const) {
      for (const [group, count] of Object.entries(counts)) {
        const inGroup = filesInTier(
          files.filter((f) => groupOf(f) === group),
          tier,
          data,
          times
        );
        slices(inGroup, count, times).forEach((s, i) => {
          if (s.seconds > SLICE_BUDGET_SECONDS) {
            heavy.push(`${tier} ${group}@${i + 1}/${count}: ${s.seconds.toFixed(1)} s`);
          }
        });
      }
    }
    expect(heavy).toEqual([]);
  });

  test("the dispatched macOS hermetic runners run the full tier", () => {
    const block = jobBlock(yml, "hermetic");
    expect(block).toContain("if: github.event_name == 'workflow_dispatch'");
    const runs = ciTestsRuns(block);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain("--tier full");
  });
});

describe("weekly-tests.yml", () => {
  const text = read("weekly-tests.yml");
  // biome-ignore lint/suspicious/noExplicitAny: a parsed workflow is untyped YAML
  const wf = Bun.YAML.parse(text) as any;
  const testYml = read("test.yml");
  const runsOf = (job: string): string[] =>
    (wf.jobs[job].steps as { run?: string }[]).flatMap((s) => (s.run ? [s.run] : []));

  test("runs every Sunday at 03:00 US Pacific (11:00 UTC) and on a manual dispatch", () => {
    expect(wf.on.schedule).toEqual([{ cron: "0 11 * * 0" }]);
    expect("workflow_dispatch" in wf.on).toBe(true);
  });

  test("runs the github tier of the idle slices, with the Bun test.yml pins", () => {
    const runs = ciTestsRuns(jobBlock(text, "idle"));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain("--run idle@${{ matrix.slice }}/3 --tier github");
    expect(wf.jobs.idle.strategy.matrix.slice).toEqual([1, 2, 3]);
    expect(bunPinOf(text, "idle")).toBe(bunPinOf(testYml, "idle") as string);
    expect(bunPinOf(text, "scripts")).toBe(bunPinOf(testYml, "scripts") as string);
  });

  test("runs the script and release-file tests and the Linux hook loading rows", () => {
    expect(runsOf("scripts")).toEqual([
      "bun install --frozen-lockfile",
      "bun test ./scripts/*.test.ts",
      "bun test src/release-files.test.ts",
    ]);
    expect(wf.jobs["hooks-loading"].strategy.matrix.os).toEqual([
      "ubuntu-latest",
      "ubuntu-24.04-arm",
    ]);
    expect(runsOf("hooks-loading")).toEqual(["bun test packages/cli/src/hooks/s1-probe/"]);
  });

  test("Linux tiered jobs are found whether runs-on names the runner or a matrix key", () => {
    const yml = [
      "jobs:",
      "  plain:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: bun scripts/ci-tests.ts --run idle@1/3 --tier essential",
      "  matrixed:",
      "    runs-on: ${{ matrix.os }}",
      "    strategy:",
      "      matrix:",
      "        os: [ubuntu-latest, ubuntu-24.04-arm]",
      "    steps:",
      "      - run: bun scripts/ci-tests.ts --run rest@1/4 --tier essential",
      "  mac:",
      "    runs-on: macos-15",
      "    steps:",
      "      - run: bun scripts/ci-tests.ts --run pane@1/6 --tier full",
      "  untiered:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: bun test ./scripts/*.test.ts",
    ].join("\n");
    expect(linuxTieredJobs(yml)).toEqual(["plain", "matrixed"]);
  });

  test("every Linux ci-tests.ts job of test.yml runs here in the github tier, same slices and Bun", () => {
    // biome-ignore lint/suspicious/noExplicitAny: a parsed workflow is untyped YAML
    const prJobs = (Bun.YAML.parse(testYml) as any).jobs as Record<string, any>;
    const linuxTiered = linuxTieredJobs(testYml);
    expect(linuxTiered).toEqual(["idle", "rest"]);
    for (const job of linuxTiered) {
      expect(wf.jobs[job]).toBeDefined();
      const runs = ciTestsRuns(jobBlock(text, job));
      expect(runs).toHaveLength(1);
      if (job === "rest") {
        expect(runs[0]).toContain("--run ${{ matrix.slices }} --tier github");
        expect(restJobs(text)).toEqual(restJobs(testYml));
      } else {
        const shards = prJobs[job].strategy.matrix.slice as number[];
        expect(runs[0]).toContain(
          `--run ${job}@\${{ matrix.slice }}/${shards.length} --tier github`
        );
        expect(wf.jobs[job].strategy.matrix.slice).toEqual(shards);
      }
      expect(bunPinOf(text, job)).toBe(bunPinOf(testYml, job) as string);
      expect(wf.jobs[job].env.CLAUDISH_SKIP_LIVE_E2E).toBe("1");
      expect(wf.jobs[job].env.CLAUDISH_DISABLE_CATALOG_WARM).toBe("1");
      expect(wf.jobs["report-failure"].needs).toContain(job);
    }
  });

  test("every test job runs with the hermetic environment test.yml sets", () => {
    for (const job of ["scripts", "idle"]) {
      expect(wf.jobs[job].env.CLAUDISH_SKIP_LIVE_E2E).toBe("1");
      expect(wf.jobs[job].env.CLAUDISH_DISABLE_CATALOG_WARM).toBe("1");
    }
  });

  test("a failed run on main opens or updates one issue, with issues: write and nothing else", () => {
    expect(wf.permissions).toEqual({ contents: "read" });
    const report = wf.jobs["report-failure"];
    expect(report.permissions).toEqual({ issues: "write" });
    expect(report.needs).toEqual(["scripts", "idle", "rest", "hooks-loading"]);
    expect(report.if).toContain("failure()");
    expect(report.if).toContain("refs/heads/main");
    expect(report.env.GH_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");
    expect(report.env.TITLE).toBe("Weekly full test run failed");
    const script = runsOf("report-failure").join("\n");
    expect(script).toContain("gh issue list");
    expect(script).toContain("gh issue comment");
    expect(script).toContain("gh issue create");
    expect(script).toContain("actions/runs/${GITHUB_RUN_ID}");
  });
});
