import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeCodeSecureStorageServices } from "./claude-code-facts.js";
import {
  claudeCodeStartupCredential,
  hasClaudeCodeLogin,
  keychainAnthropicMemoKey,
  keychainLoginPresent,
  keychainPresenceArgs,
  keychainPresenceIn,
  keychainPresenceOf,
} from "./claude-code-login.js";

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

describe("hasClaudeCodeLogin reads the login file from Claude Code's config directory", () => {
  // REGRESSION: an empty CLAUDE_CONFIG_DIR looked for .credentials.json under ~/.claude, not under cwd
  test("an empty CLAUDE_CONFIG_DIR finds the login file in the given working directory", () => {
    expect(
      hasClaudeCodeLogin({
        env: { HOME: "/h", CLAUDE_CONFIG_DIR: "" },
        cwd: "/w",
        fileExists: (path) => path === "/w/.credentials.json",
        keychainProbe: () => false,
      })
    ).toBe(true);
  });
});

describe("hasClaudeCodeLogin Keychain probe under a relative CLAUDE_CONFIG_DIR", () => {
  // A working directory that is not this process's, so only the injected cwd names it.
  const childCwd = "/claudish-test-child-cwd";
  const env = { HOME: "/h", CLAUDE_CONFIG_DIR: "rel" };
  const hashed = createHash("sha256").update(`${childCwd}/rel`).digest("hex").slice(0, 8);
  const childService = `Claude Code-credentials-${hashed}`;

  // REGRESSION: the Keychain probe hashed CLAUDE_CONFIG_DIR against process.cwd(), not the injected cwd
  test("finds the login item hashed from the injected cwd", () => {
    expect(
      hasClaudeCodeLogin({
        env,
        cwd: childCwd,
        fileExists: () => false,
        keychainProbe: (probeEnv, probeCwd) =>
          keychainLoginPresent(
            probeEnv ?? {},
            (service) => (service === childService ? "found" : "absent"),
            probeCwd
          ),
      })
    ).toBe(true);
  });

  test("keychainLoginPresent asks the services resolved against the given cwd", () => {
    const services: string[] = [];
    keychainLoginPresent(
      env,
      (service) => {
        services.push(service);
        return "absent";
      },
      childCwd
    );
    expect(services).toEqual(claudeCodeSecureStorageServices("-credentials", env, childCwd));
    expect(services).toContain(childService);
  });
});

describe("the Keychain presence probe", () => {
  test("names the keychain file only from the env it is given", () => {
    expect(keychainPresenceArgs("svc", { CLAUDISH_KEYCHAIN_FILE: "/k" })).toEqual([
      "find-generic-password",
      "-s",
      "svc",
      "/k",
    ]);
    const before = process.env.CLAUDISH_KEYCHAIN_FILE;
    process.env.CLAUDISH_KEYCHAIN_FILE = "/process-level.keychain";
    try {
      expect(keychainPresenceArgs("svc", {})).toEqual(["find-generic-password", "-s", "svc"]);
    } finally {
      if (before === undefined) delete process.env.CLAUDISH_KEYCHAIN_FILE;
      else process.env.CLAUDISH_KEYCHAIN_FILE = before;
    }
  });

  test("reads found, absent and failed from security's result", () => {
    expect(keychainPresenceOf({ status: 0 })).toBe("found");
    expect(keychainPresenceOf({ status: 44 })).toBe("absent");
    expect(keychainPresenceOf({ status: 1 })).toBe("failed");
    expect(keychainPresenceOf({ status: null })).toBe("failed");
    expect(keychainPresenceOf({ status: 0, error: new Error("spawn failed") })).toBe("failed");
  });
});

describe("the default Keychain probes read the env they are given", () => {
  test("keychainPresenceIn hands every service the given env, never process.env", () => {
    const env = { CLAUDISH_KEYCHAIN_FILE: "/given.keychain" };
    const seen: { service: string; env: NodeJS.ProcessEnv | undefined }[] = [];
    const presence = keychainPresenceIn(env, (service, e) => {
      seen.push({ service, env: e });
      return "absent";
    });
    expect(presence("svc-a")).toBe("absent");
    expect(presence("svc-b")).toBe("absent");
    expect(seen).toEqual([
      { service: "svc-a", env },
      { service: "svc-b", env },
    ]);
  });

  test("no default path passes defaultKeychainPresence unbound", () => {
    // A bare `defaultKeychainPresence` value is called with one argument and reads process.env.
    const source = readFileSync(join(import.meta.dir, "claude-code-login.ts"), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line))
      .join("\n");
    const bare = [...code.matchAll(/defaultKeychainPresence(?!\s*\()/g)]
      .map((m) => code.slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + 30))
      .filter((around) => !around.includes("keychainPresenceIn(env, defaultKeychainPresence)"));
    expect(bare).toEqual([]);
    expect(code).toContain("keychainPresenceIn(env, defaultKeychainPresence)");
  });
});

describe("the picker's Keychain probe memo", () => {
  test("two keychain files give two memo entries", () => {
    const a = keychainAnthropicMemoKey({ CLAUDISH_KEYCHAIN_FILE: "/a.keychain" }, "/w");
    const b = keychainAnthropicMemoKey({ CLAUDISH_KEYCHAIN_FILE: "/b.keychain" }, "/w");
    const none = keychainAnthropicMemoKey({}, "/w");
    expect(new Set([a, b, none]).size).toBe(3);
    expect(keychainAnthropicMemoKey({ CLAUDISH_KEYCHAIN_FILE: "/a.keychain" }, "/w")).toBe(a);
  });

  test("a changed config dir still gives another entry", () => {
    expect(keychainAnthropicMemoKey({ CLAUDE_CONFIG_DIR: "/c1" }, "/w")).not.toBe(
      keychainAnthropicMemoKey({ CLAUDE_CONFIG_DIR: "/c2" }, "/w")
    );
  });
});
