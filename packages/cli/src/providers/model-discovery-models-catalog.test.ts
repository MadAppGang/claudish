/**
 * `discoverProviderModelsCatalog` — the discriminated outcome behind the empty array.
 *
 * `discoverProviderModels` answers `[]` for six structurally different things,
 * and its callers could not tell them apart. These tests pin which outcome each
 * condition produces, and in particular the three the fetcher half could not
 * express at all before: a failing fetcher, a reachable-but-empty one, and a
 * declared format nothing claims.
 *
 * Offline by construction: `globalThis.fetch` and `credentials.getRequestAuth`
 * are replaced directly rather than through `mock.module()`, which bleeds into
 * sibling Bun test files.
 *
 * Run: bun test packages/cli/src/providers/model-discovery-models-catalog.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { credentials } from "../auth/credentials/authority.js";
import {
  type FetcherResult,
  type ModelDiscoveryDescriptor,
  discoverProviderModels,
  discoverProviderModelsCatalog,
  getDiscoveryFailure,
  invalidateModelDiscovery,
  registerModelDiscoveryFetcher,
} from "./model-discovery.js";
import type { ProviderDefinition } from "./provider-definitions.js";
import { clearRuntimeRegistry, registerRuntimeProvider } from "./runtime-providers.js";

const realFetch = globalThis.fetch;
const realGetRequestAuth = credentials.getRequestAuth;

/**
 * A provider definition that can never reach the network by accident: its host
 * is `.invalid`, it builds no handler, and every test that lets it get as far as
 * a request stubs `fetch` first.
 */
function defineProvider(
  name: string,
  overrides: Partial<ProviderDefinition> = {}
): ProviderDefinition {
  return {
    name,
    displayName: `Models Catalog Test (${name})`,
    transport: "openai",
    baseUrl: "https://models-catalog-test.invalid",
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "MODELS_CATALOG_TEST_API_KEY",
    apiKeyDescription: "Offline test key",
    apiKeyUrl: "https://models-catalog-test.invalid/key",
    shortcuts: [],
    legacyPrefixes: [],
    modelDiscovery: { path: "/v1/models", format: "openai-models-list" },
    createHandler: { kind: "none", reason: "virtual", note: "Offline test fixture" },
    isDirectApi: true,
    ...overrides,
  };
}

/** A format name no shipped provider declares, so the registry stays honest. */
function testFormat(name: string): ModelDiscoveryDescriptor["format"] {
  return name as ModelDiscoveryDescriptor["format"];
}

