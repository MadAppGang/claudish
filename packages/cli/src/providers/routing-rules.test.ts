import { catalogRouteForProvider } from "./catalog-route-bindings.js";
/**
 * Unit tests for providers/routing-rules.ts
 *
 * Tests matchRoutingRule, buildRoutingChain, loadRoutingRules, and route()
 * without hitting any real APIs or machine routing configuration.
 *
 * Run: bun test packages/cli/src/providers/routing-rules.test.ts
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { credentials } from "../auth/credentials/authority.js";
import { __resetSniffForTests } from "../auth/credentials/op-source.js";
import { getLogFilePath, initLogger, setDiagOutput } from "../logger.js";
import type { RoutingRules } from "../profile-config.js";
import { clearProviderCredentialEnv } from "../test-helpers/provider-credential-env.js";
import { type DiskCacheV3, type SlimModelEntry, writeAllModelsCache } from "./all-models-cache.js";
import { DISPLAY_NAMES } from "./auto-route.js";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "./catalog-client.js";
import { ensureEndpointsRegistered } from "./endpoint-registration.js";
import {
  getModelDiscoveryFetcher,
  invalidateModelDiscovery,
  registerModelDiscoveryFetcher,
} from "./model-discovery.js";
import "./model-discovery-builtins.js";
import type { ProviderDefinition } from "./provider-definitions.js";
import {
  type ExplainRouteOptions,
  type RouteExplanation,
  type RoutePlan,
  buildRoutingChain,
  describeRouteExplanation,
  explainRoute,
  loadRoutingRules,
  matchRoutingRule,
  matchRoutingRuleKey,
  normalizeGlmSlug,
  route,
  routingRuleProblems,
  toRoutePlan,
  validateRoutingRulesAgainstProviders,
} from "./routing-rules.js";
import { clearRuntimeRegistry, registerRuntimeProvider } from "./runtime-providers.js";

const keychainGuardAtFileLoad = process.env.CLAUDISH_DISABLE_KEYCHAIN;
const SYNTHETIC_MODEL_ID = "acme-x1.0";
const SYNTHETIC_MINIMAX_EXTERNAL_ID = "ACME-X1.0";
const STAGE4_CATALOG_FIXTURE = join(
  import.meta.dir,
  "..",
  "test-fixtures",
  "stage4-default-provider-catalog.json"
);
const STAGE5_CATALOG_FIXTURE = join(
  import.meta.dir,
  "..",
  "test-fixtures",
  "stage5-explain-route-catalog.json"
);
function seedDefaultCatalog(entries: DiskCacheV3["entries"]): () => void {
  _setCatalogEntriesForTest(entries);
  return _resetCatalogClient;
}

function makeTempCatalog(
  model: {
    modelId: string;
    aliases?: string[];
    externalId?: string;
    subscriptionPlanIds?: string[];
  },
  /** Plan names to mark as active subscription plans in the catalog (defaults to the model's own plans). */
  plans: string[] = model.subscriptionPlanIds ?? [],
  routingProviderByPlan: Record<string, string> = {},
  additionalProviders: string[] = []
): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "claudish-routing-test-"));
  const path = join(dir, "all-models.json");
  const entries: DiskCacheV3["entries"] = [];

  // Plan-owner entries: a provider is only treated as a subscription plan if
  // some catalog entry lists it in subscriptionPlanIds[]. Add markers so tests can
  // model the "model is not in this plan" drop path without duplicating real
  // plan members.
  for (const plan of plans) {
    entries.push({
      modelId: `${plan}-plan-marker`,
      aliases: [],

      subscriptionPlanIds: [plan],
      aggregators: [
        {
          sourceCollectorId: "test",
          routeStatus: "mapped",
          route: catalogRouteForProvider(routingProviderByPlan[plan] ?? plan),
          sourceProviderId: plan,
          externalModelId: "any",
          confidence: "scrape_verified" as const,
        },
      ],
    });
  }

  entries.push({
    modelId: model.modelId,
    aliases: model.aliases ?? [],

    subscriptionPlanIds: model.subscriptionPlanIds ?? [],
    aggregators: model.externalId
      ? [
          ...(model.subscriptionPlanIds ?? []).map((planId) => ({
            sourceProviderId: routingProviderByPlan[planId] ?? planId,
            sourceCollectorId: "test",
            routeStatus: "mapped" as const,
            route: catalogRouteForProvider(routingProviderByPlan[planId] ?? planId),
            externalModelId: model.externalId!,
            confidence: "scrape_verified" as const,
          })),
          ...additionalProviders.map((provider) => ({
            sourceProviderId: provider,
            sourceCollectorId: "test",
            routeStatus: "mapped" as const,
            route: catalogRouteForProvider(provider),
            externalModelId: model.externalId!,
            confidence: "api_official" as const,
          })),
        ]
      : undefined,
  });

  const cache: DiskCacheV3 = {
    catalogGenerationId: "test-generation",
    version: 3,
    lastUpdated: new Date().toISOString(),
    entries,
    models: [],
    plans: plans.map((plan) => ({
      id: plan,
      modelDiscovery: "catalog",
      routeStatus: "supported",
      route: catalogRouteForProvider(routingProviderByPlan[plan] ?? plan),
    })),
  };
  writeAllModelsCache(cache, path);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function routeInSandbox(defaultProvider: string): RoutePlan {
  const home = mkdtempSync(join(tmpdir(), "claudish-default-provider-route-"));
  const configDir = join(home, ".claudish");
  mkdirSync(configDir, { recursive: true });
  copyFileSync(STAGE4_CATALOG_FIXTURE, join(configDir, "cloud-models-catalog-v3.json"));
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      customEndpoints: {
        x: {
          kind: "simple",
          url: "https://stage4-x.invalid/v1",
          format: "openai",
          apiKey: "stage4-test-key",
        },
      },
    }),
    "utf8"
  );

  const routingModuleUrl = new URL("./routing-rules.ts", import.meta.url).href;
  const script = `
    const { route } = await import(${JSON.stringify(routingModuleUrl)});
    const plan = await route("no-such-model-xyz");
    process.stdout.write(JSON.stringify(plan));
  `;
  const env: Record<string, string> = {
    HOME: home,
    PATH: process.env.PATH ?? "",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    CLAUDISH_DEFAULT_PROVIDER: defaultProvider,
    CLAUDISH_DISABLE_CATALOG_WARM: "1",
    CLAUDISH_DISABLE_KEYCHAIN: "1",
    CLAUDISH_DISABLE_OP: "1",
  };

  try {
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: join(import.meta.dir, "../../../.."),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    expect(result.exitCode, stderr || stdout).toBe(0);
    return JSON.parse(stdout) as RoutePlan;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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

        aggregators: [
          {
            sourceCollectorId: "test",
            routeStatus: "mapped",
            route: catalogRouteForProvider("minimax"),
            sourceProviderId: "minimax",
            externalModelId: SYNTHETIC_MINIMAX_EXTERNAL_ID,
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
// loadRoutingRules — source composition without disk I/O
// ---------------------------------------------------------------------------

describe("loadRoutingRules composes only user rules", () => {
  test("keeps model-loader imports type-only so routing rules cannot read ambient cache state", () => {
    const source = readFileSync(join(import.meta.dir, "routing-rules.ts"), "utf8");
    const modelLoaderImports = [
      ...source.matchAll(
        /(?:^|\n)\s*import\s+[^;]*?(?:from\s+)?["']\.\.\/model-loader\.js["']\s*;/g
      ),
    ].map((match) => match[0].trim());
    const valueImports = modelLoaderImports.filter(
      (statement) => !/^import\s+type\b/.test(statement)
    );

    expect(valueImports).toEqual([]);
  });

  test("returns an empty table when the user configured no rules", () => {
    expect(loadRoutingRules({ globalRules: {}, localRules: {} })).toEqual({});
  });

  test("honours a user glob verbatim", () => {
    const userRules: RoutingRules = { "grok-*": ["x-ai", "openrouter"] };
    const rules = loadRoutingRules({ globalRules: userRules, localRules: {} });
    expect(matchRoutingRule("grok-4.6", rules)).toEqual(userRules["grok-*"]);
  });

  test("returns only user-supplied rule keys", () => {
    const globalRules: RoutingRules = { "team-*": ["openrouter"] };
    const localRules: RoutingRules = { "project-model": ["x-ai"] };
    expect(loadRoutingRules({ globalRules, localRules })).toEqual({
      "team-*": ["openrouter"],
      "project-model": ["x-ai"],
    });
  });

  test("an exact key beats a glob inside the user's own rules", () => {
    const rules = loadRoutingRules({
      globalRules: {
        "grok-*": ["x-ai", "openrouter"],
        "grok-4.6": ["grok-subscription"],
      },
      localRules: {},
    });
    expect(matchRoutingRule("grok-4.6", rules)).toEqual(["grok-subscription"]);
  });

  test("local rules override global rules by exact key", () => {
    const userGlobal: RoutingRules = { "claude-*": ["openrouter"] };
    const userLocal: RoutingRules = { "claude-*": ["native-anthropic"] };
    const rules = loadRoutingRules({ globalRules: userGlobal, localRules: userLocal });
    expect(rules).toEqual({ "claude-*": ["native-anthropic"] });
  });

  test("preserves an explicit empty catch-all", () => {
    const rules = loadRoutingRules({ globalRules: { "*": [] }, localRules: {} });
    expect(matchRoutingRule("totally-unknown-model-xyz", rules)).toEqual([]);
  });
});

describe("validateRoutingRulesAgainstProviders", () => {
  test("throws when a rule references an unknown provider", () => {
    expect(() =>
      validateRoutingRulesAgainstProviders({ "fake-*": ["totally-not-a-real-provider"] })
    ).toThrow(/unknown providers/);
  });

  test("lists every unknown provider without blaming known providers", () => {
    expect(() =>
      validateRoutingRulesAgainstProviders({
        "a-*": ["typo-one"],
        "b-*": ["typo-two", "openrouter"],
      })
    ).toThrow(/typo-one[\s\S]*typo-two/);
    try {
      validateRoutingRulesAgainstProviders({ "a-*": ["typo-one", "openrouter"] });
    } catch (error) {
      expect((error as Error).message).not.toContain('→ unknown provider "openrouter"');
    }
  });

  test("accepts provider@wire-id rewrites", () => {
    expect(() =>
      validateRoutingRulesAgainstProviders({ "kimi-*": ["kimi-coding@whatever-model", "kimi"] })
    ).not.toThrow();
  });

  test("accepts provider shortcuts", () => {
    expect(() => validateRoutingRulesAgainstProviders({ "*": ["or"] })).not.toThrow();
  });

  test("rejects a typo in a provider@wire-id rewrite", () => {
    expect(() =>
      validateRoutingRulesAgainstProviders({ "kimi-*": ["typo-coding@kimi-for-coding"] })
    ).toThrow(/typo-coding/);
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

// Every provider credential and base-URL variable is cleared before each test, derived
// from the provider definitions (`clearProviderCredentialEnv`). A hand list here missed
// POE_API_KEY, and two tests routed to Poe on a machine that had it set (D4).
let restoreProviderEnv: () => void = () => {};

/**
 * Route `modelId` against a catalog that publishes it through `providers` only. Without a
 * catalog path, route() reads the real ~/.claudish catalog: whatever that machine last
 * fetched, and nothing at all on a fresh runner.
 */
async function routeOnCatalog(modelId: string, providers: string[]): Promise<RoutePlan> {
  const { path, cleanup } = makeTempCatalog(
    { modelId, externalId: modelId },
    undefined,
    {},
    providers
  );
  try {
    return await route(modelId, {}, undefined, path);
  } finally {
    cleanup();
  }
}

describe("route()", () => {
  let previousKeychainGuard: string | undefined;

  // CredentialAuthority memoizes provider resolution process-wide, so another
  // test module's top-level credential probe can prewarm real credentials.
  // Invalidate before and after each test to isolate host and fake keys.
  beforeEach(() => {
    // Credential resolution is env → aliases → config → keychain → op://.
    // These tests predate the keychain source and originally disabled only
    // op://, leaving host keychain entries able to satisfy "no credentials"
    // assertions. Disable both external stores with the mock-free env flags.
    previousKeychainGuard = process.env.CLAUDISH_DISABLE_KEYCHAIN;
    process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
    process.env.CLAUDISH_DISABLE_OP = "1";
    __resetSniffForTests();
    credentials.invalidate();
    // Snapshot and clear every provider credential and base-URL variable.
    restoreProviderEnv = clearProviderCredentialEnv();
  });

  afterEach(() => {
    if (previousKeychainGuard === undefined) {
      delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
    } else {
      process.env.CLAUDISH_DISABLE_KEYCHAIN = previousKeychainGuard;
    }
    delete process.env.CLAUDISH_DISABLE_OP;
    __resetSniffForTests();
    // Restore them (preserves the host environment for other tests).
    restoreProviderEnv();
    credentials.invalidate();
  });

  test("claude-opus-4-7 with ANTHROPIC_API_KEY → primary native-anthropic", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const plan = await routeOnCatalog("claude-opus-4-7", ["native-anthropic", "openrouter"]);
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
    const originalFetcher = getModelDiscoveryFetcher("devin-connect");
    if (!originalFetcher) throw new Error("Devin discovery fetcher is not registered");
    registerModelDiscoveryFetcher("devin-connect", async () => ({
      kind: "models",
      models: [{ id: "glm-5-2" }],
    }));
    invalidateModelDiscovery("devin");
    try {
      process.env.WINDSURF_API_KEY = "devin-session-token$test";
      const plan = await route("dv@glm-5-2", {});
      expect(plan.kind).toBe("ok");
      if (plan.kind !== "ok") return;
      expect(plan.primary.modelSpec).toBe("dv@glm-5-2");
      expect(plan.primary.modelSpec).not.toBe("dv@glm-5.2");
    } finally {
      registerModelDiscoveryFetcher("devin-connect", originalFetcher);
      invalidateModelDiscovery("devin");
    }
  });

  test("claude-opus-4-7 with only OPENROUTER_API_KEY → primary openrouter", async () => {
    process.env.OPENROUTER_API_KEY = "or-test";
    const plan = await routeOnCatalog("claude-opus-4-7", ["native-anthropic", "openrouter"]);
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("openrouter");
  });

  test("claude-opus-4-7 with no credentials → no-route, hint mentions both providers", async () => {
    const plan = await routeOnCatalog("claude-opus-4-7", ["native-anthropic", "openrouter"]);
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
    const plan = await route("native-anthropic@claude-opus-4-7", {});
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("native-anthropic");
    expect(plan.fallbacks).toHaveLength(0);
  });

  test("explicit prefix openai@gpt-5 with no OPENAI_API_KEY → no-route, NO silent OR fallback", async () => {
    // Even with OPENROUTER_API_KEY set, an explicit openai@ prefix must NOT
    // silently reroute to OpenRouter.
    process.env.OPENROUTER_API_KEY = "or-test";
    const plan = await route("openai@gpt-5", {});
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
    const plan = await routeOnCatalog("gpt-5", ["openai-codex", "openai"]);
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("openai");
  });

  test("gpt-5 (bare) with OPENAI_CODEX_API_KEY and no catalog → no-route", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudish-routing-empty-catalog-test-"));
    const cachePath = join(dir, "all-models.json");
    try {
      process.env.OPENAI_CODEX_API_KEY = "sk-codex-test";
      const plan = await route("gpt-5", {}, undefined, cachePath);
      expect(plan.kind).toBe("no-route");
      if (plan.kind !== "no-route") return;
      expect(plan.reason).toContain("No model catalog available");
      expect(plan.hint).toContain("claudish --models-refresh");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("qwen3.7-plus prefers qwen-token-plan over qwen-payg when both credentials are present", async () => {
    process.env.QWEN_TOKEN_PLAN_API_KEY = "qwen-plan-test";
    process.env.DASHSCOPE_API_KEY = "qwen-payg-test";
    const { path, cleanup } = makeTempCatalog(
      {
        modelId: "qwen3.7-plus",
        externalId: "qwen3.7-plus",
        subscriptionPlanIds: ["qwen-token-plan"],
      },
      undefined,
      {},
      ["qwen-payg"]
    );
    try {
      const plan = await route("qwen3.7-plus", {}, undefined, path);
      expect(plan.kind).toBe("ok");
      if (plan.kind !== "ok") return;
      expect(plan.primary.provider).toBe("qwen-token-plan");
      expect(plan.primary.modelSpec).toBe("qtoken@qwen3.7-plus");
      expect(plan.fallbacks.map((fallback) => fallback.provider)).toEqual(["qwen-payg"]);
      expect(plan.fallbacks[0]?.modelSpec).toBe("qpay@qwen3.7-plus");
    } finally {
      cleanup();
    }
  });

  test("qwen3.7-plus prefers Coding Plan when all three Alibaba credentials are present", async () => {
    process.env.QWEN_CODING_PLAN_API_KEY = "coding-test";
    process.env.QWEN_TOKEN_PLAN_API_KEY = "token-test";
    process.env.DASHSCOPE_API_KEY = "payg-test";
    const planIds = ["alibaba-ai-coding-plan", "alibaba-token-plan-individual"];
    const { path, cleanup } = makeTempCatalog(
      { modelId: "qwen3.7-plus", externalId: "qwen3.7-plus", subscriptionPlanIds: planIds },
      planIds,
      {
        "alibaba-ai-coding-plan": "qwen-coding",
        "alibaba-token-plan-individual": "qwen-token-plan",
      },
      ["qwen-payg"]
    );
    try {
      const result = await route("qwen3.7-plus", {}, undefined, path);
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      expect(result.primary.modelSpec).toBe("qcode@qwen3.7-plus");
      expect(result.fallbacks.map((candidate) => candidate.modelSpec)).toEqual([
        "qtoken@qwen3.7-plus",
        "qpay@qwen3.7-plus",
      ]);
    } finally {
      cleanup();
    }
  });

  test("qwen3.7-plus falls through to qwen-payg with only DASHSCOPE_API_KEY", async () => {
    process.env.DASHSCOPE_API_KEY = "qwen-payg-test";
    const { path, cleanup } = makeTempCatalog(
      {
        modelId: "qwen3.7-plus",
        externalId: "qwen3.7-plus",
        subscriptionPlanIds: ["qwen-token-plan"],
      },
      undefined,
      {},
      ["qwen-payg"]
    );
    try {
      const plan = await route("qwen3.7-plus", {}, undefined, path);
      expect(plan.kind).toBe("ok");
      if (plan.kind !== "ok") return;
      expect(plan.primary.provider).toBe("qwen-payg");
      expect(plan.primary.modelSpec).toBe("qpay@qwen3.7-plus");
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
        subscriptionPlanIds: ["kimi-code"],
      },
      ["kimi-code"],
      { "kimi-code": "kimi-coding" }
    );
    try {
      const plan = await route("kimi-k3", {}, undefined, path);
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
        catalogGenerationId: "test-generation",
        version: 3,
        lastUpdated: new Date().toISOString(),
        entries: [{ modelId: "gpt-rollout-model", aliases: [] }],
        models: [],
        plans: [
          {
            id: "openai-codex",
            modelDiscovery: "catalog",
            routeStatus: "supported",
            route: catalogRouteForProvider("openai-codex"),
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
        catalogGenerationId: "test-generation",
        version: 3,
        lastUpdated: new Date().toISOString(),
        entries: [{ modelId: "grok-account-model", aliases: [] }],
        models: [],
        plans: [
          {
            id: "xai-supergrok",
            modelDiscovery: "client",
            routeStatus: "supported",
            route: catalogRouteForProvider("grok-subscription"),
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
        aliases: ["k3"],
        externalId: "k3",
        subscriptionPlanIds: ["kimi-coding"],
      },
      ["kimi-coding"]
    );
    try {
      const plan = await route("k3", {}, undefined, path);
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
        aliases: ["k3-256k"],
        externalId: "k3-256k",
        subscriptionPlanIds: ["kimi-coding"],
      },
      ["kimi-coding"]
    );
    try {
      const plan = await route("k3-256k", {}, undefined, path);
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
        externalId: "kimi-k2.5",
        // No subscriptionPlanIds — this model is not part of the kimi-coding plan,
        // so the subscription candidate is dropped instead of silently substituting.
      },
      ["kimi-coding"],
      {},
      ["kimi"]
    );
    try {
      const plan = await route("kimi-k2.5", {}, undefined, path);
      expect(plan.kind).toBe("ok");
      if (plan.kind !== "ok") return;
      expect(plan.primary.provider).toBe("kimi");
      expect(plan.primary.modelSpec).toBe("kimi@kimi-k2.5");
    } finally {
      cleanup();
    }
  });

  test("user disables catch-all with '*' = [] → no-route for unknown bare names", async () => {
    const userRules: RoutingRules = { "*": [] };
    process.env.OPENROUTER_API_KEY = "or-test";
    const plan = await route("totally-unknown-xyz", userRules);
    expect(plan.kind).toBe("no-route");
  });

  test("gpt-5 (bare) with all fallback credentials and no catalog → no-route", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudish-routing-empty-catalog-test-"));
    const cachePath = join(dir, "all-models.json");
    try {
      process.env.OPENAI_CODEX_API_KEY = "cx-test";
      process.env.OPENAI_API_KEY = "oai-test";
      process.env.OPENROUTER_API_KEY = "or-test";
      const plan = await route("gpt-5", {}, undefined, cachePath);
      expect(plan.kind).toBe("no-route");
      if (plan.kind !== "no-route") return;
      expect(plan.reason).toContain("No model catalog available");
      expect(plan.hint).toContain("claudish --models-refresh");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// defaultProvider — appended as final fallback to bare-name chains
// ---------------------------------------------------------------------------

describe("route() with defaultProvider", () => {
  let previousKeychainGuard: string | undefined;

  // CredentialAuthority memoizes provider resolution process-wide, so another
  // test module's top-level credential probe can prewarm real credentials.
  // Invalidate before and after each test to isolate host and fake keys.
  beforeEach(() => {
    previousKeychainGuard = process.env.CLAUDISH_DISABLE_KEYCHAIN;
    process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
    process.env.CLAUDISH_DISABLE_OP = "1";
    __resetSniffForTests();
    credentials.invalidate();
    restoreProviderEnv = clearProviderCredentialEnv();
  });

  afterEach(() => {
    if (previousKeychainGuard === undefined) {
      delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
    } else {
      process.env.CLAUDISH_DISABLE_KEYCHAIN = previousKeychainGuard;
    }
    delete process.env.CLAUDISH_DISABLE_OP;
    __resetSniffForTests();
    restoreProviderEnv();
    credentials.invalidate();
  });

  test("a matched user rule is honoured verbatim without appending defaultProvider", async () => {
    process.env.OPENAI_API_KEY = "oai-test";
    process.env.XAI_API_KEY = "xai-test";
    const plan = await route("gpt-5", { "gpt-*": ["openai"] }, "x-ai");
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.primary.provider).toBe("openai");
    expect(plan.fallbacks).toEqual([]);
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
    const { path, cleanup } = makeTempCatalog({ modelId: "catalog-readable-marker" });
    try {
      const plan = await route("totally-unknown-xyz", {}, "openrouter", path);
      expect(plan.kind).toBe("ok");
      if (plan.kind !== "ok") return;
      expect(plan.primary.provider).toBe("openrouter");
    } finally {
      cleanup();
    }
  });

  test("defaultProvider does not rescue a matched user chain with no credentials", async () => {
    process.env.XAI_API_KEY = "xai-test";
    const plan = await route("deepseek-r1", { "deepseek-*": ["deepseek"] }, "x-ai");
    expect(plan.kind).toBe("no-route");
  });

  test("defaultProvider undefined has the same effect as an omitted argument", async () => {
    process.env.OPENAI_API_KEY = "oai-test";
    const planA = await route("gpt-5", { "gpt-*": ["openai"] }, undefined);
    const planB = await route("gpt-5", { "gpt-*": ["openai"] });
    expect(planA).toEqual(planB);
  });

  test("defaultProvider not consulted for explicit provider@model spec", async () => {
    process.env.OPENROUTER_API_KEY = "or-test";
    const plan = await route("openrouter@gpt-5", {}, "xai");
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

describe("route() reads the resolved defaultProvider only without overrides", () => {
  test("an env provider registered by sandbox config is the fallback position", () => {
    const plan = routeInSandbox("x");
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect([plan.primary.provider, ...plan.fallbacks.map((entry) => entry.provider)]).toEqual([
      "x",
    ]);
  });

  test("an empty env value produces the catalog-empty no-route", () => {
    expect(routeInSandbox("")).toEqual({
      kind: "no-route",
      reason: 'No provider in the catalog serves "no-such-model-xyz".',
      hint:
        'No credentials found for "no-such-model-xyz". Options:\n' +
        "  Use:  claudish --model or@no-such-model-xyz  (route via OpenRouter)",
    });
  });

  test("rules passed without a third argument keep the openrouter guard", async () => {
    const priorDefault = process.env.CLAUDISH_DEFAULT_PROVIDER;
    const priorOpenRouter = process.env.OPENROUTER_API_KEY;
    const priorKeychainGuard = process.env.CLAUDISH_DISABLE_KEYCHAIN;
    const priorOpGuard = process.env.CLAUDISH_DISABLE_OP;
    process.env.CLAUDISH_DEFAULT_PROVIDER = "x";
    process.env.OPENROUTER_API_KEY = "stage4-openrouter-test-key";
    process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
    process.env.CLAUDISH_DISABLE_OP = "1";
    credentials.invalidate();
    ensureEndpointsRegistered({
      config: { version: "1.0.0", defaultProfile: "default", profiles: {} },
      force: true,
    });

    try {
      const plan = await route("no-such-model-xyz", {}, undefined, STAGE4_CATALOG_FIXTURE);
      expect(plan.kind).toBe("ok");
      if (plan.kind !== "ok") return;
      expect(plan.primary.provider).toBe("openrouter");
      expect(plan.fallbacks).toEqual([]);
    } finally {
      if (priorDefault === undefined) delete process.env.CLAUDISH_DEFAULT_PROVIDER;
      else process.env.CLAUDISH_DEFAULT_PROVIDER = priorDefault;
      if (priorOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = priorOpenRouter;
      if (priorKeychainGuard === undefined) delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
      else process.env.CLAUDISH_DISABLE_KEYCHAIN = priorKeychainGuard;
      if (priorOpGuard === undefined) delete process.env.CLAUDISH_DISABLE_OP;
      else process.env.CLAUDISH_DISABLE_OP = priorOpGuard;
      credentials.invalidate();
    }
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

    aggregators: providers.map((provider) => ({
      sourceProviderId: provider,
      sourceCollectorId: "test",
      routeStatus: "mapped" as const,
      route: catalogRouteForProvider(provider),
      externalModelId: modelId,
      confidence: "api_official",
    })),
  };
}

function modelsCatalogProvider(name: string): ProviderDefinition {
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
  let modelsCatalogs = new Map<string, string[]>();
  let fetchCalls: string[] = [];

  function allowCredentials(...providers: string[]): void {
    credentialedProviders = new Set(providers);
  }

  function registerModelsCatalog(name: string, ...ids: string[]): void {
    registerRuntimeProvider(modelsCatalogProvider(name));
    modelsCatalogs.set(name, ids);
  }

  beforeEach(() => {
    _resetCatalogClient();
    _setCatalogEntriesForTest([]);
    invalidateModelDiscovery();
    clearRuntimeRegistry();

    credentialedProviders = new Set();
    modelsCatalogs = new Map();
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
      const ids = modelsCatalogs.get(provider);
      if (!ids) throw new Error(`Unexpected discovery request for ${provider}`);
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
    registerModelsCatalog(denied, "some-other-model");
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
    registerModelsCatalog(first, "other-first");
    registerModelsCatalog(second, "other-second");
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
    registerModelsCatalog(denied, "some-other-model");
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
    registerModelsCatalog(serving, AVAILABILITY_MODEL);
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
    registerModelsCatalog(noCredential, AVAILABILITY_MODEL);
    registerModelsCatalog(credentialed, AVAILABILITY_MODEL);
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
    // guaranteed-failing discovery round-trip.
    expect(fetchCalls).toEqual([credentialed]);
    expect(fetchCalls).not.toContain(noCredential);
  });
});

// ---------------------------------------------------------------------------
// Stage 1 routing characterization — plans and billing notices
// ---------------------------------------------------------------------------

describe("route() no-route plan characterization", () => {
  const realIsAvailable = credentials.isAvailable;
  const realDescribeReadiness = credentials.describeReadiness;
  const antigravityFetcher = getModelDiscoveryFetcher("antigravity");

  let readiness = new Map<string, "present" | "absent" | "failed">();
  let previousKeychainGuard: string | undefined;

  beforeEach(() => {
    previousKeychainGuard = process.env.CLAUDISH_DISABLE_KEYCHAIN;
    process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
    // buildCatalogChain normally registers endpoints by reading global config.
    // Supplying an empty config here latches the same registry without touching
    // the developer's HOME; every route call below also supplies rules and a
    // cachePath explicitly.
    ensureEndpointsRegistered({
      config: { version: "1.0.0", defaultProfile: "default", profiles: {} },
    });
    readiness = new Map();
    credentials.isAvailable = async (provider: string) => readiness.get(provider) === "present";
    credentials.describeReadiness = async (provider: string) => ({
      readiness: readiness.get(provider) ?? "absent",
    });
    registerModelDiscoveryFetcher("antigravity", async () => ({
      kind: "models",
      models: [{ id: "some-other-model" }],
    }));
    invalidateModelDiscovery("antigravity");
  });

  afterEach(() => {
    if (previousKeychainGuard === undefined) {
      delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
    } else {
      process.env.CLAUDISH_DISABLE_KEYCHAIN = previousKeychainGuard;
    }
    credentials.isAvailable = realIsAvailable;
    credentials.describeReadiness = realDescribeReadiness;
    if (antigravityFetcher) {
      registerModelDiscoveryFetcher("antigravity", antigravityFetcher);
    }
    invalidateModelDiscovery("antigravity");
    setDiagOutput(null);
    initLogger(false, "info", true);
  });

  test("pins a matched empty rule", async () => {
    const fixture = makeTempCatalog({ modelId: "catalog-marker" });
    try {
      expect(await route("blocked-by-rule", { "blocked-by-rule": [] }, "", fixture.path)).toEqual({
        kind: "no-route",
        reason: 'A routing rule matched "blocked-by-rule" and named no provider.',
        hint:
          'No credentials found for "blocked-by-rule". Options:\n' +
          "  Use:  claudish --model or@blocked-by-rule  (route via OpenRouter)",
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("pins a rule whose only entry is excluded by subscription membership", async () => {
    const fixture = makeTempCatalog({ modelId: "membership-excluded" }, ["kimi-coding"]);
    try {
      expect(
        await route(
          "membership-excluded",
          { "membership-excluded": ["kimi-coding"] },
          "",
          fixture.path
        )
      ).toEqual({
        kind: "no-route",
        reason: 'A routing rule matched "membership-excluded" and named no provider.',
        hint:
          'No credentials found for "membership-excluded". Options:\n' +
          "  Use:  claudish --model or@membership-excluded  (route via OpenRouter)",
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("pins an unreadable catalog", async () => {
    const fixture = makeTempCatalog({ modelId: "catalog-marker" });
    const missingPath = join(fixture.path, "missing", "all-models.json");
    try {
      expect(await route("catalog-unreadable", {}, "", missingPath)).toEqual({
        kind: "no-route",
        reason: 'No model catalog available, so "catalog-unreadable" cannot be routed by name.',
        hint:
          "Run `claudish --models-refresh` to fetch the catalog, or name the provider " +
          "explicitly (e.g. `openrouter@catalog-unreadable`).",
      });
    } finally {
      fixture.cleanup();
    }
  });

  test.each([
    [
      "claude-opus-not-published",
      "Claude name",
      'No credentials found for "claude-opus-not-published". Options:\n' +
        "  Set:  export ANTHROPIC_API_KEY=your-key  (for native-anthropic)\n" +
        "  Use:  claudish --model or@claude-opus-not-published  (route via OpenRouter)",
    ],
    [
      "o4-mini",
      "non-Claude name",
      'No credentials found for "o4-mini". Options:\n' +
        "  Use:  claudish --model or@o4-mini  (route via OpenRouter)",
    ],
  ])("pins a readable catalog with no entry for a %s", async (model, _label, hint) => {
    const fixture = makeTempCatalog({ modelId: "catalog-marker" });
    try {
      expect(await route(model, {}, "", fixture.path)).toEqual({
        kind: "no-route",
        reason: `No provider in the catalog serves "${model}".`,
        hint,
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("omits the OpenRouter suggestion when the probe map says OpenRouter is backend-owned", () => {
    const model = "catalog-denies-openrouter";
    const fixture = makeTempCatalog({ modelId: model });
    const home = mkdtempSync(join(tmpdir(), "claudish-openrouter-owned-route-"));
    try {
      const configDir = join(home, ".claudish");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "probe-models.json"),
        JSON.stringify({
          version: 3,
          generationId: "stage5-test-generation",
          generatedAt: "2026-09-24T00:00:00.000Z",
          providers: { openrouter: "probe-model" },
          unavailable: {},
        }),
        "utf8"
      );
      const routingModuleUrl = new URL("./routing-rules.ts", import.meta.url).href;
      const script = `
        const { route } = await import(${JSON.stringify(routingModuleUrl)});
        const plan = await route(${JSON.stringify(model)}, {}, "", ${JSON.stringify(fixture.path)});
        process.stdout.write(JSON.stringify(plan));
      `;
      const env: Record<string, string> = {
        HOME: home,
        PATH: process.env.PATH ?? "",
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        CLAUDISH_DISABLE_CATALOG_WARM: "1",
        CLAUDISH_DISABLE_KEYCHAIN: "1",
        CLAUDISH_DISABLE_OP: "1",
      };
      const result = Bun.spawnSync([process.execPath, "-e", script], {
        cwd: join(import.meta.dir, "../../../.."),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = result.stdout.toString();
      const stderr = result.stderr.toString();
      expect(result.exitCode, stderr || stdout).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        kind: "no-route",
        reason: `No provider in the catalog serves "${model}".`,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  test("keeps the OpenRouter suggestion when no probe map says who owns the route", () => {
    const model = "catalog-denies-openrouter";
    const fixture = makeTempCatalog({ modelId: model });
    const home = mkdtempSync(join(tmpdir(), "claudish-openrouter-unknown-route-"));
    try {
      const routingModuleUrl = new URL("./routing-rules.ts", import.meta.url).href;
      const script = `
        const { route } = await import(${JSON.stringify(routingModuleUrl)});
        const plan = await route(${JSON.stringify(model)}, {}, "", ${JSON.stringify(fixture.path)});
        process.stdout.write(JSON.stringify(plan));
      `;
      const env: Record<string, string> = {
        HOME: home,
        PATH: process.env.PATH ?? "",
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        CLAUDISH_DISABLE_CATALOG_WARM: "1",
        CLAUDISH_DISABLE_KEYCHAIN: "1",
        CLAUDISH_DISABLE_OP: "1",
      };
      const result = Bun.spawnSync([process.execPath, "-e", script], {
        cwd: join(import.meta.dir, "../../../.."),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = result.stdout.toString();
      const stderr = result.stderr.toString();
      expect(result.exitCode, stderr || stdout).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        kind: "no-route",
        reason: `No provider in the catalog serves "${model}".`,
        hint: expect.stringContaining("claudish --model or@catalog-denies-openrouter"),
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  test("pins the tried providers when every candidate lacks credentials", async () => {
    const fixture = makeTempCatalog({ modelId: "no-credential-model" });
    try {
      expect(
        await route(
          "no-credential-model",
          { "no-credential-model": ["openai", "openrouter"] },
          "",
          fixture.path
        )
      ).toEqual({
        kind: "no-route",
        reason:
          'No credentialed providers in chain for "no-credential-model" (tried: openai, openrouter).',
        hint:
          'No credentials found for "no-credential-model". Options:\n' +
          "  Set:  export OPENAI_API_KEY=your-key  (for openai)\n" +
          "  Set:  export OPENROUTER_API_KEY=your-key  (for openrouter)",
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("pins the checked providers when every credentialed candidate is not served", async () => {
    const model = "gemini-characterization-target";
    const fixture = makeTempCatalog({ modelId: model });
    readiness.set("antigravity", "present");
    try {
      expect(await route(model, { [model]: [`antigravity@${model}`] }, "", fixture.path)).toEqual({
        kind: "no-route",
        reason: `No provider serves "${model}" (checked: antigravity).`,
        hint:
          `No credentials found for "${model}". Options:\n` +
          "  Run:  claudish login antigravity  (authenticate via OAuth)\n" +
          `  Use:  claudish --model or@${model}  (route via OpenRouter)`,
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("pins an explicit spec with no credential", async () => {
    const fixture = makeTempCatalog({ modelId: "gpt-5" });
    try {
      expect(await route("openai@gpt-5", {}, "", fixture.path)).toEqual({
        kind: "no-route",
        reason: 'No credentials configured for "openai".',
        hint:
          'No credentials found for "gpt-5". Options:\n' +
          "  Set:  export OPENAI_API_KEY=your-key  (for openai)\n" +
          "  Use:  claudish --model or@gpt-5  (route via OpenRouter)",
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("pins an explicit spec that its provider does not serve", async () => {
    const model = "gemini-explicit-characterization";
    const fixture = makeTempCatalog({ modelId: model });
    readiness.set("antigravity", "present");
    try {
      expect(await route(`antigravity@${model}`, {}, "", fixture.path)).toEqual({
        kind: "no-route",
        reason: `Antigravity does not serve "${model}".`,
        hint:
          `Check the model id, or use a bare \`${model}\` to let claudish pick a provider ` +
          "that carries it.",
      });
    } finally {
      fixture.cleanup();
    }
  });
});

describe("route() metered-billing notice characterization", () => {
  const realIsAvailable = credentials.isAvailable;
  const realDescribeReadiness = credentials.describeReadiness;
  const antigravityFetcher = getModelDiscoveryFetcher("antigravity");

  let readiness = new Map<string, "present" | "absent" | "failed">();
  let previousKeychainGuard: string | undefined;

  beforeEach(() => {
    previousKeychainGuard = process.env.CLAUDISH_DISABLE_KEYCHAIN;
    process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
    ensureEndpointsRegistered({
      config: { version: "1.0.0", defaultProfile: "default", profiles: {} },
    });
    readiness = new Map();
    credentials.isAvailable = async (provider: string) => readiness.get(provider) === "present";
    credentials.describeReadiness = async (provider: string) => ({
      readiness: readiness.get(provider) ?? "absent",
    });
    registerModelDiscoveryFetcher("antigravity", async () => ({
      kind: "models",
      models: [{ id: "some-other-model" }],
    }));
    invalidateModelDiscovery("antigravity");
  });

  afterEach(() => {
    if (previousKeychainGuard === undefined) {
      delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
    } else {
      process.env.CLAUDISH_DISABLE_KEYCHAIN = previousKeychainGuard;
    }
    credentials.isAvailable = realIsAvailable;
    credentials.describeReadiness = realDescribeReadiness;
    if (antigravityFetcher) {
      registerModelDiscoveryFetcher("antigravity", antigravityFetcher);
    }
    invalidateModelDiscovery("antigravity");
    setDiagOutput(null);
    initLogger(false, "info", true);
  });

  async function captureDiag<T>(run: () => Promise<T>): Promise<{ value: T; messages: string[] }> {
    const messages: string[] = [];
    setDiagOutput({
      write(message: string) {
        messages.push(message);
      },
      cleanup() {},
    });
    try {
      return { value: await run(), messages };
    } finally {
      setDiagOutput(null);
    }
  }

  test("prints the metered notice and debug skip when a subscription does not serve the model", async () => {
    const model = "gemini-notice-target";
    const fixture = makeTempCatalog({ modelId: model });
    readiness.set("antigravity", "present");
    readiness.set("openai", "present");
    initLogger(true, "debug", true);
    const logPath = getLogFilePath();
    if (!logPath) throw new Error("debug logger did not expose its path");
    try {
      const captured = await captureDiag(() =>
        route(model, { [model]: [`antigravity@${model}`, `openai@${model}`] }, "", fixture.path)
      );
      expect(captured.value).toEqual({
        kind: "ok",
        primary: { provider: "openai", modelSpec: `oai@${model}`, displayName: "OpenAI" },
        fallbacks: [],
      });
      expect(captured.messages).toEqual([
        `antigravity does not serve ${model} — using OpenAI, which bills per token.`,
      ]);

      await Bun.sleep(150);
      expect(readFileSync(logPath, "utf8")).toContain(
        `[routing] ${model}: skipped antigravity — does not serve this model`
      );
    } finally {
      initLogger(false, "info", true);
      rmSync(logPath, { force: true });
      fixture.cleanup();
    }
  });

  test("prints the metered notice when a subscription credential is unreadable", async () => {
    const model = "credential-notice-target";
    const fixture = makeTempCatalog({ modelId: model });
    readiness.set("antigravity", "failed");
    readiness.set("openai", "present");
    try {
      const captured = await captureDiag(() =>
        route(model, { [model]: [`antigravity@${model}`, `openai@${model}`] }, "", fixture.path)
      );
      expect(captured.value).toEqual({
        kind: "ok",
        primary: { provider: "openai", modelSpec: `oai@${model}`, displayName: "OpenAI" },
        fallbacks: [],
      });
      expect(captured.messages).toEqual([
        'antigravity: the credential could not be READ (not "no key") — ' +
          "using OpenAI, which bills per token.",
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  test("prints no notice when the first kept hop is a subscription", async () => {
    const model = "subscription-kept-target";
    const fixture = makeTempCatalog({ modelId: model });
    readiness.set("antigravity", "present");
    readiness.set("minimax-coding", "present");
    try {
      const captured = await captureDiag(() =>
        route(
          model,
          { [model]: [`antigravity@${model}`, `minimax-coding@${model}`] },
          "",
          fixture.path
        )
      );
      expect(captured.value).toEqual({
        kind: "ok",
        primary: {
          provider: "minimax-coding",
          modelSpec: `mmc@${model}`,
          displayName: "MiniMax Coding",
        },
        fallbacks: [],
      });
      expect(captured.messages).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Stage 5 — explainRoute, derivation, and rule warnings
// ---------------------------------------------------------------------------

describe("matchRoutingRuleKey", () => {
  const rules: RoutingRules = {
    "GLM-5.2": ["glm"],
    "glm-*": ["openrouter"],
    "glm-5-*": ["z-ai"],
    "*": ["openai"],
  };

  test("returns the stored exact key case-insensitively", () => {
    expect(matchRoutingRuleKey("glm-5.2", rules)).toBe("GLM-5.2");
  });

  test("returns the longest matching glob", () => {
    expect(matchRoutingRuleKey("glm-5-fast", rules)).toBe("glm-5-*");
  });

  test("returns the catch-all key when no specific rule matches", () => {
    expect(matchRoutingRuleKey("some-other-model", rules)).toBe("*");
  });

  test("returns null when no rule matches", () => {
    expect(matchRoutingRuleKey("some-other-model", { "glm-*": ["glm"] })).toBeNull();
  });
});

interface Stage5SandboxResult {
  diag: string[];
  consoleErrors: string[];
  problems: Array<{
    scope: "global" | "project";
    pattern: string;
    problem: "multiple-wildcards" | "case-collision" | "unknown-provider";
    entry?: string;
    collidesWith?: string;
  }>;
  localRule: { matchedPattern?: string; ruleScope?: string; description: string };
  globalRule: { matchedPattern?: string; ruleScope?: string; description: string };
  catalogDenied: {
    fallbackWithheld?: string;
    providers: string[];
  };
  membershipFallback: Array<{ provider: string; position: string; outcome: string }>;
}

let cachedStage5SandboxResult: Stage5SandboxResult | undefined;

function stage5SandboxResult(): Stage5SandboxResult {
  if (cachedStage5SandboxResult) return cachedStage5SandboxResult;

  const home = mkdtempSync(join(tmpdir(), "claudish-stage5-explain-"));
  const configDir = join(home, ".claudish");
  const projectDir = join(home, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      routing: {
        "glm-*": ["openrouter"],
        "a**b": ["openrouter"],
        "Kimi-X": ["kimi"],
        "kimi-x": ["kimi"],
        "typo-*": ["typo-one", "sandbox-ep", "together"],
      },
      customEndpoints: {
        "sandbox-ep": {
          kind: "simple",
          url: "https://sandbox-ep.invalid/v1",
          format: "openai",
          apiKey: "stage5-test-key",
        },
      },
    }),
    "utf8"
  );
  writeFileSync(
    join(projectDir, ".claudish.json"),
    JSON.stringify({ routing: { "glm-5*": ["sandbox-ep"], "x*y*z": ["glm"] } }),
    "utf8"
  );
  writeFileSync(
    join(configDir, "probe-models.json"),
    JSON.stringify({
      version: 3,
      generationId: "stage5-test-generation",
      generatedAt: "2026-09-24T00:00:00.000Z",
      providers: { openrouter: "probe-model", openai: "probe-model" },
      unavailable: {},
    }),
    "utf8"
  );

  const routingModuleUrl = new URL("./routing-rules.ts", import.meta.url).href;
  const authorityModuleUrl = new URL("../auth/credentials/authority.ts", import.meta.url).href;
  const loggerModuleUrl = new URL("../logger.ts", import.meta.url).href;
  const script = `
    const rr = await import(${JSON.stringify(routingModuleUrl)});
    const { credentials } = await import(${JSON.stringify(authorityModuleUrl)});
    const { setDiagOutput } = await import(${JSON.stringify(loggerModuleUrl)});
    credentials.isAvailable = async (provider) => provider === "sandbox-ep";
    credentials.describeReadiness = async (provider) => ({
      readiness: provider === "sandbox-ep" ? "present" : "absent",
    });
    credentials.getRequestAuth = async () => ({
      headers: { Authorization: "Bearer stage5-offline" },
    });
    globalThis.fetch = async () => new Response("offline", { status: 503 });

    const diag = [];
    const consoleErrors = [];
    const realConsoleError = console.error;
    setDiagOutput({ write: (message) => diag.push(message), cleanup() {} });
    console.error = (...args) => consoleErrors.push(args.map(String).join(" "));
    let output;
    try {
      const first = await rr.explainRoute("typo-x", {
        cachePath: ${JSON.stringify(STAGE5_CATALOG_FIXTURE)},
      });
      const local = await rr.explainRoute("glm-5.3", {
        cachePath: ${JSON.stringify(STAGE5_CATALOG_FIXTURE)},
      });
      const global = await rr.explainRoute("glm-4.6", {
        cachePath: ${JSON.stringify(STAGE5_CATALOG_FIXTURE)},
      });
      const denied = await rr.explainRoute("cat-denied", {
        rules: {},
        cachePath: ${JSON.stringify(STAGE5_CATALOG_FIXTURE)},
      });
      const membershipFallback = await rr.explainRoute("plan-less", {
        rules: {},
        defaultProvider: "kimi-coding",
        cachePath: ${JSON.stringify(STAGE5_CATALOG_FIXTURE)},
      });
      output = {
        diag,
        consoleErrors,
        problems: first.warnings
          .filter((warning) => warning.type === "rule-problem")
          .map((warning) => warning.problem),
        localRule: {
          matchedPattern: local.matchedPattern,
          ruleScope: local.ruleScope,
          description: rr.describeRouteExplanation(local),
        },
        globalRule: {
          matchedPattern: global.matchedPattern,
          ruleScope: global.ruleScope,
          description: rr.describeRouteExplanation(global),
        },
        catalogDenied: {
          fallbackWithheld: denied.fallbackWithheld,
          providers: denied.candidates.map((candidate) => candidate.provider),
        },
        membershipFallback: membershipFallback.candidates.map((candidate) => ({
          provider: candidate.provider,
          position: candidate.position,
          outcome: candidate.outcome,
        })),
      };
    } finally {
      console.error = realConsoleError;
      setDiagOutput(null);
    }
    process.stdout.write(JSON.stringify(output));
  `;
  const env: Record<string, string> = {
    HOME: home,
    PATH: process.env.PATH ?? "",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    CLAUDISH_DISABLE_CATALOG_WARM: "1",
    CLAUDISH_DISABLE_KEYCHAIN: "1",
    CLAUDISH_DISABLE_OP: "1",
  };

  try {
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: projectDir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    if (result.exitCode !== 0) {
      throw new Error(`Stage 5 sandbox failed (${result.exitCode}): ${stderr || stdout}`);
    }
    cachedStage5SandboxResult = JSON.parse(stdout) as Stage5SandboxResult;
    return cachedStage5SandboxResult;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function stage5RuntimeProvider(name: string): ProviderDefinition {
  return {
    name,
    displayName: name,
    tier: "native",
    transport: "openai",
    baseUrl: `https://${name}.invalid`,
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: `${name.toUpperCase().replaceAll("-", "_")}_API_KEY`,
    apiKeyDescription: "Offline Stage 5 routing-test key",
    apiKeyUrl: "https://example.invalid/key",
    shortcuts: [],
    legacyPrefixes: [],
    createHandler: {
      kind: "none",
      reason: "virtual",
      note: "Stage 5 test fixture — never builds a handler.",
    },
    isDirectApi: true,
  };
}

describe("explainRoute", () => {
  const realFetch = globalThis.fetch;
  const realIsAvailable = credentials.isAvailable;
  const realDescribeReadiness = credentials.describeReadiness;
  const realGetRequestAuth = credentials.getRequestAuth;
  const antigravityFetcher = getModelDiscoveryFetcher("antigravity");

  let readiness = new Map<string, "present" | "absent" | "failed">();
  let antigravityModels: string[] = [];
  let liveModels = new Map<string, string[]>();
  let previousKeychainGuard: string | undefined;
  let previousOpGuard: string | undefined;

  function setReadiness(values: Record<string, "present" | "absent" | "failed">): void {
    readiness = new Map(Object.entries(values));
  }

  function resetDiscovery(): void {
    invalidateModelDiscovery();
  }

  beforeEach(() => {
    previousKeychainGuard = process.env.CLAUDISH_DISABLE_KEYCHAIN;
    previousOpGuard = process.env.CLAUDISH_DISABLE_OP;
    process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
    process.env.CLAUDISH_DISABLE_OP = "1";
    readiness = new Map();
    antigravityModels = [];
    liveModels = new Map();
    _resetCatalogClient();
    invalidateModelDiscovery();
    clearRuntimeRegistry();
    registerRuntimeProvider(stage5RuntimeProvider("kept-metered"));
    registerRuntimeProvider(stage5RuntimeProvider("no-cred"));
    registerRuntimeProvider(stage5RuntimeProvider("fallback-no-cred"));
    credentials.isAvailable = async (provider: string) => readiness.get(provider) === "present";
    credentials.describeReadiness = async (provider: string) => ({
      readiness: readiness.get(provider) ?? "absent",
    });
    credentials.getRequestAuth = async () => ({
      headers: { Authorization: "Bearer stage5-offline" },
    });
    registerModelDiscoveryFetcher("antigravity", async () => ({
      kind: "models",
      models: antigravityModels.map((id) => ({ id })),
    }));
    globalThis.fetch = (async (input: string | URL | Request) => {
      const rawUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const ids = liveModels.get(new URL(rawUrl).hostname);
      if (!ids) return new Response("offline", { status: 503 });
      return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    if (previousKeychainGuard === undefined) delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
    else process.env.CLAUDISH_DISABLE_KEYCHAIN = previousKeychainGuard;
    if (previousOpGuard === undefined) delete process.env.CLAUDISH_DISABLE_OP;
    else process.env.CLAUDISH_DISABLE_OP = previousOpGuard;
    credentials.isAvailable = realIsAvailable;
    credentials.describeReadiness = realDescribeReadiness;
    credentials.getRequestAuth = realGetRequestAuth;
    credentials.invalidate();
    if (antigravityFetcher) {
      registerModelDiscoveryFetcher("antigravity", antigravityFetcher);
    }
    globalThis.fetch = realFetch;
    invalidateModelDiscovery();
    clearRuntimeRegistry();
    _resetCatalogClient();
    setDiagOutput(null);
  });

  test("records every candidate outcome in chain order", async () => {
    setReadiness({ antigravity: "present", "minimax-coding": "failed", "kept-metered": "present" });
    antigravityModels = ["some-other-model"];

    const explanation = await explainRoute("rule-mix", {
      rules: {
        "rule-*": [
          "kimi-coding",
          "antigravity@rule-mix",
          "minimax-coding@rule-mix",
          "kept-metered@rule-mix",
          "no-cred@rule-mix",
        ],
      },
      cachePath: STAGE5_CATALOG_FIXTURE,
    });

    expect(explanation.source).toBe("user-rule");
    expect(explanation.matchedPattern).toBe("rule-*");
    expect(explanation.candidates.map(({ provider, outcome }) => [provider, outcome])).toEqual([
      ["kimi-coding", "excluded-by-membership"],
      ["antigravity", "not-served"],
      ["minimax-coding", "credential-unreadable"],
      ["kept-metered", "kept"],
      ["no-cred", "no-credential"],
    ]);
    expect(explanation.warnings.map((warning) => warning.type)).toEqual([
      "subscription-not-served",
      "subscription-credential-unreadable",
    ]);
  });

  test("records all fallback withholding values and catalog states", async () => {
    const alreadyGathered = await explainRoute("cat-found", {
      rules: {},
      cachePath: STAGE5_CATALOG_FIXTURE,
    });
    const absent = await explainRoute("no-such-model-xyz", {
      rules: {},
      cachePath: STAGE5_CATALOG_FIXTURE,
    });
    const disabled = await explainRoute("no-such-model-xyz", {
      rules: {},
      defaultProvider: "",
      cachePath: STAGE5_CATALOG_FIXTURE,
    });
    const unreadable = await explainRoute("whatever-x", {
      rules: {},
      cachePath: join(import.meta.dir, "missing-stage5-catalog.json"),
    });
    const catalogDenied = stage5SandboxResult().catalogDenied;

    expect({
      catalog: alreadyGathered.catalog,
      withheld: alreadyGathered.fallbackWithheld,
    }).toEqual({ catalog: "found", withheld: "already-gathered" });
    expect(absent.catalog).toBe("absent");
    expect({ catalog: disabled.catalog, withheld: disabled.fallbackWithheld }).toEqual({
      catalog: "absent",
      withheld: "disabled",
    });
    expect({ catalog: unreadable.catalog, withheld: unreadable.fallbackWithheld }).toEqual({
      catalog: "unreadable",
      withheld: "catalog-unreadable",
    });
    expect(catalogDenied).toEqual({
      fallbackWithheld: "catalog-denies",
      providers: ["openai"],
    });
  });

  test("keeps membership exclusion on the fallback position", async () => {
    expect(stage5SandboxResult().membershipFallback).toEqual([
      {
        provider: "kimi-coding",
        position: "fallback",
        outcome: "excluded-by-membership",
      },
    ]);
  });

  test("records every source, explicit via, rule scope, and routed model", async () => {
    setReadiness({ openrouter: "present" });
    const native = await explainRoute("opus", { cachePath: STAGE5_CATALOG_FIXTURE });
    const explicit = await explainRoute("anthropic/claude-opus-5", {
      cachePath: STAGE5_CATALOG_FIXTURE,
    });
    const userRule = await explainRoute("rule-mix", {
      rules: { "rule-*": [] },
      cachePath: STAGE5_CATALOG_FIXTURE,
    });
    const glm = await explainRoute("glm-5-2", {
      rules: {},
      cachePath: STAGE5_CATALOG_FIXTURE,
    });
    const vendorQualified = await explainRoute("openai/gpt-5", {
      rules: {},
      cachePath: STAGE5_CATALOG_FIXTURE,
    });
    const sandbox = stage5SandboxResult();

    expect(native).toMatchObject({ source: "native", requestedModel: "opus", routedModel: "opus" });
    expect(native.candidates).toEqual([]);
    expect(describeRouteExplanation(native)).toBe("native · Claude Code's own auth · not probed");
    expect(explicit).toMatchObject({
      source: "explicit",
      via: "vendor-qualified-id",
      requestedModel: "anthropic/claude-opus-5",
      routedModel: "anthropic/claude-opus-5",
    });
    expect(describeRouteExplanation(explicit)).toBe(
      "explicit · OpenRouter · vendor-qualified id sent verbatim"
    );
    expect(userRule).toMatchObject({ source: "user-rule", matchedPattern: "rule-*" });
    expect(glm).toMatchObject({
      source: "catalog",
      requestedModel: "glm-5-2",
      routedModel: "glm-5.2",
      catalog: "found",
    });
    expect(vendorQualified).toMatchObject({
      source: "catalog",
      requestedModel: "openai/gpt-5",
      routedModel: "gpt-5",
      catalog: "found",
    });
    expect(sandbox.localRule).toEqual({
      matchedPattern: "glm-5*",
      ruleScope: "project",
      description: 'user rule "glm-5*" (project)',
    });
    expect(sandbox.globalRule).toEqual({
      matchedPattern: "glm-*",
      ruleScope: "global",
      description: 'user rule "glm-*" (global)',
    });
  });

  test("records every reachable no-route cause", async () => {
    const causes = new Set<string>();
    const record = (explanation: RouteExplanation): void => {
      expect(explanation.outcome.kind).toBe("no-route");
      if (explanation.outcome.kind === "no-route") causes.add(explanation.outcome.cause);
    };

    record(
      await explainRoute("blocked", {
        rules: { blocked: [] },
        cachePath: STAGE5_CATALOG_FIXTURE,
      })
    );
    record(
      await explainRoute("whatever-x", {
        rules: {},
        cachePath: join(import.meta.dir, "missing-stage5-catalog.json"),
      })
    );
    record(
      await explainRoute("no-such-model-xyz", {
        rules: {},
        defaultProvider: "",
        cachePath: STAGE5_CATALOG_FIXTURE,
      })
    );
    record(
      await explainRoute("no-such-model-xyz", {
        rules: {},
        defaultProvider: "fallback-no-cred",
        cachePath: STAGE5_CATALOG_FIXTURE,
      })
    );

    setReadiness({ antigravity: "present" });
    antigravityModels = ["some-other-model"];
    resetDiscovery();
    record(
      await explainRoute("bare-not-served", {
        rules: { "bare-not-served": ["antigravity@bare-not-served"] },
        cachePath: STAGE5_CATALOG_FIXTURE,
      })
    );

    setReadiness({});
    resetDiscovery();
    record(
      await explainRoute("openai@gpt-5", {
        rules: {},
        cachePath: STAGE5_CATALOG_FIXTURE,
      })
    );

    setReadiness({ antigravity: "present" });
    antigravityModels = ["some-other-model"];
    resetDiscovery();
    record(
      await explainRoute("antigravity@explicit-not-served", {
        rules: {},
        cachePath: STAGE5_CATALOG_FIXTURE,
      })
    );

    expect(causes).toEqual(
      new Set([
        "rule-empty",
        "catalog-unreadable",
        "catalog-empty",
        "no-credential",
        "not-served",
        "explicit-no-credential",
        "explicit-not-served",
      ])
    );
  });

  test("an explicit provider@model pins its wire id instead of applying membership", async () => {
    setReadiness({ "kimi-coding": "present" });
    const explanation = await explainRoute("kimi-coding@plan-less", {
      rules: {},
      cachePath: STAGE5_CATALOG_FIXTURE,
    });

    // `explicit-unbuildable` cannot be reached through provider@model: the `@`
    // path deliberately bypasses plan membership because the user pinned a wire
    // id. Membership exclusion only runs for an @-less routing entry.
    expect(explanation.candidates[0]).toMatchObject({
      provider: "kimi-coding",
      wireId: "plan-less",
      outcome: "kept",
    });
    expect(explanation.outcome).toEqual({ kind: "ok" });
  });

  test("drops an uncredentialed fallback and never returns it as a route", async () => {
    const opts: ExplainRouteOptions = {
      rules: {},
      defaultProvider: "fallback-no-cred",
      cachePath: STAGE5_CATALOG_FIXTURE,
    };
    const explanation = await explainRoute("no-such-model-xyz", opts);
    const plan = await route("no-such-model-xyz", opts.rules, opts.defaultProvider, opts.cachePath);

    expect(explanation.candidates).toHaveLength(1);
    expect(explanation.candidates[0]).toMatchObject({
      provider: "fallback-no-cred",
      position: "fallback",
      outcome: "no-credential",
    });
    expect(explanation.outcome).toMatchObject({ kind: "no-route", cause: "no-credential" });
    expect(toRoutePlan(explanation)).toEqual(plan);
    expect(plan.kind).toBe("no-route");
  });

  test("filters a non-kept fallback even when another candidate routes", async () => {
    setReadiness({ openai: "present" });
    liveModels.set("api.openai.com", ["cat-denied"]);
    const opts: ExplainRouteOptions = {
      rules: {},
      defaultProvider: "fallback-no-cred",
      cachePath: STAGE5_CATALOG_FIXTURE,
    };
    const explanation = await explainRoute("cat-denied", opts);
    resetDiscovery();
    const plan = await route("cat-denied", opts.rules, opts.defaultProvider, opts.cachePath);

    expect(
      explanation.candidates.map(({ provider, position, outcome }) => ({
        provider,
        position,
        outcome,
      }))
    ).toEqual([
      { provider: "openai", position: "candidate", outcome: "kept" },
      { provider: "fallback-no-cred", position: "fallback", outcome: "no-credential" },
    ]);
    expect(toRoutePlan(explanation)).toEqual(plan);
    expect(plan).toEqual({
      kind: "ok",
      primary: { provider: "openai", modelSpec: "oai@cat-denied", displayName: "OpenAI" },
      fallbacks: [],
    });
  });

  test("derives route() from explanations over representative targets", async () => {
    const cases: Array<{
      target: string;
      opts: ExplainRouteOptions;
      ready?: Record<string, "present" | "absent" | "failed">;
      antigravity?: string[];
    }> = [
      {
        target: "rule-mix",
        opts: {
          rules: { "rule-mix": ["minimax-coding@rule-mix", "kept-metered@rule-mix"] },
          cachePath: STAGE5_CATALOG_FIXTURE,
        },
        ready: { "minimax-coding": "failed", "kept-metered": "present" },
      },
      {
        target: "no-such-model-xyz",
        opts: {
          rules: {},
          defaultProvider: "fallback-no-cred",
          cachePath: STAGE5_CATALOG_FIXTURE,
        },
      },
      {
        target: "cat-found",
        opts: { rules: {}, cachePath: STAGE5_CATALOG_FIXTURE },
      },
      {
        target: "openai@gpt-5",
        opts: { rules: {}, cachePath: STAGE5_CATALOG_FIXTURE },
      },
      {
        target: "antigravity@explicit-not-served",
        opts: { rules: {}, cachePath: STAGE5_CATALOG_FIXTURE },
        ready: { antigravity: "present" },
        antigravity: ["some-other-model"],
      },
      {
        target: "glm-5-2",
        opts: { rules: {}, cachePath: STAGE5_CATALOG_FIXTURE },
      },
    ];

    for (const testCase of cases) {
      setReadiness(testCase.ready ?? {});
      antigravityModels = testCase.antigravity ?? [];
      resetDiscovery();
      const explanation = await explainRoute(testCase.target, testCase.opts);
      resetDiscovery();
      const notices: string[] = [];
      setDiagOutput({ write: (message) => notices.push(message), cleanup() {} });
      let plan: RoutePlan;
      try {
        plan = await route(
          testCase.target,
          testCase.opts.rules,
          testCase.opts.defaultProvider,
          testCase.opts.cachePath
        );
      } finally {
        setDiagOutput(null);
      }
      expect(toRoutePlan(explanation)).toEqual(plan);
    }
  });

  test("never writes diagnostics or console errors", async () => {
    setReadiness({ "minimax-coding": "failed", "kept-metered": "present" });
    const diagnostics: string[] = [];
    setDiagOutput({ write: (message) => diagnostics.push(message), cleanup() {} });
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      await explainRoute("rule-mix", {
        rules: { "rule-mix": ["minimax-coding@rule-mix", "kept-metered@rule-mix"] },
        cachePath: STAGE5_CATALOG_FIXTURE,
      });
      expect(diagnostics).toEqual([]);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      setDiagOutput(null);
    }
  });
});

describe("routing rule warnings", () => {
  test("loadRoutingRules does not print a multiple-wildcard problem", () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(loadRoutingRules({ globalRules: { "a**b": ["openrouter"] }, localRules: {} })).toEqual(
        { "a**b": ["openrouter"] }
      );
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  test("returns wildcard and case-collision problems with their scopes", () => {
    expect(
      routingRuleProblems({
        globalRules: { "a**b": [], "Kimi-X": [], "kimi-x": [] },
        localRules: { "x*y*z": [] },
      })
    ).toEqual([
      { scope: "global", pattern: "a**b", problem: "multiple-wildcards" },
      {
        scope: "global",
        pattern: "kimi-x",
        problem: "case-collision",
        collidesWith: "Kimi-X",
      },
      { scope: "project", pattern: "x*y*z", problem: "multiple-wildcards" },
    ]);
  });

  test("reports unknown providers but exempts bundled and registered custom endpoints", () => {
    const direct = routingRuleProblems({
      globalRules: { "typo-*": ["typo-one", "together"] },
      localRules: {},
    });
    expect(direct.filter((problem) => problem.problem === "unknown-provider")).toEqual([
      {
        scope: "global",
        pattern: "typo-*",
        problem: "unknown-provider",
        entry: "typo-one",
      },
    ]);

    const sandbox = stage5SandboxResult();
    expect(sandbox.diag).toEqual([]);
    expect(sandbox.consoleErrors).toEqual([]);
    expect(sandbox.problems).toEqual([
      { scope: "global", pattern: "a**b", problem: "multiple-wildcards" },
      {
        scope: "global",
        pattern: "kimi-x",
        problem: "case-collision",
        collidesWith: "Kimi-X",
      },
      {
        scope: "global",
        pattern: "typo-*",
        problem: "unknown-provider",
        entry: "typo-one",
      },
      { scope: "project", pattern: "x*y*z", problem: "multiple-wildcards" },
    ]);
    expect(sandbox.problems.some((problem) => problem.entry === "sandbox-ep")).toBe(false);
    expect(sandbox.problems.some((problem) => problem.entry === "together")).toBe(false);
  });
});

test("no test leaves the keychain guard changed", () => {
  expect(process.env.CLAUDISH_DISABLE_KEYCHAIN).toBe(keychainGuardAtFileLoad);
});
