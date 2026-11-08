import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  claudeCodeKeychainService,
  claudeCodeKeychainServiceCandidates,
} from "./claude-code-facts.js";

function expectedService(configDir: string): string {
  const hash = createHash("sha256").update(configDir).digest("hex").slice(0, 8);
  return `Claude Code-${hash}-credentials`;
}

describe("Claude Code Keychain service facts", () => {
  test("uses the unsuffixed service when CLAUDE_CONFIG_DIR is unset", () => {
    expect(claudeCodeKeychainService({ HOME: "/Users/tester" })).toBe("Claude Code-credentials");

    // Mutation caught: append a hash unconditionally, which loses default-dir
    // logins stored under Claude Code-credentials.
  });

  test("treats an explicitly named default ~/.claude directory as unsuffixed", () => {
    const env = {
      HOME: "/Users/tester",
      CLAUDE_CONFIG_DIR: "/Users/tester/.claude",
    };
    expect(claudeCodeKeychainService(env)).toBe("Claude Code-credentials");

    // Mutation caught: hash every explicitly set CLAUDE_CONFIG_DIR even when it
    // resolves to Claude Code's default directory.
  });

  test("hashes the resolved custom config directory into the service name", () => {
    const env = {
      HOME: "/Users/tester",
      CLAUDE_CONFIG_DIR: "profiles/custom-claude",
    };
    const resolved = resolve(process.cwd(), env.CLAUDE_CONFIG_DIR);

    expect(claudeCodeKeychainService(env)).toBe(expectedService(resolved));
    expect(claudeCodeKeychainService(env)).toMatch(/^Claude Code-[0-9a-f]{8}-credentials$/);

    // Mutation caught: restore the hardcoded Claude Code-credentials lookup or
    // hash the unresolved relative string instead of its config directory.
  });

  test("candidate probing covers resolved, raw, slash-stripped, and legacy names", () => {
    const raw = "/Users/tester/custom-claude/";
    const stripped = "/Users/tester/custom-claude";
    const candidates = claudeCodeKeychainServiceCandidates({
      HOME: "/Users/tester",
      CLAUDE_CONFIG_DIR: raw,
    });

    expect(candidates).toEqual([
      expectedService(resolve(raw)),
      expectedService(raw),
      "Claude Code-credentials",
    ]);
    // The slash-stripped raw form equals the resolved absolute form here and is
    // intentionally de-duplicated rather than probed twice.
    expect(candidates[0]).toBe(expectedService(stripped));

    // Mutation caught: probe only the guessed normalized service. Until the
    // installed binary's raw-vs-resolved rule is pinned, each candidate is needed.
  });
});
