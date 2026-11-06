/**
 * Step 5s: speed on an `openai-codex` connection whose catalog wire says
 * `speed: unknown`, decided from the account's dynamic models catalog.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { CodexAPIFormat } from "../adapters/codex-api-format.js";
import { clearCodexModelsMemo } from "../providers/codex-models-discovery.js";
import { decideCodexSpeed, findCodexServiceTier } from "../providers/codex-service-tier.js";
import { resolveConnection } from "../providers/connection-resolver.js";
import type { ProviderTransport } from "../providers/transport/types.js";
import { wireMarkerContext } from "../providers/wire-markers.js";
import { ComposedHandler } from "./composed-handler.js";
import type { ModelHandler } from "./types.js";

const cachePath = new URL(
  "../test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json",
  import.meta.url
).pathname;
const modelsBody = JSON.parse(
  readFileSync(
    new URL("../test-fixtures/code-mode/codex-models-response.json", import.meta.url),
    "utf8"
  )
);
const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const realFetch = globalThis.fetch;
const handlers: ModelHandler[] = [];

beforeEach(() => clearCodexModelsMemo());
afterEach(async () => {
  globalThis.fetch = realFetch;
  clearCodexModelsMemo();
  for (const handler of handlers.splice(0)) await handler.shutdown();
});

describe("decideCodexSpeed", () => {
  const info = { slug: "m", serviceTiers: [{ id: "priority", name: "Fast" }] };

  test("fast is the tier Codex labels Fast, by name or by the priority id", () => {
    expect(findCodexServiceTier("fast", info.serviceTiers)?.id).toBe("priority");
    expect(findCodexServiceTier("fast", [{ id: "priority", name: "Turbo" }])?.id).toBe("priority");
    expect(findCodexServiceTier("priority", info.serviceTiers)?.id).toBe("priority");
    expect(findCodexServiceTier("flex", info.serviceTiers)).toBeUndefined();
  });

  test("offered tier is written; standard writes nothing", () => {
    expect(decideCodexSpeed({ value: "fast", explicit: false }, info).tier).toBe("priority");
    expect(decideCodexSpeed({ value: "standard", explicit: true }, info)).toEqual({
      note: "speed standard: field omitted (connection default)",
    });
  });

  test.each([
    [{ slug: "m", serviceTiers: [] }, "offered: none"],
    [undefined, "did not answer"],
  ])("not offered: explicit refuses, /fast only notes (%j)", (modelInfo, text) => {
    const explicit = decideCodexSpeed({ value: "fast", explicit: true }, modelInfo);
    expect(explicit.refusal).toContain(text);
    expect(explicit.tier).toBeUndefined();
    const implicit = decideCodexSpeed({ value: "fast", explicit: false }, modelInfo);
    expect(implicit.refusal).toBeUndefined();
    expect(implicit.tier).toBeUndefined();
    expect(implicit.note).toContain(text);
  });
});

function connection(model: string) {
  const r = resolveConnection("openai-codex", model, cachePath);
  if (!r.ok || r.connection.wire.status !== "known") throw new Error("missing fixture");
  expect(r.connection.wire.speed.status).toBe("unknown");
  return structuredClone(r.connection);
}

/** An OAuth-armed Codex transport, without the account pool `signRequest` reaches. */
function transport(): ProviderTransport {
  return {
    name: "openai-codex",
    displayName: "Codex",
    streamFormat: "openai-responses-sse",
    getEndpoint: () => ENDPOINT,
    getHeaders: async (_req, binding) => ({ ...(binding?.auth?.headers ?? {}) }),
    refreshAuth: async () => ({
      auth: {
        arm: "oauth",
        endpoint: ENDPOINT,
        headers: { Authorization: "Bearer TOKEN", "chatgpt-account-id": "account-speed" },
      },
    }),
  } as ProviderTransport;
}

