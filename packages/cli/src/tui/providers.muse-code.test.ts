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
  overrides: Partial<import("../providers/meta-muse/muse-credentials.js").MuseCoreDeps> = {}
): import("../providers/meta-muse/muse-credentials.js").MuseCoreDeps {
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
  overrides: Partial<import("../providers/meta-muse/muse-keychain.js").MuseKeychainDeps> = {}
): import("../providers/meta-muse/muse-keychain.js").MuseKeychainDeps {
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
  const keychain = await import("../providers/keychain.js");
  const forbidden = () => {
    throw new Error("Real Keychain process forbidden");
  };
  keychain.setKeychainTestDeps({
    platform: () => "darwin",
    run: forbidden,
    runAsync: async () => forbidden(),
    spawnAsync: forbidden,
  });
  const core = await import("../providers/meta-muse/muse-credentials.js");
  core.resetMuseCredentialState();
  core.setMuseCoreTestDeps(fakeCoreDeps());
  const museKeychain = await import("../providers/meta-muse/muse-keychain.js");
  museKeychain.resetMuseKeychainState();
  museKeychain.setMuseKeychainTestDeps(fakeMuseKeychainDeps());
  (await import("../auth/credentials/prompt-role.js"))._resetCredentialPromptRoleForTest();
  const config = await import("../config-override.js");
  previousConfigPath = config.getConfigFileOverride();
  config.setConfigFileOverride(join(home, "config.json"));
});
afterEach(async () => {
  for (const restore of restoreRegistrations.splice(0).reverse()) restore();
  const core = await import("../providers/meta-muse/muse-credentials.js");
  core.resetMuseCredentialState();
  core.setMuseCoreTestDeps(null);
  const museKeychain = await import("../providers/meta-muse/muse-keychain.js");
  museKeychain.resetMuseKeychainState();
  museKeychain.setMuseKeychainTestDeps(null);
  const keychain = await import("../providers/keychain.js");
  keychain.invalidateKeychainCache();
  keychain.setKeychainTestDeps(null);
  (await import("../auth/credentials/prompt-role.js"))._resetCredentialPromptRoleForTest();
  (await import("../auth/credentials/billing-probe.js")).clearSignedArm();
  (await import("../providers/model-discovery.js")).invalidateModelDiscovery("meta-muse-code");
  (await import("../providers/all-models-cache.js"))._clearAllModelsCacheMemo();
  (await import("../providers/catalog-client.js"))._resetCatalogClient();
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
  expect(result.networkUrls).toEqual([]);
  return result;
}

test("U1: both providers appear before first login", async () => {
  const { getProviderDefs } = await import("./providers.js");
  const defs = getProviderDefs();
  expect(defs.some((p) => p.catalogName === "meta-muse-code" && p.apiKeyEnvVar === "")).toBe(true);
  expect(defs.some((p) => p.catalogName === "meta" && p.apiKeyEnvVar === "META_API_KEY")).toBe(
    true
  );
});

test("U1: only own login, borrowed copy and present Keychain count as configured", async () => {
  const { isMuseCredentialConfigured } = await import("../providers/meta-muse/muse-credentials.js");
  for (const status of ["own-login", "borrowed-copy", "keychain"] as const)
    expect(isMuseCredentialConfigured(status)).toBe(true);
  for (const status of ["absent", "failed", "unknown"] as const)
    expect(isMuseCredentialConfigured(status)).toBe(false);
});

test("U1: synchronous file-status projection performs zero Keychain operations", async () => {
  const { museCredentialStatus, setMuseCoreTestDeps, resetMuseCredentialState } = await import(
    "../providers/meta-muse/muse-credentials.js"
  );
  const { setMuseKeychainTestDeps, resetMuseKeychainState } = await import(
    "../providers/meta-muse/muse-keychain.js"
  );
  let starts = 0;
  let presenceChecks = 0;
  resetMuseKeychainState();
  setMuseKeychainTestDeps({
    ...fakeMuseKeychainDeps(),
    dir: () => home,
    presence: async () => {
      presenceChecks++;
      throw new Error("unexpected presence process");
    },
    startRead: () => {
      starts++;
      throw new Error("unexpected Keychain read");
    },
  });
  setMuseCoreTestDeps({ ...fakeCoreDeps(), dir: () => home, readStore: () => null });
  try {
    expect(museCredentialStatus(home)).toBe("unknown");
    setMuseCoreTestDeps({
      ...fakeCoreDeps(),
      dir: () => home,
      readStore: (kind) => (kind === "own-login" ? { access_token: "dca:TESTTOKEN0001" } : null),
    });
    expect(museCredentialStatus(home)).toBe("own-login");
    setMuseCoreTestDeps({
      ...fakeCoreDeps(),
      dir: () => home,
      readStore: (kind) =>
        kind === "borrowed-copy" ? { access_token: "dca:TESTTOKEN0001" } : null,
    });
    expect(museCredentialStatus(home)).toBe("borrowed-copy");
    expect(starts).toBe(0);
    expect(presenceChecks).toBe(0);
  } finally {
    resetMuseCredentialState();
    setMuseCoreTestDeps(null);
    resetMuseKeychainState();
    setMuseKeychainTestDeps(null);
  }
});

test("U1: render notes name source; credential state retains minted tier without Keychain", async () => {
  const ui = await import("./providers.js");
  const core = await import("../providers/meta-muse/muse-credentials.js");
  const keychain = await import("../providers/meta-muse/muse-keychain.js");
  const { setCredentialPromptRole } = await import("../auth/credentials/prompt-role.js");
  const role = setCredentialPromptRole("never");
  const p = ui.getProviderDefs().find((p) => p.catalogName === "meta-muse-code");
  if (!p) throw new Error("Muse provider missing");
  let operations = 0;
  keychain.resetMuseKeychainState();
  core.resetMuseCredentialState();
  keychain.setMuseKeychainTestDeps({
    ...fakeMuseKeychainDeps(),
    dir: () => home,
    env: () => ({}),
    presence: async () => {
      operations++;
      return { kind: "absent" };
    },
    startRead: () => {
      operations++;
      throw new Error("Keychain forbidden");
    },
  });
  core.setMuseCoreTestDeps({ ...fakeCoreDeps(), dir: () => home, readStore: () => null });
  try {
    // B18: capability support is independent of the default-path OAuth login.
    // Default-path set/readiness/source assertions run in an isolated child below.
    expect(p.oauthSlug).toBe("muse");
    expect(operations).toBe(0);
    const absentNote = ui.providerCredentialNote(p);
    const notes: string[] = [];
    for (const kind of ["own-login", "borrowed-copy"] as const) {
      core.resetMuseCredentialState();
      core.setMuseCoreTestDeps({
        ...fakeCoreDeps(),
        dir: () => home,
        readStore: (k) =>
          k === kind
            ? { access_token: "dca:TESTTOKEN0001", subs_tier_name: "Muse Code Power Usage" }
            : null,
        mint: async () => ({ apiKey: "LLM|TESTKEY0001", subsTierName: "Muse Code Power Usage" }),
      });
      await core.ensureMuseCredentialReady({ prompt: false });
      expect(core.currentMuseState()?.source).toBe(
        kind === "own-login" ? "claudish-login" : "borrowed-copy"
      );
      const note = ui.providerCredentialNote(p);
      expect(note).toBeDefined();
      expect(note?.trim().length).toBeGreaterThan(0);
      expect(note).not.toBe(absentNote);
      if (typeof note !== "string") throw new Error("credential note missing");
      notes.push(note);
      expect(core.currentMuseState()?.subsTierName).toBe("Muse Code Power Usage");
      expect(operations).toBe(0);
    }
    expect(notes[0]).not.toBe(notes[1]);
  } finally {
    core.resetMuseCredentialState();
    core.setMuseCoreTestDeps(null);
    keychain.resetMuseKeychainState();
    keychain.setMuseKeychainTestDeps(null);
    setCredentialPromptRole(role);
  }
});

test("U1: async Keychain presence projects present, absent and failed distinctly", async () => {
  const core = await import("../providers/meta-muse/muse-credentials.js");
  const keychain = await import("../providers/meta-muse/muse-keychain.js");
  let starts = 0;
  try {
    for (const [result, expected] of [
      [{ kind: "found" }, "keychain"],
      [{ kind: "absent" }, "absent"],
      [{ kind: "failed", code: 1, error: "test presence failure" }, "failed"],
    ] as const) {
      core.resetMuseCredentialState();
      keychain.resetMuseKeychainState();
      core.setMuseCoreTestDeps({ ...fakeCoreDeps(), dir: () => home, readStore: () => null });
      keychain.setMuseKeychainTestDeps({
        ...fakeMuseKeychainDeps(),
        dir: () => home,
        env: () => ({}),
        presence: async () => result,
        startRead: () => {
          starts++;
          throw new Error("value read forbidden");
        },
      });
      expect(await core.refreshMuseCredentialStatus()).toBe(expected);
      expect(core.museCredentialStatus(home)).toBe(expected);
      expect(core.isMuseCredentialConfigured(expected)).toBe(expected === "keychain");
    }
    expect(starts).toBe(0);
  } finally {
    core.resetMuseCredentialState();
    core.setMuseCoreTestDeps(null);
    keychain.resetMuseKeychainState();
    keychain.setMuseKeychainTestDeps(null);
  }
});

test("U1: malformed or empty-token files never configure Muse; valid own login is identified", async () => {
  const { writeFileSync } = await import("node:fs");
  const { museStorePath } = await import("../providers/meta-muse/muse-store.js");
  const {
    museCredentialStatusFromFiles,
    isMuseCredentialConfigured,
    setMuseCoreTestDeps,
    resetMuseCredentialState,
  } = await import("../providers/meta-muse/muse-credentials.js");
  const { readMuseStore } = await import("../providers/meta-muse/muse-store.js");
  setMuseCoreTestDeps({
    ...fakeCoreDeps(),
    dir: () => home,
    readStore: (kind) => readMuseStore(kind, home),
  });
  try {
    for (const content of [
      "{broken",
      JSON.stringify({ access_token: "" }),
      JSON.stringify({ api_key: "LLM|TESTKEY0001" }),
    ]) {
      writeFileSync(museStorePath("own-login", home), content, { mode: 0o600 });
      expect(isMuseCredentialConfigured(museCredentialStatusFromFiles(home))).toBe(false);
    }
    writeFileSync(
      museStorePath("own-login", home),
      JSON.stringify({ access_token: "dca:TESTTOKEN0001" }),
      { mode: 0o600 }
    );
    expect(museCredentialStatusFromFiles(home)).toBe("own-login");
  } finally {
    resetMuseCredentialState();
    setMuseCoreTestDeps(null);
  }
});

test("U1: OAuth set, readiness and source before/after login in an isolated child", async () => {
  const result = await runHomeScenario(async () => {
    const ui = await import("./providers.js");
    const core = await import("../providers/meta-muse/muse-credentials.js");
    const store = await import("../providers/meta-muse/muse-store.js");
    const { existsSync } = await import("node:fs");
    const p = ui.getProviderDefs().find((p) => p.catalogName === "meta-muse-code")!;
    core.setMuseCoreTestDeps({
      ...fakeCoreDeps(),
      dir: store.defaultMuseStoreDir,
      readStore: (kind) => store.readMuseStore(kind),
      mint: async () => ({ apiKey: "LLM|TESTKEY0001" }),
    });
    const project = () => ({
      oauth: ui.providerAuthCapabilities(p, {}).oauth,
      ready: ui.providerIsReady(p, {}),
      source: ui.providerAuthSource(p, {}),
    });
    const absent = project();
    expect(absent).toMatchObject({
      oauth: { supported: true, set: false },
      ready: false,
      source: null,
    });
    const present = [];
    for (const kind of ["own-login", "borrowed-copy"] as const) {
      store.deleteMuseStores();
      core.resetMuseCredentialState();
      if (kind === "own-login") store.writeMuseStore(kind, { access_token: "dca:TESTTOKEN0001" });
      else store.writeBorrowedCopy("dca:TESTTOKEN0001", "Muse Code Power Usage");
      await core.ensureMuseCredentialReady({ prompt: false });
      const projection = project();
      expect(projection).toMatchObject({
        oauth: { supported: true, set: true },
        ready: true,
        source: "oauth",
      });
      present.push({ kind, ...projection, fileExists: existsSync(store.museStorePath(kind)) });
    }
    return { absent, present };
  });
  expect(result.absent).toMatchObject({
    oauth: { supported: true, set: false },
    ready: false,
    source: null,
  });
  expect(result.present).toHaveLength(2);
  for (const projection of result.present) {
    expect(projection).toMatchObject({
      oauth: { supported: true, set: true },
      ready: true,
      source: "oauth",
      fileExists: true,
    });
  }
}, 15000);

test("U1: describeSourceSync follows the Muse core own-login seam", async () => {
  const { describeSourceSync } = await import("../auth/credentials/source.js");
  const core = await import("../providers/meta-muse/muse-credentials.js");
  const provider = { catalogName: "meta-muse-code", apiKeyEnvVar: "", oauthSlug: "muse" };
  core.resetMuseCredentialState();
  core.setMuseCoreTestDeps(
    fakeCoreDeps({
      readStore: (kind) => (kind === "own-login" ? { access_token: "dca:TESTTOKEN0001" } : null),
    })
  );
  expect(describeSourceSync(provider, {})).toBe("oauth");
  core.resetMuseCredentialState();
  core.setMuseCoreTestDeps(fakeCoreDeps({ readStore: () => null }));
  expect(describeSourceSync(provider, {})).toBeNull();
});
