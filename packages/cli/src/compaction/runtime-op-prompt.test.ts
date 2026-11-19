import { afterEach, expect, test } from "bun:test";
import {
  _resetCredentialPromptRoleForTest,
  decideLaunchRole,
  setCredentialPromptRole,
} from "../auth/credentials/prompt-role.js";
import { compactionMayPromptForKey } from "./runtime.js";

afterEach(() => {
  _resetCredentialPromptRoleForTest();
});

test("only an interactive launch may open a 1Password prompt for the compaction key", () => {
  expect(compactionMayPromptForKey("interactive-launch")).toBe(true);
  expect(compactionMayPromptForKey("never")).toBe(false);
  expect(compactionMayPromptForKey("tui")).toBe(false);
});

test("a headless pane child started with -i on a PTY never prompts", () => {
  const role = decideLaunchRole({
    argv: ["-i", "--compaction", "--model", "test-model"],
    env: { CLAUDISH_PANE_CHILD: "1" },
    stdinIsTTY: true,
    stderrIsTTY: true,
  });
  setCredentialPromptRole(role);
  expect(compactionMayPromptForKey()).toBe(false);
});

test("the default reads the process's role", () => {
  setCredentialPromptRole("interactive-launch");
  expect(compactionMayPromptForKey()).toBe(true);
});
