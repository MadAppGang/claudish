import { describe, expect, test } from "bun:test";
import { claudeCodeSecureStorageServices } from "./claude-code-facts.js";
import { claudeCodeStartupCredential } from "./claude-code-login.js";

/** Runs the startup check over no files and records every Keychain service it asks about. */
function probed(env: NodeJS.ProcessEnv): string[] {
  const asked: string[] = [];
  claudeCodeStartupCredential({
    env,
    fileExists: () => false,
    readFile: () => {
      throw new Error("ENOENT");
    },
    keychainPresence: (service) => {
      asked.push(service);
      return "absent";
    },
  });
  return asked;
}

describe("claudeCodeStartupCredential Keychain services", () => {
  test("an empty CLAUDE_SECURESTORAGE_CONFIG_DIR asks only the unsuffixed services", () => {
    expect(
      probed({ HOME: "/h", CLAUDE_CONFIG_DIR: "/cfg", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" })
    ).toEqual(["Claude Code-credentials", "Claude Code"]);
  });

  test("a set CLAUDE_SECURESTORAGE_CONFIG_DIR asks only its own hashed services", () => {
    const env = { HOME: "/h", CLAUDE_CONFIG_DIR: "/cfg", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/s" };
    expect(probed(env)).toEqual([
      ...claudeCodeSecureStorageServices("-credentials", env),
      ...claudeCodeSecureStorageServices("", env),
    ]);
  });

  test("CLAUDE_CONFIG_DIR alone asks the hashed services and not the unsuffixed login", () => {
    const asked = probed({ HOME: "/h", CLAUDE_CONFIG_DIR: "/cfg" });
    expect(asked).not.toContain("Claude Code-credentials");
    expect(asked.every((s) => /^Claude Code(-credentials)?-[0-9a-f]{8}$/.test(s))).toBe(true);
  });
});
