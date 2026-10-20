import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CREDENTIAL_DECIDED_PROVIDERS,
  SUBSCRIPTION_PROVIDERS,
  getModelPricing,
  isSubscriptionProvider,
  registerSubscriptionCredentialProbe,
} from "../../handlers/shared/remote-provider-types.js";

// HOME must exist in the environment at process start for Bun's os.homedir().
// Keep the child and all of its writable resources under a per-case temp home.
const childRoots: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  for (const root of childRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function runHomeScenario(scenario: string) {
  const root = mkdtempSync(join(tmpdir(), "claudish-run4-child-"));
  childRoots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const scriptPath = join(home, "scenario.ts");
  const srcDir = resolve(import.meta.dir, "../..");
  const bootstrap = `
    import fs from "node:fs";
    import { homedir } from "node:os";
    import { resolve, isAbsolute } from "node:path";
    import { fileURLToPath, pathToFileURL } from "node:url";
    import { syncBuiltinESMExports } from "node:module";
    const realExit = process.exit;
    try {
    const home = process.env.HOME;
    if (homedir() !== home) throw new Error("child HOME was not honoured");
    const src = ${JSON.stringify(srcDir)};
    const load = (name) => import(pathToFileURL(resolve(src, name)).href);
    const writes = [];
    const outsideWrites = [];
    const checkWrite = (value) => {
      const path = resolve(value instanceof URL ? fileURLToPath(value) : String(value));
      if (path !== home && !path.startsWith(home + "/")) {
        outsideWrites.push(path);
        throw new Error("write outside child HOME: " + path);
      }
      writes.push(path);
    };
    // Audit before importing production modules, including cached named fs exports.
    for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "unlinkSync", "chmodSync", "truncateSync", "createWriteStream"]) {
      const original = fs[name];
      fs[name] = function(path, ...args) { checkWrite(path); return original.call(fs, path, ...args); };
    }
    for (const name of ["writeFile", "appendFile", "mkdir", "rm", "unlink", "chmod", "truncate"]) {
      const original = fs.promises[name];
      fs.promises[name] = async function(path, ...args) { checkWrite(path); return original.call(fs.promises, path, ...args); };
    }
    for (const name of ["renameSync", "copyFileSync"]) {
      const original = fs[name];
      fs[name] = function(from, to, ...args) {
        checkWrite(from); checkWrite(to); return original.call(fs, from, to, ...args);
      };
    }
    for (const name of ["writeFile", "appendFile", "mkdir", "rm", "unlink", "chmod", "truncate"]) {
      const original = fs[name];
      fs[name] = function(path, ...args) { checkWrite(path); return original.call(fs, path, ...args); };
    }
    for (const name of ["rename", "copyFile"]) {
      const original = fs[name];
      fs[name] = function(from, to, ...args) {
        checkWrite(from); checkWrite(to); return original.call(fs, from, to, ...args);
      };
      const promiseOriginal = fs.promises[name];
      fs.promises[name] = async function(from, to, ...args) {
        checkWrite(from); checkWrite(to); return promiseOriginal.call(fs.promises, from, to, ...args);
      };
    }
    const writesOnOpen = (flags) => typeof flags === "number"
      ? (flags & (1 | 2 | 64 | 512 | 1024)) !== 0 : /[wa+]/.test(flags ?? "r");
    for (const name of ["open", "openSync"]) {
      const original = fs[name];
      fs[name] = function(path, flags, ...args) {
        if (writesOnOpen(flags)) checkWrite(path);
        return original.call(fs, path, flags, ...args);
      };
    }
    const promiseOpen = fs.promises.open;
    fs.promises.open = async function(path, flags, ...args) {
      if (writesOnOpen(flags)) checkWrite(path);
      return promiseOpen.call(fs.promises, path, flags, ...args);
    };
    syncBuiltinESMExports();
    const bunWrite = Bun.write;
    Bun.write = function(path, ...args) { checkWrite(path); return bunWrite.call(Bun, path, ...args); };
    let networkRequests = 0;
    const networkUrls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.protocol !== "http:" && url.protocol !== "https:") return realFetch(input, init);
      networkRequests++;
      networkUrls.push(url.href);
      throw new Error("unexpected child network request");
    }, { preconnect: () => {} });
    let keychainOperations = 0;
    const keychainAbsent = () => { keychainOperations++; return { code: 44, stdout: "", stderr: "test absent" }; };
    const keychain = await load("providers/keychain.js");
    keychain.setKeychainTestDeps({
      platform: () => "darwin", run: keychainAbsent, runAsync: async () => keychainAbsent(),
      spawnAsync: () => ({ done: Promise.resolve(keychainAbsent()), pid: undefined }),
    });
    const core = await load("providers/meta-muse/muse-credentials.js");
    core.setMuseCoreTestDeps({
      dir: () => home, now: () => 1_800_000_000_000, readStore: () => null,
      writeBorrowedCopy: () => { throw new Error("unexpected borrowed write"); },
      mint: async () => { throw new Error("unexpected mint"); },
      keychainLogin: async () => ({ kind: "not-allowed" }),
    });
    const museKeychain = await load("providers/meta-muse/muse-keychain.js");
    museKeychain.setMuseKeychainTestDeps({
      dir: () => home, env: () => ({}), now: () => 1_800_000_000_000,
      sleep: async () => { throw new Error("unexpected keychain wait"); },
      pid: () => 424242, isAlive: () => false,
      presence: async () => ({ kind: "absent" }),
      startRead: () => ({ done: Promise.resolve({ kind: "absent" }), pid: undefined }),
    });
    const { OAUTH_PROVIDERS, hasOAuthCredentials, oauthCredentialWouldQualify } = await load("auth/oauth-registry.js");
    const credentialPath = (name) => {
      const file = OAUTH_PROVIDERS[name].credentialFile;
      if (isAbsolute(file) || file.includes("..")) throw new Error("unsafe credential filename");
      return resolve(home, ".claudish", file);
    };
    const { credentials } = await load("auth/credentials/authority.js");
    const report = (result) => console.log(JSON.stringify({
      ...result, home, writes, outsideWrites, networkRequests, networkUrls, keychainOperations,
    }));
  `;
  writeFileSync(
    scriptPath,
    bootstrap +
      scenario +
      "\nrealExit(0);\n} catch (error) { console.error(error); realExit(1); }\n"
  );
  const child = Bun.spawn([process.execPath, scriptPath], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: home,
      TMP: home,
      TEMP: home,
      CLAUDISH_DISABLE_KEYCHAIN: "1",
      CLAUDISH_DISABLE_CATALOG_WARM: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
  const lines = stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  const result = JSON.parse(lines[0]!);
  expect(result.home).toBe(home);
  expect(result.outsideWrites).toEqual([]);
  expect(result.writes.every((path: string) => path === home || path.startsWith(home + "/"))).toBe(
    true
  );
  expect(readdirSync(root)).toEqual(["home"]);
  expect(result.networkRequests).toBe(0);
  expect(result.networkUrls).toEqual([]);
  expect(result.keychainOperations).toBe(0);
  return result;
}

const savedEnvironment = new Map(["CLAUDISH_DISABLE_KEYCHAIN"].map((k) => [k, process.env[k]]));
const testHome = mkdtempSync(join(tmpdir(), "claudish-auth-tests-"));
process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
const realFetch = globalThis.fetch;
const realExit = process.exit;
const unexpectedExit = new Error("RUN4_UNEXPECTED_PROCESS_EXIT");
let exitAttempted = false;
globalThis.fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol === "http:" && url.hostname === "127.0.0.1") return realFetch(input, init);
    throw new Error(`Unexpected external request: ${url.origin}${url.pathname}`);
  },
  { preconnect: () => {} }
) as typeof fetch;
const keychain = await import("../../providers/keychain.js");
const fakeKeychainDeps = {
  platform: () => "darwin",
  run: () => ({ code: 44, stdout: "", stderr: "test: absent" }),
  runAsync: async () => ({ code: 44, stdout: "", stderr: "test: absent" }),
  spawnAsync: () => ({
    done: Promise.resolve({ code: 44, stdout: "", stderr: "test: absent" }),
    pid: undefined,
  }),
};
keychain.setKeychainTestDeps(fakeKeychainDeps);
beforeEach(() => {
  keychain.setKeychainTestDeps(fakeKeychainDeps);
});
afterEach(() => {
  keychain.setKeychainTestDeps(null);
  keychain.invalidateKeychainCache();
});
afterAll(() => {
  globalThis.fetch = realFetch;
  keychain.setKeychainTestDeps(null);
  keychain.invalidateKeychainCache();
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(testHome, { recursive: true, force: true });
});

