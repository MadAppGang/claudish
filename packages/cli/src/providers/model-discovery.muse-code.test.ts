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

let restoreFetcher: (() => void) | undefined;
afterEach(() => {
  restoreFetcher?.();
  restoreFetcher = undefined;
});

async function installFetcher() {
  const discovery = await import("./model-discovery.js");
  await import("./model-discovery-builtins.js");
  // Save the built-in registration before replacing it.
  const { fetchMuseCodeModelsCatalog } = await import("./meta-muse/muse-models.js");
  const original = discovery.getModelDiscoveryFetcher("muse-code-models");
  if (!original) throw new Error("Muse discovery fetcher must be registered before replacement");
  expect(typeof fetchMuseCodeModelsCatalog).toBe("function");
  discovery.invalidateModelDiscovery("meta-muse-code");
  restoreFetcher = () => {
    discovery.registerModelDiscoveryFetcher("muse-code-models", original);
    discovery.invalidateModelDiscovery("meta-muse-code");
  };
  return discovery;
}

test("N2: discovery partitions opt-in ids, keeps exact entitlement and reported window", async () => {
  const d = await installFetcher();
  const { providerServesModel } = await import("./model-availability.js");
  let calls = 0;
  // Projection of the §4 capture into the public fetcher result. Contributor first.
  d.registerModelDiscoveryFetcher("muse-code-models", async () => {
    calls++;
    return {
      kind: "models",
      models: [
        { id: "muse-wonder-full-1.0-contributor", contextWindow: 1007997 },
        { id: "muse-wonder-full-1.0", contextWindow: 1007997 },
      ],
    };
  });
  const outcome = await d.discoverProviderModelsCatalog("meta-muse-code");
  expect(outcome.kind).toBe("served");
  if (outcome.kind !== "served") throw new Error(JSON.stringify(outcome));
  expect(outcome.models.map((m) => m.id)).toEqual(["muse-wonder-full-1.0"]);
  expect(outcome.optInIds).toEqual(["muse-wonder-full-1.0-contributor"]);
  expect(d.rankDiscoveredModels(outcome.models).map((m) => m.id)).toEqual(["muse-wonder-full-1.0"]);
  expect(await providerServesModel("meta-muse-code", "muse-wonder-full-1.0-contributor")).toBe(
    "serves"
  );
  expect(await d.discoverContextWindow("meta-muse-code", "muse-wonder-full-1.0")).toBe(1007997);
  expect(calls).toBe(1);
});

test("N2: a later success clears the prior failure and uses new reported context", async () => {
  const d = await installFetcher();
  let calls = 0;
  d.registerModelDiscoveryFetcher("muse-code-models", async () => {
    calls++;
    if (calls === 1)
      return {
        kind: "failed",
        failure: {
          kind: "no-credentials",
          detail: "Muse Code login not available in this process",
        },
      };
    // Negative fixture mutation: different served context verifies it is data-driven.
    return { kind: "models", models: [{ id: "muse-spark-1.3", contextWindow: 123456 }] };
  });
  expect((await d.discoverProviderModelsCatalog("meta-muse-code")).kind).toBe("failed");
  expect(d.getDiscoveryFailure("meta-muse-code")?.kind).toBe("no-credentials");
  expect((await d.discoverProviderModelsCatalog("meta-muse-code")).kind).toBe("served");
  expect(d.getDiscoveryFailure("meta-muse-code")).toBeUndefined();
  expect(await d.discoverContextWindow("meta-muse-code", "muse-spark-1.3")).toBe(123456);
  expect(calls).toBe(2);
});
