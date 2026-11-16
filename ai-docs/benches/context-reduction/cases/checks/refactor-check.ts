// Grades the refactor case: nativeRouteFor renamed to claudeSubscriptionRoute
// and moved to packages/cli/src/providers/claude-subscription-route.ts.
//
// madbench starts this program with the Check envelope on stdin. Five parts,
// each worth one fifth of the score; pass only when all five hold:
//   1. the old name appears nowhere under packages/cli/src;
//   2. the new module exports `function claudeSubscriptionRoute(`;
//   3. native-route.ts neither defines nor re-exports it;
//   4. `bun run typecheck` in packages/cli exits 0;
//   5. the tests that used the function, plus any test naming the new one,
//      pass (`bun test`, 0 fail).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

type Envelope = { session?: { work_dir?: string }; work_dir?: string };

const OLD = "nativeRouteFor";
const NEW = "claudeSubscriptionRoute";
// The test files that used the function at 533e4233; 118 tests there.
const TESTS = [
  "src/grammar.behaviour.test.ts",
  "src/pane/accounting.test.ts",
  "src/auth/credentials/prehydrate.test.ts",
  "src/providers/native-route.test.ts",
];

function emit(pass: boolean, score: number, reason: string, evidence: Record<string, unknown>): never {
  console.log(JSON.stringify({ pass, score, reason, evidence }));
  process.exit(0);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const envelope = JSON.parse(await Bun.stdin.text()) as Envelope;
const workDir = envelope.session?.work_dir ?? envelope.work_dir;
if (!workDir) emit(false, 0, "the envelope names no work_dir", {});

const cli = join(workDir, "packages/cli");
const src = join(cli, "src");
const files = walk(src);
const oldWord = new RegExp(`\\b${OLD}\\b`);
const oldLeft = files.filter((f) => oldWord.test(readFileSync(f, "utf8"))).map((f) => relative(workDir, f));

const modulePath = join(src, "providers/claude-subscription-route.ts");
const moduleOk =
  existsSync(modulePath) && new RegExp(`export\\s+(async\\s+)?function\\s+${NEW}\\s*\\(`).test(readFileSync(modulePath, "utf8"));

const nativeRoute = readFileSync(join(src, "providers/native-route.ts"), "utf8");
const notInOld =
  !new RegExp(`function\\s+${NEW}\\b`).test(nativeRoute) &&
  !new RegExp(`export\\s*(type\\s*)?\\{[^}]*\\b${NEW}\\b[^}]*\\}`).test(nativeRoute) &&
  !/export\s*\*\s*from/.test(nativeRoute);

const tc = spawnSync("bun", ["run", "typecheck"], { cwd: cli, encoding: "utf8", timeout: 300_000 });
const typecheckOk = tc.status === 0;

const newWord = new RegExp(`\\b${NEW}\\b`);
const extraTests = files
  .filter((f) => f.endsWith(".test.ts") && newWord.test(readFileSync(f, "utf8")))
  .map((f) => relative(cli, f));
const testList = [...new Set([...TESTS, ...extraTests])].filter((t) => existsSync(join(cli, t)));
const run = spawnSync("bun", ["test", ...testList], { cwd: cli, encoding: "utf8", timeout: 300_000 });
const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
const count = (label: string) => Number(out.match(new RegExp(`^\\s*(\\d+) ${label}\\s*$`, "m"))?.[1] ?? 0);
const passed = count("pass");
const failed = count("fail");
const testsOk = run.status === 0 && failed === 0 && passed >= 118 && testList.length >= TESTS.length;

const parts = {
  old_name_gone: oldLeft.length === 0,
  new_module_exports: moduleOk,
  not_left_in_native_route: notInOld,
  typecheck: typecheckOk,
  tests: testsOk,
};
const right = Object.values(parts).filter(Boolean).length;
emit(right === 5, right / 5, `refactor: ${right} of 5 parts hold; tests ${passed} pass, ${failed} fail`, {
  parts,
  old_name_files: oldLeft.slice(0, 20),
  tests_run: testList,
  typecheck_tail: typecheckOk ? "" : `${tc.stdout ?? ""}${tc.stderr ?? ""}`.slice(-1200),
  tests_tail: testsOk ? "" : out.slice(-1200),
});
