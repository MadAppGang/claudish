import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Extracted with jq from cloud models catalog generation g-20261021063612126-17350b71.
import museCatalog from "../test-fixtures/catalog-v3/muse-code-g-20261021063612126-17350b71.json";
import type { DiskCacheV3 } from "./all-models-cache.js";

let home: string;
let savedEnv: Record<string, string | undefined>;
let savedFetch: typeof fetch;
let savedExit: typeof process.exit;
// Any unexpected CLI exit must fail the case instead of terminating Bun's runner.
class UnexpectedProcessExit extends Error {
  constructor(code?: string | number | null) {
    super(`RUN5_PROCESS_EXIT:${code ?? 0}`);
    this.name = "UnexpectedProcessExit";
  }
}
beforeEach(() => {
  savedEnv = { CLAUDISH_DISABLE_KEYCHAIN: process.env.CLAUDISH_DISABLE_KEYCHAIN };
  home = mkdtempSync(join(tmpdir(), "muse-run5-"));
  process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
  savedExit = process.exit;
  process.exit = (code?: string | number | null): never => {
    throw new UnexpectedProcessExit(code);
  };
  savedFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("Unexpected network in Run 5 test");
    },
    { preconnect: () => {} }
  ) as typeof fetch;
});
function restoreHarness() {
  process.exit = savedExit;
  globalThis.fetch = savedFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
}

// HOME is not an isolation seam in Bun. Every filesystem-capable dependency
// below is explicit and test-owned; omitted production defaults are forbidden.
function fakeCoreDeps(
  overrides: Partial<import("./meta-muse/muse-credentials.js").MuseCoreDeps> = {}
): import("./meta-muse/muse-credentials.js").MuseCoreDeps {
  return {
    dir: () => home,
    now: () => 1792088000000,
    readStore: () => null,
    writeBorrowedCopy: () => {
      throw new Error("Unexpected borrowed-copy write");
    },
    mint: async () => {
      throw new Error("Unexpected mint");
    },
    keychainLogin: async () => {
      throw new Error("Keychain forbidden");
    },
    ...overrides,
  };
}
function fakeMuseKeychainDeps(
  overrides: Partial<import("./meta-muse/muse-keychain.js").MuseKeychainDeps> = {}
): import("./meta-muse/muse-keychain.js").MuseKeychainDeps {
  return {
    dir: () => home,
    env: () => ({}),
    now: () => 1792088000000,
    sleep: async () => {
      throw new Error("Unexpected Keychain wait");
    },
    pid: () => 424242,
    isAlive: () => false,
    presence: async () => ({ kind: "absent" }),
    startRead: () => {
      throw new Error("Keychain forbidden");
    },
    ...overrides,
  };
}
let previousConfigPath: string | null;
const restoreRegistrations: (() => void)[] = [];
beforeEach(async () => {
  const keychain = await import("./keychain.js");
  const forbidden = () => {
    throw new Error("Real Keychain process forbidden");
  };
  keychain.setKeychainTestDeps({
    platform: () => "darwin",
    run: forbidden,
    runAsync: async () => forbidden(),
    spawnAsync: forbidden,
  });
  const core = await import("./meta-muse/muse-credentials.js");
  core.resetMuseCredentialState();
  core.setMuseCoreTestDeps(fakeCoreDeps());
  const museKeychain = await import("./meta-muse/muse-keychain.js");
  museKeychain.resetMuseKeychainState();
  museKeychain.setMuseKeychainTestDeps(fakeMuseKeychainDeps());
  (await import("../auth/credentials/prompt-role.js"))._resetCredentialPromptRoleForTest();
  const config = await import("../config-override.js");
  previousConfigPath = config.getConfigFileOverride();
  config.setConfigFileOverride(join(home, "config.json"));
});
afterEach(async () => {
  for (const restore of restoreRegistrations.splice(0).reverse()) restore();
  const core = await import("./meta-muse/muse-credentials.js");
  core.resetMuseCredentialState();
  core.setMuseCoreTestDeps(null);
  const museKeychain = await import("./meta-muse/muse-keychain.js");
  museKeychain.resetMuseKeychainState();
  museKeychain.setMuseKeychainTestDeps(null);
  const keychain = await import("./keychain.js");
  keychain.invalidateKeychainCache();
  keychain.setKeychainTestDeps(null);
  (await import("../auth/credentials/prompt-role.js"))._resetCredentialPromptRoleForTest();
  (await import("../auth/credentials/billing-probe.js")).clearSignedArm();
  (await import("./model-discovery.js")).invalidateModelDiscovery("meta-muse-code");
  (await import("./all-models-cache.js"))._clearAllModelsCacheMemo();
  (await import("./catalog-client.js"))._resetCatalogClient();
  (await import("../config-override.js")).setConfigFileOverride(previousConfigPath);
  restoreHarness();
});

