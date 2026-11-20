// Grades the finished workspace against the feature's own tests.
//
// madbench starts this program with the Check envelope on stdin. It runs
// ../grade.sh on the workspace the envelope names and prints one Check result:
// pass when every hidden test passed, score as the share of tests that passed.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

type Envelope = { session?: { work_dir?: string }; work_dir?: string };

const TOTAL_TESTS = 114;

function emit(
  pass: boolean,
  score: number,
  reason: string,
  evidence: Record<string, unknown>
): never {
  console.log(JSON.stringify({ pass, score, reason, evidence }));
  process.exit(0);
}

const envelope = JSON.parse(await Bun.stdin.text()) as Envelope;
const workDir = envelope.session?.work_dir ?? envelope.work_dir;
if (!workDir) {
  emit(false, 0, "the envelope names no work_dir", {});
}

const gradeScript = join(dirname(import.meta.dir), "grade.sh");
const run = spawnSync("sh", [gradeScript, workDir], { encoding: "utf8", timeout: 540_000 });
const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;

const count = (label: string): number => {
  const found = output.match(new RegExp(`^\\s*(\\d+) ${label}\\s*$`, "m"));
  return found ? Number(found[1]) : 0;
};
const passed = count("pass");
const failed = count("fail");
const exit = run.status ?? -1;
const pass = exit === 0 && failed === 0 && passed > 0;
// A test file that cannot load counts no tests, so the share is taken of the
// known total, never of the tests that happened to run.
const score = pass ? 1 : Math.min(passed / TOTAL_TESTS, 0.99);

emit(pass, score, `hidden tests: ${passed} pass, ${failed} fail, exit ${exit}`, {
  passed,
  failed,
  exit,
  total: TOTAL_TESTS,
  tail: keptTail(output),
});

/**
 * What the report keeps of the test output: every "(fail)" line and every
 * error line, wherever it is, then the last 1,500 characters. A long run
 * pushes its first failures out of the last 1,500 characters, and a test file
 * that cannot load names its cause only near the top of the output.
 */
function keptTail(text: string): string {
  const failures = text
    .split("\n")
    .filter((line) => /^\(fail\) |^# Unhandled error|^\s*error:|^\s*[A-Z]\w*Error:/.test(line));
  const last = text.slice(-1500);
  if (failures.length === 0) return last;
  return `${failures.join("\n")}\n--- last 1500 characters ---\n${last}`;
}
