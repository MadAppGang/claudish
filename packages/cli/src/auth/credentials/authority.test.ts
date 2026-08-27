import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ApiKeyCredentialProvider } from "./api-key-credential.js";
import { CredentialAuthority } from "./authority.js";
import { CompositeCredentialProvider } from "./composite-credential.js";
import { __resetSniffForTests } from "./op-source.js";
import type { CredentialProvider, RequestAuth, RequestAuthContext } from "./types.js";

// ── Hermetic op-source gate (mock-free) ─────────────────────────────────────
//
// The credential layer resolves env → aliases → config → keychain →
// 1Password (op://). On a machine with either external source enabled, real
// credentials could satisfy an intended miss; the SDK can also be denied or
// time out.
//
// We do NOT mock op-source.js: Bun's mock.module is process-global, so a stub
// here bleeds into sibling files that test the REAL op-source (op-source.test.ts)
// when both run in one `bun test` process. Instead we use the production escape
// hatches CLAUDISH_DISABLE_KEYCHAIN=1 and CLAUDISH_DISABLE_OP=1. The latter
// makes hasOpSources() return false WITHOUT touching the SDK. Together they
// preserve the env/config-only resolution these tests need, hermetically, with
// no module mock to leak.
let savedDisableKeychain: string | undefined;
let savedDisableOp: string | undefined;

beforeAll(() => {
  savedDisableKeychain = process.env.CLAUDISH_DISABLE_KEYCHAIN;
  savedDisableOp = process.env.CLAUDISH_DISABLE_OP;
  process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
  process.env.CLAUDISH_DISABLE_OP = "1";
  __resetSniffForTests(); // hasOpSources() memoizes — re-sniff with the flag on.
});

afterAll(() => {
  if (savedDisableKeychain === undefined) delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
  else process.env.CLAUDISH_DISABLE_KEYCHAIN = savedDisableKeychain;
  if (savedDisableOp === undefined) delete process.env.CLAUDISH_DISABLE_OP;
  else process.env.CLAUDISH_DISABLE_OP = savedDisableOp;
  __resetSniffForTests(); // drop the disabled-state sniff for later files.
});

// ── Test helpers ────────────────────────────────────────────────────────────

/** A fake CredentialProvider with scriptable authed-state + artifact/throw. */
class FakeProvider implements CredentialProvider {
  readonly catalogName: string;
  authed: boolean;
  private artifact: RequestAuth;
  private throwError?: Error;
  loginCalls = 0;
  logoutCalls = 0;
  getRequestAuthCalls = 0;
  invalidateCalls = 0;

  constructor(
    catalogName: string,
    opts: { authed?: boolean; artifact?: RequestAuth; throwError?: Error } = {}
  ) {
    this.catalogName = catalogName;
    this.authed = opts.authed ?? false;
    this.artifact = opts.artifact ?? { headers: { "x-from": catalogName } };
    this.throwError = opts.throwError;
  }

  async isAvailable(): Promise<boolean> {
    return this.authed;
  }

  async getRequestAuth(_ctx: RequestAuthContext): Promise<RequestAuth> {
    this.getRequestAuthCalls++;
    if (this.throwError) throw this.throwError;
    return this.artifact;
  }

  invalidate(): void {
    this.invalidateCalls++;
  }

  async login(): Promise<void> {
    this.loginCalls++;
  }

  async logout(): Promise<void> {
    this.logoutCalls++;
  }
}

const CTX: RequestAuthContext = { model: "test-model" };

/** Extract the resolved API key from a RequestAuth, for either auth scheme. */
function keyFromAuth(auth: RequestAuth): string | undefined {
  if (auth.headers.Authorization) {
    return auth.headers.Authorization.replace(/^Bearer /, "");
  }
  return auth.headers["x-api-key"];
}

// ── ApiKeyCredentialProvider ────────────────────────────────────────────────

