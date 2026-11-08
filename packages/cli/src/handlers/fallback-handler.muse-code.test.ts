import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
const { clearSignedArm, recordSignedArm } = await import("../auth/credentials/billing-probe.js");
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
const { FallbackHandler, isRetryableError, _resetCredentialRejectionNotices } = await import(
  "./fallback-handler.js"
);
import { authVerdictHeaders } from "./shared/auth-failure.js";

const subscriptions = [
  "kimi-coding",
  "qwen-token-plan",
  "qwen-coding",
  "glm-coding",
  "minimax-coding",
  "sakana-subscription",
  "opencode-zen-go",
  "grok-subscription",
  "antigravity",
  "devin",
  "meta-muse-code",
];
// Meta wire-capture §7; upstream_status is claudish's surfaced-error envelope.
const rejection = JSON.stringify({
  error: { type: "invalid_api_key", message: "Unauthorized", upstream_status: 401 },
});

// Owner rule 2026-10-21: a subscription's rejected credential advances to the
// next hop, metered included; a transient verdict still holds. (These tests
// pinned the earlier stop and were updated.)
describe("B1: routing-chain decisions on a subscription credential verdict", () => {
  test.each(subscriptions)(
    "%s advances a terminal verdict and holds a transient one before status recovery",
    (provider) => {
      for (const verdict of ["terminal", "transient"] as const) {
        for (const upstream of [401, 403]) {
          const body = JSON.stringify({
            error: { message: "run `claudish login muse`", upstream_status: upstream },
          });
          expect(
            isRetryableError(
              400,
              body,
              provider,
              new Headers(authVerdictHeaders(verdict)),
              provider
            )
          ).toBe(verdict === "terminal");
        }
      }
    }
  );
  test.each(subscriptions)("%s advances a credential rejection without a verdict", (provider) => {
    expect(isRetryableError(401, rejection, provider, new Headers(), provider)).toBe(true);
  });
  test("metered Meta 401 remains eligible to advance", () => {
    expect(isRetryableError(401, rejection, "meta", new Headers(), "meta")).toBe(true);
  });
});

describe("B2: request-specific failures may advance", () => {
  test.each([
    "Model deepseek-v4-pro-0813 is not supported",
    "Model grok-4.6 is not supported for format oa-compat",
  ])("Zen Go model miss: %s", (message) => {
    for (const status of [401, 403]) {
      expect(
        isRetryableError(status, message, "opencode-zen-go", new Headers(), "opencode-zen-go")
      ).toBe(true);
    }
  });
  test("Kimi allowance exhaustion still advances", () => {
    expect(
      isRetryableError(
        403,
        "You've reached your usage limit for this billing cycle",
        "kimi-coding",
        new Headers(),
        "kimi-coding"
      )
    ).toBe(true);
    expect(
      isRetryableError(
        429,
        "You've reached your usage limit for this billing cycle",
        "kimi-coding",
        new Headers(),
        "kimi-coding"
      )
    ).toBe(true);
  });
  test.skip("BLOCKED B2 region opt-in: no captured or measured region-opt-in message in the contract", () => {});
});

// Exercise the actual chain: only the second handler represents metered Meta.
async function twoHop(provider: string, firstResponse: () => Response) {
  let firstCalls = 0;
  let meteredCalls = 0;
  const warnings: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: unknown, ..._rest: unknown[]) => {
    warnings.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const chain = new FallbackHandler([
    {
      name: `${provider}@fixture`,
      provider,
      handler: {
        handle: async () => {
          firstCalls++;
          return firstResponse();
        },
        shutdown: async () => {},
      },
    },
    {
      name: "meta@fixture",
      provider: "meta",
      handler: {
        handle: async () => {
          meteredCalls++;
          return new Response("metered success");
        },
        shutdown: async () => {},
      },
    },
  ]);
  try {
    const app = new Hono();
    app.post("/", (c) => chain.handle(c, { messages: [{ role: "user", content: "PONG" }] }));
    const response = await app.request("http://localhost/", { method: "POST" });
    return {
      status: response.status,
      verdict: response.headers.get("x-claudish-auth-verdict"),
      body: await response.text(),
      firstCalls,
      meteredCalls,
      warnings: warnings.join(""),
    };
  } finally {
    process.stderr.write = originalWrite;
    await chain.shutdown();
  }
}

describe("B1: actual two-hop chain after a subscription credential verdict", () => {
  test.each([...subscriptions, "openai-codex"])(
    "%s moves on to metered Meta, announced, on a rejected credential",
    async (provider) => {
      recordSignedArm("openai-codex", "subscription");
      for (const verdict of ["terminal", "transient"] as const) {
        for (const upstream of [401, 403]) {
          _resetCredentialRejectionNotices();
          const result = await twoHop(
            provider,
            () =>
              new Response(
                JSON.stringify({
                  error: {
                    message: "run `claudish login muse`",
                    upstream_status: upstream,
                  },
                }),
                { status: verdict === "terminal" ? 400 : 503, headers: authVerdictHeaders(verdict) }
              )
          );
          expect(result.firstCalls).toBe(1);
          if (verdict === "terminal") {
            expect(result.status).toBe(200);
            expect(result.body).toBe("metered success");
            expect(result.meteredCalls).toBe(1);
            expect(result.warnings).toContain("meta@fixture (metered, billed per token)");
          } else {
            expect(result.status).toBe(503);
            expect(result.verdict).toBe("transient");
            expect(result.body).toContain("login muse");
            expect(result.meteredCalls).toBe(0);
          }
        }
      }
      for (const upstream of [401, 403]) {
        const result = await twoHop(provider, () => new Response(rejection, { status: upstream }));
        expect(result.status).toBe(200);
        expect(result.body).toBe("metered success");
        expect(result.firstCalls).toBe(1);
        expect(result.meteredCalls).toBe(1);
      }
    }
  );
});

describe("B2: actual request-specific and metered advances", () => {
  test.each([401, 403])(
    "Zen Go unsupported-model HTTP %i reaches the next handler once",
    async (status) => {
      const result = await twoHop(
        "opencode-zen-go",
        () => new Response("Model grok-4.6 is not supported for format oa-compat", { status })
      );
      expect(result.status).toBe(200);
      expect(result.body).toBe("metered success");
      expect(result.firstCalls).toBe(1);
      expect(result.meteredCalls).toBe(1);
    }
  );
  test.each([403, 429])(
    "subscription allowance HTTP %i advances with a billing warning",
    async (status) => {
      const result = await twoHop(
        "kimi-coding",
        () => new Response("You've reached your usage limit for this billing cycle", { status })
      );
      expect(result.status).toBe(200);
      expect(result.meteredCalls).toBe(1);
      expect(result.warnings).toMatch(/cost|metered|per.token|paid|billing/i);
    }
  );
  test("metered Meta invalid key advances, including Codex's metered signed arm", async () => {
    recordSignedArm("openai-codex", "metered");
    for (const provider of ["meta", "openai-codex"]) {
      const result = await twoHop(provider, () => new Response(rejection, { status: 401 }));
      expect(result.status).toBe(200);
      expect(result.body).toBe("metered success");
      expect(result.meteredCalls).toBe(1);
    }
  });
});
