import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Explicit temporary directories and complete Keychain fakes isolate the core.
let home: string;
let billing: typeof import("../../auth/credentials/billing-probe.js");
let savedFetch: typeof fetch;
let savedDisable: string | undefined;
let core: typeof import("./muse-credentials.js");
let store: typeof import("./muse-store.js");
let roles: typeof import("../../auth/credentials/prompt-role.js");
let kc: typeof import("./muse-keychain.js");
let generic: typeof import("../keychain.js");
let mintModule: typeof import("./muse-mint.js");
let now: number;
let calls: string[];
let reads: number;
let status: number;
let body: Record<string, unknown>;
const OWN = "dca:TESTTOKENOWN0001";
const BORROWED = "dca:TESTTOKENBORROWED0001";
const KEYCHAIN = "dca:TESTTOKEN0001";
const KEY = "LLM|TESTKEY0001";
// §8 response fields with inert ASCII credentials; source/key changes are explicit mutations.
function capturedMint(): Record<string, unknown> {
  return {
    api_key: KEY,
    base_url: "https://api.meta.ai/v1",
    has_payment_method: true,
    require_payment: false,
    is_subs_active: true,
    can_subscribe: false,
    show_subs_upsell: true,
    user_full_name: "TEST USER",
    user_email: "test@example.invalid",
    user_avatar_url: null,
    payment_method: "TESTPAYMENT",
    action_url: null,
    subs_tier_id: "<tier-id>",
    subs_tier_name: "Muse Code Power Usage",
    is_subs_upgrade_available: true,
    subs_usage: {
      window: { used_percent: 1, window_duration_mins: 300, resets_at: 1792136182 },
      weekly: { used_percent: 0, resets_at: 1792368000 },
      tier: "<tier-id>",
    },
  };
}
function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
function installCore(overrides: Partial<import("./muse-credentials.js").MuseCoreDeps> = {}) {
  core.setMuseCoreTestDeps({
    readStore: (kind) => store.readMuseStore(kind, home),
    writeBorrowedCopy: (token, tier) =>
      store.writeBorrowedCopy(token, tier, home, () => new Date(1000000)),
    dir: () => home,
    now: () => now,
    mint: async (token) => {
      calls.push(token);
      return mintModule.mintMuseApiKey(token, {
        fetch: Object.assign(async () => Response.json(body, { status }), {
          preconnect: () => {},
        }) as typeof fetch,
      });
    },
    keychainLogin: async (use) => {
      reads++;
      return { kind: "used", value: await use(KEYCHAIN), source: "keychain" };
    },
    ...overrides,
  });
}
beforeEach(async () => {
  savedDisable = process.env.CLAUDISH_DISABLE_KEYCHAIN;
  home = mkdtempSync(join(tmpdir(), "muse-core-test-"));
  process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
  savedFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.protocol === "http:" && url.hostname === "127.0.0.1") return savedFetch(input, init);
      throw new Error(`unexpected network request: ${url.origin}${url.pathname}`);
    },
    { preconnect: () => {} }
  ) as typeof fetch;
  generic = await import("../keychain.js");
  generic.setKeychainTestDeps({
    platform: () => "darwin",
    run: () => {
      throw new Error("unexpected Keychain process");
    },
    runAsync: async () => {
      throw new Error("unexpected Keychain process");
    },
    spawnAsync: () => {
      throw new Error("unexpected Keychain process");
    },
  });
  kc = await import("./muse-keychain.js");
  kc.setMuseKeychainTestDeps({
    dir: () => home,
    env: () => ({ CLAUDISH_DISABLE_KEYCHAIN: "1" }),
    now: () => 1000000,
    sleep: async () => {},
    pid: () => 98765,
    isAlive: () => false,
    presence: async () => ({ kind: "absent" }),
    startRead: () => {
      throw new Error("unexpected value read");
    },
  });
  roles = await import("../../auth/credentials/prompt-role.js");
  store = await import("./muse-store.js");
  mintModule = await import("./muse-mint.js");
  core = await import("./muse-credentials.js");
  roles._resetCredentialPromptRoleForTest();
  core.resetMuseCredentialState();
  now = 1000000;
  calls = [];
  reads = 0;
  status = 200;
  body = capturedMint();
  installCore();
  billing = await import("../../auth/credentials/billing-probe.js");
  billing.clearSignedArm();
});
afterEach(() => {
  billing.clearSignedArm();
  globalThis.fetch = savedFetch;
  core.resetMuseCredentialState();
  core.setMuseCoreTestDeps(null);
  kc.resetMuseKeychainState();
  kc.setMuseKeychainTestDeps(null);
  generic.invalidateKeychainCache();
  generic.setKeychainTestDeps(null);
  roles._resetCredentialPromptRoleForTest();
  restore("CLAUDISH_DISABLE_KEYCHAIN", savedDisable);
  rmSync(home, { recursive: true, force: true });
});
function seed() {
  store.writeMuseStore("own-login", { access_token: OWN }, home);
  store.writeBorrowedCopy(BORROWED, "Muse Code Power Usage", home);
}
function bytes(kind: "own-login" | "borrowed-copy") {
  return readFileSync(store.museStorePath(kind, home), "utf8");
}

