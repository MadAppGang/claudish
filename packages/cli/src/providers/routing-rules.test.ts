/**
 * Unit tests for providers/routing-rules.ts
 *
 * Tests matchRoutingRule, buildRoutingChain, and loadRoutingRules
 * without hitting any real APIs or file system config.
 *
 * Run: bun test packages/cli/src/providers/routing-rules.test.ts
 */

import { describe, test, expect } from "bun:test";
import { matchRoutingRule, buildRoutingChain, loadRoutingRules } from "./routing-rules.js";
import { PROVIDER_SHORTCUTS } from "./model-parser.js";
import { PROVIDER_TO_PREFIX, DISPLAY_NAMES } from "./auto-route.js";
import type { RoutingRules } from "../profile-config.js";

// ---------------------------------------------------------------------------
// matchRoutingRule — pattern matching
// ---------------------------------------------------------------------------

describe("matchRoutingRule", () => {
  test("exact match returns the chain for that model", () => {
    const rules: RoutingRules = {
      "kimi-k2.5": ["kimi", "openrouter"],
      "gpt-4o": ["openai"],
    };
    const result = matchRoutingRule("kimi-k2.5", rules);
    expect(result).toEqual(["kimi", "openrouter"]);
  });

  test("exact match returns different chain than glob that would also match", () => {
    const rules: RoutingRules = {
      "kimi-k2.5": ["kimi"],
      "kimi-*": ["openrouter"],
    };
    // Exact match should win even though glob also matches
    const result = matchRoutingRule("kimi-k2.5", rules);
    expect(result).toEqual(["kimi"]);
  });

  test("glob pattern 'kimi-*' matches 'kimi-k2.5'", () => {
    const rules: RoutingRules = {
      "kimi-*": ["openrouter"],
    };
    const result = matchRoutingRule("kimi-k2.5", rules);
    expect(result).toEqual(["openrouter"]);
  });

  test("glob pattern 'kimi-*' does not match 'gemini-2.5-pro'", () => {
    const rules: RoutingRules = {
      "kimi-*": ["openrouter"],
    };
    const result = matchRoutingRule("gemini-2.5-pro", rules);
    expect(result).toBeNull();
  });

  test("suffix glob '*-preview' matches 'trinity-large-preview'", () => {
    const rules: RoutingRules = {
      "*-preview": ["opencode-zen"],
    };
    const result = matchRoutingRule("trinity-large-preview", rules);
    expect(result).toEqual(["opencode-zen"]);
  });

  test("suffix glob '*-preview' does not match 'gpt-4o'", () => {
    const rules: RoutingRules = {
      "*-preview": ["opencode-zen"],
    };
    const result = matchRoutingRule("gpt-4o", rules);
    expect(result).toBeNull();
  });

  test("longest glob wins: 'kimi-for-*' beats 'kimi-*' when both match", () => {
    const rules: RoutingRules = {
      "kimi-*": ["openrouter"],
      "kimi-for-*": ["kimi-coding"],
    };
    const result = matchRoutingRule("kimi-for-coding", rules);
    expect(result).toEqual(["kimi-coding"]);
  });

  test("catch-all '*' matches when no exact or glob match", () => {
    const rules: RoutingRules = {
      "gpt-4o": ["openai"],
      "*": ["openrouter"],
    };
    const result = matchRoutingRule("some-unknown-model", rules);
    expect(result).toEqual(["openrouter"]);
  });

  test("catch-all '*' does not fire when an exact match exists", () => {
    const rules: RoutingRules = {
      "gpt-4o": ["openai"],
      "*": ["openrouter"],
    };
    const result = matchRoutingRule("gpt-4o", rules);
    expect(result).toEqual(["openai"]);
  });

  test("catch-all '*' does not fire when a glob match exists", () => {
    const rules: RoutingRules = {
      "gpt-*": ["openai"],
      "*": ["openrouter"],
    };
    const result = matchRoutingRule("gpt-4o", rules);
    expect(result).toEqual(["openai"]);
  });

  test("returns null when no rules match and no catch-all", () => {
    const rules: RoutingRules = {
      "kimi-*": ["kimi"],
      "gpt-4o": ["openai"],
    };
    const result = matchRoutingRule("gemini-2.5-pro", rules);
    expect(result).toBeNull();
  });

  test("returns null for empty rules object", () => {
    const result = matchRoutingRule("kimi-k2.5", {});
    expect(result).toBeNull();
  });

  test("exact match takes priority over glob even if glob is longer", () => {
    // e.g. exact key "kimi-k2.5" is shorter than glob "kimi-k2.*-super-long-suffix"
    // but exact should still win
    const rules: RoutingRules = {
      "kimi-k2.5": ["exact-winner"],
      "kimi-k2.*-super-long-suffix-that-would-normally-beat-exact": ["glob-loser"],
      "kimi-k2.*": ["glob-loser-too"],
    };
    const result = matchRoutingRule("kimi-k2.5", rules);
    expect(result).toEqual(["exact-winner"]);
  });

  test("glob with no wildcard acts as exact match (via globMatch)", () => {
    // A key without '*' doesn't appear in the glob list since filter checks includes('*')
    // But test that a glob-like entry with no star in the rules doesn't interfere
    const rules: RoutingRules = {
      "some-model": ["kimi"],
    };
    expect(matchRoutingRule("some-model", rules)).toEqual(["kimi"]);
    expect(matchRoutingRule("some-model-extra", rules)).toBeNull();
  });

  test("prefix glob 'gemini-2.*' matches 'gemini-2.5-pro'", () => {
    const rules: RoutingRules = {
      "gemini-2.*": ["google"],
    };
    expect(matchRoutingRule("gemini-2.5-pro", rules)).toEqual(["google"]);
    expect(matchRoutingRule("gemini-1.5-pro", rules)).toBeNull();
  });

  test("middle wildcard 'gpt-*-turbo' matches 'gpt-3.5-turbo' but not 'gpt-4o'", () => {
    const rules: RoutingRules = {
      "gpt-*-turbo": ["openai"],
    };
    expect(matchRoutingRule("gpt-3.5-turbo", rules)).toEqual(["openai"]);
    expect(matchRoutingRule("gpt-4o", rules)).toBeNull();
  });

  test("catch-all '*' alone matches any model", () => {
    const rules: RoutingRules = {
      "*": ["openrouter"],
    };
    expect(matchRoutingRule("anything-at-all", rules)).toEqual(["openrouter"]);
    expect(matchRoutingRule("gemini-2.5-pro", rules)).toEqual(["openrouter"]);
    expect(matchRoutingRule("gpt-4o", rules)).toEqual(["openrouter"]);
  });
});

