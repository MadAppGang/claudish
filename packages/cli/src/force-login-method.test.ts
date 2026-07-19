/**
 * Tests for the forced-claude.ai-auth hardening in claude-runner.ts.
 *
 * When a user's global (~/.claude/settings.json) or project (.claude/settings.json)
 * settings set `forceLoginMethod: "claudeai"`, Claude Code would block claudish's
 * proxy sessions (which authenticate via a placeholder ANTHROPIC_API_KEY) at startup.
 * claudish neutralizes this by writing `forceLoginMethod: "console"` into its own
 * --settings overlay, which loads at the CLI-args precedence tier — above the user,
 * project, and local settings files. Native-Anthropic / --monitor sessions use the
 * real claude.ai subscription, so they must be left untouched. The OS *managed* tier
 * cannot be overridden and is caught with a fail-fast abort instead.
 */

import { describe, expect, test } from "bun:test";
import {
  buildClaudishSettingsOverlay,
  hasResolvableAnthropicAuth,
  isProxyAuthMode,
  managedSettingsForcesClaudeAi,
} from "./claude-runner.js";
import type { ClaudishConfig } from "./types.js";

const baseConfig = (overrides: Partial<ClaudishConfig> = {}): ClaudishConfig =>
  ({
    claudeArgs: [],
    ...overrides,
  }) as ClaudishConfig;

const statusLine = { type: "command", command: "echo hi", padding: 0 };

describe("isProxyAuthMode", () => {
  test("alternative model (proxy) → proxy mode", () => {
    expect(isProxyAuthMode(baseConfig({ model: "x-ai/grok-code-fast-1" }))).toBe(true);
  });

  test("bare/unknown model (proxy) → proxy mode", () => {
    expect(isProxyAuthMode(baseConfig({ model: "deepseek-v3" }))).toBe(true);
  });

  test("native claude model → NOT proxy mode", () => {
    expect(isProxyAuthMode(baseConfig({ model: "claude-opus-4-6" }))).toBe(false);
  });

  test("native claude in a profile mapping → NOT proxy mode", () => {
    expect(
      isProxyAuthMode(
        baseConfig({ modelOpus: "claude-opus-4-6", modelSonnet: "x-ai/grok-code-fast-1" })
      )
    ).toBe(false);
  });

  test("--monitor → NOT proxy mode (uses native subscription)", () => {
    expect(isProxyAuthMode(baseConfig({ monitor: true }))).toBe(false);
  });

  test("--monitor wins even with an alternative model set", () => {
    expect(isProxyAuthMode(baseConfig({ monitor: true, model: "x-ai/grok-code-fast-1" }))).toBe(
      false
    );
  });
});

describe("buildClaudishSettingsOverlay", () => {
  test("proxy mode injects forceLoginMethod: console", () => {
    const overlay = buildClaudishSettingsOverlay(statusLine, true);
    expect(overlay.forceLoginMethod).toBe("console");
    expect(overlay.disableClaudeAiConnectors).toBe(true);
    expect(overlay.statusLine).toBe(statusLine);
  });

  test("native/monitor mode OMITS forceLoginMethod entirely", () => {
    const overlay = buildClaudishSettingsOverlay(statusLine, false);
    expect("forceLoginMethod" in overlay).toBe(false);
    // Non-auth keys are still present regardless of mode.
    expect(overlay.disableClaudeAiConnectors).toBe(true);
    expect(overlay.statusLine).toBe(statusLine);
  });
});

describe("managedSettingsForcesClaudeAi", () => {
  test("managed settings forcing claudeai → true", () => {
    const readFile = (() => JSON.stringify({ forceLoginMethod: "claudeai" })) as never;
    expect(managedSettingsForcesClaudeAi(readFile)).toBe(true);
  });

  test("managed settings forcing console → false (not a claudeai block)", () => {
    const readFile = (() => JSON.stringify({ forceLoginMethod: "console" })) as never;
    expect(managedSettingsForcesClaudeAi(readFile)).toBe(false);
  });

  test("managed settings without forceLoginMethod → false", () => {
    const readFile = (() => JSON.stringify({ someOtherKey: true })) as never;
    expect(managedSettingsForcesClaudeAi(readFile)).toBe(false);
  });

  test("unreadable/garbled managed settings → false (best-effort, non-fatal)", () => {
    const readFile = (() => {
      throw new Error("EACCES");
    }) as never;
    expect(managedSettingsForcesClaudeAi(readFile)).toBe(false);
  });

  test("garbage JSON → false", () => {
    const readFile = (() => "{ not json") as never;
    expect(managedSettingsForcesClaudeAi(readFile)).toBe(false);
  });
});

describe("hasResolvableAnthropicAuth", () => {
  // Inject all deps so tests are hermetic: never read the real process.env / filesystem,
  // never mutate process.platform, and never spawn `security`.
  const noEnv: NodeJS.ProcessEnv = {};
  const noFile = () => false;
  const noKeychain = () => false;

  test("ANTHROPIC_API_KEY env → true", () => {
    expect(
      hasResolvableAnthropicAuth({
        env: { ANTHROPIC_API_KEY: "sk-test" },
        fileExists: noFile,
        keychainProbe: noKeychain,
      })
    ).toBe(true);
  });

  test("ANTHROPIC_AUTH_TOKEN env → true", () => {
    expect(
      hasResolvableAnthropicAuth({
        env: { ANTHROPIC_AUTH_TOKEN: "tok-test" },
        fileExists: noFile,
        keychainProbe: noKeychain,
      })
    ).toBe(true);
  });

  test("credentials file present → true (no env, no keychain)", () => {
    expect(
      hasResolvableAnthropicAuth({ env: noEnv, fileExists: () => true, keychainProbe: noKeychain })
    ).toBe(true);
  });

  test("macOS Keychain item present → true (no env, no file)", () => {
    expect(
      hasResolvableAnthropicAuth({ env: noEnv, fileExists: noFile, keychainProbe: () => true })
    ).toBe(true);
  });

  test("Keychain absent + no env + no file → false", () => {
    expect(
      hasResolvableAnthropicAuth({ env: noEnv, fileExists: noFile, keychainProbe: noKeychain })
    ).toBe(false);
  });

  test("non-darwin (probe returns false) still resolves via env/file", () => {
    // Off-darwin, defaultKeychainAnthropicProbe returns false; the env/file checks
    // remain the only sources. All-absent → false; env present → still true.
    expect(
      hasResolvableAnthropicAuth({ env: noEnv, fileExists: noFile, keychainProbe: () => false })
    ).toBe(false);
    expect(
      hasResolvableAnthropicAuth({
        env: { ANTHROPIC_API_KEY: "sk-test" },
        fileExists: noFile,
        keychainProbe: () => false,
      })
    ).toBe(true);
  });
});
