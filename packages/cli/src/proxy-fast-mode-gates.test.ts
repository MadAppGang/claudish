/**
 * The two Claude Code gates claudish opens for `/fast` in a pure proxy child,
 * and their removal when a native-auth launch inherits them.
 *
 * `runClaudeWithProxy` spawns Claude Code and cannot run here, so a source guard
 * pins WHERE the helpers are called: open only next to the placeholder auth,
 * close on both real-credential branches.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CLAUDISH_FAST_MODE_GATES_VAR,
  applyProxyFastModeGates,
  scrubInheritedFastModeGates,
} from "./fast-mode-gates.js";

describe("applyProxyFastModeGates", () => {
  test("opens both gates on a clean env and records them", () => {
    const env: Record<string, string | undefined> = {};
    applyProxyFastModeGates(env);
    expect(env).toEqual({
      CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: "1",
      CLAUDE_CODE_MODEL_CAPABILITIES: "fast_mode",
      [CLAUDISH_FAST_MODE_GATES_VAR]: "skip,caps",
    });
  });

  test("prepends to the user's capabilities so their per-model entries still win", () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_MODEL_CAPABILITIES: "cx@gpt-6*=-fast_mode",
    };
    applyProxyFastModeGates(env);
    expect(env.CLAUDE_CODE_MODEL_CAPABILITIES).toBe("fast_mode;cx@gpt-6*=-fast_mode");
  });

  test("a user's own org-check value is kept and not recorded", () => {
    const env: Record<string, string | undefined> = { CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: "" };
    applyProxyFastModeGates(env);
    expect(env.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK).toBe("");
    expect(env[CLAUDISH_FAST_MODE_GATES_VAR]).toBe("caps");
  });

  test("CLAUDE_CODE_DISABLE_FAST_MODE leaves both gates closed", () => {
    const env: Record<string, string | undefined> = { CLAUDE_CODE_DISABLE_FAST_MODE: "1" };
    applyProxyFastModeGates(env);
    expect(env).toEqual({ CLAUDE_CODE_DISABLE_FAST_MODE: "1" });
  });

  test("an inherited proxied env is not stacked twice", () => {
    const env: Record<string, string | undefined> = { CLAUDE_CODE_MODEL_CAPABILITIES: "x=y" };
    applyProxyFastModeGates(env);
    applyProxyFastModeGates(env);
    expect(env.CLAUDE_CODE_MODEL_CAPABILITIES).toBe("fast_mode;x=y");
    expect(env[CLAUDISH_FAST_MODE_GATES_VAR]).toBe("skip,caps");
  });
});

describe("scrubInheritedFastModeGates", () => {
  test("restores exactly the env claudish found", () => {
    for (const original of [{}, { CLAUDE_CODE_MODEL_CAPABILITIES: "a=b,-c" }]) {
      const env: Record<string, string | undefined> = { ...original };
      applyProxyFastModeGates(env);
      const { removed } = scrubInheritedFastModeGates(env);
      expect(env).toEqual(original);
      expect(removed).toContain("CLAUDE_CODE_MODEL_CAPABILITIES");
    }
  });

  test("without the marker, the user's values are never touched", () => {
    const env = {
      CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: "1",
      CLAUDE_CODE_MODEL_CAPABILITIES: "fast_mode",
    };
    expect(scrubInheritedFastModeGates(env).removed).toEqual([]);
    expect(env).toEqual({
      CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: "1",
      CLAUDE_CODE_MODEL_CAPABILITIES: "fast_mode",
    });
  });
});

describe("runClaudeWithProxy opens the gates only in pure proxy mode", () => {
  const source = readFileSync(resolve(import.meta.dir, "claude-runner.ts"), "utf8");
  const run = source.slice(source.indexOf("export async function runClaudeWithProxy"));
  const code = run.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("opened right after the placeholder auth, nowhere else", () => {
    expect(code.match(/applyProxyFastModeGates\(/g)).toHaveLength(1);
    expect(code).toMatch(/applyProxyPlaceholderAuth\(env\);\s*applyProxyFastModeGates\(env\);/);
  });

  test("closed on the monitor and native-auth branches", () => {
    expect(code.match(/scrubInheritedFastModeGates\(env\)/g)).toHaveLength(2);
  });
});
