import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;
let savedEnv: Map<string, string | undefined>;
let savedFetch: typeof fetch;
let core: typeof import("../../providers/meta-muse/muse-credentials.js");
let store: typeof import("../../providers/meta-muse/muse-store.js");
let mint: typeof import("../../providers/meta-muse/muse-mint.js");
let generic: typeof import("../../providers/keychain.js");
let kc: typeof import("../../providers/meta-muse/muse-keychain.js");
let roles: typeof import("./prompt-role.js");
let authority: typeof import("./authority.js");
let billing: typeof import("./billing-probe.js");
let provider: import("./muse-code-credential.js").MuseCodeCredentialProvider;
let previous: import("./types.js").CredentialProvider;
let now: number;
let calls: string[];
let reads: number;
let failure: Error | undefined;
let body: Record<string, unknown>;
const TOKEN = "dca:TESTTOKEN0001";
const KEY = "LLM|TESTKEY0001";
// §8 capture. Credential values are inert ASCII placeholders; tests mutate flags and keys.
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
beforeEach(async () => {
  savedEnv = new Map(["CLAUDISH_DISABLE_KEYCHAIN", "META_API_KEY"].map((k) => [k, process.env[k]]));
  home = mkdtempSync(join(tmpdir(), "muse-credential-test-"));
  process.env.CLAUDISH_DISABLE_KEYCHAIN = "1";
  process.env.META_API_KEY = "metered-key-fixture-never-send";
  savedFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("unexpected network request");
    },
    { preconnect: () => {} }
  ) as typeof fetch;
  generic = await import("../../providers/keychain.js");
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
  kc = await import("../../providers/meta-muse/muse-keychain.js");
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
  roles = await import("./prompt-role.js");
  store = await import("../../providers/meta-muse/muse-store.js");
  mint = await import("../../providers/meta-muse/muse-mint.js");
  core = await import("../../providers/meta-muse/muse-credentials.js");
  roles._resetCredentialPromptRoleForTest();
  core.resetMuseCredentialState();
  now = 1000000;
  calls = [];
  reads = 0;
  failure = undefined;
  body = capturedMint();
  core.setMuseCoreTestDeps({
    readStore: (kind) => store.readMuseStore(kind, home),
    writeBorrowedCopy: (token, tier) =>
      store.writeBorrowedCopy(token, tier, home, () => new Date(1000000)),
    dir: () => home,
    now: () => now,
    mint: async (token) => {
      calls.push(token);
      if (failure) throw failure;
      return mint.interpretMint(body);
    },
    keychainLogin: async () => {
      reads++;
      return { kind: "not-allowed" };
    },
  });
  authority = await import("./authority.js");
  billing = await import("./billing-probe.js");
  const old = authority.credentials.get("meta-muse-code");
  if (!old) throw new Error("default Muse credential registration missing");
  previous = old;
  const { MuseCodeCredentialProvider } = await import("./muse-code-credential.js");
  provider = new MuseCodeCredentialProvider();
  authority.credentials.register(provider, ["meta-muse-code"]);
  billing.clearSignedArm();
});
afterEach(() => {
  authority.credentials.register(previous, ["meta-muse-code"]);
  authority.credentials.invalidate("meta-muse-code");
  billing.clearSignedArm();
  core.resetMuseCredentialState();
  core.setMuseCoreTestDeps(null);
  kc.resetMuseKeychainState();
  kc.setMuseKeychainTestDeps(null);
  generic.invalidateKeychainCache();
  generic.setKeychainTestDeps(null);
  roles._resetCredentialPromptRoleForTest();
  globalThis.fetch = savedFetch;
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});
function sign() {
  return authority.credentials.getRequestAuth("meta-muse-code", { model: "muse-spark-1.3" });
}

describe("A1/C2: the real Muse credential signs only confirmed process keys", () => {
  test("authority registration returns an OAuth artifact with the minted bearer, ignoring META_API_KEY", async () => {
    store.writeMuseStore("own-login", { access_token: TOKEN }, home);
    expect(provider.catalogName).toBe("meta-muse-code");
    expect(authority.credentials.get("meta-muse-code")).toBe(provider);
    const artifact = await sign();
    expect(artifact.arm).toBe("oauth");
    expect(artifact.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(Object.values(artifact.headers)).not.toContain(`Bearer ${process.env.META_API_KEY}`);
    expect(calls).toEqual([TOKEN]);
    expect(reads).toBe(0);
    expect(await provider.isAvailable()).toBe(true);
    expect((await provider.describeReadiness()).readiness).toBe("present");
    expect((await sign()).headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(calls).toEqual([TOKEN]);
  });
  test("META_API_KEY alone cannot make Muse ready or sign; error names claudish login muse", async () => {
    expect(await provider.isAvailable()).toBe(false);
    expect((await provider.describeReadiness()).readiness).toBe("absent");
    await expect(sign()).rejects.toThrow("claudish login muse");
    expect(calls).toEqual([]);
    expect(reads).toBe(0);
    expect(core.currentMuseState()).toBeUndefined();
  });
  for (const flags of [
    { is_subs_active: false, require_payment: false },
    { is_subs_active: true, require_payment: true },
    { is_subs_active: undefined, require_payment: false },
    { is_subs_active: true, require_payment: undefined },
  ]) {
    test(`readiness cannot bypass entitlement ${JSON.stringify(flags)}`, async () => {
      store.writeMuseStore("own-login", { access_token: TOKEN }, home);
      Object.assign(body, flags);
      await provider.describeReadiness();
      await provider.isAvailable();
      await expect(sign()).rejects.toThrow("https://accountscenter.meta.com/muse_code/?ep=no_payg");
      expect(calls.length).toBeGreaterThan(0);
      expect(reads).toBe(0);
      expect(core.currentMuseState()).toBeUndefined();
      expect(store.readMuseStore("own-login", home)?.access_token).toBe(TOKEN);
    });
  }
  test("C2: exact TTL signs cached key; expired confirmation must remint before signing", async () => {
    store.writeMuseStore("own-login", { access_token: TOKEN }, home);
    expect((await sign()).headers.Authorization).toBe(`Bearer ${KEY}`);
    now += 30 * 60_000;
    expect((await sign()).headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(calls).toEqual([TOKEN]);
    now++;
    failure = new mint.MuseMintTransientError(503);
    await expect(sign()).rejects.toBe(failure);
    expect(calls).toEqual([TOKEN, TOKEN]);
    failure = undefined;
    body.api_key = "LLM|TESTKEY0002";
    expect((await sign()).headers.Authorization).toBe(`Bearer ${body.api_key}`);
    expect(calls).toEqual([TOKEN, TOKEN, TOKEN]);
  });
  test("C2: rejected key cannot sign after a terminal remint", async () => {
    store.writeMuseStore("own-login", { access_token: TOKEN }, home);
    expect((await sign()).headers.Authorization).toBe(`Bearer ${KEY}`);
    failure = new mint.MuseLoginExpiredError(401);
    await expect(core.forceRefreshMuseApiKey({ rejectedKey: KEY, prompt: false })).rejects.toThrow(
      "login"
    );
    await expect(sign()).rejects.toThrow("login");
    expect(calls.length).toBeGreaterThan(1);
    expect(reads).toBe(0);
  });
});
