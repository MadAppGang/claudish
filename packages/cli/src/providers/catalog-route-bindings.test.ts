import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DiskCacheV3, writeAllModelsCache } from "./all-models-cache.js";
import { resolveExternalId } from "./catalog-client.js";
import {
  CATALOG_ROUTE_BINDINGS,
  LOOKUP_ONLY_ROUTE_BINDINGS,
  catalogRouteForProvider,
  catalogRouteMatchesProvider,
  providerForCatalogRoute,
  routingProvidersForRoute,
} from "./catalog-route-bindings.js";
import { PREDEFINED_ENDPOINTS } from "./predefined-catalog.js";
import { BUILTIN_PROVIDERS } from "./provider-definitions.js";

const subscriptionBindings = [
  ["native-anthropic", "anthropic", "claude-code-subscription"],
  ["openai-codex", "openai", "codex-subscription"],
  ["kimi-coding", "moonshotai", "kimi-code-subscription"],
  ["glm-coding", "z-ai", "glm-coding-subscription"],
  ["grok-subscription", "x-ai", "supergrok-subscription"],
  ["minimax-coding", "minimax", "coding-plan-subscription"],
  ["sakana-subscription", "sakana", "fugu-subscription"],
  ["devin", "cognition", "devin-subscription"],
  ["antigravity", "google", "antigravity-subscription"],
  ["qwen-coding", "qwen", "modelstudio-coding-plan"],
  ["qwen-token-plan", "qwen", "qwencloud-token-plan"],
  ["opencode-zen-go", "opencode", "go-subscription"],
  ["ollamacloud", "ollama", "cloud"],
  // REGRESSION: MTL-189 muse-wonder-full has no route; meta/muse-code-subscription unbound — Fixed in /dev:fix session dev-fix-20261021-223935-f1801ee6
  ["meta-muse-code", "meta", "muse-code-subscription"],
] as const;

const gatewayBindings = [
  ["openrouter", "openrouter", "gateway"],
  ["together", "together-ai", "gateway"],
  ["fireworks", "fireworks", "gateway"],
  ["poe", "poe", "gateway"],
  ["vertex", "vertex", "google-cloud"],
] as const;

describe("v3 route bindings", () => {
  for (const [provider, routeId, routeProfileId] of [...subscriptionBindings, ...gatewayBindings]) {
    test(`${provider} executes only ${routeId}/${routeProfileId}`, () => {
      const route = { routeId, routeProfileId };
      expect(catalogRouteForProvider(provider)).toEqual(route);
      expect(providerForCatalogRoute(route)).toBe(provider);
    });
  }

  test("the three Alibaba products have isolated route profiles", () => {
    expect(catalogRouteForProvider("qwen-payg")).toEqual({
      routeId: "qwen",
      routeProfileId: "dashscope-direct",
    });
    expect(
      providerForCatalogRoute({ routeId: "qwen", routeProfileId: "unrecognised" })
    ).toBeUndefined();
  });

  test("lookup-only names are exact, non-routable names", () => {
    const lookupNames = Object.keys(LOOKUP_ONLY_ROUTE_BINDINGS);
    const providerNames = new Set([
      ...BUILTIN_PROVIDERS.map((provider) => provider.name),
      ...PREDEFINED_ENDPOINTS.map((endpoint) => endpoint.name),
    ]);

    expect(lookupNames).toEqual(["anthropic", "moonshotai", "zen"]);
    expect(lookupNames.filter((name) => providerNames.has(name))).toEqual([]);
    expect(lookupNames.filter((name) => name in CATALOG_ROUTE_BINDINGS)).toEqual([]);
  });

  test("catalog reads retain literal lookup routes without creating route candidates", () => {
    expect(catalogRouteForProvider("anthropic")).toEqual({
      routeId: "anthropic",
      routeProfileId: "direct-api",
    });
    expect(catalogRouteForProvider("moonshotai")).toEqual({
      routeId: "moonshotai",
      routeProfileId: "direct-api",
    });
    expect(catalogRouteForProvider("zen")).toEqual({
      routeId: "opencode",
      routeProfileId: "zen",
    });

    expect(
      catalogRouteMatchesProvider(
        { routeId: "anthropic", routeProfileId: "direct-api" },
        "anthropic"
      )
    ).toBe(true);
    expect(
      catalogRouteMatchesProvider(
        { routeId: "anthropic", routeProfileId: "claude-code-subscription" },
        "anthropic"
      )
    ).toBe(false);

    expect(
      routingProvidersForRoute({ routeId: "anthropic", routeProfileId: "direct-api" })
    ).toEqual([]);
    expect(
      routingProvidersForRoute({ routeId: "moonshotai", routeProfileId: "direct-api" })
    ).toEqual(["kimi"]);
    expect(routingProvidersForRoute({ routeId: "opencode", routeProfileId: "zen" })).toEqual([
      "opencode-zen",
    ]);
  });
});

