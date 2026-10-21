import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSubscriptionRouting } from "../adapters/model-catalog.js";
import type { CredentialProvider } from "../auth/credentials/types.js";
import type { AggregatorEntry } from "../model-loader.js";
// Extracted with jq from cloud models catalog generation g-20261021063612126-17350b71.
import museCatalog from "../test-fixtures/catalog-v3/muse-code-g-20261021063612126-17350b71.json";
import type { DiskCacheV3, SlimModelEntry } from "./all-models-cache.js";

let home: string;
let savedKeychain: string | undefined;
let cachePath: string;
let savedFetch: typeof globalThis.fetch;
let cache: typeof import("./all-models-cache.js");

function connection(id: string, routeId = "meta", routeProfileId = "direct-api"): AggregatorEntry {
  return {
    sourceProviderId: routeId,
    sourceCollectorId: routeId,
    confidence: "api_official",
    routeStatus: "mapped",
    route: { routeId, routeProfileId },
    externalModelId: id,
  };
}
function seed(aggregators: AggregatorEntry[]): SlimModelEntry {
  return {
    contractVersion: 3,
    modelId: "muse-spark-1.3",
    provider: "meta",
    aliases: [],
    aggregators,
  };
}
function disk(entries: SlimModelEntry[]): DiskCacheV3 {
  return {
    version: 3,
    lastUpdated: new Date().toISOString(),
    catalogGenerationId: "g-run3-fixture",
    entries,
    models: entries.map((entry) => ({ id: entry.modelId })),
    plans: [],
  };
}
beforeEach(async () => {
  // All disk access uses the explicit cache path; HOME is not an isolation seam.
  home = mkdtempSync(join(tmpdir(), "claudish-run3-"));
  savedKeychain = process.env.CLAUDISH_DISABLE_KEYCHAIN;
  process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
  cachePath = join(home, "all-models.json");
  savedFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("Run 3 tests forbid network requests");
    },
    { preconnect: () => {} }
  ) as typeof fetch;
  cache = await import("./all-models-cache.js");
  cache._clearAllModelsCacheMemo();
});
afterEach(() => {
  cache?._clearAllModelsCacheMemo();
  if (savedFetch) globalThis.fetch = savedFetch;
  if (savedKeychain === undefined) delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
  else process.env.CLAUDISH_DISABLE_KEYCHAIN = savedKeychain;
  rmSync(home, { recursive: true, force: true });
});

let routing: typeof import("./routing-rules.js");
let gathering: typeof import("./route-candidates.js");
let catalog: typeof import("./catalog-client.js");
beforeEach(async () => {
  routing = await import("./routing-rules.js");
  gathering = await import("./route-candidates.js");
  catalog = await import("./catalog-client.js");
  catalog._resetCatalogClient();
});
afterEach(() => {
  catalog?._setCatalogEntriesForTest(null);
  catalog?._resetCatalogClient();
});

const fakeAvailability = new Map<string, boolean>();
const previousCredentials = new Map<string, CredentialProvider>();
let authority: typeof import("../auth/credentials/authority.js");
let billing: typeof import("../auth/credentials/billing-probe.js");
let discovery: typeof import("./model-discovery.js");
const credentialNames = ["meta", "meta-muse-code", "openrouter", "opencode-zen", "opencode-zen-go"];
beforeEach(async () => {
  authority = await import("../auth/credentials/authority.js");
  billing = await import("../auth/credentials/billing-probe.js");
  discovery = await import("./model-discovery.js");
  // Verify restoration is possible before replacing any registrations.
  previousCredentials.clear();
  for (const name of credentialNames) {
    const previous = authority.credentials.get(name);
    if (!previous) throw new Error(`No original credential registration for ${name}`);
    previousCredentials.set(name, previous);
  }
  for (const name of credentialNames) {
    fakeAvailability.set(name, true);
    authority.credentials.register({
      catalogName: name,
      isAvailable: async () => fakeAvailability.get(name) === true,
      describeReadiness: async () => ({
        readiness: fakeAvailability.get(name) ? "present" : "absent",
      }),
      getRequestAuth: async () => ({
        headers: {},
        arm: name === "meta-muse-code" ? "oauth" : "api-key",
      }),
    });
  }
  billing.clearSignedArm();
  discovery.invalidateModelDiscovery();
});
afterEach(() => {
  for (const previous of previousCredentials.values()) authority.credentials.register(previous);
  previousCredentials.clear();
  fakeAvailability.clear();
  billing?.clearSignedArm();
  discovery?.invalidateModelDiscovery();
});

