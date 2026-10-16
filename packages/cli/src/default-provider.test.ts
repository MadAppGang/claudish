import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildLegacyHint,
  planDefaultProviderFlag,
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

  test('strict opt-out asymmetry (#483 CR): config "" is NOT an opt-out, env "" is', () => {
    // The truthiness guard on the config branch drops defaultProvider:"" and
    // falls through to openrouter — only a PRESENT-EMPTY CLAUDISH_DEFAULT_
    // PROVIDER disables the fallback hop. Pinned so the strict-mode recipe in
    // docs/settings-reference.md §6.1 (routing["*"]=[] + env present-empty)
    // can never drift from the resolver again.
    const configEmpty = makeConfig({ defaultProvider: "" });
    const envOr: NodeJS.ProcessEnv = { OPENROUTER_API_KEY: "or-key" };

    const configResult = resolveDefaultProvider({ config: configEmpty, env: envOr });
    expect(configResult.provider).toBe("openrouter");
    expect(configResult.source).toBe("openrouter-key");

    const envResult = resolveDefaultProvider({
      config: configEmpty,
      env: { ...envOr, CLAUDISH_DEFAULT_PROVIDER: "" },
    });
    expect(envResult.provider).toBe("");
    expect(envResult.source).toBe("env-var");
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

  test("an empty env var disables the fallback and keeps the env-var source (upstream 9be012fc)", () => {
    // `--default-provider ""` arrives as CLAUDISH_DEFAULT_PROVIDER="" via
    // planDefaultProviderFlag: PRESENT-but-empty beats the config file and
    // disables the fallback hop. A missing env var falls through instead.
    const config = makeConfig({ defaultProvider: "from-config" });

    const empty = resolveDefaultProvider({
      config,
      env: { CLAUDISH_DEFAULT_PROVIDER: "" },
    });
    expect(empty).toEqual({ provider: "", source: "env-var", legacyAutoPromoted: false });

    const missing = resolveDefaultProvider({ config, env: {} });
    expect(missing.provider).toBe("from-config");
    expect(missing.source).toBe("config-file");
  });
});

describe("planDefaultProviderFlag (upstream 9be012fc: pre-scan before parseArgs)", () => {
  test("no flag → none, argv untouched", () => {
    const plan = planDefaultProviderFlag(["--probe", "glm-5.2", "--json"]);
    expect(plan).toEqual({ kind: "none" });
  });

  test("flag before --probe → apply, stripped", () => {
    const plan = planDefaultProviderFlag(["--default-provider", "poe", "--probe", "m", "--json"]);
    expect(plan.kind).toBe("apply");
    if (plan.kind === "apply") {
      expect(plan.value).toBe("poe");
      expect(plan.argv).toEqual(["--probe", "m", "--json"]);
    }
  });

  test("flag AFTER --probe → apply all the same (the bug this port fixes)", () => {
    // --probe runs and exits inside parseArgs's argv loop, so a flag parsed
    // there — or positioned after it — never reached the probe. The pre-scan
    // is position-blind by design.
    const plan = planDefaultProviderFlag(["--probe", "m", "--default-provider", "poe"]);
    expect(plan.kind).toBe("apply");
    if (plan.kind === "apply") {
      expect(plan.value).toBe("poe");
      expect(plan.argv).toEqual(["--probe", "m"]);
    }
  });

  test("= form, and empty value survives as a real value", () => {
    const eq = planDefaultProviderFlag(["--default-provider=poe", "prompt"]);
    expect(eq).toEqual({ kind: "apply", value: "poe", argv: ["prompt"] });

    const empty = planDefaultProviderFlag(["--default-provider", "", "prompt"]);
    expect(empty).toEqual({ kind: "apply", value: "", argv: ["prompt"] });
  });

  test("last occurrence wins; every occurrence is stripped", () => {
    const plan = planDefaultProviderFlag([
      "--default-provider=a",
      "--default-provider",
      "b",
      "x",
    ]);
    expect(plan).toEqual({ kind: "apply", value: "b", argv: ["x"] });
  });

  test("dangling flag or flag-like value → error, argv not half-consumed", () => {
    const dangling = planDefaultProviderFlag(["--default-provider"]);
    expect(dangling.kind).toBe("error");

    const flagLike = planDefaultProviderFlag(["--default-provider", "--json", "m"]);
    expect(flagLike.kind).toBe("error");
  });

  test("scan stops at -- : the rest belongs to Claude Code", () => {
    const plan = planDefaultProviderFlag(["--default-provider", "poe", "--", "--default-provider", "keep"]);
    expect(plan.kind).toBe("apply");
    if (plan.kind === "apply") {
      expect(plan.value).toBe("poe");
      expect(plan.argv).toEqual(["--", "--default-provider", "keep"]);
    }
  });
});

describe("index.ts applies the flag plan before any dispatch (structural pin)", () => {
  // The pre-scan only works if it runs BEFORE the argv is consumed: before the
  // MCP-mode check and before parseArgs. Structural pin in the mcp-dotenv-quiet
  // style (in-process import of index.ts would start the CLI).
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");

  test("applyDefaultProviderFlag is defined and awaited before the MCP-mode check", () => {
    const call = "await applyDefaultProviderFlag();";
    const gate = 'const isMcpMode = process.argv.includes("--mcp");';
    const callIdx = source.indexOf(call);
    const gateIdx = source.indexOf(gate);
    expect(callIdx).toBeGreaterThanOrEqual(0);
    expect(gateIdx).toBeGreaterThanOrEqual(0);
    expect(callIdx).toBeLessThan(gateIdx);
  });

  test("the applied plan exports the value to the env, not to a config field", () => {
    expect(source).toContain("process.env.CLAUDISH_DEFAULT_PROVIDER = plan.value;");
    expect(source).not.toContain("config.defaultProvider = plan.value");
  });
});

describe("buildLegacyHint (commit 5: now a no-op)", () => {
  // Pre-commit-5, this returned a stderr hint when legacyAutoPromoted=true.
  // Since LiteLLM auto-promotion was removed, the function always returns
  // null — kept for backwards-compat with existing callers.
  test("always returns null", () => {
    const resolvedTrue: ResolvedDefaultProvider = {
      provider: "litellm",
      source: "config-file",
      legacyAutoPromoted: true,
    };
    const resolvedFalse: ResolvedDefaultProvider = {
      provider: "openrouter",
      source: "hardcoded",
      legacyAutoPromoted: false,
    };

    expect(buildLegacyHint(resolvedTrue)).toBeNull();
    expect(buildLegacyHint(resolvedFalse)).toBeNull();
  });
});
