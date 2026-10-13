/**
 * Tests for live, per-subscription model discovery.
 *
 * The fetch path is exercised via a mocked global.fetch. The credential
 * authority method is replaced directly to keep the tests offline without
 * using mock.module(), which can bleed into sibling Bun test files.
 *
 * Run: bun test packages/cli/src/providers/model-discovery.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { credentials } from "../auth/credentials/authority.js";
import {
  type DiscoveredModel,
  type DiscoveryFailure,
  describeDiscoveryFailure,
  discoverContextWindow,
  discoverProviderModels,
  getDiscoveryFailure,
  invalidateModelDiscovery,
  rankDiscoveredModels,
} from "./model-discovery.js";
import type { ProviderDefinition } from "./provider-definitions.js";
import { clearRuntimeRegistry, registerRuntimeProvider } from "./runtime-providers.js";

const realFetch = globalThis.fetch;
const realGetRequestAuth = credentials.getRequestAuth;

function stubJsonResponse(body: unknown, status = 200) {
  const fetchMock = mock(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  invalidateModelDiscovery();
  clearRuntimeRegistry();
  globalThis.fetch = realFetch;
  credentials.getRequestAuth = realGetRequestAuth;

  credentials.getRequestAuth = mock(async () => ({
    headers: { Authorization: "Bearer offline-test-token" },
  }));
  globalThis.fetch = mock(async () => {
    throw new Error("Unexpected fetch call");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  invalidateModelDiscovery();
  clearRuntimeRegistry();
  globalThis.fetch = realFetch;
  credentials.getRequestAuth = realGetRequestAuth;
});

describe("discoverProviderModels", () => {
  test("sends a claudish User-Agent on discovery requests", async () => {
    let requestInit: RequestInit | undefined;
    globalThis.fetch = mock(async (_input, init) => {
      requestInit = init;
      return new Response(JSON.stringify({ data: [{ id: "header-test-model" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await discoverProviderModels("kimi-coding");

    const requestHeaders = new Headers(requestInit?.headers);
    expect(requestHeaders.get("User-Agent")).toMatch(/^claudish\//);
  });

  test("applies credential headers after definition headers and the default User-Agent", async () => {
    const provider: ProviderDefinition = {
      name: "discovery-header-merge-test",
      displayName: "Discovery Header Merge Test",
      transport: "openai",
      baseUrl: "https://header-merge.invalid",
      apiPath: "/v1/chat/completions",
      apiKeyEnvVar: "DISCOVERY_HEADER_MERGE_TEST_API_KEY",
      apiKeyDescription: "Offline test key",
      apiKeyUrl: "https://header-merge.invalid/key",
      shortcuts: [],
      legacyPrefixes: [],
      modelDiscovery: { path: "/v1/models", format: "openai-models-list" },
      createHandler: {
        kind: "none",
        reason: "virtual",
        note: "Test fixture — never builds a handler.",
      },
      headers: {
        Authorization: "Bearer definition-token",
        "X-API-Key": "definition-api-key",
        "User-Agent": "definition-agent",
        "X-Definition-Header": "preserved",
      },
      isDirectApi: true,
    };
    registerRuntimeProvider(provider);
    credentials.getRequestAuth = mock(async () => ({
      headers: {
        Authorization: "Bearer authority-token",
        "X-API-Key": "authority-api-key",
        "User-Agent": "authority-agent",
      },
    }));

    let requestInit: RequestInit | undefined;
    globalThis.fetch = mock(async (_input, init) => {
      requestInit = init;
      return new Response(JSON.stringify({ data: [{ id: "header-test-model" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await discoverProviderModels(provider.name);

    const requestHeaders = new Headers(requestInit?.headers);
    expect(requestHeaders.get("Authorization")).toBe("Bearer authority-token");
    expect(requestHeaders.get("X-API-Key")).toBe("authority-api-key");
    expect(requestHeaders.get("User-Agent")).toBe("authority-agent");
    expect(requestHeaders.get("X-Definition-Header")).toBe("preserved");
  });

  test("parses an OpenAI-style model list", async () => {
    stubJsonResponse({
      data: [
        {
          id: "k3",
          display_name: "Kimi K3",
          context_length: 1_048_576,
        },
      ],
    });

    expect(await discoverProviderModels("kimi-coding")).toEqual([
      {
        id: "k3",
        displayName: "Kimi K3",
        contextWindow: 1_048_576,
      },
    ]);
  });

  test("tolerates context-window field names and rejects invalid windows", async () => {
    stubJsonResponse({
      data: [
        { id: "context-length", context_length: 1_000 },
        { id: "context-window", context_window: 2_000 },
        { id: "max-context-length", max_context_length: 3_000 },
        { id: "zero", context_length: 0 },
        { id: "negative", context_window: -1 },
        { id: "non-numeric", max_context_length: "4000" },
        { id: "missing" },
      ],
    });

    const models = await discoverProviderModels("kimi-coding");
    const windows = Object.fromEntries(models.map((model) => [model.id, model.contextWindow]));

    expect(windows).toEqual({
      "context-length": 1_000,
      "context-window": 2_000,
      "max-context-length": 3_000,
      zero: undefined,
      negative: undefined,
      "non-numeric": undefined,
      missing: undefined,
    });
  });

  test("returns [] without fetching when the provider has no descriptor", async () => {
    const fetchMock = mock(async () => new Response("should not be called"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await discoverProviderModels("openrouter")).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test("returns [] for an unknown provider", async () => {
    expect(await discoverProviderModels("not-a-real-provider")).toEqual([]);
  });

  test("records no-credentials without fetching when credential resolution throws", async () => {
    const fetchMock = mock(async () => new Response("should not be called"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    credentials.getRequestAuth = mock(async () => {
      throw new Error("No offline credentials");
    });

    expect(await discoverProviderModels("kimi-coding")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getDiscoveryFailure("kimi-coding")).toMatchObject({
      kind: "no-credentials",
      provider: "kimi-coding",
      detail: "No offline credentials",
    });
  });

  test.each([
    ["missing", {}],
    ["blank", { "X-API-Key": "   " }],
  ])(
    "records no-credentials without fetching when auth headers are %s",
    async (_label, headers) => {
      const fetchMock = mock(async () => new Response("should not be called"));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      credentials.getRequestAuth = mock(async () => ({
        headers: headers as Record<string, string>,
      }));

      expect(await discoverProviderModels("kimi-coding")).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getDiscoveryFailure("kimi-coding")).toMatchObject({
        kind: "no-credentials",
        provider: "kimi-coding",
      });
    }
  );

  test.each([
    ["authorization", { aUtHoRiZaTiOn: "Bearer offline-test-token" }],
    ["x-api-key", { "X-aPi-KeY": "offline-test-token" }],
    ["api-key", { "aPi-KeY": "offline-test-token" }],
  ])("accepts a case-insensitive %s credential header", async (_label, headers) => {
    credentials.getRequestAuth = mock(async () => ({ headers }));
    const fetchMock = stubJsonResponse({ data: [{ id: "authenticated-model" }] });

    expect((await discoverProviderModels("kimi-coding")).map((model) => model.id)).toEqual([
      "authenticated-model",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getDiscoveryFailure("kimi-coding")).toBeUndefined();
  });

  test("classifies a fetch rejection as unreachable", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("Offline");
    }) as unknown as typeof fetch;

    expect(await discoverProviderModels("kimi-coding")).toEqual([]);
    expect(getDiscoveryFailure("kimi-coding")).toMatchObject({
      kind: "unreachable",
      provider: "kimi-coding",
      detail: "Offline",
    });
  });

  test.each([401, 403])("classifies HTTP %i as unauthorized", async (status) => {
    stubJsonResponse({ error: "rejected test credential" }, status);

    expect(await discoverProviderModels("kimi-coding")).toEqual([]);
    expect(getDiscoveryFailure("kimi-coding")).toMatchObject({
      kind: "unauthorized",
      provider: "kimi-coding",
      status,
      detail: '{"error":"rejected test credential"}',
    });
  });

  test("classifies HTTP 500 as http-error", async () => {
    stubJsonResponse({ error: "unavailable" }, 500);

    expect(await discoverProviderModels("kimi-coding")).toEqual([]);
    expect(getDiscoveryFailure("kimi-coding")).toMatchObject({
      kind: "http-error",
      provider: "kimi-coding",
      status: 500,
    });
  });

  test("classifies a non-JSON 200 response as malformed", async () => {
    globalThis.fetch = mock(
      async () => new Response("{not-json", { status: 200 })
    ) as unknown as typeof fetch;

    expect(await discoverProviderModels("kimi-coding")).toEqual([]);
    expect(getDiscoveryFailure("kimi-coding")).toMatchObject({
      kind: "malformed",
      provider: "kimi-coding",
    });
  });

  test("returns [] when the body has no data array", async () => {
    stubJsonResponse({ models: [{ id: "k3" }] });

    expect(await discoverProviderModels("kimi-coding")).toEqual([]);
  });

  test("classifies a 200 response with an empty data array as empty-models-catalog", async () => {
    stubJsonResponse({ data: [] });

    expect(await discoverProviderModels("kimi-coding")).toEqual([]);
    expect(getDiscoveryFailure("kimi-coding")).toMatchObject({
      kind: "empty-models-catalog",
      provider: "kimi-coding",
    });
  });

  test("skips rows with missing or blank ids", async () => {
    stubJsonResponse({
      data: [{ display_name: "Missing" }, { id: "" }, { id: "   " }, null, "not-an-object"],
    });

    expect(await discoverProviderModels("kimi-coding")).toEqual([]);
  });
});

describe("model discovery cache and context lookup", () => {
  test("retries a failed discovery and clears its failure after success", async () => {
    let fetchCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return new Response(JSON.stringify({ error: "temporary outage" }), { status: 500 });
      }
      return new Response(JSON.stringify({ data: [{ id: "recovered-model" }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    expect(await discoverProviderModels("kimi-coding")).toEqual([]);
    expect(getDiscoveryFailure("kimi-coding")?.kind).toBe("http-error");

    expect(await discoverProviderModels("kimi-coding")).toEqual([
      { id: "recovered-model", displayName: undefined, contextWindow: undefined },
    ]);
    expect(fetchCount).toBe(2);
    expect(getDiscoveryFailure("kimi-coding")).toBeUndefined();
  });

  test("provider invalidation clears only that failure and global invalidation clears all", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ error: "outage" }), { status: 500 })
    ) as unknown as typeof fetch;

    await discoverProviderModels("kimi-coding");
    await discoverProviderModels("qwen-token-plan");
    expect(getDiscoveryFailure("kimi-coding")?.kind).toBe("http-error");
    expect(getDiscoveryFailure("qwen-token-plan")?.kind).toBe("http-error");

    invalidateModelDiscovery("kimi-coding");
    expect(getDiscoveryFailure("kimi-coding")).toBeUndefined();
    expect(getDiscoveryFailure("qwen-token-plan")?.kind).toBe("http-error");

    invalidateModelDiscovery();
    expect(getDiscoveryFailure("qwen-token-plan")).toBeUndefined();
  });

  test("caches within the TTL and provider invalidation forces a refetch", async () => {
    let fetchCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          data: [{ id: `model-${fetchCount}`, context_length: fetchCount * 1_000 }],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    expect((await discoverProviderModels("kimi-coding"))[0]?.id).toBe("model-1");
    expect((await discoverProviderModels("kimi-coding"))[0]?.id).toBe("model-1");
    expect(fetchCount).toBe(1);

    invalidateModelDiscovery("kimi-coding");

    expect((await discoverProviderModels("kimi-coding"))[0]?.id).toBe("model-2");
    expect(fetchCount).toBe(2);
  });

  test("global invalidation clears cached discovery", async () => {
    let fetchCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCount++;
      return new Response(JSON.stringify({ data: [{ id: `model-${fetchCount}` }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    await discoverProviderModels("kimi-coding");
    await discoverProviderModels("kimi-coding");
    expect(fetchCount).toBe(1);

    invalidateModelDiscovery();

    await discoverProviderModels("kimi-coding");
    expect(fetchCount).toBe(2);
  });

  test("finds exact and case-insensitive windows and returns undefined otherwise", async () => {
    const fetchMock = stubJsonResponse({
      data: [
        { id: "k3", context_length: 1_048_576 },
        { id: "window-not-reported", display_name: "Unknown window" },
      ],
    });

    expect(await discoverContextWindow("kimi-coding", "k3")).toBe(1_048_576);
    expect(await discoverContextWindow("kimi-coding", "K3")).toBe(1_048_576);
    expect(await discoverContextWindow("kimi-coding", "not-listed")).toBeUndefined();
    expect(await discoverContextWindow("kimi-coding", "window-not-reported")).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("describeDiscoveryFailure", () => {
  const cases: Array<{
    kind: DiscoveryFailure["kind"];
    failure: DiscoveryFailure;
    substrings: string[];
  }> = [
    {
      kind: "no-credentials",
      failure: { kind: "no-credentials", provider: "test", detail: "missing key" },
      substrings: ["no usable credentials", "missing key"],
    },
    {
      kind: "unauthorized",
      failure: {
        kind: "unauthorized",
        provider: "test",
        endpoint: "https://example.test/models",
        status: 401,
      },
      substrings: ["rejected", "HTTP 401", "https://example.test/models"],
    },
    {
      kind: "http-error",
      failure: {
        kind: "http-error",
        provider: "test",
        endpoint: "https://example.test/models",
        status: 500,
      },
      substrings: ["HTTP 500", "https://example.test/models"],
    },
    {
      kind: "unreachable",
      failure: { kind: "unreachable", provider: "test", endpoint: "https://example.test/models" },
      substrings: ["unreachable", "https://example.test/models"],
    },
    {
      kind: "malformed",
      failure: { kind: "malformed", provider: "test", endpoint: "https://example.test/models" },
      substrings: ["not valid JSON", "https://example.test/models"],
    },
    {
      kind: "empty-models-catalog",
      failure: {
        kind: "empty-models-catalog",
        provider: "test",
        endpoint: "https://example.test/models",
      },
      substrings: ["answered", "listed no models", "https://example.test/models"],
    },
  ];

  test.each(cases)("renders $kind with stable detail", ({ failure, substrings }) => {
    const description = describeDiscoveryFailure(failure);
    for (const substring of substrings) expect(description).toContain(substring);
  });
});

describe("rankDiscoveredModels", () => {
  test("sorts by window descending, then id, without mutating the input", () => {
    const models: DiscoveredModel[] = [
      { id: "no-window" },
      { id: "zeta", contextWindow: 262_144 },
      { id: "alpha", contextWindow: 262_144 },
      { id: "largest", contextWindow: 1_048_576 },
    ];
    const original = [...models];

    const ranked = rankDiscoveredModels(models);

    expect(ranked.map((model) => model.id)).toEqual(["largest", "alpha", "zeta", "no-window"]);
    expect(models).toEqual(original);
    expect(ranked).not.toBe(models);
  });

  test("ranks k3 first for the real Kimi dynamic models catalog", () => {
    const ranked = rankDiscoveredModels([
      { id: "kimi-for-coding-highspeed", contextWindow: 262_144 },
      { id: "k3-256k", contextWindow: 262_144 },
      { id: "k3", contextWindow: 1_048_576 },
      { id: "kimi-for-coding", contextWindow: 262_144 },
    ]);

    expect(ranked[0]?.id).toBe("k3");
  });
});

describe("OpenAI-compatible probe discovery", () => {
  test("uses an authenticated dynamic models catalog and advances past excluded models", async () => {
    // The probe filter requires published chat metadata; isolate its default
    // cache in a child rather than depending on the developer's cloud cache.
    const home = mkdtempSync(join(tmpdir(), "probe-discovery-"));
    try {
      mkdirSync(join(home, ".claudish"));
      const fixture = readFileSync(
        new URL(
          "../test-fixtures/catalog-v3/wire-g-20261012101007285-7770c36e.json",
          import.meta.url
        ),
        "utf8"
      );
      writeFileSync(join(home, ".claudish/cloud-models-catalog-v3.json"), fixture);
      const child = Bun.spawnSync(
        [
          process.execPath,
          "--eval",
          `
        const { registerRuntimeProvider } = await import(${JSON.stringify(new URL("./runtime-providers.ts", import.meta.url).pathname)});
        const { OpenAIProviderTransport } = await import(${JSON.stringify(new URL("./transport/openai.ts", import.meta.url).pathname)});
        const { credentials } = await import(${JSON.stringify(new URL("../auth/credentials/authority.ts", import.meta.url).pathname)});
        const provider = { name: "account-scoped-openai-probe-test", displayName: "Account Scoped Probe Test", transport: "openai", baseUrl: "https://account-scoped.invalid", apiPath: "/v1/chat/completions", apiKeyEnvVar: "ACCOUNT_SCOPED_PROBE_TEST_KEY", apiKeyDescription: "Test", apiKeyUrl: "https://example.invalid", shortcuts: [], legacyPrefixes: [], modelDiscovery: { path: "/v1/models", format: "openai-models-list" }, createHandler: {kind: "none", reason: "virtual", note: "test"}, isDirectApi: true };
        registerRuntimeProvider(provider);
        const originalFetch = globalThis.fetch, originalAuth = credentials.getRequestAuth;
        credentials.getRequestAuth = async () => ({headers: {Authorization: "Bearer fake"}});
        const calls = [];
        globalThis.fetch = async (url, init) => {
          calls.push({ url, headers: Object.fromEntries(new Headers(init.headers)) });
          return Response.json({data: [{id: "grok-4.7", context_length: 1000000}, {id: "grok-build-0.1", context_length: 500000}, {id: "mai-voice-2.1", context_length: 2000000}]});
        };
        try {
          const transport = new OpenAIProviderTransport({...provider, prefixes: []}, "<discover>", "");
          console.log(JSON.stringify({first: await transport.discoverProbeModel(), second: await transport.discoverProbeModel(new Set(["grok-4.7"])), calls}));
        } finally { globalThis.fetch = originalFetch; credentials.getRequestAuth = originalAuth; }
      `,
        ],
        {
          env: {
            PATH: process.env.PATH,
            HOME: home,
            CLAUDISH_DISABLE_KEYCHAIN: "1",
            CLAUDISH_DISABLE_OP: "1",
            CLAUDISH_DISABLE_CATALOG_WARM: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      const result = JSON.parse(child.stdout.toString());
      expect(result.first).toEqual({ model: "grok-4.7" });
      expect(result.second).toEqual({ model: "grok-build-0.1" });
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].headers.authorization).toBe("Bearer fake");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