describe("C1/C3/C4: source selection and entitlement", () => {
  test("C1/C4: never role uses own login before borrowed without Keychain", async () => {
    seed();
    await core.ensureMuseCredentialReady({ prompt: false });
    expect(calls).toEqual([OWN]);
    expect(reads).toBe(0);
    expect(core.currentMuseState()).toMatchObject({
      source: "claudish-login",
      key: KEY,
      accessToken: OWN,
      subsTierName: "Muse Code Power Usage",
    });
  });
  for (const rejected of [401, 403]) {
    test(`C1: mint ${rejected} advances own → borrowed → permitted Keychain`, async () => {
      seed();
      roles.setCredentialPromptRole("interactive-launch");
      installCore({
        mint: async (token) => {
          calls.push(token);
          return mintModule.mintMuseApiKey(token, {
            fetch: Object.assign(
              async () =>
                token === KEYCHAIN
                  ? Response.json(capturedMint())
                  : Response.json(
                      { error: { type: "invalid_api_key", message: "Unauthorized" } },
                      { status: rejected }
                    ),
              { preconnect: () => {} }
            ) as typeof fetch,
          });
        },
      });
      await core.ensureMuseCredentialReady({ prompt: true });
      expect(calls).toEqual([OWN, BORROWED, KEYCHAIN]);
      expect(reads).toBe(1);
      expect(core.currentMuseState()).toMatchObject({
        source: "keychain",
        key: KEY,
        subsTierName: "Muse Code Power Usage",
      });
      expect(store.readMuseStore("borrowed-copy", home)).toMatchObject({
        access_token: KEYCHAIN,
        schema: 1,
        subs_tier_name: "Muse Code Power Usage",
      });
    });
  }
  for (const failure of [429, 503, "unknown"] as const) {
    test(`C1: ${failure} preserves both files and does not change source`, async () => {
      seed();
      const own = bytes("own-login");
      const borrowed = bytes("borrowed-copy");
      roles.setCredentialPromptRole("interactive-launch");
      const unknown = new Error("unclassified mint failure");
      if (failure === "unknown")
        installCore({
          mint: async (token) => {
            calls.push(token);
            throw unknown;
          },
        });
      else {
        status = failure;
        body = { error: { type: "invalid_api_key", message: "Unauthorized" } };
      }
      const operation = core.ensureMuseCredentialReady({ prompt: true });
      if (failure === "unknown") await expect(operation).rejects.toBe(unknown);
      else await expect(operation).rejects.toThrow();
      expect(calls).toEqual([OWN]);
      expect(reads).toBe(0);
      expect(bytes("own-login")).toBe(own);
      expect(bytes("borrowed-copy")).toBe(borrowed);
      expect(core.currentMuseState()).toBeUndefined();
    });
  }
  for (const wrapped of [false, true]) {
    test(`C1: actual refused fetch${wrapped ? " wrapped as cause" : ""} preserves sources`, async () => {
      seed();
      roles.setCredentialPromptRole("interactive-launch");
      const own = bytes("own-login");
      const borrowed = bytes("borrowed-copy");
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("unused"),
      });
      const url = `http://127.0.0.1:${server.port}/mint`;
      await server.stop(true);
      let refusal: unknown;
      try {
        await fetch(url);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(Error);
      const failure = wrapped ? new Error("mint request failed", { cause: refusal }) : refusal;
      installCore({
        mint: async (token) => {
          calls.push(token);
          throw failure;
        },
      });
      await expect(core.ensureMuseCredentialReady({ prompt: true })).rejects.toBe(failure);
      expect(calls).toEqual([OWN]);
      expect(reads).toBe(0);
      expect(bytes("own-login")).toBe(own);
      expect(bytes("borrowed-copy")).toBe(borrowed);
      expect(core.currentMuseState()).toBeUndefined();
    });
  }
  test("C4: borrowed file works in never role; missing files give exact team/MCP guidance", async () => {
    store.writeBorrowedCopy(BORROWED, "Muse Code Power Usage", home);
    await core.ensureMuseCredentialReady({ prompt: false });
    expect(core.currentMuseState()).toMatchObject({ source: "borrowed-copy", key: KEY });
    expect(calls).toEqual([BORROWED]);
    expect(reads).toBe(0);
    store.deleteMuseStores(home);
    core.resetMuseCredentialState();
    await expect(core.ensureMuseCredentialReady({ prompt: false })).rejects.toThrow(
      "muse@ in a team slot / MCP session needs a claudish login: run `claudish login muse`, or one interactive `claudish --model muse@<model>` and allow Keychain access."
    );
    expect(reads).toBe(0);
    expect(calls).toEqual([BORROWED]);
  });
  test("C3: approval alone does not copy a login before confirming mint", async () => {
    roles.setCredentialPromptRole("interactive-launch");
    let release!: (value: import("./muse-mint.js").MuseMint) => void;
    const deferred = new Promise<import("./muse-mint.js").MuseMint>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    installCore({
      mint: async () => {
        entered();
        return deferred;
      },
    });
    const pending = core.ensureMuseCredentialReady({ prompt: true });
    await started;
    expect(existsSync(store.museStorePath("borrowed-copy", home))).toBe(false);
    expect(core.currentMuseState()).toBeUndefined();
    release(mintModule.interpretMint(capturedMint()));
    await pending;
    expect(store.readMuseStore("borrowed-copy", home)).toMatchObject({
      access_token: KEYCHAIN,
      subs_tier_name: "Muse Code Power Usage",
    });
    expect(core.currentMuseState()?.key).toBe(KEY);
  });
  for (const failure of ["denied", "transient", "unsubscribed"] as const) {
    test(`C3: ${failure} never writes a borrowed copy or installs a key`, async () => {
      roles.setCredentialPromptRole("interactive-launch");
      if (failure === "denied")
        installCore({ keychainLogin: async () => ({ kind: "failed" as const, detail: "denied" }) });
      else if (failure === "transient") {
        status = 503;
      } else body.is_subs_active = false;
      await expect(core.ensureMuseCredentialReady({ prompt: true })).rejects.toThrow(
        failure === "unsubscribed"
          ? "https://accountscenter.meta.com/muse_code/?ep=no_payg"
          : undefined
      );
      expect(existsSync(store.museStorePath("borrowed-copy", home))).toBe(false);
      expect(core.currentMuseState()).toBeUndefined();
      if (failure === "denied") expect(calls).toEqual([]);
    });
  }
});

