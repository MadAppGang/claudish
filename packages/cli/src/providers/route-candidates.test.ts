/**
 * Assumed extension:
 * gatherRouteCandidates(model: string, cachePath?: string,
 *   lists?: AccountModelsListSnapshot): CandidateGathering.
 * The typed call below lets the current implementation ignore the extra argument,
 * so missing list behaviour fails assertions rather than module loading.
 */
// REQ-101: Test fallbacks carry their source without consulting machine configuration.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentials } from "../auth/credentials/authority.js";
import { type DiskCacheV3, type SlimModelEntry, writeAllModelsCache } from "./all-models-cache.js";
import { _resetCatalogClient, _setCatalogEntriesForTest } from "./catalog-client.js";
import { catalogRouteForProvider, routingProvidersForRoute } from "./catalog-route-bindings.js";
import type { AccountModelsListSnapshot } from "./dynamic-models-catalog.js";
import type { DiscoveredModel } from "./model-discovery.js";
import {
  getModelDiscoveryFetcher,
  invalidateModelDiscovery,
  registerModelDiscoveryFetcher,
} from "./model-discovery.js";
import "./model-discovery-builtins.js";
import {
  type CandidateGathering,
  type RouteCandidate,
  catalogDeniesProvider,
  compareRouteCandidates,
  gatherRouteCandidates,
  nativeProviderForVendor,
  routeOwnership,
} from "./route-candidates.js";
import { buildCatalogChain, route } from "./routing-rules.js";

const GENERATION = "g-20260921062451697-f490edba";

/**
 * Trimmed verbatim from ~/.claudish/cloud-models-catalog-v3.json at GENERATION.
 * The comments name every canonical model id used by a test; fields irrelevant
 * to gathering are omitted, while route bindings, wire ids, prices, vendor and
 * context windows remain exactly as published.
 */
