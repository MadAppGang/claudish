/**
 * CLI team mode/input regressions through the real entry, with the signal test's
 * hermetic pane environment and fake interactive child. No real model is called.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupSession } from "./team-orchestrator.js";
import {
  MAGMUX,
  NO_MAGMUX_MESSAGE,
  type PaneTestEnv,
  finishPaneTest,
  makePaneTestEnv,
} from "./test-helpers/team-pane.js";

if (!MAGMUX) console.warn(NO_MAGMUX_MESSAGE);

const ENTRY = join(import.meta.dir, "index.ts");
const TASK = Buffer.from("Review the team CLI mode and input handling.\n", "utf8");

let t: PaneTestEnv;

beforeEach(() => {
  t = makePaneTestEnv({ CONTRACT_FAKE_MAX_MS: "60000" });
});

afterEach(async () => {
  const report = await finishPaneTest(t);
  expect(report).toEqual({ processes: [], files: [] });
});

async function runCli(cwd: string, sessionPath: string, extraArgs: string[] = []) {
  // Grid commands invoke `claudish` by name rather than CLAUDISH_BIN. Keep that
  // path hermetic too: forward it to the same fake child used by the pane path.
  const binDir = join(t.tmp, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "claudish"),
    `#!${process.execPath}
const fake = process.env.CLAUDISH_BIN;
if (!fake) process.exit(70);
const proc = Bun.spawn([fake, ...process.argv.slice(2)], {
  env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
});
process.exit(await proc.exited);
`,
    { mode: 0o755 }
  );

  const proc = Bun.spawn(
    [
      process.execPath,
      ENTRY,
      "team",
      "run",
      "--path",
      sessionPath,
      "--models",
      "contract-fake-a",
      // Bound only the defective grid path; pane mode does not use this timeout.
      "--timeout",
      "1",
      ...extraArgs,
    ],
    {
      cwd,
      env: { ...t.env, PATH: `${binDir}:${t.env.PATH ?? ""}` },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const code = await Promise.race([
      proc.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("team run did not exit within 30 s")), 30_000);
      }),
    ]);
    return { code, stdout: await stdout, stderr: await stderr };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (proc.exitCode === null) proc.kill("SIGKILL");
    await proc.exited;
  }
}

describe.skipIf(!MAGMUX)("claudish team run — mode and existing input", () => {
  it("bare run uses panes and preserves input.md byte for byte", async () => {
    // REGRESSION: claudish team run without --grid ran the grid and emptied input.md — Fixed in /dev:fix session dev-fix-20261016-224933-5e5cb5a4
    // validateSessionPath requires the session under the CLI's cwd.
    const cwd = join(t.tmp, "work");
    const sessionPath = join(cwd, "review");
    mkdirSync(sessionPath, { recursive: true });
    writeFileSync(join(sessionPath, "input.md"), TASK);

    await runCli(cwd, sessionPath);

    const status = JSON.parse(readFileSync(join(sessionPath, "status.json"), "utf8")) as {
      models: Record<string, { pane?: unknown }>;
    };
    const rows = Object.values(status.models);
    expect(rows).toHaveLength(1);
    expect({
      gridfileExists: existsSync(join(sessionPath, "gridfile.txt")),
      pane: rows[0]?.pane ?? null,
      inputBytes: readFileSync(join(sessionPath, "input.md")).toString("hex"),
    }).toEqual({
      gridfileExists: false,
      pane: expect.anything(),
      inputBytes: TASK.toString("hex"),
    });
  }, 60_000);

  it("refuses an unknown mode with exit 2 before writing session files", async () => {
    // REGRESSION: claudish team run without --grid ran the grid and emptied input.md — Fixed in /dev:fix session dev-fix-20261016-224933-5e5cb5a4
    const cwd = join(t.tmp, "work");
    mkdirSync(cwd, { recursive: true });
    const sessionPath = join(cwd, "review");

    const result = await runCli(cwd, sessionPath, ["--mode", "bogus"]);
    const errorOutput = `${result.stderr}\n${result.stdout}`;

    expect({
      code: result.code,
      namesDefault: /\bdefault\b/.test(errorOutput),
      namesInteractive: /\binteractive\b/.test(errorOutput),
      namesJson: /\bjson\b/.test(errorOutput),
      manifestExists: existsSync(join(sessionPath, "manifest.json")),
      statusExists: existsSync(join(sessionPath, "status.json")),
    }).toEqual({
      code: 2,
      namesDefault: true,
      namesInteractive: true,
      namesJson: true,
      manifestExists: false,
      statusExists: false,
    });
  }, 60_000);
});

it("setupSession keeps absent input; explicit empty input documents the grid call-site hazard", () => {
  // REGRESSION: claudish team run without --grid ran the grid and emptied input.md — Fixed in /dev:fix session dev-fix-20261016-224933-5e5cb5a4
  const absentPath = join(t.tmp, "absent-input");
  const emptyPath = join(t.tmp, "empty-input");
  for (const sessionPath of [absentPath, emptyPath]) {
    mkdirSync(sessionPath, { recursive: true });
    writeFileSync(join(sessionPath, "input.md"), TASK);
  }

  setupSession(absentPath, ["contract-fake-a"], undefined);
  expect(readFileSync(join(absentPath, "input.md"))).toEqual(TASK);

  // Documents the call-site hazard, not desired absent-input behaviour: today's
  // grid caller passes input ?? "", which explicitly replaces the existing task.
  setupSession(emptyPath, ["contract-fake-a"], "");
  expect(readFileSync(join(emptyPath, "input.md"))).toEqual(Buffer.alloc(0));
});