const { CodexOAuth } = await import("../codex-oauth.js");
import { oauthCredentialWouldQualify } from "../oauth-registry.js";

// The one production registration site. Importing it is what installs the probe.
// The binding is also what lets the api-key-arm test below drive the REAL
// composite instead of a stub — see "FR-3: the REAL composite's api-key arm".
const { credentials } = await import("./authority.js");

const museCore = await import("../../providers/meta-muse/muse-credentials.js");
const museKeychain = await import("../../providers/meta-muse/muse-keychain.js");
const promptRole = await import("../../auth/credentials/prompt-role.js");
const catalogClient = await import("../../providers/catalog-client.js");
const allModelsCache = await import("../../providers/all-models-cache.js");
// Every seam is a complete fake: omitted fields would restore machine defaults.
beforeEach(() => {
  museCore.setMuseCoreTestDeps({
    dir: () => testHome,
    now: () => 1_800_000_000_000,
    readStore: () => null,
    writeBorrowedCopy: () => {
      throw new Error("unexpected borrowed-copy write");
    },
    mint: async () => {
      throw new Error("unexpected Muse mint");
    },
    keychainLogin: async () => ({ kind: "not-allowed" }),
  });
  museKeychain.setMuseKeychainTestDeps({
    dir: () => testHome,
    env: () => ({}),
    now: () => 1_800_000_000_000,
    sleep: async () => {
      throw new Error("unexpected Muse Keychain wait");
    },
    pid: () => 424242,
    isAlive: () => false,
    presence: async () => ({ kind: "absent" }),
    startRead: () => ({ done: Promise.resolve({ kind: "absent" as const }), pid: undefined }),
  });
});
afterEach(() => {
  process.exit = realExit;
  museCore.setMuseCoreTestDeps(null);
  museCore.resetMuseCredentialState();
  museKeychain.setMuseKeychainTestDeps(null);
  museKeychain.resetMuseKeychainState();
  promptRole._resetCredentialPromptRoleForTest();
  catalogClient._resetCatalogClient();
  allModelsCache._clearAllModelsCacheMemo();
  keychain.invalidateKeychainCache();
});

