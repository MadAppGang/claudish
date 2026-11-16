import { describe, expect, test } from "bun:test";
import { claudeCodeSecureStorageServices } from "./claude-code-facts.js";
import { claudeCodeStartupCredential, keychainLoginPresent } from "./claude-code-login.js";

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

describe("the picker's Keychain login probe asks the launch check's services", () => {
  /** Every service `keychainLoginPresent` asks, each answered `absent`. */
  function asked(env: NodeJS.ProcessEnv): string[] {
    const services: string[] = [];
    keychainLoginPresent(env, (service) => {
      services.push(service);
      return "absent";
    });
    return services;
  }

  for (const env of [
    { HOME: "/h" },
    { HOME: "/h", CLAUDE_CONFIG_DIR: "/cfg" },
    { HOME: "/h", CLAUDE_CONFIG_DIR: "/cfg", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/s" },
    { HOME: "/h", CLAUDE_CONFIG_DIR: "/cfg", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" },
  ]) {
    test(`asks claudeCodeSecureStorageServices for ${JSON.stringify(env)}`, () => {
      expect(asked(env)).toEqual(claudeCodeSecureStorageServices("-credentials", env));
    });
  }

  test("a custom config directory never falls back to the unsuffixed login", () => {
    expect(asked({ HOME: "/h", CLAUDE_CONFIG_DIR: "/cfg" })).not.toContain(
      "Claude Code-credentials"
    );
  });

  test("a login under the hashed -credentials-<hash> name is found", () => {
    const env = { HOME: "/h", CLAUDE_CONFIG_DIR: "/cfg" };
    const [service] = claudeCodeSecureStorageServices("-credentials", env);
    expect(keychainLoginPresent(env, (s) => (s === service ? "found" : "absent"))).toBe(true);
    expect(keychainLoginPresent(env, () => "absent")).toBe(false);
  });
});
