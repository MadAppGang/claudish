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
const { OpenAICodexTransport } = await import("./openai-codex.js");

const FAKE_TOKEN = "codex-oauth-token-abc";
const FAKE_ACCOUNT = "acct-123";
const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

// What the real CodexOAuthHalf.getRequestAuth() returns (buildOAuthHeaders + endpoint + transform).
const CODEX_OAUTH_AUTH = {
  // `arm` is part of the artifact the real half returns (codex-credential.ts) and
  // it is what refreshAuth() turns into the SUB billing label. A fixture that
  // omits it is not the OAuth artifact — it is an unmarked one, which the
  // transport reads as metered.
  arm: "oauth" as const,
  headers: {
    Authorization: `Bearer ${FAKE_TOKEN}`,
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    accept: "text/event-stream",
    "chatgpt-account-id": FAKE_ACCOUNT,
    "x-conversation-id": "claudish-session",
    "x-session-id": "claudish-session",
  },
  endpoint: CODEX_ENDPOINT,
  transformPayload: (p: any) => ({
    ...p,
    store: false,
    include: ["reasoning.encrypted_content"],
  }),
};

// What the real ApiKeyCredentialProvider.getRequestAuth() returns for the same
// provider: a marked artifact with a Bearer header, NO endpoint, NO
// transformPayload. Never null, never a throw.
const API_KEY_AUTH = {
  arm: "api-key" as const,
  headers: { Authorization: "Bearer sk-codex-key" },
};

let getRequestAuthMock = mock(async (_name: string, _ctx: any) => CODEX_OAUTH_AUTH as any);

// Registered under "openai-codex" ONLY. The authority consumes the name in its
// registry lookup, so the fake passes that name on itself; the mock is reached
// only when the transport asked for "openai-codex", which is what the
// "delegates with the openai-codex catalog name" assertions pin together.
const fakeCodexCredential: CredentialProvider = {
  catalogName: "openai-codex",
  isAvailable: async () => true,
  describeReadiness: async () => ({ readiness: "present" }),
  getRequestAuth: (ctx) => getRequestAuthMock("openai-codex", ctx),
};

let realCodexCredential: CredentialProvider | undefined;

beforeEach(() => {
  realCodexCredential = credentials.get("openai-codex");
  if (!realCodexCredential) {
    throw new Error("the authority has no openai-codex credential to restore after this file");
  }
  credentials.register(fakeCodexCredential, ["openai-codex"]);
  credentials.invalidate("openai-codex");
});

afterEach(() => {
  // Put the real credential back so no later file in the Bun run signs with the fake.
  if (realCodexCredential) credentials.register(realCodexCredential, ["openai-codex"]);
  credentials.invalidate("openai-codex");
});

const provider: RemoteProvider = {
  name: "openai-codex",
  baseUrl: "https://api.openai.com",
  apiPath: "/v1/responses",
  apiKeyEnvVar: "OPENAI_CODEX_API_KEY",
  prefixes: ["cx@", "codex@"],
};

beforeEach(() => {
  getRequestAuthMock = mock(async (_name: string, _ctx: any) => CODEX_OAUTH_AUTH as any);
});

afterEach(() => {
  mock.restore();
  // refreshAuth() ALWAYS calls recordSignedArm, so this endpoint/header suite
  // writes a process-wide billing record it never meant to touch. The record is
  // read BEFORE the presence probe (billing-probe.ts), and Bun runs every test
  // file in one process — so without this clear, the OAuth fixture above leaves
  // "subscription" behind and the next file answers
  // isSubscriptionProvider("openai-codex") = true on a machine where no
  // credential would sign. Measured: validation/fix2-residue-leak.txt.
  credentials.invalidate("openai-codex");
});

