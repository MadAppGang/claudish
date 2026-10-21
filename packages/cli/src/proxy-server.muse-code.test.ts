import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
  }
});
async function waitForChild(child: ReturnType<typeof Bun.spawn>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited,
      new Promise<number>((resolve) => {
        timer = setTimeout(() => {
          child.kill();
          resolve(124);
        }, 4000);
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

// HOME must be present at process start: keep default-path consumers in Bun children.
// The callback and fake builders are serialized after Bun has stripped TypeScript.
async function runHomeScenario(
  scenario: (transportAvailable: boolean) => Promise<Record<string, unknown>>,
  transportAvailable: boolean
) {
  const absoluteImports = (source: string) =>
    source.replace(
      /import\(\s*(["'])(\.[^"']+)\1\s*\)/g,
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
process.on("uncaughtException", error => { console.error(error); realExit(1); });
process.on("unhandledRejection", error => { console.error(error); realExit(1); });
    const home = process.env.HOME;
    expect(homedir()).toBe(home);
    process.exit = code => { throw new Error("RUN5_CHILD_EXIT:" + (code ?? 0)); };
    const savedFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.protocol !== "http:" && url.protocol !== "https:") return savedFetch(input, init);
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
    const generic = await import(${JSON.stringify(resolve(import.meta.dir, "./providers/keychain.js"))});
    generic.setKeychainTestDeps({ platform: () => "darwin", run: forbidden, runAsync: async () => forbidden(), spawnAsync: forbidden });
    const coreSetup = await import(${JSON.stringify(resolve(import.meta.dir, "./providers/meta-muse/muse-credentials.js"))});
    coreSetup.resetMuseCredentialState(); coreSetup.setMuseCoreTestDeps(fakeCoreDeps());
    const keychainSetup = await import(${JSON.stringify(resolve(import.meta.dir, "./providers/meta-muse/muse-keychain.js"))});
    keychainSetup.resetMuseKeychainState(); keychainSetup.setMuseKeychainTestDeps(fakeMuseKeychainDeps());
    (await import(${JSON.stringify(resolve(import.meta.dir, "./auth/credentials/prompt-role.js"))}))._resetCredentialPromptRoleForTest();
    (await import(${JSON.stringify(resolve(import.meta.dir, "./config-override.js"))})).setConfigFileOverride(join(home, "config.json"));
  `;
  writeFileSync(
    scriptPath,
    setup +
      absoluteImports(fakeCoreDeps.toString()) +
      "\n" +
      absoluteImports(fakeMuseKeychainDeps.toString()) +
      initialization +
      `\nconst result = await (${absoluteImports(scenario.toString())})(${JSON.stringify(transportAvailable)});\n` +
      "expect(outsideWrites).toEqual([]);\nexpect(keychainOperations).toBe(0);\nconsole.log(JSON.stringify({ ...result, outsideWrites, writes, keychainOperations }));\nrealExit(0);\n"
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
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    waitForChild(child),
  ]);
  expect(exitCode, stderr).toBe(0);
  const lines = stdout.trim().split("\n");
  expect(lines, stderr).toHaveLength(1);
  const result = JSON.parse(lines[0]);
  expect(result.outsideWrites).toEqual([]);
  expect(result.keychainOperations).toBe(0);
  return result;
}

for (const transportAvailable of [true, false]) {
  // MTL-189: meta/muse-code-subscription must stay bound.
  test(`N5: isolated-home Muse probe-discover with subscription binding and transport=${transportAvailable}; borrowed concurrent requests never read Keychain`, async () => {
    const scenario = async (transportAvailable: boolean) => {
      const { createProxyServer } = await import("./proxy-server.js");
      const { discoverProbeModelFromEndpoint } = await import("./providers/probe-catalog.js");
      const { catalogRouteForProvider } = await import("./providers/catalog-route-bindings.js");
      const { writeAllModelsCache, readAllModelsCache } = await import(
        "./providers/all-models-cache.js"
      );
      // Extracted with jq from cloud models catalog generation g-20261021063612126-17350b71.
      const { default: museCatalog } = await import(
        "./test-fixtures/catalog-v3/muse-code-g-20261021063612126-17350b71.json"
      );
      const data = structuredClone(museCatalog) as import(
        "./providers/all-models-cache.js"
      ).DiskCacheV3;
      // A catalog predating the profile still reaches the provider factory, so
      // the no-transport variant keeps testing provider-level discovery.
      if (!transportAvailable) {
        delete data.routeRegistry!.registry.routes.meta.profiles["muse-code-subscription"];
        data.entries = data.entries.map((entry) => ({
          ...entry,
          aggregators: entry.aggregators?.filter(
            (connection) => connection.route?.routeProfileId !== "muse-code-subscription"
          ),
        }));
        data.plans = [];
      }
      writeAllModelsCache(data);
      expect(readAllModelsCache()).not.toBeNull();
      const { getProviderByName } = await import("./providers/provider-definitions.js");
      const { getConfigFileOverride, setConfigFileOverride } = await import("./config-override.js");
      const { _clearProbeDiscoveryCache } = await import(
        "./providers/transport/probe-discovery.js"
      );
      const core = await import("./providers/meta-muse/muse-credentials.js");
      const keychain = await import("./providers/meta-muse/muse-keychain.js");
      const { setCredentialPromptRole } = await import("./auth/credentials/prompt-role.js");
      const { credentials } = await import("./auth/credentials/authority.js");
      const { MuseCodeCredentialProvider } = await import(
        "./auth/credentials/muse-code-credential.js"
      );
      const { clearSignedArm } = await import("./auth/credentials/billing-probe.js");
      const d = await import("./providers/model-discovery.js");
      await import("./providers/model-discovery-builtins.js");
      const prior = credentials.get("meta-muse-code");
      const fetcher = d.getModelDiscoveryFetcher("muse-code-models");
      const definition = getProviderByName("meta-muse-code");
      if (!prior || !fetcher || !definition) throw new Error("missing Muse registration");
      const factory = definition.createHandler;
      const config = getConfigFileOverride();
      setConfigFileOverride(join(home, "config.json"));
      const role = setCredentialPromptRole("never");
      let reads = 0;
      let mints = 0;
      let factoryCalls = 0;
      let upstream = 0;
      const statuses: number[] = [];
      keychain.resetMuseKeychainState();
      keychain.setMuseKeychainTestDeps({
        ...fakeMuseKeychainDeps(),
        dir: () => home,
        presence: async () => {
          reads++;
          return { kind: "absent" };
        },
        startRead: () => {
          reads++;
          throw new Error("Keychain forbidden");
        },
      });
      core.resetMuseCredentialState();
      core.setMuseCoreTestDeps({
        ...fakeCoreDeps(),
        dir: () => home,
        readStore: (kind) =>
          kind === "borrowed-copy" ? { access_token: "dca:TESTTOKEN0001" } : null,
        mint: async () => {
          mints++;
          return { apiKey: "LLM|TESTKEY0001" };
        },
        keychainLogin: async () => {
          reads++;
          throw new Error("Keychain forbidden");
        },
      });
      credentials.register(new MuseCodeCredentialProvider());
      d.registerModelDiscoveryFetcher("muse-code-models", async () => ({
        kind: "models",
        models: [{ id: "muse-spark-1.3", reported: "chat", contextWindow: 262144 }],
      }));
      d.invalidateModelDiscovery("meta-muse-code");
      _clearProbeDiscoveryCache();
      // The public factory permits a handler without a transport: exercise the
      // provider-level discovery fallback without reaching into private members.
      if (!transportAvailable)
        definition.createHandler = async () => {
          factoryCalls++;
          return {
            handle: async () => new Response("no inference in fallback fixture", { status: 418 }),
            shutdown: async () => {},
          };
        };
      let proxy: Awaited<ReturnType<typeof createProxyServer>> | undefined;
      try {
        expect(catalogRouteForProvider("meta-muse-code")).toEqual({
          routeId: "meta",
          routeProfileId: "muse-code-subscription",
        });
        proxy = await createProxyServer(0, "", "muse@muse-spark-1.3", false, undefined, undefined, {
          quiet: true,
        });
        const origin = new URL(proxy.url).origin;
        globalThis.fetch = Object.assign(
          (input: string | URL | Request, init?: RequestInit) => {
            const url = input instanceof Request ? input.url : String(input);
            if (new URL(url).origin === origin) return savedFetch(input, init);
            if (url === "https://api.meta.ai/v1/responses") {
              upstream++;
              return Promise.resolve(
                Response.json(
                  { error: { type: "invalid_api_key", message: "Unauthorized" } },
                  { status: 401 }
                )
              );
            }
            throw new Error(`Unexpected URL ${url}`);
          },
          { preconnect: () => {} }
        ) as typeof fetch;
        const result = await discoverProbeModelFromEndpoint(proxy.url, "meta-muse-code");
        expect(result.model).toBe("muse-spark-1.3");
        if (transportAvailable) {
          const request = () =>
            fetch(`${origin}/v1/messages`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                model: "muse@muse-spark-1.3",
                max_tokens: 16,
                stream: true,
                messages: [{ role: "user", content: "PONG" }],
              }),
            });
          const responses = await Promise.all([request(), request()]);
          for (const response of responses) {
            statuses.push(response.status);
            expect(response.status).toBe(400);
            expect(response.headers.get("x-claudish-auth-verdict")).toBe("terminal");
            expect(await response.text()).toContain("claudish login muse");
          }
          expect(upstream).toBeGreaterThanOrEqual(2);
          expect(mints).toBeGreaterThan(0);
        } else expect(factoryCalls).toBeGreaterThan(0);
        expect(reads).toBe(0);
        return { model: result.model, reads, mints, factoryCalls, upstream, statuses };
      } finally {
        await proxy?.shutdown();
        definition.createHandler = factory;
        credentials.register(prior);
        credentials.invalidate("meta-muse-code");
        clearSignedArm();
        d.registerModelDiscoveryFetcher("muse-code-models", fetcher);
        d.invalidateModelDiscovery("meta-muse-code");
        _clearProbeDiscoveryCache();
        core.resetMuseCredentialState();
        core.setMuseCoreTestDeps(null);
        keychain.resetMuseKeychainState();
        keychain.setMuseKeychainTestDeps(null);
        setCredentialPromptRole(role);
        setConfigFileOverride(config);
      }
    };
    const result = await runHomeScenario(scenario, transportAvailable);
    expect(result.model).toBe("muse-spark-1.3");
    expect(result.reads).toBe(0);
    if (transportAvailable) {
      expect(result.statuses).toEqual([400, 400]);
      expect(result.upstream).toBeGreaterThanOrEqual(2);
      expect(result.mints).toBeGreaterThan(0);
    } else expect(result.factoryCalls).toBeGreaterThan(0);
  }, 25000);
}
