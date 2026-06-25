/**
 * Unit tests for providers/routing-rules.ts
 *
 * Tests matchRoutingRule, buildRoutingChain, loadRoutingRules, mergeRoutingRules,
 * and route() without hitting any real APIs (file-system config is unavoidable
 * for loadRoutingRules itself, so we assert weakly there).
 *
 * Run: bun test packages/cli/src/providers/routing-rules.test.ts
 */

import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  matchRoutingRule,
  buildRoutingChain,
  loadRoutingRules,
  mergeRoutingRules,
  normalizeGlmSlug,
  route,
} from "./routing-rules.js";
import { DEFAULT_ROUTING_RULES } from "./default-routing-rules.js";
import { PROVIDER_SHORTCUTS } from "./model-parser.js";
import { PROVIDER_TO_PREFIX, DISPLAY_NAMES } from "./auto-route.js";
import type { RoutingRules } from "../profile-config.js";

// ---------------------------------------------------------------------------
// normalizeGlmSlug — tolerate dash-slugified GLM version names
// ---------------------------------------------------------------------------

describe("normalizeGlmSlug", () => {
  test("rewrites slugified glm versions to canonical dotted form", () => {
    expect(normalizeGlmSlug("glm-5-2")).toBe("glm-5.2");
    expect(normalizeGlmSlug("glm-4-6")).toBe("glm-4.6");
    expect(normalizeGlmSlug("glm-4-5")).toBe("glm-4.5");
  });

  test("preserves a trailing suffix after the version", () => {
    expect(normalizeGlmSlug("glm-4-5-air")).toBe("glm-4.5-air");
    expect(normalizeGlmSlug("glm-4-5-airx")).toBe("glm-4.5-airx");
  });

  test("leaves already-dotted names untouched", () => {
    expect(normalizeGlmSlug("glm-5.2")).toBe("glm-5.2");
    expect(normalizeGlmSlug("glm-4.5-air")).toBe("glm-4.5-air");
  });

  test("does not touch non-GLM models or dash-native names", () => {
    // dash-native open-model id (version dot would be wrong) — left as-is
    expect(normalizeGlmSlug("glm-4-9b")).toBe("glm-4-9b");
    expect(normalizeGlmSlug("glm-4-flash")).toBe("glm-4-flash");
    // unrelated families must never be rewritten
    expect(normalizeGlmSlug("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(normalizeGlmSlug("qwen3.6-35b-a3b")).toBe("qwen3.6-35b-a3b");
    expect(normalizeGlmSlug("gpt-4o")).toBe("gpt-4o");
  });
});

describe("route — GLM slug tolerance", () => {
  test("slugified glm-5-2 routes identically to canonical glm-5.2", () => {
    const rules: RoutingRules = { "glm-5.2": ["openrouter"] };
    const slug = route("glm-5-2", rules);
    const canonical = route("glm-5.2", rules);
    // The dash form must resolve to the exact same plan as the dotted form —
    // proving the slug no longer misses the canonical rule. (Relative assertion
    // so it holds regardless of which credentials the test env happens to have.)
    expect(slug).toEqual(canonical);
  });
});

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
// loadRoutingRules — smoke test (always returns RoutingRules now)
// ---------------------------------------------------------------------------

describe("loadRoutingRules", () => {
  test("always returns a non-null RoutingRules object", () => {
    const result = loadRoutingRules();
    // After commit 4, defaults are merged in — result is never null.
    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();
    expect(Object.keys(result).length).toBeGreaterThan(0);
  });

  test("includes the default catch-all (unless overridden by user config)", () => {
    const result = loadRoutingRules();
    // User config could override "*" but the key must exist (defaults ship one).
    expect(result["*"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// mergeRoutingRules — pure merge semantics (testable without disk I/O)
// ---------------------------------------------------------------------------

describe("loadRoutingRules merges defaults", () => {
  test("with no user rules: merge returns defaults exactly", () => {
    const merged = mergeRoutingRules(DEFAULT_ROUTING_RULES, {}, {});
    expect(merged).toEqual(DEFAULT_ROUTING_RULES);
  });

  test("user rule that overrides 'claude-*' wins; defaults still cover other patterns", () => {
    const userGlobal: RoutingRules = {
      "claude-*": ["openrouter"],
    };
    const merged = mergeRoutingRules(DEFAULT_ROUTING_RULES, userGlobal, {});
    expect(merged["claude-*"]).toEqual(["openrouter"]);
    // Defaults still apply to unrelated patterns
    expect(merged["gpt-*"]).toEqual(DEFAULT_ROUTING_RULES["gpt-*"]);
    expect(merged["*"]).toEqual(DEFAULT_ROUTING_RULES["*"]);
  });

  test("user '*' = [] removes the catch-all (verify match returns empty)", () => {
    const userGlobal: RoutingRules = {
      "*": [],
    };
    const merged = mergeRoutingRules(DEFAULT_ROUTING_RULES, userGlobal, {});
    expect(merged["*"]).toEqual([]);
    // Other defaults still apply
    expect(merged["claude-*"]).toEqual(DEFAULT_ROUTING_RULES["claude-*"]);
    // matchRoutingRule on a pattern only the catch-all would have caught
    // returns the empty array (caller treats as "no route").
    const m = matchRoutingRule("totally-unknown-model-xyz", merged);
    expect(m).toEqual([]);
  });

  test("local overrides global; defaults still cover untouched patterns", () => {
    const userGlobal: RoutingRules = { "claude-*": ["openrouter"] };
    const userLocal: RoutingRules = { "claude-*": ["native-anthropic"] };
    const merged = mergeRoutingRules(DEFAULT_ROUTING_RULES, userGlobal, userLocal);
    // Local wins
    expect(merged["claude-*"]).toEqual(["native-anthropic"]);
    // Defaults still cover unrelated patterns
    expect(merged["gpt-*"]).toEqual(DEFAULT_ROUTING_RULES["gpt-*"]);
  });

  test("local + global add new patterns without disturbing defaults", () => {
    const userGlobal: RoutingRules = { "my-custom-*": ["openrouter"] };
    const userLocal: RoutingRules = { "my-other-*": ["openai"] };
    const merged = mergeRoutingRules(DEFAULT_ROUTING_RULES, userGlobal, userLocal);
    expect(merged["my-custom-*"]).toEqual(["openrouter"]);
    expect(merged["my-other-*"]).toEqual(["openai"]);
    expect(merged["claude-*"]).toEqual(DEFAULT_ROUTING_RULES["claude-*"]);
  });
});

// ---------------------------------------------------------------------------
// route() — credential-aware single entry point
// ---------------------------------------------------------------------------

const ENV_KEYS_TO_CLEAR = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_CODEX_API_KEY",
  "GEMINI_API_KEY",
  "MOONSHOT_API_KEY",
  "KIMI_API_KEY",
  "KIMI_CODING_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CODING_API_KEY",
  "ZHIPU_API_KEY",
  "GLM_API_KEY",
  "GLM_CODING_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "ZAI_API_KEY",
  "OLLAMA_API_KEY",
  "OPENCODE_API_KEY",
];

const savedEnv: Record<string, string | undefined> = {};

describe("route()", () => {
  beforeEach(() => {
    // Snapshot and clear credential env vars so each test starts clean.
    for (const key of ENV_KEYS_TO_CLEAR) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore env vars (preserves the host's actual config for other tests).
    for (const key of ENV_KEYS_TO_CLEAR) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  test("claude-opus-4-7 with ANTHROPIC_API_KEY → primary native-anthropic", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const plan = route("claude-opus-4-7", DEFAULT_ROUTING_RULES);
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("native-anthropic");
  });

  test("claude-opus-4-7 with only OPENROUTER_API_KEY → primary openrouter", () => {
    process.env.OPENROUTER_API_KEY = "or-test";
    const plan = route("claude-opus-4-7", DEFAULT_ROUTING_RULES);
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("openrouter");
  });

  test("claude-opus-4-7 with no credentials → no-route, hint mentions both providers", () => {
    const plan = route("claude-opus-4-7", DEFAULT_ROUTING_RULES);
    expect(plan.kind).toBe("no-route");
    if (plan.kind !== "no-route") return;
    expect(plan.hint).toBeDefined();
    // Both native-anthropic (ANTHROPIC_API_KEY) and openrouter (OPENROUTER_API_KEY)
    // should be in the hint.
    expect(plan.hint).toContain("ANTHROPIC_API_KEY");
    expect(plan.hint).toContain("OPENROUTER_API_KEY");
  });

  test("explicit prefix native-anthropic@claude-opus-4-7 with ANTHROPIC_API_KEY → ok", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const plan = route("native-anthropic@claude-opus-4-7", DEFAULT_ROUTING_RULES);
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("native-anthropic");
    expect(plan.fallbacks).toHaveLength(0);
  });

  test("explicit prefix openai@gpt-5 with no OPENAI_API_KEY → no-route, NO silent OR fallback", () => {
    // Even with OPENROUTER_API_KEY set, an explicit openai@ prefix must NOT
    // silently reroute to OpenRouter.
    process.env.OPENROUTER_API_KEY = "or-test";
    const plan = route("openai@gpt-5", DEFAULT_ROUTING_RULES);
    expect(plan.kind).toBe("no-route");
    if (plan.kind !== "no-route") return;
    // Hint should mention the missing OpenAI key, not OpenRouter
    expect(plan.hint).toContain("OPENAI_API_KEY");
  });

  test("gpt-5 (bare) with only OPENAI_API_KEY → openai-codex skipped if no codex creds", () => {
    // OPENAI_API_KEY is listed as an alias on openai-codex in provider-definitions.ts,
    // but routing requires the codex-specific credential (OPENAI_CODEX_API_KEY or
    // ~/.claudish/codex-oauth.json) — without that the codex /v1/responses
    // endpoint 400s with "instructions required" before the chain falls
    // through. See hasCredentialsForProvider() in routing-rules.ts.
    //
    // In a dev environment where codex-oauth.json exists, codex is genuinely
    // credentialed — the chain stays codex-first. Skip the strict assertion
    // there; the predicate is exercised by the next test plus the explicit-
    // prefix coverage above.
    const codexOauth = join(homedir(), ".claudish", "codex-oauth.json");
    if (existsSync(codexOauth)) return;

    process.env.OPENAI_API_KEY = "sk-openai-test";
    const plan = route("gpt-5", DEFAULT_ROUTING_RULES);
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("openai");
  });

  test("gpt-5 (bare) with OPENAI_CODEX_API_KEY → primary openai-codex", () => {
    process.env.OPENAI_CODEX_API_KEY = "sk-codex-test";
    const plan = route("gpt-5", DEFAULT_ROUTING_RULES);
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("openai-codex");
  });

  test("kimi-k2.5 (bare) with KIMI_CODING_API_KEY → primary kimi-coding with rewritten model", () => {
    process.env.KIMI_CODING_API_KEY = "kc-test";
    const plan = route("kimi-k2.5", DEFAULT_ROUTING_RULES);
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("kimi-coding");
    expect(plan.primary.modelSpec).toBe("kc@kimi-for-coding");
  });

  test("user disables catch-all with '*' = [] → no-route for unknown bare names", () => {
    const userRules: RoutingRules = mergeRoutingRules(DEFAULT_ROUTING_RULES, { "*": [] }, {});
    process.env.OPENROUTER_API_KEY = "or-test";
    const plan = route("totally-unknown-xyz", userRules);
    expect(plan.kind).toBe("no-route");
  });

  test("ok plan returns primary plus fallbacks in order", () => {
    process.env.OPENAI_CODEX_API_KEY = "cx-test";
    process.env.OPENAI_API_KEY = "oai-test";
    process.env.OPENROUTER_API_KEY = "or-test";
    const plan = route("gpt-5", DEFAULT_ROUTING_RULES);
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("openai-codex");
    expect(plan.fallbacks.map((r) => r.provider)).toEqual(["openai", "openrouter"]);
  });
});

// ---------------------------------------------------------------------------
// defaultProvider — appended as final fallback to bare-name chains
// ---------------------------------------------------------------------------

describe("route() with defaultProvider", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS_TO_CLEAR) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS_TO_CLEAR) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  test("defaultProvider appended after matched chain when not already present", () => {
    process.env.OPENAI_API_KEY = "oai-test";
    process.env.XAI_API_KEY = "xai-test";
    const plan = route("gpt-5", { "gpt-*": ["openai"] }, "xai");
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("openai");
    expect(plan.fallbacks.map((r) => r.provider)).toEqual(["xai"]);
  });

  test("defaultProvider deduped if already present in chain", () => {
    process.env.OPENAI_API_KEY = "oai-test";
    process.env.OPENROUTER_API_KEY = "or-test";
    const plan = route("gpt-5", { "gpt-*": ["openai", "openrouter"] }, "openrouter");
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("openai");
    expect(plan.fallbacks.map((r) => r.provider)).toEqual(["openrouter"]);
  });

  test("defaultProvider rescues unmatched model with no rule", () => {
    process.env.OPENROUTER_API_KEY = "or-test";
    const plan = route("totally-unknown-xyz", {}, "openrouter");
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("openrouter");
  });

  test("defaultProvider rescues when matched chain has no credentialed providers", () => {
    process.env.XAI_API_KEY = "xai-test";
    const plan = route("deepseek-r1", { "deepseek-*": ["deepseek"] }, "xai");
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("xai");
  });

  test("defaultProvider undefined → identical behavior to omitted argument", () => {
    process.env.OPENAI_API_KEY = "oai-test";
    const planA = route("gpt-5", { "gpt-*": ["openai"] }, undefined);
    const planB = route("gpt-5", { "gpt-*": ["openai"] });
    expect(planA).toEqual(planB);
  });

  test("defaultProvider not consulted for explicit provider@model spec", () => {
    process.env.OPENROUTER_API_KEY = "or-test";
    const plan = route("openrouter@gpt-5", DEFAULT_ROUTING_RULES, "xai");
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("openrouter");
    expect(plan.fallbacks).toEqual([]);
  });

  test("defaultProvider shortcut (e.g. 'or') resolves to canonical for dedup", () => {
    process.env.OPENAI_API_KEY = "oai-test";
    process.env.OPENROUTER_API_KEY = "or-test";
    const plan = route("gpt-5", { "gpt-*": ["openai", "openrouter"] }, "or");
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.fallbacks.map((r) => r.provider)).toEqual(["openrouter"]);
  });

  test("defaultProvider with no credentials → still no-route if rest of chain also lacks creds", () => {
    const plan = route("gpt-5", { "gpt-*": ["openai"] }, "xai");
    expect(plan.kind).toBe("no-route");
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