const REAL_ENTRIES: SlimModelEntry[] = [
  // gpt-6-astra: subscription + native API + gateways.
  {
    modelId: "gpt-6-astra",
    provider: "openai",
    aliases: ["openai/gpt-6-astra", "~openai/gpt-astra-latest"],
    contextWindow: 1_050_000,
    subscriptionPlanIds: ["openai-codex"],
    aggregators: [
      {
        sourceProviderId: "openai-codex",
        sourceCollectorId: "openai-codex-models",
        confidence: "scrape_verified",
        routeStatus: "mapped",
        route: { routeId: "openai", routeProfileId: "codex-subscription" },
        externalModelId: "gpt-6-astra",
      },
      {
        sourceProviderId: "openai",
        sourceCollectorId: "openai-api",
        confidence: "api_official",
        routeStatus: "mapped",
        route: { routeId: "openai", routeProfileId: "direct-api" },
        externalModelId: "gpt-6-astra",
        pricing: { type: "flat", input: 10, output: 50 },
      },
      {
        sourceProviderId: "opencode-zen",
        sourceCollectorId: "opencode-zen-pricing-scrape",
        confidence: "gateway_official",
        routeStatus: "mapped",
        route: { routeId: "opencode", routeProfileId: "zen" },
        externalModelId: "gpt-6-astra",
        pricing: { type: "flat", input: 10, output: 50 },
      },
      {
        sourceProviderId: "openrouter",
        sourceCollectorId: "openrouter-api",
        confidence: "aggregator_reported",
        routeStatus: "mapped",
        route: { routeId: "openrouter", routeProfileId: "gateway" },
        externalModelId: "openai/gpt-6-astra",
        pricing: { type: "flat", input: 10, output: 50 },
      },
    ],
  },
  // glm-4.7: z-ai/direct-api is bound to both z-ai and glm credential silos.
  {
    modelId: "glm-4.7",
    provider: "z-ai",
    aliases: ["z-ai/glm-4.7", "zai-org/GLM-4.7", "GLM-4.7"],
    contextWindow: 202_752,
    aggregators: [
      {
        sourceProviderId: "openrouter",
        sourceCollectorId: "openrouter-api",
        confidence: "aggregator_reported",
        routeStatus: "mapped",
        route: { routeId: "openrouter", routeProfileId: "gateway" },
        externalModelId: "z-ai/glm-4.7",
        pricing: { type: "flat", input: 0.4, output: 1.75 },
      },
      {
        sourceProviderId: "z-ai",
        sourceCollectorId: "zhipu-api",
        confidence: "api_official",
        routeStatus: "mapped",
        route: { routeId: "z-ai", routeProfileId: "direct-api" },
        externalModelId: "glm-4.7",
        pricing: { type: "unavailable" },
      },
    ],
  },
  // kimi-k3: vendor connection plus priced and unpriced alternatives.
  {
    modelId: "kimi-k3",
    provider: "moonshotai",
    aliases: ["moonshotai/kimi-k3", "~moonshotai/kimi-latest", "k3"],
    contextWindow: 1_048_576,
    aggregators: [
      {
        sourceProviderId: "moonshotai",
        sourceCollectorId: "moonshot-api",
        confidence: "api_official",
        routeStatus: "mapped",
        route: { routeId: "moonshotai", routeProfileId: "direct-api" },
        externalModelId: "kimi-k3",
        pricing: { type: "unavailable" },
      },
      {
        sourceProviderId: "opencode-zen",
        sourceCollectorId: "opencode-zen-pricing-scrape",
        confidence: "gateway_official",
        routeStatus: "mapped",
        route: { routeId: "opencode", routeProfileId: "zen" },
        externalModelId: "kimi-k3",
        pricing: { type: "flat", input: 3, output: 15 },
      },
      {
        sourceProviderId: "openrouter",
        sourceCollectorId: "openrouter-api",
        confidence: "aggregator_reported",
        routeStatus: "mapped",
        route: { routeId: "openrouter", routeProfileId: "gateway" },
        externalModelId: "moonshotai/kimi-k3",
        pricing: { type: "flat", input: 1.7, output: 8.5 },
      },
    ],
  },
  // qwen3.8-max: subscriptions + native API, positively no OpenRouter connection.
  {
    modelId: "qwen3.8-max",
    provider: "qwen",
    aliases: ["accounts/fireworks/models/qwen3p8-max"],
    contextWindow: 1_000_000,
    subscriptionPlanIds: [
      "alibaba-token-plan-individual",
      "alibaba-token-plan-team-edition",
      "opencode-go",
    ],
    aggregators: [
      {
        sourceProviderId: "opencode-go",
        sourceCollectorId: "popular-coding-subscriptions",
        confidence: "gateway_official",
        routeStatus: "mapped",
        route: { routeId: "opencode", routeProfileId: "go-subscription" },
        externalModelId: "qwen3.8-max",
      },
      {
        sourceProviderId: "qwen-cloud",
        sourceCollectorId: "qwen-cloud-token-plan-scrape",
        confidence: "scrape_verified",
        routeStatus: "mapped",
        route: { routeId: "qwen", routeProfileId: "qwencloud-token-plan" },
        externalModelId: "qwen3.8-max",
      },
      {
        sourceProviderId: "qwen",
        sourceCollectorId: "dashscope-api",
        confidence: "api_official",
        routeStatus: "mapped",
        route: { routeId: "qwen", routeProfileId: "dashscope-direct" },
        externalModelId: "qwen3.8-max",
        pricing: { type: "flat", input: 2, output: 6 },
      },
    ],
  },
  // gemini-3.8-flash: metered connections plus Antigravity's vendor claim.
  {
    modelId: "gemini-3.8-flash",
    provider: "google",
    inputModalities: ["text"],
    outputModalities: ["text"],
    aliases: ["google/gemini-3.8-flash"],
    contextWindow: 1_048_576,
    aggregators: [
      {
        sourceProviderId: "google",
        sourceCollectorId: "google-model-get-api",
        confidence: "api_official",
        routeStatus: "mapped",
        route: { routeId: "google", routeProfileId: "direct-api" },
        externalModelId: "gemini-3.8-flash",
        pricing: { type: "flat", input: 0.75, output: 3.75 },
      },
      {
        sourceProviderId: "openrouter",
        sourceCollectorId: "openrouter-api",
        confidence: "aggregator_reported",
        routeStatus: "mapped",
        route: { routeId: "openrouter", routeProfileId: "gateway" },
        externalModelId: "google/gemini-3.8-flash",
        pricing: { type: "flat", input: 0.75, output: 3.75 },
      },
    ],
  },
];

