/**
 * Step 5s: speed on an `openai-codex` connection whose catalog wire says
 * `speed: unknown`, decided from the account's dynamic models catalog.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { CodexAPIFormat } from "../adapters/codex-api-format.js";
import * as logger from "../logger.js";
import * as discovery from "../providers/codex-models-discovery.js";
import { clearCodexModelsMemo } from "../providers/codex-models-discovery.js";
import { decideCodexSpeed, findCodexServiceTier } from "../providers/codex-service-tier.js";
import { resolveConnection } from "../providers/connection-resolver.js";
import type { ProviderTransport } from "../providers/transport/types.js";
import { wireMarkerContext } from "../providers/wire-markers.js";
import { redactSigningValues } from "../redact.js";
import { ComposedHandler, _resetFastIgnoredNotices } from "./composed-handler.js";
import {
  SIGNING_SECRETS_KEY,
  createSigningSecrets,
  releaseWhenBodyEnds,
} from "./shared/call-context.js";
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
/**
 * A short opaque access token: 26 characters, the shape of a plain id. New for
 * every test: these requests run without the session middleware that releases
 * a request's signing lease, so a value one test signed with stays registered.
 */
let accessToken = "";
const realFetch = globalThis.fetch;
const handlers: ModelHandler[] = [];

beforeEach(() => {
  accessToken = `tok_${crypto.randomUUID().replaceAll("-", "").slice(0, 22)}`;
  clearCodexModelsMemo();
  _resetFastIgnoredNotices();
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  clearCodexModelsMemo();
  for (const handler of handlers.splice(0)) await handler.shutdown();
});