// Imported dynamically, and AFTER the authority, only to keep the ordering above
// honest: this is the sole production writer of the signed-arm record.
const { OpenAICodexTransport } = await import("../../providers/transport/openai-codex.js");

const singleton = CodexOAuth.getInstance();

/** A model name that cannot be in any warmed dynamic pricing cache. */
const SYNTHETIC_MODEL = "billing-probe-test-model";

/** An obviously-fake OPENAI_CODEX_API_KEY. Never sent anywhere. */
const METERED_KEY = "sk-codex-metered-fixture";

const { clearSignedArm, recordSignedArm } = await import("./billing-probe.js");
let savedProvider: ReturnType<typeof credentials.get>;
let savedHasCredentials: PropertyDescriptor | undefined;
let savedEnvCodexKey: string | undefined;

/** Drive "which credential WOULD sign" without touching the filesystem. */
function setHasCredentials(value: boolean): void {
  singleton.hasCredentials = () => value;
}

/**
 * Put an own-property override back the way it was — which may be ABSENT (fall
 * through to the prototype) or another file's override, never assumed to be the
 * prototype method.
 */
function restoreOwn(target: object, key: string, saved: PropertyDescriptor | undefined): void {
  if (saved) Object.defineProperty(target, key, saved);
  else delete (target as Record<string, unknown>)[key];
}

beforeEach(() => {
  savedProvider = credentials.get("openai-codex");
  savedHasCredentials = Object.getOwnPropertyDescriptor(singleton, "hasCredentials");
  savedEnvCodexKey = process.env.OPENAI_CODEX_API_KEY;
  credentials.invalidate();
});

