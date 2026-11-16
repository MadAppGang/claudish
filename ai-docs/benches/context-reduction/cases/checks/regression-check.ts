// Grades the regression test of the topic-change case: the test the agent
// wrote, in a later turn, for its own fix of the Gemini tool-output order.
//
// madbench starts this program with the Check envelope on stdin. The test
// file has a fixed name, given in the prompt. Three parts, each one third of
// the score; pass only when all three hold:
//   1. the file exists and declares at least one test;
//   2. it passes on the workspace as the agent left it;
//   3. it fails when gemini-api-format.ts is the snapshot's unfixed file.
//
// Part 3 never touches the workspace, because other checks read it and
// madbench does not promise an order. It copies packages/cli/src (with
// package.json and tsconfig.json) into a scratch folder inside packages/cli,
// so imports still resolve through packages/cli/node_modules. In that copy
// the test must first pass with the agent's file (else the copy itself is
// broken and nothing is proven), then fail with the unfixed one.
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

type Envelope = { session?: { work_dir?: string }; work_dir?: string };

const TEST = "src/adapters/gemini-parallel-tool-order.test.ts";
const SOURCE = "src/adapters/gemini-api-format.ts";
const UNFIXED = join(import.meta.dir, "../hidden-tests/topic-change/gemini-api-format.ts.unfixed");

function emit(pass: boolean, score: number, reason: string, evidence: Record<string, unknown>): never {
  console.log(JSON.stringify({ pass, score, reason, evidence }));
  process.exit(0);
}

function run(cwd: string) {
  const r = spawnSync("bun", ["test", TEST], { cwd, encoding: "utf8", timeout: 300_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const pass = Number(out.match(/(\d+) pass/)?.[1] ?? 0);
  const fail = Number(out.match(/(\d+) fail/)?.[1] ?? 0);
  return { code: r.status, pass, fail, tail: out.trim().split("\n").slice(-6).join("\n") };
}

const envelope = JSON.parse(await Bun.stdin.text()) as Envelope;
const workDir = envelope.session?.work_dir ?? envelope.work_dir;
if (!workDir) emit(false, 0, "the envelope names no work_dir", {});

const cli = join(workDir, "packages/cli");
const testPath = join(cli, TEST);
if (!existsSync(testPath)) emit(false, 0, `no ${TEST}`, {});
const declares = /\b(test|it)\s*\(/.test(readFileSync(testPath, "utf8"));
if (!declares) emit(false, 1 / 3, `${TEST} declares no test`, {});

const workspace = run(cli);
const passesHere = workspace.code === 0 && workspace.pass > 0 && workspace.fail === 0;

const scratch = join(cli, `.regression-grade-${process.pid}`);
const notRun: ReturnType<typeof run> = { code: null, pass: 0, fail: 0, tail: "not run" };
let copyFixed = notRun;
let copyUnfixed = notRun;
try {
  cpSync(join(cli, "src"), join(scratch, "src"), { recursive: true });
  for (const f of ["package.json", "tsconfig.json"]) if (existsSync(join(cli, f))) copyFileSync(join(cli, f), join(scratch, f));
  copyFixed = run(scratch);
  copyFileSync(UNFIXED, join(scratch, SOURCE));
  copyUnfixed = run(scratch);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const copyWorks = copyFixed.code === 0 && copyFixed.pass > 0 && copyFixed.fail === 0;
const catches = copyWorks && copyUnfixed.code !== 0 && copyUnfixed.fail > 0;
const score = (1 + (passesHere ? 1 : 0) + (catches ? 1 : 0)) / 3;
const reason = !passesHere
  ? "the test does not pass on the workspace"
  : !copyWorks
    ? "the scratch copy did not run the test green, so the unfixed run proves nothing"
    : !catches
      ? "the test still passes with the unfixed gemini-api-format.ts"
      : "the test passes with the fix and fails without it";
emit(passesHere && catches, score, reason, { workspace, copyFixed, copyUnfixed });