const tempDir = mkdtempSync(join(tmpdir(), "claudish-route-candidates-"));
const cachePath = join(tempDir, "cloud-models-catalog-v3.json");
const missingCachePath = join(tempDir, "missing-catalog.json");

beforeAll(() => {
  const cache: DiskCacheV3 = {
    version: 3,
    catalogGenerationId: GENERATION,
    lastUpdated: "2026-09-21T06:24:51.697Z",
    entries: REAL_ENTRIES,
    models: [],
    plans: [],
  };
  writeAllModelsCache(cache, cachePath);
});

afterAll(() => {
  _resetCatalogClient();
  rmSync(tempDir, { recursive: true, force: true });
});

function gatheredCandidate(model: string, provider: string): RouteCandidate {
  const candidate = gatherRouteCandidates(model, cachePath).candidates.find(
    (item) => item.provider === provider
  );
  if (!candidate) throw new Error(`fixture produced no ${provider} candidate for ${model}`);
  return candidate;
}

describe("catalog route candidate gathering and order", () => {
  test("derives native providers from vendor route bindings", () => {
    const expected = {
      openai: "openai",
      google: "google",
      "x-ai": "x-ai",
      "z-ai": "z-ai",
      moonshotai: "kimi",
      minimax: "minimax",
      qwen: "qwen-payg",
      deepseek: "deepseek",
      mistralai: "mistralai",
      sakana: "sakana",
    } as const;

    expect(
      Object.fromEntries(
        Object.keys(expected).map((vendor) => [vendor, nativeProviderForVendor(vendor)])
      )
    ).toEqual(expected);
    expect(nativeProviderForVendor("anthropic")).toBeUndefined();
  });

  test("puts a flat-rate subscription before a metered connection", () => {
    const candidates = gatherRouteCandidates("gpt-6-astra", cachePath).candidates;

    expect(candidates[0]?.provider).toBe("openai-codex");
    expect(candidates.map(({ provider }) => provider)).toContain("openrouter");
  });

  test("gathers every provider bound to z-ai/direct-api", () => {
    const binding = { routeId: "z-ai", routeProfileId: "direct-api" };
    expect(routingProvidersForRoute(binding)).toEqual(["z-ai", "glm"]);

    const direct = gatherRouteCandidates("glm-4.7", cachePath).candidates.filter(
      ({ wireId }) => wireId === "glm-4.7"
    );
    expect(direct.map(({ provider }) => provider).sort()).toEqual(["glm", "z-ai"]);
  });

  test("the vendor comes first when candidates share a tier", () => {
    const vendor = gatheredCandidate("kimi-k3", "kimi");
    const gateway = gatheredCandidate("kimi-k3", "openrouter");

    // No current row puts a vendor-native connection and a gateway in one tier:
    // RouteTier defines those separately. Equalising only the tier isolates the
    // comparator contract while retaining kimi-k3's real wire ids, prices and
    // moonshotai vendor binding.
    const tied = [
      { ...gateway, tier: "gateway" as const },
      { ...vendor, tier: "gateway" as const },
    ].sort(compareRouteCandidates);
    expect(tied[0]?.provider).toBe("kimi");
  });

  test("orders known prices cheapest-first and every unknown price last", () => {
    const openrouter = gatheredCandidate("kimi-k3", "openrouter");
    const zen = gatheredCandidate("kimi-k3", "opencode-zen");
    const unknown = gatheredCandidate("kimi-k3", "kimi");
    const comparable = [openrouter, zen, unknown]
      .map((candidate) => ({ ...candidate, tier: "gateway" as const, isVendorOwn: false }))
      .sort(compareRouteCandidates);

    expect(comparable.map(({ provider }) => provider)).toEqual([
      "openrouter",
      "opencode-zen",
      "kimi",
    ]);
    expect(comparable.at(-1)?.price.known).toBe(false);
  });

  test("uses larger context next and provider name as the deterministic final tie-break", () => {
    const kimi = gatheredCandidate("kimi-k3", "kimi");
    const zai = gatheredCandidate("glm-4.7", "z-ai");

    // Generation g-20260921062451697-f490edba publishes zero per-connection
    // windows. The AggregatorEntry contract says omission inherits the model's
    // headline window, so these are the real 1,048,576 and 202,752 values.
    const neitherVendor = [zai, kimi].map((candidate) => ({
      ...candidate,
      isVendorOwn: false,
    }));
    expect(neitherVendor.sort(compareRouteCandidates).map(({ provider }) => provider)).toEqual([
      "kimi",
      "z-ai",
    ]);

    const sameContext = neitherVendor
      .map((candidate) => ({ ...candidate, contextWindow: kimi.contextWindow }))
      .sort(compareRouteCandidates);
    expect(sameContext.map(({ provider }) => provider)).toEqual(["kimi", "z-ai"]);
  });
});