afterEach(() => {
  if (savedProvider) credentials.register(savedProvider, ["openai-codex"]);
  // Restore whatever was installed BEFORE this test — which may be another
  // file's override, not the prototype method.
  if (savedHasCredentials) {
    Object.defineProperty(singleton, "hasCredentials", savedHasCredentials);
  } else {
    delete (singleton as unknown as Record<string, unknown>).hasCredentials;
  }
  clearSignedArm();
  if (savedEnvCodexKey === undefined) delete process.env.OPENAI_CODEX_API_KEY;
  else process.env.OPENAI_CODEX_API_KEY = savedEnvCodexKey;
  // ApiKeyCredentialProvider MEMOIZES the resolved key (api-key-credential.ts:110),
  // so without this the fixture key set by a test outlives it and every later file
  // in the run sees a credentialed openai-codex. Must run AFTER the env restore.
  credentials.invalidate("openai-codex");
  credentials.invalidate();
});

/** The transport under test, carrying the production definition's fields. */
function makeCodexTransport(apiKey: string): InstanceType<typeof OpenAICodexTransport> {
  return new OpenAICodexTransport(
    {
      name: "openai-codex",
      baseUrl: "https://api.openai.com",
      apiPath: "/v1/responses",
      apiKeyEnvVar: "OPENAI_CODEX_API_KEY",
      prefixes: [],
    },
    "gpt-test",
    apiKey
  );
}

