import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { catalogRouteForProvider } from "./catalog-route-bindings.js";

import { credentials } from "../auth/credentials/authority.js";
import type { SlimModelEntry } from "./all-models-cache.js";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "./catalog-client.js";
import { providerServesModel } from "./model-availability.js";
import { invalidateModelDiscovery } from "./model-discovery.js";
import type { ProviderDefinition } from "./provider-definitions.js";
import { clearRuntimeRegistry, registerRuntimeProvider } from "./runtime-providers.js";

const CATALOG_PROVIDER = "openrouter";
const OTHER_CATALOG_PROVIDER = "fireworks";
const DISCOVERY_PROVIDER = "availability-discovery-test";

const realFetch = globalThis.fetch;
const realGetRequestAuth = credentials.getRequestAuth;

function catalogEntry(
  modelId: string,
  providers: Array<{ provider: string; externalId?: string }> = [],
  aliases: string[] = []
): SlimModelEntry {
  return {
    modelId,
    aliases,

    aggregators: providers.map(({ provider, externalId }) => ({
      sourceProviderId: provider,
      sourceCollectorId: "test",
      routeStatus: "mapped",
      route: catalogRouteForProvider(provider),
      externalModelId: externalId ?? modelId,
      confidence: "api_official",
    })),
  };
}

function discoveryProvider(): ProviderDefinition {
  return {
    name: DISCOVERY_PROVIDER,
    displayName: "Availability Discovery Test",
    transport: "openai",
    baseUrl: "https://discovery.invalid",
    apiPath: "/v1/chat/completions",
    apiKeyEnvVar: "AVAILABILITY_DISCOVERY_TEST_API_KEY",
    apiKeyDescription: "Offline test key",
    apiKeyUrl: "https://discovery.invalid/key",
    shortcuts: [],
    legacyPrefixes: [],
    modelDiscovery: { path: "/v1/models", format: "openai-models-list" },
    // Required because handler wiring once lived in PROVIDER_PROFILES, where a missing entry silently routed to OpenRouter; colocating it prevents that half-add.
    createHandler: {
      kind: "none",
      reason: "virtual",
      note: "Test fixture — never builds a handler.",
    },
    isDirectApi: true,
  };
}

function stubRoster(...ids: string[]): void {
  globalThis.fetch = mock(
    async () =>
      new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  _resetCatalogClient();
  // Keep every test off the real on-disk catalog, including discovery tests.
  _setCatalogEntriesForTest([]);
  invalidateModelDiscovery();
  clearRuntimeRegistry();
  registerRuntimeProvider(discoveryProvider());

  credentials.getRequestAuth = mock(async () => ({
    headers: { Authorization: "Bearer offline-test-token" },
  }));
  globalThis.fetch = mock(async () => {
    throw new Error("Unexpected fetch call");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  _resetCatalogClient();
  invalidateModelDiscovery();
  clearRuntimeRegistry();
  credentials.getRequestAuth = realGetRequestAuth;
  globalThis.fetch = realFetch;
});

describe("providerServesModel catalog evidence", () => {
  test("still returns serves when the matching row lists the provider", async () => {
    _setCatalogEntriesForTest([
      catalogEntry("model-one", [{ provider: CATALOG_PROVIDER, externalId: "vendor/model-one" }]),
    ]);

    // Partial coverage cannot prove a denial, but a listed provider is still
    // positive catalog evidence and remains safe to confirm.
    expect(await providerServesModel(CATALOG_PROVIDER, "model-one")).toBe("serves");
  });

  test("returns unknown when a catalog-known provider is absent from the matching row", async () => {
    _setCatalogEntriesForTest([
      catalogEntry("model-one", [{ provider: OTHER_CATALOG_PROVIDER }]),
      catalogEntry("model-two", [{ provider: CATALOG_PROVIDER }]),
    ]);

    // Catalog coverage is partial, so absence from one row cannot deny service:
    // openai-codex appears on only 1 of ~760 rows yet genuinely serves gpt-5.
    // Only a complete live roster may turn absence into "not-served".
    expect(await providerServesModel(CATALOG_PROVIDER, "model-one")).toBe("unknown");
  });

  test("returns unknown for the openai-codex thin-coverage shape", async () => {
    _setCatalogEntriesForTest([
      catalogEntry("the-one-listed-row", [{ provider: "openai-codex" }]),
      catalogEntry("gpt-5", [{ provider: OTHER_CATALOG_PROVIDER }]),
    ]);

    // This models openai-codex appearing on one row but being absent from the
    // queried row. Its real 1-of-~760 coverage is partial evidence, not a denial.
    expect(await providerServesModel("openai-codex", "gpt-5")).toBe("unknown");
  });

  test("returns unknown when the provider never appears in the catalog vocabulary", async () => {
    _setCatalogEntriesForTest([catalogEntry("model-one", [{ provider: OTHER_CATALOG_PROVIDER }])]);

    // This guard stops subscription providers, which the aggregator catalog
    // usually does not cover, from being dropped from every paid routing chain.
    expect(await providerServesModel("subscription-provider", "model-one")).toBe("unknown");
  });

  test("returns unknown when the catalog is cold", async () => {
    _setCatalogEntriesForTest(null);

    expect(await providerServesModel(CATALOG_PROVIDER, "model-one")).toBe("unknown");
  });

  test("returns unknown when a vocabulary provider has no matching row", async () => {
    _setCatalogEntriesForTest([catalogEntry("known-model", [{ provider: CATALOG_PROVIDER }])]);

    expect(await providerServesModel(CATALOG_PROVIDER, "newer-than-cache")).toBe("unknown");
  });

  test.each([
    [
      "alias",
      "MODEL-ALIAS",
      catalogEntry("canonical-model", [{ provider: CATALOG_PROVIDER }], ["model-alias"]),
    ],
    [
      "aggregator external id",
      "VENDOR/MODEL-ONE",
      catalogEntry("canonical-model", [
        { provider: CATALOG_PROVIDER, externalId: "vendor/model-one" },
      ]),
    ],
  ])("matches a row by %s, not only modelId", async (_kind, wireId, entry) => {
    _setCatalogEntriesForTest([entry]);

    expect(await providerServesModel(CATALOG_PROVIDER, wireId)).toBe("serves");
  });
});

describe("providerServesModel live discovery", () => {
  test("returns serves for exact and case-insensitive roster membership", async () => {
    stubRoster("MiniMax-M3");

    expect(await providerServesModel(DISCOVERY_PROVIDER, "MiniMax-M3")).toBe("serves");
    expect(await providerServesModel(DISCOVERY_PROVIDER, "minimax-m3")).toBe("serves");
  });

  test("returns not-served when a non-empty roster omits the model", async () => {
    stubRoster("available-model");

    expect(await providerServesModel(DISCOVERY_PROVIDER, "missing-model")).toBe("not-served");
  });

  test("returns unknown when discovery returns an empty roster", async () => {
    stubRoster();

    // A temporarily unavailable listing endpoint must not silently switch the
    // user away from the provider they selected and may already pay for.
    expect(await providerServesModel(DISCOVERY_PROVIDER, "model-one")).toBe("unknown");
  });

  test("uses discovery before conflicting catalog evidence", async () => {
    _setCatalogEntriesForTest([catalogEntry("model-one", [{ provider: DISCOVERY_PROVIDER }])]);
    stubRoster("different-model");

    expect(await providerServesModel(DISCOVERY_PROVIDER, "model-one")).toBe("not-served");
  });
});
