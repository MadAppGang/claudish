import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { credentials } from "../auth/credentials/authority.js";
import * as logger from "../logger.js";
import museCatalog from "../test-fixtures/catalog-v3/muse-code-g-20261021063612126-17350b71.json";
import {
  type DiskCacheV3,
  _clearAllModelsCacheMemo,
  writeAllModelsCache,
} from "./all-models-cache.js";
import { _resetCatalogClient } from "./catalog-client.js";
import {
  type ResolvedConnection,
  connectionBaseUrl,
  resolveConnection,
} from "./connection-resolver.js";
import "./model-discovery-builtins.js";
import * as discovery from "./model-discovery.js";
import { getProviderByName, toRemoteProvider } from "./provider-definitions.js";
import type { ProfileContext } from "./provider-profiles.js";
import { resolveRemoteProvider } from "./remote-provider-registry.js";
import { buildKnownWireHandler } from "./wire-handler.js";

// MTL-189 follow-up: B — log ignored overrides and pin absent URLs (generation g-20261021063612126-17350b71).
const originalFetch = globalThis.fetch;
const originalCredential = credentials.get("meta-muse-code");
const originalFetcher = discovery.getModelDiscoveryFetcher("muse-code-models");
let dir: string;
let ctx: ProfileContext;
let connection: ResolvedConnection;
let logSpy: ReturnType<typeof spyOn<typeof logger, "log">>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "muse-wire-pin-"));
  const cachePath = join(dir, "catalog.json");
  _resetCatalogClient();
  _clearAllModelsCacheMemo();
  writeAllModelsCache(structuredClone(museCatalog) as DiskCacheV3, cachePath);
  const resolved = resolveConnection("meta-muse-code", "muse-wonder-full-1.0", cachePath);
  if (!resolved.ok) throw new Error(`Muse connection missing: ${resolved.reason}`);
  connection = resolved.connection;
  ctx = {
    provider: toRemoteProvider(getProviderByName("meta-muse-code")!),
    modelName: connection.externalModelId,
    targetModel: `muse@${connection.externalModelId}`,
    apiKey: "",
    port: 0,
    catalogCachePath: cachePath,
    sharedOpts: {},
  };
  credentials.register({
    catalogName: "meta-muse-code",
    isAvailable: async () => true,
    getRequestAuth: async () => ({
      headers: { Authorization: "Bearer TEST_MUSE_TOKEN" },
      arm: "oauth",
    }),
  });
  discovery.invalidateModelDiscovery("meta-muse-code");
  discovery.registerModelDiscoveryFetcher("muse-code-models", async () => ({
    kind: "models",
    models: [{ id: connection.externalModelId, contextWindow: 1007997, reported: "chat" }],
  }));
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("Unexpected network in Muse pin test");
    },
    { preconnect: () => {} }
  ) as typeof fetch;
  logSpy = spyOn(logger, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  globalThis.fetch = originalFetch;
  if (originalCredential) credentials.register(originalCredential);
  credentials.invalidate("meta-muse-code");
  if (originalFetcher) discovery.registerModelDiscoveryFetcher("muse-code-models", originalFetcher);
  discovery.invalidateModelDiscovery("meta-muse-code");
  _resetCatalogClient();
  _clearAllModelsCacheMemo();
  rmSync(dir, { recursive: true, force: true });
});

test("logs that the user base URL was ignored for meta-muse-code", async () => {
  ctx.provider = { ...ctx.provider, baseUrl: "https://override.invalid/v1" };
  if (connection.wire.status !== "known") throw new Error("Expected known Muse wire");
  const handler = buildKnownWireHandler(ctx, "meta-muse-code", connection, connection.wire);
  try {
    expect(handler).not.toBeNull();
    expect(logSpy.mock.calls.map(([line]) => line)).toContainEqual(
      expect.stringMatching(/(?=.*meta-muse-code)(?=.*base[ -]?url)(?=.*ignor)/i)
    );
  } finally {
    await handler?.shutdown();
  }
});

test("does not log an ignored user base URL when Muse uses its definition default", async () => {
  const resolved = resolveRemoteProvider("muse@muse-wonder-full-1.0");
  if (!resolved) throw new Error("Expected resolved Muse provider");
  ctx = { ...ctx, provider: resolved.provider, modelName: resolved.modelName };
  expect(ctx.provider.baseUrl).toBe(getProviderByName("meta-muse-code")!.baseUrl);
  if (connection.wire.status !== "known") throw new Error("Expected known Muse wire");
  const handler = buildKnownWireHandler(ctx, "meta-muse-code", connection, connection.wire);
  try {
    expect(handler).not.toBeNull();
    expect(logSpy.mock.calls.map(([line]) => line)).not.toContainEqual(
      expect.stringMatching(/(?=.*meta-muse-code)(?=.*base[ -]?url)(?=.*ignor)/i)
    );
  } finally {
    await handler?.shutdown();
  }
});

test("builds a pinned Responses handler when the registry publishes no base URL", async () => {
  const withoutBase = structuredClone(connection);
  const responses: { baseUrl?: string } = withoutBase.profile.apis.responses!;
  delete responses.baseUrl;
  expect(connectionBaseUrl(withoutBase, "responses")).toBeUndefined();
  if (withoutBase.wire.status !== "known") throw new Error("Expected known Muse wire");
  const urls: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
    { preconnect: () => {} }
  ) as typeof fetch;
  const handler = buildKnownWireHandler(ctx, "meta-muse-code", withoutBase, withoutBase.wire);
  try {
    expect(handler).not.toBeNull();
    if (!handler) return;
    const app = new Hono();
    app.post("/", (c) =>
      handler.handle(c, {
        model: ctx.targetModel,
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "PONG" }],
      })
    );
    const response = await app.request("http://localhost/", { method: "POST" });
    await response.text();
    expect(response.status).toBe(200);
    expect(urls).toEqual(["https://api.meta.ai/v1/responses"]);
  } finally {
    await handler?.shutdown();
  }
});