describe("FR-3: openai-codex billing follows the credential in play", () => {
  test("B2: real Codex file predicate rejects no-refresh and absent files in child HOME", async () => {
    const result = await runHomeScenario(`
      delete process.env.OPENAI_CODEX_API_KEY;
      const { CodexOAuth } = await load("auth/codex-oauth.js");
      const { isSubscriptionProvider, getModelPricing } = await load("handlers/shared/remote-provider-types.js");
      const { clearSignedArm } = await load("auth/credentials/billing-probe.js");
      const path = credentialPath("openai-codex");
      const oauth = CodexOAuth.getInstance();
      const observe = () => {
        oauth.reloadCredentials();
        credentials.invalidate("openai-codex");
        clearSignedArm();
        const pricing = getModelPricing("openai-codex", "billing-probe-test-model");
        return { hasCredentials: oauth.hasCredentials(), subscription: isSubscriptionProvider("openai-codex"),
          fileExists: fs.existsSync(path), priceSubscription: pricing.isSubscription === true,
          input: pricing.inputCostPer1M, output: pricing.outputCostPer1M };
      };
      const absent = observe();
      const trap = { access_token: "at-no-refresh", expires_at: Date.now() + 3_600_000 };
      fs.mkdirSync(resolve(home, ".claudish"), { recursive: true });
      fs.writeFileSync(path, JSON.stringify(trap));
      const noRefresh = observe();
      const rejectedOracle = oauthCredentialWouldQualify("openai-codex", trap);
      fs.writeFileSync(path, JSON.stringify({ ...trap, refresh_token: "codex-test-refresh" }));
      const complete = observe();
      fs.unlinkSync(path);
      const removed = observe();
      report({ absent, noRefresh, rejectedOracle, complete, removed });
    `);
    for (const state of [result.absent, result.noRefresh, result.removed]) {
      expect(state.hasCredentials).toBe(false);
      expect(state.subscription).toBe(false);
      expect(state.priceSubscription).toBe(false);
      expect(state.input).toBeGreaterThan(0);
    }
    expect(result.absent.fileExists).toBe(false);
    expect(result.noRefresh.fileExists).toBe(true);
    expect(result.removed.fileExists).toBe(false);
    expect(result.rejectedOracle).toBe(true);
    expect(result.complete).toMatchObject({
      hasCredentials: true,
      subscription: true,
      fileExists: true,
      priceSubscription: true,
      input: 0,
      output: 0,
    });
  });
  test("wiring: importing authority.js installs the probe, and the answer tracks it", () => {
    // Fails on ANY machine when the probe is not registered — the first assertion
    // is false without it, regardless of whether a real oauth file exists.
    //
    // LOAD-BEARING, and more so than it looks: this is also the assertion that
    // kills the "use hasOAuthCredentials instead" substitution HERMETICALLY. That
    // oracle reads a file, so its answer is CONSTANT across the two halves below,
    // while these assertions demand two different answers from the same call. One
    // half or the other must fail, whichever way the machine is configured —
    // measured both ways (file present: this test + 3 others red; file absent:
    // this test + 4 others red). Do not collapse it into a single-value check.
    setHasCredentials(true);
    expect(isSubscriptionProvider("openai-codex")).toBe(true);

    setHasCredentials(false);
    expect(isSubscriptionProvider("openai-codex")).toBe(false);
  });

  test("OAuth would sign → subscription, and the pricing is a real zero", () => {
    setHasCredentials(true);

    const pricing = getModelPricing("openai-codex", SYNTHETIC_MODEL);
    expect(pricing.isSubscription).toBe(true);
    expect(pricing.inputCostPer1M).toBe(0);
    expect(pricing.outputCostPer1M).toBe(0);
  });

  test("THE TRAP: access_token unexpired with NO refresh_token → METERED", () => {
    // The pure qualification rule accepts an unexpired access token. Billing
    // consults the public hasCredentials predicate, overridden below per B2.
    // Its real file-backed evaluation runs in the B2 child-process case above.
    const trap = { access_token: "at-no-refresh", expires_at: Date.now() + 3_600_000 };
    expect(trap.access_token).toBeTruthy();
    expect(trap.expires_at).toBeGreaterThan(Date.now());
    expect("refresh_token" in trap).toBe(false);

    // THE DISCRIMINATION, asserted rather than assumed: the REJECTED oracle would
    // call this credential usable (⇒ it would report SUB), the CHOSEN one does not.
    // If these two ever agree, the choice recorded in billing-probe.ts stopped
    // being load-bearing and this whole test should be re-derived.
    expect(oauthCredentialWouldQualify("openai-codex", trap)).toBe(true);

    // This control isolates probe wiring; B2 above exercises the real file reader.
    setHasCredentials(false);

    // The mechanism, asserted so a change to either half is attributable.
    expect(singleton.hasCredentials()).toBe(false);
    expect(isSubscriptionProvider("openai-codex")).toBe(false);

    const pricing = getModelPricing("openai-codex", SYNTHETIC_MODEL);
    expect(pricing.isSubscription).toBeUndefined();
    expect(pricing.isEstimate).toBe(true);
    expect(pricing.inputCostPer1M).toBeGreaterThan(0);
  });

  test("presence probe: no OAuth credential → METERED", () => {
    // Scope, stated so this is not read as more than it is: the probe path is
    // isSubscriptionProvider → the closure at billing-probe.ts:104 →
    // CodexOAuth.hasCredentials(). It reads NO env var, so setting
    // OPENAI_CODEX_API_KEY here would be inert and is deliberately not done —
    // an earlier version set it and read as a second case when it was the same
    // one. The api-key arm is exercised for real in "the REAL composite's
    // api-key arm" below, which drives the composite and the transport.
    setHasCredentials(false);

    expect(singleton.hasCredentials()).toBe(false);
    expect(isSubscriptionProvider("openai-codex")).toBe(false);

    const pricing = getModelPricing("openai-codex", SYNTHETIC_MODEL);
    expect(pricing.isSubscription).toBeUndefined();
    expect(pricing.inputCostPer1M).toBeGreaterThan(0);
  });

  // "neither credential present → METERED" used to live here. It was deleted, not
  // lost: with the inert `process.env` write removed from the test above, the two
  // were byte-identical in behaviour — the presence probe cannot distinguish them.
  // Two spellings of one case read as two cases and hid the missing one.
});

