/**
 * #651 — the declared window must come from the engine, not from a human.
 *
 * The measured starting point (hub, 2026-10-24): `customEndpoints.vllm-myia
 * .contextLimit = 262144` agreed with `GET /v1/models` → `max_model_len =
 * 262144` — by coincidence. Nothing in production read `max_model_len`, so the
 * number behind the #441 clamp and the #565 admission census was a literal, and
 * a rebuilt engine with a smaller `--max-model-len` would have kept the lie.
 *
 * What these pins hold, one per path the issue names:
 *   1. DERIVED — an opted-in endpoint's `max_model_len` becomes the declared
 *      limit, in the registry the census and the handler builders both read.
 *   2. NOT DERIVED — every failure shape (non-2xx, no `max_model_len`, two
 *      served models that disagree, network error) reports a reason and leaves
 *      the config value alone. It must NEVER invent a default: an absent
 *      measurement coerced into a number is evidence nobody collected.
 *   3. ABSENT — an endpoint that does not opt in is untouched: zero probes, so
 *      today's behaviour is byte-identical (the inert-by-default pin).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  deriveContextLimits,
  modelsUrlFor,
  parseCatalogModels,
  pickMaxModelLen,
  purgeCapsReplacedByDerivation,
} from "./context-limit-derivation.js";
import {
  clearRuntimeRegistry,
  getDeclaredContextLimit,
  getDerivedContextLimit,
  registerDeclaredContextLimit,
} from "./runtime-providers.js";
import { customEndpointCapKey, loadCustomEndpoints } from "./custom-endpoints-loader.js";
import { OpenAIProviderTransport } from "./transport/openai.js";
import type { RemoteProvider } from "../handlers/shared/remote-provider-types.js";
import type { CustomEndpoint } from "../config-schema.js";
import {
  getOverflowCap,
  rememberOverflowCap,
  resetOverflowCapsForTests,
} from "../handlers/shared/context-overflow.js";

function stubFetch(answer: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const impl = (async (input: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    calls.push(url);
    return answer(url);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function config(customEndpoints: Record<string, unknown>) {
  return { customEndpoints } as any;
}

describe("modelsUrlFor", () => {
  test("replaces the chat segment, keeping the /v1 prefix the operator declared", () => {
    // Simple shape: the URL already carries /v1, the handler appends the path.
    expect(modelsUrlFor("http://127.0.0.1:5002/v1", "/chat/completions")).toBe(
      "http://127.0.0.1:5002/v1/models"
    );
    // Complex shape: a bare base URL and the full /v1/chat/completions path.
    expect(modelsUrlFor("http://h:8000/", "/v1/chat/completions")).toBe("http://h:8000/v1/models");
    expect(modelsUrlFor("http://host", "/v1/messages")).toBe("http://host/v1/models");
    // No recognisable terminal segment: fall back to the OpenAI convention
    // rather than concatenating onto a path we do not understand.
    expect(modelsUrlFor("http://host/api", "/custom/chat")).toBe("http://host/api/v1/models");
  });
});

describe("parseCatalogModels", () => {
  test("reads the OpenAI/vLLM shape and requires a positive finite max_model_len", () => {
    const entries = parseCatalogModels({
      data: [
        { id: "swift-1.5-27b", max_model_len: 262144 },
        { id: "qwen3.6-35b-a3b", max_model_len: 262144 },
        { id: "no-len" },
        { id: "bad-len", max_model_len: "262144" },
        { id: "zero-len", max_model_len: 0 },
      ],
    });
    expect(entries.map((e) => e.id)).toEqual([
      "swift-1.5-27b",
      "qwen3.6-35b-a3b",
      "no-len",
      "bad-len",
      "zero-len",
    ]);
    expect(entries[0].maxModelLen).toBe(262144);
    expect(entries[2].maxModelLen).toBeUndefined();
    expect(entries[3].maxModelLen).toBeUndefined();
    expect(entries[4].maxModelLen).toBeUndefined();
  });

  test("accepts a bare array and Ollama's {models:[…]}; junk yields nothing", () => {
    expect(parseCatalogModels([{ id: "a", max_model_len: 10 }])).toHaveLength(1);
    expect(parseCatalogModels({ models: [{ id: "b", max_model_len: 20 }] })).toHaveLength(1);
    expect(parseCatalogModels(null)).toEqual([]);
    expect(parseCatalogModels({ data: "nope" })).toEqual([]);
  });
});

describe("pickMaxModelLen", () => {
  const both = [
    { id: "swift-1.5-27b", maxModelLen: 262144 },
    { id: "qwen3.6-35b-a3b", maxModelLen: 262144 },
  ];

  test("agreement across the served universe is a measurement, not a guess", () => {
    expect(pickMaxModelLen(both, {}).limit).toBe(262144);
  });

  test("disagreement with no selector is ambiguous — never max, never min", () => {
    const mixed = [
      { id: "small", maxModelLen: 32768 },
      { id: "big", maxModelLen: 262144 },
    ];
    const picked = pickMaxModelLen(mixed, {});
    expect(picked.limit).toBeUndefined();
    expect(picked.reason).toContain("disagree");
    expect(picked.reason).toContain("32768");
    expect(picked.reason).toContain("262144");
  });

  test("the declared models list and the prefix both select which entry speaks", () => {
    const mixed = [
      { id: "small-1", maxModelLen: 32768 },
      { id: "big-1", maxModelLen: 262144 },
    ];
    expect(pickMaxModelLen(mixed, { models: ["big-1"] }).limit).toBe(262144);
    expect(pickMaxModelLen(mixed, { modelPrefix: "small-" }).limit).toBe(32768);
    // A selector that matches entries which still disagree stays ambiguous.
    expect(pickMaxModelLen(mixed, { modelPrefix: "" }).limit).toBeUndefined();
  });

  test("a catalog with no max_model_len at all says so", () => {
    const picked = pickMaxModelLen([{ id: "m" }], {});
    expect(picked.limit).toBeUndefined();
    expect(picked.reason).toContain("none carries max_model_len");
    expect(pickMaxModelLen([], {}).reason).toContain("no recognisable model entries");
  });
});

describe("deriveContextLimits", () => {
  beforeEach(() => clearRuntimeRegistry());

  test("INERT: an endpoint that does not opt in issues no probe at all", async () => {
    const fx = stubFetch(() => json({ data: [{ id: "m", max_model_len: 1234 }] }));
    const outcomes = await deriveContextLimits(
      config({ ep: { kind: "simple", url: "http://h/v1", format: "openai", apiKey: "k", contextLimit: 999 } }),
      { fetchImpl: fx.impl }
    );
    expect(outcomes).toEqual([]);
    expect(fx.calls).toEqual([]); // zero wire bytes — today's behaviour, byte-identical
    expect(getDeclaredContextLimit("ep")).toBeUndefined();
  });

  test("DERIVED: max_model_len becomes the declared limit in the registry", async () => {
    const fx = stubFetch(() =>
      json({
        data: [
          { id: "swift-1.5-27b", max_model_len: 262144 },
          { id: "qwen3.6-35b-a3b", max_model_len: 262144 },
        ],
      })
    );
    const outcomes = await deriveContextLimits(
      config({
        "vllm-myia": {
          kind: "simple",
          url: "http://127.0.0.1:5002/v1",
          format: "openai",
          apiKey: "k",
          contextLimit: 262144,
          deriveContextLimit: true,
        },
      }),
      { fetchImpl: fx.impl }
    );
    expect(fx.calls).toEqual(["http://127.0.0.1:5002/v1/models"]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ name: "vllm-myia", derived: true, limit: 262144 });
    expect(getDeclaredContextLimit("vllm-myia")).toBe(262144);
    // #651 — the MEASURED window is registered apart from the claim: only this
    // one may pre-seed the learned cap (runtime-providers.registerDerivedContextLimit).
    expect(getDerivedContextLimit("vllm-myia")).toBe(262144);
  });

  test("DERIVED: the engine wins over a stale config value — the whole point", async () => {
    registerDeclaredContextLimit("ep", 262144); // what the loader registered from config
    const fx = stubFetch(() => json({ data: [{ id: "m", max_model_len: 131072 }] }));
    await deriveContextLimits(
      config({ ep: { kind: "simple", url: "http://h/v1", format: "openai", apiKey: "k", deriveContextLimit: true } }),
      { fetchImpl: fx.impl }
    );
    expect(getDeclaredContextLimit("ep")).toBe(131072);
    expect(getDerivedContextLimit("ep")).toBe(131072);
  });

  test("NOT DERIVED (401): reports the status, keeps the declared value, invents nothing", async () => {
    registerDeclaredContextLimit("ep", 262144);
    const fx = stubFetch(() => json({ error: "unauthorized" }, 401));
    const outcomes = await deriveContextLimits(
      config({
        ep: { kind: "simple", url: "http://h/v1", format: "openai", apiKey: "k", contextLimit: 262144, deriveContextLimit: true },
      }),
      { fetchImpl: fx.impl }
    );
    expect(outcomes[0].derived).toBe(false);
    expect(outcomes[0].reason).toContain("401");
    expect(getDeclaredContextLimit("ep")).toBe(262144); // the fallback, not a default
  });

  test("NOT DERIVED: a failed probe with NO config value leaves the endpoint undeclared", async () => {
    const fx = stubFetch(() => json({ data: [{ id: "m" }] })); // no max_model_len anywhere
    const outcomes = await deriveContextLimits(
      config({ ep: { kind: "simple", url: "http://h/v1", format: "openai", apiKey: "k", deriveContextLimit: true } }),
      { fetchImpl: fx.impl }
    );
    expect(outcomes[0].derived).toBe(false);
    expect(outcomes[0].reason).toContain("max_model_len");
    expect(getDeclaredContextLimit("ep")).toBeUndefined(); // NOT 262144, NOT 0
    expect(getDerivedContextLimit("ep")).toBeUndefined(); // nothing measured, so nothing may pre-seed
  });

  test("NOT DERIVED: ambiguous catalogs and network errors stay non-fatal", async () => {
    const ambiguous = stubFetch(() =>
      json({ data: [{ id: "a", max_model_len: 32768 }, { id: "b", max_model_len: 262144 }] })
    );
    const a = await deriveContextLimits(
      config({ ep: { kind: "simple", url: "http://h/v1", format: "openai", apiKey: "k", deriveContextLimit: true } }),
      { fetchImpl: ambiguous.impl }
    );
    expect(a[0].derived).toBe(false);
    expect(a[0].reason).toContain("disagree");
    expect(getDeclaredContextLimit("ep")).toBeUndefined();

    const dead = stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const b = await deriveContextLimits(
      config({ ep: { kind: "simple", url: "http://h/v1", format: "openai", apiKey: "k", deriveContextLimit: true } }),
      { fetchImpl: dead.impl }
    );
    expect(b[0].derived).toBe(false);
    expect(b[0].reason).toContain("ECONNREFUSED");
  });

  test("a failing endpoint does not stop the next one (per-endpoint isolation)", async () => {
    const fx = stubFetch((url) =>
      url.includes("bad") ? json({}, 500) : json({ data: [{ id: "m", max_model_len: 4096 }] })
    );
    const outcomes = await deriveContextLimits(
      config({
        bad: { kind: "simple", url: "http://bad/v1", format: "openai", apiKey: "k", deriveContextLimit: true },
        good: { kind: "simple", url: "http://good/v1", format: "openai", apiKey: "k", deriveContextLimit: true },
      }),
      { fetchImpl: fx.impl }
    );
    expect(outcomes.map((o) => [o.name, o.derived])).toEqual([
      ["bad", false],
      ["good", true],
    ]);
    expect(getDeclaredContextLimit("good")).toBe(4096);
  });

  test("complex endpoints use their own baseUrl/apiPath and auth scheme", async () => {
    const seen: Array<{ url: string; headers: any }> = [];
    const impl = (async (input: any, init?: any) => {
      seen.push({ url: String(input), headers: init?.headers ?? {} });
      return json({ data: [{ id: "m", max_model_len: 8192 }] });
    }) as unknown as typeof fetch;
    await deriveContextLimits(
      config({
        anth: {
          kind: "complex",
          displayName: "Anth",
          transport: "anthropic",
          baseUrl: "http://h:8000",
          apiPath: "/v1/messages",
          apiKey: "secret-key",
          authScheme: "x-api-key",
          deriveContextLimit: true,
        },
      }),
      { fetchImpl: impl }
    );
    expect(seen[0].url).toBe("http://h:8000/v1/models");
    expect(seen[0].headers["x-api-key"]).toBe("secret-key");
    expect(seen[0].headers.Authorization).toBeUndefined();
    expect(getDeclaredContextLimit("anth")).toBe(8192);
  });

  test("an invalid endpoint entry is skipped silently — the loader already reported it", async () => {
    const fx = stubFetch(() => json({ data: [{ id: "m", max_model_len: 1 }] }));
    const outcomes = await deriveContextLimits(
      config({ broken: { kind: "simple", format: "openai", deriveContextLimit: true } }),
      { fetchImpl: fx.impl }
    );
    expect(outcomes).toEqual([]);
    expect(fx.calls).toEqual([]);
  });
});

// #660 r2 — the purge must fire under the key a REAL handler records.
//
// The recording site is `transport.displayName` (composed-handler.ts), which
// for a custom endpoint is `formatDisplayName(<config key>)` — "vllm-myia"
// records as "Vllm-myia". r1 shipped a purge keyed on the config key and
// purged exactly nothing for every lowercase endpoint name (measured: 0
// purged, cap intact). These pins hold the seam from BOTH sides at once: the
// cap is learned under a transport built the way buildSimpleHandler builds
// it, and the purge runs the exact loop createProxyServer runs.
describe("purgeCapsReplacedByDerivation — the call-site key (#660 r2)", () => {
  beforeEach(() => {
    clearRuntimeRegistry();
    resetOverflowCapsForTests();
  });

  test("a cap learned under a real transport's displayName is purged; rerun purges 0", async () => {
    // The endpoint a hub actually runs: lowercase name, openai wire.
    const vllm = {
      kind: "simple",
      url: "http://127.0.0.1:5002/v1",
      format: "openai",
      apiKey: "k",
      contextLimit: 262144,
      deriveContextLimit: true,
    };
    // Register through the real loader — same validation path production takes.
    const loaded = loadCustomEndpoints(config({ "vllm-myia": vllm }));
    expect(loaded.registered).toBe(1);
    expect(loaded.errors).toEqual([]);

    // Build the transport EXACTLY as buildSimpleHandler's openai branch does:
    // RemoteProvider.name is the config key, and the transport derives its
    // displayName — the key composed-handler records caps under — from it.
    const remote: RemoteProvider = {
      name: "vllm-myia",
      baseUrl: "http://127.0.0.1:5002/v1",
      apiPath: "/chat/completions",
      apiKeyEnvVar: "CUSTOM_VLLM_MYIA_KEY",
      prefixes: ["vllm-myia"],
      authScheme: "bearer",
    };
    const transport = new OpenAIProviderTransport(remote, "swift-1.5-27b", "k");
    // The mismatch r2 measured, stated as an invariant rather than assumed:
    // displayName ≠ config key for a lowercase name.
    expect(transport.displayName).toBe("Vllm-myia");
    expect(transport.displayName).not.toBe("vllm-myia");

    // A restored cap, learned under the key the handler uses.
    rememberOverflowCap(transport.displayName, "swift-1.5-27b", 120000);
    expect(getOverflowCap(transport.displayName, "swift-1.5-27b")).toBe(120000);

    // Derivation succeeds, then the startup purge runs the shared loop.
    const fx = stubFetch(() => json({ data: [{ id: "swift-1.5-27b", max_model_len: 262144 }] }));
    const outcomes = await deriveContextLimits(config({ "vllm-myia": vllm }), {
      fetchImpl: fx.impl,
    });
    expect(outcomes[0].derived).toBe(true);
    expect(purgeCapsReplacedByDerivation(outcomes)).toBe(1);
    expect(getOverflowCap(transport.displayName, "swift-1.5-27b")).toBeUndefined();

    // Idempotent: nothing left to drop on a rerun.
    expect(purgeCapsReplacedByDerivation(outcomes)).toBe(0);
  });

  test("a NOT-derived outcome purges nothing — the cap must survive a failed probe", async () => {
    const ep = {
      kind: "simple",
      url: "http://h/v1",
      format: "openai",
      apiKey: "k",
      deriveContextLimit: true,
    };
    const transport = new OpenAIProviderTransport(
      { name: "ep", baseUrl: "http://h/v1", apiPath: "/chat/completions", apiKeyEnvVar: "X", prefixes: [] },
      "m",
      "k"
    );
    rememberOverflowCap(transport.displayName, "m", 90000);

    const fx = stubFetch(() => json({}, 500));
    const outcomes = await deriveContextLimits(config({ ep }), { fetchImpl: fx.impl });
    expect(outcomes[0].derived).toBe(false);
    expect(purgeCapsReplacedByDerivation(outcomes)).toBe(0);
    expect(getOverflowCap(transport.displayName, "m")).toBe(90000);
  });

  test("capKey mirrors each transport's own displayName computation", () => {
    const simpleOpenai = {
      kind: "simple",
      url: "http://h/v1",
      format: "openai",
      apiKey: "k",
    } as CustomEndpoint;
    const simpleAnthropic = {
      kind: "simple",
      url: "http://h",
      format: "anthropic",
      apiKey: "k",
    } as CustomEndpoint;
    const complexAnthropic = {
      kind: "complex",
      displayName: "Anth",
      transport: "anthropic",
      baseUrl: "http://h",
      apiKey: "k",
    } as CustomEndpoint;
    const complexLitellm = {
      kind: "complex",
      displayName: "LLM",
      transport: "litellm",
      baseUrl: "http://h",
      apiKey: "k",
    } as CustomEndpoint;

    // Lowercase custom name → capitalised, never the raw key (the r2 bug).
    expect(customEndpointCapKey("vllm-myia", simpleOpenai)).toBe("Vllm-myia");
    // Built-in names hit the transports' own maps — including on the custom
    // wire, where the config key would have been wrong twice over.
    expect(customEndpointCapKey("glm", simpleOpenai)).toBe("GLM");
    expect(customEndpointCapKey("zai", simpleAnthropic)).toBe("Z.AI");
    expect(customEndpointCapKey("minimax", complexAnthropic)).toBe("MiniMax");
    // LiteLLM's transport hardcodes one displayName for every endpoint.
    expect(customEndpointCapKey("anything", complexLitellm)).toBe("LiteLLM");
  });
});
