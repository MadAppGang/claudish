import { describe, expect, test } from "bun:test";
import {
  buildClaudishSettingsOverlay,
  isProxyAuthMode,
  managedSettingsForcesClaudeAi,
} from "./claude-runner.js";
import type { ClaudishConfig } from "./types.js";

const config = (overrides: Partial<ClaudishConfig> = {}): ClaudishConfig =>
  ({ claudeArgs: [], ...overrides }) as ClaudishConfig;
const statusLine = { type: "command", command: "echo hi", padding: 0 };

describe("isProxyAuthMode", () => {
  test("alternative models use proxy authentication", () => {
    expect(isProxyAuthMode(config({ model: "cx@gpt-6-astra" }))).toBe(true);
  });

  test("a fully remapped Fable role uses proxy authentication", () => {
    expect(isProxyAuthMode(config({ modelFable: "cx@gpt-6-astra" }))).toBe(true);
  });

  test("any native Anthropic mapping preserves claude.ai authentication", () => {
    expect(isProxyAuthMode(config({ modelOpus: "claude-opus-5" }))).toBe(false);
    expect(isProxyAuthMode(config({ modelFable: "claude-fable-5-1" }))).toBe(false);
  });

  test("monitor mode preserves native authentication", () => {
    expect(isProxyAuthMode(config({ monitor: true, model: "cx@gpt-6-astra" }))).toBe(false);
  });
});

describe("buildClaudishSettingsOverlay", () => {
  test("proxy-only mode bypasses claude.ai onboarding", () => {
    const overlay = buildClaudishSettingsOverlay(statusLine, true);
    expect(overlay).toEqual({
      statusLine,
      disableClaudeAiConnectors: true,
      forceLoginMethod: "console",
    });
  });

  test("native and monitor modes do not force a login method", () => {
    const overlay = buildClaudishSettingsOverlay(statusLine, false);
    expect("forceLoginMethod" in overlay).toBe(false);
  });

  test("the settings overlay contains no credentials", () => {
    const json = JSON.stringify(buildClaudishSettingsOverlay(statusLine, true));
    expect(json).not.toContain("ANTHROPIC_API_KEY");
    expect(json).not.toContain("ANTHROPIC_AUTH_TOKEN");
    expect(json).not.toContain("x-proxy-key");
  });
});

describe("managedSettingsForcesClaudeAi", () => {
  test("detects an unoverrideable claude.ai policy", () => {
    const readFile = (() => JSON.stringify({ forceLoginMethod: "claudeai" })) as never;
    expect(managedSettingsForcesClaudeAi(readFile)).toBe(true);
  });

  test("allows console or unspecified managed authentication", () => {
    const consolePolicy = (() => JSON.stringify({ forceLoginMethod: "console" })) as never;
    const noPolicy = (() => JSON.stringify({})) as never;
    expect(managedSettingsForcesClaudeAi(consolePolicy)).toBe(false);
    expect(managedSettingsForcesClaudeAi(noPolicy)).toBe(false);
  });

  test("missing, unreadable, or malformed managed settings are non-fatal", () => {
    const unreadable = (() => {
      throw new Error("EACCES");
    }) as never;
    const malformed = (() => "{ invalid") as never;
    expect(managedSettingsForcesClaudeAi(unreadable)).toBe(false);
    expect(managedSettingsForcesClaudeAi(malformed)).toBe(false);
  });
});
