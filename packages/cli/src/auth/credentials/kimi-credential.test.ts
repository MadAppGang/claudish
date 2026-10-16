import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";

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

// HOME must exist in the environment at process start for Bun's os.homedir().
// Keep the child and all of its writable resources under a per-case temp home.
const childRoots: string[] = [];
afterEach(async () => {
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
    const realExit = process.exit.bind(process);
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
    const report = (result) => {
      console.log(JSON.stringify({ ...result, home, writes, outsideWrites, networkRequests, networkUrls, keychainOperations }));
    };
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
    waitForChild(child),
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

const savedEnvironment = new Map(
  ["CLAUDISH_DISABLE_KEYCHAIN", "API_TIMEOUT_MS"].map((k) => [k, process.env[k]])
);
const testHome = mkdtempSync(join(tmpdir(), "claudish-run4-"));
process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
const realFetch = globalThis.fetch;
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
const guardedFetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "127.0.0.1" && url.protocol === "http:") return realFetch(input, init);
    throw new Error(`Unexpected external request: ${url.origin}${url.pathname}`);
  },
  { preconnect: () => {} }
) as typeof fetch;
globalThis.fetch = guardedFetch;
const { credentials } = await import("../../auth/credentials/authority.js");
const { clearSignedArm } = await import("../../auth/credentials/billing-probe.js");
const core = await import("../../providers/meta-muse/muse-credentials.js");
const museKeychain = await import("../../providers/meta-muse/muse-keychain.js");
const roles = await import("../../auth/credentials/prompt-role.js");
const catalog = await import("../../providers/catalog-client.js");
const cache = await import("../../providers/all-models-cache.js");
// Every seam is a complete fake: omitted fields would restore machine defaults.
beforeEach(() => {
  core.setMuseCoreTestDeps({
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
  globalThis.fetch = guardedFetch;
  credentials.invalidate();
  clearSignedArm();
  core.setMuseCoreTestDeps(null);
  core.resetMuseCredentialState();
  museKeychain.setMuseKeychainTestDeps(null);
  museKeychain.resetMuseKeychainState();
  roles._resetCredentialPromptRoleForTest();
  catalog._resetCatalogClient();
  cache._clearAllModelsCacheMemo();
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
const { ApiKeyCredentialProvider } = await import("./api-key-credential.js");
const { CompositeCredentialProvider } = await import("./composite-credential.js");
const { terminalCredentialError, credentialHttpError } = await import("./credential-error.js");
const { AnthropicProviderTransport } = await import(
  "../../providers/transport/anthropic-compat.js"
);
const { ComposedHandler } = await import("../../handlers/composed-handler.js");
const { AnthropicAPIFormat } = await import("../../adapters/anthropic-api-format.js");
import type { CredentialProvider } from "./types.js";

const envNames = ["KIMI_CODING_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY"];
let savedEnv: Map<string, string | undefined>;
let original: ReturnType<typeof credentials.get>;
beforeEach(() => {
  savedEnv = new Map(envNames.map((k) => [k, process.env[k]]));
  for (const key of envNames) delete process.env[key];
  original = credentials.get("kimi-coding");
  credentials.invalidate("kimi-coding");
});
afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (original) credentials.register(original, ["kimi-coding"]);
  credentials.invalidate("kimi-coding");
});

// The production B3 child below covers the OAuth login-file gate. These
// in-process cases use the exact Kimi fallback signal from the contract;
// terminal, unknown and transient errors must propagate unchanged.
function installOAuthFailure(error: Error) {
  const primary: CredentialProvider = {
    catalogName: "kimi",
    isAvailable: async () => true,
    getRequestAuth: async () => {
      throw error;
    },
  };
  const fallback = new ApiKeyCredentialProvider({
    catalogName: "kimi-coding",
    envVar: "KIMI_CODING_API_KEY",
    authScheme: "bearer",
    declaredKey: () => process.env.KIMI_CODING_API_KEY,
  });
  credentials.register(
    new CompositeCredentialProvider("kimi-coding", primary, fallback, {
      fallbackSignal: "OAuth_FALLBACK_TO_API_KEY",
    }),
    ["kimi-coding"]
  );
  credentials.invalidate("kimi-coding");
}

const provider = {
  name: "kimi-coding",
  baseUrl: "https://api.moonshot.cn",
  apiPath: "/anthropic/v1/messages",
  apiKeyEnvVar: "KIMI_CODING_API_KEY",
  prefixes: ["kc@"],
  authScheme: "x-api-key" as const,
};

describe("E1: registered Kimi composite and transport", () => {
  test("B3: production Kimi file gate and Coding Plan fallback use the child HOME", async () => {
    const result = await runHomeScenario(`
      delete process.env.KIMI_CODING_API_KEY;
      process.env.MOONSHOT_API_KEY = "forbidden-metered-key";
      process.env.KIMI_API_KEY = "forbidden-metered-key";
      const path = credentialPath("kimi");
      fs.mkdirSync(resolve(home, ".claudish"), { recursive: true });
      fs.writeFileSync(path, JSON.stringify({
        access_token: "kimi-test-token", refresh_token: "kimi-test-refresh",
        expires_at: Date.now() + 3_600_000, scope: "", token_type: "Bearer",
      }));
      const { KimiOAuth } = await load("auth/kimi-oauth.js");
      const oauth = KimiOAuth.getInstance();
      oauth.reloadCredentials();
      const { makeKimiCodingCredential } = await load("auth/credentials/kimi-credential.js");
      const { terminalCredentialError, credentialHttpError } = await load("auth/credentials/credential-error.js");
      const { AnthropicProviderTransport } = await load("providers/transport/anthropic-compat.js");
      const provider = ${JSON.stringify(provider)};
      let calls = 0;
      let failure;
      oauth.getAccessToken = async () => { calls++; throw failure; };
      const rows = [];
      const loginPresent = hasOAuthCredentials("kimi");
      for (const kind of ["signal-with-key", "signal-without-key", "dead-with-key", "dead-without-key", "unknown", "transient"]) {
        if (kind.endsWith("without-key")) delete process.env.KIMI_CODING_API_KEY;
        else process.env.KIMI_CODING_API_KEY = "coding-plan-fixture";
        if (kind.startsWith("signal")) failure = new Error("OAuth_FALLBACK_TO_API_KEY", {
          cause: terminalCredentialError("run claudish login kimi", 401),
        });
        else if (kind.startsWith("dead")) failure = terminalCredentialError("run claudish login kimi", 401);
        else if (kind === "unknown") failure = new Error("OAuth unavailable");
        else failure = credentialHttpError("token host busy", 503);
        credentials.register(makeKimiCodingCredential(), ["kimi-coding"]);
        credentials.invalidate("kimi-coding");
        const before = calls;
        try {
          const headers = await new AnthropicProviderTransport(provider, "forbidden-constructor-key").getHeaders();
          rows.push({ kind, headers, calls: calls - before });
        } catch (error) {
          rows.push({ kind, message: error.message, sameError: error === failure, calls: calls - before });
        }
      }
      fs.unlinkSync(path);
      oauth.reloadCredentials();
      delete process.env.KIMI_CODING_API_KEY;
      credentials.register(makeKimiCodingCredential(), ["kimi-coding"]);
      credentials.invalidate("kimi-coding");
      const before = calls;
      let absentMessage;
      try { await new AnthropicProviderTransport(provider, "forbidden-constructor-key").getHeaders(); }
      catch (error) { absentMessage = error.message; }
      report({ loginPresent, rows, absentMessage, absentCalls: calls - before,
        loginAfterRemoval: hasOAuthCredentials("kimi"), fileExists: fs.existsSync(path) });
    `);
    expect(result.loginPresent).toBe(true);
    expect(result.rows[0].headers.Authorization).toBe("Bearer coding-plan-fixture");
    expect(result.rows[0].headers["x-api-key"]).toBeUndefined();
    expect(result.rows.every((row: { calls: number }) => row.calls === 1)).toBe(true);
    expect(result.rows[1]).toMatchObject({ message: "run claudish login kimi", sameError: false });
    for (const row of result.rows.slice(2, 4)) {
      expect(row).toMatchObject({ message: "run claudish login kimi", sameError: true });
    }
    expect(result.rows[4]).toMatchObject({ message: "OAuth unavailable", sameError: true });
    expect(result.rows[5]).toMatchObject({ message: "token host busy", sameError: true });
    for (const row of result.rows.slice(1)) expect(row.headers).toBeUndefined();
    expect(JSON.stringify(result.rows.slice(1))).not.toContain("coding-plan-fixture");
    expect(JSON.stringify(result.rows)).not.toContain("forbidden-");
    expect(result.absentMessage).toMatch(/claudish login kimi/);
    expect(result.absentCalls).toBe(0);
    expect(result.loginAfterRemoval).toBe(false);
    expect(result.fileExists).toBe(false);
  });
  test("declared OAuth fallback signal may sign with the same-subscription Coding Plan key", async () => {
    process.env.KIMI_CODING_API_KEY = "coding-plan-fixture";
    process.env.MOONSHOT_API_KEY = "forbidden-metered-key";
    process.env.KIMI_API_KEY = "forbidden-metered-key";
    installOAuthFailure(
      new Error("OAuth_FALLBACK_TO_API_KEY", {
        cause: terminalCredentialError("run `claudish login kimi`", 401),
      })
    );
    const transport = new AnthropicProviderTransport(provider, "forbidden-constructor-key");
    const headers = await transport.getHeaders();
    expect(headers.Authorization).toBe("Bearer coding-plan-fixture");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain("forbidden-metered-key");
    expect(JSON.stringify(headers)).not.toContain("forbidden-constructor-key");
  });
  test.each(["MOONSHOT_API_KEY", "KIMI_API_KEY"])(
    "dead OAuth cannot sign with metered %s",
    async (envName) => {
      process.env[envName] = "forbidden-metered-key";
      installOAuthFailure(terminalCredentialError("run `claudish login kimi`", 401));
      await expect(
        credentials.getRequestAuth("kimi-coding", { model: "kimi-fixture" })
      ).rejects.toThrow(/claudish login kimi/);
      await expect(
        new AnthropicProviderTransport(provider, "forbidden-constructor-key").getHeaders()
      ).rejects.toThrow(/claudish login kimi/);
    }
  );
  test.each([
    terminalCredentialError("run claudish login kimi", 401),
    new Error("OAuth unavailable"),
    credentialHttpError("token host busy", 503),
  ])("non-signal %s propagates even with Coding Plan key", async (error) => {
    process.env.KIMI_CODING_API_KEY = "coding-plan-fixture";
    installOAuthFailure(error);
    await expect(
      new AnthropicProviderTransport(provider, "forbidden-constructor-key").getHeaders()
    ).rejects.toBe(error);
  });

  test.each([false, true])(
    "Kimi handler returns auth verdict (identified dead=%s), with zero inference requests",
    async (dead) => {
      process.env.MOONSHOT_API_KEY = "forbidden-metered-key";
      process.env.KIMI_API_KEY = "forbidden-metered-key";
      installOAuthFailure(
        dead
          ? terminalCredentialError("run `claudish login kimi`", 401)
          : new Error("OAuth unavailable")
      );
      let requests = 0;
      globalThis.fetch = Object.assign(
        async () => {
          requests++;
          throw new Error("no inference expected");
        },
        { preconnect: () => {} }
      ) as typeof fetch;
      const handler = new ComposedHandler(
        new AnthropicProviderTransport(provider, "forbidden-constructor-key"),
        "kimi-fixture",
        "kimi-fixture",
        0,
        {
          adapter: new AnthropicAPIFormat("kimi-fixture"),
          catalogCachePath: join(testHome, "catalog.json"),
        }
      );
      try {
        const app = new Hono();
        app.post("/", (c) =>
          handler.handle(c, {
            messages: [{ role: "user", content: "PONG" }],
            max_tokens: 64,
            stream: false,
          })
        );
        const response = await app.request("http://localhost/", { method: "POST" });
        expect(response.status).toBe(dead ? 400 : 503);
        expect(response.headers.get("x-claudish-auth-verdict")).toBe(
          dead ? "terminal" : "transient"
        );
        expect(await response.text()).toContain(dead ? "login kimi" : "OAuth unavailable");
        expect(requests).toBe(0);
      } finally {
        await handler.shutdown();
      }
    }
  );
});

describe("E1: declared composite fallback signal", () => {
  test("only exact fallbackSignal advances; other errors propagate unchanged", async () => {
    let error = new Error("OAuth_FALLBACK_TO_API_KEY");
    let fallbackCalls = 0;
    const primary: CredentialProvider = {
      catalogName: "primary",
      isAvailable: async () => true,
      getRequestAuth: async () => {
        throw error;
      },
    };
    const fallback: CredentialProvider = {
      catalogName: "fallback",
      isAvailable: async () => true,
      getRequestAuth: async () => {
        fallbackCalls++;
        return { arm: "api-key", headers: { "x-api-key": "coding-plan-fixture" } };
      },
    };
    const composite = new CompositeCredentialProvider("kimi-coding", primary, fallback, {
      fallbackSignal: "OAuth_FALLBACK_TO_API_KEY",
    });
    expect((await composite.getRequestAuth({ model: "kimi-fixture" })).headers["x-api-key"]).toBe(
      "coding-plan-fixture"
    );
    expect(fallbackCalls).toBe(1);
    for (const message of [
      "OAuth_FALLBACK_TO_API_KEY extra",
      "OAuth unavailable",
      "token host busy",
    ]) {
      error = new Error(message);
      await expect(composite.getRequestAuth({ model: "kimi-fixture" })).rejects.toBe(error);
      expect(fallbackCalls).toBe(1);
    }
    const strict = new CompositeCredentialProvider("openai-codex", primary, fallback);
    error = new Error("OAuth_FALLBACK_TO_API_KEY");
    await expect(strict.getRequestAuth({ model: "codex-fixture" })).rejects.toBe(error);
    expect(fallbackCalls).toBe(1);
  });
});