describe("FR-3: the REAL composite's api-key arm", () => {
  test("api-key arm signs api.openai.com, so the recorded arm must be METERED", async () => {
    // THE configuration the whole of FR-3 exists for, built from the production
    // classes with NOTHING stubbed on getRequestAuth: a user with
    // OPENAI_CODEX_API_KEY and no usable ChatGPT OAuth
    // (provider-definitions.ts:410-412 — a first-class supported setup).
    //
    // CompositeCredentialProvider.getRequestAuth takes
    // `return this.fallback.getRequestAuth(ctx)` (composite-credential.ts:61) when
    // the primary is unavailable, and the api-key half RETURNS AN ARTIFACT
    // (api-key-credential.ts:283) — it never returns null and never throws. So any
    // discriminator built on "the composite returned something" answers
    // subscription here, for a request OpenAI meters. That is the money-losing
    // direction, and this test is the one that says so.
    //
    // Hermetic: the OAuth half is switched off through the singleton seam, and the
    // key comes from process.env, which is step 1 of the resolution chain
    // (api-key-credential.ts:168-172) — the keychain and 1Password steps are never
    // reached, so nothing here depends on this machine.
    setHasCredentials(false);
    process.env.OPENAI_CODEX_API_KEY = METERED_KEY;
    credentials.invalidate("openai-codex"); // drop any memoized resolution first

    // (1) The artifact is NON-NULL on the metered arm — asserted on its own so a
    //     change in the credential layer is attributable there, not to the
    //     transport. This single fact is what made `cachedAuth ? ... : ...` wrong.
    const artifact = await credentials.getRequestAuth("openai-codex", { model: "" });
    expect(artifact).toBeTruthy();
    expect(artifact.headers.Authorization).toBe(`Bearer ${METERED_KEY}`);
    // Only the OAuth half sets an endpoint override (codex-credential.ts:54).
    expect(artifact.endpoint).toBeUndefined();

    // (2) The transport really does sign the METERED host with that key.
    const transport = makeCodexTransport(METERED_KEY);
    await transport.refreshAuth();
    expect(transport.getEndpoint()).toBe("https://api.openai.com/v1/responses");
    expect((await transport.getHeaders()).Authorization).toBe(`Bearer ${METERED_KEY}`);

    // (3) …so every billing surface must say METERED, and the price must be a
    //     real per-token figure rather than a subscription zero.
    expect(isSubscriptionProvider("openai-codex")).toBe(false);
    const pricing = getModelPricing("openai-codex", SYNTHETIC_MODEL);
    expect(pricing.isSubscription).toBeUndefined();
    expect(pricing.inputCostPer1M).toBeGreaterThan(0);
  });

  test("an artifact that names no arm is METERED — the default must stay safe", async () => {
    // A future credential provider that forgets the marker, and the shape the
    // api-key half returns with no key resolved at all: `{headers:{}}`, which is
    // truthy. Stubbed rather than driven through the real composite ON PURPOSE —
    // resolving "no key" for real would fall through to the keychain and 1Password
    // steps (api-key-credential.ts:176-205) and touch this developer's machine.
    // The stub reproduces the artifact those steps would produce, exactly.
    setHasCredentials(true); // the presence probe would say subscription…
    const real = credentials.get("openai-codex")!;
    try {
      credentials.register(
        {
          catalogName: "openai-codex",
          isAvailable: async () => true,
          describeReadiness: async () => ({ readiness: "present" }),
          getRequestAuth: async () => ({ headers: {} }),
        },
        ["openai-codex"]
      );
      const transport = makeCodexTransport("");
      await transport.refreshAuth();
      // …but nothing said an arm, so the answer is metered.
      expect(isSubscriptionProvider("openai-codex")).toBe(false);
    } finally {
      credentials.register(real, ["openai-codex"]);
      credentials.invalidate("openai-codex");
    }
  });
});

