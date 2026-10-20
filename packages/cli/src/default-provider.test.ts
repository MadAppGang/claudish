import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDefaultProvider } from "./default-provider.js";
import type { ClaudishProfileConfig } from "./profile-config.js";

const STAGE4_CATALOG_FIXTURE = join(
  import.meta.dir,
  "test-fixtures",
  "stage4-default-provider-catalog.json"
);
const CLI_ENTRY = join(import.meta.dir, "index.ts");

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

  test("an empty env var disables the fallback and keeps the env-var source", () => {
    expect(
      resolveDefaultProvider({
        config: makeConfig(),
        env: { CLAUDISH_DEFAULT_PROVIDER: "" },
      })
    ).toEqual({ provider: "", source: "env-var", legacyAutoPromoted: false });
  });

  test("an empty config value disables the fallback and keeps the config-file source", () => {
    expect(
      resolveDefaultProvider({ config: makeConfig({ defaultProvider: "" }), env: {} })
    ).toEqual({
      provider: "",
      source: "config-file",
      legacyAutoPromoted: false,
    });
  });

  test("an empty env var beats a non-empty config value", () => {
    expect(
      resolveDefaultProvider({
        config: makeConfig({ defaultProvider: "from-config" }),
        env: { CLAUDISH_DEFAULT_PROVIDER: "" },
      })
    ).toEqual({ provider: "", source: "env-var", legacyAutoPromoted: false });
  });

  test("a non-empty CLI flag beats an empty env var", () => {
    expect(
      resolveDefaultProvider({
        cliFlag: "from-flag",
        config: makeConfig({ defaultProvider: "from-config" }),
        env: { CLAUDISH_DEFAULT_PROVIDER: "" },
      })
    ).toEqual({ provider: "from-flag", source: "cli-flag", legacyAutoPromoted: false });
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

  test("LITELLM env vars no longer auto-promote (commit 5: removed)", () => {
    // Pre-commit-5, having both LITELLM_BASE_URL and LITELLM_API_KEY set
    // would resolve provider="litellm" with source="legacy-litellm". After
    // commit 5 of the catalog/routing redesign, this auto-promotion is gone
    // — the resolver falls through to the next tier (OPENROUTER_API_KEY or
    // hardcoded). Users wanting LiteLLM as default must set defaultProvider
    // explicitly in config.json or via CLAUDISH_DEFAULT_PROVIDER.
    const env: NodeJS.ProcessEnv = {
      LITELLM_BASE_URL: "http://litellm.local",
      LITELLM_API_KEY: "key",
    };
    const config = makeConfig();

    const result = resolveDefaultProvider({ config, env });

    expect(result.provider).toBe("openrouter");
    expect(result.source).toBe("hardcoded");
    expect(result.legacyAutoPromoted).toBe(false);
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

interface ProbeJson {
  chain: Array<{ provider: string }>;
  dropped: Array<{
    provider: string;
    position: "candidate" | "fallback";
    label: string;
    outcome: string;
  }>;
}

function sandboxedProbe(flagBeforeProbe: boolean, provider: string): ProbeJson {
  const home = mkdtempSync(join(tmpdir(), "claudish-default-provider-probe-"));
  const configDir = join(home, ".claudish");
  mkdirSync(configDir, { recursive: true });
  copyFileSync(STAGE4_CATALOG_FIXTURE, join(configDir, "cloud-models-catalog-v3.json"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ version: "1.0.0", defaultProfile: "default", profiles: {} }),
    "utf8"
  );

  const flag = ["--default-provider", provider];
  const probe = ["--probe", "no-such-model-xyz"];
  const args = flagBeforeProbe
    ? [CLI_ENTRY, ...flag, ...probe, "--json", "--no-probe"]
    : [CLI_ENTRY, ...probe, ...flag, "--json", "--no-probe"];
  const env: Record<string, string> = {
    HOME: home,
    PATH: process.env.PATH ?? "",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    CLAUDISH_DISABLE_CATALOG_WARM: "1",
    CLAUDISH_DISABLE_KEYCHAIN: "1",
    CLAUDISH_DISABLE_OP: "1",
    CLAUDISH_SKIP_LIVE_E2E: "1",
  };

  try {
    const result = Bun.spawnSync([process.execPath, "--no-env-file", ...args], {
      cwd: join(import.meta.dir, "../../.."),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    expect(result.exitCode, stderr || stdout).toBe(0);
    const parsed = JSON.parse(stdout) as ProbeJson[];
    expect(parsed).toHaveLength(1);
    return parsed[0];
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("--default-provider pre-scan reaches --probe", () => {
  test("uses poe when the flag appears before --probe", () => {
    const result = sandboxedProbe(true, "poe");
    expect([...result.chain, ...result.dropped].map((entry) => entry.provider)).toEqual(["poe"]);
    expect(result.dropped).toEqual([
      expect.objectContaining({
        provider: "poe",
        position: "fallback",
        label: "fallback",
        outcome: "no-credential",
      }),
    ]);
  });

  test("uses poe when the flag appears after the probed model", () => {
    const result = sandboxedProbe(false, "poe");
    expect([...result.chain, ...result.dropped].map((entry) => entry.provider)).toEqual(["poe"]);
    expect(result.dropped).toEqual([
      expect.objectContaining({
        provider: "poe",
        position: "fallback",
        label: "fallback",
        outcome: "no-credential",
      }),
    ]);
  });

  test("an empty flag value produces an empty chain", () => {
    expect(sandboxedProbe(true, "").chain).toEqual([]);
  });
});