function handler(
  model: string,
  edit?: (c: ReturnType<typeof connection>) => void,
  modelParams?: Record<string, unknown>
): ModelHandler {
  const c = connection(model);
  edit?.(c);
  const h = new ComposedHandler(transport(), `openai-codex@${model}`, model, 0, {
    adapter: new CodexAPIFormat(model),
    tokenStrategy: "delta-aware",
    codeMode: "off",
    connection: c,
    ...(modelParams && { modelParams }),
  });
  handlers.push(h);
  return h;
}

/** `/models` answers `models`; every Responses call is recorded and answered `error`. */
function upstream(error: string, models: unknown = modelsBody) {
  const calls: any[] = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/codex/models")) return Response.json(models);
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ error: { message: error } }), { status: 400 });
  }) as typeof fetch;
  return calls;
}

function send(h: ModelHandler, extra: Record<string, unknown> = {}) {
  const app = new Hono();
  app.post("/", (c) =>
    h.handle(c, {
      model: "x",
      stream: true,
      max_tokens: 1000,
      messages: [{ role: "user", content: "hello" }],
      ...extra,
    })
  );
  return app.request("/", { method: "POST" });
}

describe("step 5s on cx@ with catalog speed unknown", () => {
  test("Claude Code /fast sends the account's priority tier", async () => {
    const calls = upstream("some other failure");
    await send(handler("gpt-6.1-sol"), { speed: "fast" });
    expect(calls).toHaveLength(1);
    expect(calls[0].service_tier).toBe("priority");
    expect(calls[0]).not.toHaveProperty("speed");
  });

  test("#fast marker sends the tier instead of being refused", async () => {
    const calls = upstream("some other failure");
    const h = handler("gpt-6.1-sol");
    await wireMarkerContext.run({ spec: "cx@gpt-6.1-sol", speed: "fast" }, () => send(h));
    expect(calls).toHaveLength(1);
    expect(calls[0].service_tier).toBe("priority");
  });

  test("no speed asked → no service_tier", async () => {
    const calls = upstream("some other failure");
    await send(handler("gpt-6.1-sol"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("service_tier");
  });

  test("account without the tier: /fast is sent standard, #fast is refused", async () => {
    const noTiers = {
      models: modelsBody.models.map((m: any) => ({ ...m, service_tiers: [] })),
    };
    const calls = upstream("some other failure", noTiers);
    await send(handler("gpt-6.1-sol"), { speed: "fast" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("service_tier");

    const h = handler("gpt-6.1-sol");
    const refused = await wireMarkerContext.run({ spec: "cx@gpt-6.1-sol", speed: "fast" }, () =>
      send(h)
    );
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('speed \\"fast\\" is not offered');
    expect(calls).toHaveLength(1);
  });

  test("a catalog answer wins: speed rejected is never overlaid", async () => {
    const calls = upstream("some other failure");
    const rejected = (c: ReturnType<typeof connection>) => {
      if (c.wire.status === "known") c.wire.speed = { status: "rejected", path: "/service_tier" };
    };
    await send(handler("gpt-6.1-sol", rejected), { speed: "fast" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("service_tier");
    const h = handler("gpt-6.1-sol", rejected);
    const refused = await wireMarkerContext.run({ spec: "cx@gpt-6.1-sol", speed: "fast" }, () =>
      send(h)
    );
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("(rejected)");
    expect(calls).toHaveLength(1);
  });

  test("--model-params service_tier wins and is never dropped by recovery", async () => {
    const calls = upstream("Unsupported parameter: 'service_tier'");
    await send(handler("gpt-6.1-sol", undefined, { service_tier: "flex" }), { speed: "fast" });
    expect(calls).toHaveLength(1);
    expect(calls[0].service_tier).toBe("flex");
  });

  test("a 400 naming service_tier resends /fast without it, once", async () => {
    const calls = upstream("Unsupported parameter: 'service_tier'");
    await send(handler("gpt-6.1-sol"), { speed: "fast" });
    expect(calls).toHaveLength(2);
    expect(calls[0].service_tier).toBe("priority");
    expect(calls[1]).not.toHaveProperty("service_tier");
  });
});
