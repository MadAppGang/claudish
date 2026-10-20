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

test("D1a: Muse and Meta have separate shortcuts, tiers, credentials and factories", async () => {
  const { getShortcuts, getProviderByName } = await import("./provider-definitions.js");
  const { catalogRouteForProvider } = await import("./catalog-route-bindings.js");
  const { SUBSCRIPTION_PROVIDERS } = await import("../handlers/shared/remote-provider-types.js");
  const shortcuts = getShortcuts();
  expect(shortcuts.muse).toBe("meta-muse-code");
  expect(shortcuts.meta).toBe("meta");
  expect(shortcuts.meta).not.toBe("ollamacloud");
  const muse = getProviderByName("meta-muse-code");
  const meta = getProviderByName("meta");
  expect(muse).toBeDefined();
  expect(meta).toBeDefined();
  expect(muse?.tier).toBe("subscription");
  expect(meta?.tier).toBe("native");
  expect(muse?.apiKeyEnvVar).toBe("");
  expect(meta?.apiKeyEnvVar).toBe("META_API_KEY");
  expect(typeof muse?.createHandler).toBe("function");
  expect(typeof meta?.createHandler).toBe("function");
  expect(catalogRouteForProvider("meta")).toEqual({
    routeId: "meta",
    routeProfileId: "direct-api",
  });
  expect(SUBSCRIPTION_PROVIDERS.has("meta-muse-code")).toBe(true);
  expect(SUBSCRIPTION_PROVIDERS.has("meta")).toBe(false);
});
