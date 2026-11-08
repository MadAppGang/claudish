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

test("U2: probe preserves upstream 401 and adds login action for terminal login errors", async () => {
  const { probeLink } = await import("./probe-live.js");
  let requests = 0;
  // Claudish error envelope, not a fabricated Meta endpoint response.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests++;
      return Response.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message:
              "Your Muse Code login has expired: run `claudish login muse` (or `muse login`).",
            upstream_status: 401,
          },
        },
        { status: 400, headers: { "x-claudish-auth-verdict": "terminal" } }
      );
    },
  });
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== server.url.origin) throw new Error(`Unexpected URL: ${url}`);
      return savedFetch(input, init);
    },
    { preconnect: () => {} }
  ) as typeof fetch;
  try {
    const result = await probeLink(
      server.url.origin,
      { provider: "meta-muse-code", modelSpec: "muse@muse-spark-1.3", hasCredentials: true },
      2000
    );
    expect(result.state).toBe("auth-failed");
    expect(result.httpStatus).toBe(401);
    expect(result.errorMessage).toContain("login");
    expect(result.actionHint).toContain("claudish login muse");
    expect(requests).toBe(1);
  } finally {
    await server.stop(true);
  }
});

test("U2: unsubscribed probe offers subscribe URL rather than a login action", async () => {
  const { probeLink } = await import("./probe-live.js");
  const url = "https://accountscenter.meta.com/muse_code/?ep=no_payg";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: `Your Meta account has no active Muse Code subscription (or needs a payment method): subscribe at ${url}.`,
            upstream_status: 403,
          },
        },
        { status: 400, headers: { "x-claudish-auth-verdict": "terminal" } }
      ),
  });
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (target.origin !== server.url.origin) throw new Error(`Unexpected URL: ${target}`);
      return savedFetch(input, init);
    },
    { preconnect: () => {} }
  ) as typeof fetch;
  try {
    const result = await probeLink(
      server.url.origin,
      { provider: "meta-muse-code", modelSpec: "muse@muse-spark-1.3", hasCredentials: true },
      2000
    );
    expect(result.state).toBe("auth-failed");
    expect(result.httpStatus).toBe(403);
    expect(result.actionHint).toContain(`subscribe at ${url}`);
    expect(result.actionHint).not.toContain("login");
  } finally {
    await server.stop(true);
  }
});

for (const upstreamStatus of [401, 403]) {
  test(`U2: real ComposedHandler terminal response retains upstream ${upstreamStatus} through probe`, async () => {
    const { Hono } = await import("hono");
    const { ComposedHandler } = await import("../handlers/composed-handler.js");
    const { probeLink } = await import("./probe-live.js");
    const { clearSignedArm } = await import("../auth/credentials/billing-probe.js");
    const subscribe = "https://accountscenter.meta.com/muse_code/?ep=no_payg";
    const message =
      upstreamStatus === 401
        ? "Your Muse Code login has expired: run `claudish login muse` (or `muse login`)."
        : `Your Meta account has no active Muse Code subscription (or needs a payment method): subscribe at ${subscribe}.`;
    let authCalls = 0;
    // A classified application error at the auth boundary, not a Meta wire fixture.
    const failure = Object.assign(new Error(message), { terminal: true, upstreamStatus });
    const handler = new ComposedHandler(
      {
        name: "meta-muse-code",
        displayName: "Muse Code",
        streamFormat: "openai-responses-sse",
        getEndpoint: () => "https://api.meta.ai/v1/responses",
        getHeaders: async () => ({}),
        refreshAuth: async () => {
          authCalls++;
          throw failure;
        },
      },
      "muse@muse-spark-1.3",
      "muse-spark-1.3",
      0
    );
    const app = new Hono();
    app.all("*", async (c) => handler.handle(c, await c.req.json()));
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    const observed: { status: number; verdict: string | null }[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (
          new URL(input instanceof Request ? input.url : String(input)).origin !== server.url.origin
        )
          throw new Error("upstream request forbidden");
        const response = await savedFetch(input, init);
        observed.push({
          status: response.status,
          verdict: response.headers.get("x-claudish-auth-verdict"),
        });
        return response;
      },
      { preconnect: () => {} }
    ) as typeof fetch;
    try {
      const result = await probeLink(
        server.url.origin,
        { provider: "meta-muse-code", modelSpec: "muse@muse-spark-1.3", hasCredentials: true },
        2000
      );
      expect(observed).toEqual([{ status: 400, verdict: "terminal" }]);
      expect(authCalls).toBe(1);
      expect(result.state).toBe("auth-failed");
      expect(result.httpStatus).toBe(upstreamStatus);
      expect(result.actionHint).toContain(
        upstreamStatus === 401 ? "claudish login muse" : `subscribe at ${subscribe}`
      );
      if (upstreamStatus === 403) expect(result.actionHint).not.toContain("login");
    } finally {
      await server.stop(true);
      await handler.shutdown();
      clearSignedArm();
    }
  });
}
