import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

const savedEnvironment = new Map(
  ["CLAUDISH_DISABLE_KEYCHAIN", "API_TIMEOUT_MS"].map((k) => [k, process.env[k]])
);
const testHome = mkdtempSync(join(tmpdir(), "claudish-run4-"));
process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
const realFetch = globalThis.fetch;
const keychain = await import("../providers/keychain.js");
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
const { credentials } = await import("../auth/credentials/authority.js");
const { clearSignedArm } = await import("../auth/credentials/billing-probe.js");
const core = await import("../providers/meta-muse/muse-credentials.js");
const museKeychain = await import("../providers/meta-muse/muse-keychain.js");
const roles = await import("../auth/credentials/prompt-role.js");
const catalog = await import("../providers/catalog-client.js");
const cache = await import("../providers/all-models-cache.js");
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
import type { ProviderTransport } from "../providers/transport/types.js";
const { ComposedHandler } = await import("./composed-handler.js");
const { DefaultAPIFormat } = await import("../adapters/base-api-format.js");
const { terminalCredentialError, credentialHttpError } = await import(
  "../auth/credentials/credential-error.js"
);
const recovery = await import("../recovery/settings.js");
const recoveryTime = await import("../recovery/clock.js");
const episodes = await import("../recovery/coordinator.js");
const stores = await import("../providers/meta-muse/muse-store.js");

const parameterComplaint =
  "reasoning_effort 'none' is not supported for model 'muse-spark-1.3'. Supported values: [minimal, low, medium, high, xhigh, max]";

// Parameter rejection is an adapter outcome, not a fabricated Meta response.
class RecoveringAdapter extends DefaultAPIFormat {
  recoverFromRejection(payload: any, errorText: string) {
    if (errorText !== parameterComplaint) return null;
    return { payload: { ...payload, reasoning_effort: "minimal" }, note: "test adapter recovery" };
  }
}
const sites = [
  "refreshAuth",
  "getHeaders",
  "primary fetch",
  "parameter-recovery re-fetch",
  "forceRefreshAuth",
] as const;
type Site = (typeof sites)[number];
const rejection = JSON.stringify({ error: { type: "invalid_api_key", message: "Unauthorized" } }); // capture §7
const payload = {
  model: "muse-spark-1.3",
  messages: [{ role: "user", content: "PONG" }],
  max_tokens: 64,
  stream: false,
};
let handler: InstanceType<typeof ComposedHandler> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let previous: ReturnType<typeof credentials.get>;

