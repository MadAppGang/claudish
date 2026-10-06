/**
 * What claude-runner deletes from the environment it hands Claude Code.
 *
 * `scrubChildEnv` is tested directly; `runClaudeWithProxy` itself cannot be run here
 * (it spawns Claude Code), so a source guard pins that it calls the helper on the
 * environment it spawns with, right after building it. The real-claudish pane test
 * (Phase 3) checks the same property end to end.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scrubChildEnv } from "./claude-runner.js";

describe("scrubChildEnv", () => {
  test("an interactive launch drops CLAUDE_CODE_CHILD_SESSION and CLAUDECODE", () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDECODE: "1",
      KEEP: "me",
    };
    scrubChildEnv(env, { interactive: true });
    expect(env).toEqual({ KEEP: "me" });
  });

  test("print mode keeps CLAUDE_CODE_CHILD_SESSION as before", () => {
    const env: Record<string, string | undefined> = { CLAUDE_CODE_CHILD_SESSION: "1" };
    scrubChildEnv(env, { interactive: false });
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBe("1");
  });

  for (const interactive of [true, false]) {
    test(`the CLAUDISH_PANE_* markers never reach Claude Code (interactive: ${interactive})`, () => {
      const env: Record<string, string | undefined> = {
        CLAUDISH_PANE_CHILD: "1",
        CLAUDISH_PANE_ENV: "{}",
        CLAUDISH_PANE_CWD: "/w",
        CLAUDISH_TOKEN_FILE: "/run/a.json",
      };
      scrubChildEnv(env, { interactive });
      expect(env).toEqual({ CLAUDISH_TOKEN_FILE: "/run/a.json" });
    });
  }
});

describe("runClaudeWithProxy scrubs the environment it spawns with", () => {
  const source = readFileSync(resolve(import.meta.dir, "claude-runner.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("the call follows the env literal, on that env, with config.interactive", () => {
    const m = /const env: Record<string, string> = \{[\s\S]*?\n {2}\};\n\s*(.*)\n/.exec(code);
    expect(m, "could not find the env literal in claude-runner.ts").toBeTruthy();
    expect(m?.[1]).toBe("scrubChildEnv(env, { interactive: Boolean(config.interactive) });");
  });
});
