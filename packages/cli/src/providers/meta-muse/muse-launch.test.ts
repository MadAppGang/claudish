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
  overrides: Partial<import("./muse-credentials.js").MuseCoreDeps> = {}
): import("./muse-credentials.js").MuseCoreDeps {
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
  overrides: Partial<import("./muse-keychain.js").MuseKeychainDeps> = {}
): import("./muse-keychain.js").MuseKeychainDeps {
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
  const keychain = await import("../keychain.js");
  const forbidden = () => {
    throw new Error("Real Keychain process forbidden");
  };
  keychain.setKeychainTestDeps({
    platform: () => "darwin",
    run: forbidden,
    runAsync: async () => forbidden(),
    spawnAsync: forbidden,
  });
  const core = await import("./muse-credentials.js");
  core.resetMuseCredentialState();
  core.setMuseCoreTestDeps(fakeCoreDeps());
  const museKeychain = await import("./muse-keychain.js");
  museKeychain.resetMuseKeychainState();
  museKeychain.setMuseKeychainTestDeps(fakeMuseKeychainDeps());
  (await import("../../auth/credentials/prompt-role.js"))._resetCredentialPromptRoleForTest();
  const config = await import("../../config-override.js");
  previousConfigPath = config.getConfigFileOverride();
  config.setConfigFileOverride(join(home, "config.json"));
});
afterEach(async () => {
  for (const restore of restoreRegistrations.splice(0).reverse()) restore();
  const core = await import("./muse-credentials.js");
  core.resetMuseCredentialState();
  core.setMuseCoreTestDeps(null);
  const museKeychain = await import("./muse-keychain.js");
  museKeychain.resetMuseKeychainState();
  museKeychain.setMuseKeychainTestDeps(null);
  const keychain = await import("../keychain.js");
  keychain.invalidateKeychainCache();
  keychain.setKeychainTestDeps(null);
  (await import("../../auth/credentials/prompt-role.js"))._resetCredentialPromptRoleForTest();
  (await import("../../auth/credentials/billing-probe.js")).clearSignedArm();
  (await import("../model-discovery.js")).invalidateModelDiscovery("meta-muse-code");
  (await import("../all-models-cache.js"))._clearAllModelsCacheMemo();
  (await import("../catalog-client.js"))._resetCatalogClient();
  (await import("../../config-override.js")).setConfigFileOverride(previousConfigPath);
  restoreHarness();
});

test("P2: explicit Muse slots prepare; unrelated explicit providers do not", async () => {
  const { museSlots } = await import("./muse-launch.js");
  expect(museSlots(["muse@muse-wonder-full-1.0", "meta@muse-spark-1.3", null, 42, ""])).toEqual({
    explicit: true,
    bare: false,
  });
  expect(museSlots(["meta@muse-spark-1.3", "cx@gpt-6-astra", null])).toEqual({
    explicit: false,
    bare: false,
  });
});

test("P2: today's bare Muse name needs no Muse login with no published mapping", async () => {
  const { _setCatalogEntriesForTest, _resetCatalogClient } = await import("../catalog-client.js");
  const { museSlots, prepareMuseLoginForLaunch } = await import("./muse-launch.js");
  const { setMuseCoreTestDeps, resetMuseCredentialState } = await import("./muse-credentials.js");
  const { setCredentialPromptRole } = await import("../../auth/credentials/prompt-role.js");
  const role = setCredentialPromptRole("never");
  let reads = 0;
  resetMuseCredentialState();
  setMuseCoreTestDeps({
    ...fakeCoreDeps(),
    dir: () => home,
    readStore: () => {
      reads++;
      return null;
    },
    keychainLogin: async () => {
      throw new Error("Keychain must not be read");
    },
  });
  try {
    _setCatalogEntriesForTest([]);
    expect(museSlots(["muse-spark-1.3"])).toEqual({ explicit: false, bare: false });
    expect(await prepareMuseLoginForLaunch(["muse-spark-1.3"])).toEqual({ kind: "not-needed" });
    expect(reads).toBe(0);
  } finally {
    resetMuseCredentialState();
    setMuseCoreTestDeps(null);
    setCredentialPromptRole(role);
    _resetCatalogClient();
  }
});

