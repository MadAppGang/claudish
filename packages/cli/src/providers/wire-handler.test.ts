import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { DiskCacheV3 } from "./all-models-cache.js";
import { connectionRequestUrl, resolveConnection } from "./connection-resolver.js";
import { getProviderByName, toRemoteProvider } from "./provider-definitions.js";
import type { ProfileContext } from "./provider-profiles.js";
import { RefusingHandler, buildWireHandler, effectiveBaseUrl } from "./wire-handler.js";
import { TryInTurnHandler } from "./wire-try-in-turn.js";
const cachePath = new URL(
  "../test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json",
  import.meta.url
).pathname;
const fixture: DiskCacheV3 = JSON.parse(readFileSync(cachePath, "utf8"));
const realFetch = globalThis.fetch;
const dirs: string[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function context(
  provider: string,
  model: string,
  sharedOpts: ProfileContext["sharedOpts"] = {},
  path = cachePath
): ProfileContext {
  const def = getProviderByName(provider);
  return {
    provider: def
      ? toRemoteProvider(def)
      : { name: provider, baseUrl: "", apiPath: "", apiKeyEnvVar: "", prefixes: [] },
    modelName: model,
    targetModel: `${provider}@${model}`,
    apiKey: "sk-test-not-a-key",
    port: 0,
    catalogCachePath: path,
    sharedOpts,
  };
}
function request(over: Record<string, unknown> = {}) {
  return {
    model: "x",
    max_tokens: 32000,
    stream: true,
    messages: [{ role: "user", content: "Read README.md" }],
    tools: [
      {
        name: "Read",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    ...over,
  };
}
function temporary(cache: DiskCacheV3) {
  const dir = mkdtempSync(join(tmpdir(), "wire-handler-"));
  dirs.push(dir);
  const path = join(dir, "catalog.json");
  writeFileSync(path, JSON.stringify(cache));
  return path;
}
const cases = [
  {
    provider: "openai",
    model: "gpt-6.1-sol",
    url: "https://api.openai.com/v1/responses",
    expected: {
      max_output_tokens: 32000,
      reasoning: {
        effort: "high",
      },
    },
    absent: ["store", "include", "text", "reasoning_effort"],
    opts: {},
    req: {},
  },
  {
    provider: "openai",
    model: "gpt-6.1-sol",
    url: "https://api.openai.com/v1/responses",
    expected: {
      max_output_tokens: 32000,
      reasoning: {
        effort: "high",
        mode: "pro",
      },
      service_tier: "priority",
    },
    absent: ["store", "include", "text", "reasoning_effort"],
    opts: {
      wireMode: "pro",
      wireSpeed: "fast",
    },
    req: {},
  },
  {
    provider: "openai",
    model: "gpt-6.1-sol",
    url: "https://api.openai.com/v1/responses",
    expected: {
      reasoning: {
        effort: "low",
      },
      max_output_tokens: 32000,
    },
    absent: ["reasoning_effort"],
    opts: {},
    req: {
      output_config: {
        effort: "minimal",
      },
    },
  },
  {
    provider: "openrouter",
    model: "openai/gpt-6.1-sol",
    url: "https://openrouter.ai/api/v1/chat/completions",
    expected: {
      max_tokens: 32000,
      reasoning: {
        enabled: true,
        effort: "high",
      },
    },
    absent: [],
    opts: {},
    req: {},
  },
  {
    provider: "opencode-zen-go",
    model: "grok-4.7",
    url: "https://opencode.ai/zen/go/v1/responses",
    expected: {
      max_output_tokens: 32000,
      reasoning: {
        effort: "high",
      },
    },
    absent: [],
    opts: {},
    req: {},
  },
  {
    provider: "opencode-zen-go",
    model: "minimax-m3",
    url: "https://opencode.ai/zen/go/v1/messages",
    expected: {
      max_tokens: 32000,
    },
    absent: ["thinking"],
    opts: {},
    req: {},
  },
  {
    provider: "opencode-zen",
    model: "minimax-m3",
    url: "https://opencode.ai/zen/v1/chat/completions",
    expected: {
      max_completion_tokens: 32000,
      thinking: {
        type: "adaptive",
      },
    },
    absent: [],
    opts: {},
    req: {},
  },
  {
    provider: "z-ai",
    model: "glm-5.3",
    url: "https://api.z.ai/api/paas/v4/chat/completions",
    expected: {
      max_tokens: 32000,
      thinking: {
        type: "enabled",
      },
      reasoning_effort: "high",
    },
    absent: [],
    opts: {},
    req: {},
  },
  {
    provider: "kimi-coding",
    model: "k3",
    url: "https://api.kimi.ai/coding/v1/chat/completions",
    expected: {
      max_completion_tokens: 32000,
      reasoning_effort: "low",
    },
    absent: [],
    opts: {},
    req: {
      thinking: {
        type: "disabled",
      },
      output_config: null,
    },
  },
  {
    provider: "ollamacloud",
    model: "kimi-k3",
    url: "https://ollama.com/v1/chat/completions",
    expected: {
      max_tokens: 32000,
      reasoning_effort: "high",
    },
    absent: [],
    opts: {},
    req: {},
  },
  {
    provider: "qwen-token-plan",
    model: "qwen3.7-plus",
    url: "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1/chat/completions",
    expected: {
      max_completion_tokens: 32000,
      enable_thinking: true,
    },
    absent: [],
    opts: {},
    req: {},
  },
  {
    provider: "fireworks",
    model: "accounts/fireworks/models/qwen3p8-max",
    url: "https://api.fireworks.ai/inference/v1/chat/completions",
    expected: {
      max_tokens: 32000,
    },
    absent: ["reasoning", "reasoning_effort", "thinking", "enable_thinking"],
    opts: {},
    req: {},
  },
  {
    provider: "google",
    model: "gemini-3.8-flash",
    url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse",
    expected: {
      "generationConfig.maxOutputTokens": 32000,
    },
    absent: ["generationConfig.thinkingConfig", "thinkingConfig"],
    opts: {},
    req: {},
  },
  {
    provider: "anthropic",
    model: "claude-opus-5-5",
    url: "https://api.anthropic.com/v1/messages",
    expected: {
      max_tokens: 32000,
      "output_config.effort": "high",
      speed: "fast",
    },
    absent: ["thinking"],
    opts: {
      wireSpeed: "fast",
    },
    req: {},
  },
];

for (const [index, tc] of cases.entries())
  test(`capture ${index}: ${tc.provider}@${tc.model}`, async () => {
    const captures: Array<{ url: string; body: any; headers: Headers }> = [];
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      captures.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        headers: new Headers(init?.headers),
      });
      return new Response("capture complete", { status: 599 });
    }) as unknown as typeof fetch;
    const resolved = resolveConnection(tc.provider, tc.model, cachePath);
    if (!resolved.ok || resolved.connection.wire.status !== "known")
      throw new Error("fixture connection missing");
    expect(connectionRequestUrl(resolved.connection, resolved.connection.wire.api)).toBe(tc.url);
    const outcome = await buildWireHandler(
      context(tc.provider, tc.model, tc.opts as ProfileContext["sharedOpts"]),
      tc.provider
    );
    if (outcome.kind !== "handler") throw new Error(JSON.stringify(outcome));
    try {
      const app = new Hono();
      app.post("/", async (c) => outcome.handler.handle(c, await c.req.json()));
      await app.request("/", {
        method: "POST",
        body: JSON.stringify(request(tc.req)),
        headers: { "content-type": "application/json" },
      });
      expect(captures).toHaveLength(1);
      const capture = captures[0]!;
      expect(capture.url).toBe(tc.url);
      for (const [key, value] of Object.entries(tc.expected))
        expect(capture.body).toHaveProperty(key, value);
      for (const key of tc.absent) expect(capture.body).not.toHaveProperty(key);
      for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
        if (!(key in tc.expected)) expect(capture.body).not.toHaveProperty(key);
      }
      if (tc.provider.startsWith("opencode"))
        expect(capture.headers.get("x-opencode-session")).toBeTruthy();
      if (tc.provider === "opencode-zen-go" && tc.model === "minimax-m3") {
        expect(capture.headers.get("x-api-key")).toBe("sk-test-not-a-key");
        expect(capture.headers.get("anthropic-version")).toBe("2023-06-01");
      }
      if (tc.provider === "anthropic")
        expect(capture.headers.get("anthropic-beta")?.split(",")).toContain("fast-mode-2026-02-01");
      if (tc.provider === "ollamacloud") {
        expect(capture.body.model).toBe("kimi-k3");
        expect(capture.body.tools).toHaveLength(1);
      }
    } finally {
      await outcome.handler.shutdown();
    }
  });
