/**
 * #538 — FAILED models must carry the error details the MCP report renders.
 *
 * The report block in mcp-server.ts (`formatTeamResult`) reads
 * `m.error.{model, command, stderrSnippet, errorLogPath, workDir}` — but no
 * producer ever attached that field, so failed models were listed with state
 * and exit code only, and the stderr snippet the surrounding text promised
 * never appeared.
 *
 * Pins:
 *  - the producer (`failureDetails` + the runModels settle path), against
 *    values that are true at the instant the status is published: the real
 *    exit code, the drained stderr, and an error log that exists on disk;
 *  - the renderer (`formatTeamResult`), asserted **inside** the
 *    `## Failures Detected` block — the report's leading JSON dump embeds
 *    status.error, so whole-report assertions are satisfied whether or not
 *    the detail block renders anything;
 *  - the PATH-shim e2e runs on POSIX *and* win32 (a `claudish.cmd` batch on
 *    win32, the technique from #534's channel suite), so the mutants below
 *    are killed on every seat, not only where the shell script can execute.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import {
  failureDetails,
  setupSession,
  runModels,
  type TeamStatus,
  type ModelStatus,
} from "./team-orchestrator.js";
import { formatTeamResult } from "./mcp-server.js";

/**
 * #646 — since the spawn goes through `resolveClaudishSpawn` (claudish-spawn.ts),
 * the three `runModels` cases below run on POSIX *and* win32: on win32 the
 * resolver finds this suite's `claudish.cmd` fake and drives it through
 * `cmd.exe /d /s /c`, which is exactly the npm-global install shape that the
 * old bare `spawn("claudish")` could not reach (ENOENT under bun, EINVAL under
 * node — measured 2026-10-24). The win32-only refusal case (no executable on
 * PATH at all) is pinned further down via `itWin32`.
 */
const itWin32 = process.platform === "win32" ? it : it.skip;


// ─── Unit: failureDetails (the producer) ─────────────────────────────────────

describe("#538 failureDetails", () => {
  const args = ["--model", "or@deepseek/deepseek-r1", "-y", "--stdin", "--quiet"];

  it("carries the five fields the MCP report renders", () => {
    const d = failureDetails({ model: "or@deepseek/deepseek-r1" }, args, "boom", "/s/errors/01.log", "/s");
    expect(d.model).toBe("or@deepseek/deepseek-r1");
    expect(d.command).toBe("claudish --model or@deepseek/deepseek-r1 -y --stdin --quiet");
    expect(d.stderrSnippet).toBe("boom");
    expect(d.errorLogPath).toBe("/s/errors/01.log");
    expect(d.workDir).toBe("/s");
  });

  it("bounds the stderr snippet (full stderr lives in the log, not in status.json)", () => {
    const long = "x".repeat(5_000);
    const d = failureDetails({ model: "m" }, args, long, "/log", "/s");
    expect(d.stderrSnippet.length).toBeLessThanOrEqual(500);
    expect(d.stderrSnippet).toBe(long.slice(0, 500));
  });

  it("keeps an empty snippet well-formed (failed run with no stderr)", () => {
    const d = failureDetails({ model: "m" }, args, "", "/log", "/s");
    expect(d.stderrSnippet).toBe("");
  });
});

// ─── Unit: formatTeamResult (the renderer) ───────────────────────────────────