beforeEach(() => {
  previous = credentials.get("meta-muse-code");
  credentials.register(
    {
      catalogName: "meta-muse-code",
      isAvailable: async () => true,
      getRequestAuth: async () => ({
        arm: "oauth",
        headers: { Authorization: "Bearer LLM|TESTKEY0001" },
      }),
    },
    ["meta-muse-code"]
  );
  core.resetMuseCredentialState();
  roles.setCredentialPromptRole("never");
  recovery.setRecoveryFlagOverrides({ recovery: true, recoveryUi: false });
  // Advance only the recovery scheduler. No waits or real service requests.
  let elapsed = 0;
  recoveryTime.setRecoveryClock({
    now: () => Date.now() + elapsed,
    setTimeout: (fn, ms) =>
      setTimeout(() => {
        elapsed += ms;
        fn();
      }, 0),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
  core.setMuseCoreTestDeps({
    dir: () => testHome,
    now: () => 1_800_000_000_000,
    mint: async () => {
      throw new Error("unexpected mint in fake-transport test");
    },
    readStore: (kind) => stores.readMuseStore(kind, testHome),
    writeBorrowedCopy: (token, tier) =>
      stores.writeBorrowedCopy(token, tier, testHome, () => new Date(1_800_000_000_000)),
    keychainLogin: async () => ({ kind: "not-allowed" }),
  });
  stores.writeMuseStore("own-login", { access_token: "dca:TESTTOKEN0001" }, testHome);
  stores.writeBorrowedCopy(
    "dca:TESTTOKEN0001",
    "Muse Code Power Usage",
    testHome,
    () => new Date(1_800_000_000_000)
  );
});
afterEach(async () => {
  if (handler) await handler.shutdown();
  handler = undefined;
  if (server) await server.stop(true);
  server = undefined;
  if (previous) credentials.register(previous, ["meta-muse-code"]);
  credentials.invalidate("meta-muse-code");
  episodes.closeAllEpisodes("shutdown");
  recovery.resetRecoveryFlagOverrides();
  recoveryTime.resetRecoveryClock();
});

async function refusedFetch() {
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") });
  const url = `http://127.0.0.1:${closed.port}/token`;
  await closed.stop(true);
  try {
    await realFetch(url);
  } catch (error) {
    return error;
  }
  throw new Error("refused-fetch fixture unexpectedly succeeded");
}

async function exercise(
  site: Site,
  failures: unknown[],
  retryStatus = 401,
  providerName = "meta-muse-code",
  primaryStatus = 403
) {
  let siteCalls = 0;
  let fetchCalls = 0;
  let forceCalls = 0;
  const seen: Array<{ url: string; authorization: string | null }> = [];
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") });
  const endpoint = `http://127.0.0.1:${server.port}/v1/responses`;
  const hit = () => {
    const index = siteCalls++;
    if (index < failures.length) throw failures[index];
  };
  const transport: ProviderTransport = {
    name: providerName,
    displayName: providerName,
    streamFormat: "openai-sse",
    getEndpoint: () => endpoint,
    refreshAuth: async () => {
      if (site === "refreshAuth") hit();
    },
    getHeaders: async () => {
      if (site === "getHeaders") hit();
      return { Authorization: forceCalls ? "Bearer LLM|TESTKEY0002" : "Bearer LLM|TESTKEY0001" };
    },
    forceRefreshAuth: async () => {
      forceCalls++;
      if (site === "forceRefreshAuth") hit();
    },
    classifyTerminalError: (status) => providerName === "antigravity" && status === 429,
  };
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      // Fail closed on incidental discovery or telemetry: it cannot reach a service.
      if (request.url !== endpoint) throw new Error(`unexpected URL ${request.url}`);
      fetchCalls++;
      seen.push({ url: request.url, authorization: request.headers.get("authorization") });
      if (site === "primary fetch") hit();
      if (site === "parameter-recovery re-fetch") {
        if (fetchCalls === 1) return new Response(parameterComplaint, { status: 400 });
        hit();
      }
      // Negative fixtures mutate only the status of capture §7's rejection body.
      if (site === "forceRefreshAuth")
        return new Response(rejection, { status: fetchCalls === 1 ? 401 : retryStatus });
      return new Response(rejection, { status: primaryStatus });
    },
    { preconnect: () => {} }
  ) as typeof fetch;
  const own = readFileSync(stores.museStorePath("own-login", testHome), "utf8");
  const borrowed = readFileSync(stores.museStorePath("borrowed-copy", testHome), "utf8");
  handler = new ComposedHandler(transport, "muse-spark-1.3", "muse-spark-1.3", 0, {
    adapter: new RecoveringAdapter("muse-spark-1.3"),
    isInteractive: false,
    invocationMode: "explicit-model",
    catalogCachePath: join(testHome, "empty-catalog.json"),
  });
  const app = new Hono();
  app.post("/v1/messages", (c) => handler!.handle(c, payload));
  const response = await app.request("http://localhost/v1/messages", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  });
  const result = {
    status: response.status,
    verdict: response.headers.get("x-claudish-auth-verdict"),
    body: await response.text(),
    siteCalls,
    fetchCalls,
    forceCalls,
    seen,
  };
  expect(readFileSync(stores.museStorePath("own-login", testHome), "utf8")).toBe(own);
  expect(readFileSync(stores.museStorePath("borrowed-copy", testHome), "utf8")).toBe(borrowed);
  expect(seen.every((request) => request.url === endpoint)).toBe(true);
  return result;
}

