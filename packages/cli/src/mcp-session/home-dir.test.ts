/**
 * The sessions directory and Claude Code's config directory follow `$HOME`,
 * by the same rule the magus plugin monitor uses to find the directory it
 * polls. Bun's `os.homedir()` ignores a runtime `HOME`, which is how claudish
 * wrote into the account home while the monitor watched a sandbox.
 *
 * Nothing here writes: the manager's resolved directory is read back, never
 * used, so a regression cannot touch the real ~/.claudish.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { projectDirNameFor, sessionsDirFrom, userHomeFrom } from "./home-dir.js";
import { claudeConfigDir } from "./parent-session.js";
import { SessionManager } from "./session-manager.js";

const SANDBOX_HOME = "/sandbox/home-dir-test";
const ACCOUNT_HOME = "/Users/account";
const accountHome = () => ACCOUNT_HOME;

describe("sessionsDirFrom / userHomeFrom", () => {
  test("CLAUDISH_SESSIONS_DIR wins over HOME", () => {
    expect(
      sessionsDirFrom({ CLAUDISH_SESSIONS_DIR: "/explicit", HOME: SANDBOX_HOME }, accountHome)
    ).toBe("/explicit");
  });

  test("HOME wins over os.homedir()", () => {
    expect(sessionsDirFrom({ HOME: SANDBOX_HOME }, accountHome)).toBe(
      join(SANDBOX_HOME, ".claudish", "sessions")
    );
    expect(userHomeFrom({ HOME: SANDBOX_HOME }, accountHome)).toBe(SANDBOX_HOME);
  });

  test("an empty CLAUDISH_SESSIONS_DIR or HOME counts as unset", () => {
    expect(sessionsDirFrom({ CLAUDISH_SESSIONS_DIR: "", HOME: "" }, accountHome)).toBe(
      join(ACCOUNT_HOME, ".claudish", "sessions")
    );
    expect(userHomeFrom({}, accountHome)).toBe(ACCOUNT_HOME);
  });
});

describe("claudish follows a runtime HOME", () => {
  const saved = {
    HOME: process.env.HOME,
    CLAUDISH_SESSIONS_DIR: process.env.CLAUDISH_SESSIONS_DIR,
  };

  beforeEach(() => {
    process.env.HOME = SANDBOX_HOME;
    delete process.env.CLAUDISH_SESSIONS_DIR;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("SessionManager resolves its sessions directory under $HOME", async () => {
    const manager = new SessionManager({ hostPid: 1 });
    try {
      const resolved = (manager as unknown as { sessionsDir: string }).sessionsDir;
      expect(resolved).toBe(join(SANDBOX_HOME, ".claudish", "sessions"));
    } finally {
      await manager.shutdownAll();
    }
  });

  test("the host session record is read from Claude Code's config under $HOME", () => {
    expect(claudeConfigDir({ HOME: SANDBOX_HOME })).toBe(join(SANDBOX_HOME, ".claude"));
  });

  test("CLAUDE_CONFIG_DIR still wins over HOME", () => {
    expect(claudeConfigDir({ HOME: SANDBOX_HOME, CLAUDE_CONFIG_DIR: "/cfg" })).toBe("/cfg");
  });
});

describe("REQ-4 projectDirNameFor: every character outside [A-Za-z0-9] becomes '-'", () => {
  test.each([
    ["/Users/someone/.claude/worktrees/x", "-Users-someone--claude-worktrees-x"],
    ["/srv/my_app v2.1", "-srv-my-app-v2-1"],
  ])("%s → %s", (cwd, expected) => {
    expect(projectDirNameFor(cwd)).toBe(expected);
  });
});