function stubResponse(body: string, status = 200): void {
  globalThis.fetch = mock(
    async () => new Response(body, { status, headers: { "Content-Type": "application/json" } })
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  invalidateModelDiscovery();
  clearRuntimeRegistry();
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

describe("discoverProviderModelsCatalog — the GET half", () => {
  test("a non-empty dynamic models catalog is `served`, and `served.models` is never empty", async () => {
    stubResponse(JSON.stringify({ data: [{ id: "k3", context_length: 1_048_576 }] }));

    const outcome = await discoverProviderModelsCatalog("kimi-coding");

    expect(outcome.kind).toBe("served");
    if (outcome.kind !== "served") throw new Error("unreachable");
    expect(outcome.models.map((m) => m.id)).toEqual(["k3"]);
    expect(outcome.models.length).toBeGreaterThan(0);
    expect(getDiscoveryFailure("kimi-coding")).toBeUndefined();
  });

  test.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [500, "http-error"],
    [404, "http-error"],
  ] as const)("HTTP %i is failed{%s}", async (status, kind) => {
    stubResponse(JSON.stringify({ error: "rejected" }), status);

    const outcome = await discoverProviderModelsCatalog("kimi-coding");

    expect(outcome).toMatchObject({
      kind: "failed",
      failure: { kind, provider: "kimi-coding", status },
    });
  });

  test("a fetch rejection is failed{unreachable} carrying the message", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("Offline");
    }) as unknown as typeof fetch;

    expect(await discoverProviderModelsCatalog("kimi-coding")).toMatchObject({
      kind: "failed",
      failure: { kind: "unreachable", provider: "kimi-coding", detail: "Offline" },
    });
  });

  test("a non-JSON 200 is failed{malformed}", async () => {
    globalThis.fetch = mock(
      async () => new Response("{not-json", { status: 200 })
    ) as unknown as typeof fetch;

    expect(await discoverProviderModelsCatalog("kimi-coding")).toMatchObject({
      kind: "failed",
      failure: { kind: "malformed", provider: "kimi-coding" },
    });
  });

  test("an empty data array is failed{empty-models-catalog}, not `served` with []", async () => {
    stubResponse(JSON.stringify({ data: [] }));

    const outcome = await discoverProviderModelsCatalog("kimi-coding");

    expect(outcome).toMatchObject({
      kind: "failed",
      failure: { kind: "empty-models-catalog", provider: "kimi-coding" },
    });
    // The GET half has always had a URL to name, and still does.
    if (outcome.kind !== "failed") throw new Error("unreachable");
    expect(outcome.failure.endpoint).toContain("/v1/models");
  });

  test("blank credentials are failed{no-credentials} without a request", async () => {
    const fetchMock = mock(async () => new Response("should not be called"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    credentials.getRequestAuth = mock(async () => ({ headers: { authorization: "   " } }));

    expect(await discoverProviderModelsCatalog("kimi-coding")).toMatchObject({
      kind: "failed",
      failure: { kind: "no-credentials", provider: "kimi-coding" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('authScheme "none" has no auth header BY DECLARATION, so the request is made', async () => {
    // What the authority really answers for the scheme: static headers, no auth
    // (`api-key-credential.ts:362`). Under the blank-credential gate above that
    // is indistinguishable from an unset key, so a keyless endpoint was told it
    // had no credential — a variable to go and find that it correctly lacks.
    credentials.getRequestAuth = mock(async () => ({ headers: {} }));
    stubResponse(JSON.stringify({ data: [{ id: "local-model" }] }));
    registerRuntimeProvider(
      defineProvider("models-catalog-keyless-test", {
        authScheme: "none",
        modelDiscovery: { path: "/models", format: "openai-models-list" },
      })
    );

    const outcome = await discoverProviderModelsCatalog("models-catalog-keyless-test");

    expect(outcome.kind).toBe("served");
    if (outcome.kind !== "served") throw new Error("unreachable");
    expect(outcome.models.map((m) => m.id)).toEqual(["local-model"]);
    expect(getDiscoveryFailure("models-catalog-keyless-test")).toBeUndefined();
  });
});

describe("discoverProviderModelsCatalog — `unsupported` is not a failure", () => {
  test.each(["openrouter", "not-a-real-provider"])(
    "%s declares no discovery, so nothing is attempted or recorded",
    async (provider) => {
      const fetchMock = mock(async () => new Response("should not be called"));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      expect(await discoverProviderModelsCatalog(provider)).toEqual({
        kind: "unsupported",
        reason: "no-descriptor",
      });
      expect(fetchMock).not.toHaveBeenCalled();
      // Nothing to explain to the user, so nothing is recorded for the classic
      // path's warning to pick up either.
      expect(getDiscoveryFailure(provider)).toBeUndefined();
    }
  );

  test("a declared descriptor with no resolvable base URL is failed{unreachable}, naming where to fix it", async () => {
    // Not `unsupported`: the provider DID declare discovery, so this is a setup
    // fault the user can fix — reporting it silently read as "the plan lists no
    // models". With no override variables to name, the detail names the field.
    const provider = defineProvider("models-catalog-no-base-url-test", {
      baseUrl: "",
      baseUrlEnvVars: [],
    });
    registerRuntimeProvider(provider);

    expect(await discoverProviderModelsCatalog(provider.name)).toEqual({
      kind: "failed",
      failure: {
        kind: "unreachable",
        provider: provider.name,
        detail: "no base URL resolved — check the provider's baseUrl",
      },
    });
    expect(getDiscoveryFailure(provider.name)?.kind).toBe("unreachable");
  });

  test("a declared format nothing claims is unsupported{no-fetcher}, not an empty dynamic models catalog", async () => {
    // This is a PACKAGING bug — a definition opted into a format whose owner was
    // never bundled. It used to be recorded as `empty-models-catalog`, i.e. as a claim
    // about the user's subscription.
    const provider = defineProvider("models-catalog-unclaimed-format-test", {
      modelDiscovery: { path: "", format: testFormat("models-catalog-unclaimed-format") },
    });
    registerRuntimeProvider(provider);

    expect(await discoverProviderModelsCatalog(provider.name)).toEqual({
      kind: "unsupported",
      reason: "no-fetcher",
    });
    expect(getDiscoveryFailure(provider.name)).toBeUndefined();
  });
});

describe("discoverProviderModelsCatalog — the fetcher half can finally classify", () => {
  test("a fetcher reporting failure surfaces as failed with ITS kind, not empty-models-catalog", async () => {
    const format = testFormat("models-catalog-failing-fetcher");
    registerModelDiscoveryFetcher(format, async (): Promise<FetcherResult> => {
      return {
        kind: "failed",
        failure: {
          kind: "unreachable",
          endpoint: "http://localhost:11434/api/tags",
          detail: "connect ECONNREFUSED",
        },
      };
    });
    const provider = defineProvider("models-catalog-failing-fetcher-test", {
      modelDiscovery: { path: "", format },
    });
    registerRuntimeProvider(provider);

    const outcome = await discoverProviderModelsCatalog(provider.name);

    expect(outcome).toMatchObject({
      kind: "failed",
      failure: {
        kind: "unreachable",
        // The caller fills in the provider — the fetcher cannot know its own
        // registration name.
        provider: provider.name,
        endpoint: "http://localhost:11434/api/tags",
        detail: "connect ECONNREFUSED",
      },
    });
    expect(getDiscoveryFailure(provider.name)?.kind).toBe("unreachable");
  });

  test("a fetcher reporting no-credentials earns the credential kind", async () => {
    const format = testFormat("models-catalog-logged-out-fetcher");
    registerModelDiscoveryFetcher(format, async () => ({
      kind: "failed" as const,
      failure: { kind: "no-credentials" as const, detail: "no OAuth token" },
    }));
    registerRuntimeProvider(
      defineProvider("models-catalog-logged-out-test", { modelDiscovery: { path: "", format } })
    );

    expect(await discoverProviderModelsCatalog("models-catalog-logged-out-test")).toMatchObject({
      kind: "failed",
      failure: { kind: "no-credentials", provider: "models-catalog-logged-out-test" },
    });
  });

  test("a reachable-but-empty fetcher gives empty-models-catalog WITH the endpoint it asked", async () => {
    const format = testFormat("models-catalog-empty-fetcher");
    registerModelDiscoveryFetcher(format, async () => ({
      kind: "models" as const,
      models: [],
      endpoint: "http://localhost:11434/api/tags",
    }));
    registerRuntimeProvider(
      defineProvider("models-catalog-empty-fetcher-test", { modelDiscovery: { path: "", format } })
    );

    expect(await discoverProviderModelsCatalog("models-catalog-empty-fetcher-test")).toEqual({
      kind: "failed",
      failure: {
        kind: "empty-models-catalog",
        provider: "models-catalog-empty-fetcher-test",
        // Before `FetcherResult`, this half recorded empty-models-catalog with NO
        // endpoint, so any copy naming one rendered the literal `undefined`.
        endpoint: "http://localhost:11434/api/tags",
      },
    });
  });

  test("a fetcher returning models is served", async () => {
    const format = testFormat("models-catalog-serving-fetcher");
    registerModelDiscoveryFetcher(format, async () => ({
      kind: "models" as const,
      models: [{ id: "llama3.2", supportsTools: true }],
      endpoint: "http://localhost:11434/api/tags",
    }));
    registerRuntimeProvider(
      defineProvider("models-catalog-serving-fetcher-test", {
        modelDiscovery: { path: "", format },
      })
    );

    expect(await discoverProviderModelsCatalog("models-catalog-serving-fetcher-test")).toEqual({
      kind: "served",
      models: [{ id: "llama3.2", supportsTools: true }],
    });
  });

  test("NEVER REJECTS: a throwing fetcher resolves to failed{unreachable}", async () => {
    const format = testFormat("models-catalog-throwing-fetcher");
    registerModelDiscoveryFetcher(format, async () => {
      throw new Error("protobuf decode blew up");
    });
    registerRuntimeProvider(
      defineProvider("models-catalog-throwing-test", { modelDiscovery: { path: "", format } })
    );

    // `.resolves` is the assertion, not a convenience: before the wrapping try,
    // this rejection propagated out of the picker and, behind a live renderer
    // with no stderr, would leave a progress indicator running forever.
    await expect(
      discoverProviderModelsCatalog("models-catalog-throwing-test")
    ).resolves.toMatchObject({
      kind: "failed",
      failure: {
        kind: "unreachable",
        provider: "models-catalog-throwing-test",
        detail: "protobuf decode blew up",
      },
    });
  });
});

describe("discoverProviderModels stays the fail-soft wrapper", () => {
  test.each([
    ["served", JSON.stringify({ data: [{ id: "k3" }] }), 200, ["k3"]],
    ["failed", JSON.stringify({ error: "nope" }), 401, []],
    ["empty-models-catalog", JSON.stringify({ data: [] }), 200, []],
  ] as const)("%s → the models or []", async (_label, body, status, ids) => {
    stubResponse(body, status);

    expect((await discoverProviderModels("kimi-coding")).map((m) => m.id)).toEqual([...ids]);
  });

  test("unsupported → []", async () => {
    expect(await discoverProviderModels("openrouter")).toEqual([]);
  });

  test("both entry points share ONE cache, so asking twice costs one request", async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      return new Response(JSON.stringify({ data: [{ id: `model-${calls}` }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const first = await discoverProviderModelsCatalog("kimi-coding");
    const second = await discoverProviderModels("kimi-coding");

    expect(calls).toBe(1);
    expect(first).toMatchObject({ kind: "served" });
    expect(second.map((m) => m.id)).toEqual(["model-1"]);
  });
});
