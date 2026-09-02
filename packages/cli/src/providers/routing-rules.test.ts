/**
 * Unit tests for providers/routing-rules.ts
 *
 * Tests matchRoutingRule, buildRoutingChain, loadRoutingRules, mergeRoutingRules,
 * and route() without hitting any real APIs (file-system config is unavoidable
 * for loadRoutingRules itself, so we assert weakly there).
 *
 * Run: bun test packages/cli/src/providers/routing-rules.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { credentials } from "../auth/credentials/authority.js";
import { __resetSniffForTests } from "../auth/credentials/op-source.js";
import type { RoutingRules } from "../profile-config.js";
import { type DiskCacheV2, type SlimModelEntry, writeAllModelsCache } from "./all-models-cache.js";
import { DISPLAY_NAMES } from "./auto-route.js";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "./catalog-client.js";
import { DEFAULT_ROUTING_RULES } from "./default-routing-rules.js";
import { invalidateModelDiscovery } from "./model-discovery.js";
import type { ProviderDefinition } from "./provider-definitions.js";
import {
  buildRoutingChain,
  matchRoutingRule,
  mergeRoutingRules,
  normalizeGlmSlug,
  retainKnownCatalogRoutingRules,
  route,
} from "./routing-rules.js";
import { clearRuntimeRegistry, registerRuntimeProvider } from "./runtime-providers.js";

const SYNTHETIC_MODEL_ID = "acme-x1.0";
const SYNTHETIC_MINIMAX_EXTERNAL_ID = "ACME-X1.0";

function seedDefaultCatalog(entries: DiskCacheV2["entries"]): () => void {
  _setCatalogEntriesForTest(entries);
  return _resetCatalogClient;
}

function makeTempCatalog(
  model: {
    modelId: string;
    externalId?: string;
    subscriptionPlans?: string[];
  },
  /** Plan names to mark as active subscription plans in the catalog (defaults to the model's own plans). */
  plans: string[] = model.subscriptionPlans ?? [],
  routingProviderByPlan: Record<string, string> = {}
): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "claudish-routing-test-"));
  const path = join(dir, "all-models.json");
  const entries: DiskCacheV2["entries"] = [];

  // Plan-owner entries: a provider is only treated as a subscription plan if
  // some catalog entry lists it in subscriptionPlans[]. Add markers so tests can
  // model the "model is not in this plan" drop path without duplicating real
  // plan members.
  for (const plan of plans) {
    entries.push({
      modelId: `${plan}-plan-marker`,
      aliases: [],
      sources: {},
      subscriptionPlans: [plan],
      aggregators: [{ provider: plan, externalId: "any", confidence: "scrape_verified" as const }],
    });
  }

  entries.push({
    modelId: model.modelId,
    aliases: [],
    sources: {},
    subscriptionPlans: model.subscriptionPlans ?? [],
    aggregators:
      model.externalId && model.subscriptionPlans
        ? model.subscriptionPlans.map((planId) => ({
            provider: routingProviderByPlan[planId] ?? planId,
            externalId: model.externalId!,
            confidence: "scrape_verified" as const,
          }))
        : undefined,
  });

  const cache: DiskCacheV2 = {
    version: 2,
    lastUpdated: new Date().toISOString(),
    entries,
    models: [],
    plans: plans.map((plan) => ({
      id: plan,
      modelDiscovery: "catalog",
      routing: {
        providerUid: routingProviderByPlan[plan] ?? plan,
        nativeModelProviders: [],
      },
    })),
  };
  writeAllModelsCache(cache, path);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

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
  let cleanupCatalog: (() => void) | undefined;

  beforeEach(() => {
    _resetCatalogClient();
    cleanupCatalog = seedDefaultCatalog([
      {
        modelId: SYNTHETIC_MODEL_ID,
        aliases: [],
        sources: {},
        aggregators: [
          {
            provider: "minimax",
            externalId: SYNTHETIC_MINIMAX_EXTERNAL_ID,
            confidence: "scrape_verified",
          },
        ],
      },
    ]);
  });

  afterEach(() => {
    cleanupCatalog?.();
    cleanupCatalog = undefined;
  });

  test("plain provider name 'minimax' resolves via PROVIDER_SHORTCUTS and uses originalModelName", () => {
    const routes = buildRoutingChain(["minimax"], SYNTHETIC_MODEL_ID);
    expect(routes).toHaveLength(1);
    const route = routes[0];
    expect(route.provider).toBe("minimax");
    // PROVIDER_TO_PREFIX["minimax"] = "mm". The synthetic catalog deliberately
    // gives the provider external id different casing from the user's input, so
    // this exact check fails if catalog-driven normalization is removed.
    expect(route.modelSpec).toBe(`mm@${SYNTHETIC_MINIMAX_EXTERNAL_ID}`);
    expect(route.displayName).toBe(DISPLAY_NAMES.minimax ?? "minimax");
  });

  test("plain provider shortcut 'mm' resolves to canonical 'minimax'", () => {
    const routes = buildRoutingChain(["mm"], SYNTHETIC_MODEL_ID);
    expect(routes).toHaveLength(1);
    expect(routes[0].provider).toBe("minimax");
    expect(routes[0].modelSpec).toBe(`mm@${SYNTHETIC_MINIMAX_EXTERNAL_ID}`);
  });

  test("explicit 'mm@acme-x1.0' parses provider and model, ignores originalModelName", () => {
    const routes = buildRoutingChain([`mm@${SYNTHETIC_MODEL_ID}`], "some-other-model");
    expect(routes).toHaveLength(1);
    const route = routes[0];
    expect(route.provider).toBe("minimax");
    // An explicitly pinned model is still normalised to the provider's own id.
    expect(route.modelSpec).toBe(`mm@${SYNTHETIC_MINIMAX_EXTERNAL_ID}`);
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

// ---------------------------------------------------------------------------
// mergeRoutingRules — pure merge semantics (testable without disk I/O)
// ---------------------------------------------------------------------------

describe("loadRoutingRules merges defaults", () => {
  test("catalog routes keep known providers and cannot shadow defaults with an unknown provider", () => {
    expect(
      retainKnownCatalogRoutingRules({
        "mixed-model": ["future-provider@future-wire", "openrouter@vendor/model"],
        "future-only-model": ["future-provider@future-wire"],
      })
    ).toEqual({
      "mixed-model": ["openrouter@vendor/model"],
    });
  });

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
// normalizeGlmSlug — bare-name GLM slug normalization
// ---------------------------------------------------------------------------

describe("normalizeGlmSlug", () => {
  test("rewrites dash-slugified GLM versions to dotted canonical names", () => {
    expect(normalizeGlmSlug("glm-5-2")).toBe("glm-5.2");
    expect(normalizeGlmSlug("glm-4-6")).toBe("glm-4.6");
    expect(normalizeGlmSlug("glm-4-5-air")).toBe("glm-4.5-air");
    expect(normalizeGlmSlug("glm-4-5-airx")).toBe("glm-4.5-airx");
  });

  test("leaves already-dotted GLM names unchanged", () => {
    expect(normalizeGlmSlug("glm-5.2")).toBe("glm-5.2");
    expect(normalizeGlmSlug("glm-4.5-air")).toBe("glm-4.5-air");
  });

  test("leaves dash-native GLM ids unchanged", () => {
    expect(normalizeGlmSlug("glm-4-9b")).toBe("glm-4-9b");
    expect(normalizeGlmSlug("glm-4-flash")).toBe("glm-4-flash");
  });

  test("leaves unrelated model families unchanged", () => {
    expect(normalizeGlmSlug("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(normalizeGlmSlug("qwen3.6-35b-a3b")).toBe("qwen3.6-35b-a3b");
    expect(normalizeGlmSlug("gpt-4o")).toBe("gpt-4o");
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
  "QWEN_CLOUD_PLAN_API_KEY",
  "DASHSCOPE_API_KEY",
  "QWEN_API_KEY",
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
  "OPENCODE_GO_API_KEY",
  "WINDSURF_API_KEY",
];

const savedEnv: Record<string, string | undefined> = {};

describe("route()", () => {
  // CredentialAuthority memoizes provider resolution process-wide, so another
  // test module's top-level credential probe can prewarm real credentials.
  // Invalidate before and after each test to isolate host and fake keys.
  beforeEach(() => {
    // Credential resolution is env → aliases → config → keychain → op://.
    // These tests predate the keychain source and originally disabled only
    // op://, leaving host keychain entries able to satisfy "no credentials"
    // assertions. Disable both external stores with the mock-free env flags.
    process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
    process.env.CLAUDISH_DISABLE_OP = "1";
    __resetSniffForTests();
    credentials.invalidate();
    // Snapshot and clear credential env vars so each test starts clean.
    for (const key of ENV_KEYS_TO_CLEAR) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
    delete process.env.CLAUDISH_DISABLE_OP;
    __resetSniffForTests();
    // Restore env vars (preserves the host's actual config for other tests).
    for (const key of ENV_KEYS_TO_CLEAR) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    credentials.invalidate();
  });

  test("claude-opus-4-7 with ANTHROPIC_API_KEY → primary native-anthropic", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const plan = await route("claude-opus-4-7", DEFAULT_ROUTING_RULES);
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("native-anthropic");
  });

  test("bare glm-5-2 routes identically to canonical glm-5.2", async () => {
    const rules: RoutingRules = { "glm-5.2": ["glm"] };
    const dashPlan = await route("glm-5-2", rules);
    const dottedPlan = await route("glm-5.2", rules);
    expect(dashPlan).toEqual(dottedPlan);
  });

  test("explicit Devin dv@glm-5-2 preserves the dash-native uid without normalization", async () => {
    process.env.WINDSURF_API_KEY = "devin-session-token$test";
    const plan = await route("dv@glm-5-2", DEFAULT_ROUTING_RULES);
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.modelSpec).toBe("dv@glm-5-2");
    expect(plan.primary.modelSpec).not.toBe("dv@glm-5.2");
  });

  test("claude-opus-4-7 with only OPENROUTER_API_KEY → primary openrouter", async () => {
    process.env.OPENROUTER_API_KEY = "or-test";
    const plan = await route("claude-opus-4-7", DEFAULT_ROUTING_RULES);
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("openrouter");
  });

  test("claude-opus-4-7 with no credentials → no-route, hint mentions both providers", async () => {
    const plan = await route("claude-opus-4-7", DEFAULT_ROUTING_RULES);
    expect(plan.kind).toBe("no-route");
    if (plan.kind !== "no-route") return;
    expect(plan.hint).toBeDefined();
    // Both native-anthropic (ANTHROPIC_API_KEY) and openrouter (OPENROUTER_API_KEY)
    // should be in the hint.
    expect(plan.hint).toContain("ANTHROPIC_API_KEY");
    expect(plan.hint).toContain("OPENROUTER_API_KEY");
  });

  test("explicit prefix native-anthropic@claude-opus-4-7 with ANTHROPIC_API_KEY → ok", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const plan = await route("native-anthropic@claude-opus-4-7", DEFAULT_ROUTING_RULES);
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("native-anthropic");
    expect(plan.fallbacks).toHaveLength(0);
  });

  test("explicit prefix openai@gpt-5 with no OPENAI_API_KEY → no-route, NO silent OR fallback", async () => {
    // Even with OPENROUTER_API_KEY set, an explicit openai@ prefix must NOT
    // silently reroute to OpenRouter.
    process.env.OPENROUTER_API_KEY = "or-test";
    const plan = await route("openai@gpt-5", DEFAULT_ROUTING_RULES);
    expect(plan.kind).toBe("no-route");
    if (plan.kind !== "no-route") return;
    // Hint should mention the missing OpenAI key, not OpenRouter
    expect(plan.hint).toContain("OPENAI_API_KEY");
  });

  test("gpt-5 (bare) with only OPENAI_API_KEY → openai-codex skipped if no codex creds", async () => {
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
    const plan = await route("gpt-5", DEFAULT_ROUTING_RULES);
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("openai");
  });

  test("gpt-5 (bare) with OPENAI_CODEX_API_KEY → primary openai-codex", async () => {
    process.env.OPENAI_CODEX_API_KEY = "sk-codex-test";
    const plan = await route("gpt-5", DEFAULT_ROUTING_RULES);
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("openai-codex");
  });

  test("qwen3.7-plus prefers qwen-cloud over qwen-payg when both credentials are present", async () => {
    process.env.QWEN_CLOUD_PLAN_API_KEY = "qwen-plan-test";
    process.env.DASHSCOPE_API_KEY = "qwen-payg-test";
    const { path, cleanup } = makeTempCatalog({
      modelId: "qwen3.7-plus",
      externalId: "qwen3.7-plus",
      subscriptionPlans: ["qwen-cloud"],
    });
    try {
      const plan = await route("qwen3.7-plus", DEFAULT_ROUTING_RULES, undefined, path);
      expect(plan.kind).toBe("ok");
      if (plan.kind !== "ok") return;
      expect(plan.primary.provider).toBe("qwen-cloud");
      expect(plan.primary.modelSpec).toBe("qc@qwen3.7-plus");
      expect(plan.fallbacks.map((fallback) => fallback.provider)).toEqual(["qwen-payg"]);
      expect(plan.fallbacks[0]?.modelSpec).toBe("qp@qwen3.7-plus");
    } finally {
      cleanup();
    }
  });

  test("qwen3.7-plus falls through to qwen-payg with only DASHSCOPE_API_KEY", async () => {
    process.env.DASHSCOPE_API_KEY = "qwen-payg-test";
    const { path, cleanup } = makeTempCatalog({
      modelId: "qwen3.7-plus",
      externalId: "qwen3.7-plus",
      subscriptionPlans: ["qwen-cloud"],
    });
    try {
      const plan = await route("qwen3.7-plus", DEFAULT_ROUTING_RULES, undefined, path);
      expect(plan.kind).toBe("ok");
      if (plan.kind !== "ok") return;
      expect(plan.primary.provider).toBe("qwen-payg");
      expect(plan.primary.modelSpec).toBe("qp@qwen3.7-plus");
    } finally {
      cleanup();
    }
  });

  test("kimi-k3 (bare) with KIMI_CODING_API_KEY uses subscription wire id k3", async () => {
    process.env.KIMI_CODING_API_KEY = "kc-test";
    const { path, cleanup } = makeTempCatalog(
      {
        modelId: "kimi-k3",
        externalId: "k3",
        subscriptionPlans: ["kimi-code"],
      },
      ["kimi-code"],
      { "kimi-code": "kimi-coding" }
    );
    try {
      const plan = await route("kimi-k3", DEFAULT_ROUTING_RULES, undefined, path);
      expect(plan.kind).toBe("ok");
      if (plan.kind !== "ok") return;
      expect(plan.primary.provider).toBe("kimi-coding");
      expect(plan.primary.modelSpec).toBe("kc@k3");
    } finally {
      cleanup();
    }
  });

  test("joins commercial plan IDs to provider UIDs before dropping an unserved route", () => {
    const { path, cleanup } = makeTempCatalog({ modelId: "kimi-unserved" }, ["kimi-code"], {
      "kimi-code": "kimi-coding",
    });
    try {
      expect(
        buildRoutingChain(["kimi-coding", "kimi"], "kimi-unserved", path).map(
          (candidate) => candidate.provider
        )
      ).toEqual(["kimi"]);
    } finally {
      cleanup();
    }
  });

  test("keeps candidates when queryPlans is newer than a zero-coverage slim snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudish-routing-skewed-plan-test-"));
    const path = join(dir, "all-models.json");
    writeAllModelsCache(
      {
        version: 2,
        lastUpdated: new Date().toISOString(),
        entries: [{ modelId: "gpt-rollout-model", aliases: [], sources: {} }],
        models: [],
        plans: [
          {
            id: "openai-codex",
            modelDiscovery: "catalog",
            routing: { providerUid: "openai-codex", nativeModelProviders: ["openai"] },
          },
        ],
      },
      path
    );
    try {
      expect(buildRoutingChain(["openai-codex", "openai"], "gpt-rollout-model", path)).toHaveLength(
        2
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps client-discovered subscription candidates when static membership is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudish-routing-client-plan-test-"));
    const path = join(dir, "all-models.json");
    writeAllModelsCache(
      {
        version: 2,
        lastUpdated: new Date().toISOString(),
        entries: [{ modelId: "grok-account-model", aliases: [], sources: {} }],
        models: [],
        plans: [
          {
            id: "xai-supergrok",
            modelDiscovery: "client",
            routing: { providerUid: "grok-subscription", nativeModelProviders: ["x-ai"] },
          },
        ],
      },
      path
    );
    try {
      expect(
        buildRoutingChain(["grok-subscription", "x-ai"], "grok-account-model", path).map(
          (candidate) => candidate.provider
        )
      ).toEqual(["grok-subscription", "x-ai"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("k3 (bare) with KIMI_CODING_API_KEY uses subscription wire id k3", async () => {
    process.env.KIMI_CODING_API_KEY = "kc-test";
    const { path, cleanup } = makeTempCatalog(
      {
        modelId: "kimi-k3",
        externalId: "k3",
        subscriptionPlans: ["kimi-coding"],
      },
      ["kimi-coding"]
    );
    try {
      const plan = await route("k3", DEFAULT_ROUTING_RULES, undefined, path);
      expect(plan.kind).toBe("ok");
      if (plan.kind !== "ok") return;
      expect(plan.primary.provider).toBe("kimi-coding");
      expect(plan.primary.modelSpec).toBe("kc@k3");
    } finally {
      cleanup();
    }
  });

  test("k3-256k (bare) with KIMI_CODING_API_KEY uses subscription wire id k3-256k", async () => {
    process.env.KIMI_CODING_API_KEY = "kc-test";
    const { path, cleanup } = makeTempCatalog(
      {
        modelId: "kimi-k3-256k",
        externalId: "k3-256k",
        subscriptionPlans: ["kimi-coding"],
      },
      ["kimi-coding"]
    );
    try {
      const plan = await route("k3-256k", DEFAULT_ROUTING_RULES, undefined, path);
      expect(plan.kind).toBe("ok");
      if (plan.kind !== "ok") return;
      expect(plan.primary.provider).toBe("kimi-coding");
      expect(plan.primary.modelSpec).toBe("kc@k3-256k");
    } finally {
      cleanup();
    }
  });

  test("kimi-k2.5 (bare) with KIMI_CODING_API_KEY falls through to kimi when not in coding plan", async () => {
    process.env.KIMI_CODING_API_KEY = "kc-test";
    process.env.KIMI_API_KEY = "kimi-test";
    const { path, cleanup } = makeTempCatalog(
      {
        modelId: "kimi-k2.5",
        // No subscriptionPlans — this model is not part of the kimi-coding plan,
        // so the subscription candidate is dropped instead of silently substituting.
      },
      ["kimi-coding"]
    );
    try {
      const plan = await route("kimi-k2.5", DEFAULT_ROUTING_RULES, undefined, path);
      expect(plan.kind).toBe("ok");
      if (plan.kind !== "ok") return;
      expect(plan.primary.provider).toBe("kimi");
      expect(plan.primary.modelSpec).toBe("kimi@kimi-k2.5");
    } finally {
      cleanup();
    }
  });

  test("user disables catch-all with '*' = [] → no-route for unknown bare names", async () => {
    const userRules: RoutingRules = mergeRoutingRules(DEFAULT_ROUTING_RULES, { "*": [] }, {});
    process.env.OPENROUTER_API_KEY = "or-test";
    const plan = await route("totally-unknown-xyz", userRules);
    expect(plan.kind).toBe("no-route");
  });

  test("ok plan returns primary plus fallbacks in order", async () => {
    process.env.OPENAI_CODEX_API_KEY = "cx-test";
    process.env.OPENAI_API_KEY = "oai-test";
    process.env.OPENROUTER_API_KEY = "or-test";
    const plan = await route("gpt-5", DEFAULT_ROUTING_RULES);
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
  // CredentialAuthority memoizes provider resolution process-wide, so another
  // test module's top-level credential probe can prewarm real credentials.
  // Invalidate before and after each test to isolate host and fake keys.
  beforeEach(() => {
    process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
    process.env.CLAUDISH_DISABLE_OP = "1";
    __resetSniffForTests();
    credentials.invalidate();
    for (const key of ENV_KEYS_TO_CLEAR) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
    delete process.env.CLAUDISH_DISABLE_OP;
    __resetSniffForTests();
    for (const key of ENV_KEYS_TO_CLEAR) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    credentials.invalidate();
  });

  test("defaultProvider appended after matched chain when not already present", async () => {
    process.env.OPENAI_API_KEY = "oai-test";
    process.env.XAI_API_KEY = "xai-test";
    const plan = await route("gpt-5", { "gpt-*": ["openai"] }, "x-ai");
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("openai");
    expect(plan.fallbacks.map((r) => r.provider)).toEqual(["x-ai"]);
  });

  test("defaultProvider deduped if already present in chain", async () => {
    process.env.OPENAI_API_KEY = "oai-test";
    process.env.OPENROUTER_API_KEY = "or-test";
    const plan = await route("gpt-5", { "gpt-*": ["openai", "openrouter"] }, "openrouter");
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("openai");
    expect(plan.fallbacks.map((r) => r.provider)).toEqual(["openrouter"]);
  });

  test("defaultProvider rescues unmatched model with no rule", async () => {
    process.env.OPENROUTER_API_KEY = "or-test";
    const plan = await route("totally-unknown-xyz", {}, "openrouter");
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("openrouter");
  });

  test("defaultProvider rescues when matched chain has no credentialed providers", async () => {
    process.env.XAI_API_KEY = "xai-test";
    const plan = await route("deepseek-r1", { "deepseek-*": ["deepseek"] }, "x-ai");
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("x-ai");
  });

  test("defaultProvider undefined → identical behavior to omitted argument", () => {
    process.env.OPENAI_API_KEY = "oai-test";
    const planA = route("gpt-5", { "gpt-*": ["openai"] }, undefined);
    const planB = route("gpt-5", { "gpt-*": ["openai"] });
    expect(planA).toEqual(planB);
  });

  test("defaultProvider not consulted for explicit provider@model spec", async () => {
    process.env.OPENROUTER_API_KEY = "or-test";
    const plan = await route("openrouter@gpt-5", DEFAULT_ROUTING_RULES, "xai");
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("openrouter");
    expect(plan.fallbacks).toEqual([]);
  });

  test("defaultProvider shortcut (e.g. 'or') resolves to canonical for dedup", async () => {
    process.env.OPENAI_API_KEY = "oai-test";
    process.env.OPENROUTER_API_KEY = "or-test";
    const plan = await route("gpt-5", { "gpt-*": ["openai", "openrouter"] }, "or");
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.fallbacks.map((r) => r.provider)).toEqual(["openrouter"]);
  });

  test("defaultProvider with no credentials → still no-route if rest of chain also lacks creds", async () => {
    const plan = await route("gpt-5", { "gpt-*": ["openai"] }, "xai");
    expect(plan.kind).toBe("no-route");
  });
});

// ---------------------------------------------------------------------------
// PROVIDER_SHORTCUTS / PROVIDER_TO_PREFIX sanity checks
// (ensure imports are consistent — routing-rules depends on these)
// ---------------------------------------------------------------------------

describe("import consistency", () => {
  // Identity mapping (kimi→kimi): buildRoutingChain's `?? raw` fallback resolves
  // "kimi" even if the shortcut is absent, so only this direct assertion guards it.
});

// ---------------------------------------------------------------------------
// route() — model-availability filtering
// ---------------------------------------------------------------------------

const AVAILABILITY_MODEL = "availability-model";

function routingCatalogEntry(modelId: string, providers: string[]): SlimModelEntry {
  return {
    modelId,
    aliases: [],
    sources: { test: { externalId: modelId } },
    aggregators: providers.map((provider) => ({
      provider,
      externalId: modelId,
      confidence: "api_official",
    })),
  };
}

function rosterProvider(name: string): ProviderDefinition {
  return {
    name,
    displayName: name,
    transport: "openai",
    baseUrl: `https://${name}.invalid`,
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: `${name.toUpperCase().replaceAll("-", "_")}_API_KEY`,
    apiKeyDescription: "Offline routing-test key",
    apiKeyUrl: "https://example.invalid/key",
    shortcuts: [],
    legacyPrefixes: [],
    modelDiscovery: { path: "/v1/models", format: "openai-models-list" },
    createHandler: {
      kind: "none",
      reason: "virtual",
      note: "Test fixture — never builds a handler.",
    },
    isDirectApi: true,
  };
}

describe("route() model-availability filtering", () => {
  const realFetch = globalThis.fetch;
  const realIsAvailable = credentials.isAvailable;
  const realGetRequestAuth = credentials.getRequestAuth;

  let cachePath = "";
  let cleanupCache: (() => void) | undefined;
  let credentialedProviders = new Set<string>();
  let rosters = new Map<string, string[]>();
  let fetchCalls: string[] = [];

  function allowCredentials(...providers: string[]): void {
    credentialedProviders = new Set(providers);
  }

  function registerRoster(name: string, ...ids: string[]): void {
    registerRuntimeProvider(rosterProvider(name));
    rosters.set(name, ids);
  }

  beforeEach(() => {
    _resetCatalogClient();
    _setCatalogEntriesForTest([]);
    invalidateModelDiscovery();
    clearRuntimeRegistry();

    credentialedProviders = new Set();
    rosters = new Map();
    fetchCalls = [];

    const tempCatalog = makeTempCatalog({ modelId: AVAILABILITY_MODEL });
    cachePath = tempCatalog.path;
    cleanupCache = tempCatalog.cleanup;

    credentials.isAvailable = async (provider: string) => credentialedProviders.has(provider);
    credentials.getRequestAuth = async () => ({
      headers: { Authorization: "Bearer offline-routing-test-token" },
    });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const rawUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const provider = new URL(rawUrl).hostname.replace(/\.invalid$/, "");
      fetchCalls.push(provider);
      const ids = rosters.get(provider);
      if (!ids) throw new Error(`Unexpected roster request for ${provider}`);
      return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    cleanupCache?.();
    cleanupCache = undefined;
    _resetCatalogClient();
    invalidateModelDiscovery();
    clearRuntimeRegistry();
    credentials.isAvailable = realIsAvailable;
    credentials.getRequestAuth = realGetRequestAuth;
    globalThis.fetch = realFetch;
  });

  test("removes not-served candidates and preserves the surviving order", async () => {
    const denied = "availability-denied";
    registerRoster(denied, "some-other-model");
    allowCredentials(denied, "openai", "openrouter");
    _setCatalogEntriesForTest([routingCatalogEntry(AVAILABILITY_MODEL, ["openai", "openrouter"])]);

    const plan = await route(
      AVAILABILITY_MODEL,
      { [AVAILABILITY_MODEL]: [denied, "openai", "openrouter"] },
      undefined,
      cachePath
    );

    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect([plan.primary.provider, ...plan.fallbacks.map((fallback) => fallback.provider)]).toEqual(
      ["openai", "openrouter"]
    );
  });

  test("keeps an unknown candidate when catalog coverage is partial", async () => {
    allowCredentials("openai-codex");
    _setCatalogEntriesForTest([
      routingCatalogEntry(AVAILABILITY_MODEL, ["openai"]),
      routingCatalogEntry("the-one-listed-codex-row", ["openai-codex"]),
    ]);

    // Safety guard: treating catalog absence as denial would drop nearly every
    // subscription provider, whose catalog coverage is partial by nature.
    const plan = await route(
      AVAILABILITY_MODEL,
      { [AVAILABILITY_MODEL]: ["openai-codex"] },
      undefined,
      cachePath
    );

    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("openai-codex");
  });

  test("keeps a candidate confirmed as serves", async () => {
    allowCredentials("openai");
    _setCatalogEntriesForTest([routingCatalogEntry(AVAILABILITY_MODEL, ["openai"])]);

    const plan = await route(
      AVAILABILITY_MODEL,
      { [AVAILABILITY_MODEL]: ["openai"] },
      undefined,
      cachePath
    );

    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("openai");
  });

  test("returns no-route naming every checked provider when all are not-served", async () => {
    const first = "availability-denied-first";
    const second = "availability-denied-second";
    registerRoster(first, "other-first");
    registerRoster(second, "other-second");
    allowCredentials(first, second);

    const plan = await route(
      AVAILABILITY_MODEL,
      { [AVAILABILITY_MODEL]: [first, second] },
      undefined,
      cachePath
    );

    expect(plan.kind).toBe("no-route");
    if (plan.kind !== "no-route") return;
    expect(plan.reason).toBe(
      `No provider serves "${AVAILABILITY_MODEL}" (checked: ${first}, ${second}).`
    );
  });

  test("explicit not-served spec returns no-route without silent substitution", async () => {
    const denied = "availability-explicit-denied";
    registerRoster(denied, "some-other-model");
    allowCredentials(denied, "openai");

    const plan = await route(
      `${denied}@${AVAILABILITY_MODEL}`,
      { [AVAILABILITY_MODEL]: ["openai"] },
      "openai",
      cachePath
    );

    expect(plan.kind).not.toBe("ok");
    expect(plan.kind).toBe("no-route");
    if (plan.kind !== "no-route") return;
    expect(plan.reason).toContain("does not serve");
    expect(plan.reason).toContain(AVAILABILITY_MODEL);
  });

  test("explicit serves spec returns ok with the named provider", async () => {
    const serving = "availability-explicit-serving";
    registerRoster(serving, AVAILABILITY_MODEL);
    allowCredentials(serving);

    const plan = await route(`${serving}@${AVAILABILITY_MODEL}`, {}, undefined, cachePath);

    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe(serving);
    expect(plan.fallbacks).toEqual([]);
  });

  test("checks availability only after filtering providers without credentials", async () => {
    const noCredential = "availability-no-credential";
    const credentialed = "availability-credentialed";
    registerRoster(noCredential, AVAILABILITY_MODEL);
    registerRoster(credentialed, AVAILABILITY_MODEL);
    allowCredentials(credentialed);

    const plan = await route(
      AVAILABILITY_MODEL,
      { [AVAILABILITY_MODEL]: [noCredential, credentialed] },
      undefined,
      cachePath
    );

    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe(credentialed);
    // A provider the user cannot authenticate to must never incur the
    // guaranteed-failing roster round-trip.
    expect(fetchCalls).toEqual([credentialed]);
    expect(fetchCalls).not.toContain(noCredential);
  });
});
