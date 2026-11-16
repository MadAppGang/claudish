/**
 * The status line and advisor model claudish discovers from the user settings
 * file come from the ONE user file Claude Code loads: `$CLAUDE_CONFIG_DIR/settings.json`
 * when that variable is set, never `~/.claude/settings.json` beside it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { discoverUserAdvisorModel, discoverUserStatusLineCommand } from "./claude-runner.js";

const root = mkdtempSync(join(tmpdir(), "claudish-discover-config-dir-"));
const cwd = join(root, "cwd");
mkdirSync(cwd, { recursive: true });

function settingsDir(name: string, settings: unknown): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  return dir;
}

// The test preload gives this process a temporary HOME, so this file is test data.
const homeClaudeDir = join(homedir(), ".claude");
const homeSettings = join(homeClaudeDir, "settings.json");
const homeSettingsExisted = existsSync(homeSettings);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (!homeSettingsExisted) rmSync(homeSettings, { force: true });
});

describe("discoverUserStatusLineCommand under CLAUDE_CONFIG_DIR", () => {
  // REGRESSION: the status line was read from ~/.claude/settings.json while CLAUDE_CONFIG_DIR named another directory
  test("reads the status line from $CLAUDE_CONFIG_DIR/settings.json", () => {
    const cfg = settingsDir("cfg-status", { statusLine: { type: "command", command: "cfg-cmd" } });
    expect(discoverUserStatusLineCommand([], cwd, { CLAUDE_CONFIG_DIR: cfg })).toBe("cfg-cmd");
  });

  // REGRESSION: ~/.claude/settings.json supplied a status line Claude Code never loads under CLAUDE_CONFIG_DIR
  test("ignores ~/.claude/settings.json when CLAUDE_CONFIG_DIR names another directory", () => {
    if (homeSettingsExisted) throw new Error(`refusing to overwrite ${homeSettings}`);
    mkdirSync(homeClaudeDir, { recursive: true });
    writeFileSync(
      homeSettings,
      JSON.stringify({ statusLine: { type: "command", command: "home-cmd" } })
    );
    try {
      const cfg = settingsDir("cfg-empty", {});
      expect(discoverUserStatusLineCommand([], cwd, { CLAUDE_CONFIG_DIR: cfg })).toBeNull();
    } finally {
      rmSync(homeSettings, { force: true });
    }
  });
});

describe("discoverUserAdvisorModel under CLAUDE_CONFIG_DIR", () => {
  // REGRESSION: the advisor model was read from ~/.claude/settings.json while CLAUDE_CONFIG_DIR named another directory
  test("reads advisorModel from $CLAUDE_CONFIG_DIR/settings.json", () => {
    const cfg = settingsDir("cfg-advisor", { advisorModel: "opus" });
    expect(discoverUserAdvisorModel([], cwd, { CLAUDE_CONFIG_DIR: cfg })).toBe("opus");
  });
});

describe("settings discovery under env.HOME", () => {
  // A HOME that is neither process.env.HOME nor os.homedir(), so only env.HOME can name it.
  const home = join(root, "env-home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      statusLine: { type: "command", command: "env-home-cmd" },
      advisorModel: "opus",
    })
  );

  // REGRESSION: with no home injected, the user settings file was read under os.homedir() instead of env.HOME
  test("reads the status line from $HOME/.claude/settings.json of the env given", () => {
    expect(discoverUserStatusLineCommand([], cwd, { HOME: home })).toBe("env-home-cmd");
  });

  // REGRESSION: with no home injected, the user settings file was read under os.homedir() instead of env.HOME
  test("reads advisorModel from $HOME/.claude/settings.json of the env given", () => {
    expect(discoverUserAdvisorModel([], cwd, { HOME: home })).toBe("opus");
  });

  test("an injected home still wins over env.HOME", () => {
    const injected = join(root, "injected-home");
    mkdirSync(join(injected, ".claude"), { recursive: true });
    writeFileSync(
      join(injected, ".claude", "settings.json"),
      JSON.stringify({ advisorModel: "haiku" })
    );
    expect(discoverUserAdvisorModel([], cwd, { HOME: home }, { home: injected })).toBe("haiku");
  });
});
