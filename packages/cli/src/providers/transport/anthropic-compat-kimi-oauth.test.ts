import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const savedEnvironment = new Map(["CLAUDISH_DISABLE_KEYCHAIN"].map((k) => [k, process.env[k]]));
const testHome = mkdtempSync(join(tmpdir(), "claudish-auth-tests-"));
process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol === "http:" && url.hostname === "127.0.0.1") return realFetch(input, init);
    throw new Error(`Unexpected external request: ${url.origin}${url.pathname}`);
  },
  { preconnect: () => {} }
) as typeof fetch;
const keychain = await import("../keychain.js");
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

const { credentials } = await import("../../auth/credentials/authority.js");

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
  museCore.setMuseCoreTestDeps(null);
  museCore.resetMuseCredentialState();
  museKeychain.setMuseKeychainTestDeps(null);
  museKeychain.resetMuseKeychainState();
  promptRole._resetCredentialPromptRoleForTest();
  catalogClient._resetCatalogClient();
  allModelsCache._clearAllModelsCacheMemo();
  keychain.invalidateKeychainCache();
});

const { clearSignedArm } = await import("../../auth/credentials/billing-probe.js");
afterEach(() => {
  clearSignedArm();
  keychain.invalidateKeychainCache();
});
type CredentialProvider = NonNullable<ReturnType<typeof credentials.get>>;
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
const { AnthropicProviderTransport } = await import("./anthropic-compat.js");

const FAKE_TOKEN = "kimi-oauth-token-xyz";

// The platform headers the real KimiOAuth.getPlatformHeaders() returns. The
// credential impl merges these into the kimi-coding request auth.
const PLATFORM_HEADERS: Record<string, string> = {
  "X-Msh-Platform": "claudish",
  "X-Msh-Version": "9.9.9",
  "X-Msh-Device-Name": "test-host",
  "X-Msh-Device-Model": "darwin-arm64",
  "X-Msh-Os-Version": "25.0.0",
  "X-Msh-Device-Id": "device-abc",
};

// What credentials.getRequestAuth("kimi-coding") returns when OAuth is present.
// This mirrors KimiOAuthHalf.getRequestAuth() exactly.
const KIMI_OAUTH_AUTH = {
  headers: {
    "anthropic-version": "2023-06-01",
    Authorization: `Bearer ${FAKE_TOKEN}`,
    ...PLATFORM_HEADERS,
  },
};

// ── Fake the authority's credentials (the new delegation target) ──────────────
let getRequestAuthMock = mock(async (_name: string, _ctx: any) => KIMI_OAUTH_AUTH as any);

// Every name this file's transports could sign under. "kimi-coding" is the
// delegation under test. "minimax" and "z-ai" are faked too so the "no authority
// call" assertions can still fail: without a fake, a call under either name
// would reach the real api-key provider and never touch the mock.
const FAKED_NAMES = ["kimi-coding", "minimax", "z-ai"] as const;

/** Answers under `name` only, and passes that name on (the authority consumes it). */
function fakeCredential(name: string): CredentialProvider {
  return {
    catalogName: name,
    isAvailable: async () => true,
    describeReadiness: async () => ({ readiness: "present" }),
    getRequestAuth: (ctx) => getRequestAuthMock(name, ctx),
  };
}

const realCredentials = new Map<string, CredentialProvider>();

beforeEach(() => {
  for (const name of FAKED_NAMES) {
    const real = credentials.get(name);
    if (!real) {
      throw new Error(`the authority has no ${name} credential to restore after this file`);
    }
    realCredentials.set(name, real);
    credentials.register(fakeCredential(name), [name]);
    credentials.invalidate(name);
  }
});

afterEach(() => {
  // Put the real credentials back so no later file in the Bun run signs with a fake.
  for (const [name, real] of realCredentials) {
    credentials.register(real, [name]);
    credentials.invalidate(name);
  }
  realCredentials.clear();
});

beforeEach(() => {
  getRequestAuthMock = mock(async (_name: string, _ctx: any) => KIMI_OAUTH_AUTH as any);
});

afterEach(() => {
  mock.restore();
});

describe("AnthropicProviderTransport — kimi-coding OAuth delegation", () => {
  const kimiCoding: RemoteProvider = {
    name: "kimi-coding",
    baseUrl: "https://api.moonshot.cn",
    apiPath: "/anthropic/v1/messages",
    apiKeyEnvVar: "KIMI_CODING_API_KEY",
    prefixes: ["mmc@"],
    authScheme: "x-api-key",
  };

  test("OAuth present: anthropic-version + Bearer + 6 platform headers, NO x-api-key", async () => {
    const transport = new AnthropicProviderTransport(kimiCoding, "stale-api-key");
    const headers = await transport.getHeaders();

    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(headers["x-api-key"]).toBeUndefined();

    expect(headers["X-Msh-Platform"]).toBe("claudish");
    expect(headers["X-Msh-Version"]).toBe("9.9.9");
    expect(headers["X-Msh-Device-Name"]).toBe("test-host");
    expect(headers["X-Msh-Device-Model"]).toBe("darwin-arm64");
    expect(headers["X-Msh-Os-Version"]).toBe("25.0.0");
    expect(headers["X-Msh-Device-Id"]).toBe("device-abc");
  });

  test("OAuth unavailable propagates unchanged without a constructor-key signature", async () => {
    const error = new Error("OAuth unavailable");
    getRequestAuthMock = mock(async () => {
      throw error;
    });
    const transport = new AnthropicProviderTransport(kimiCoding, "forbidden-constructor-key");
    await expect(transport.getHeaders()).rejects.toBe(error);
  });
});

describe("AnthropicProviderTransport — non-kimi providers are NOT routed through the authority", () => {
  test("minimax (bearer): plain Bearer + anthropic-version, no authority call", async () => {
    const minimax: RemoteProvider = {
      name: "minimax",
      baseUrl: "https://api.minimax.io",
      apiPath: "/anthropic/v1/messages",
      apiKeyEnvVar: "MINIMAX_API_KEY",
      prefixes: ["mm@"],
      authScheme: "bearer",
    };
    const transport = new AnthropicProviderTransport(minimax, "mm-key");
    const headers = await transport.getHeaders();

    expect(headers.Authorization).toBe("Bearer mm-key");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(getRequestAuthMock).toHaveBeenCalledTimes(0);
  });

  test("z-ai (x-api-key default) with provider.headers: unchanged, no authority call", async () => {
    const zai: RemoteProvider = {
      name: "z-ai",
      baseUrl: "https://api.z.ai",
      apiPath: "/anthropic/v1/messages",
      apiKeyEnvVar: "ZAI_API_KEY",
      prefixes: ["zai@"],
      headers: { "X-Custom": "z-value" },
    };
    const transport = new AnthropicProviderTransport(zai, "zai-key");
    const headers = await transport.getHeaders();

    expect(headers["x-api-key"]).toBe("zai-key");
    expect(headers.Authorization).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["X-Custom"]).toBe("z-value");
    expect(getRequestAuthMock).toHaveBeenCalledTimes(0);
  });
});