describe("the subscription band", () => {
  test("a vendor's own dynamic subscription leads another vendor's catalog subscription", () => {
    const candidate = gatheredCandidate("kimi-k3", "kimi");
    const catalog: RouteCandidate = {
      ...candidate,
      provider: "opencode-zen-go",
      wireId: "kimi-k3",
      tier: "subscription",
      isVendorOwn: false,
    };
    const dynamic: RouteCandidate = {
      ...candidate,
      provider: "grok-subscription",
      wireId: "kimi-k3",
      tier: "dynamic-subscription",
      isVendorOwn: true,
    };

    for (const pair of [
      [catalog, dynamic],
      [dynamic, catalog],
    ]) {
      expect(pair.sort(compareRouteCandidates).map(({ provider }) => provider)).toEqual([
        "grok-subscription",
        "opencode-zen-go",
      ]);
    }
  });

  describe("inside the band a catalog subscription leads a dynamic one when the vendor rule ties", () => {
    for (const isVendorOwn of [true, false]) {
      test(`both isVendorOwn = ${isVendorOwn}`, () => {
        const candidate = gatheredCandidate("kimi-k3", "kimi");
        const dynamic: RouteCandidate = {
          ...candidate,
          provider: "antigravity",
          wireId: "kimi-k3",
          tier: "dynamic-subscription",
          isVendorOwn,
        };
        const catalog: RouteCandidate = {
          ...candidate,
          provider: "opencode-zen-go",
          wireId: "kimi-k3",
          tier: "subscription",
          isVendorOwn,
        };

        for (const pair of [
          [dynamic, catalog],
          [catalog, dynamic],
        ]) {
          expect(pair.sort(compareRouteCandidates).map(({ provider }) => provider)).toEqual([
            "opencode-zen-go",
            "antigravity",
          ]);
        }
      });
    }
  });

  test("the vendor rule never crosses a band", () => {
    const candidate = gatheredCandidate("kimi-k3", "kimi");
    const vendorNative: RouteCandidate = {
      ...candidate,
      provider: "xai-native",
      wireId: "kimi-k3",
      tier: "native",
      isVendorOwn: true,
    };
    const dynamic: RouteCandidate = {
      ...candidate,
      provider: "zz-dynamic",
      wireId: "kimi-k3",
      tier: "dynamic-subscription",
      isVendorOwn: false,
    };
    const vendorGateway: RouteCandidate = {
      ...candidate,
      provider: "aa-gateway",
      wireId: "kimi-k3",
      tier: "gateway",
      isVendorOwn: true,
    };
    const native: RouteCandidate = {
      ...candidate,
      provider: "zz-native",
      wireId: "kimi-k3",
      tier: "native",
      isVendorOwn: false,
    };

    for (const pair of [
      [vendorNative, dynamic],
      [dynamic, vendorNative],
    ]) {
      expect(pair.sort(compareRouteCandidates).map(({ provider }) => provider)).toEqual([
        "zz-dynamic",
        "xai-native",
      ]);
    }
    for (const pair of [
      [vendorGateway, native],
      [native, vendorGateway],
    ]) {
      expect(pair.sort(compareRouteCandidates).map(({ provider }) => provider)).toEqual([
        "zz-native",
        "aa-gateway",
      ]);
    }
  });
});