describe("C2: process cache, TTL and rejected-key concurrency", () => {
  test("concurrent resolves mint once and repeated requests reuse the key", async () => {
    seed();
    let release!: (v: import("./muse-mint.js").MuseMint) => void;
    const deferred = new Promise<import("./muse-mint.js").MuseMint>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    installCore({
      mint: async (token) => {
        calls.push(token);
        entered();
        return deferred;
      },
    });
    const first = core.ensureMuseCredentialReady({ prompt: false });
    await started;
    const second = core.ensureMuseCredentialReady({ prompt: false });
    release(mintModule.interpretMint(capturedMint()));
    await Promise.all([first, second]);
    await core.ensureMuseCredentialReady({ prompt: false });
    expect(calls).toEqual([OWN]);
    expect(core.currentMuseState()?.key).toBe(KEY);
  });
  test("exactly 30 minutes reuses; one millisecond later requires successful confirmation", async () => {
    seed();
    await core.ensureMuseCredentialReady({ prompt: false });
    now += 30 * 60_000;
    await core.ensureMuseCredentialReady({ prompt: false });
    expect(calls).toEqual([OWN]);
    now++;
    status = 503;
    await expect(core.ensureMuseCredentialReady({ prompt: false })).rejects.toThrow();
    expect(calls).toEqual([OWN, OWN]);
    status = 200;
    body.api_key = "LLM|TESTKEY0002";
    await core.ensureMuseCredentialReady({ prompt: false });
    expect(calls).toEqual([OWN, OWN, OWN]);
    expect(core.currentMuseState()).toMatchObject({ key: body.api_key, confirmedAt: now });
  });
  test("concurrent 401s share remint; a stale rejection cannot replace the newer key", async () => {
    seed();
    await core.ensureMuseCredentialReady({ prompt: false });
    const generation = core.currentMuseState()!.generation;
    const next = { ...mintModule.interpretMint(capturedMint()), apiKey: "LLM|TESTKEY0002" };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    installCore({
      mint: async (token) => {
        calls.push(token);
        entered();
        await gate;
        return next;
      },
    });
    const first = core.forceRefreshMuseApiKey({ rejectedKey: KEY, prompt: false });
    await started;
    const second = core.forceRefreshMuseApiKey({ rejectedKey: KEY, prompt: false });
    release();
    await Promise.all([first, second]);
    expect(calls).toEqual([OWN, OWN]);
    expect(core.currentMuseState()?.key).toBe(next.apiKey);
    expect(core.currentMuseState()!.generation).toBeGreaterThan(generation);
    const current = core.currentMuseState()!.generation;
    await core.forceRefreshMuseApiKey({ rejectedKey: KEY, prompt: false });
    expect(calls).toEqual([OWN, OWN]);
    expect(core.currentMuseState()).toMatchObject({ key: next.apiKey, generation: current });
  });
  test("a failed remint cannot revive the rejected key from process cache", async () => {
    store.writeMuseStore("own-login", { access_token: OWN }, home);
    await core.ensureMuseCredentialReady({ prompt: false });
    status = 401;
    body = { error: { type: "invalid_api_key", message: "Unauthorized" } };
    await expect(core.forceRefreshMuseApiKey({ rejectedKey: KEY, prompt: false })).rejects.toThrow(
      "login"
    );
    await expect(core.ensureMuseCredentialReady({ prompt: false })).rejects.toThrow("login");
    expect(calls.length).toBeGreaterThan(1);
    expect(reads).toBe(0);
    expect(store.readMuseStore("own-login", home)?.access_token).toBe(OWN);
  });
});
