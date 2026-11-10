import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slowestReport } from "./ci-tests";

const SCRIPT = join(import.meta.dir, "ci-tests.ts");
const dir = mkdtempSync(join(tmpdir(), "ci-tests-local-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("slowestReport", () => {
  test("lists the slowest files first, with the total over every file", () => {
    const lines = slowestReport({ "a.test.ts": 1.25, "b.test.ts": 30, "c.test.ts": 4 }, 2);
    expect(lines).toEqual([
      "[ci-tests] slowest 2 of 3 test files, 35.3 s in all:",
      "   30.0 s  b.test.ts",
      "    4.0 s  c.test.ts",
    ]);
  });

  test("an empty report says so instead of printing a header over nothing", () => {
    expect(slowestReport({}, 5)).toEqual(["[ci-tests] no test file timings in the junit report"]);
  });
});

// A `--local` that ignored its file would run this whole package, this file included, and
// each copy would start another. The processes these tests start carry the marker, and a
// copy that has it skips these tests, so such a bug fails once instead of multiplying.
const NESTED = "CLAUDISH_CI_TESTS_NESTED";

describe.skipIf(process.env[NESTED] === "1")("--local", () => {
  async function local(body: string, name: string, dash = true) {
    const file = join(dir, `${name}.test.ts`);
    writeFileSync(file, `import { test } from "bun:test";\n${body}\n`);
    const out = join(dir, `${name}.xml`);
    const args = dash ? ["--local", out, "--", file] : ["--local", out, file];
    const proc = Bun.spawn([process.execPath, SCRIPT, ...args], {
      env: { ...process.env, [NESTED]: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, text: stdout + stderr, out };
  }

  test("writes the junit report and prints the per-file timing after a green run", async () => {
    const r = await local('test("ok", () => {});', "green");
    expect(r.code).toBe(0);
    expect(existsSync(r.out)).toBe(true);
    expect(r.text).toContain("[ci-tests] slowest 1 of 1 test files");
    expect(r.text).toContain("green.test.ts");
  }, 60_000);

  test("keeps bun test's exit code when a test fails, and still prints the timing", async () => {
    const r = await local('test("red", () => { throw new Error("red"); });', "red");
    expect(r.code).toBe(1);
    expect(r.text).toContain("[ci-tests] slowest 1 of 1 test files");
    expect(r.text).toContain("red.test.ts");
  }, 60_000);

  test("a run that writes no report never prints the previous run's report", async () => {
    const out = join(dir, "stale.xml");
    writeFileSync(
      out,
      '<testsuites><testsuite name="old-run.test.ts" file="old-run.test.ts"><testcase name="t" time="9"/></testsuite></testsuites>'
    );
    const proc = Bun.spawn(
      [process.execPath, SCRIPT, "--local", out, "--", join(dir, "missing.test.ts")],
      { env: { ...process.env, [NESTED]: "1" }, stdout: "pipe", stderr: "pipe" }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(1);
    expect(stdout + stderr).not.toContain("old-run.test.ts");
    expect(stdout + stderr).toContain("[ci-tests] no test file timings in the junit report");
  }, 60_000);

  test("passes a file given without `--` to bun test, as `bun run test <file>` does", async () => {
    const r = await local('test("ok", () => {});', "nodash", false);
    expect(r.code).toBe(0);
    expect(r.text).toContain("[ci-tests] slowest 1 of 1 test files");
  }, 60_000);
});
