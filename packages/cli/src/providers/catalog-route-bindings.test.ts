import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DiskCacheV3, writeAllModelsCache } from "./all-models-cache.js";
import { resolveExternalId } from "./catalog-client.js";
import { catalogRouteForProvider, providerForCatalogRoute } from "./catalog-route-bindings.js";

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
