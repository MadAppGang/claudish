import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentials } from "./auth/credentials/authority.js";
import type { CredentialProvider } from "./auth/credentials/types.js";
import { computeMainThreadContextWindow } from "./claude-runner.js";
import { getConfigFileOverride, setConfigFileOverride } from "./config-override.js";
import {
  type DiskCacheV3,
  _clearAllModelsCacheMemo,
  writeAllModelsCache,
} from "./providers/all-models-cache.js";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "./providers/catalog-client.js";
import { CATALOG_ROUTE_BINDINGS } from "./providers/catalog-route-bindings.js";
import "./providers/model-discovery-builtins.js";
import * as discovery from "./providers/model-discovery.js";
import * as routing from "./providers/routing-rules.js";
import kimiCatalog from "./test-fixtures/catalog-v3/kimi-k3-g-20261021063612126-17350b71.json";
import museCatalog from "./test-fixtures/catalog-v3/muse-code-g-20261021063612126-17350b71.json";
import type { ClaudishConfig } from "./types.js";

// MTL-189 follow-up: A — use routed wire ids for windows (generation g-20261021063612126-17350b71).
// Extracted from ~/.claudish/cloud-models-catalog-v3.json, generation g-20261021063612126-17350b71:
// jq '[.entries[] | select(.modelId == "qwen3.8-flash-next" or .modelId == "qwen3.8-flash")
//   | {modelId, provider, aliases, contextWindow,
//      aggregators: [.aggregators[] | select(.route.routeId == "openrouter")]}]'
const qwenCollisionEntries = [
  {
    modelId: "qwen3.8-flash",
    provider: "qwen",
    aliases: [],
    contextWindow: 1000000,
    aggregators: [],
  },
  {
    modelId: "qwen3.8-flash-next",
    provider: "qwen",
    aliases: ["Qwen/Qwen3.8-Flash-Next"],
    contextWindow: 1000000,
    aggregators: [
      {
        sourceProviderId: "openrouter",
        sourceCollectorId: "openrouter-api",
        confidence: "aggregator_reported",
        routeStatus: "mapped",
        route: { routeId: "openrouter", routeProfileId: "gateway" },
        externalModelId: "qwen/qwen3.8-flash",
        pricing: { type: "flat", input: 0.15, output: 0.47, cachedRead: 0.016 },
        reasoning: {
          request: {
            status: "supported",
            api: "chat-completions",
            evidenceSourceUrl: "https://openrouter.ai/api/v1/models",
            enable: [{ path: "/reasoning/enabled", value: true }],
          },
        },
        wire: {
          status: "known",
          api: "chat-completions",
          tokenParam: "max_tokens",
          toolsWithReasoning: "ok",
          reasoning: {
            status: "supported",
            enable: [{ path: "/reasoning/enabled", value: true }],
            disable: { status: "unknown" },
            effort: { status: "not_applicable" },
            mode: { status: "not_applicable" },
          },
          speed: { status: "not_applicable" },
          evidence: [
            {
              evidenceId: "wev_01b429cd2f66760ae2b394fbab32095c",
              method: "api",
              sourceUrl: "https://openrouter.ai/api/v1/models",
              observedAt: "2026-10-21T06:35:11.236Z",
            },
            {
              evidenceId: "wev_74fd14648cfb703b6d204d8ca087c524",
              method: "api",
              sourceUrl: "https://openrouter.ai/api/v1/models",
              observedAt: "2026-10-21T06:35:11.236Z",
            },
            {
              evidenceId: "wev_914c76ad315edc7420739fc70c74c8da",
              method: "api",
              sourceUrl: "https://openrouter.ai/api/v1/models",
              observedAt: "2026-10-21T06:35:11.236Z",
            },
            {
              evidenceId: "wev_dae8bf8b2f605af3e5f3e9f4faeeb7f1",
              method: "api",
              sourceUrl: "https://openrouter.ai/api/v1/models",
              observedAt: "2026-10-21T06:35:11.236Z",
            },
            {
              evidenceId: "wev_8655468cddad28572ecb644d4f543f06",
              method: "docs",
              sourceUrl: "https://openrouter.ai/docs/guides/best-practices/reasoning-tokens",
              observedAt: "2026-10-21T06:35:41.955Z",
            },
            {
              evidenceId: "wev_8d0d4fe6275240b3c182fecb09ff1be3",
              method: "docs",
              sourceUrl: "https://openrouter.ai/docs/guides/best-practices/reasoning-tokens",
              observedAt: "2026-10-21T06:35:41.955Z",
            },
            {
              evidenceId: "wev_184a0f17b8473137498c46aef8530a52",
              method: "probe",
              observedAt: "2026-10-16T22:13:16.312Z",
            },
            {
              evidenceId: "wev_3c0765d2f6da28e6c3c320d9b56712a0",
              method: "probe",
              observedAt: "2026-10-16T22:13:14.368Z",
            },
            {
              evidenceId: "wev_7ab7c7ded45b01ddb77d0a84cac05fb6",
              method: "probe",
              observedAt: "2026-10-16T22:13:16.312Z",
            },
          ],
        },
        contentUse: "standard",
      },
    ],
  },
];
const realRoute = routing.route;
const originalFetcher = discovery.getModelDiscoveryFetcher("muse-code-models");
const originalFetch = globalThis.fetch;
const previousCredentials = new Map<string, CredentialProvider>();
let dir: string;
let cachePath: string;
let selectedProvider: string;
let previousConfig: string | null;
let routeSpy: ReturnType<typeof spyOn<typeof routing, "route">>;
let windowSpy: ReturnType<typeof spyOn<typeof discovery, "discoverContextWindow">>;