function routingFixture(modelId = "muse-spark-1.3"): SlimModelEntry {
  // Cloud models catalog seeds, NOT Meta endpoint responses. Architecture §3(b).
  return {
    ...seed([
      connection(`${modelId}-contributor`, "meta", "direct-api"),
      connection(modelId, "meta", "direct-api"),
      connection(`${modelId}-contributor`, "opencode", "go-subscription"),
      connection(`${modelId}-contributor-free`, "opencode", "zen"),
      connection(modelId, "opencode", "zen"),
      connection(`${modelId}-contributor`, "openrouter", "gateway"),
      connection(modelId, "openrouter", "gateway"),
    ]),
    modelId,
    provider: modelId.startsWith("gemini") ? "google" : "meta",
  };
}
function install(entry: SlimModelEntry, unsupportedPlan = true): void {
  const data = disk([entry]);
  if (unsupportedPlan)
    data.plans = [
      {
        id: "meta-muse-code",
        contractVersion: 3,
        modelDiscovery: "catalog",
        routeStatus: "unsupported",
        routeReason: "no_reviewed_consumer_route",
      },
    ];
  writeFileSync(cachePath, JSON.stringify(data));
  cache._clearAllModelsCacheMemo();
  catalog._setCatalogEntriesForTest([entry]);
}

function installWithoutMuseProfile(): void {
  const data = structuredClone(museCatalog) as DiskCacheV3;
  delete data.routeRegistry!.registry.routes.meta.profiles["muse-code-subscription"];
  data.entries = data.entries.map((entry) => ({
    ...entry,
    aggregators: entry.aggregators?.filter(
      (connection) => connection.route?.routeProfileId !== "muse-code-subscription"
    ),
  }));
  data.plans = [];
  cache.writeAllModelsCache(data, cachePath);
  expect(cache.readAllModelsCache(cachePath)).not.toBeNull();
  catalog._setCatalogEntriesForTest(data.entries);
}

function installMuseCatalog(): void {
  cache.writeAllModelsCache(structuredClone(museCatalog) as DiskCacheV3, cachePath);
  const data = cache.readAllModelsCache(cachePath);
  expect(data).not.toBeNull();
  catalog._setCatalogEntriesForTest(data!.entries);
}

