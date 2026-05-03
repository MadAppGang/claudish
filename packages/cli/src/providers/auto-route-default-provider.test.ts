/**
 * Focused unit tests for Phase 2 default-provider routing in getFallbackChain().
 *
 * These tests mutate process.env to exercise different credential permutations
 * without depending on the host shell environment. Each test restores env in
 * afterEach. They do NOT hit the network — only the synchronous chain builder
 * is exercised.
 *
 * Run: bun test packages/cli/src/providers/auto-route-default-provider.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getDefaultProviderRoute, getFallbackChain } from "./auto-route.js";
import { loadCustomEndpoints } from "./custom-endpoints-loader.js";
import { clearRuntimeRegistry } from "./runtime-providers.js";

const originalEnv = { ...process.env };

describe("getDefaultProviderRoute", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    clearRuntimeRegistry();
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    clearRuntimeRegistry();
  });

  test("returns litellm route when default='litellm' and both LITELLM env vars set", () => {
    process.env.LITELLM_BASE_URL = "http://example.invalid:4000";
    process.env.LITELLM_API_KEY = "test-key";
    const route = getDefaultProviderRoute("foo-model", "litellm");
    expect(route).not.toBeNull();
    expect(route!.provider).toBe("litellm");
    expect(route!.modelSpec).toBe("litellm@foo-model");
  });

  test("returns null for default='litellm' when LITELLM_API_KEY missing", () => {
    process.env.LITELLM_BASE_URL = "http://example.invalid:4000";
    delete process.env.LITELLM_API_KEY;
    expect(getDefaultProviderRoute("foo-model", "litellm")).toBeNull();
  });

  test("returns openrouter route when default='openrouter' and OPENROUTER_API_KEY set", () => {
    process.env.OPENROUTER_API_KEY = "test-or-key";
    const route = getDefaultProviderRoute("foo-model", "openrouter");
    expect(route).not.toBeNull();
    expect(route!.provider).toBe("openrouter");
  });

  test("returns null for native-API defaults (openai/anthropic/google)", () => {
    expect(getDefaultProviderRoute("foo-model", "openai")).toBeNull();
    expect(getDefaultProviderRoute("foo-model", "anthropic")).toBeNull();
    expect(getDefaultProviderRoute("foo-model", "google")).toBeNull();
  });

  test("returns null for unknown default provider name", () => {
    expect(getDefaultProviderRoute("foo-model", "my-unknown-endpoint")).toBeNull();
  });

  test("returns custom endpoint route when default provider is registered", () => {
    const result = loadCustomEndpoints({
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      customEndpoints: {
        "my-custom-endpoint": {
          kind: "simple",
          url: "https://api.example.com/v1",
          format: "openai",
          apiKey: "stored-key",
        },
      },
    });

    expect(result.registered).toBe(1);
    const route = getDefaultProviderRoute("foo-model", "my-custom-endpoint");
    expect(route).not.toBeNull();
    expect(route!.provider).toBe("my-custom-endpoint");
    expect(route!.modelSpec).toBe("my-custom-endpoint@foo-model");
    expect(route!.displayName).toBe("my-custom-endpoint");
  });

  test("canonicalizes default provider shortcut before building route", () => {
    process.env.LITELLM_BASE_URL = "http://example.invalid:4000";
    process.env.LITELLM_API_KEY = "test-key";
    const route = getDefaultProviderRoute("foo-model", "ll");
    expect(route).not.toBeNull();
    expect(route!.provider).toBe("litellm");
    expect(route!.modelSpec).toBe("litellm@foo-model");
  });
});

describe("getFallbackChain — default provider seeding", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    clearRuntimeRegistry();
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    clearRuntimeRegistry();
  });

  test("case 1: default='litellm' with LITELLM env vars puts litellm first", () => {
    process.env.LITELLM_BASE_URL = "http://example.invalid:4000";
    process.env.LITELLM_API_KEY = "test-ll-key";
    const chain = getFallbackChain("foo-model", "minimax", "litellm");
    expect(chain.length).toBeGreaterThan(0);
    expect(chain[0].provider).toBe("litellm");
  });

  test("case 2: default='openrouter' with OPENROUTER_API_KEY puts openrouter first and omits litellm even if LITELLM env vars set", () => {
    process.env.OPENROUTER_API_KEY = "test-or-key";
    process.env.LITELLM_BASE_URL = "http://example.invalid:4000";
    process.env.LITELLM_API_KEY = "test-ll-key";
    const chain = getFallbackChain("foo-model", "minimax", "openrouter");
    expect(chain.length).toBeGreaterThan(0);
    expect(chain[0].provider).toBe("openrouter");
    const providers = chain.map((r) => r.provider);
    expect(providers).not.toContain("litellm");
  });

  test("case 3: default='openai' adds no default-provider route (falls through to native + OpenRouter steps)", () => {
    // Ensure no litellm credentials bleed in
    delete process.env.LITELLM_BASE_URL;
    delete process.env.LITELLM_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-or-key";
    const chain = getFallbackChain("foo-model", "minimax", "openai");
    const providers = chain.map((r) => r.provider);
    // default-provider step contributed nothing — no 'openai' route seeded at position 0
    expect(providers[0]).not.toBe("openai");
    // OpenRouter still appears as universal fallback
    expect(providers).toContain("openrouter");
    // No LiteLLM even though it was historically always-first
    expect(providers).not.toContain("litellm");
  });

  test("case 4: default='unknown-custom' contributes no route but chain still builds", () => {
    delete process.env.LITELLM_BASE_URL;
    delete process.env.LITELLM_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-or-key";
    const chain = getFallbackChain("foo-model", "minimax", "my-custom-endpoint");
    expect(chain.length).toBeGreaterThan(0);
    const providers = chain.map((r) => r.provider);
    expect(providers).toContain("openrouter");
    expect(providers).not.toContain("my-custom-endpoint");
  });

  test("case 5: dedup — default='openrouter' with OPENROUTER_API_KEY contains exactly one openrouter entry", () => {
    process.env.OPENROUTER_API_KEY = "test-or-key";
    const chain = getFallbackChain("foo-model", "minimax", "openrouter");
    const orCount = chain.filter((r) => r.provider === "openrouter").length;
    expect(orCount).toBe(1);
  });

  test("case 6: calling without third arg still works (back-compat via internal resolver)", () => {
    delete process.env.LITELLM_BASE_URL;
    delete process.env.LITELLM_API_KEY;
    delete process.env.CLAUDISH_DEFAULT_PROVIDER;
    process.env.OPENROUTER_API_KEY = "test-or-key";
    // No explicit default — resolver should pick "openrouter" from OPENROUTER_API_KEY presence
    const chain = getFallbackChain("foo-model", "minimax");
    expect(chain.length).toBeGreaterThan(0);
    const providers = chain.map((r) => r.provider);
    expect(providers).toContain("openrouter");
    // Legacy LiteLLM auto-promotion doesn't fire when env vars absent
    expect(providers).not.toContain("litellm");
  });
});
