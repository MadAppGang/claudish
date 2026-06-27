import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AuthSource,
  type ProviderDef,
  providerAuthSource,
  providerIsReady,
  providerIsReadyForDisplay,
} from "./providers.js";

// Minimal ProviderDef builder for the helpers under test.
function def(overrides: Partial<ProviderDef>): ProviderDef {
  return {
    name: "test",
    catalogName: "test",
    displayName: "Test",
    apiKeyEnvVar: "CLAUDISH_TEST_PROVIDERS_KEY",
    description: "",
    keyUrl: "",
    ...overrides,
  };
}

const EMPTY = { apiKeys: {} as Record<string, string>, localProviders: [] as string[] };

describe("providerAuthSource", () => {
  const ENV = "CLAUDISH_TEST_PROVIDERS_KEY";
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[ENV];
    delete process.env[ENV];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  test("null when no credential of any kind", () => {
    expect(providerAuthSource(def({}), EMPTY)).toBeNull();
  });

  test("'env' when the env var is set", () => {
    process.env[ENV] = "sk-123";
    expect(providerAuthSource(def({}), EMPTY)).toBe<AuthSource>("env");
  });

  test("'cfg' when only a config key is set", () => {
    expect(providerAuthSource(def({}), { apiKeys: { [ENV]: "sk-cfg" } })).toBe<AuthSource>("cfg");
  });

  test("'e+c' when both env and config are set", () => {
    process.env[ENV] = "sk-env";
    expect(providerAuthSource(def({}), { apiKeys: { [ENV]: "sk-cfg" } })).toBe<AuthSource>("e+c");
  });

  // Regression for the OpenCode Zen bug: a keyless/free provider
  // (publicKeyFallback) must report a NON-NULL source so it sorts above the
  // "not configured" divider and shows a ready dot — matching providerIsReady.
  test("'public' for a keyless provider with publicKeyFallback and no user key", () => {
    expect(providerAuthSource(def({ publicKeyFallback: true }), EMPTY)).toBe<AuthSource>("public");
  });

  test("a real env key wins over the public-key affordance", () => {
    process.env[ENV] = "sk-real";
    expect(providerAuthSource(def({ publicKeyFallback: true }), EMPTY)).toBe<AuthSource>("env");
  });

  test("local provider: 'local' only when enabled in config", () => {
    const local = def({ isLocal: true, catalogName: "ollama", apiKeyEnvVar: "" });
    expect(providerAuthSource(local, { localProviders: [] })).toBeNull();
    expect(providerAuthSource(local, { localProviders: ["ollama"] })).toBe<AuthSource>("local");
  });
});

describe("providerIsReady agrees with providerAuthSource for the public case", () => {
  const ENV = "CLAUDISH_TEST_PROVIDERS_KEY";
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[ENV];
    delete process.env[ENV];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  // The core invariant the OpenCode Zen fix restores: the SOURCE classifier and
  // the readiness oracle must NOT disagree for a keyless provider, or the row
  // renders "ready" under "not configured".
  test("keyless provider is ready AND has a non-null source", () => {
    const zen = def({ publicKeyFallback: true });
    expect(providerAuthSource(zen, EMPTY)).not.toBeNull();
    expect(providerIsReady(zen, EMPTY)).toBe(true);
  });

  // Regression for the direct-Gemini false-ready bug: the direct-Gemini row has
  // catalogName "google", which the authority aliases onto the Gemini Code
  // Assist OAuth credential. A NON-OAuth-capable provider (no oauthSlug) must
  // NOT be marked ready by that OAuth alias — only by a real API key. Otherwise
  // an OAuth-only user sees the direct row green and gets a 401 on probe.
  test("API-key-only provider with no key is NOT ready even if its catalogName has OAuth", () => {
    // catalogName "google" → credentials.isAuthenticated("google") may be true
    // (Code Assist OAuth on disk), but the direct-Gemini row has no oauthSlug.
    const directGemini = def({
      name: "gemini",
      catalogName: "google",
      apiKeyEnvVar: "CLAUDISH_TEST_PROVIDERS_KEY",
      // no oauthSlug, no publicKeyFallback, no env/cfg key
    });
    expect(providerIsReady(directGemini, EMPTY)).toBe(false);
  });

  test("API-key-only provider IS ready once a real key is present", () => {
    process.env[ENV] = "sk-gemini-direct";
    const directGemini = def({ name: "gemini", catalogName: "google" });
    expect(providerIsReady(directGemini, EMPTY)).toBe(true);
  });
});

describe("providerIsReadyForDisplay — running local counts as ready", () => {
  // Regression: a RUNNING but not-config-enabled local (e.g. a freshly-started
  // Ollama) must sort/divide as ready, matching its "running" status — not sit
  // below the "not configured" divider with a hollow dot.
  test("running local is ready for display even when not config-enabled", () => {
    const ollama = def({ isLocal: true, catalogName: "ollama", apiKeyEnvVar: "" });
    // Plain readiness: NOT enabled → not ready.
    expect(providerIsReady(ollama, { localProviders: [] })).toBe(false);
    // Display readiness with liveness "running" → ready.
    expect(providerIsReadyForDisplay(ollama, { localProviders: [] }, { ollama: "running" })).toBe(
      true
    );
  });

  test("down/unknown local is NOT ready for display when not enabled", () => {
    const ollama = def({ isLocal: true, catalogName: "ollama", apiKeyEnvVar: "" });
    expect(providerIsReadyForDisplay(ollama, { localProviders: [] }, { ollama: "down" })).toBe(
      false
    );
    expect(providerIsReadyForDisplay(ollama, { localProviders: [] }, {})).toBe(false);
  });

  test("config-enabled local is ready regardless of liveness", () => {
    const ollama = def({ isLocal: true, catalogName: "ollama", apiKeyEnvVar: "" });
    expect(
      providerIsReadyForDisplay(ollama, { localProviders: ["ollama"] }, { ollama: "down" })
    ).toBe(true);
  });

  test("non-local provider: liveness is irrelevant, falls through to providerIsReady", () => {
    const saved = process.env.CLAUDISH_TEST_PROVIDERS_KEY;
    delete process.env.CLAUDISH_TEST_PROVIDERS_KEY;
    try {
      const openrouter = def({ name: "openrouter", catalogName: "openrouter" });
      expect(
        providerIsReadyForDisplay(openrouter, { apiKeys: {} }, { ollama: "running" })
      ).toBe(false);
    } finally {
      if (saved !== undefined) process.env.CLAUDISH_TEST_PROVIDERS_KEY = saved;
    }
  });
});
