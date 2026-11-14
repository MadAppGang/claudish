import { expect, test } from "bun:test";
import {
  KEY,
  LOGIN,
  MODEL,
  contractConfig,
  isolatedFile,
} from "./test-helpers/claude-behaviour.js";

await isolatedFile(import.meta, async () => {
  const {
    claudeCodeStartupCredential: startup,
    hasClaudeCodeLogin,
    defaultKeychainPresence,
  } = await import("./auth/claude-code-login.js");
  const { prepareClaudeLaunch } = await import("./launcher/claude-launch.js");
  const { CLAUDISH_PLACEHOLDER_AUTH_TOKEN } = await import("./auth/claudish-placeholder.js");
  type StartupDeps = NonNullable<Parameters<typeof startup>[0]>;
  type Deps = NonNullable<Parameters<typeof prepareClaudeLaunch>[1]>;
  type Config = Parameters<typeof prepareClaudeLaunch>[0];
  const stores = (over: StartupDeps = {}): StartupDeps => ({
    env: { HOME: "/h" },
    fileExists: () => false,
    readFile: () => {
      throw new Error("ENOENT");
    },
    keychainPresence: () => "absent",
    ...over,
  });
  const deps = (kind: "login" | "none" | "unknown" | "api-key" = "none"): Deps => ({
    env: {},
    settingsFindings: () => [],
    wantsApiBilling: () => false,
    settingsLoginToken: () => "absent",
    claudeCodeCredential: () =>
      kind === "api-key" ? { kind, where: "test Console store" } : { kind },
  });
  const monitor = (): Config =>
    contractConfig({ model: "claude@" + MODEL, claudeLaunch: "subscription", monitor: true });
  const tier = (): Config =>
    contractConfig({
      model: "grok@g",
      modelHaiku: "claude-haiku-x",
      modelTierSources: { haiku: 'profile "default"' },
    });

  test("B-67 classifies injected startup stores without exposing keys", () => {
    expect(
      startup(
        stores({
          env: { HOME: "/h", CLAUDE_CODE_OAUTH_TOKEN: LOGIN },
          keychainPresence: () => {
            throw new Error("token must avoid Keychain");
          },
        })
      )
    ).toEqual({ kind: "login" });
    expect(startup(stores({ fileExists: (p) => p === "/h/.claude/.credentials.json" }))).toEqual({
      kind: "login",
    });
    expect(
      startup(
        stores({
          env: { HOME: "/h", CLAUDE_CONFIG_DIR: "/cfg" },
          keychainPresence: (s) => (/^Claude Code-credentials-.+/.test(s) ? "found" : "absent"),
        })
      )
    ).toEqual({ kind: "login" });
    const keyOnly = startup(
      stores({
        env: { HOME: "/h", CLAUDE_CONFIG_DIR: "/cfg" },
        fileExists: (p) => p === "/cfg/.claude.json",
        readFile: (p) => {
          if (p === "/cfg/.claude.json") return JSON.stringify({ primaryApiKey: "sk-fake" });
          throw new Error("ENOENT");
        },
      })
    );
    expect(keyOnly).toEqual({ kind: "api-key", where: "/cfg/.claude.json" });
    expect(JSON.stringify(keyOnly)).not.toContain("sk-fake");
    expect(
      startup(
        stores({
          fileExists: (p) => p === "/h/.claude.json",
          readFile: () => '{"primaryApiKey":""}',
        })
      )
    ).toEqual({ kind: "none" });
    expect(
      startup(
        stores({ fileExists: (p) => p === "/h/.claude.json", readFile: () => "invalid JSON" })
      )
    ).toEqual({ kind: "unknown" });
    expect(
      startup(stores({ keychainPresence: (s) => (s === "Claude Code" ? "found" : "absent") }))
    ).toEqual({ kind: "api-key", where: "the macOS Keychain" });
    expect(startup(stores())).toEqual({ kind: "none" });
    expect(startup(stores({ keychainPresence: () => "failed" }))).toEqual({ kind: "unknown" });
    expect(
      startup(
        stores({
          env: { HOME: "/h", CLAUDE_CONFIG_DIR: "/cfg", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" },
          keychainPresence: (s) => {
            if (!["Claude Code-credentials", "Claude Code"].includes(s))
              throw new Error("hashed service forbidden by empty secure-storage override");
            return "absent";
          },
        })
      )
    ).toEqual({ kind: "none" });
  });

  test("B-68 treats unanswered OAuth stores as unknown rather than API-only", async () => {
    for (const configStore of [
      {
        fileExists: (p: string) => p === "/h/.claude.json",
        readFile: () => '{"primaryApiKey":"sk-fake"}',
      },
      {
        fileExists: () => false,
        readFile: () => {
          throw new Error("ENOENT");
        },
      },
    ]) {
      expect(
        startup(
          stores({
            ...configStore,
            keychainPresence: (s) => (s.startsWith("Claude Code-credentials") ? "failed" : "found"),
          })
        )
      ).toEqual({ kind: "unknown" });
    }
    expect(
      startup(
        stores({
          fileExists: (p) => p === "/h/.claude.json",
          readFile: () => '{"primaryApiKey":"sk-fake"}',
        })
      )
    ).toEqual({ kind: "api-key", where: "/h/.claude.json" });
    expect(
      startup(stores({ fileExists: (p) => p === "/h/.claude.json", readFile: () => "not-json" }))
    ).toEqual({ kind: "unknown" });
    expect(await prepareClaudeLaunch(monitor(), deps("unknown"))).toMatchObject({
      ok: true,
      signing: { kind: "login-only" },
    });
  });

  test("B-69 does not consult Keychain when disabled", () => {
    const previous = process.env.CLAUDISH_DISABLE_KEYCHAIN;
    process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
    try {
      expect(defaultKeychainPresence("Claude Code")).toBe(
        process.platform === "darwin" ? "failed" : "absent"
      );
    } finally {
      if (previous === undefined) delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
      else process.env.CLAUDISH_DISABLE_KEYCHAIN = previous;
    }
  });

  test("B-70 refuses missing or API-only logins with appropriate remedies", async () => {
    const keyOnly = await prepareClaudeLaunch(tier(), deps("api-key"));
    expect(keyOnly.ok).toBe(false);
    if (keyOnly.ok) throw new Error("API-only credential unexpectedly accepted");
    for (const text of [
      "API key",
      "test Console store",
      "anthropic@<id>",
      "--anthropic-api-billing",
      'because the haiku model claude-haiku-x from profile "default" is a Claude model',
    ])
      expect(keyOnly.message).toContain(text);
    expect(await prepareClaudeLaunch(tier(), deps("none"))).toMatchObject({
      ok: false,
      message: expect.stringContaining("/login"),
    });
    for (const kind of ["unknown", "login"] as const)
      expect(await prepareClaudeLaunch(tier(), deps(kind))).toMatchObject({
        ok: true,
        signing: { kind: "login-only" },
      });
    for (const c of [monitor(), { ...tier(), claudeSubscriptionPin: true }]) {
      const out = await prepareClaudeLaunch(c, deps("api-key"));
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("pinned API-only credential unexpectedly accepted");
      expect(out.message).not.toContain("--anthropic-api-billing");
    }
    expect(
      await prepareClaudeLaunch(tier(), {
        ...deps("login"),
        env: { ANTHROPIC_AUTH_TOKEN: "gw-token-fake" },
      })
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("your shell environment sets ANTHROPIC_AUTH_TOKEN"),
    });
    expect(
      await prepareClaudeLaunch(tier(), { ...deps("none"), env: { ANTHROPIC_AUTH_TOKEN: LOGIN } })
    ).toMatchObject({ ok: true, signing: { kind: "login-only" } });
    expect(
      await prepareClaudeLaunch(tier(), {
        ...deps("login"),
        env: { ANTHROPIC_AUTH_TOKEN: CLAUDISH_PLACEHOLDER_AUTH_TOKEN },
      })
    ).toMatchObject({ ok: true });
    expect(
      await prepareClaudeLaunch(tier(), {
        ...deps(),
        wantsApiBilling: () => true,
        claudeCodeCredential: () => {
          throw new Error("opt-in must avoid login stores");
        },
      })
    ).toMatchObject({ ok: true });
  });

  test("B-71 honours settings login tokens including clears and unknown layers", async () => {
    for (const c of [monitor(), tier()]) {
      expect(
        await prepareClaudeLaunch(c, { ...deps("none"), settingsLoginToken: () => "set" })
      ).toMatchObject({ ok: true, signing: { kind: "login-only" } });
      for (const kind of ["none", "api-key"] as const)
        expect(
          await prepareClaudeLaunch(c, { ...deps(kind), settingsLoginToken: () => "unknown" })
        ).toMatchObject({ ok: true });
      expect(
        await prepareClaudeLaunch(c, { ...deps("none"), settingsLoginToken: () => "absent" })
      ).toMatchObject({ ok: false, message: expect.stringContaining("/login") });
      expect(
        await prepareClaudeLaunch(c, {
          ...deps(),
          env: { CLAUDE_CODE_OAUTH_TOKEN: LOGIN },
          settingsLoginToken: () => "cleared",
          claudeCodeCredential: (env) =>
            env.CLAUDE_CODE_OAUTH_TOKEN ? { kind: "login" } : { kind: "none" },
        })
      ).toMatchObject({ ok: false, message: expect.stringContaining("/login") });
    }
  });

  test("B-73 uses injected login files and never an API key as login evidence", () => {
    for (const [env, path] of [
      [{ CLAUDE_CONFIG_DIR: "/cfg" }, "/cfg/.credentials.json"],
      [{ HOME: "/h" }, "/h/.claude/.credentials.json"],
    ] as const) {
      expect(
        hasClaudeCodeLogin({ env, fileExists: (p) => p === path, keychainProbe: () => false })
      ).toBe(true);
      expect(
        hasClaudeCodeLogin({
          env,
          fileExists: () => false,
          keychainProbe: (e) => JSON.stringify(e) === JSON.stringify(env),
        })
      ).toBe(true);
    }
    expect(
      hasClaudeCodeLogin({
        env: { CLAUDE_CODE_OAUTH_TOKEN: "x" },
        fileExists: () => {
          throw new Error("token must avoid file lookup");
        },
        keychainProbe: () => false,
      })
    ).toBe(true);
    expect(
      hasClaudeCodeLogin({
        env: { HOME: "/h", CLAUDE_CODE_OAUTH_TOKEN: "" },
        fileExists: (p) => p === "/h/.claude/.credentials.json",
        keychainProbe: () => false,
      })
    ).toBe(true);
    expect(
      hasClaudeCodeLogin({
        env: { HOME: "/h", ANTHROPIC_API_KEY: KEY },
        fileExists: () => false,
        keychainProbe: () => false,
      })
    ).toBe(false);
  });
});