describe("ApiKeyCredentialProvider", () => {
  const ENV_VAR = "CLAUDISH_TEST_FAKE_API_KEY";
  const ALIAS = "CLAUDISH_TEST_FAKE_API_KEY_ALIAS";
  let savedEnv: string | undefined;
  let savedAlias: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_VAR];
    savedAlias = process.env[ALIAS];
    delete process.env[ENV_VAR];
    delete process.env[ALIAS];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = savedEnv;
    if (savedAlias === undefined) delete process.env[ALIAS];
    else process.env[ALIAS] = savedAlias;
  });

  test("isAvailable() is true when the env var is set", async () => {
    const provider = new ApiKeyCredentialProvider({ catalogName: "fake", envVar: ENV_VAR });
    expect(await provider.isAvailable()).toBe(false);
    process.env[ENV_VAR] = "sk-test-123";
    provider.invalidate();
    expect(await provider.isAvailable()).toBe(true);
  });

  test("isAvailable() is true when an alias env var is set", async () => {
    const provider = new ApiKeyCredentialProvider({
      catalogName: "fake",
      envVar: ENV_VAR,
      aliases: [ALIAS],
    });
    expect(await provider.isAvailable()).toBe(false);
    process.env[ALIAS] = "sk-alias-456";
    provider.invalidate();
    expect(await provider.isAvailable()).toBe(true);
  });

  // Regression: when ONLY an alias env var is set, the resolved key must be the
  // alias's VALUE, not the alias NAME. Previously resolveFromEnvConfig used
  // `aliases.find(a => process.env[a])`, which returns the matching element (the
  // alias NAME string) — so getRequestAuth sent the literal env-var name as the
  // API key → guaranteed 401. Affects any provider configured via its alias
  // (e.g. glm via GLM_API_KEY, glm-coding via ZAI_CODING_API_KEY). The resolved
  // key now surfaces in the Authorization header as `Bearer <value>`.
  test("resolves the alias VALUE (not the alias name) when only the alias is set", async () => {
    process.env[ALIAS] = "sk-alias-real-value-789";
    const provider = new ApiKeyCredentialProvider({
      catalogName: "fake",
      envVar: ENV_VAR,
      aliases: [ALIAS],
    });
    const auth = await provider.getRequestAuth(CTX);
    expect(auth.headers.Authorization).toBe("Bearer sk-alias-real-value-789");
    // Specifically NOT the alias NAME — guards the resolve-name-vs-value bug.
    expect(auth.headers.Authorization).not.toBe(`Bearer ${ALIAS}`);
  });

  test("primary env var wins over an alias when both are set", async () => {
    process.env[ENV_VAR] = "sk-primary-wins";
    process.env[ALIAS] = "sk-alias-loses";
    const provider = new ApiKeyCredentialProvider({
      catalogName: "fake",
      envVar: ENV_VAR,
      aliases: [ALIAS],
    });
    const auth = await provider.getRequestAuth(CTX);
    expect(auth.headers.Authorization).toBe("Bearer sk-primary-wins");
  });

  test("getRequestAuth() returns an Authorization Bearer header (bearer scheme)", async () => {
    process.env[ENV_VAR] = "sk-bearer-789";
    const provider = new ApiKeyCredentialProvider({ catalogName: "fake", envVar: ENV_VAR });
    const auth = await provider.getRequestAuth(CTX);
    expect(auth.headers.Authorization).toBe("Bearer sk-bearer-789");
    expect(auth.endpoint).toBeUndefined();
    expect(auth.transformPayload).toBeUndefined();
  });

  test("getRequestAuth() uses x-api-key header when authScheme is x-api-key", async () => {
    process.env[ENV_VAR] = "sk-xkey-000";
    const provider = new ApiKeyCredentialProvider({
      catalogName: "fake",
      envVar: ENV_VAR,
      authScheme: "x-api-key",
    });
    const auth = await provider.getRequestAuth(CTX);
    expect(auth.headers["x-api-key"]).toBe("sk-xkey-000");
    expect(auth.headers.Authorization).toBeUndefined();
  });

  test("getRequestAuth() merges staticHeaders", async () => {
    process.env[ENV_VAR] = "sk-static";
    const provider = new ApiKeyCredentialProvider({
      catalogName: "fake",
      envVar: ENV_VAR,
      staticHeaders: { "X-Title": "claudish" },
    });
    const auth = await provider.getRequestAuth(CTX);
    expect(auth.headers["X-Title"]).toBe("claudish");
    expect(auth.headers.Authorization).toBe("Bearer sk-static");
  });

  test('isAvailable() is always true when authScheme is "none"', async () => {
    // No env/config key is needed when the provider expects no credential.
    const provider = new ApiKeyCredentialProvider({
      catalogName: "zen",
      envVar: "CLAUDISH_TEST_ZEN_KEY_UNSET",
      authScheme: "none",
    });
    expect(await provider.isAvailable()).toBe(true);
  });

  test("no fallback + no key → empty headers (request path rejects the route)", async () => {
    const provider = new ApiKeyCredentialProvider({
      catalogName: "fake",
      envVar: "CLAUDISH_TEST_NO_KEY_UNSET",
    });
    const auth = await provider.getRequestAuth(CTX);
    expect(auth.headers.Authorization).toBeUndefined();
    expect(auth.headers["x-api-key"]).toBeUndefined();
  });

  test("isAvailable() is false when the oauthFallback file does not exist", async () => {
    // A bogus oauthFallback filename (definitely absent under ~/.claudish) must
    // NOT authenticate when there's no env/config/op key either.
    const provider = new ApiKeyCredentialProvider({
      catalogName: "fake-oauth",
      envVar: "CLAUDISH_TEST_FAKE_OAUTH_KEY_UNSET",
      oauthFallback: "claudish-test-definitely-absent-oauth.json",
    });
    expect(await provider.isAvailable()).toBe(false);
  });

  // CRITICAL laziness test: isAvailable() with NO env/config key must return
  // false WITHOUT touching the 1Password SDK. ApiKeyCredentialProvider only
  // consults op-source when hasOpSources() is true — and CLAUDISH_DISABLE_OP=1
  // (set in beforeAll) pins hasOpSources() to false. So the op path is
  // STRUCTURALLY unreachable here: resolveOpKeyForEnvVars() is never called and
  // the @1password/sdk WASM never loads. (This structural guarantee replaces the
  // old mock-based call counter, which leaked across files.) We assert the check
  // resolves false, never throws, and completes near-instantly (an SDK pull would
  // take far longer than a few ms).
  test("isAvailable() returns false (no throw) without touching the 1Password SDK", async () => {
    const opOnlyVar = "CLAUDISH_TEST_OP_ONLY_KEY_XYZ";
    const saved = process.env[opOnlyVar];
    delete process.env[opOnlyVar];
    try {
      const provider = new ApiKeyCredentialProvider({ catalogName: "fake", envVar: opOnlyVar });
      // Even if config.json contained "op://Vault/Item/FAKE_FIELD" for this var,
      // hasOpSources() is false (CLAUDISH_DISABLE_OP=1) → the SDK is never consulted.
      let result: boolean | undefined;
      let threw = false;
      const started = performance.now();
      try {
        result = await provider.isAvailable();
      } catch {
        threw = true;
      }
      const elapsedMs = performance.now() - started;
      expect(threw).toBe(false);
      expect(result).toBe(false);
      // No SDK round-trip happened — the env/config-only path is synchronous-fast.
      expect(elapsedMs).toBeLessThan(250);
    } finally {
      if (saved === undefined) delete process.env[opOnlyVar];
      else process.env[opOnlyVar] = saved;
    }
  });

  // invalidate() drops the memoized resolution so the next isAvailable()/
  // getRequestAuth() re-reads env. Without it, an env change after the first
  // resolve would be invisible (the key is cached for the process lifetime).
  test("invalidate() re-opens resolution after the env changes", async () => {
    process.env[ENV_VAR] = "sk-cached-first";
    const provider = new ApiKeyCredentialProvider({ catalogName: "fake", envVar: ENV_VAR });
    expect(await provider.isAvailable()).toBe(true);
    // Prime the memo via a request.
    expect((await provider.getRequestAuth(CTX)).headers.Authorization).toBe(
      "Bearer sk-cached-first"
    );

    // Drop the key; the memoized value still reports available until invalidate().
    delete process.env[ENV_VAR];
    expect(await provider.isAvailable()).toBe(true);

    provider.invalidate();
    expect(await provider.isAvailable()).toBe(false);
  });
});

