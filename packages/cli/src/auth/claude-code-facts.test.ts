import { describe, expect, test } from "bun:test";
import { claudeCodeConfigDir, claudeCodeGlobalConfigPath } from "./claude-code-facts.js";

// Claude Code's rule, measured on 2.1.325: unset → `~/.claude`; any string value,
// empty and whitespace-only included → `resolve(cwd, value.normalize("NFC"))`.
describe("claudeCodeConfigDir follows Claude Code's CLAUDE_CONFIG_DIR rule", () => {
  // REGRESSION: an empty CLAUDE_CONFIG_DIR was treated as unset and answered ~/.claude
  test("an empty value resolves to the working directory", () => {
    expect(claudeCodeConfigDir({ HOME: "/h", CLAUDE_CONFIG_DIR: "" }, "/w")).toBe("/w");
  });

  // REGRESSION: a CLAUDE_CONFIG_DIR with surrounding spaces was trimmed
  test("a value with surrounding spaces is taken as given and resolved against cwd", () => {
    expect(claudeCodeConfigDir({ CLAUDE_CONFIG_DIR: " /x " }, "/w")).toBe("/w/ /x ");
  });

  // REGRESSION: a decomposed CLAUDE_CONFIG_DIR was not NFC-normalized
  test("a decomposed value is NFC-normalized", () => {
    expect(claudeCodeConfigDir({ CLAUDE_CONFIG_DIR: "café" }, "/w")).toBe("/w/café");
  });

  // REGRESSION: a relative CLAUDE_CONFIG_DIR resolved against process.cwd(), ignoring the given cwd
  test("a relative value resolves against the given cwd", () => {
    expect(claudeCodeConfigDir({ CLAUDE_CONFIG_DIR: "rel" }, "/w")).toBe("/w/rel");
  });

  test("unset falls back to .claude under HOME", () => {
    expect(claudeCodeConfigDir({ HOME: "/h" }, "/w")).toBe("/h/.claude");
  });
});

describe("claudeCodeGlobalConfigPath", () => {
  // REGRESSION: the global config path trimmed CLAUDE_CONFIG_DIR before resolving it
  test("a value with surrounding spaces keeps them", () => {
    expect(claudeCodeGlobalConfigPath({ HOME: "/h", CLAUDE_CONFIG_DIR: " /x " }, "/w")).toBe(
      "/w/ /x /.claude.json"
    );
  });
});