describe("decideCodexSpeed", () => {
  const info = { slug: "m", serviceTiers: [{ id: "priority", name: "Fast" }] };

  test("fast is the tier the account names Fast; a tier is matched by id or name only", () => {
    expect(findCodexServiceTier("fast", info.serviceTiers)?.id).toBe("priority");
    expect(findCodexServiceTier("fast", [{ id: "priority", name: "Turbo" }])).toBeUndefined();
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
    [{ slug: "m", serviceTiers: [] }, "lists 0 service tiers"],
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

  test("no upstream tier id reaches the note or refusal, only how many tiers there are", () => {
    const secret = "sk-".concat("a".repeat(61));
    const odd = {
      slug: "m",
      serviceTiers: [
        { id: secret, name: "Turbo" },
        { id: "flexid", name: "Flex" },
      ],
    };
    const refused = decideCodexSpeed({ value: "fast", explicit: true }, odd);
    expect(refused.refusal).toContain("lists 2 service tiers");
    for (const text of [refused.refusal, refused.note]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain("flexid");
    }

    const matched = decideCodexSpeed(
      { value: "fast", explicit: false },
      { slug: "m", serviceTiers: [{ id: "prioid", name: "Fast" }] }
    );
    expect(matched.tier).toBe("prioid");
    expect(matched.note).not.toContain("prioid");
  });

  test("api-key arm: the reason is that no subscription account signed", () => {
    const explicit = decideCodexSpeed({ value: "fast", explicit: true }, "unsigned");
    expect(explicit.refusal).toContain("no subscription account signed the request");
    expect(explicit.refusal).not.toContain("retry");
    expect(decideCodexSpeed({ value: "fast", explicit: false }, "unsigned").tier).toBeUndefined();
  });
});

function connection(model: string) {
  const r = resolveConnection("openai-codex", model, cachePath);
  if (!r.ok || r.connection.wire.status !== "known") throw new Error("missing fixture");
  expect(r.connection.wire.speed.status).toBe("unknown");
  return structuredClone(r.connection);
}

/** A Codex transport signing with `arm`, without the account pool `signRequest` reaches. */
function transport(arm: "oauth" | "api-key" = "oauth"): ProviderTransport {
  return {
    name: "openai-codex",
    displayName: "Codex",
    streamFormat: "openai-responses-sse",
    getEndpoint: () => ENDPOINT,
    getHeaders: async (_req, binding) => ({ ...(binding?.auth?.headers ?? {}) }),
    refreshAuth: async () =>
      arm === "oauth"
        ? {
            auth: {
              arm: "oauth",
              endpoint: ENDPOINT,
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "chatgpt-account-id": "account-speed",
              },
            },
          }
        : { auth: { arm: "api-key", headers: { Authorization: "Bearer sk-metered" } } },
  } as ProviderTransport;
}

function handler(
  model: string,
  edit?: (c: ReturnType<typeof connection>) => void,
  modelParams?: Record<string, unknown>,
  arm: "oauth" | "api-key" = "oauth"
): ModelHandler {
  const c = connection(model);
  edit?.(c);
  const h = new ComposedHandler(transport(arm), `openai-codex@${model}`, model, 0, {
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

/**
 * `send` with the session app's lease lifecycle: a lease installed for the
 * request and released once its body has been read, so a value it signed
 * with is no longer redacted afterwards.
 */
function sendLeased(h: ModelHandler, extra: Record<string, unknown> = {}) {
  const app = new Hono();
  app.post("/", async (c) => {
    const secrets = createSigningSecrets();
    c.set(SIGNING_SECRETS_KEY as never, secrets as never);
    const response = await h.handle(c, {
      model: "x",
      stream: true,
      max_tokens: 1000,
      messages: [{ role: "user", content: "hello" }],
      ...extra,
    });
    return releaseWhenBodyEnds(response, () => secrets.lease.release());
  });
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

  test("#fast refusal body never carries an upstream tier id shaped like a secret", async () => {
    const secret = "sk-".concat("b".repeat(61));
    const oddTiers = {
      models: modelsBody.models.map((m: any) => ({
        ...m,
        service_tiers: [{ id: secret, name: "Turbo" }],
      })),
    };
    const calls = upstream("some other failure", oddTiers);
    const h = handler("gpt-6.1-sol");
    const refused = await wireMarkerContext.run({ spec: "cx@gpt-6.1-sol", speed: "fast" }, () =>
      send(h)
    );
    expect(refused.status).toBe(400);
    const body = await refused.text();
    expect(body).toContain("is not offered");
    expect(body).not.toContain(secret);
    expect(calls).toHaveLength(0);
  });

  test("a tier id equal to the signing token reaches neither the 400 body nor the log", async () => {
    expect(accessToken).toHaveLength(26);
    const echoed = {
      models: modelsBody.models.map((m: any) => ({
        ...m,
        service_tiers: [{ id: accessToken, name: "Turbo" }],
      })),
    };
    const calls = upstream("some other failure", echoed);
    const lines: string[] = [];
    const logSpy = spyOn(logger, "log").mockImplementation((message: string) => {
      lines.push(redactSigningValues(message));
    });
    try {
      const h = handler("gpt-6.1-sol");
      const refused = await wireMarkerContext.run({ spec: "cx@gpt-6.1-sol", speed: "fast" }, () =>
        send(h)
      );
      expect(refused.status).toBe(400);
      const body = await refused.text();
      expect(body).toContain("is not offered");
      expect(body).not.toContain(accessToken);
      const speedLines = lines.filter((line) => line.includes("is not offered"));
      expect(speedLines.length).toBeGreaterThan(0);
      for (const line of speedLines) expect(line).not.toContain(accessToken);
      expect(calls).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("a memoized tier id no lease holds (an old token) reaches neither the 400 nor the log", async () => {
    const oldToken = `old_${crypto.randomUUID().replaceAll("-", "").slice(0, 22)}`;
    const calls = upstream("some other failure", {
      models: modelsBody.models.map((m: any) => ({
        ...m,
        service_tiers: [{ id: oldToken, name: "Turbo" }],
      })),
    });
    const lines: string[] = [];
    const logSpy = spyOn(logger, "log").mockImplementation((message: string) => {
      lines.push(redactSigningValues(message));
    });
    try {
      for (let n = 0; n < 2; n++) {
        const h = handler("gpt-6.1-sol");
        const refused = await wireMarkerContext.run({ spec: "cx@gpt-6.1-sol", speed: "fast" }, () =>
          send(h)
        );
        expect(refused.status).toBe(400);
        const body = await refused.text();
        expect(body).toContain("is not offered");
        expect(body).not.toContain(oldToken);
      }
      expect(lines.filter((line) => line.includes("is not offered"))).toHaveLength(2);
      for (const line of lines) expect(line).not.toContain(oldToken);
      expect(calls).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("a tier id that was the signing token when /models answered is never sent after a refresh", async () => {
    const tokenA = accessToken;
    const calls: any[] = [];
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/codex/models")) {
        return Response.json({
          models: modelsBody.models.map((m: any) => ({
            ...m,
            service_tiers: [{ id: tokenA, name: "Fast" }],
          })),
        });
      }
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      const message = `Invalid service_tier: ${body.service_tier ?? "none"}`;
      return new Response(JSON.stringify({ error: { message } }), { status: 400 });
    }) as typeof fetch;
    const lines: string[] = [];
    const logSpy = spyOn(logger, "log").mockImplementation((message: string) => {
      lines.push(redactSigningValues(message));
    });
    const bodies: string[] = [];
    let tokenB = "";
    try {
      const h = handler("gpt-6.1-sol");
      bodies.push(await (await sendLeased(h, { speed: "fast" })).text());
      tokenB = `tok_${crypto.randomUUID().replaceAll("-", "").slice(0, 22)}`;
      accessToken = tokenB;
      const explicit = await wireMarkerContext.run({ spec: "cx@gpt-6.1-sol", speed: "fast" }, () =>
        sendLeased(h)
      );
      bodies.push(await explicit.text());
      bodies.push(await (await sendLeased(h, { speed: "fast" })).text());
    } finally {
      logSpy.mockRestore();
    }
    expect(tokenB).not.toBe(tokenA);
    for (const text of [...bodies, ...lines]) {
      expect(text).not.toContain(tokenA);
      expect(text).not.toContain(tokenB);
    }
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.service_tier).not.toBe(tokenA);
  });

  test("an applied tier is sent upstream but named in no log line", async () => {
    const tierId = `tier_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const calls = upstream("some other failure", {
      models: modelsBody.models.map((m: any) => ({
        ...m,
        service_tiers: [{ id: tierId, name: "Fast" }],
      })),
    });
    const lines: string[] = [];
    const logSpy = spyOn(logger, "log").mockImplementation((message: string) => {
      lines.push(message);
    });
    try {
      await send(handler("gpt-6.1-sol"), { speed: "fast" });
    } finally {
      logSpy.mockRestore();
    }
    expect(calls[0].service_tier).toBe(tierId);
    expect(lines.some((line) => line.includes("speed fast"))).toBe(true);
    for (const line of lines) expect(line).not.toContain(tierId);
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

  test("/models unanswered: the Codex CLI cache never decides the tier", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "claudish-speed-cli-cache-"));
    writeFileSync(join(codexHome, "models_cache.json"), JSON.stringify(modelsBody));
    const real = discovery.getCodexModelInfo;
    const lookup = spyOn(discovery, "getCodexModelInfo").mockImplementation(
      (slug, binding, accountKey, opts) => real(slug, binding, accountKey, { ...opts, codexHome })
    );
    const calls: any[] = [];
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/codex/models")) throw new TypeError("offline");
      calls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ error: { message: "x" } }), { status: 400 });
    }) as typeof fetch;
    try {
      await send(handler("gpt-6.1-sol"), { speed: "fast" });
      expect(lookup).toHaveBeenCalled();
      expect(calls).toHaveLength(1);
      expect(calls[0]).not.toHaveProperty("service_tier");

      const h = handler("gpt-6.1-sol");
      const refused = await wireMarkerContext.run({ spec: "cx@gpt-6.1-sol", speed: "fast" }, () =>
        send(h)
      );
      expect(refused.status).toBe(400);
      expect(await refused.text()).toContain("did not answer");
    } finally {
      lookup.mockRestore();
      rmSync(codexHome, { recursive: true, force: true });
    }
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

/** Run `body` with stderr captured; returns the lines that report an ignored /fast. */
async function fastNotices(body: () => unknown): Promise<string[]> {
  const lines: string[] = [];
  const write = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  try {
    await body();
  } finally {
    write.mockRestore();
  }
  return lines.filter((line) => line.includes("/fast ignored"));
}

describe("Claude Code /fast is sent only on a subscription-signed Codex request", () => {
  test("api-key arm: no tier, no discovery call, one stderr line per model", async () => {
    let modelsCalls = 0;
    const calls: any[] = [];
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/codex/models")) {
        modelsCalls++;
        return Response.json(modelsBody);
      }
      calls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ error: { message: "x" } }), { status: 400 });
    }) as typeof fetch;
    const h = handler("gpt-6.1-sol", undefined, undefined, "api-key");
    const notices = await fastNotices(async () => {
      await send(h, { speed: "fast" });
      await send(h, { speed: "fast" });
    });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).not.toHaveProperty("service_tier");
      expect(call).not.toHaveProperty("speed");
    }
    expect(modelsCalls).toBe(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("gpt-6.1-sol");
    expect(notices[0]).toContain("metered");
    expect(notices[0]).toContain("subscription");
    expect(notices[0]).not.toContain("#fast");
  });

  test("api-key arm: #fast is refused naming the missing subscription account", async () => {
    const calls = upstream("some other failure");
    const h = handler("gpt-6.1-sol", undefined, undefined, "api-key");
    const refused = await wireMarkerContext.run({ spec: "cx@gpt-6.1-sol", speed: "fast" }, () =>
      send(h)
    );
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("no subscription account signed the request");
    expect(calls).toHaveLength(0);
  });

  test("oauth arm: /fast sends the Fast tier with no stderr line", async () => {
    const calls = upstream("some other failure");
    const notices = await fastNotices(() => send(handler("gpt-6.1-sol"), { speed: "fast" }));
    expect(calls[0].service_tier).toBe("priority");
    expect(notices).toHaveLength(0);
  });

  const supported = (c: ReturnType<typeof connection>) => {
    if (c.wire.status === "known") {
      c.wire.speed = {
        status: "supported",
        path: "/service_tier",
        values: { fast: "priority" },
        default: "standard",
        headers: [],
        echo: "/service_tier",
        access: "open",
      };
    }
  };

  test.each([
    ["oauth", "priority"],
    ["api-key", undefined],
  ] as const)("catalog speed supported, %s arm: /fast tier is %p", async (arm, tier) => {
    const calls = upstream("some other failure");
    const notices = await fastNotices(() =>
      send(handler("gpt-6.1-sol", supported, undefined, arm), { speed: "fast" })
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].service_tier).toBe(tier);
    expect(notices).toHaveLength(arm === "oauth" ? 0 : 1);
    if (arm === "api-key") expect(notices[0]).toContain("Add #fast");
  });

  test("catalog speed supported, api-key arm: an explicit #fast still applies", async () => {
    const calls = upstream("some other failure");
    const h = handler("gpt-6.1-sol", supported, undefined, "api-key");
    await wireMarkerContext.run({ spec: "cx@gpt-6.1-sol", speed: "fast" }, () => send(h));
    expect(calls).toHaveLength(1);
    expect(calls[0].service_tier).toBe("priority");
  });
});