describe("#538 formatTeamResult renders failure details", () => {
  const failed: ModelStatus = {
    state: "FAILED",
    exitCode: 3,
    startedAt: "2026-10-20T00:00:00Z",
    completedAt: "2026-10-20T00:00:05Z",
    outputSize: 0,
    error: {
      model: "or@deepseek/deepseek-r1",
      command: "claudish --model or@deepseek/deepseek-r1 -y --stdin --quiet",
      stderrSnippet: "provider quota exhausted",
      errorLogPath: "/sess/errors/01.log",
      workDir: "/sess",
    },
  };
  const timedOut: ModelStatus = {
    state: "TIMEOUT",
    exitCode: null,
    startedAt: "2026-10-20T00:00:00Z",
    completedAt: "2026-10-20T00:05:00Z",
    outputSize: 12,
  };
  const ok: ModelStatus = {
    state: "COMPLETED",
    exitCode: 0,
    startedAt: "2026-10-20T00:00:00Z",
    completedAt: "2026-10-20T00:00:05Z",
    outputSize: 800,
  };

  // Assert on the detail block only — the JSON dump at the head of the report
  // embeds status.error, so whole-report contains() checks are vacuous.
  const failureBlock = (out: string): string => {
    const i = out.indexOf("## Failures Detected");
    expect(i).toBeGreaterThanOrEqual(0);
    return out.slice(i);
  };

  it("renders model, command, snippet, log path and workDir inside the failure block", () => {
    const status: TeamStatus = { startedAt: "t", models: { "01": failed, "02": ok } };
    const block = failureBlock(formatTeamResult(status, "/sess"));
    expect(block).toContain("### Model 01: FAILED");
    expect(block).toContain("- **Model:** or@deepseek/deepseek-r1");
    expect(block).toContain("- **Command:** `claudish --model or@deepseek/deepseek-r1");
    expect(block).toContain("- **Exit code:** 3");
    expect(block).toContain("- **Error output:**");
    expect(block).toContain("provider quota exhausted");
    expect(block).toContain("- **Full error log:** /sess/errors/01.log");
    expect(block).toContain("- **Working directory:** /sess");
  });

  it("does not crash or invent details for a TIMEOUT without error details", () => {
    const status: TeamStatus = { startedAt: "t", models: { "01": timedOut, "02": ok } };
    const block = failureBlock(formatTeamResult(status, "/sess"));
    expect(block).toContain("Model 01: TIMEOUT");
    expect(block).not.toContain("**Error output:**");
    expect(block).not.toContain("**Full error log:**");
  });

  it("advertises no log path when the producer could not write one", () => {
    const noLog: ModelStatus = {
      ...failed,
      error: { ...failed.error!, errorLogPath: "" },
    };
    const block = failureBlock(formatTeamResult({ startedAt: "t", models: { "01": noLog } }, "/sess"));
    expect(block).not.toContain("**Full error log:**");
    // the rest of the details survive — the report still says what failed
    expect(block).toContain("- **Model:** or@deepseek/deepseek-r1");
  });

  it("sanitizes the captured stderr before rendering it", () => {
    const leaky: ModelStatus = {
      ...failed,
      error: { ...failed.error!, stderrSnippet: "auth failed: sk-abcdefgh12345678 for user a@b.co" },
    };
    const block = failureBlock(formatTeamResult({ startedAt: "t", models: { "01": leaky } }, "/sess"));
    expect(block).not.toContain("sk-abcdefgh12345678");
    expect(block).not.toContain("a@b.co");
    expect(block).toContain("REDACTED");
  });

  it("no failure section when everything completed", () => {
    const status: TeamStatus = { startedAt: "t", models: { "01": ok } };
    expect(formatTeamResult(status, "/sess")).not.toContain("## Failures Detected");
  });
});

// ─── E2E: the real spawn path settles before publishing (POSIX + win32) ─────

interface FakeOptions {
  exitCode: number;
  stderr?: string;
}

/**
 * Install a fake `claudish` at the head of PATH. win32 gets a `claudish.cmd`
 * batch; POSIX gets a `#!/bin/sh` script. Both consume stdin to EOF first, so
 * the parent's stdin write cannot EPIPE.
 *
 * The win32 branch is reachable since #646: `resolveClaudishSpawn` finds the
 * `claudish.cmd` on PATH and spawns it through `cmd.exe /d /s /c` with every
 * argument quoted — the npm-global install shape. `findstr "^"` consumes
 * stdin to EOF under that wrapper exactly as `cat` does on POSIX.
 */
async function withFakeClaudish(opts: FakeOptions, body: () => Promise<void>): Promise<void> {
  const fakeDir = mkdtempSync(join(tmpdir(), "fake-claudish-538-"));
  const originalPath = process.env.PATH;
  try {
    if (process.platform === "win32") {
      const lines = ["@echo off", 'findstr "^" >nul'];
      if (opts.stderr) lines.push(`echo ${opts.stderr} 1>&2`);
      lines.push(`exit /b ${opts.exitCode}`);
      writeFileSync(join(fakeDir, "claudish.cmd"), `${lines.join("\r\n")}\r\n`, "utf-8");
    } else {
      const script = join(fakeDir, "claudish");
      writeFileSync(
        script,
        `#!/bin/sh\ncat > /dev/null\n${opts.stderr ? `echo ${JSON.stringify(opts.stderr)} 1>&2\n` : ""}exit ${opts.exitCode}\n`,
        "utf-8"
      );
      chmodSync(script, 0o755);
    }
    process.env.PATH = `${fakeDir}${delimiter}${originalPath}`;
    // `await` is load-bearing: returning the promise would run the finally
    // (PATH restore + shim removal) before the body's runModels finishes.
    await body();
  } finally {
    process.env.PATH = originalPath;
    rmSync(fakeDir, { recursive: true, force: true });
  }
}

