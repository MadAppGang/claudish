/**
 * Which test tier each workflow runs: pull requests and pushes run the essential tier, a manual
 * dispatch runs the full tier (packages/cli/scripts/ci-tests.ts, test-tiers.json).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bunPinOf } from "./test-macos.ts";

const WORKFLOWS = join(import.meta.dir, "..", ".github", "workflows");
const read = (name: string) => readFileSync(join(WORKFLOWS, name), "utf8");

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

describe("test.yml", () => {
  const yml = read("test.yml");

  test("the Linux idle slices run the essential tier, and the full tier on a dispatch", () => {
    const runs = ciTestsRuns(jobBlock(yml, "idle"));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain(
      "--tier ${{ github.event_name == 'workflow_dispatch' && 'full' || 'essential' }}"
    );
  });

  test("the Linux rest slices run on every pull request: essential tier, full on a dispatch", () => {
    const block = jobBlock(yml, "rest");
    expect(block).toContain("runs-on: ubuntu-latest");
    expect(block).not.toMatch(/^ {4}if:/m);
    const runs = ciTestsRuns(block);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain("--run rest@${{ matrix.slice }}/4");
    expect(runs[0]).toContain(
      "--tier ${{ github.event_name == 'workflow_dispatch' && 'full' || 'essential' }}"
    );
    expect(bunPinOf(yml, "rest")).toBe(bunPinOf(yml, "idle") as string);
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

  test("runs the full tier of the idle slices, with the Bun test.yml pins", () => {
    const runs = ciTestsRuns(jobBlock(text, "idle"));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain("--run idle@${{ matrix.slice }}/3 --tier full");
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

  test("every Linux ci-tests.ts job of test.yml runs here in the full tier, same slices and Bun", () => {
    // biome-ignore lint/suspicious/noExplicitAny: a parsed workflow is untyped YAML
    const prJobs = (Bun.YAML.parse(testYml) as any).jobs as Record<string, any>;
    const linuxTiered = Object.keys(prJobs).filter(
      (job) =>
        String(prJobs[job]["runs-on"]).startsWith("ubuntu") &&
        ciTestsRuns(jobBlock(testYml, job)).length > 0
    );
    expect(linuxTiered).toEqual(["idle", "rest"]);
    for (const job of linuxTiered) {
      expect(wf.jobs[job]).toBeDefined();
      const runs = ciTestsRuns(jobBlock(text, job));
      expect(runs).toHaveLength(1);
      const slices = prJobs[job].strategy.matrix.slice as number[];
      expect(runs[0]).toContain(`--run ${job}@\${{ matrix.slice }}/${slices.length} --tier full`);
      expect(wf.jobs[job].strategy.matrix.slice).toEqual(slices);
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
