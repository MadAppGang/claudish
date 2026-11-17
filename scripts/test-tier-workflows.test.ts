/**
 * Which test tier each workflow runs: pull requests and pushes run the essential tier, a manual
 * dispatch runs the full tier (packages/cli/scripts/ci-tests.ts, test-tiers.json).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

  test("the dispatched macOS hermetic runners run the full tier", () => {
    const block = jobBlock(yml, "hermetic");
    expect(block).toContain("if: github.event_name == 'workflow_dispatch'");
    const runs = ciTestsRuns(block);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain("--tier full");
  });
});