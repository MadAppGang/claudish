import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  overrides: Partial<import("./providers/meta-muse/muse-credentials.js").MuseCoreDeps> = {}
): import("./providers/meta-muse/muse-credentials.js").MuseCoreDeps {
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
  overrides: Partial<import("./providers/meta-muse/muse-keychain.js").MuseKeychainDeps> = {}
): import("./providers/meta-muse/muse-keychain.js").MuseKeychainDeps {
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
  const keychain = await import("./providers/keychain.js");
  const forbidden = () => {
    throw new Error("Real Keychain process forbidden");
  };
  keychain.setKeychainTestDeps({
    platform: () => "darwin",
    run: forbidden,
    runAsync: async () => forbidden(),
    spawnAsync: forbidden,
  });
  const core = await import("./providers/meta-muse/muse-credentials.js");
  core.resetMuseCredentialState();
  core.setMuseCoreTestDeps(fakeCoreDeps());
  const museKeychain = await import("./providers/meta-muse/muse-keychain.js");
  museKeychain.resetMuseKeychainState();
  museKeychain.setMuseKeychainTestDeps(fakeMuseKeychainDeps());
  (await import("./auth/credentials/prompt-role.js"))._resetCredentialPromptRoleForTest();
  const config = await import("./config-override.js");
  previousConfigPath = config.getConfigFileOverride();
  config.setConfigFileOverride(join(home, "config.json"));
});
afterEach(async () => {
  for (const restore of restoreRegistrations.splice(0).reverse()) restore();
  const core = await import("./providers/meta-muse/muse-credentials.js");
  core.resetMuseCredentialState();
  core.setMuseCoreTestDeps(null);
  const museKeychain = await import("./providers/meta-muse/muse-keychain.js");
  museKeychain.resetMuseKeychainState();
  museKeychain.setMuseKeychainTestDeps(null);
  const keychain = await import("./providers/keychain.js");
  keychain.invalidateKeychainCache();
  keychain.setKeychainTestDeps(null);
  (await import("./auth/credentials/prompt-role.js"))._resetCredentialPromptRoleForTest();
  (await import("./auth/credentials/billing-probe.js")).clearSignedArm();
  (await import("./providers/model-discovery.js")).invalidateModelDiscovery("meta-muse-code");
  (await import("./providers/all-models-cache.js"))._clearAllModelsCacheMemo();
  (await import("./providers/catalog-client.js"))._resetCatalogClient();
  (await import("./config-override.js")).setConfigFileOverride(previousConfigPath);
  restoreHarness();
});

test("N3: picker offers Muse and Meta and emits the exact plain Muse spec", async () => {
  const { buildProviderChoices, buildExplicitModelSpec } = await import("./model-selector.js");
  const choices = buildProviderChoices();
  expect(choices.some((choice) => choice.provider === "meta-muse-code")).toBe(true);
  expect(choices.some((choice) => choice.provider === "meta")).toBe(true);
  expect(buildExplicitModelSpec("meta-muse-code", "muse-wonder-full-1.0")).toBe(
    "muse@muse-wonder-full-1.0"
  );
});

test("N3: discovery failure notice identifies the missing Muse login", async () => {
  const { formatDiscoveryFailureNotice } = await import("./model-selector.js");
  const notice = formatDiscoveryFailureNotice(
    "Muse Code",
    {
      kind: "no-credentials",
      provider: "meta-muse-code",
      detail: "Muse Code login not available in this process",
    },
    { apiKeyEnvVar: "", apiKeyUrl: "https://accountscenter.meta.com/muse_code/?ep=no_payg" }
  );
  expect(JSON.stringify(notice)).toContain("Muse Code");
  expect(JSON.stringify(notice).toLowerCase()).toContain("login");
});