function install(data: DiskCacheV3): void {
  _clearAllModelsCacheMemo();
  writeAllModelsCache(structuredClone(data), cachePath);
  _setCatalogEntriesForTest(data.entries);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bare-wire-window-"));
  cachePath = join(dir, "catalog.json");
  previousConfig = getConfigFileOverride();
  setConfigFileOverride(join(dir, "config.json"));
  selectedProvider = "meta-muse-code";
  for (const name of Object.keys(CATALOG_ROUTE_BINDINGS)) {
    const previous = credentials.get(name);
    if (!previous) continue;
    previousCredentials.set(name, previous);
    credentials.register({
      catalogName: name,
      isAvailable: async () => name === selectedProvider,
      getRequestAuth: async () => ({ headers: { Authorization: "Bearer TEST_TOKEN" } }),
    });
  }
  discovery.invalidateModelDiscovery();
  discovery.registerModelDiscoveryFetcher("muse-code-models", async () => ({
    kind: "models",
    models: [{ id: "muse-wonder-full-1.0", contextWindow: 1007997, reported: "chat" }],
  }));
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("Unexpected network in bare-wire-window test");
    },
    { preconnect: () => {} }
  ) as typeof fetch;
  _resetCatalogClient();
  install(museCatalog as DiskCacheV3);
  routeSpy = spyOn(routing, "route").mockImplementation((spec) =>
    realRoute(spec, {}, "", cachePath)
  );
  windowSpy = spyOn(discovery, "discoverContextWindow");
});

afterEach(() => {
  windowSpy.mockRestore();
  routeSpy.mockRestore();
  globalThis.fetch = originalFetch;
  if (originalFetcher) discovery.registerModelDiscoveryFetcher("muse-code-models", originalFetcher);
  discovery.invalidateModelDiscovery();
  for (const previous of previousCredentials.values()) credentials.register(previous);
  previousCredentials.clear();
  _resetCatalogClient();
  _clearAllModelsCacheMemo();
  setConfigFileOverride(previousConfig);
  rmSync(dir, { recursive: true, force: true });
});

test("bare Wonder Full returns its routed Muse served context window", async () => {
  const window = await computeMainThreadContextWindow(
    { model: "muse-wonder-full" } as ClaudishConfig,
    cachePath
  );
  expect(window).toBe(1007997);
});

test("explicit Muse wire id returns the served context window", async () => {
  expect(
    await computeMainThreadContextWindow(
      { model: "muse@muse-wonder-full-1.0" } as ClaudishConfig,
      cachePath
    )
  ).toBe(1007997);
});

test("bare Kimi uses its routed wire id for context discovery", async () => {
  selectedProvider = "kimi-coding";
  const data = kimiCatalog as DiskCacheV3;
  install(data);
  const model = data.entries[0]!;
  if (model.contextWindow === undefined) throw new Error("Expected catalog context window");
  const binding = CATALOG_ROUTE_BINDINGS[selectedProvider]!;
  const connection = model.aggregators!.find(
    (row) =>
      row.route?.routeId === binding.routeId && row.route.routeProfileId === binding.routeProfileId
  )!;
  expect(connection.externalModelId).not.toBe(model.modelId);
  globalThis.fetch = Object.assign(
    async () =>
      Response.json({
        data: [{ id: connection.externalModelId, context_length: model.contextWindow }],
      }),
    { preconnect: () => {} }
  ) as typeof fetch;
  const window = await computeMainThreadContextWindow(
    { model: model.modelId } as ClaudishConfig,
    cachePath
  );
  expect(windowSpy).toHaveBeenCalledWith(selectedProvider, connection.externalModelId);
  expect(window).toBe(model.contextWindow);
});

test("bare qwen3.8-flash-next keeps its own window when its OpenRouter wire id names another row", async () => {
  selectedProvider = "openrouter";
  const data = {
    ...structuredClone(museCatalog),
    entries: structuredClone(qwenCollisionEntries),
  } as DiskCacheV3;
  const model = data.entries.find((entry) => entry.modelId === "qwen3.8-flash-next")!;
  const other = data.entries.find((entry) => entry.modelId === "qwen3.8-flash")!;
  if (model.contextWindow === undefined) throw new Error("Expected catalog context window");
  expect(other.contextWindow).toBe(model.contextWindow);
  // Both real rows have the same window. Change ONLY the other row's window in
  // this extracted copy so a wire-id collision cannot pass by returning that value.
  other.contextWindow = model.contextWindow / 2;
  const connection = model.aggregators!.find((row) => row.route?.routeId === "openrouter")!;
  if (!connection.externalModelId) throw new Error("Expected OpenRouter wire id");
  expect(connection.externalModelId).toBe(`qwen/${other.modelId}`);
  install(data);

  const previousKey = process.env.OPENROUTER_API_KEY;
  try {
    process.env.OPENROUTER_API_KEY = "or-test";
    const credential = previousCredentials.get(selectedProvider);
    if (!credential) throw new Error("Expected registered OpenRouter credential provider");
    credentials.register(credential);
    const plan = await routing.route(model.modelId);
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") throw new Error("Expected an OpenRouter route");
    expect(plan.primary.provider).toBe(selectedProvider);
    expect(plan.primary.modelSpec).toBe(connection.externalModelId);
    expect(plan.fallbacks).toEqual([]);
    const window = await computeMainThreadContextWindow(
      { model: model.modelId } as ClaudishConfig,
      cachePath
    );
    expect(window).toBe(model.contextWindow);
  } finally {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    credentials.invalidate(selectedProvider);
  }
});
