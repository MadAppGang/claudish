import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERMETIC_RUNS, bunPinOf, compareVersions, runSteps, startStep } from "./test-macos.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "test-macos-test-"));
}

const WORKFLOW = readFileSync(
  join(import.meta.dir, "..", ".github", "workflows", "test.yml"),
  "utf8"
);

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

describe("compareVersions", () => {
  test("orders dotted numbers numerically", () => {
    expect(compareVersions("0.19.0", "0.19.0")).toBe(0);
    expect(compareVersions("0.9.0", "0.19.0")).toBe(-1);
    expect(compareVersions("0.20.0", "0.19.0")).toBe(1);
  });
});
