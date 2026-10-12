import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DiskCacheV3,
  _clearAllModelsCacheMemo,
  writeAllModelsCache,
} from "./all-models-cache.js";
import {
  connectionBaseUrl,
  connectionRequestUrl,
  resolveConnection,
} from "./connection-resolver.js";
import type { KnownWire, WireApi } from "./connection-wire.js";

const fixture: DiskCacheV3 = JSON.parse(
  readFileSync(
    new URL("../test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json", import.meta.url),
    "utf8"
  )
);
let dir: string;
let cachePath: string;
beforeEach(() => {
  _clearAllModelsCacheMemo();
  dir = mkdtempSync(join(tmpdir(), "claudish-wire-resolver-"));
  cachePath = join(dir, "catalog.json");
  writeAllModelsCache(structuredClone(fixture), cachePath);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  _clearAllModelsCacheMemo();
});

type Case = [string, string, string, string, string, WireApi, KnownWire["tokenParam"], string];
const cases: Case[] = [
  [
    "openai",
    "gpt-6.1-sol",
    "gpt-6.1-sol",
    "openai/direct-api",
    "gpt-6.1-sol",
    "responses",
    "max_output_tokens",
    "https://api.openai.com/v1/responses",
  ],
  [
    "openai-codex",
    "gpt-6-sol",
    "gpt-6-sol",
    "openai/codex-subscription",
    "gpt-6-sol",
    "responses",
    "max_output_tokens",
    "https://chatgpt.com/backend-api/codex/responses",
  ],
  [
    "openrouter",
    "openai/gpt-6.1-sol",
    "gpt-6.1-sol",
    "openrouter/gateway",
    "openai/gpt-6.1-sol",
    "chat-completions",
    "max_tokens",
    "https://openrouter.ai/api/v1/chat/completions",
  ],
  [
    "openrouter",
    "gpt-6.1-sol",
    "gpt-6.1-sol",
    "openrouter/gateway",
    "openai/gpt-6.1-sol",
    "chat-completions",
    "max_tokens",
    "https://openrouter.ai/api/v1/chat/completions",
  ],
  [
    "opencode-zen-go",
    "grok-4.7",
    "grok-4.7",
    "opencode/go-subscription",
    "grok-4.7",
    "responses",
    "max_output_tokens",
    "https://opencode.ai/zen/go/v1/responses",
  ],
  [
    "opencode-zen-go",
    "minimax-m3",
    "minimax-m3",
    "opencode/go-subscription",
    "minimax-m3",
    "anthropic-messages",
    "max_tokens",
    "https://opencode.ai/zen/go/v1/messages",
  ],
  [
    "opencode-zen",
    "minimax-m3",
    "minimax-m3",
    "opencode/zen",
    "minimax-m3",
    "chat-completions",
    { status: "unknown" },
    "https://opencode.ai/zen/v1/chat/completions",
  ],
  [
    "x-ai",
    "grok-4.7",
    "grok-4.7",
    "x-ai/direct-api",
    "grok-4.7",
    "responses",
    "max_output_tokens",
    "https://api.x.ai/v1/responses",
  ],
  [
    "z-ai",
    "glm-5.3",
    "glm-5.3",
    "z-ai/direct-api",
    "glm-5.3",
    "chat-completions",
    "max_tokens",
    "https://api.z.ai/api/paas/v4/chat/completions",
  ],
  [
    "kimi-coding",
    "k3",
    "kimi-k3",
    "moonshotai/kimi-code-subscription",
    "k3",
    "chat-completions",
    "max_completion_tokens",
    "https://api.kimi.ai/coding/v1/chat/completions",
  ],
  [
    "kimi-coding",
    "kimi-k3",
    "kimi-k3",
    "moonshotai/kimi-code-subscription",
    "k3",
    "chat-completions",
    "max_completion_tokens",
    "https://api.kimi.ai/coding/v1/chat/completions",
  ],
  [
    "ollamacloud",
    "kimi-k3",
    "kimi-k3",
    "ollama/cloud",
    "kimi-k3",
    "chat-completions",
    "max_tokens",
    "https://ollama.com/v1/chat/completions",
  ],
  [
    "qwen-token-plan",
    "qwen3.7-plus",
    "qwen3.7-plus",
    "qwen/qwencloud-token-plan",
    "qwen3.7-plus",
    "chat-completions",
    "max_completion_tokens",
    "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1/chat/completions",
  ],
  [
    "fireworks",
    "qwen3.8-max",
    "qwen3.8-max",
    "fireworks/gateway",
    "accounts/fireworks/models/qwen3p8-max",
    "chat-completions",
    "max_tokens",
    "https://api.fireworks.ai/inference/v1/chat/completions",
  ],
  [
    "google",
    "gemini-3.8-flash",
    "gemini-3.8-flash",
    "google/direct-api",
    "gemini-3.8-flash",
    "gemini",
    { status: "not_applicable" },
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse",
  ],
  [
    "anthropic",
    "claude-opus-5-5",
    "claude-opus-5-5",
    "anthropic/direct-api",
    "claude-opus-5-5",
    "anthropic-messages",
    "max_tokens",
    "https://api.anthropic.com/v1/messages",
  ],
];

