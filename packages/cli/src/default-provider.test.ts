import { describe, expect, test } from "bun:test";
import {
  buildLegacyHint,
  resolveDefaultProvider,
  type ResolvedDefaultProvider,
} from "./default-provider.js";
import type { ClaudishProfileConfig } from "./profile-config.js";

function makeConfig(overrides: Partial<ClaudishProfileConfig> = {}): ClaudishProfileConfig {
  return {
    version: "1.0.0",
    defaultProfile: "default",
    profiles: {},
    ...overrides,
  };
}

describe("resolveDefaultProvider precedence", () => {
  test("CLI flag wins over env var, config, and legacy", () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDISH_DEFAULT_PROVIDER: "from-env",
      LITELLM_BASE_URL: "http://litellm.local",
      LITELLM_API_KEY: "key",
      OPENROUTER_API_KEY: "or-key",
    };
    const config = makeConfig({ defaultProvider: "from-config" });

    const result = resolveDefaultProvider({ cliFlag: "from-flag", config, env });

    expect(result.provider).toBe("from-flag");
    expect(result.source).toBe("cli-flag");
    expect(result.legacyAutoPromoted).toBe(false);
  });

  test("CLI flag shortcut is canonicalized", () => {
    const env: NodeJS.ProcessEnv = {};
    const config = makeConfig();

    const result = resolveDefaultProvider({ cliFlag: "ll", config, env });

    expect(result.provider).toBe("litellm");
    expect(result.source).toBe("cli-flag");
  });

  test("env var wins over config and legacy", () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDISH_DEFAULT_PROVIDER: "from-env",
      LITELLM_BASE_URL: "http://litellm.local",
      LITELLM_API_KEY: "key",
    };
    const config = makeConfig({ defaultProvider: "from-config" });

    const result = resolveDefaultProvider({ config, env });

    expect(result.provider).toBe("from-env");
    expect(result.source).toBe("env-var");
    expect(result.legacyAutoPromoted).toBe(false);
  });

  test("env var shortcut is canonicalized", () => {
    const env: NodeJS.ProcessEnv = { CLAUDISH_DEFAULT_PROVIDER: "or" };
    const config = makeConfig();

    const result = resolveDefaultProvider({ config, env });

    expect(result.provider).toBe("openrouter");
    expect(result.source).toBe("env-var");
  });

  test("config wins over legacy", () => {
    const env: NodeJS.ProcessEnv = {
      LITELLM_BASE_URL: "http://litellm.local",
      LITELLM_API_KEY: "key",
    };
    const config = makeConfig({ defaultProvider: "from-config" });

    const result = resolveDefaultProvider({ config, env });

    expect(result.provider).toBe("from-config");
    expect(result.source).toBe("config-file");
    expect(result.legacyAutoPromoted).toBe(false);
  });

  test("legacy LITELLM auto-promotes when nothing else set", () => {
    const env: NodeJS.ProcessEnv = {
      LITELLM_BASE_URL: "http://litellm.local",
      LITELLM_API_KEY: "key",
    };
    const config = makeConfig();

    const result = resolveDefaultProvider({ config, env });

    expect(result.provider).toBe("litellm");
    expect(result.source).toBe("legacy-litellm");
    expect(result.legacyAutoPromoted).toBe(true);
  });

  test("OPENROUTER_API_KEY fallback when no LITELLM", () => {
    const env: NodeJS.ProcessEnv = {
      OPENROUTER_API_KEY: "or-key",
    };
    const config = makeConfig();

    const result = resolveDefaultProvider({ config, env });

    expect(result.provider).toBe("openrouter");
    expect(result.source).toBe("openrouter-key");
    expect(result.legacyAutoPromoted).toBe(false);
  });

  test("hardcoded openrouter when nothing set", () => {
    const env: NodeJS.ProcessEnv = {};
    const config = makeConfig();

    const result = resolveDefaultProvider({ config, env });

    expect(result.provider).toBe("openrouter");
    expect(result.source).toBe("hardcoded");
    expect(result.legacyAutoPromoted).toBe(false);
  });

  test("LITELLM_BASE_URL alone without LITELLM_API_KEY does not auto-promote", () => {
    const env: NodeJS.ProcessEnv = {
      LITELLM_BASE_URL: "http://litellm.local",
    };
    const config = makeConfig();

    const result = resolveDefaultProvider({ config, env });

    expect(result.provider).toBe("openrouter");
    expect(result.source).toBe("hardcoded");
    expect(result.legacyAutoPromoted).toBe(false);
  });

  test("empty CLI flag falls through (does not match)", () => {
    const env: NodeJS.ProcessEnv = { CLAUDISH_DEFAULT_PROVIDER: "from-env" };
    const config = makeConfig();

    const result = resolveDefaultProvider({ cliFlag: "", config, env });

    expect(result.provider).toBe("from-env");
    expect(result.source).toBe("env-var");
  });
});

describe("buildLegacyHint", () => {
  test("returns string only when legacyAutoPromoted is true", () => {
    const resolved: ResolvedDefaultProvider = {
      provider: "litellm",
      source: "legacy-litellm",
      legacyAutoPromoted: true,
    };

    const hint = buildLegacyHint(resolved);
    expect(hint).not.toBeNull();
    expect(hint).toContain("LITELLM_BASE_URL");
    expect(hint).toContain("defaultProvider");
  });

  test("returns null for cli-flag source", () => {
    const resolved: ResolvedDefaultProvider = {
      provider: "openrouter",
      source: "cli-flag",
      legacyAutoPromoted: false,
    };

    expect(buildLegacyHint(resolved)).toBeNull();
  });

  test("returns null for hardcoded source", () => {
    const resolved: ResolvedDefaultProvider = {
      provider: "openrouter",
      source: "hardcoded",
      legacyAutoPromoted: false,
    };

    expect(buildLegacyHint(resolved)).toBeNull();
  });
});