describe("vendor claims and availability", () => {
  test("a vendor claim is gathered but the dynamic models catalog may remove it", async () => {
    const gathered = gatherRouteCandidates("gemini-3.8-flash", cachePath);
    expect(gathered.candidates).toContainEqual(
      expect.objectContaining({
        provider: "antigravity",
        tier: "dynamic-subscription",
        source: "vendor-claim",
      })
    );

    const originalFetcher = getModelDiscoveryFetcher("antigravity");
    const originalIsAvailable = credentials.isAvailable;
    const originalDescribeReadiness = credentials.describeReadiness;
    if (!originalFetcher) throw new Error("Antigravity discovery fetcher was not registered");

    try {
      registerModelDiscoveryFetcher("antigravity", async () => ({
        kind: "models",
        models: [{ id: "gemini-2.5-flash" }],
      }));
      invalidateModelDiscovery("antigravity");
      credentials.isAvailable = async (provider: string) => provider === "antigravity";
      credentials.describeReadiness = async (provider: string) => ({
        readiness: provider === "antigravity" ? "present" : "absent",
      });

      const plan = await route(
        "gemini-3.8-flash",
        {},
        { provider: "", source: "config-file", legacyAutoPromoted: false },
        cachePath
      );
      expect(plan.kind).toBe("no-route");
      if (plan.kind === "no-route") {
        expect(plan.reason).toBe('No provider serves "gemini-3.8-flash" (checked: antigravity).');
      }
    } finally {
      registerModelDiscoveryFetcher("antigravity", originalFetcher);
      invalidateModelDiscovery("antigravity");
      credentials.isAvailable = originalIsAvailable;
      credentials.describeReadiness = originalDescribeReadiness;
    }
  });
});

const gatherWithLists = gatherRouteCandidates as (
  model: string,
  cachePath?: string,
  lists?: AccountModelsListSnapshot
) => CandidateGathering;