describe("R1/R3: catalog candidate boundaries", () => {
  test.each([true, false])(
    "R1: unsupported/missing plan never synthesizes Muse (plan present=%s)",
    (present) => {
      install(routingFixture(), present);
      const result = gathering.gatherRouteCandidates("muse-spark-1.3", cachePath);
      expect(result.catalogMiss).toBe(false);
      expect(result.candidates.map((candidate) => candidate.provider)).not.toContain(
        "meta-muse-code"
      );
      expect(result.candidates[0]?.provider).toBe("meta");
      expect(result.candidates[0]?.wireId).toBe("muse-spark-1.3");
      expect(result.candidates.map((candidate) => candidate.provider)).toContain("openrouter");
    }
  );

  // MTL-189: meta/muse-code-subscription must stay bound.
  test("R1: explicit muse@ builds without a published subscription profile", () => {
    installWithoutMuseProfile();
    expect(routing.buildRoutingChain(["muse@muse-spark-1.3"], "muse-spark-1.3", cachePath)).toEqual(
      [expect.objectContaining({ provider: "meta-muse-code", modelSpec: "muse@muse-spark-1.3" })]
    );
  });

  test.each(["muse-spark-1.3", "gemini-4-argon"])(
    "R3: %s excludes Go with content-use reason",
    (modelId) => {
      install(routingFixture(modelId));
      const result = gathering.gatherRouteCandidates(modelId, cachePath);
      expect(result.candidates.map((candidate) => candidate.provider)).not.toContain(
        "opencode-zen-go"
      );
      expect(result.excluded).toContainEqual(
        expect.objectContaining({
          outcome: "excluded-by-content-use",
          candidate: expect.objectContaining({
            provider: "opencode-zen-go",
            wireId: `${modelId}-contributor`,
          }),
        })
      );
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(
        result.candidates.every((candidate) => !/-contributor(?:-free)?$/i.test(candidate.wireId))
      ).toBe(true);
    }
  );

  test("R3: contributor-first Meta/Zen/OpenRouter choices all retain plain wire ids", () => {
    install(routingFixture());
    const result = gathering.gatherRouteCandidates("muse-spark-1.3", cachePath);
    for (const provider of ["meta", "opencode-zen", "openrouter"]) {
      expect(result.candidates).toContainEqual(
        expect.objectContaining({ provider, wireId: "muse-spark-1.3" })
      );
    }
  });

  test("R3: zgo user rule excludes a contributor-only mapping", async () => {
    install(routingFixture("gemini-4-argon"));
    const routes = routing.buildRoutingChain(["zgo"], "gemini-4-argon", cachePath);
    expect(routes).toEqual([]);
    const explanation = await routing.explainRoute("gemini-4-argon", {
      rules: { "gemini-4-argon": ["zgo"] },
      defaultProvider: "openrouter",
      cachePath,
    });
    expect(explanation.source).toBe("user-rule");
    expect(explanation.candidates).toContainEqual(
      expect.objectContaining({
        provider: "opencode-zen-go",
        outcome: "excluded-by-content-use",
      })
    );
    expect(
      explanation.candidates
        .filter((row) => row.outcome === "kept")
        .some((row) => row.provider === "opencode-zen-go")
    ).toBe(false);
  });

  test("R3: configured Go fallback cannot synthesize an opt-in wire id", () => {
    install(routingFixture("gemini-4-argon"));
    const result = routing.buildCatalogChain("gemini-4-argon", "opencode-zen-go", cachePath);
    expect(result.catalogReadable).toBe(true);
    expect(result.routes.length).toBeGreaterThan(0);
    expect(result.routes.some((route) => /-contributor(?:-free)?$/i.test(route.modelSpec))).toBe(
      false
    );
    expect(result.routes.map((route) => route.provider)).not.toContain("opencode-zen-go");
  });

  test.each([
    ["meta", "muse-spark-1.3"],
    ["zgo", "gemini-4-argon"],
  ])("R3: typed %s contributor spec survives verbatim", (shortcut, modelId) => {
    install(routingFixture(modelId));
    const routes = routing.buildRoutingChain(
      [`${shortcut}@${modelId}-contributor`],
      modelId,
      cachePath
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]!.modelSpec.split("@")[1]).toBe(`${modelId}-contributor`);
    expect(routes[0]!.provider).toBe(shortcut === "meta" ? "meta" : "opencode-zen-go");
  });

  test.each([true, false])(
    "R1: real route/explanation filters Meta credential (available=%s)",
    async (available) => {
      install(routingFixture());
      fakeAvailability.set("meta", available);
      const explanation = await routing.explainRoute("muse-spark-1.3", {
        rules: {},
        defaultProvider: "openrouter",
        cachePath,
      });
      expect(explanation.outcome).toEqual({ kind: "ok" });
      expect(explanation.candidates.find((row) => row.provider === "meta")?.outcome).toBe(
        available ? "kept" : "no-credential"
      );
      expect(explanation.candidates.some((row) => row.provider === "meta-muse-code")).toBe(false);
      const plan = await routing.route("muse-spark-1.3", {}, "openrouter", cachePath);
      expect(plan.kind).toBe("ok");
      if (plan.kind !== "ok") throw new Error(plan.reason);
      expect(plan.primary.provider).toBe(available ? "meta" : "opencode-zen");
      expect(
        [plan.primary, ...plan.fallbacks].every(
          (row) => !/-contributor(?:-free)?$/i.test(row.modelSpec)
        )
      ).toBe(true);
    }
  );

  test("R1: explicit muse@ passes credential filtering without a published subscription profile", async () => {
    installWithoutMuseProfile();
    const plan = await routing.route("muse@muse-spark-1.3", {}, "openrouter", cachePath);
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") throw new Error(plan.reason);
    expect(plan.primary).toEqual(
      expect.objectContaining({ provider: "meta-muse-code", modelSpec: "muse@muse-spark-1.3" })
    );
  });

  test.each(["muse-spark-1.3", "gemini-4-argon"])(
    "R3: credential-filtered explanation retains %s content-use exclusion",
    async (modelId) => {
      install(routingFixture(modelId));
      const explanation = await routing.explainRoute(modelId, {
        rules: {},
        defaultProvider: "opencode-zen-go",
        cachePath,
      });
      expect(explanation.candidates).toContainEqual(
        expect.objectContaining({
          provider: "opencode-zen-go",
          wireId: `${modelId}-contributor`,
          outcome: "excluded-by-content-use",
        })
      );
      expect(explanation.candidates.filter((row) => row.outcome === "kept").length).toBeGreaterThan(
        0
      );
      expect(
        explanation.candidates
          .filter((row) => row.outcome === "kept")
          .every((row) => !/-contributor(?:-free)?$/i.test(row.wireId))
      ).toBe(true);
    }
  );
  test.each([
    ["meta", "muse-spark-1.3"],
    ["zgo", "gemini-4-argon"],
  ])("R3: real explicit %s route retains the contributor id", async (shortcut, modelId) => {
    install(routingFixture(modelId));
    const plan = await routing.route(
      `${shortcut}@${modelId}-contributor`,
      {},
      "openrouter",
      cachePath
    );
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") throw new Error(plan.reason);
    expect(plan.primary.modelSpec.split("@")[1]).toBe(`${modelId}-contributor`);
    expect(plan.primary.provider).toBe(shortcut === "meta" ? "meta" : "opencode-zen-go");
  });

  test("R2: bare Wonder Full routes first to Muse without contributor wire ids", async () => {
    installMuseCatalog();
    fakeAvailability.set("meta-muse-code", true);
    const gathered = gathering.gatherRouteCandidates("muse-wonder-full", cachePath);
    expect(gathered.candidates[0]).toEqual(
      expect.objectContaining({
        provider: "meta-muse-code",
        wireId: "muse-wonder-full-1.0",
      })
    );
    const plan = await routing.route("muse-wonder-full", {}, undefined, cachePath);
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") throw new Error(plan.reason);
    expect(plan.primary.provider).toBe("meta-muse-code");
    expect(plan.primary.modelSpec.split("@")[1]).toBe("muse-wonder-full-1.0");
    expect(
      [plan.primary, ...plan.fallbacks].every(
        (hop) => !/-contributor(?:-free)?$/i.test(hop.modelSpec.split("@")[1]!)
      )
    ).toBe(true);
  });

  test("R2: bare Spark routes Muse subscription before metered Meta", async () => {
    installMuseCatalog();
    fakeAvailability.set("meta-muse-code", true);
    fakeAvailability.set("meta", true);
    const plan = await routing.route("muse-spark-1.3", {}, undefined, cachePath);
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") throw new Error(plan.reason);
    const providers = [plan.primary, ...plan.fallbacks].map((hop) => hop.provider);
    expect(providers).toContain("meta-muse-code");
    expect(providers).toContain("meta");
    expect(providers.indexOf("meta-muse-code")).toBeLessThan(providers.indexOf("meta"));
  });

  test("R2: Muse Code plan membership serves Wonder Full", () => {
    installMuseCatalog();
    expect(resolveSubscriptionRouting("muse-wonder-full", "meta-muse-code", cachePath)).toEqual({
      kind: "serves",
      externalId: "muse-wonder-full-1.0",
    });
  });
});