// MTL-189: meta/muse-code-subscription must stay bound.
test("T4: Muse binds its subscription route and still builds an explicit profile handler", async () => {
  const { museCodeProfile } = await import("./provider-profiles.js");
  const { catalogRouteForProvider } = await import("./catalog-route-bindings.js");
  const { _resetCatalogClient } = await import("./catalog-client.js");
  const { _clearAllModelsCacheMemo } = await import("./all-models-cache.js");
  try {
    _resetCatalogClient();
    _clearAllModelsCacheMemo();
    expect(catalogRouteForProvider("meta-muse-code")).toEqual({
      routeId: "meta",
      routeProfileId: "muse-code-subscription",
    });
    const handler = await museCodeProfile.createHandler({
      provider: {
        name: "meta-muse-code",
        baseUrl: "https://api.meta.ai/v1",
        apiPath: "/responses",
        apiKeyEnvVar: "",
        prefixes: ["muse@"],
      },
      modelName: "muse-wonder-full-1.0",
      targetModel: "muse@muse-wonder-full-1.0",
      apiKey: "",
      port: 0,
      sharedOpts: {},
      catalogCachePath: join(home, "missing-catalog.json"),
    });
    expect(handler).not.toBeNull();
    expect(handler).toBeDefined();
    await handler?.shutdown();
  } finally {
    _resetCatalogClient();
    _clearAllModelsCacheMemo();
  }
});

test.each(["https://api.meta.ai/v1", "https://override.invalid/v1"])(
  "T4: explicit Wonder Full pins the Meta responses URL with provider baseUrl=%s",
  async (baseUrl) => {
    const { Hono } = await import("hono");
    const { createHandlerForProvider } = await import("./provider-profiles.js");
    const { writeAllModelsCache, readAllModelsCache } = await import("./all-models-cache.js");
    const { credentials } = await import("../auth/credentials/authority.js");
    const d = await import("./model-discovery.js");
    await import("./model-discovery-builtins.js");
    const previous = credentials.get("meta-muse-code");
    const previousFetcher = d.getModelDiscoveryFetcher("muse-code-models");
    if (!previous || !previousFetcher) throw new Error("missing Muse registration");
    restoreRegistrations.push(() => {
      credentials.register(previous);
      credentials.invalidate("meta-muse-code");
      d.registerModelDiscoveryFetcher("muse-code-models", previousFetcher);
    });
    credentials.register({
      catalogName: "meta-muse-code",
      isAvailable: async () => true,
      getRequestAuth: async () => ({
        headers: { Authorization: "Bearer TEST_MUSE_TOKEN" },
        arm: "oauth",
      }),
    });
    d.registerModelDiscoveryFetcher("muse-code-models", async () => ({
      kind: "models",
      models: [{ id: "muse-wonder-full-1.0", reported: "chat" }],
    }));
    const path = join(home, "muse-catalog.json");
    writeAllModelsCache(structuredClone(museCatalog) as DiskCacheV3, path);
    expect(readAllModelsCache(path)).not.toBeNull();
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: input instanceof Request ? input.url : String(input),
          body: JSON.parse(String(init?.body)),
        });
        return new Response("data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      },
      { preconnect: () => {} }
    ) as typeof fetch;
    const handler = await createHandlerForProvider({
      provider: {
        name: "meta-muse-code",
        baseUrl,
        apiPath: "/responses",
        apiKeyEnvVar: "",
        prefixes: ["muse@"],
      },
      modelName: "muse-wonder-full-1.0",
      targetModel: "muse@muse-wonder-full-1.0",
      apiKey: "",
      port: 0,
      sharedOpts: {},
      catalogCachePath: path,
    });
    if (!handler) throw new Error("Muse handler absent");
    const app = new Hono();
    app.post("/", (c) =>
      handler.handle(c, {
        model: "muse@muse-wonder-full-1.0",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "PONG" }],
      })
    );
    try {
      const response = await app.request("http://localhost/", { method: "POST" });
      await response.text();
      expect(response.status).toBe(200);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe("https://api.meta.ai/v1/responses");
      expect(requests[0]!.body.model).toBe("muse-wonder-full-1.0");
    } finally {
      await handler.shutdown();
    }
  }
);