// ── CompositeCredentialProvider ─────────────────────────────────────────────

describe("CompositeCredentialProvider", () => {
  test("isAvailable() is true when either half is authed", async () => {
    const neither = new CompositeCredentialProvider(
      "c",
      new FakeProvider("p", { authed: false }),
      new FakeProvider("f", { authed: false })
    );
    expect(await neither.isAvailable()).toBe(false);

    const primaryOnly = new CompositeCredentialProvider(
      "c",
      new FakeProvider("p", { authed: true }),
      new FakeProvider("f", { authed: false })
    );
    expect(await primaryOnly.isAvailable()).toBe(true);

    const fallbackOnly = new CompositeCredentialProvider(
      "c",
      new FakeProvider("p", { authed: false }),
      new FakeProvider("f", { authed: true })
    );
    expect(await fallbackOnly.isAvailable()).toBe(true);
  });

  test("primary authed → returns the primary artifact", async () => {
    const primary = new FakeProvider("p", {
      authed: true,
      artifact: { headers: { src: "primary" } },
    });
    const fallback = new FakeProvider("f", {
      authed: true,
      artifact: { headers: { src: "fallback" } },
    });
    const composite = new CompositeCredentialProvider("c", primary, fallback);
    const auth = await composite.getRequestAuth(CTX);
    expect(auth.headers.src).toBe("primary");
    expect(fallback.getRequestAuthCalls).toBe(0);
  });

  test("primary unauthed → returns the fallback artifact", async () => {
    const primary = new FakeProvider("p", {
      authed: false,
      artifact: { headers: { src: "primary" } },
    });
    const fallback = new FakeProvider("f", {
      authed: true,
      artifact: { headers: { src: "fallback" } },
    });
    const composite = new CompositeCredentialProvider("c", primary, fallback);
    const auth = await composite.getRequestAuth(CTX);
    expect(auth.headers.src).toBe("fallback");
    expect(primary.getRequestAuthCalls).toBe(0);
  });

  test("primary throws the fallbackSignal → falls through to fallback", async () => {
    const primary = new FakeProvider("p", {
      authed: true,
      throwError: new Error("OAuth_FALLBACK_TO_API_KEY"),
    });
    const fallback = new FakeProvider("f", {
      authed: true,
      artifact: { headers: { src: "fallback" } },
    });
    const composite = new CompositeCredentialProvider("c", primary, fallback, {
      fallbackSignal: "OAuth_FALLBACK_TO_API_KEY",
    });
    const auth = await composite.getRequestAuth(CTX);
    expect(auth.headers.src).toBe("fallback");
    expect(primary.getRequestAuthCalls).toBe(1);
    expect(fallback.getRequestAuthCalls).toBe(1);
  });

  test("primary throws a non-signal error → rethrows (no fallback)", async () => {
    const primary = new FakeProvider("p", {
      authed: true,
      throwError: new Error("network exploded"),
    });
    const fallback = new FakeProvider("f", { authed: true });
    const composite = new CompositeCredentialProvider("c", primary, fallback, {
      fallbackSignal: "OAuth_FALLBACK_TO_API_KEY",
    });
    await expect(composite.getRequestAuth(CTX)).rejects.toThrow("network exploded");
    expect(fallback.getRequestAuthCalls).toBe(0);
  });
});

