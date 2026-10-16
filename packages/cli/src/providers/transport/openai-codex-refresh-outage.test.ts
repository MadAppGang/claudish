import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
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
let original: ReturnType<typeof credentials.get>;
beforeEach(() => {
  original = credentials.get("openai-codex");
});
import { classifyAuthFailure } from "../../handlers/shared/auth-failure.js";
type CredentialProvider = NonNullable<ReturnType<typeof credentials.get>>;
type RequestAuthContext = Parameters<CredentialProvider["getRequestAuth"]>[0];
type RequestAuth = Awaited<ReturnType<CredentialProvider["getRequestAuth"]>>;
function classifyConnectionError(error: unknown) {
  const failure = classifyAuthFailure(error);
  return failure.kind === "connection" ? failure.conn : null;
}
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
const { OpenAICodexTransport } = await import("./openai-codex.js");

const PROVIDER: RemoteProvider = {
  name: "openai-codex",
  baseUrl: "https://api.openai.com",
  apiPath: "/v1/responses",
  apiKeyEnvVar: "OPENAI_CODEX_API_KEY",
  prefixes: ["cx@", "codex@"],
};
const MODEL = "gpt-5.1-codex";
const API_KEY = "sk-codex-key";
const SUBSCRIPTION_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

const { credentialHttpError } = await import("../../auth/credentials/credential-error.js");

/** B17: throw the classified rejection itself; wrapping would make it unknown. */
function invalidGrantRejection(): Error {
  return credentialHttpError(
    "OAuth credentials invalid (invalid_grant). Please run `claudish login codex` again.",
    400
  );
}

/** A second non-network rejection: the token server's answer, unwrapped. */
function bareServerRejection(): Error {
  return credentialHttpError(
    "Token refresh failed: 400 - invalid_grant; run `claudish login codex`",
    400
  );
}

/**
 * A REAL connection failure: bind a server to an ephemeral loopback port, stop
 * it, then POST to that port. Nothing listens, so the fetch is refused. Returns
 * the value `fetch` threw, untouched.
 */
async function realConnectionFailure(): Promise<unknown> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
  const port = server.port;
  await server.stop(true);
  try {
    await fetch(`http://127.0.0.1:${port}/oauth/token`, { method: "POST" });
  } catch (err) {
    return err;
  }
  throw new Error(
    `fixture broken: port ${port} was expected to be free, but a fetch to it succeeded`
  );
}

/** The real failure wrapped the way a refresh routine would wrap it. */
function wrapped(real: unknown): Error {
  return new Error("Token refresh failed: could not reach auth.openai.com", { cause: real });
}

/**
 * A fake `openai-codex` credential. It is available and present; its
 * `getRequestAuth` does whatever the test says. `consulted` counts calls — used
 * ONLY as a precondition guard (the spec's "when getRequestAuth throws …" is not
 * met if it is never asked), never as the behaviour under test.
 */
function installFakeCodexCredential(
  getRequestAuth: (ctx: RequestAuthContext) => Promise<RequestAuth>
): { consulted: () => number } {
  let calls = 0;
  const fake: CredentialProvider = {
    catalogName: "openai-codex",
    isAvailable: async () => true,
    describeReadiness: async () => ({ readiness: "present" }),
    getRequestAuth: async (ctx) => {
      calls += 1;
      return getRequestAuth(ctx);
    },
  };
  credentials.register(fake, ["openai-codex"]);
  credentials.invalidate("openai-codex");
  return { consulted: () => calls };
}

type Settled = { settled: "resolved" } | { settled: "rejected"; reason: unknown };

/** Let a promise settle either way, so the test can assert WHICH way. */
function settle(p: Promise<unknown>): Promise<Settled> {
  return p.then(
    () => ({ settled: "resolved" as const }),
    (reason: unknown) => ({ settled: "rejected" as const, reason })
  );
}

function newTransport(): InstanceType<typeof OpenAICodexTransport> {
  return new OpenAICodexTransport(PROVIDER, MODEL, API_KEY);
}

afterEach(() => {
  if (original) credentials.register(original, ["openai-codex"]);
  credentials.invalidate("openai-codex");
});

describe("C1 (REQ-1) — token host unreachable: refreshAuth rejects with a classifiable connection error", () => {
  test("C1-bare: rejects, and the rejection classifies non-null, when getRequestAuth throws the real fetch failure as-is", async () => {
    const real = await realConnectionFailure();
    const fake = installFakeCodexCredential(async () => {
      throw real;
    });
    const transport = newTransport();

    const outcome = await settle(transport.refreshAuth());

    expect(fake.consulted()).toBeGreaterThan(0);
    // Resolving here means the request proceeds on the metered api-key path.
    expect(outcome.settled).toBe("rejected");
    const reason = outcome.settled === "rejected" ? outcome.reason : undefined;
    expect(classifyConnectionError(reason)).not.toBeNull();
  });

  test("C1-wrapped: rejects, and the rejection classifies non-null, when getRequestAuth throws the real fetch failure as an Error cause", async () => {
    const real = await realConnectionFailure();
    const fake = installFakeCodexCredential(async () => {
      throw wrapped(real);
    });
    const transport = newTransport();

    const outcome = await settle(transport.refreshAuth());

    expect(fake.consulted()).toBeGreaterThan(0);
    expect(outcome.settled).toBe("rejected");
    const reason = outcome.settled === "rejected" ? outcome.reason : undefined;
    expect(classifyConnectionError(reason)).not.toBeNull();
  });
});

