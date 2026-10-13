import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustomEndpoint } from "../config-schema.js";

// Imports that cache HOME, credentials and adapters stay in the isolated child.
function capture(
  endpoint?: CustomEndpoint,
  model = "qwen3-thinking",
  request: Record<string, unknown> = {},
  mode = "custom"
) {
  const home = mkdtempSync(join(tmpdir(), "declared-endpoint-"));
  const source = new URL("../", import.meta.url).pathname;
  try {
    const child = Bun.spawnSync(
      [
        process.execPath,
        "--eval",
        `
      const { Hono } = await import("hono");
      const { loadCustomEndpoints } = await import(${JSON.stringify(source + "providers/custom-endpoints-loader.ts")});
      const { getRuntimeProfiles, clearRuntimeRegistry } = await import(${JSON.stringify(source + "providers/runtime-providers.ts")});
      const { getProviderByName, toRemoteProvider } = await import(${JSON.stringify(source + "providers/provider-definitions.ts")});
      const { ComposedHandler } = await import(${JSON.stringify(source + "handlers/composed-handler.ts")});
      const model = ${JSON.stringify(model)};
      const mode = ${JSON.stringify(mode)};
      const ctx = { provider: { name: "wire-test", baseUrl: "https://example.invalid/v1", apiPath: "/chat/completions", apiKeyEnvVar: "", prefixes: [] }, modelName: model, targetModel: "wire-test@" + model, port: 0, apiKey: "fake", sharedOpts: {} };
      let handler;
      if (mode === "custom") {
        const result = loadCustomEndpoints({ version: "1.0.0", defaultProfile: "default", profiles: {}, customEndpoints: { "wire-test": ${JSON.stringify(endpoint)} } });
        if (result.registered !== 1) throw new Error(JSON.stringify(result));
        ctx.provider = toRemoteProvider(getProviderByName("wire-test"));
        handler = getRuntimeProfiles().get("wire-test").createHandler(ctx);
      } else if (mode === "grok") {
        const { grokSubscriptionProfile } = await import(${JSON.stringify(source + "providers/provider-profiles.ts")});
        ctx.provider = toRemoteProvider(getProviderByName("grok-subscription"));
        handler = grokSubscriptionProfile.createHandler(ctx);
        console.log(JSON.stringify({ adapter: handler.getActiveAdapterName() }));
        await handler.shutdown();
        process.exit(0);
      } else {
        const options = {};
        if (mode === "openrouter") {
          const { OpenRouterAPIFormat } = await import(${JSON.stringify(source + "adapters/openrouter-api-format.ts")});
          const { declaredWire, declaredConnection } = await import(${JSON.stringify(source + "providers/declared-wire.ts")});
          options.adapter = new OpenRouterAPIFormat(model, { vendor: "" });
          options.connection = declaredConnection("openrouter", model, ctx.provider.baseUrl, declaredWire("chat-completions", undefined));
        }
        handler = new ComposedHandler({ name: "wire-test", displayName: "Test", streamFormat: "openai-sse", getEndpoint: () => "https://example.invalid/chat/completions", getHeaders: async () => ({}) }, ctx.targetModel, model, 0, options);
      }
      const captures = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        captures.push({ url: String(url), method: init.method, body: JSON.parse(init.body) });
        return new Response("captured", { status: 400 });
      };
      try {
        const app = new Hono();
        app.post("/", c => handler.handle(c, { model, max_tokens: 512, messages: [{role: "user", content: "hello"}], thinking: { type: "enabled", budget_tokens: 128 }, output_config: { effort: "high" }, ...${JSON.stringify(request)} }));
        await app.request("/", { method: "POST" });
        if (captures.length !== 1) throw new Error(JSON.stringify(captures));
        console.log(JSON.stringify(captures[0]));
      } finally { globalThis.fetch = originalFetch; await handler.shutdown(); clearRuntimeRegistry(); }
    `,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CLAUDISH_DISABLE_CATALOG_WARM: "1",
          CLAUDISH_DISABLE_KEYCHAIN: "1",
          CLAUDISH_DISABLE_OP: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    return JSON.parse(child.stdout.toString());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
const simple: CustomEndpoint = {
  kind: "simple",
  url: "https://example.invalid/v1",
  format: "openai",
  apiKey: "fake",
};
const thinkingWire = {
  reasoning: {
    enable: [{ path: "/chat_template_kwargs/enable_thinking", value: true }],
    disable: [{ path: "/chat_template_kwargs/enable_thinking", value: false }],
  },
};

test("simple OpenAI endpoint defaults do not infer Qwen reasoning", () => {
  const { body } = capture(simple);
  expect(body.max_tokens).toBe(512);
  for (const field of ["enable_thinking", "chat_template_kwargs", "reasoning_effort", "thinking"])
    expect(body).not.toHaveProperty(field);
});
test.each([true, false])("declared Qwen thinking switch sends %s", (enabled) => {
  const { body } = capture({ ...simple, wire: thinkingWire }, "qwen3-thinking", {
    thinking: { type: enabled ? "enabled" : "disabled" },
  });
  expect(body.chat_template_kwargs).toEqual({ enable_thinking: enabled });
  expect(body.max_tokens).toBe(512);
});
test("declared effort clamps to a published value", () => {
  const { body } = capture(
    {
      ...simple,
      wire: {
        reasoning: {
          effort: { path: "/reasoning_effort", values: { low: "small", high: "large" } },
        },
      },
    },
    "qwen3-thinking",
    { output_config: { effort: "medium" } }
  );
  expect(body.reasoning_effort).toBe("large");
});
test("simple Responses declaration chooses URL, body and output limit", () => {
  const result = capture({ ...simple, wire: { api: "responses" } });
  expect(result.url).toBe("https://example.invalid/v1/responses");
  expect(result.method).toBe("POST");
  expect(result.body.input).toBeArray();
  expect(result.body).not.toHaveProperty("messages");
  expect(result.body.max_output_tokens).toBe(512);
  expect(result.body).not.toHaveProperty("max_tokens");
});
test.each([undefined, "/custom/responses"])("complex Responses honors apiPath %s", (apiPath) => {
  const result = capture({
    kind: "complex",
    displayName: "Test",
    transport: "openai",
    baseUrl: "https://example.invalid",
    apiKey: "fake",
    apiPath,
    wire: { api: "responses" },
  });
  expect(result.url).toBe(`https://example.invalid${apiPath ?? "/v1/responses"}`);
  expect(result.body.max_output_tokens).toBe(512);
  expect(result.body).toHaveProperty("input");
  expect(result.body).not.toHaveProperty("messages");
});
test("complex Anthropic endpoint uses Messages limit without Qwen dialect", () => {
  const { body } = capture({
    kind: "complex",
    displayName: "Test",
    transport: "anthropic",
    baseUrl: "https://example.invalid",
    apiPath: "/v1/messages",
    apiKey: "fake",
  });
  expect(body.max_tokens).toBe(512);
  expect(body.messages).toBeArray();
  for (const field of ["thinking", "enable_thinking", "thinking_budget", "reasoning_effort"])
    expect(body).not.toHaveProperty(field);
});
test.each(["glm-5.3", "qwen3.8-max", "deepseek-v4.1-flash", "minimax-m3"])(
  "no connection or explicit dialect infers no fields for %s",
  (model) => {
    const { body } = capture(undefined, model, {}, "plain");
    for (const field of [
      "thinking",
      "enable_thinking",
      "chat_template_kwargs",
      "thinking_budget",
      "reasoning_effort",
    ])
      expect(body).not.toHaveProperty(field);
  }
);
test("Grok subscription profile explicitly composes GrokModelDialect", () => {
  expect(capture(undefined, "grok-4.7", {}, "grok").adapter).toBe("GrokModelDialect");
});
test("unpublished OpenRouter model uses declared defaults without legacy reasoning", () => {
  const { body } = capture(undefined, "unpublished/o3-grok-reasoning", {}, "openrouter");
  expect(body.max_tokens).toBe(512);
  expect(body).not.toHaveProperty("include_reasoning");
  expect(body).not.toHaveProperty("thinking");
});