const translations = [
  ["ollamacloud", "ollama", "cloud", "deepseek-v4.1-flash", "deepseek-v4.1-flash:cloud"],
  ["minimax", "minimax", "direct-api", "minimax-m3", "MiniMax-M3"],
  ["opencode-zen", "opencode", "zen", "gpt-6-astra", "gpt-6-astra"],
  ["anthropic", "anthropic", "direct-api", "claude-opus-5", "claude-opus-5"],
  ["x-ai", "x-ai", "direct-api", "grok-4.6", "grok-4.6"],
  ["deepseek", "deepseek", "direct-api", "deepseek-v4.1-flash", "deepseek-flash"],
  ["openrouter", "openrouter", "gateway", "minimax-m3", "minimax/minimax-m3"],
  ["together", "together-ai", "gateway", "minimax-m3", "minimaxai/MiniMax-M3"],
  ["fireworks", "fireworks", "gateway", "minimax-m3", "accounts/fireworks/models/minimax-m3"],
  ["poe", "poe", "gateway", "minimax-m3", "MiniMax-M3"],
  ["vertex", "vertex", "google-cloud", "minimax-m3", "publishers/custom/models/minimax-m3"],
  ["qwen-coding", "qwen", "modelstudio-coding-plan", "qwen3.7-plus", "coding-wire"],
  ["qwen-token-plan", "qwen", "qwencloud-token-plan", "qwen3.7-plus", "token-wire"],
  ["qwen-payg", "qwen", "dashscope-direct", "qwen3.7-plus", "payg-wire"],
] as const;

describe("exact route wire IDs", () => {
  const dir = mkdtempSync(join(tmpdir(), "claudish-route-v3-"));
  const path = join(dir, "all-models.json");
  const entries = [...new Set(translations.map((row) => row[3]))].map((modelId) => ({
    modelId,
    aliases: [],
    aggregators: translations
      .filter((row) => row[3] === modelId)
      .map(([, routeId, routeProfileId, , externalModelId]) => ({
        sourceProviderId: routeId,
        sourceCollectorId: "fixture",
        confidence: "api_official" as const,
        routeStatus: "mapped" as const,
        route: { routeId, routeProfileId },
        externalModelId,
      })),
  }));
  const cache: DiskCacheV3 = {
    version: 3,
    catalogGenerationId: "fixture-generation",
    lastUpdated: new Date().toISOString(),
    entries,
    models: [],
    plans: [],
  };
  writeAllModelsCache(cache, path);

  for (const [provider, , , modelId, externalModelId] of translations) {
    test(`${provider} sends ${externalModelId} for ${modelId}`, () => {
      expect(resolveExternalId(modelId, provider, path)).toBe(externalModelId);
    });
  }
  test("a sibling Alibaba wire ID cannot stand in for a missing route", () => {
    expect(resolveExternalId("qwen3.7-plus", "opencode-zen-go", path)).toBeNull();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});
