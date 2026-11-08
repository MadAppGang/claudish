import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface ProbeOutcome {
  status: "fulfilled" | "rejected";
  elapsedMs: number;
  unavailable?: boolean;
  message?: string;
  result?: { binary: string; version: string };
}

interface ProbeReport {
  runs: number;
  outcomes: ProbeOutcome[];
}

interface ProbeLayout {
  root: string;
  binary: string;
  runs: string;
  pids: string;
  runner: string;
  report: string;
  child?: ReturnType<typeof Bun.spawn>;
}

const layouts: ProbeLayout[] = [];
const probeModule = new URL("./pane-launch.ts", import.meta.url).href;
const version = "999.0.0";

const runnerSource = `
import { readFileSync, writeFileSync } from "node:fs";
import { assertMagmuxAvailable, MagmuxUnavailableError } from ${JSON.stringify(probeModule)};

const [scenario, binary, runs, report] = process.argv.slice(2);
const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
const runCount = () => readFileSync(runs, "utf8").split("\\n").filter(Boolean).length;

function probe() {
  const started = performance.now();
  return assertMagmuxAvailable(binary).then(
    (result) => ({ status: "fulfilled", elapsedMs: performance.now() - started, result }),
    (error) => ({
      status: "rejected",
      elapsedMs: performance.now() - started,
      unavailable: error instanceof MagmuxUnavailableError,
      message: error instanceof Error ? error.message : String(error),
    })
  );
}

let outcomes = [];
if (scenario === "deadline") {
  outcomes = [await probe()];
} else if (scenario === "retry") {
  let first;
  const started = performance.now();
  const firstProbe = probe().then((outcome) => { first = outcome; });
  // Arrive after rejection normally; at 8 s a broken probe is still pending.
  while (!first && performance.now() - started < 8000) await pause();
  const secondProbe = probe();
  const retryStarted = performance.now();
  while (runCount() < 2 && performance.now() - retryStarted < 750) await pause();
  if (first) outcomes.push(first);
  void firstProbe;
  void secondProbe;
} else if (scenario === "concurrent") {
  outcomes = await Promise.all([probe(), probe()]);
} else if (scenario === "success") {
  outcomes = [await probe(), await probe()];
} else {
  throw new Error("Unknown probe scenario: " + scenario);
}

writeFileSync(report, JSON.stringify({ runs: runCount(), outcomes }));
process.exit(0);
`;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function makeProbe(stuck = true): ProbeLayout {
  const root = mkdtempSync(join(tmpdir(), "magmux-stuck-probe-"));
  const layout: ProbeLayout = {
    root,
    binary: join(root, "magmux"),
    runs: join(root, "runs"),
    pids: join(root, "pids"),
    runner: join(root, "probe.ts"),
    report: join(root, "report.json"),
  };
  layouts.push(layout);
  writeFileSync(layout.runs, "");
  writeFileSync(layout.pids, "");
  // The real 15 s sleep and ignored TERM reproduce the owner's CI defect.
  writeFileSync(
    layout.binary,
    `#!/bin/sh
trap '' TERM
printf '%s\\n' "$$" >> ${shellQuote(layout.pids)}
printf 'run\\n' >> ${shellQuote(layout.runs)}
${
  stuck
    ? `/bin/sleep 15 &
sleeper=$!
printf '%s\\n' "$sleeper" >> ${shellQuote(layout.pids)}
wait "$sleeper"
`
    : ""
}printf 'magmux ${version}\\n'
`
  );
  chmodSync(layout.binary, 0o700);
  writeFileSync(layout.runner, runnerSource);
  return layout;
}

async function runScenario(layout: ProbeLayout, scenario: string): Promise<ProbeReport> {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      layout.runner,
      scenario,
      layout.binary,
      layout.runs,
      layout.report,
    ],
    {
      cwd: layout.root,
      env: {
        HOME: layout.root,
        CLAUDE_CONFIG_DIR: layout.root,
        XDG_CONFIG_HOME: layout.root,
        ZDOTDIR: layout.root,
        PATH: "/usr/bin:/bin",
        CLAUDISH_DISABLE_KEYCHAIN: "1",
        CLAUDISH_DISABLE_OP: "1",
        CLAUDISH_DISABLE_CATALOG_WARM: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  layout.child = child;
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });
  return JSON.parse(readFileSync(layout.report, "utf8")) as ProbeReport;
}

async function killLeftovers(): Promise<void> {
  for (const layout of layouts) {
    if (layout.child) {
      if (layout.child.exitCode === null) layout.child.kill("SIGKILL");
      await layout.child.exited;
    }
    if (!existsSync(layout.pids)) continue;
    const pids = readFileSync(layout.pids, "utf8").split("\n").filter(Boolean).map(Number);
    for (const pid of pids.reverse()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    writeFileSync(layout.pids, "");
  }
}

afterEach(killLeftovers);
afterAll(async () => {
  await killLeftovers();
  for (const layout of layouts) rmSync(layout.root, { recursive: true, force: true });
});

describe("assertMagmuxAvailable with a SIGTERM-ignoring binary", () => {
  test("G1 rejects with MagmuxUnavailableError before 8 s instead of waiting for child exit", async () => {
    const report = await runScenario(makeProbe(), "deadline");
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0].elapsedMs).toBeLessThan(8000);
    expect(report.outcomes[0]).toMatchObject({ status: "rejected", unavailable: true });
    expect(report.outcomes[0].message).toContain("no answer in");
    expect(report.runs).toBe(1);
  }, 20_000);

  test("G2 starts a new binary run for a caller arriving after the failed probe deadline", async () => {
    const report = await runScenario(makeProbe(), "retry");
    expect(report.runs).toBe(2);
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0]).toMatchObject({ status: "rejected", unavailable: true });
    expect(report.outcomes[0].message).toContain("no answer in");
  }, 20_000);

  test("G3 concurrent callers share one binary run and both reject", async () => {
    const report = await runScenario(makeProbe(), "concurrent");
    expect(report.runs).toBe(1);
    expect(report.outcomes).toHaveLength(2);
    for (const outcome of report.outcomes) {
      expect(outcome).toMatchObject({ status: "rejected", unavailable: true });
      expect(outcome.message).toContain("no answer in");
    }
  }, 20_000);

  test("successful probes remain cached for later callers", async () => {
    const layout = makeProbe(false);
    const report = await runScenario(layout, "success");
    expect(report.runs).toBe(1);
    expect(report.outcomes).toHaveLength(2);
    for (const outcome of report.outcomes) {
      expect(outcome).toMatchObject({
        status: "fulfilled",
        result: { binary: layout.binary, version },
      });
    }
  }, 20_000);
});
