import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";
import type { DiskCacheV3 } from "../providers/all-models-cache.js";
import { resolveConnection } from "../providers/connection-resolver.js";
import { getProviderByName, toRemoteProvider } from "../providers/provider-definitions.js";
import type { ProfileContext } from "../providers/provider-profiles.js";
import { OpenAIProviderTransport } from "../providers/transport/openai.js";
import { buildKnownWireHandler } from "../providers/wire-handler.js";
import { wireMarkerContext } from "../providers/wire-markers.js";
import { ComposedHandler } from "./composed-handler.js";
import type { ModelHandler } from "./types.js";
const cachePath = new URL(
  "../test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json",
  import.meta.url
).pathname;
const realFetch = globalThis.fetch;
const handlers: ModelHandler[] = [];
const dirs: string[] = [];
afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const handler of handlers.splice(0)) await handler.shutdown();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function context(
  provider: string,
  model: string,
  sharedOpts: ProfileContext["sharedOpts"] = {}
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
    catalogCachePath: cachePath,
    sharedOpts,
  };
}
function resolved(provider: string, model: string, path = cachePath) {
  const r = resolveConnection(provider, model, path);
  if (!r.ok || r.connection.wire.status !== "known") throw new Error("missing fixture");
  return { ...structuredClone(r.connection), wire: structuredClone(r.connection.wire) };
}
function request(handler: ModelHandler) {
  const app = new Hono();
  app.post("/", (c) =>
    handler.handle(c, {
      model: "x",
      stream: true,
      max_tokens: 32000,
      messages: [{ role: "user", content: "hello" }],
      output_config: { effort: "high" },
    })
  );
  return app.request("/", { method: "POST" });
}
function capture(error: string) {
  const calls: Array<{ body: any; headers: Headers }> = [];
  globalThis.fetch = (async (_url, init) => {
    calls.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    // Returning the same rejection again proves recovery is attempted only once.
    return new Response(JSON.stringify({ error: { message: error } }), { status: 400 });
  }) as typeof fetch;
  return calls;
}
test("borrowed field rejection retries exactly once and preserves other decisions", async () => {
  const c = resolved("opencode-zen", "minimax-m3");
  const handler = buildKnownWireHandler(
    context("opencode-zen", "minimax-m3"),
    "opencode-zen",
    c,
    c.wire
  )!;
  handlers.push(handler);
  const calls = capture("Unsupported parameter: 'max_completion_tokens'");
  await request(handler);
  expect(calls).toHaveLength(2);
  expect(calls[0]!.body.max_completion_tokens).toBe(32000);
  expect(calls[1]!.body).not.toHaveProperty("max_completion_tokens");
  expect(calls[1]!.body.thinking).toEqual({ type: "adaptive" });
  const first = structuredClone(calls[0]!.body);
  delete first.max_completion_tokens;
  expect(calls[1]!.body).toEqual(first);
});
test("wire beta header survives parameter recovery header refresh", async () => {
  const original = resolved("anthropic", "claude-opus-5-5");
  // One unknown sub-field enables borrowing; all encodings and headers remain
  // those of the real fixture. Pass its original wire as the owner test seam.
  const cache: DiskCacheV3 = JSON.parse(readFileSync(cachePath, "utf8"));
  const published = cache.entries
    .find((e) => e.modelId === original.modelId)!
    .aggregators!.find(
      (c) => c.route?.routeId === "anthropic" && c.route.routeProfileId === "direct-api"
    )!;
  if (published.wire?.status !== "known") throw new Error("missing fixture wire");
  published.wire.tokenParam = { status: "unknown" };
  const dir = mkdtempSync(join(tmpdir(), "composed-wire-"));
  dirs.push(dir);
  const path = join(dir, "catalog.json");
  writeFileSync(path, JSON.stringify(cache));
  const c = resolved("anthropic", "claude-opus-5-5", path);
  c.ownerWire = original.wire;
  const handler = buildKnownWireHandler(
    context("anthropic", "claude-opus-5-5", { wireSpeed: "fast" }),
    "anthropic",
    c,
    c.wire
  )!;
  handlers.push(handler);
  const calls = capture("Unsupported parameter: 'max_tokens'");
  await request(handler);
  expect(calls).toHaveLength(2);
  expect(calls[0]!.body.max_tokens).toBe(32000);
  expect(calls[1]!.body).not.toHaveProperty("max_tokens");
  for (const call of calls) {
    expect(call.headers.get("anthropic-beta")?.split(",")).toContain("fast-mode-2026-02-01");
    expect(call.body.speed).toBe("fast");
    expect(call.body.output_config.effort).toBe("high");
  }
});
test("marker without connection refuses before fetch", async () => {
  const ctx = context("openai", "gpt-6.1-sol");
  const handler = new ComposedHandler(
    new OpenAIProviderTransport(ctx.provider, ctx.modelName, ctx.apiKey),
    ctx.targetModel,
    ctx.modelName,
    0,
    { adapter: new OpenAIAPIFormat(ctx.modelName) }
  );
  handlers.push(handler);
  const calls = capture("unexpected fetch");
  const response = await wireMarkerContext.run({ spec: ctx.targetModel, speed: "fast" }, () =>
    request(handler)
  );
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("has no catalog wire");
  expect(calls).toHaveLength(0);
});
test("request marker context sends priority on OpenAI", async () => {
  const c = resolved("openai", "gpt-6.1-sol");
  const handler = buildKnownWireHandler(context("openai", "gpt-6.1-sol"), "openai", c, c.wire)!;
  handlers.push(handler);
  const calls = capture("invalid value");
  await wireMarkerContext.run({ spec: "openai@gpt-6.1-sol", speed: "fast" }, () =>
    request(handler)
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body.service_tier).toBe("priority");
  expect(wireMarkerContext.getStore()).toBeUndefined();
});