// ── CredentialAuthority registry/dispatch ───────────────────────────────────

describe("CredentialAuthority", () => {
  test("register + isAvailable dispatch by catalogName", async () => {
    const authority = new CredentialAuthority();
    authority.register(new FakeProvider("alpha", { authed: true }));
    authority.register(new FakeProvider("beta", { authed: false }));
    expect(await authority.isAvailable("alpha")).toBe(true);
    expect(await authority.isAvailable("beta")).toBe(false);
  });

  test("aliases resolve to the same instance", async () => {
    const authority = new CredentialAuthority();
    const instance = new FakeProvider("antigravity", { authed: true });
    authority.register(instance, ["antigravity", "google"]);
    expect(authority.get("antigravity")).toBe(instance);
    expect(authority.get("google")).toBe(instance);
    expect(await authority.isAvailable("google")).toBe(true);
  });

  test("unknown name → isAvailable false, getRequestAuth throws", async () => {
    const authority = new CredentialAuthority();
    expect(await authority.isAvailable("nonexistent")).toBe(false);
    await expect(authority.getRequestAuth("nonexistent", CTX)).rejects.toThrow(
      "No credential provider for nonexistent"
    );
  });

  test("isAvailable swallows a thrown provider check and returns false", async () => {
    const authority = new CredentialAuthority();
    const throwing: CredentialProvider = {
      catalogName: "throws",
      async isAvailable(): Promise<boolean> {
        throw new Error("boom");
      },
      async getRequestAuth() {
        return { headers: {} };
      },
    };
    authority.register(throwing);
    expect(await authority.isAvailable("throws")).toBe(false);
  });

  test("getRequestAuth dispatches to the registered provider's artifact", async () => {
    const authority = new CredentialAuthority();
    authority.register(
      new FakeProvider("alpha", { authed: true, artifact: { headers: { who: "alpha" } } })
    );
    const auth = await authority.getRequestAuth("alpha", CTX);
    expect(auth.headers.who).toBe("alpha");
  });

  test("login/logout no-op safely for a provider without those methods", async () => {
    const authority = new CredentialAuthority();
    const minimal: CredentialProvider = {
      catalogName: "minimal",
      isAvailable: async () => false,
      getRequestAuth: async () => ({ headers: {} }),
    };
    authority.register(minimal);
    // Should not throw despite no login/logout defined.
    await authority.login("minimal");
    await authority.logout("minimal");
    await authority.login("unknown-too");
  });

  test("invalidate(name) no-ops for a provider without invalidate()", () => {
    const authority = new CredentialAuthority();
    const minimal: CredentialProvider = {
      catalogName: "minimal",
      isAvailable: async () => false,
      getRequestAuth: async () => ({ headers: {} }),
    };
    authority.register(minimal);
    // Should not throw despite no invalidate() defined.
    expect(() => authority.invalidate("minimal")).not.toThrow();
    expect(() => authority.invalidate()).not.toThrow();
  });
});