describe("account-listed route candidates", () => {
  const path = join(tempDir, "account-listed-catalog.json");
  const swe: DiscoveredModel = {
    id: "swe-1-7-medium",
    family: "swe-1.7",
    isFamilyDefault: true,
    contextWindow: 200000,
    reported: "chat",
  };
  function snapshot(provider: string, models: DiscoveredModel[]): AccountModelsListSnapshot {
    return new Map([
      [provider, { provider, models, fetchedAt: Date.now(), age: "live", mayDeny: true }],
    ]);
  }
  function seed(entries: SlimModelEntry[], plans: DiskCacheV3["plans"] = []): void {
    _setCatalogEntriesForTest(entries);
    writeAllModelsCache(
      {
        version: 3,
        catalogGenerationId: "account-listed-test-data",
        lastUpdated: new Date().toISOString(),
        entries,
        models: [],
        plans,
      },
      path
    );
  }
  function connection(provider: string, wireId: string) {
    return {
      sourceProviderId: provider,
      sourceCollectorId: "test-data",
      confidence: "api_official" as const,
      routeStatus: "mapped" as const,
      route: catalogRouteForProvider(provider),
      externalModelId: wireId,
    };
  }
  afterEach(_resetCatalogClient);

  test("adds Devin for a catalog-absent name in the account's own spelling", () => {
    seed([]);
    const gathered = gatherWithLists("swe-1.7", path, snapshot("devin", [swe]));
    expect(gathered.catalogMiss).toBe(true);
    expect(gathered.candidates).toContainEqual(
      expect.objectContaining({
        provider: "devin",
        wireId: "swe-1.7",
        tier: "dynamic-subscription",
        source: "account-listed",
        isVendorOwn: false,
      })
    );
  });

  test.each(["swe-1.7", "gemini-test-missing", "grok-test-missing", "fugu-test-missing"])(
    "does not infer a subscription candidate from the spelling %s",
    (model) => {
      seed([]);
      expect(gatherWithLists(model, path, new Map()).candidates).toEqual([]);
    }
  );

  test("adds Devin when the cloud models catalog has no Devin connection", () => {
    seed([
      {
        modelId: "kimi-k3",
        provider: "moonshotai",
        aliases: [],
        inputModalities: ["text"],
        outputModalities: ["text"],
        aggregators: [
          connection("kimi", "kimi-k3"),
          connection("openrouter", "moonshotai/kimi-k3"),
        ],
      },
    ]);
    const gathered = gatherWithLists(
      "kimi-k3",
      path,
      snapshot("devin", [
        { id: "kimi-k3-high", family: "kimi-k3", isFamilyDefault: true, reported: "chat" },
      ])
    );
    expect(gathered.catalogMiss).toBe(false);
    expect(gathered.candidates.map(({ provider }) => provider)).toEqual([
      "devin",
      "kimi",
      "openrouter",
    ]);
    expect(gathered.candidates[0]).toMatchObject({ source: "account-listed" });
  });

  test("orders an own-vendor claim before another subscription and the native API", () => {
    seed([
      {
        modelId: "grok-4.7",
        provider: "x-ai",
        aliases: [],
        inputModalities: ["text"],
        outputModalities: ["text"],
        subscriptionPlanIds: ["test-go-plan"],
        aggregators: [connection("opencode-zen-go", "grok-4.7"), connection("x-ai", "grok-4.7")],
      },
    ]);
    const candidates = gatherWithLists("grok-4.7", path, new Map()).candidates;
    expect(candidates.map(({ provider }) => provider)).toEqual([
      "grok-subscription",
      "opencode-zen-go",
      "x-ai",
    ]);
    expect(candidates[0]).toMatchObject({ source: "vendor-claim", isVendorOwn: true });
  });

  test.each([
    { model: "gemini-test-image", input: ["text"], output: ["image"], claims: false },
    { model: "gemma-4-31b-it", input: ["file", "image", "text"], output: ["text"], claims: true },
    { model: "gemini-test-audio-input", input: ["audio"], output: ["text"], claims: false },
    { model: "gemini-test-unknown", input: undefined, output: undefined, claims: false },
  ])("requires published chat modalities for a vendor claim on $model", (row) => {
    seed([
      {
        modelId: row.model,
        provider: "google",
        aliases: [],
        inputModalities: row.input ? [...row.input] : undefined,
        outputModalities: row.output ? [...row.output] : undefined,
      },
    ]);
    const candidates = gatherWithLists(row.model, path, new Map()).candidates;
    if (row.claims) {
      expect(candidates).toContainEqual(
        expect.objectContaining({ provider: "antigravity", source: "vendor-claim" })
      );
    } else {
      expect(candidates.map(({ provider }) => provider)).not.toContain("antigravity");
    }
  });

  test("uses the account list even when no cloud models catalog is readable", () => {
    _setCatalogEntriesForTest(null);
    const gathered = gatherWithLists("swe-1.7", missingCachePath, snapshot("devin", [swe]));
    expect(gathered).toMatchObject({ catalogReadable: false, catalogMiss: true });
    expect(gathered.candidates.map(({ provider }) => provider)).toEqual(["devin"]);
    expect(gathered.candidates[0]).toMatchObject({ source: "account-listed" });
  });

  test("carries the account-listed row's context window", () => {
    seed([]);
    expect(
      gatherWithLists("swe-1.7", path, snapshot("devin", [swe])).candidates.find(
        ({ provider }) => provider === "devin"
      )?.contextWindow
    ).toBe(200000);
  });

  test("keeps the catalog connection's metadata when an account list serves the same pair", () => {
    seed([
      {
        modelId: "test-dedupe",
        provider: "test-vendor",
        aliases: [],
        contextWindow: 64000,
        aggregators: [connection("devin", "test-dedupe")],
      },
    ]);
    const candidates = gatherWithLists(
      "test-dedupe",
      path,
      snapshot("devin", [{ id: "test-dedupe", contextWindow: 200000, reported: "chat" }])
    ).candidates.filter(({ provider }) => provider === "devin");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      wireId: "test-dedupe",
      source: "catalog-connection",
      contextWindow: 64000,
    });
  });

  test("an account list cannot override published subscription membership", () => {
    seed(
      [
        {
          modelId: "test-muse-member",
          aliases: [],
          subscriptionPlanIds: ["test-muse-plan"],
        },
        {
          modelId: "test-muse-excluded",
          provider: "meta",
          aliases: [],
          subscriptionPlanIds: [],
        },
      ],
      [
        {
          id: "test-muse-plan",
          modelDiscovery: "catalog",
          routeStatus: "supported",
          route: catalogRouteForProvider("meta-muse-code"),
        },
      ]
    );
    const gathered = gatherWithLists(
      "test-muse-excluded",
      path,
      snapshot("meta-muse-code", [{ id: "test-muse-excluded", reported: "chat" }])
    );
    expect(gathered.candidates.map(({ provider }) => provider)).not.toContain("meta-muse-code");
    expect(gathered.excluded).toContainEqual({
      candidate: expect.objectContaining({ provider: "meta-muse-code" }),
      outcome: "excluded-by-membership",
    });
  });
});

