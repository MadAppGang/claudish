import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

const savedEnvironment = new Map(
  ["CLAUDISH_DISABLE_KEYCHAIN", "API_TIMEOUT_MS"].map((k) => [k, process.env[k]])
);
const testHome = mkdtempSync(join(tmpdir(), "claudish-subscription-only-"));
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
const { FallbackHandler } = await import("./fallback-handler.js");
import { authVerdictHeaders } from "./shared/auth-failure.js";

function terminalLoginFailure(message = "This API key has expired.") {
  return new Response(JSON.stringify({ error: { message, upstream_status: 401 } }), {
    status: 400,
    headers: authVerdictHeaders("terminal"),
  });
}

function rawLoginFailure() {
  return new Response(
    JSON.stringify({ error: { type: "invalid_api_key", message: "Unauthorized" } }),
    { status: 401 }
  );
}

function usageLimit() {
  return new Response(JSON.stringify({ error: { message: "usage limit reached" } }), {
    status: 429,
  });
}

const loginFailures = [
  {
    response: terminalLoginFailure,
    status: 400,
    verdict: "terminal",
    message: "This API key has expired.",
  },
  { response: rawLoginFailure, status: 401, verdict: null, message: "Unauthorized" },
];

async function runChain(candidates: { provider: string; response: Response }[]) {
  const calls = candidates.map(() => 0);
  const originalWrite = process.stderr.write;
  process.stderr.write = ((_chunk: unknown, ..._rest: unknown[]) => {
    return true;
  }) as typeof process.stderr.write;
  const chain = new FallbackHandler(
    candidates.map(({ provider, response }, index) => ({
      name: `${provider}@subscription-only-test-${index}`,
      provider,
      handler: {
        handle: async () => {
          calls[index]++;
          return response;
        },
        shutdown: async () => {},
      },
    }))
  );
  try {
    const app = new Hono();
    app.post("/", (c) =>
      chain.handle(c, {
        model: "glm-5.3",
        messages: [{ role: "user", content: "PONG" }],
      })
    );
    const response = await app.request("http://localhost/", { method: "POST" });
    return {
      status: response.status,
      verdict: response.headers.get("x-claudish-auth-verdict"),
      body: await response.text(),
      calls,
    };
  } finally {
    process.stderr.write = originalWrite;
    await chain.shutdown();
  }
}

const subscriptions = [
  "glm-coding",
  "opencode-zen-go",
  "qwen-token-plan",
  "kimi-coding",
  "minimax-coding",
  "qwen-coding",
  "devin",
  "antigravity",
  "sakana-subscription",
  "grok-subscription",
];

