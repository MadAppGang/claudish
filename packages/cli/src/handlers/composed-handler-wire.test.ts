import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { OpenAIAPIFormat } from "../adapters/openai-api-format.js";
import { builtinHooks } from "../hooks/builtins/index.js";
import { HookEngine } from "../hooks/engine.js";
import { HookRegistry } from "../hooks/registry.js";
import { withHooks } from "../hooks/response-seam.js";
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

test.each(["google/gemini-3.8-flash", "opaque-model"])(
  "Google vendor on a chat wire preserves thought signatures for %s",
  async (model) => {
    const connection = resolved("openrouter", "gemini-3.8-flash");
    expect(connection.vendor).toBe("google");
    expect(connection.wire.api).toBe("chat-completions");
    // Rename only the fixture connection's ids: the vendor and wire remain real.
    connection.externalModelId = model;
    connection.modelId = model;
    const handler = buildKnownWireHandler(
      context("openrouter", model),
      "openrouter",
      connection,
      connection.wire
    )!;
    handlers.push(handler);
    const details = [{ type: "reasoning.encrypted", id: "call_signature", data: "test-signature" }];
    const bodies: any[] = [];
    globalThis.fetch = (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length > 1) return new Response("captured", { status: 599 });
      const frames = [
        {
          choices: [
            {
              delta: {
                role: "assistant",
                reasoning_details: details,
                tool_calls: [
                  {
                    index: 0,
                    id: "call_signature",
                    type: "function",
                    function: { name: "Read", arguments: '{"path":"README.md"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ];
      return new Response(
        frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } }
      );
    }) as typeof fetch;
    // The thought signatures are carried by the built-in raw hook
    // `gemini/thought-signature`, which runs inside the hook seam, as in the proxy.
    const engine = new HookEngine({
      registry: new HookRegistry(builtinHooks({}), [], undefined),
      config: {},
      hostMode: "other",
      journalSink: () => {},
      warn: () => {},
      drainTelemetryOutbox: false,
    });
    const hooked = withHooks(handler, engine);
    const app = new Hono();
    app.post("/", async (c) => hooked.handle(c, await c.req.json()));
    const base = {
      model,
      stream: true,
      max_tokens: 100,
      tools: [
        {
          name: "Read",
          description: "Read",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    };
    const messages: any[] = [{ role: "user", content: "Read README.md" }];
    const first = await app.request("/", {
      method: "POST",
      body: JSON.stringify({ ...base, messages }),
      headers: { "content-type": "application/json" },
    });
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("call_signature");
    messages.push(
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_signature", name: "Read", input: { path: "README.md" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_signature", content: "file contents" }],
      }
    );
    await app.request("/", {
      method: "POST",
      body: JSON.stringify({ ...base, messages }),
      headers: { "content-type": "application/json" },
    });
    expect(bodies).toHaveLength(2);
    const assistant = bodies[1].messages.find((message: any) => message.role === "assistant");
    expect(assistant.reasoning_details).toEqual(details);
  }
);

test.each([
  ["openai", "grok-vendor-regression", false],
  ["", "grok-vendor-regression", false],
  ["x-ai", "opaque-model", true],
] as const)(
  "chat wire vendor %s controls the xAI instruction for %s",
  async (vendor, model, expectsInstruction) => {
    const connection = resolved("fireworks", "deepseek-v4.1-flash");
    expect(connection.wire.api).toBe("chat-completions");
    // Keep the fixture's chat wire and route binding, but make vendor and id
    // disagree. Fireworks uses a plain OpenAIAPIFormat, with no vendor hint
    // supplied by its constructor: ComposedHandler must pass the connection's.
    connection.vendor = vendor;
    connection.externalModelId = model;
    connection.modelId = model;
    const handler = buildKnownWireHandler(
      context("fireworks", model),
      "fireworks",
      connection,
      connection.wire
    )!;
    expect(handler).toBeInstanceOf(ComposedHandler);
    handlers.push(handler);
    const calls = capture("invalid value");
    const app = new Hono();
    app.post("/", (c) =>
      handler.handle(c, {
        model,
        system: "You help with code.",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 100,
        stream: true,
      })
    );
    await app.request("/", { method: "POST" });
    expect(calls).toHaveLength(1);
    const system = calls[0]!.body.messages.find(
      (message: { role: string }) => message.role === "system"
    );
    expect(system?.content).toContain("You help with code.");
    const instruction = "NEVER use XML format like <xai:function_call>";
    if (expectsInstruction) expect(system.content).toContain(instruction);
    else expect(system.content).not.toContain(instruction);
  }
);

test.each([
  [0, 0.01],
  [2, 1],
])(
  "MiniMax vendor clamps temperature %s while wire reasoning wins",
  async (temperature, clamped) => {
    const connection = resolved("opencode-zen-go", "minimax-m3");
    expect(connection.vendor).toBe("minimax");
    // This Messages wire has unknown reasoning; its owner uses Chat, so no
    // reasoning can be borrowed. Step 5w must erase the dialect thinking toggle.
    expect(connection.wire.reasoning).toEqual({ status: "unknown" });
    const foreign = structuredClone(connection);
    foreign.vendor = "openai";
    const bodies: any[] = [];
    globalThis.fetch = (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("captured", { status: 418 });
    }) as typeof fetch;
    for (const c of [connection, foreign]) {
      const handler = buildKnownWireHandler(
        context("opencode-zen-go", "minimax-m3"),
        "opencode-zen-go",
        c,
        c.wire
      )!;
      handlers.push(handler);
      const app = new Hono();
      app.post("/", (ctx) =>
        handler.handle(ctx, {
          model: "minimax-m3",
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 100,
          temperature,
          stream: true,
          output_config: { effort: "high" },
        })
      );
      await app.request("/", { method: "POST" });
    }
    expect(bodies).toHaveLength(2);
    expect(bodies[0].temperature).toBe(clamped);
    expect(bodies[1].temperature).toBe(temperature);
    for (const body of bodies) {
      expect(body).not.toHaveProperty("thinking");
      expect(body).not.toHaveProperty("reasoning_effort");
    }
  }
);