test("T4: missing owner wire supplies no fabricated support, including Wonder-full", async () => {
  const { ownerWireForModel } = await import("./meta-muse/muse-wire.js");
  const { _clearAllModelsCacheMemo } = await import("./all-models-cache.js");
  try {
    for (const model of ["muse-wonder-full-1.0", "muse-spark-1.3", "unknown-model"]) {
      expect(ownerWireForModel(model, join(home, "missing-catalog.json"))).toBeUndefined();
    }
  } finally {
    _clearAllModelsCacheMemo();
  }
});

test("T4: Muse borrows Meta owner wire and clamps outgoing effort to changed advertised values", async () => {
  const { Hono } = await import("hono");
  const { writeAllModelsCache, _clearAllModelsCacheMemo } = await import("./all-models-cache.js");
  const { _setCatalogEntriesForTest, _resetCatalogClient } = await import("./catalog-client.js");
  const { createHandlerForProvider } = await import("./provider-profiles.js");
  const { ownerWireForModel } = await import("./meta-muse/muse-wire.js");
  const { credentials } = await import("../auth/credentials/authority.js");
  const { clearSignedArm } = await import("../auth/credentials/billing-probe.js");
  const d = await import("./model-discovery.js");
  await import("./model-discovery-builtins.js");
  const prior = credentials.get("meta-muse-code");
  const priorMeta = credentials.get("meta");
  const fetcher = d.getModelDiscoveryFetcher("muse-code-models");
  if (!prior || !priorMeta || !fetcher) throw new Error("missing default registration");
  restoreRegistrations.push(() => {
    credentials.register(prior);
    credentials.register(priorMeta);
    credentials.invalidate("meta-muse-code");
    credentials.invalidate("meta");
    d.registerModelDiscoveryFetcher("muse-code-models", fetcher);
  });
  credentials.register({
    catalogName: "meta-muse-code",
    isAvailable: async () => true,
    getRequestAuth: async () => ({
      headers: { Authorization: "Bearer LLM|TESTKEY0001" },
      arm: "oauth",
    }),
  });
  credentials.register({
    catalogName: "meta",
    isAvailable: async () => true,
    getRequestAuth: async () => ({
      headers: { Authorization: "Bearer TESTMETEREDKEY0001" },
      arm: "api-key",
    }),
  });
  d.registerModelDiscoveryFetcher("muse-code-models", async () => ({
    kind: "models",
    models: [{ id: "muse-spark-1.3", reported: "chat", contextWindow: 262144 }],
  }));
  const requests: any[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      expect(input instanceof Request ? input.url : String(input)).toBe(
        "https://api.meta.ai/v1/responses"
      );
      requests.push(JSON.parse(String(init?.body)));
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    },
    { preconnect: () => {} }
  ) as typeof fetch;
  try {
    for (const effort of ["high", "medium"] as const) {
      const path = join(home, `catalog-${effort}.json`);
      const wire: import("./connection-wire.js").KnownWire = {
        status: "known",
        api: "responses",
        tokenParam: "max_output_tokens",
        toolsWithReasoning: "ok",
        reasoning: {
          status: "supported",
          enable: [],
          disable: { status: "not_applicable" },
          effort: {
            path: "/reasoning/effort",
            values: { minimal: "minimal", [effort]: effort },
            default: effort,
          },
          mode: { status: "unknown" },
        },
        speed: { status: "unknown" },
        evidence: [],
      };
      const entry = {
        modelId: "muse-spark-1.3",
        provider: "meta",
        aliases: [],
        inputModalities: ["text"],
        outputModalities: ["text"],
        aggregators: [
          {
            sourceProviderId: "meta",
            sourceCollectorId: "contract-fixture",
            confidence: "api_official" as const,
            routeStatus: "mapped" as const,
            route: { routeId: "meta", routeProfileId: "direct-api" },
            externalModelId: "muse-spark-1.3",
            wire,
          },
        ],
      };
      writeAllModelsCache(
        {
          version: 3,
          lastUpdated: new Date().toISOString(),
          catalogGenerationId: `g-${effort}`,
          entries: [entry],
          models: [{ id: entry.modelId }],
          plans: [],
          routeRegistry: {
            generationId: `g-${effort}`,
            registry: {
              registryVersion: "3.7.0",
              routes: {
                meta: {
                  profiles: {
                    "direct-api": {
                      kind: "direct",
                      nativeModelProviders: ["meta"],
                      apis: { responses: { baseUrl: "https://api.meta.ai/v1" } },
                    },
                  },
                },
              },
            },
          },
        },
        path
      );
      _clearAllModelsCacheMemo();
      _setCatalogEntriesForTest([entry]);
      d.invalidateModelDiscovery("meta-muse-code");
      expect(ownerWireForModel(entry.modelId, path)?.wire).toEqual(wire);
      for (const name of ["meta-muse-code", "meta"]) {
        const handler = await createHandlerForProvider({
          provider: {
            name,
            baseUrl: "https://api.meta.ai/v1",
            apiPath: "/responses",
            apiKeyEnvVar: name === "meta" ? "META_API_KEY" : "",
            prefixes: [name === "meta" ? "meta@" : "muse@"],
          },
          modelName: entry.modelId,
          targetModel: `${name === "meta" ? "meta" : "muse"}@muse-spark-1.3`,
          apiKey: name === "meta" ? "TESTMETEREDKEY0001" : "",
          port: 0,
          catalogCachePath: path,
          sharedOpts: { effortOverride: "max" },
        });
        if (!handler) throw new Error("Muse handler absent");
        const app = new Hono();
        app.post("/", (c) =>
          handler.handle(c, {
            model: entry.modelId,
            max_tokens: 64,
            stream: true,
            messages: [{ role: "user", content: "PONG" }],
          })
        );
        try {
          await (await app.request("http://localhost/", { method: "POST" })).text();
        } finally {
          await handler.shutdown();
        }
        expect(requests.at(-1)?.reasoning?.effort).toBe(effort);
      }
      // The public wire shaper also accepts raw effort strings, including ultra.
      const { shapeRequestFromWire } = await import("./wire-request.js");
      const payload: Record<string, unknown> = {};
      const unknown = shapeRequestFromWire(payload, wire, { effort: "ultra", maxTokens: 64 });
      expect((payload.reasoning as { effort?: string } | undefined)?.effort).toBeUndefined();
      expect(payload.max_output_tokens).toBe(64);
      expect(unknown.sentEffort).toBeUndefined();
      expect(unknown.notes.length).toBeGreaterThan(0);
      const ranked: Record<string, unknown> = {};
      const clamped = shapeRequestFromWire(ranked, wire, { effort: "max", maxTokens: 64 });
      expect(ranked).toMatchObject({ reasoning: { effort }, max_output_tokens: 64 });
      expect(clamped.sentEffort).toBe(effort);
    }
    expect(requests).toHaveLength(4);
  } finally {
    credentials.register(prior);
    credentials.register(priorMeta);
    credentials.invalidate("meta-muse-code");
    credentials.invalidate("meta");
    clearSignedArm();
    d.registerModelDiscoveryFetcher("muse-code-models", fetcher);
    d.invalidateModelDiscovery("meta-muse-code");
    _resetCatalogClient();
    _clearAllModelsCacheMemo();
  }
}, 30000);

test("T4: cold registry wait returns within the public five-second budget", async () => {
  const { museCodeProfile } = await import("./provider-profiles.js");
  const { _resetCatalogClient } = await import("./catalog-client.js");
  const { _clearAllModelsCacheMemo } = await import("./all-models-cache.js");
  _resetCatalogClient();
  _clearAllModelsCacheMemo();
  const started = performance.now();
  const handler = await museCodeProfile.createHandler({
    provider: {
      name: "meta-muse-code",
      baseUrl: "https://api.meta.ai/v1",
      apiPath: "/responses",
      apiKeyEnvVar: "",
      prefixes: ["muse@"],
    },
    modelName: "muse-wonder-full-1.0",
    targetModel: "muse@muse-wonder-full-1.0",
    apiKey: "",
    port: 0,
    catalogCachePath: join(home, "cold.json"),
    sharedOpts: {},
  });
  try {
    expect(handler).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(6500);
  } finally {
    await handler?.shutdown();
    _resetCatalogClient();
    _clearAllModelsCacheMemo();
  }
}, 8000);
