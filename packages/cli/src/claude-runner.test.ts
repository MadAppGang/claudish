import { describe, expect, test } from "bun:test";
import { ENV } from "./config.js";
import { applyModelMappingEnv } from "./claude-runner.js";
import type { ClaudishConfig } from "./types.js";

function makeConfig(overrides: Partial<ClaudishConfig>): ClaudishConfig {
  return {
    model: undefined,
    claudeArgs: [],
    interactive: false,
    stdin: false,
    quiet: true,
    monitor: false,
    debug: false,
    dangerous: false,
    logLevel: "info",
    jsonOutput: false,
    autoApprove: false,
    summarizeTools: false,
    noLogs: true,
    diagMode: "off",
    ...overrides,
  };
}

describe("applyModelMappingEnv", () => {
  test("writes resolved role mappings to Claude Code standard env vars", () => {
    const env: Record<string, string> = {};
    applyModelMappingEnv(
      env,
      makeConfig({
        modelOpus: "meridian@claude-opus-4-7",
        modelSonnet: "ds@deepseek-v4-flash",
        modelHaiku: "meridian@claude-haiku-4-5",
        modelSubagent: "ds@deepseek-v4-pro",
      })
    );

    expect(env[ENV.ANTHROPIC_DEFAULT_OPUS_MODEL]).toBe("meridian@claude-opus-4-7");
    expect(env[ENV.ANTHROPIC_DEFAULT_SONNET_MODEL]).toBe("ds@deepseek-v4-flash");
    expect(env[ENV.ANTHROPIC_DEFAULT_HAIKU_MODEL]).toBe("meridian@claude-haiku-4-5");
    expect(env[ENV.CLAUDE_CODE_SUBAGENT_MODEL]).toBe("ds@deepseek-v4-pro");
  });

  test("leaves existing env untouched when a role has no mapping", () => {
    const env: Record<string, string> = {
      [ENV.CLAUDE_CODE_SUBAGENT_MODEL]: "existing-subagent",
    };
    applyModelMappingEnv(env, makeConfig({ modelHaiku: "meridian@claude-haiku-4-5" }));

    expect(env[ENV.ANTHROPIC_DEFAULT_HAIKU_MODEL]).toBe("meridian@claude-haiku-4-5");
    expect(env[ENV.CLAUDE_CODE_SUBAGENT_MODEL]).toBe("existing-subagent");
    expect(env[ENV.ANTHROPIC_DEFAULT_OPUS_MODEL]).toBeUndefined();
  });
});