test("xAI refuses fast with offered values before fetch", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("unexpected", { status: 599 });
  }) as unknown as typeof fetch;
  const outcome = await buildWireHandler(
    context("x-ai", "grok-4.7", { wireSpeed: "fast" }),
    "x-ai"
  );
  if (outcome.kind !== "handler") throw new Error("expected handler");
  try {
    const app = new Hono();
    app.post("/", (c) => outcome.handler.handle(c, request()));
    const response = await app.request("/", { method: "POST" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("standard, priority");
    expect(calls).toBe(0);
  } finally {
    await outcome.handler.shutdown();
  }
});
test("unsupported realtime wire refuses with its protocol", async () => {
  // No claudish provider binds realtime-websocket. Move only this connection's
  // binding to the token-plan test route so the real resolver can select it.
  const cache = structuredClone(fixture);
  const entry = cache.entries.find((e) => e.modelId === "qwen3.8-omni-flash-realtime")!;
  const connection = entry.aggregators!.find((c) => c.wire?.status === "unsupported")!;
  expect(connection.wire).toMatchObject({
    status: "unsupported",
    protocol: "dashscope-realtime-websocket",
  });
  connection.route = { routeId: "qwen", routeProfileId: "qwencloud-token-plan" };
  const path = temporary(cache);
  const resolved = resolveConnection("qwen-token-plan", entry.modelId, path);
  expect(resolved).toMatchObject({ ok: true, connection: { wire: connection.wire } });
  const result = await buildWireHandler(
    context("qwen-token-plan", entry.modelId, {}, path),
    "qwen-token-plan"
  );
  expect(result).toMatchObject({ kind: "refused" });
  if (result.kind !== "refused") throw new Error("expected refusal");
  expect(result.message).toContain("dashscope-realtime-websocket");
});
test("unknown mai wire builds TryInTurnHandler", async () => {
  expect(resolveConnection("openrouter", "mai-voice-2.1", cachePath)).toMatchObject({
    ok: true,
    connection: { wire: { status: "unknown" } },
  });
  const result = await buildWireHandler(context("openrouter", "mai-voice-2.1"), "openrouter");
  if (result.kind !== "handler") throw new Error("expected handler");
  expect(result.handler).toBeInstanceOf(TryInTurnHandler);
  await result.handler.shutdown();
});
test("provider with no route binding is not wire routed", async () => {
  expect(await buildWireHandler(context("ollama", "local-model"), "ollama")).toEqual({
    kind: "not-wire-routed",
  });
});
test("explicit cache without registry refuses without refreshing or fetching", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("unexpected", { status: 599 });
  }) as unknown as typeof fetch;
  const cache = structuredClone(fixture);
  delete cache.routeRegistry;
  const result = await buildWireHandler(
    context("openai", "gpt-6.1-sol", {}, temporary(cache)),
    "openai"
  );
  expect(result.kind).toBe("refused");
  if (result.kind !== "refused") throw new Error("expected refusal");
  expect(result.message).toContain("route registry");
  expect(calls).toBe(0);
});
test.each([
  [undefined, { baseUrl: "https://registry.test/anthropic/v1", overridden: false }],
  [
    "https://definition.test/v1",
    { baseUrl: "https://registry.test/anthropic/v1", overridden: false },
  ],
  ["https://override.test", { baseUrl: "https://override.test/anthropic/v1", overridden: true }],
  ["https://override.test/custom/", { baseUrl: "https://override.test/custom", overridden: true }],
] as const)("effective base URL %s", (override, expected) =>
  expect(
    effectiveBaseUrl("https://registry.test/anthropic/v1", "https://definition.test/v1", override)
  ).toEqual(expected)
);
test("RefusingHandler returns 400 and supplied message", async () => {
  const response = await new RefusingHandler("unsupported protocol").handle();
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    type: "error",
    error: { type: "invalid_request_error", message: "claudish: unsupported protocol" },
  });
});
