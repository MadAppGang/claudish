import { describe, expect, it } from "bun:test";
import { AUTO_MODE_SERVER_ENV_VAR, resolveAutoModeServerEnv } from "./claude-runner.js";
import type { ClaudishConfig } from "./types.js";

function config(overrides: Partial<ClaudishConfig> = {}): ClaudishConfig {
  return {
    autoApprove: false,
    dangerous: false,
    interactive: false,
    debug: false,
    logLevel: "info",
    quiet: false,
    jsonOutput: false,
    monitor: false,
    stdin: false,
    claudeArgs: [],
    noLogs: false,
    diagMode: "auto",
    ...overrides,
  };
}

describe("resolveAutoModeServerEnv", () => {
  it("turns the server-side classifier off when passthrough is on by flag", () => {
    const vars = resolveAutoModeServerEnv(config({ classifierProvider: "anthropic" }), {});
    expect(vars[AUTO_MODE_SERVER_ENV_VAR]).toBe("0");
  });

  it("turns the server-side classifier off when passthrough is on by environment", () => {
    const vars = resolveAutoModeServerEnv(config(), { CLAUDISH_CLASSIFIER_PROVIDER: "anthropic" });
    expect(vars[AUTO_MODE_SERVER_ENV_VAR]).toBe("0");
  });

  it("turns it off when only a classifier model is named", () => {
    const vars = resolveAutoModeServerEnv(config({ classifierModel: "claude-sonnet-5" }), {});
    expect(vars[AUTO_MODE_SERVER_ENV_VAR]).toBe("0");
  });

  it("sets nothing without passthrough", () => {
    expect(resolveAutoModeServerEnv(config(), {})).toEqual({});
  });

  it("sets nothing in monitor mode, where the main loop reaches Anthropic and the server can review", () => {
    const vars = resolveAutoModeServerEnv(
      config({ monitor: true, classifierProvider: "anthropic" }),
      {}
    );
    expect(vars).toEqual({});
  });

  it("leaves a value the user exported alone, including 1", () => {
    const parentEnv = { [AUTO_MODE_SERVER_ENV_VAR]: "1" };
    const vars = resolveAutoModeServerEnv(config({ classifierProvider: "anthropic" }), parentEnv);
    expect(vars).toEqual({});
    expect({ ...parentEnv, ...vars }[AUTO_MODE_SERVER_ENV_VAR]).toBe("1");
  });
});
