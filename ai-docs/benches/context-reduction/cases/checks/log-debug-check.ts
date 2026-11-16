// Grades the log-heavy debugging case: the Gemini function-response order fix.
//
// madbench starts this program with the Check envelope on stdin. It copies the
// fix commit's own test file (../hidden-tests/log-debug, kept with a .hidden
// suffix so no test runner here picks it up) over the workspace's copy, then
// runs both Gemini format test files. Pass: every test passes. Score: the
// share of the 8 known tests that pass.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

type Envelope = { session?: { work_dir?: string }; work_dir?: string };

const TOTAL = 8;
const TESTS = ["src/adapters/gemini-api-format-tool-round.test.ts", "src/adapters/gemini-api-format-claude-budget.test.ts"];

function emit(pass: boolean, score: number, reason: string, evidence: Record<string, unknown>): never {
  console.log(JSON.stringify({ pass, score, reason, evidence }));
  process.exit(0);
}

const envelope = JSON.parse(await Bun.stdin.text()) as Envelope;
const workDir = envelope.session?.work_dir ?? envelope.work_dir;
if (!workDir) emit(false, 0, "the envelope names no work_dir", {});

const hidden = join(import.meta.dir, "../hidden-tests/log-debug");
const walk = (d: string, out: string[] = []): string[] => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".hidden")) out.push(p);
  }
  return out;
};
for (const f of walk(hidden)) {
  const dest = join(workDir, relative(hidden, f).replace(/\.hidden$/, ""));
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(f, dest);
}

const cli = join(workDir, "packages/cli");
const run = spawnSync("bun", ["test", ...TESTS], { cwd: cli, encoding: "utf8", timeout: 300_000 });
const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
const count = (label: string) => Number(out.match(new RegExp(`^\\s*(\\d+) ${label}\\s*$`, "m"))?.[1] ?? 0);
const passed = count("pass");
const failed = count("fail");
const pass = run.status === 0 && failed === 0 && passed >= TOTAL;
emit(pass, pass ? 1 : Math.min(passed / TOTAL, 0.99), `hidden tests: ${passed} pass, ${failed} fail, exit ${run.status}`, {
  passed,
  failed,
  tail: pass ? "" : out.slice(-1500),
});