describe("OpenAICodexTransport — OAuth present (delegated)", () => {
  test("refreshAuth → chatgpt.com endpoint + OAuth headers + store/include transform", async () => {
    const t = new OpenAICodexTransport(provider, "gpt-5.1-codex", "ignored-api-key");
    await t.refreshAuth();

    // endpoint comes from cachedAuth
    expect(t.getEndpoint()).toBe(CODEX_ENDPOINT);

    // headers come from cachedAuth (the 6 OAuth headers w/ accountId)
    const headers = await t.getHeaders();
    expect(headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(headers["OpenAI-Beta"]).toBe("responses=experimental");
    expect(headers.originator).toBe("codex_cli_rs");
    expect(headers.accept).toBe("text/event-stream");
    expect(headers["chatgpt-account-id"]).toBe(FAKE_ACCOUNT);
    expect(headers["x-conversation-id"]).toBe("claudish-session");
    expect(headers["x-session-id"]).toBe("claudish-session");

    // transformPayload adds the auth-derived store/include bits.
    const out = t.transformPayload({ model: "gpt-5.1-codex", input: "hi" });
    expect(out.store).toBe(false);
    expect(out.include).toEqual(["reasoning.encrypted_content"]);

    // delegates with the openai-codex catalog name
    expect(getRequestAuthMock).toHaveBeenCalledTimes(1);
    expect(getRequestAuthMock.mock.calls[0][0]).toBe("openai-codex");
  });
});

describe("OpenAICodexTransport — no OAuth (api-key half answers)", () => {
  beforeEach(() => {
    // What the composite ACTUALLY does with no OAuth: no throw, no null — it
    // returns the api-key half's artifact verbatim, `arm` and all
    // (composite-credential.ts, api-key-credential.ts). Endpoint-less, so the
    // transport lands on the base OpenAI path.
    getRequestAuthMock = mock(async () => API_KEY_AUTH);
  });

  test("refreshAuth → static api.openai.com endpoint + Bearer apiKey, no OAuth headers", async () => {
    const t = new OpenAICodexTransport(provider, "gpt-5.1-codex", "sk-codex-key");
    await t.refreshAuth();

    // The artifact carries no endpoint override, so getEndpoint() falls to
    // super.getEndpoint() — the codex Responses endpoint on api.openai.com.
    expect(t.getEndpoint()).toBe("https://api.openai.com/v1/responses");

    // Headers are the api-key artifact's: Bearer <key>, nothing OAuth-shaped.
    const headers = await t.getHeaders();
    expect(headers.Authorization).toBe("Bearer sk-codex-key");
    expect(headers["OpenAI-Beta"]).toBeUndefined();
    expect(headers["chatgpt-account-id"]).toBeUndefined();
  });

  test("transformPayload normalizes model but does NOT add auth store/include bits", async () => {
    const t = new OpenAICodexTransport(provider, "gpt-5.1-codex", "sk-codex-key");
    await t.refreshAuth();
    const out = t.transformPayload({ model: "gpt-5.1-codex", input: "y" });
    expect(out.store).toBeUndefined();
    expect(out.include).toBeUndefined();
    expect(typeof out.model).toBe("string");
  });
});

describe("OpenAICodexTransport — OAuth available but its refresh is rejected", () => {
  beforeEach(() => {
    // The ONLY way getRequestAuth throws: the composite took an AVAILABLE OAuth
    // primary and the refresh failed with something other than fallbackSignal
    // (Codex declares none), so it rethrows rather than falling through.
    getRequestAuthMock = mock(async () => {
      throw new Error("refresh_token rejected");
    });
  });

  test("unclassified refresh rejection propagates without a constructor-key signature", async () => {
    const t = new OpenAICodexTransport(provider, "gpt-5.1-codex", "sk-codex-key");
    await expect(t.refreshAuth()).rejects.toThrow("refresh_token rejected");
  });

  test("E2: successful OAuth followed by rejected refresh never records metered billing", async () => {
    const { isSubscriptionProvider } = await import(
      "../../handlers/shared/remote-provider-types.js"
    );
    getRequestAuthMock = mock(async () => CODEX_OAUTH_AUTH);
    const t = new OpenAICodexTransport(provider, "gpt-5.1-codex", "sk-codex-key");
    await t.refreshAuth();
    expect((await t.getHeaders()).Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    const error = new Error("refresh_token rejected");
    getRequestAuthMock = mock(async () => {
      throw error;
    });
    await expect(t.refreshAuth()).rejects.toBe(error);
    expect(isSubscriptionProvider("openai-codex")).toBe(true);
  });
});