test("N3: contributor-first cloud connections emit plain Meta specs and no implicit zgo contributor", async () => {
  const { _setChatCapabilityCachePathForTest } = await import(
    "./providers/transport/probe-discovery.js"
  );
  const { createCatalogClient } = await import("./providers/model-catalog.js");
  const { servedModelsForProvider, resolveProviderExternalId } = await import(
    "./model-selector.js"
  );
  const { writeAllModelsCache, readAllModelsCache, _clearAllModelsCacheMemo } = await import(
    "./providers/all-models-cache.js"
  );
  const connection = (routeId: string, externalModelId: string) => ({
    sourceProviderId: routeId,
    sourceCollectorId: "contract-fixture",
    confidence: "api_official" as const,
    routeStatus: "mapped" as const,
    route: { routeId, routeProfileId: "direct-api" },
    externalModelId,
  });
  // Contract v3 seed; ids copied from §4 / architecture §3b, not a Meta response.
  const entry = {
    modelId: "muse-spark-1.3",
    displayName: "Muse Spark",
    provider: "meta",
    aliases: [],
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsTools: true,
    aggregators: [
      connection("meta", "muse-spark-1.3-contributor"),
      connection("meta", "muse-spark-1.3"),
      {
        ...connection("opencode", "muse-spark-1.3-contributor"),
        route: { routeId: "opencode", routeProfileId: "go-subscription" },
      },
    ],
  };
  const cachePath = join(home, "picker-catalog.json");
  writeAllModelsCache(
    {
      version: 3,
      lastUpdated: new Date().toISOString(),
      entries: [entry],
      models: [{ id: entry.modelId }],
      plans: [],
      catalogGenerationId: "g-picker-wave2",
    },
    cachePath
  );
  const catalog = createCatalogClient({
    readSlimCache: () => readAllModelsCache(cachePath),
    getModelsByProvider: async () => [],
    getModelByIdFromFirebase: async () => null,
    searchModels: async () => [],
  });
  try {
    _setChatCapabilityCachePathForTest(cachePath);
    const rows = servedModelsForProvider("meta", catalog);
    expect(rows.map((r) => resolveProviderExternalId("meta", r))).toEqual(["muse-spark-1.3"]);
    expect(servedModelsForProvider("opencode-zen-go", catalog)).toEqual([]);
  } finally {
    _setChatCapabilityCachePathForTest(undefined);
    _clearAllModelsCacheMemo();
  }
});

test("N3: discovered reported chat rows exclude contributor-first ids before picker emission", async () => {
  const d = await import("./providers/model-discovery.js");
  await import("./providers/model-discovery-builtins.js");
  const { createCatalogClient } = await import("./providers/model-catalog.js");
  const { buildDiscoveredModelRows, buildExplicitModelSpec } = await import("./model-selector.js");
  const original = d.getModelDiscoveryFetcher("muse-code-models");
  if (!original) throw new Error("missing production discovery fetcher");
  restoreRegistrations.push(() => d.registerModelDiscoveryFetcher("muse-code-models", original));
  const catalog = createCatalogClient({
    readSlimCache: () => null,
    getModelsByProvider: async () => [],
    getModelByIdFromFirebase: async () => null,
    searchModels: async () => [],
  });
  d.invalidateModelDiscovery("meta-muse-code");
  d.registerModelDiscoveryFetcher("muse-code-models", async () => ({
    kind: "models",
    models: [
      { id: "muse-wonder-full-1.0-contributor", reported: "chat", contextWindow: 1007997 },
      { id: "muse-wonder-full-1.0", reported: "chat", contextWindow: 1007997 },
    ],
  }));
  try {
    const rows = await buildDiscoveredModelRows("meta-muse-code", "Muse Code", catalog);
    expect(rows.map((r) => buildExplicitModelSpec("meta-muse-code", r.id))).toEqual([
      "muse@muse-wonder-full-1.0",
    ]);
    expect(rows[0].contextLength).toBe(1007997);
  } finally {
    d.registerModelDiscoveryFetcher("muse-code-models", original);
    d.invalidateModelDiscovery("meta-muse-code");
  }
});
