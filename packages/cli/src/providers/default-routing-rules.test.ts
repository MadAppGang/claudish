/**
 * Unit tests for providers/default-routing-rules.ts
 *
 * Verifies that the shipped DEFAULT_ROUTING_RULES table:
 *   - matches the patterns the migration plan §B.1 documents,
 *   - feeds correctly through matchRoutingRule + buildRoutingChain,
 *   - validates cleanly against provider-definitions.ts.
 *
 * These tests do not touch the disk or env — pure data assertions.
 *
 * Run: bun test packages/cli/src/providers/default-routing-rules.test.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DiskCacheV2, writeAllModelsCache } from "./all-models-cache.js";
import {
  DEFAULT_ROUTING_RULES,
  validateDefaultRoutingRules,
  validateRoutingRulesAgainstProviders,
} from "./default-routing-rules.js";
import { buildRoutingChain, matchRoutingRule } from "./routing-rules.js";

function makeTempCatalog(
  model: {
    modelId: string;
    externalId?: string;
    subscriptionPlans?: string[];
  },
  /** Plan names to mark as active subscription plans in the catalog (defaults to the model's own plans). */
  plans: string[] = model.subscriptionPlans ?? []
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
        ? model.subscriptionPlans.map((provider) => ({
            provider,
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
  };
  writeAllModelsCache(cache, path);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Pattern matching against the shipped rules
// ---------------------------------------------------------------------------

describe("DEFAULT_ROUTING_RULES pattern matching", () => {
  test("'claude-opus-4-7' matches claude-* → [native-anthropic, openrouter]", () => {
    const matched = matchRoutingRule("claude-opus-4-7", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["native-anthropic", "openrouter"]);
  });

  test("'gpt-5' matches gpt-* → [openai-codex, openai, openrouter]", () => {
    const matched = matchRoutingRule("gpt-5", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["openai-codex", "openai", "openrouter"]);
  });

  test("'o1-mini' matches o1-* → [openai-codex, openai, openrouter]", () => {
    const matched = matchRoutingRule("o1-mini", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["openai-codex", "openai", "openrouter"]);
  });

  test("'o3-pro' matches o3-* → [openai-codex, openai, openrouter]", () => {
    const matched = matchRoutingRule("o3-pro", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["openai-codex", "openai", "openrouter"]);
  });

  test("'gemini-2.0-flash' matches gemini-* → [antigravity, google, openrouter]", () => {
    const matched = matchRoutingRule("gemini-2.0-flash", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["antigravity", "google", "openrouter"]);
  });

  test("'grok-4' matches grok-* → [x-ai, openrouter]", () => {
    const matched = matchRoutingRule("grok-4", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["x-ai", "openrouter"]);
  });

  test("'kimi-k2.5' matches kimi-* → [kimi-coding, opencode-zen-go, kimi, openrouter] (no pinned model)", () => {
    const matched = matchRoutingRule("kimi-k2.5", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["kimi-coding", "opencode-zen-go", "kimi", "openrouter"]);
  });

  test("kimi-coding candidate drops when model is not in its subscription plan", () => {
    const { path, cleanup } = makeTempCatalog(
      {
        modelId: "kimi-k2.5",
        // kimi-k2.5 is not part of the kimi-coding subscription plan in this
        // catalog snapshot, so the subscription candidate is dropped rather than
        // being silently answered by a different model.
      },
      ["kimi-coding"]
    );
    try {
      const matched = matchRoutingRule("kimi-k2.5", DEFAULT_ROUTING_RULES);
      expect(matched).not.toBeNull();
      const routes = buildRoutingChain(matched!, "kimi-k2.5", path);
      expect(routes).toHaveLength(3);
      // kimi-coding is dropped because the plan doesn't serve this model
      expect(routes.map((route) => route.provider)).not.toContain("kimi-coding");
      expect(routes[0].provider).toBe("opencode-zen-go");
      expect(routes[0].modelSpec).toBe("zengo@kimi-k2.5");
      expect(routes[1].provider).toBe("kimi");
      expect(routes[1].modelSpec).toBe("kimi@kimi-k2.5");
      expect(routes[2].provider).toBe("openrouter");
    } finally {
      cleanup();
    }
  });

  test("kimi-coding candidate translates K3 to the plan's wire id", () => {
    const { path, cleanup } = makeTempCatalog(
      {
        modelId: "kimi-k3",
        externalId: "k3",
        subscriptionPlans: ["kimi-coding"],
      },
      ["kimi-coding"]
    );
    try {
      const matched = matchRoutingRule("kimi-k3", DEFAULT_ROUTING_RULES);
      expect(matched).not.toBeNull();
      const routes = buildRoutingChain(matched!, "kimi-k3", path);
      expect(routes).toHaveLength(4);
      // catalog translates the subscription model to its wire id
      expect(routes[0].provider).toBe("kimi-coding");
      expect(routes[0].modelSpec).toBe("kc@k3");
      expect(routes[1].provider).toBe("opencode-zen-go");
      expect(routes[1].modelSpec).toBe("zengo@kimi-k3");
      expect(routes[2].provider).toBe("kimi");
      expect(routes[2].modelSpec).toBe("kimi@kimi-k3");
    } finally {
      cleanup();
    }
  });

  test("k3 bare name matches k3* rule and uses the plan wire id", () => {
    const { path, cleanup } = makeTempCatalog(
      {
        modelId: "kimi-k3",
        externalId: "k3",
        subscriptionPlans: ["kimi-coding"],
      },
      ["kimi-coding"]
    );
    try {
      // bare `k3` doesn't match `kimi-*`, so the dedicated `k3*` rule handles it
      const matched = matchRoutingRule("k3", DEFAULT_ROUTING_RULES);
      expect(matched).toEqual(["kimi-coding", "opencode-zen-go", "kimi", "openrouter"]);
      const routes = buildRoutingChain(matched!, "k3", path);
      expect(routes).toHaveLength(4);
      expect(routes[0].provider).toBe("kimi-coding");
      expect(routes[0].modelSpec).toBe("kc@k3");
      expect(routes[1].provider).toBe("opencode-zen-go");
      expect(routes[1].modelSpec).toBe("zengo@k3");
      expect(routes[2].provider).toBe("kimi");
      expect(routes[2].modelSpec).toBe("kimi@k3");
    } finally {
      cleanup();
    }
  });

  test("'minimax-m2.5' matches minimax-* → [minimax-coding, opencode-zen-go, minimax, openrouter]", () => {
    const matched = matchRoutingRule("minimax-m2.5", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["minimax-coding", "opencode-zen-go", "minimax", "openrouter"]);
  });

  // Case-insensitive matching: docs use mixed casing (`MiniMax-M2.5`,
  // `GPT-4o`); the rule keys are lowercase but matchRoutingRule lowers both
  // sides before comparing.
  test("'MiniMax-M2.5' matches minimax-* (case-insensitive) → [minimax-coding, opencode-zen-go, minimax, openrouter]", () => {
    const matched = matchRoutingRule("MiniMax-M2.5", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["minimax-coding", "opencode-zen-go", "minimax", "openrouter"]);
  });

  test("'GPT-4o' matches gpt-* (case-insensitive) → [openai-codex, openai, openrouter]", () => {
    const matched = matchRoutingRule("GPT-4o", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["openai-codex", "openai", "openrouter"]);
  });

  test("'Gemini-2.5-Pro' matches gemini-* (case-insensitive) → [antigravity, google, openrouter]", () => {
    const matched = matchRoutingRule("Gemini-2.5-Pro", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["antigravity", "google", "openrouter"]);
  });

  test("'glm-4.6' matches glm-* → [glm-coding, opencode-zen-go, glm, openrouter]", () => {
    const matched = matchRoutingRule("glm-4.6", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["glm-coding", "opencode-zen-go", "glm", "openrouter"]);
  });

  test("'qwen3.7-plus' matches qwen3.* → [qwen-cloud, opencode-zen-go, openrouter]", () => {
    const matched = matchRoutingRule("qwen3.7-plus", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["qwen-cloud", "opencode-zen-go", "openrouter"]);
  });

  test("'qwen3-coder-next' does not match the dotted Qwen Plan rule", () => {
    const matched = matchRoutingRule("qwen3-coder-next", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["openrouter"]);
    expect(matched).not.toContain("qwen-cloud");
  });

  test("cross-vendor default chains never include qwen-cloud", () => {
    for (const model of ["glm-4.6", "glm-5.2", "deepseek-v4-pro"]) {
      const matched = matchRoutingRule(model, DEFAULT_ROUTING_RULES);
      expect(matched).not.toBeNull();
      expect(matched!).not.toContain("qwen-cloud");
    }
  });

  test("'z-ai-glm-4.6' matches z-ai-* → [z-ai, openrouter]", () => {
    const matched = matchRoutingRule("z-ai-glm-4.6", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["z-ai", "openrouter"]);
  });

  test("'deepseek-v3.5' matches deepseek-* → [opencode-zen-go, deepseek, openrouter]", () => {
    const matched = matchRoutingRule("deepseek-v3.5", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["opencode-zen-go", "deepseek", "openrouter"]);
  });

  test("'mimo-v2-pro' matches mimo-* → [opencode-zen-go, openrouter]", () => {
    const matched = matchRoutingRule("mimo-v2-pro", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["opencode-zen-go", "openrouter"]);
  });

  test("hy3* matches both 'hy3' and 'hy3-preview' → [opencode-zen-go, openrouter]", () => {
    expect(matchRoutingRule("hy3", DEFAULT_ROUTING_RULES)).toEqual([
      "opencode-zen-go",
      "openrouter",
    ]);
    expect(matchRoutingRule("hy3-preview", DEFAULT_ROUTING_RULES)).toEqual([
      "opencode-zen-go",
      "openrouter",
    ]);
  });

  test("gpt-* and grok-* deliberately exclude opencode-zen-go", () => {
    for (const model of ["gpt-5", "grok-4"]) {
      const matched = matchRoutingRule(model, DEFAULT_ROUTING_RULES);
      expect(matched).not.toBeNull();
      expect(matched!).not.toContain("opencode-zen-go");
    }
  });

  test("'fugu' matches the exact fugu rule → [sakana-subscription, sakana] (no openrouter)", () => {
    const matched = matchRoutingRule("fugu", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["sakana-subscription", "sakana"]);
  });

  test("'fugu-ultra' matches fugu-* → [sakana-subscription, sakana] (no openrouter)", () => {
    const matched = matchRoutingRule("fugu-ultra", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["sakana-subscription", "sakana"]);
  });

  test("'something-zen' matches *-zen → [opencode-zen]", () => {
    const matched = matchRoutingRule("something-zen", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["opencode-zen"]);
  });

  test("'random-unknown-model' falls through to '*' → [openrouter]", () => {
    const matched = matchRoutingRule("random-unknown-model", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["openrouter"]);
  });
});

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

describe("validateDefaultRoutingRules", () => {
  test("does NOT throw with the shipped rules", () => {
    expect(() => validateDefaultRoutingRules()).not.toThrow();
  });

  test("throws when a rule references an unknown provider", () => {
    expect(() =>
      validateRoutingRulesAgainstProviders({
        "fake-*": ["totally-not-a-real-provider"],
      })
    ).toThrow(/unknown providers/);
  });

  test("throws and lists all unknown providers when multiple typos exist", () => {
    let err: Error | null = null;
    try {
      validateRoutingRulesAgainstProviders({
        "a-*": ["typo-one"],
        "b-*": ["typo-two", "openrouter"],
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("typo-one");
    expect(err!.message).toContain("typo-two");
    // Real provider should not appear in the error
    expect(err!.message).not.toContain('→ unknown provider "openrouter"');
  });

  test("accepts provider@model rewrite syntax — only validates the provider portion", () => {
    expect(() =>
      validateRoutingRulesAgainstProviders({
        "kimi-*": ["kimi-coding@whatever-model-name", "kimi"],
      })
    ).not.toThrow();
  });

  test("accepts provider shortcuts (e.g. 'or' resolves to 'openrouter')", () => {
    expect(() =>
      validateRoutingRulesAgainstProviders({
        "*": ["or"],
      })
    ).not.toThrow();
  });

  test("rejects a typo in the provider portion of a provider@model rewrite", () => {
    expect(() =>
      validateRoutingRulesAgainstProviders({
        "kimi-*": ["typo-coding@kimi-for-coding"],
      })
    ).toThrow(/typo-coding/);
  });
});

// ---------------------------------------------------------------------------
// Shape of the rules table
// ---------------------------------------------------------------------------