describe("FR-3: the recorded arm beats the presence probe", () => {
  test("a metered signed arm overrides an available OAuth presence probe", () => {
    setHasCredentials(true);
    recordSignedArm("openai-codex", "metered");
    expect(isSubscriptionProvider("openai-codex")).toBe(false);
    expect(getModelPricing("openai-codex", SYNTHETIC_MODEL).isSubscription).not.toBe(true);
  });
  test("a subscription signed arm overrides an absent presence probe", () => {
    setHasCredentials(false);
    recordSignedArm("openai-codex", "subscription");
    expect(isSubscriptionProvider("openai-codex")).toBe(true);
    expect(getModelPricing("openai-codex", SYNTHETIC_MODEL).inputCostPer1M).toBe(0);
  });
  test("clear a provider record and clear all both restore the presence probe", () => {
    setHasCredentials(true);
    recordSignedArm("openai-codex", "metered");
    clearSignedArm("openai-codex");
    expect(isSubscriptionProvider("openai-codex")).toBe(true);
    recordSignedArm("openai-codex", "metered");
    clearSignedArm();
    expect(isSubscriptionProvider("openai-codex")).toBe(true);
  });
  test.each(["invalidate", "logout"] as const)(
    "authority %s clears a signed record",
    async (action) => {
      setHasCredentials(true);
      recordSignedArm("openai-codex", "metered");
      expect(isSubscriptionProvider("openai-codex")).toBe(false);
      // Local credential registration keeps logout free of browser/remote work.
      credentials.register(
        {
          catalogName: "openai-codex",
          isAvailable: async () => true,
          getRequestAuth: async () => ({ headers: {} }),
          logout: async () => {},
        },
        ["openai-codex"]
      );
      recordSignedArm("openai-codex", "metered");
      if (action === "logout") {
        // This authority call should return normally. Fail recognisably if an
        // implementation starts exiting like the public CLI command does.
        exitAttempted = false;
        process.exit = (): never => {
          exitAttempted = true;
          throw unexpectedExit;
        };
        try {
          await expect(credentials.logout("openai-codex")).resolves.toBeUndefined();
          expect(exitAttempted).toBe(false);
        } finally {
          process.exit = realExit;
        }
      } else credentials.invalidate("openai-codex");
      expect(isSubscriptionProvider("openai-codex")).toBe(true);
    }
  );

  test("refreshAuth() writes the record, per request, from the REAL arms", async () => {
    // The only production writer, driven end to end through the real
    // CodexOAuthHalf → CompositeCredentialProvider → ApiKeyCredentialProvider.
    // NOTHING is stubbed on the credential authority.
    //
    // The previous version of this test replaced `credentials.getRequestAuth`
    // with two stubs: one that THREW, and one that returned a hand-written OAuth
    // artifact. Both were wrong models of the code they guarded. The throw is a
    // shape the real composite produces only for a rejected refresh, so it made
    // "cachedAuth is null ⇒ api-key path" look like the whole story; and a
    // hand-written artifact can never catch a marker the production half fails to
    // set. That pairing is how C-1 shipped green. The seam moved DOWN, to the
    // CodexOAuth singleton, so every layer above it is the production one.
    process.env.OPENAI_CODEX_API_KEY = METERED_KEY;
    credentials.invalidate("openai-codex");
    const transport = makeCodexTransport(METERED_KEY);

    // OAuth credentials exist, so "what WOULD sign" says subscription…
    setHasCredentials(true);
    const savedToken = Object.getOwnPropertyDescriptor(singleton, "getAccessToken");
    const savedAccount = Object.getOwnPropertyDescriptor(singleton, "getAccountId");
    const mutable = singleton as unknown as Record<string, unknown>;
    try {
      const unavailable = new Error("refresh rejected");
      mutable.getAccessToken = async () => {
        throw unavailable;
      };
      await expect(transport.refreshAuth()).rejects.toBe(unavailable);
      expect(isSubscriptionProvider("openai-codex")).toBe(true);

      // The OAuth arm wins on the next request → back to subscription. The
      // endpoint, the headers and the arm marker all come from the production
      // CodexOAuthHalf, so this assertion fails if it ever stops marking itself.
      mutable.getAccessToken = async () => "oauth-access-token-fixture";
      mutable.getAccountId = () => "acct-fixture";
      await transport.refreshAuth();
      expect(transport.getEndpoint()).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect((await transport.getHeaders()).Authorization).toBe(
        "Bearer oauth-access-token-fixture"
      );
      expect(isSubscriptionProvider("openai-codex")).toBe(true);

      // E2: a rejected refresh after successful OAuth cannot switch billing arms.
      const { terminalCredentialError } = await import("./credential-error.js");
      const rejected = terminalCredentialError("run `claudish login codex`", 400);
      mutable.getAccessToken = async () => {
        throw rejected;
      };
      await expect(credentials.getRequestAuth("openai-codex", { model: "" })).rejects.toBe(
        rejected
      );
      await expect(transport.refreshAuth()).rejects.toBe(rejected);
      expect(isSubscriptionProvider("openai-codex")).toBe(true);
      const { ComposedHandler } = await import("../../handlers/composed-handler.js");
      const { DefaultAPIFormat } = await import("../../adapters/base-api-format.js");
      const { Hono } = await import("hono");
      let inferenceRequests = 0;
      const fetchBefore = globalThis.fetch;
      globalThis.fetch = Object.assign(
        async () => {
          inferenceRequests++;
          throw new Error("no inference expected after rejected refresh");
        },
        { preconnect: () => {} }
      ) as typeof fetch;
      const handler = new ComposedHandler(transport, "gpt-test", "gpt-test", 0, {
        adapter: new DefaultAPIFormat("gpt-test"),
        catalogCachePath: join(testHome, "empty.json"),
      });
      try {
        const app = new Hono();
        app.post("/", (c) =>
          handler.handle(c, {
            messages: [{ role: "user", content: "PONG" }],
            stream: false,
            max_tokens: 64,
          })
        );
        const response = await app.request("http://localhost/", { method: "POST" });
        expect(response.status).toBe(400);
        expect(response.headers.get("x-claudish-auth-verdict")).toBe("terminal");
        expect(await response.text()).toContain("login codex");
        expect(inferenceRequests).toBe(0);
        expect(isSubscriptionProvider("openai-codex")).toBe(true);
      } finally {
        globalThis.fetch = fetchBefore;
        await handler.shutdown();
      }
    } finally {
      restoreOwn(singleton, "getAccessToken", savedToken);
      restoreOwn(singleton, "getAccountId", savedAccount);
    }
  });
});