const failures = [
  {
    name: "dead login",
    make: () => terminalCredentialError("run `claudish login muse`", 401),
    status: 400,
    verdict: "terminal",
    message: "login muse",
  },
  {
    name: "token host 429",
    make: () => credentialHttpError("key service unavailable (429)", 429),
    status: 429,
    verdict: "transient",
    message: "429",
  },
  {
    name: "token host 503",
    make: () => credentialHttpError("key service unavailable (503)", 503),
    status: 503,
    verdict: "transient",
    message: "503",
  },
  {
    name: "unknown subscription error",
    make: () => new Error("OAuth unavailable"),
    status: 503,
    verdict: "transient",
    message: "OAuth unavailable",
  },
];
describe("H1: all five auth failure sites", () => {
  for (const site of sites)
    for (const failure of failures) {
      test(`${site}: ${failure.name}`, async () => {
        const result = await exercise(site, [failure.make()]);
        expect(result.siteCalls).toBe(1);
        expect(result.status).toBe(failure.status);
        expect(result.verdict).toBe(failure.verdict);
        expect(result.body).toContain(failure.message);
        if (site === "refreshAuth" || site === "getHeaders") expect(result.fetchCalls).toBe(0);
        else expect(result.fetchCalls).toBe(site === "parameter-recovery re-fetch" ? 2 : 1);
      });
    }
});

describe("H2: real connection recovery reclassifies its next outcome", () => {
  for (const site of sites)
    for (const wrapped of [false, true])
      for (const failure of failures) {
        test(`${site}: ${wrapped ? "wrapped" : "raw"} refused fetch then ${failure.name}`, async () => {
          const raw = await refusedFetch();
          const connection = wrapped ? new Error("token host unreachable", { cause: raw }) : raw;
          const result = await exercise(site, [connection, failure.make()]);
          expect(result.siteCalls).toBe(2);
          expect(result.status).toBe(failure.status);
          expect(result.verdict).toBe(failure.verdict);
          expect(result.body).toContain(failure.message);
        });
      }
  for (const site of sites)
    test(`${site}: recovery returning fresh-key HTTP 403 is terminal`, async () => {
      const result = await exercise(site, [await refusedFetch()]);
      expect(result.siteCalls).toBeGreaterThanOrEqual(2);
      expect(result.status).toBe(400);
      expect(result.verdict).toBe("terminal");
      expect(result.body).toMatch(/login/);
    });
});

describe("H3: post-refresh HTTP rejection and allowance", () => {
  for (const status of [401, 403])
    test(`fresh-key HTTP ${status} requires login`, async () => {
      const result = await exercise("forceRefreshAuth", [], status);
      expect(result.forceCalls).toBe(1);
      expect(result.fetchCalls).toBe(2);
      expect(result.seen.map((request) => request.authorization)).toEqual([
        "Bearer LLM|TESTKEY0001",
        "Bearer LLM|TESTKEY0002",
      ]);
      expect(result.status).toBe(400);
      expect(result.verdict).toBe("terminal");
      expect(result.body).toMatch(/login/);
    });
  test("post-refresh 429 retains allowance behavior without terminal credential verdict", async () => {
    const result = await exercise("forceRefreshAuth", [], 429);
    expect(result.forceCalls).toBe(1);
    expect(result.fetchCalls).toBe(2);
    expect(result.status).toBe(429);
    expect(result.verdict).not.toBe("terminal");
  });
  test("Antigravity post-refresh 429 retains its upstream status", async () => {
    const result = await exercise("forceRefreshAuth", [], 429, "antigravity");
    expect(result.forceCalls).toBe(1);
    expect(result.fetchCalls).toBe(2);
    expect(result.status).toBe(429);
    expect(result.verdict).not.toBe("terminal");
    const body = JSON.parse(result.body);
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.message).toContain("Unauthorized");
  });
});

describe("H3: Antigravity primary allowance response", () => {
  test("primary terminal 429 is remapped to 400 without refreshing auth", async () => {
    const result = await exercise("primary fetch", [], 401, "antigravity", 429);
    expect(result.status).toBe(400);
    expect(result.body).toContain("429");
    expect(result.forceCalls).toBe(0);
    expect(result.fetchCalls).toBe(1);
  });
});