test("P2: explicit never-role slot with no file is fatal with login guidance", async () => {
  const { prepareMuseLoginForLaunch } = await import("./muse-launch.js");
  const { setMuseCoreTestDeps, resetMuseCredentialState } = await import("./muse-credentials.js");
  const { setCredentialPromptRole } = await import("../../auth/credentials/prompt-role.js");
  const role = setCredentialPromptRole("never");
  let keychainReads = 0;
  resetMuseCredentialState();
  setMuseCoreTestDeps({
    ...fakeCoreDeps(),
    dir: () => home,
    readStore: () => null,
    keychainLogin: async () => {
      keychainReads++;
      throw new Error("unexpected Keychain read");
    },
  });
  try {
    const result = await prepareMuseLoginForLaunch(["muse@muse-wonder-full-1.0"]);
    expect(result.kind).toBe("fatal");
    if (result.kind !== "fatal") throw new Error(JSON.stringify(result));
    expect(result.message).toContain("claudish login muse");
    expect(keychainReads).toBe(0);
  } finally {
    resetMuseCredentialState();
    setMuseCoreTestDeps(null);
    setCredentialPromptRole(role);
  }
});

test.skip("P2 BLOCKED: future mapped bare slots require phase 17 Muse route binding; no public binding setter", () => {});

test("P2: never-role borrowed copy prepares discovery without reading Keychain", async () => {
  const { prepareMuseLoginForLaunch } = await import("./muse-launch.js");
  const { setMuseCoreTestDeps, resetMuseCredentialState, currentMuseState } = await import(
    "./muse-credentials.js"
  );
  const { setCredentialPromptRole } = await import("../../auth/credentials/prompt-role.js");
  const d = await import("../model-discovery.js");
  await import("../model-discovery-builtins.js");
  const originalFetcher = d.getModelDiscoveryFetcher("muse-code-models");
  if (!originalFetcher) throw new Error("Muse discovery fetcher is not registered");
  restoreRegistrations.push(() =>
    d.registerModelDiscoveryFetcher("muse-code-models", originalFetcher)
  );
  const role = setCredentialPromptRole("never");
  let keychainReads = 0;
  let mints = 0;
  resetMuseCredentialState();
  setMuseCoreTestDeps({
    ...fakeCoreDeps(),
    dir: () => home,
    readStore: (kind) =>
      kind === "borrowed-copy"
        ? { access_token: "dca:TESTTOKEN0001", subs_tier_name: "Muse Code Power Usage" }
        : null,
    keychainLogin: async () => {
      keychainReads++;
      throw new Error("unexpected Keychain read");
    },
    mint: async (token) => {
      expect(token).toBe("dca:TESTTOKEN0001");
      mints++;
      return { apiKey: "LLM|TESTKEY0001", subsTierName: "Muse Code Power Usage" };
    },
  });
  d.invalidateModelDiscovery("meta-muse-code");
  d.registerModelDiscoveryFetcher("muse-code-models", async () => ({
    kind: "models",
    models: [{ id: "muse-wonder-full-1.0", contextWindow: 1007997 }],
  }));
  try {
    expect(await prepareMuseLoginForLaunch(["muse@muse-wonder-full-1.0"])).toEqual({
      kind: "ready",
    });
    expect(currentMuseState()?.source).toBe("borrowed-copy");
    expect(await d.discoverContextWindow("meta-muse-code", "muse-wonder-full-1.0")).toBe(1007997);
    expect(keychainReads).toBe(0);
    expect(mints).toBe(1);
  } finally {
    d.registerModelDiscoveryFetcher("muse-code-models", originalFetcher);
    d.invalidateModelDiscovery("meta-muse-code");
    resetMuseCredentialState();
    setMuseCoreTestDeps(null);
    setCredentialPromptRole(role);
  }
});

test("P2: a real failed loopback fetch during mint warns rather than becoming fatal", async () => {
  const { prepareMuseLoginForLaunch } = await import("./muse-launch.js");
  const { setMuseCoreTestDeps, resetMuseCredentialState } = await import("./muse-credentials.js");
  const { setCredentialPromptRole } = await import("../../auth/credentials/prompt-role.js");
  const role = setCredentialPromptRole("never");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") });
  const closedUrl = server.url.href;
  await server.stop(true);
  resetMuseCredentialState();
  setMuseCoreTestDeps({
    ...fakeCoreDeps(),
    dir: () => home,
    readStore: (kind) => (kind === "borrowed-copy" ? { access_token: "dca:TESTTOKEN0001" } : null),
    mint: async () => {
      await savedFetch(closedUrl);
      throw new Error("closed endpoint unexpectedly answered");
    },
    keychainLogin: async () => {
      throw new Error("Keychain must not be read");
    },
  });
  try {
    const result = await prepareMuseLoginForLaunch(["muse@muse-wonder-full-1.0"]);
    expect(result.kind).toBe("warn");
    if (result.kind !== "warn") throw new Error(JSON.stringify(result));
    expect(result.message.length).toBeGreaterThan(0);
  } finally {
    resetMuseCredentialState();
    setMuseCoreTestDeps(null);
    setCredentialPromptRole(role);
  }
});
