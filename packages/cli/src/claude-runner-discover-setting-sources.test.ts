/**
 * The status line and advisor model claudish discovers come from the settings
 * layers Claude Code itself loads: `--setting-sources` closes the layers it does
 * not name, and a linked worktree also reads the main checkout's
 * `.claude/settings.local.json`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverUserAdvisorModel, discoverUserStatusLineCommand } from "./claude-runner.js";

const root = mkdtempSync(join(tmpdir(), "claudish-discover-setting-sources-"));
let counter = 0;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

/** A fresh case: a cwd with no settings yet, and a user config dir of its own. */
function freshCase(): { cwd: string; configDir: string; env: NodeJS.ProcessEnv } {
  const base = join(root, `case-${counter++}`);
  const cwd = join(base, "cwd");
  const configDir = join(base, "config");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  return { cwd, configDir, env: { CLAUDE_CONFIG_DIR: configDir } };
}

const statusLine = (command: string) => ({ statusLine: { type: "command", command } });

/** A linked worktree `<base>/wt` of the main checkout `<base>/main`, written as Git lays it out. */
function linkedWorktree(): { main: string; worktree: string; env: NodeJS.ProcessEnv } {
  const base = join(root, `case-${counter++}`);
  const main = join(base, "main");
  const worktree = join(base, "wt");
  const gitDir = join(main, ".git", "worktrees", "wt");
  mkdirSync(gitDir, { recursive: true });
  put(join(gitDir, "commondir"), "../..\n");
  mkdirSync(worktree, { recursive: true });
  put(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
  const configDir = join(base, "config");
  mkdirSync(configDir, { recursive: true });
  return { main, worktree, env: { CLAUDE_CONFIG_DIR: configDir } };
}

describe("discoverUserStatusLineCommand and --setting-sources", () => {
  // REGRESSION: a project status line was chained although --setting-sources user closed the project layer
  test("--setting-sources user ignores the project settings file", () => {
    const { cwd, env } = freshCase();
    put(join(cwd, ".claude", "settings.json"), statusLine("proj-cmd"));
    expect(discoverUserStatusLineCommand(["--setting-sources", "user"], cwd, env)).toBeNull();
  });

  // REGRESSION: an empty --setting-sources closed no layer, so the local file's status line was chained
  test('--setting-sources "" ignores the user, project and local files', () => {
    const { cwd, configDir, env } = freshCase();
    put(join(configDir, "settings.json"), statusLine("user-cmd"));
    put(join(cwd, ".claude", "settings.json"), statusLine("proj-cmd"));
    put(join(cwd, ".claude", "settings.local.json"), statusLine("local-cmd"));
    expect(discoverUserStatusLineCommand(["--setting-sources", ""], cwd, env)).toBeNull();
  });

  // REGRESSION: a linked worktree never read the main checkout's settings.local.json
  test("reads the main checkout's settings.local.json from a linked worktree", () => {
    const { main, worktree, env } = linkedWorktree();
    put(join(main, ".claude", "settings.local.json"), statusLine("local-cmd"));
    expect(discoverUserStatusLineCommand([], worktree, env)).toBe("local-cmd");
  });

  test("local overrides project overrides user", () => {
    const { cwd, configDir, env } = freshCase();
    put(join(configDir, "settings.json"), statusLine("user-cmd"));
    expect(discoverUserStatusLineCommand([], cwd, env)).toBe("user-cmd");
    put(join(cwd, ".claude", "settings.json"), statusLine("proj-cmd"));
    expect(discoverUserStatusLineCommand([], cwd, env)).toBe("proj-cmd");
    put(join(cwd, ".claude", "settings.local.json"), statusLine("local-cmd"));
    expect(discoverUserStatusLineCommand([], cwd, env)).toBe("local-cmd");
  });
});

describe("discoverUserAdvisorModel and --setting-sources", () => {
  // REGRESSION: a project advisorModel was used although --setting-sources user closed the project layer
  test("--setting-sources user ignores the project settings file", () => {
    const { cwd, env } = freshCase();
    put(join(cwd, ".claude", "settings.json"), { advisorModel: "opus" });
    expect(discoverUserAdvisorModel(["--setting-sources", "user"], cwd, env)).toBeUndefined();
  });

  // REGRESSION: a linked worktree never read the main checkout's settings.local.json
  test("reads the main checkout's settings.local.json from a linked worktree", () => {
    const { main, worktree, env } = linkedWorktree();
    put(join(main, ".claude", "settings.local.json"), { advisorModel: "opus" });
    expect(discoverUserAdvisorModel([], worktree, env)).toBe("opus");
  });

  test("local overrides project overrides user", () => {
    const { cwd, configDir, env } = freshCase();
    put(join(configDir, "settings.json"), { advisorModel: "haiku" });
    expect(discoverUserAdvisorModel([], cwd, env)).toBe("haiku");
    put(join(cwd, ".claude", "settings.json"), { advisorModel: "sonnet" });
    expect(discoverUserAdvisorModel([], cwd, env)).toBe("sonnet");
    put(join(cwd, ".claude", "settings.local.json"), { advisorModel: "opus" });
    expect(discoverUserAdvisorModel([], cwd, env)).toBe("opus");
  });
});
