import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const children: ReturnType<typeof Bun.spawn>[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
});
async function waitForChild(child: ReturnType<typeof Bun.spawn>, stderr: Promise<string>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          if (child.exitCode === null) child.kill();
          void stderr.then((message) => {
            reject(new Error(`Probe child did not exit within 10 seconds: ${message}`));
          }, reject);
        }, 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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

// HOME must be present at process start: keep default-path consumers in Bun children.
// The callback and fake builders are serialized after Bun has stripped TypeScript.
async function runHomeScenario(scenario: () => Promise<Record<string, unknown>>) {
  const absoluteImports = (source: string) =>
    source.replace(
      /import\((["'])(\.[^"']+)\1\)/g,
      (_match, _quote, path) => `import(${JSON.stringify(resolve(import.meta.dir, path))})`
    );
  const scriptPath = join(home, "scenario.ts");
  const setup = `
    import { expect } from "bun:test";
    import fs from "node:fs";
    import fsp from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    import { join, resolve, relative, isAbsolute } from "node:path";
    import { fileURLToPath } from "node:url";
    import { homedir } from "node:os";
    const realExit = process.exit.bind(process);
    try {
    const home = process.env.HOME;
    expect(homedir()).toBe(home);
    process.exit = code => { throw new Error("RUN5_CHILD_EXIT:" + (code ?? 0)); };
    const savedFetch = globalThis.fetch;
    const networkUrls = [];
    globalThis.fetch = Object.assign(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.protocol !== "http:" && url.protocol !== "https:") return savedFetch(input, init);
      networkUrls.push(url.href);
      throw new Error("Unexpected child network: " + url.href);
    }, { preconnect() {} });
    // Audit and reject filesystem mutations outside the child's owned HOME.
    // Apply before implementation imports, including their singleton setup.
    const outsideWrites = [];
    const writes = [];
    function checkWrite(path) {
      if (typeof path === "number") return; // fd was checked when opened
      const target = resolve(path instanceof URL ? fileURLToPath(path) : String(path));
      const rel = relative(home, target);
      if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
        outsideWrites.push(target);
        throw new Error("Outside-HOME mutation forbidden: " + target);
      }
      writes.push(rel);
    }
    for (const api of [fs, fsp]) {
      for (const name of ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "mkdir", "mkdirSync",
        "rm", "rmSync", "rmdir", "rmdirSync", "unlink", "unlinkSync", "chmod", "chmodSync",
        "truncate", "truncateSync", "utimes", "utimesSync", "createWriteStream", "mkdtemp", "mkdtempSync"]) {
        const original = api[name];
        if (original) api[name] = function(path, ...args) { checkWrite(path); return original.call(this, path, ...args); };
      }
      for (const name of ["rename", "renameSync", "copyFile", "copyFileSync", "cp", "cpSync", "link", "linkSync", "symlink", "symlinkSync"]) {
        const original = api[name];
        if (original) api[name] = function(from, to, ...args) {
          if (name.startsWith("rename")) checkWrite(from);
          checkWrite(to); return original.call(this, from, to, ...args);
        };
      }
      for (const name of ["open", "openSync"]) {
        const original = api[name];
        if (original) api[name] = function(path, flags, ...args) {
          if (typeof flags === "number" ? (flags & 3) !== 0 || (flags & (fs.constants.O_CREAT | fs.constants.O_TRUNC)) !== 0 : /[wa+]/.test(flags)) checkWrite(path);
          return original.call(this, path, flags, ...args);
        };
      }
    }
    const bunWrite = Bun.write;
    Bun.write = (path, ...args) => { checkWrite(path); return bunWrite(path, ...args); };
    syncBuiltinESMExports();
  `;
  const initialization = `
    let keychainOperations = 0;
    const forbidden = () => { keychainOperations++; throw new Error("Real Keychain process forbidden"); };
    const generic = await import(${JSON.stringify(resolve(import.meta.dir, "../providers/keychain.js"))});
    generic.setKeychainTestDeps({ platform: () => "darwin", run: forbidden, runAsync: async () => forbidden(), spawnAsync: forbidden });
    const coreSetup = await import(${JSON.stringify(resolve(import.meta.dir, "../providers/meta-muse/muse-credentials.js"))});
    coreSetup.resetMuseCredentialState(); coreSetup.setMuseCoreTestDeps(fakeCoreDeps());
    const keychainSetup = await import(${JSON.stringify(resolve(import.meta.dir, "../providers/meta-muse/muse-keychain.js"))});
    keychainSetup.resetMuseKeychainState(); keychainSetup.setMuseKeychainTestDeps(fakeMuseKeychainDeps());
    (await import(${JSON.stringify(resolve(import.meta.dir, "../auth/credentials/prompt-role.js"))}))._resetCredentialPromptRoleForTest();
    (await import(${JSON.stringify(resolve(import.meta.dir, "../config-override.js"))})).setConfigFileOverride(join(home, "config.json"));
  `;
  writeFileSync(
    scriptPath,
    setup +
      absoluteImports(fakeCoreDeps.toString()) +
      "\n" +
      absoluteImports(fakeMuseKeychainDeps.toString()) +
      initialization +
      `\nconst result = await (${absoluteImports(scenario.toString())})();\n` +
      "expect(outsideWrites).toEqual([]);\nexpect(keychainOperations).toBe(0);\nexpect(networkUrls).toEqual([]);\nconsole.log(JSON.stringify({ ...result, outsideWrites, writes, keychainOperations, networkUrls }));\nrealExit(0);\n} catch (error) { console.error(error); realExit(1); }\n"
  );
  const child = Bun.spawn([process.execPath, scriptPath], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: home,
      CLAUDISH_DISABLE_KEYCHAIN: "1",
      CLAUDISH_DISABLE_CATALOG_WARM: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const stderrPromise = new Response(child.stderr).text();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    stderrPromise,
    waitForChild(child, stderrPromise),
  ]);
  expect(exitCode, `probe child exit ${exitCode} (124 means 4-second timeout): ${stderr}`).toBe(0);
  const lines = stdout.trim().split("\n");
  expect(lines, stderr).toHaveLength(1);
  const result = JSON.parse(lines[0]);
  expect(result.outsideWrites).toEqual([]);
  expect(result.keychainOperations).toBe(0);
  expect(result.networkUrls).toEqual([]);
  return result;
}

test("N4: probe cache round-trips only through an explicit temporary path", async () => {
  const p = await import("./probe-catalog.js");
  const path = join(home, "probe-models.json");
  const data = {
    version: 3 as const,
    generationId: "g-probe-wave4",
    generatedAt: new Date().toISOString(),
    providers: { "meta-muse-code": "muse-spark-1.3-contributor", meta: "muse-spark-1.3" },
    unavailable: {},
  };
  p.writeProbeModelsCache(data, path);
  expect(p.readProbeModelsCache(path)).toEqual(data);
});
test("N4: default-home cached probe picks exclude contributor ids", async () => {
  const result = await runHomeScenario(async () => {
    const p = await import("./probe-catalog.js");
    const { existsSync } = await import("node:fs");
    p.writeProbeModelsCache({
      version: 3,
      generationId: "g-probe-wave5",
      generatedAt: new Date().toISOString(),
      providers: { "meta-muse-code": "muse-spark-1.3-contributor", meta: "muse-spark-1.3" },
      unavailable: {},
    });
    return {
      contributor: p.getProbeModel("meta-muse-code"),
      plain: p.getProbeModel("meta"),
      cacheExists: existsSync(p.PROBE_MODELS_CACHE_PATH),
    };
  });
  expect(result).toMatchObject({ contributor: null, plain: "muse-spark-1.3", cacheExists: true });
});

test("N4: endpoint-discovered picks exclude contributor ids in an isolated child", async () => {
  const result = await runHomeScenario(async () => {
    const { createProxyServer } = await import("../proxy-server.js");
    const { discoverProbeModelFromEndpoint } = await import("./probe-catalog.js");
    const { getConfigFileOverride, setConfigFileOverride } = await import("../config-override.js");
    const d = await import("./model-discovery.js");
    await import("./model-discovery-builtins.js");
    const { credentials } = await import("../auth/credentials/authority.js");
    const { clearSignedArm } = await import("../auth/credentials/billing-probe.js");
    const { _clearProbeDiscoveryCache } = await import("./transport/probe-discovery.js");
    const prior = credentials.get("meta-muse-code");
    const fetcher = d.getModelDiscoveryFetcher("muse-code-models");
    if (!prior || !fetcher) throw new Error("missing registrations");
    const oldConfig = getConfigFileOverride();
    setConfigFileOverride(join(home, "config.json"));
    credentials.register({
      catalogName: "meta-muse-code",
      isAvailable: async () => true,
      getRequestAuth: async () => ({ headers: {}, arm: "oauth" }),
    });
    let ids = ["muse-spark-1.3-contributor", "muse-spark-1.3"];
    d.registerModelDiscoveryFetcher("muse-code-models", async () => ({
      kind: "models",
      models: ids.map((id) => ({ id, reported: "chat" })),
    }));
    d.invalidateModelDiscovery("meta-muse-code");
    _clearProbeDiscoveryCache();
    let loopbackRequests = 0;
    let proxy: Awaited<ReturnType<typeof createProxyServer>> | undefined;
    const blockedFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.protocol !== "http:" && url.protocol !== "https:") return savedFetch(input, init);
        if (
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        ) {
          loopbackRequests++;
          return savedFetch(input, init);
        }
        return blockedFetch(input, init);
      },
      { preconnect: () => {} }
    ) as typeof fetch;
    try {
      proxy = await createProxyServer(0, "", "muse@muse-spark-1.3", false, undefined, undefined, {
        quiet: true,
      });
      const plain = (await discoverProbeModelFromEndpoint(proxy.url, "meta-muse-code")).model;
      expect(plain).toBe("muse-spark-1.3");
      ids = ["muse-spark-1.3-contributor"];
      d.invalidateModelDiscovery("meta-muse-code");
      _clearProbeDiscoveryCache();
      proxy.invalidateHandlerCache("meta-muse-code");
      const contributorOnly = (await discoverProbeModelFromEndpoint(proxy.url, "meta-muse-code"))
        .model;
      expect(contributorOnly).toBeNull();
      return { plain, contributorOnly, loopbackRequests };
    } finally {
      await proxy?.shutdown();
      globalThis.fetch = blockedFetch;
      credentials.register(prior);
      credentials.invalidate("meta-muse-code");
      clearSignedArm();
      d.registerModelDiscoveryFetcher("muse-code-models", fetcher);
      d.invalidateModelDiscovery("meta-muse-code");
      _clearProbeDiscoveryCache();
      setConfigFileOverride(oldConfig);
    }
  });
  expect(result).toMatchObject({ plain: "muse-spark-1.3", contributorOnly: null });
  expect(result.loopbackRequests).toBeGreaterThanOrEqual(2);
}, 20000);