async function runWithFake(opts: FakeOptions) {
  const tempDir = mkdtempSync(join(tmpdir(), "team-538-"));
  try {
    let status: TeamStatus | null = null;
    await withFakeClaudish(opts, async () => {
      setupSession(tempDir, ["failing-model"], "Say hello");
      status = await runModels(tempDir, { timeout: 10 });
    });
    const m = Object.values(status!.models)[0];
    return { m, sessionDir: tempDir, cleanup: () => rmSync(tempDir, { recursive: true, force: true }) };
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }
}

describe("#538 runModels settles with true values before publishing", () => {
  it("a non-zero exit records the REAL exit code and a log that exists at resolve", async () => {
    const { m, cleanup } = await runWithFake({ exitCode: 3, stderr: "538-stderr-marker: provider blew up" });
    try {
      expect(m.state).toBe("FAILED");
      // The settle waits for the child, so the exit code is not the `?? 1` fallback.
      expect(m.exitCode).toBe(3);
      expect(m.error).toBeDefined();
      expect(m.error!.model).toBe("failing-model");
      expect(m.error!.command).toContain("--model failing-model");
      expect(m.error!.stderrSnippet).toContain("538-stderr-marker");
      expect(m.error!.workDir).toBe(process.cwd());
      // Advertised path exists at resolve, and holds the full stderr.
      expect(m.error!.errorLogPath).not.toBe("");
      expect(existsSync(m.error!.errorLogPath)).toBe(true);
      expect(readFileSync(m.error!.errorLogPath, "utf-8")).toContain("538-stderr-marker");
    } finally {
      cleanup();
    }
  }, 30_000);

  it("a failure with EMPTY stderr still writes the advertised log (mutant 4)", async () => {
    const { m, cleanup } = await runWithFake({ exitCode: 3 });
    try {
      expect(m.state).toBe("FAILED");
      expect(m.exitCode).toBe(3);
      expect(m.error).toBeDefined();
      expect(m.error!.stderrSnippet).toBe("");
      expect(m.error!.errorLogPath).not.toBe("");
      expect(existsSync(m.error!.errorLogPath)).toBe(true);
      expect(readFileSync(m.error!.errorLogPath, "utf-8")).toBe("");
    } finally {
      cleanup();
    }
  }, 30_000);

  it("an exit-0 child settles COMPLETED with no error and no log", async () => {
    const { m, sessionDir, cleanup } = await runWithFake({ exitCode: 0 });
    try {
      // Before the settle fix this child was recorded FAILED with exitCode 1
      // in 30/30 runs (stdout close won the race), with a dangling log path.
      expect(m.state).toBe("COMPLETED");
      expect(m.exitCode).toBe(0);
      expect(m.error).toBeUndefined();
      expect(existsSync(join(sessionDir, "errors", "01.log"))).toBe(false);
    } finally {
      cleanup();
    }
  }, 30_000);
});

// ─── #646 — a Windows seat with no claudish on PATH refuses naming it ────────
// The old code's spawn failure surfaced as FAILED/exit-1 with EMPTY stderr —
// indistinguishable from the model itself crashing on startup. The acceptance
// for #646: such a seat either works or is refused with a message naming the
// executable forms the resolver looked for. (POSIX keeps the bare spawn, so
// this pin is win32-only.)
describe("#646 win32 executable resolution", () => {
  itWin32("no claudish anywhere on PATH fails the model naming the executable forms", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "team-646-"));
    const originalPath = process.env.PATH;
    try {
      setupSession(tempDir, ["no-shim-model"], "Say hello");
      process.env.PATH = ""; // nothing resolvable in any PATH entry
      try {
        const status = await runModels(tempDir, { timeout: 10 });
        const m = status.models["01"];
        expect(m).toBeDefined();
        expect(m!.state).toBe("FAILED");
        expect(m!.exitCode).toBe(1);
        expect(m!.error).toBeDefined();
        // The refusal names every executable form the resolver looked for.
        expect(m!.error!.stderrSnippet).toContain("claudish.exe");
        expect(m!.error!.stderrSnippet).toContain("claudish.cmd");
        expect(m!.error!.stderrSnippet).toContain("claudish.bat");
        expect(m!.error!.command).toContain("--model no-shim-model");
        // Same contract as any FAILED run: the advertised log exists and
        // holds the full refusal text.
        expect(m!.error!.errorLogPath).not.toBe("");
        expect(existsSync(m!.error!.errorLogPath)).toBe(true);
        expect(readFileSync(m!.error!.errorLogPath, "utf-8")).toContain("claudish.exe");
      } finally {
        process.env.PATH = originalPath;
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);
});