describe("FR-3: the registration seam", () => {
  test("an unregistered probe means METERED, the safe default", () => {
    const previous = registerSubscriptionCredentialProbe(null);
    try {
      // Also proves the production probe WAS installed: null here would mean the
      // authority import registered nothing.
      expect(typeof previous).toBe("function");
      setHasCredentials(true);
      expect(isSubscriptionProvider("openai-codex")).toBe(false);
      expect(getModelPricing("openai-codex", SYNTHETIC_MODEL).isSubscription).toBeUndefined();
    } finally {
      registerSubscriptionCredentialProbe(previous);
    }
  });

  test("the registrar RETURNS the previous probe, so a test can restore it", () => {
    // Restoring `null` instead would uninstall the production probe for the rest
    // of the Bun process and break sibling files by run order.
    const fake = () => true;
    const production = registerSubscriptionCredentialProbe(fake);
    expect(typeof production).toBe("function");
    expect(production).not.toBe(fake);

    const handedBack = registerSubscriptionCredentialProbe(production);
    expect(handedBack).toBe(fake);
    expect(registerSubscriptionCredentialProbe(production)).toBe(production);
  });

  test("only the canonical uid is credential-decided; the shortcut is not", () => {
    setHasCredentials(true);
    expect(isSubscriptionProvider("cx")).toBe(false);
    expect(isSubscriptionProvider("OPENAI-CODEX")).toBe(true);
  });

  test("openai-codex is never in the name-keyed set, which would short-circuit the probe", () => {
    for (const name of CREDENTIAL_DECIDED_PROVIDERS) {
      expect(SUBSCRIPTION_PROVIDERS.has(name)).toBe(false);
    }
    expect(SUBSCRIPTION_PROVIDERS.has("openai-codex")).toBe(false);
    expect(CREDENTIAL_DECIDED_PROVIDERS.has("openai-codex")).toBe(true);
  });

  test("no other provider consults the probe", () => {
    const previous = registerSubscriptionCredentialProbe(() => true);
    try {
      expect(isSubscriptionProvider("openai")).toBe(false);
      expect(isSubscriptionProvider("opencode-zen")).toBe(false);
      // A name-set member stays true without ever reaching the probe.
      expect(isSubscriptionProvider("kimi-coding")).toBe(true);
    } finally {
      registerSubscriptionCredentialProbe(previous);
    }
  });
});

describe("BILL1: Muse subscription and metered Meta billing categories", () => {
  test("Muse records subscription pricing as zero; Meta stays metered", () => {
    expect(isSubscriptionProvider("meta-muse-code")).toBe(true);
    expect(isSubscriptionProvider("meta")).toBe(false);
    const muse = getModelPricing("meta-muse-code", SYNTHETIC_MODEL);
    expect(muse.isSubscription).toBe(true);
    expect(muse.inputCostPer1M).toBe(0);
    expect(muse.outputCostPer1M).toBe(0);
    expect(getModelPricing("meta", SYNTHETIC_MODEL).isSubscription).not.toBe(true);
  });
  test.skip("BLOCKED BILL1: registerDynamicPricingLookup returns void, exposes no previous lookup/reset, and ResolvedConnection has no pricing field", () => {});
});