describe("fallback placement and no-catalog behavior", () => {
  test("does not display the qwen steering placeholder as a dashscope hop", () => {
    const providers = buildCatalogChain(
      "qwen3.8-max",
      { provider: "", source: "config-file", legacyAutoPromoted: false },
      cachePath
    ).routes.map(({ provider }) => provider);

    expect(providers).toContain("qwen-payg");
    expect(providers).not.toContain("qwen");
  });

  test("appends the fallback last and does not duplicate an existing candidate", () => {
    const missingModel = buildCatalogChain(
      "swe-1.7",
      { provider: "openrouter", source: "hardcoded", legacyAutoPromoted: false },
      cachePath
    );
    expect(missingModel.routes.map(({ provider }) => provider)).toEqual(["openrouter"]);

    const alreadyGathered = buildCatalogChain(
      "gpt-6-astra",
      { provider: "openrouter", source: "config-file", legacyAutoPromoted: false },
      cachePath
    );
    expect(alreadyGathered.routes.at(-1)?.provider).toBe("openrouter");
    expect(alreadyGathered.routes.filter(({ provider }) => provider === "openrouter")).toHaveLength(
      1
    );
  });

  test("does not append a fallback when defaultProvider is explicitly empty", () => {
    expect(
      buildCatalogChain(
        "swe-1.7",
        { provider: "", source: "config-file", legacyAutoPromoted: false },
        cachePath
      ).routes.map(({ provider }) => provider)
    ).toEqual([]);
  });

  test.skipIf(routeOwnership("openrouter") !== "backend-owned")(
    "does not append a backend-owned gateway the cloud models catalog positively denies",
    () => {
      // The probe ownership cache and qwen3.8-max row are both generation
      // g-20260921062451697-f490edba. The branch cannot be isolated from the
      // default probe-cache path because production exposes no injection seam.
      expect(catalogDeniesProvider("openrouter", "qwen3.8-max", cachePath)).toBe(true);
      expect(
        buildCatalogChain(
          "qwen3.8-max",
          { provider: "openrouter", source: "config-file", legacyAutoPromoted: false },
          cachePath
        ).routes.map(({ provider }) => provider)
      ).not.toContain("openrouter");
    }
  );

  test("a matching empty user rule suppresses every fallback", async () => {
    const originalIsAvailable = credentials.isAvailable;
    try {
      credentials.isAvailable = async () => true;
      const plan = await route(
        "gpt-6-astra",
        { "*": [] },
        { provider: "openrouter", source: "config-file", legacyAutoPromoted: false },
        cachePath
      );
      expect(plan).toEqual({
        kind: "no-route",
        reason: 'A routing rule matched "gpt-6-astra" and named no provider.',
        hint: expect.any(String),
      });
    } finally {
      credentials.isAvailable = originalIsAvailable;
    }
  });

  test("no cloud models catalog blocks bare names but explicit model specs still work", async () => {
    const originalIsAvailable = credentials.isAvailable;
    _setCatalogEntriesForTest([]);
    try {
      credentials.isAvailable = async (provider: string) => provider === "openai";
      const bare = await route(
        "gpt-5",
        {},
        { provider: "openrouter", source: "hardcoded", legacyAutoPromoted: false },
        missingCachePath
      );
      expect(bare.kind).toBe("no-route");
      if (bare.kind === "no-route") {
        expect(bare.reason).toContain("No model catalog available");
        expect(bare.hint).toContain("claudish --models-refresh");
      }

      const explicit = await route(
        "openai@gpt-5",
        {},
        { provider: "openrouter", source: "hardcoded", legacyAutoPromoted: false },
        missingCachePath
      );
      expect(explicit.kind).toBe("ok");
      if (explicit.kind === "ok") expect(explicit.primary.modelSpec).toBe("oai@gpt-5");
    } finally {
      credentials.isAvailable = originalIsAvailable;
      _resetCatalogClient();
    }
  });
});
