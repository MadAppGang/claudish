import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { statPathKind } from "./claude-runner.js";

let tmp: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "claudish-path-kind-")));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function mkfifo(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const made = Bun.spawnSync(["mkfifo", path]);
  expect(made.exitCode).toBe(0);
}

/** Runs `body` against the real claude-runner module in a child Bun, killed after 4 s. */
function runRunnerIsolated(body: string): { exitCode: number | null; stdout: string } {
  const modPath = join(import.meta.dir, "claude-runner.ts");
  const script = `const runner = await import(${JSON.stringify(modPath)});\n${body}\n`;
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    cwd: tmp,
    env: { PATH: process.env.PATH ?? "", HOME: join(tmp, "home") },
    timeout: 4000,
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString() };
}

/** A main checkout at tmp/main and a linked worktree at tmp/wt whose Git directory's `commondir` is a named pipe. */
function worktreeWithFifoCommondir(): { main: string; worktree: string } {
  const main = join(tmp, "main");
  const gitDir = join(main, ".git", "worktrees", "wt");
  mkdirSync(gitDir, { recursive: true });
  mkfifo(join(gitDir, "commondir"));
  mkdirSync(join(main, ".claude"), { recursive: true });
  writeFileSync(
    join(main, ".claude", "settings.local.json"),
    JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: "main-checkout-token" } })
  );
  const worktree = join(tmp, "wt");
  mkdirSync(worktree);
  writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
  return { main, worktree };
}

describe("statPathKind", () => {
  test("a directory is dir, a regular file is file, a missing path is undefined", () => {
    const file = join(tmp, "f.json");
    writeFileSync(file, "{}");

    expect([statPathKind(tmp), statPathKind(file), statPathKind(join(tmp, "missing"))]).toEqual([
      "dir",
      "file",
      undefined,
    ]);
  });

  test("a named pipe is not a file", () => {
    const fifo = join(tmp, "pipe");
    mkfifo(fifo);

    expect(statPathKind(fifo)).toBeUndefined();
  });
});

describe("the default settings path and a named-pipe commondir", () => {
  test("localSettingsFiles with the real statPathKind returns without reading the pipe", () => {
    const { worktree } = worktreeWithFifoCommondir();

    const run = runRunnerIsolated(
      [
        `const fs = await import("node:fs");`,
        `const files = runner.localSettingsFiles(${JSON.stringify(worktree)}, (p) => fs.readFileSync(p, "utf-8"), runner.statPathKind);`,
        "console.log(JSON.stringify(files));",
      ].join("\n")
    );

    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([
      [join(worktree, ".claude", "settings.local.json"), "local"],
    ]);
  });

  test("settingsClaudeLoginToken with no injected pathKind treats the worktree as its own root", () => {
    const { worktree } = worktreeWithFifoCommondir();
    const home = join(tmp, "home");
    mkdirSync(home);

    const run = runRunnerIsolated(
      `console.log(JSON.stringify(runner.settingsClaudeLoginToken({ claudeArgs: [] }, { HOME: ${JSON.stringify(home)} }, { cwd: ${JSON.stringify(worktree)}, home: ${JSON.stringify(home)} })));`
    );

    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toBe("absent");
  });
});