describe("production connection resolution", () => {
  for (const [provider, name, modelId, binding, externalModelId, api, tokenParam, url] of cases) {
    test(`${provider}@${name} retains its published wire and exact route binding`, () => {
      const [routeId, routeProfileId] = binding.split("/");
      const record = fixture.entries.find((entry) => entry.modelId === modelId)!;
      const published = record.aggregators!.find(
        (connection) =>
          connection.routeStatus === "mapped" &&
          connection.route?.routeId === routeId &&
          connection.route.routeProfileId === routeProfileId &&
          connection.externalModelId === externalModelId
      )!;
      expect(published.wire).toMatchObject({ status: "known", api, tokenParam });
      const result = resolveConnection(provider, name, cachePath);
      // Independently derive the owner's first direct connection from registry
      // ownership, excluding the selected connection itself.
      const owner = record.aggregators!.find((candidate) => {
        if (candidate === published || candidate.routeStatus !== "mapped" || !candidate.route)
          return false;
        const profile =
          fixture.routeRegistry!.registry.routes[candidate.route.routeId]?.profiles[
            candidate.route.routeProfileId
          ];
        return (
          profile?.kind === "direct" &&
          profile.nativeModelProviders?.includes(record.provider ?? "")
        );
      });
      expect(result).toEqual({
        ok: true,
        connection: {
          provider,
          vendor: record.provider,
          modelId,
          route: { routeId, routeProfileId },
          externalModelId,
          wire: published.wire!,
          profile: fixture.routeRegistry!.registry.routes[routeId!]!.profiles[routeProfileId!],
          generationId: fixture.catalogGenerationId,
          ...(owner?.wire?.status === "known" ? { ownerWire: owner.wire } : {}),
        },
      });
      if (result.ok === false) throw new Error("Expected resolved fixture connection");
      expect(connectionRequestUrl(result.connection, api)).toBe(url);
      const base =
        api === "gemini"
          ? url.split("/models/")[0]
          : url.replace(/\/(responses|messages|chat\/completions)$/, "");
      expect(connectionBaseUrl(result.connection, api)).toBe(base);
    });
  }
  test.each([
    ["grok-subscription", "grok-4.7", "no-connection"],
    ["ollama", "llama3.2", "not-catalog-routed"],
    ["openai", "no-such-model", "no-connection"],
  ] as const)("%s@%s reports %s", (provider, model, reason) => {
    expect(resolveConnection(provider, model, cachePath)).toEqual({ ok: false, reason });
  });
  test("missing cache reports no-catalog", () => {
    expect(resolveConnection("openai", "gpt-6.1-sol", join(dir, "missing.json"))).toEqual({
      ok: false,
      reason: "no-catalog",
    });
  });
  test("legacy cache reports no-registry", () => {
    const cache = structuredClone(fixture);
    delete cache.routeRegistry;
    writeAllModelsCache(cache, cachePath);
    expect(resolveConnection("openai", "gpt-6.1-sol", cachePath)).toEqual({
      ok: false,
      reason: "no-registry",
    });
  });
  test.each(["GPT-6.1-SOL", "vendor/GPT-6.1-SOL", "OPENAI/GPT-6.1-SOL:BATCH"])(
    "resolves canonical ids and aliases case-insensitively: %s",
    (name) => {
      expect(resolveConnection("openai", name, cachePath)).toEqual(
        resolveConnection("openai", "gpt-6.1-sol", cachePath)
      );
    }
  );
  test("an exact wire id wins over an earlier canonical id match", () => {
    const cache = structuredClone(fixture);
    const first = cache.entries.find((entry) => entry.modelId === "gpt-6.1-sol")!;
    // This earlier record's canonical id collides with a later record's wire id.
    first.modelId = "gpt-6-sol";
    cache.entries.find((entry) => entry !== first && entry.modelId === "gpt-6-sol")!.modelId =
      "wire-match-record";
    writeAllModelsCache(cache, cachePath);
    const result = resolveConnection("openai", "gpt-6-sol", cachePath);
    expect(result).toMatchObject({
      ok: true,
      connection: {
        modelId: "wire-match-record",
        externalModelId: "gpt-6-sol",
      },
    });
  });
  test.each(["~vendor/x-latest", "x-latest"])(
    "skips leading moving pointer %s for canonical lookup",
    (pointer) => {
      const cache = structuredClone(fixture);
      const record = cache.entries.find((entry) => entry.modelId === "kimi-k3")!;
      const exact = record.aggregators!.find(
        (connection) => connection.route?.routeProfileId === "kimi-code-subscription"
      )!;
      record.aggregators!.unshift({ ...structuredClone(exact), externalModelId: pointer });
      writeAllModelsCache(cache, cachePath);
      expect(resolveConnection("kimi-coding", "kimi-k3", cachePath)).toMatchObject({
        ok: true,
        connection: { modelId: "kimi-k3", externalModelId: "k3" },
      });
      const requested = resolveConnection("kimi-coding", pointer, cachePath);
      expect(requested).toMatchObject({ ok: true, connection: { externalModelId: pointer } });
      record.modelId = "canonical-latest";
      writeAllModelsCache(cache, cachePath);
      expect(resolveConnection("kimi-coding", "canonical-latest", cachePath)).toMatchObject({
        ok: true,
        connection: { externalModelId: pointer },
      });
    }
  );
  test("URL helpers preserve non-streaming Gemini and absent APIs", () => {
    const result = resolveConnection("google", "gemini-3.8-flash", cachePath);
    if (result.ok === false) throw new Error("Expected Gemini fixture connection");
    expect(connectionRequestUrl(result.connection, "gemini", false)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent"
    );
    expect(connectionBaseUrl(result.connection, "responses")).toBeUndefined();
    expect(connectionRequestUrl(result.connection, "responses")).toBeUndefined();
  });
});