describe("subscription-only routing after a login failure", () => {
  test("rule 1: either login failure skips every later metered candidate", async () => {
    for (const provider of subscriptions) {
      for (const failure of loginFailures) {
        const result = await runChain([
          { provider, response: failure.response() },
          { provider: "glm", response: new Response("metered glm success") },
          {
            provider: provider === "qwen-token-plan" ? "kimi-coding" : "qwen-token-plan",
            response: new Response("remaining subscription success"),
          },
          { provider: "z-ai", response: new Response("metered z-ai success") },
        ]);
        expect(result.calls).toEqual([1, 0, 1, 0]);
        expect(result.status).toBe(200);
        expect(result.body).toBe("remaining subscription success");
      }
    }
  });

  test("rule 2: returns the later subscription's successful response", async () => {
    const body = JSON.stringify({ answer: "served by kimi-coding" });
    const result = await runChain([
      { provider: "opencode-zen-go", response: terminalLoginFailure() },
      { provider: "kimi-coding", response: new Response(body, { status: 200 }) },
      { provider: "meta", response: new Response("metered success") },
    ]);
    expect(result.status).toBe(200);
    expect(result.body).toBe(body);
    expect(result.calls).toEqual([1, 1, 0]);
  });

  test("rule 3: later login, usage-limit, and server failures continue to subscriptions", async () => {
    const laterFailures = [
      () => terminalLoginFailure("Later subscription login failed"),
      rawLoginFailure,
      usageLimit,
      () => new Response("Internal Server Error", { status: 500 }),
    ];
    for (const laterFailure of laterFailures) {
      const result = await runChain([
        { provider: "opencode-zen-go", response: terminalLoginFailure() },
        { provider: "deepseek", response: new Response("metered deepseek success") },
        { provider: "kimi-coding", response: laterFailure() },
        { provider: "openrouter", response: new Response("metered openrouter success") },
        { provider: "qwen-token-plan", response: new Response("subscription success") },
        { provider: "poe", response: new Response("metered poe success") },
      ]);
      expect(result.status).toBe(200);
      expect(result.body).toBe("subscription success");
      expect(result.calls).toEqual([1, 0, 1, 0, 1, 0]);
    }
  });

  test("rule 4: exhausted subscriptions return the first login failure unchanged", async () => {
    for (const failure of loginFailures) {
      const firstFailure = failure.response();
      const firstBody = await firstFailure.clone().text();
      const result = await runChain([
        { provider: "opencode-zen-go", response: firstFailure },
        { provider: "meta", response: new Response("metered meta success") },
        { provider: "kimi-coding", response: terminalLoginFailure("Later login failed") },
        { provider: "qwen-token-plan", response: usageLimit() },
        { provider: "glm-coding", response: new Response("Server failure", { status: 500 }) },
        { provider: "openrouter", response: new Response("metered openrouter success") },
      ]);
      expect(result.status).toBe(failure.status);
      expect(result.verdict).toBe(failure.verdict);
      expect(result.body).toBe(firstBody);
      expect(result.body).toContain(failure.message);
      expect(result.body).not.toContain("all_providers_failed");
      expect(result.body).not.toContain("Later login failed");
      expect(result.calls).toEqual([1, 0, 1, 1, 1, 0]);
    }
  });

  test("rule 5: a transient subscription verdict returns without advancing", async () => {
    const body = JSON.stringify({
      error: { message: "Subscription login temporarily unavailable" },
    });
    const result = await runChain([
      {
        provider: "opencode-zen-go",
        response: new Response(body, { status: 503, headers: authVerdictHeaders("transient") }),
      },
      { provider: "qwen-token-plan", response: new Response("subscription success") },
      { provider: "meta", response: new Response("metered success") },
    ]);
    expect(result.status).toBe(503);
    expect(result.verdict).toBe("transient");
    expect(result.body).toBe(body);
    expect(result.calls).toEqual([1, 0, 0]);
  });

  test("rule 5: a terminal metered verdict returns without advancing", async () => {
    const body = JSON.stringify({
      error: { message: "Metered login failed", upstream_status: 401 },
    });
    const result = await runChain([
      {
        provider: "meta",
        response: new Response(body, { status: 400, headers: authVerdictHeaders("terminal") }),
      },
      { provider: "qwen-token-plan", response: new Response("subscription success") },
      { provider: "openrouter", response: new Response("metered success") },
    ]);
    expect(result.status).toBe(400);
    expect(result.verdict).toBe("terminal");
    expect(result.body).toBe(body);
    expect(result.calls).toEqual([1, 0, 0]);
  });

  test("rule 5: a usage limit before any login failure can advance to metered", async () => {
    const result = await runChain([
      { provider: "kimi-coding", response: usageLimit() },
      { provider: "deepseek", response: new Response("metered success") },
      { provider: "qwen-token-plan", response: new Response("subscription success") },
    ]);
    expect(result.status).toBe(200);
    expect(result.body).toBe("metered success");
    expect(result.calls).toEqual([1, 1, 0]);
  });

  test("rule 6: each candidate is called at most once per request", async () => {
    const result = await runChain([
      { provider: "glm-coding", response: usageLimit() },
      { provider: "opencode-zen-go", response: terminalLoginFailure() },
      { provider: "glm", response: new Response("metered glm success") },
      { provider: "kimi-coding", response: rawLoginFailure() },
      { provider: "z-ai", response: new Response("metered z-ai success") },
      { provider: "minimax-coding", response: usageLimit() },
      { provider: "qwen-coding", response: new Response("Server failure", { status: 500 }) },
      { provider: "qwen-token-plan", response: new Response("subscription success") },
      { provider: "poe", response: new Response("metered poe success") },
    ]);
    expect(result.status).toBe(200);
    expect(result.body).toBe("subscription success");
    expect(result.calls).toEqual([1, 1, 0, 1, 0, 1, 1, 1, 0]);
    for (const count of result.calls) expect(count).toBeLessThanOrEqual(1);
  });

  test("real glm-5.3 chain: expired package, expired key, then qwen-token-plan", async () => {
    const result = await runChain([
      {
        provider: "glm-coding",
        response: new Response(
          JSON.stringify({ error: { message: "Your plan package has expired" } }),
          { status: 429 }
        ),
      },
      { provider: "opencode-zen-go", response: terminalLoginFailure("This API key has expired") },
      { provider: "qwen-token-plan", response: new Response("qwen-token-plan serves glm-5.3") },
      { provider: "glm", response: new Response("metered glm success") },
      { provider: "z-ai", response: new Response("metered z-ai success") },
    ]);
    expect(result.status).toBe(200);
    expect(result.body).toBe("qwen-token-plan serves glm-5.3");
    expect(result.calls).toEqual([1, 1, 1, 0, 0]);
  });

  test("real interleaved chain: terminal Zen Go skips metered DeepSeek before Qwen", async () => {
    const result = await runChain([
      { provider: "opencode-zen-go", response: terminalLoginFailure() },
      { provider: "deepseek", response: new Response("metered deepseek success") },
      { provider: "qwen-token-plan", response: new Response("qwen-token-plan success") },
    ]);
    expect(result.status).toBe(200);
    expect(result.body).toBe("qwen-token-plan success");
    expect(result.calls).toEqual([1, 0, 1]);
  });
});