// ── buildDefault() wiring ───────────────────────────────────────────────────

describe("CredentialAuthority.buildDefault()", () => {
  // Regression: kimi-coding must resolve its OWN key (KIMI_CODING_API_KEY),
  // not the regular Kimi key. Previously kimi-coding was aliased onto the
  // shared Kimi composite whose API-key half resolved MOONSHOT_API_KEY first,
  // so the coding-plan endpoint received the wrong product's key → 401.
  //
  // We assert the resolved key via the API-key fallback half of each composite:
  // the regular Kimi credential's fallback is keyed on MOONSHOT_API_KEY, the
  // coding credential's on KIMI_CODING_API_KEY. Going through getRequestAuth on
  // the API-key provider surfaces the resolved key in the Authorization header.
  // (We build the fallback halves with the SAME descriptors the composites use,
  // keeping the test hermetic regardless of whether a kimi-oauth.json exists on
  // the running machine — the old sync getApiKey() likewise bypassed OAuth.)
  test("kimi-coding resolves KIMI_CODING_API_KEY, kimi resolves MOONSHOT_API_KEY", async () => {
    const savedMoon = process.env.MOONSHOT_API_KEY;
    const savedKimi = process.env.KIMI_API_KEY;
    const savedCoding = process.env.KIMI_CODING_API_KEY;
    try {
      process.env.MOONSHOT_API_KEY = "sk-moonshot-regular";
      delete process.env.KIMI_API_KEY;
      process.env.KIMI_CODING_API_KEY = "sk-kimi-coding-dedicated";

      // Mirror kimi-credential.ts's fallback halves exactly.
      const kimiFallback = new ApiKeyCredentialProvider({
        catalogName: "kimi",
        envVar: "MOONSHOT_API_KEY",
        aliases: ["KIMI_API_KEY"],
      });
      const kimiCodingFallback = new ApiKeyCredentialProvider({
        catalogName: "kimi-coding",
        envVar: "KIMI_CODING_API_KEY",
      });

      // The coding provider must NOT pick up the regular Moonshot key.
      expect(keyFromAuth(await kimiCodingFallback.getRequestAuth(CTX))).toBe(
        "sk-kimi-coding-dedicated"
      );
      // The regular Kimi provider must NOT pick up the coding key.
      expect(keyFromAuth(await kimiFallback.getRequestAuth(CTX))).toBe("sk-moonshot-regular");
    } finally {
      if (savedMoon === undefined) delete process.env.MOONSHOT_API_KEY;
      else process.env.MOONSHOT_API_KEY = savedMoon;
      if (savedKimi === undefined) delete process.env.KIMI_API_KEY;
      else process.env.KIMI_API_KEY = savedKimi;
      if (savedCoding === undefined) delete process.env.KIMI_CODING_API_KEY;
      else process.env.KIMI_CODING_API_KEY = savedCoding;
    }
  });

  // Regression (probe 500): the runtime request path signs with the
  // RemoteProvider name "gemini" (toRemoteProvider renames the "google"
  // catalog entry), but the authority only registered "google" (and that,
  // wrongly, as a Code Assist alias) — so getRequestAuth("gemini") threw
  // "No credential provider for gemini" → HTTP 500 on every direct-Gemini
  // probe/request. Both names must resolve the same GEMINI_API_KEY credential.
  test("getRequestAuth('gemini') resolves the same GEMINI_API_KEY auth as 'google'", async () => {
    const saved = process.env.GEMINI_API_KEY;
    try {
      process.env.GEMINI_API_KEY = "sk-gemini-direct-123";
      const authority = CredentialAuthority.buildDefault();
      const viaRuntimeName = await authority.getRequestAuth("gemini", CTX);
      const viaCatalogName = await authority.getRequestAuth("google", CTX);
      expect(keyFromAuth(viaRuntimeName)).toBe("sk-gemini-direct-123");
      expect(viaCatalogName).toEqual(viaRuntimeName);
    } finally {
      if (saved === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = saved;
    }
  });

  // Hardening companion (proxy-server): an UNREGISTERED name must be
  // detectable via get() WITHOUT calling getRequestAuth (which throws) — the
  // request path uses this to degrade to the "no credential" 400 instead of
  // surfacing a 500.
  test("get() returns undefined for an unregistered name (no throw)", () => {
    const authority = CredentialAuthority.buildDefault();
    expect(authority.get("definitely-not-a-provider")).toBeUndefined();
  });

  // The real OAuth singletons read real credential files; we only assert the
  // negative (no oauth file → not authenticated) to keep the test hermetic.
});