// ---------------------------------------------------------------------------
// buildRoutingChain — entry to FallbackRoute conversion
// ---------------------------------------------------------------------------

describe("buildRoutingChain", () => {
  test("plain provider name 'minimax' resolves via PROVIDER_SHORTCUTS and uses originalModelName", () => {
    const routes = buildRoutingChain(["minimax"], "minimax-m2.5");
    expect(routes).toHaveLength(1);
    const route = routes[0];
    expect(route.provider).toBe("minimax");
    // PROVIDER_TO_PREFIX["minimax"] = "mm"
    expect(route.modelSpec).toBe("mm@minimax-m2.5");
    expect(route.displayName).toBe(DISPLAY_NAMES["minimax"] ?? "minimax");
  });

  test("plain provider shortcut 'mm' resolves to canonical 'minimax'", () => {
    const routes = buildRoutingChain(["mm"], "minimax-m2.5");
    expect(routes).toHaveLength(1);
    expect(routes[0].provider).toBe("minimax");
    expect(routes[0].modelSpec).toBe("mm@minimax-m2.5");
  });

  test("explicit 'mm@minimax-m2.5' parses provider and model, ignores originalModelName", () => {
    const routes = buildRoutingChain(["mm@minimax-m2.5"], "some-other-model");
    expect(routes).toHaveLength(1);
    const route = routes[0];
    expect(route.provider).toBe("minimax");
    expect(route.modelSpec).toBe("mm@minimax-m2.5");
  });

  test("explicit 'kimi@kimi-k2.5' parses correctly", () => {
    const routes = buildRoutingChain(["kimi@kimi-k2.5"], "original");
    expect(routes).toHaveLength(1);
    const route = routes[0];
    expect(route.provider).toBe("kimi");
    // PROVIDER_TO_PREFIX["kimi"] = "kimi"
    expect(route.modelSpec).toBe("kimi@kimi-k2.5");
  });

  test("plain 'kimi' with originalModelName uses originalModelName", () => {
    const routes = buildRoutingChain(["kimi"], "kimi-k2.5");
    expect(routes).toHaveLength(1);
    expect(routes[0].provider).toBe("kimi");
    expect(routes[0].modelSpec).toBe("kimi@kimi-k2.5");
  });

  test("shortcut 'or' resolves to 'openrouter'", () => {
    const routes = buildRoutingChain(["or"], "some-model");
    expect(routes).toHaveLength(1);
    expect(routes[0].provider).toBe("openrouter");
    // openrouter uses resolveModelNameSync — modelSpec will be the resolved or fallback id
    expect(typeof routes[0].modelSpec).toBe("string");
    expect(routes[0].modelSpec.length).toBeGreaterThan(0);
  });

  test("explicit 'openrouter@vendor/model-name' uses model portion for resolution", () => {
    const routes = buildRoutingChain(["openrouter@minimax/minimax-m2.5"], "original");
    expect(routes).toHaveLength(1);
    expect(routes[0].provider).toBe("openrouter");
    // resolveModelNameSync returns resolvedId — may be the same or vendor-prefixed
    expect(typeof routes[0].modelSpec).toBe("string");
  });

  test("unknown provider name passes through without crashing", () => {
    const routes = buildRoutingChain(["totally-unknown-provider"], "my-model");
    expect(routes).toHaveLength(1);
    const route = routes[0];
    expect(route.provider).toBe("totally-unknown-provider");
    // Falls back to using provider name as prefix
    expect(route.modelSpec).toBe("totally-unknown-provider@my-model");
    expect(route.displayName).toBe("totally-unknown-provider");
  });

  test("multiple entries produce multiple FallbackRoute objects in order", () => {
    const routes = buildRoutingChain(["kimi", "mm@minimax-m2.5", "openrouter"], "kimi-k2.5");
    expect(routes).toHaveLength(3);
    expect(routes[0].provider).toBe("kimi");
    expect(routes[1].provider).toBe("minimax");
    expect(routes[2].provider).toBe("openrouter");
  });

  test("empty entries array returns empty array", () => {
    const routes = buildRoutingChain([], "some-model");
    expect(routes).toHaveLength(0);
  });

  test("displayName falls back to provider name for unknown providers", () => {
    const routes = buildRoutingChain(["my-custom-provider"], "some-model");
    expect(routes[0].displayName).toBe("my-custom-provider");
  });

  test("displayName is set correctly for known providers", () => {
    const routes = buildRoutingChain(["google"], "gemini-2.5-pro");
    expect(routes[0].displayName).toBe("Gemini");
  });

  test("explicit 'glm@glm-5' uses glm prefix", () => {
    const routes = buildRoutingChain(["glm@glm-5"], "original");
    expect(routes).toHaveLength(1);
    // PROVIDER_TO_PREFIX["glm"] = "glm"
    expect(routes[0].modelSpec).toBe("glm@glm-5");
    expect(routes[0].provider).toBe("glm");
  });

  test("shortcut 'g' resolves to 'google'", () => {
    const routes = buildRoutingChain(["g"], "gemini-2.5-pro");
    expect(routes[0].provider).toBe("google");
    // PROVIDER_TO_PREFIX["google"] = "g"
    expect(routes[0].modelSpec).toBe("g@gemini-2.5-pro");
  });
});