describe("C2 (REQ-2) — refresh REJECTED by the server: refreshAuth rejects without a metered signature", () => {
  test.each([
    ["classified invalid_grant login rejection", invalidGrantRejection],
    ["a bare 400 invalid_grant rejection", bareServerRejection],
  ])(
    "C2: rejects the invalid grant without a constructor-key signature, for %s",
    async (_label, makeRejection) => {
      const fake = installFakeCodexCredential(async () => {
        throw makeRejection();
      });
      const transport = newTransport();

      const outcome = await settle(transport.refreshAuth());
      expect(fake.consulted()).toBeGreaterThan(0);
      expect(outcome.settled).toBe("rejected");
      if (outcome.settled === "rejected") {
        expect(String(outcome.reason)).toContain("invalid");
        expect(classifyAuthFailure(outcome.reason).kind).toBe("terminal");
      }
    }
  );
});

describe("C3 (REQ-3) — OAuth artifact: refreshAuth resolves and the request goes to the subscription endpoint", () => {
  test("C3: resolves, and getEndpoint returns the artifact's chatgpt.com endpoint, when getRequestAuth returns an oauth artifact", async () => {
    installFakeCodexCredential(async () => ({
      arm: "oauth",
      headers: { Authorization: "Bearer fake-codex-oauth-access-token" },
      endpoint: SUBSCRIPTION_ENDPOINT,
    }));
    const transport = newTransport();

    const outcome = await settle(transport.refreshAuth());

    expect(outcome).toEqual({ settled: "resolved" });
    expect(transport.getEndpoint(MODEL)).toBe(SUBSCRIPTION_ENDPOINT);
  });
});

describe("C4 (REQ-4) — the fixtures prove something: the classifier separates the two kinds of throw", () => {
  test("C4: the real fetch failure is refused (the port was free) and classifies non-null", async () => {
    const real = await realConnectionFailure();

    expect(real).toBeInstanceOf(Error);
    // Refused = nothing was listening, which is the proof the port was free.
    expect((real as { code?: unknown }).code).toBe("ConnectionRefused");
    const classified = classifyConnectionError(real);
    expect(classified).not.toBeNull();
    expect(classified).toHaveProperty("kind");
  });

  test("C4: the real fetch failure wrapped as an Error cause classifies non-null", async () => {
    const real = await realConnectionFailure();

    expect(classifyConnectionError(wrapped(real))).not.toBeNull();
  });

  test("C4: the spec's invalid_grant rejection classifies null", () => {
    expect(classifyConnectionError(invalidGrantRejection())).toBeNull();
  });

  test("C4: the bare 400 invalid_grant rejection classifies null", () => {
    expect(classifyConnectionError(bareServerRejection())).toBeNull();
  });
});

// Section 1: actual HTTP response and request counts, not endpoint getters alone.
describe("C2/E2: Codex handler never sends a metered request on refresh failure", () => {
  test.each([
    ["unknown refresh", () => new Error("refresh_token rejected"), 503, "transient"],
    ["classified invalid grant login rejection", invalidGrantRejection, 400, "terminal"],
    ["bare invalid grant", bareServerRejection, 400, "terminal"],
  ] as const)("%s", async (_label, makeError, status, verdict) => {
    const { Hono } = await import("hono");
    const { ComposedHandler } = await import("../../handlers/composed-handler.js");
    const { DefaultAPIFormat } = await import("../../adapters/base-api-format.js");
    installFakeCodexCredential(async () => {
      throw makeError();
    });
    let requests = 0;
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async () => {
        requests++;
        throw new Error("unexpected inference");
      },
      { preconnect: () => {} }
    ) as typeof fetch;
    const handler = new ComposedHandler(newTransport(), MODEL, MODEL, 0, {
      adapter: new DefaultAPIFormat(MODEL),
      catalogCachePath: join(testHome, "empty.json"),
    });
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
      expect(response.status).toBe(status);
      expect(response.headers.get("x-claudish-auth-verdict")).toBe(verdict);
      const body = await response.text();
      expect(body).toMatch(status === 400 ? /login codex/ : /refresh_token rejected/);
      expect(requests).toBe(0);
    } finally {
      globalThis.fetch = fetchBefore;
      await handler.shutdown();
    }
  });
});