// ---------------------------------------------------------------------------
// loadRoutingRules — smoke test (no config file in test environment)
// ---------------------------------------------------------------------------

describe("loadRoutingRules", () => {
  test("returns null or a RoutingRules object (never throws)", () => {
    // In CI/test environment without a ~/.claudish/config.json, this should be null.
    // In a dev environment with routing configured, it may return an object.
    const result = loadRoutingRules();

    // Result is either null or a non-empty RoutingRules object
    if (result !== null) {
      expect(typeof result).toBe("object");
      expect(Object.keys(result).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// PROVIDER_SHORTCUTS / PROVIDER_TO_PREFIX sanity checks
// (ensure imports are consistent — routing-rules depends on these)
// ---------------------------------------------------------------------------

describe("import consistency", () => {
  test("PROVIDER_SHORTCUTS maps 'mm' to 'minimax'", () => {
    expect(PROVIDER_SHORTCUTS["mm"]).toBe("minimax");
  });

  test("PROVIDER_SHORTCUTS maps 'kimi' to 'kimi'", () => {
    expect(PROVIDER_SHORTCUTS["kimi"]).toBe("kimi");
  });

  test("PROVIDER_TO_PREFIX maps 'minimax' to 'mm'", () => {
    expect(PROVIDER_TO_PREFIX["minimax"]).toBe("mm");
  });

  test("PROVIDER_TO_PREFIX maps 'google' to 'g'", () => {
    expect(PROVIDER_TO_PREFIX["google"]).toBe("g");
  });

  test("DISPLAY_NAMES maps 'openrouter' to 'OpenRouter'", () => {
    expect(DISPLAY_NAMES["openrouter"]).toBe("OpenRouter");
  });
});
