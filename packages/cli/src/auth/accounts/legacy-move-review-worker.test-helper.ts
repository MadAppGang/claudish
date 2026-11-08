/**
 * Isolated child for legacy-move-review.test.ts (MTL-372, second review round).
 *
 * Runs under a temp HOME handed in by the parent, with the fake `security`
 * installed and outbound `fetch` replaced before any account module is
 * imported. Never the real Keychain, never the real ~/.claudish, never a
 * browser: every PKCE seam is a fake.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodexPkceDeps, CodexPkceResult } from "../codex-pkce.js";
import { FakeSecurity } from "./fake-security.test-helper.js";
import type { StoredTokenRecord } from "./token-store.js";
import type { AccountRef, SubscriptionAccountsEntry } from "./types.js";

type Row = SubscriptionAccountsEntry["accounts"][number];

const scenario = process.argv[2]!;
const home = process.env.HOME!;
assert.ok(home && home !== "/", "a dedicated temp HOME is mandatory");
assert.equal(process.env.CLAUDISH_DISABLE_KEYCHAIN, "1", "child must boot with Keychain disabled");
assert.equal(process.env.CLAUDISH_ACCOUNTS_DIR, join(home, ".claudish", "accounts"));
const fake = new FakeSecurity(home);

const { setKeychainTestDeps, invalidateKeychainCache } = await import(
  "../../providers/keychain.js"
);
setKeychainTestDeps(fake.deps("darwin"));
delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
delete process.env.CLAUDISH_ACCOUNT_STORE;
delete process.env.CLAUDISH_KEYCHAIN_FILE;

/** Every token-endpoint request the facade makes. Anything else is refused. */
const tokenRequests: string[] = [];
let onTokenRequest: (() => Response | Promise<Response>) | null = null;
globalThis.fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0]) => {
    const url = input instanceof Request ? input.url : String(input);
    assert.ok(url.endsWith("/oauth/token"), "only the token endpoint may be reached");
    tokenRequests.push(url);
    if (!onTokenRequest) throw new Error("no token exchange is expected in this scenario");
    return onTokenRequest();
  },
  { preconnect: () => {} }
) as typeof fetch;

const { CodexAccountManagement, legacyMoveDeferredMessage } = await import("./management.js");
const { LegacyCodexFileStore, KeychainTokenStore, fingerprintOf } = await import(
  "./token-store.js"
);
const { AccountRegistry, setAccountRegistryForTests } = await import("./registry.js");
const { legacyCodexCredentialsPath } = await import("./paths.js");

const env = process.env;
const appHome = join(home, ".claudish");
const defaultConfig = join(appHome, "config.json");
const legacyPath = legacyCodexCredentialsPath(env);
mkdirSync(appHome, { recursive: true, mode: 0o700 });
mkdirSync(env.CLAUDISH_ACCOUNTS_DIR!, { recursive: true, mode: 0o700 });
let activeConfig = defaultConfig;
const ref: AccountRef = { provider: "openai-codex", id: "aaaaaaaaaaaa", label: "default" };
const legacy = new LegacyCodexFileStore({ env, path: legacyPath });
const keychain = new KeychainTokenStore({ env });
const registry = new AccountRegistry({
  env,
  configPath: () => activeConfig,
  legacyCodexPath: () => legacyPath,
});
setAccountRegistryForTests(registry);

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const fileHash = (path: string) =>
  existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;

function seedConfig(rows: Row[] = [], marker = false, path = activeConfig): void {
  const config = {
    subscriptionAccounts: {
      "openai-codex": {
        generation: 1,
        accounts: rows,
        ...(marker ? { legacyCodexSuppressed: true } : {}),
      },
    },
  };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  registry.invalidate();
}
function row(overrides: Partial<Row> = {}): Row {
  return {
    id: ref.id,
    label: ref.label,
    store: "legacy-codex-file",
    enabled: true,
    identity: { chatgptAccountId: "test-codex-identity" },
    addedAt: "2026-01-02T03:04:05.000Z",
    ...overrides,
  };
}
function token(suffix: string, expiresAt: number): StoredTokenRecord {
  const refreshToken = `legacy-refresh-marker-${suffix}`;
  return {
    accessToken: `legacy-access-marker-${suffix}`,
    refreshToken,
    expiresAt,
    accountId: "test-codex-identity",
    generation: 3,
    fingerprint: fingerprintOf(refreshToken),
    updatedAt: 1_780_000_000_000,
  };
}
function rotatedResponse(): Response {
  return Response.json({
    access_token: "rotated-access-marker",
    refresh_token: "rotated-refresh-marker",
    expires_in: 3600,
    token_type: "Bearer",
  });
}
/** The published state the move leaves when M8 failed: a keychain row, the marker, the file. */
function publishedMoveConfig(): void {
  seedConfig([row({ store: "keychain" })], true);
}
function idToken(accountId: string): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    part({ alg: "none" }),
    part({
      email: "test@example.invalid",
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId,
        chatgpt_plan_type: "test-plan",
      },
    }),
    "signature",
  ].join(".");
}
function pkceResult(suffix: string): CodexPkceResult {
  return {
    credentials: {
      access_token: `login-access-marker-${suffix}`,
      refresh_token: `login-refresh-marker-${suffix}`,
      expires_at: Date.now() + 3_600_000,
      account_id: "test-codex-identity",
    },
    identity: {
      chatgptAccountId: "test-codex-identity",
      email: "test@example.invalid",
      plan: "test-plan",
    },
  };
}
async function facade() {
  const mod = await import("../codex-oauth.js");
  mod.CodexOAuth._resetInstanceForTests();
  return mod;
}
async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

async function run(): Promise<void> {
  switch (scenario) {
    case "facade-file-left": {
      // A: the move published (keychain row + marker) and its M8 delete did not
      // happen. The facade's expired file is still present: it must not exchange.
      seedConfig([]);
      await legacy.write(ref, token("left", Date.now() - 60_000));
      const { CodexOAuth, CodexOAuthLocalError, CodexOAuthRefreshError } = await facade();
      const oauth = CodexOAuth.getInstance();
      assert.equal(oauth.hasCredentials(), true, "the facade loaded the file before the move");
      publishedMoveConfig();
      const before = fileHash(legacyPath);
      onTokenRequest = rotatedResponse;

      const err = await rejection(oauth.getAccessToken());

      assert.equal(tokenRequests.length, 0, "the facade must not exchange a moved login");
      assert.ok(err instanceof CodexOAuthLocalError, "a transient local error");
      assert.equal(err instanceof CodexOAuthRefreshError, false);
      assert.equal("upstreamStatus" in (err as object), false);
      assert.equal(fileHash(legacyPath), before, "the file is untouched");
      return;
    }
    case "facade-moved-during-exchange": {
      // A, the pre-save re-check: the account list stops naming the file while
      // the exchange is on the wire. The rotated token is not saved to it.
      seedConfig([]);
      await legacy.write(ref, token("during", Date.now() - 60_000));
      const { CodexOAuth, CodexOAuthLocalError } = await facade();
      const oauth = CodexOAuth.getInstance();
      const before = fileHash(legacyPath);
      onTokenRequest = () => {
        publishedMoveConfig();
        return rotatedResponse();
      };

      const err = await rejection(oauth.getAccessToken());

      assert.equal(tokenRequests.length, 1);
      assert.ok(err instanceof CodexOAuthLocalError, "a transient local error");
      assert.equal(fileHash(legacyPath), before, "a file no reader uses is not saved to");
      return;
    }
    case "facade-gone-after-failure": {
      // D (~558): the last read failed, the next finds the file gone because the
      // move published and deleted it. Transient, not the terminal login demand.
      seedConfig([]);
      writeFileSync(legacyPath, '{"access_token": "x", "refresh_tok', { mode: 0o600 });
      const { CodexOAuth, CodexOAuthLocalError, CodexOAuthRefreshError } = await facade();
      const oauth = CodexOAuth.getInstance();
      assert.equal(oauth.hasCredentials(), true, "a failed read still counts as configured");
      rmSync(legacyPath);
      publishedMoveConfig();

      const err = await rejection(oauth.getAccessToken());

      assert.ok(err instanceof CodexOAuthLocalError, "a transient local error");
      assert.equal(err instanceof CodexOAuthRefreshError, false);
      assert.equal(tokenRequests.length, 0);
      return;
    }
    case "facade-gone-logout": {
      // D (~558), the other branch: a genuine logout stays terminal.
      seedConfig([]);
      writeFileSync(legacyPath, '{"access_token": "x", "refresh_tok', { mode: 0o600 });
      const { CodexOAuth, CodexOAuthRefreshError } = await facade();
      const oauth = CodexOAuth.getInstance();
      rmSync(legacyPath);
      registry.invalidate();

      const err = await rejection(oauth.getAccessToken());

      assert.ok(err instanceof CodexOAuthRefreshError, "a logout is terminal");
      return;
    }
    case "facade-removed-during-exchange": {
      // D (~727): the move published and deleted the file during the exchange.
      seedConfig([]);
      await legacy.write(ref, token("removed", Date.now() - 60_000));
      const { CodexOAuth, CodexOAuthLocalError, CodexOAuthRefreshError } = await facade();
      const oauth = CodexOAuth.getInstance();
      onTokenRequest = () => {
        publishedMoveConfig();
        rmSync(legacyPath);
        return rotatedResponse();
      };

      const err = await rejection(oauth.getAccessToken());

      assert.equal(tokenRequests.length, 1);
      assert.ok(err instanceof CodexOAuthLocalError, "a transient local error");
      assert.equal(err instanceof CodexOAuthRefreshError, false);
      assert.equal(existsSync(legacyPath), false, "the file is not recreated");
      return;
    }
    case "m8-journal": {
      // C: M8 compares every durable field. A journal written to the file after
      // the copy changes neither fingerprint nor generation; the file is kept.
      seedConfig([row()]);
      const source = token("m8", Date.now() + 3_600_000);
      await legacy.write(ref, source);
      const management = new CodexAccountManagement({
        env,
        configPath: () => activeConfig,
        print: () => {},
        invalidate: () => registry.invalidate(),
        moveHooks: {
          beforeDelete: async () => {
            await legacy.write(ref, {
              ...source,
              journal: {
                state: "unknown",
                from: source.fingerprint,
                at: 1_780_000_100_000,
                pid: 4242,
                host: "test-host",
                nonce: "m8-journal-nonce",
              },
            });
          },
        },
      });

      const outcome = await management.moveLegacyLogin();

      assert.equal(outcome.kind, "moved");
      if (outcome.kind !== "moved") return;
      assert.equal(outcome.fileDeleted, false, "a file changed since the copy is kept");
      assert.equal(existsSync(legacyPath), true);
      return;
    }
    case "torn-detail": {
      // E: Bun's SyntaxError quotes the bytes it failed on.
      const fragment = "rtTornSecretFragment42";
      seedConfig([row()]);
      writeFileSync(legacyPath, `{"access_token": "x", "refresh_token": ${fragment}, "a": 1}`, {
        mode: 0o600,
      });
      const management = new CodexAccountManagement({
        env,
        configPath: () => activeConfig,
        print: () => {},
        invalidate: () => registry.invalidate(),
      });

      const outcome = await management.moveLegacyLogin();

      assert.equal(outcome.kind, "deferred");
      if (outcome.kind !== "deferred") return;
      assert.equal(outcome.reason, "file-unreadable");
      assert.equal(outcome.detail.includes(fragment), false, "detail must not quote file bytes");
      assert.equal(legacyMoveDeferredMessage(outcome, env).includes(fragment), false);
      assert.equal(fake.calls().length, 0);
      return;
    }
    case "alt-config-login": {
      // F: an alternate config on a Keychain platform logs in its synthesized
      // legacy target through THIS instance, never the facade's default deps.
      const altConfig = join(appHome, "alt.json");
      activeConfig = altConfig;
      seedConfig([], false, altConfig);
      await legacy.write(ref, token("shared", Date.now() + 3_600_000));
      const legacyBefore = fileHash(legacyPath);
      const defaultBefore = fileHash(defaultConfig);
      const printed: string[] = [];
      let pkceCalls = 0;
      let legacyLoginCalls = 0;
      const management = new CodexAccountManagement({
        env,
        configPath: () => altConfig,
        print: (line) => printed.push(line),
        invalidate: () => registry.invalidate(),
        confirm: async () => {
          throw new Error("unexpected interactive confirmation");
        },
        pkce: async () => {
          pkceCalls++;
          return pkceResult("alt");
        },
        legacyLogin: async () => {
          legacyLoginCalls++;
        },
      });

      const lines = await management.run({ verb: "login", selector: "default" });

      assert.equal(
        legacyLoginCalls,
        0,
        "the legacy facade login must not run on a Keychain platform"
      );
      assert.equal(pkceCalls, 1, "this instance's PKCE deps are used, once");
      const saved = JSON.parse(readFileSync(altConfig, "utf8")).subscriptionAccounts["openai-codex"]
        .accounts as Row[];
      assert.equal(saved.length, 1);
      assert.equal(saved[0]!.store, "keychain");
      assert.equal(saved[0]!.identity?.chatgptAccountId, "test-codex-identity");
      assert.equal(fileHash(legacyPath), legacyBefore, "the shared legacy file is never written");
      assert.equal(fileHash(defaultConfig), defaultBefore, "the default config is not touched");
      const results = [...lines, ...printed].filter((line) => /login saved|^Added /i.test(line));
      assert.equal(results.length, 1, "one result line");
      invalidateKeychainCache();
      const item = await keychain.read({ ...ref, id: saved[0]!.id }, { uncached: true });
      assert.ok(item);
      assert.equal(digest(item.refreshToken), digest("login-refresh-marker-alt"));
      return;
    }
    case "quota-keychain-row": {
      // G (0ef0da21): a Keychain row and no file is a configured Codex login.
      publishedMoveConfig();
      assert.equal(existsSync(legacyPath), false);
      const { codexQuotaAdapter } = await import("../quota/sources/codex.js");
      assert.equal(codexQuotaAdapter.isAvailable(), true);
      assert.equal(fake.calls().length, 0, "configuration only: no Keychain call");
      seedConfig([], true);
      assert.equal(codexQuotaAdapter.isAvailable(), false, "nothing configured is unavailable");
      return;
    }
    case "facade-keychain-login": {
      // G: `CodexOAuth.getInstance().login(pkceDeps)` on the Keychain branch.
      seedConfig([]);
      const { CodexOAuth } = await facade();
      const material = pkceResult("facade").credentials;
      let browserOpens = 0;
      const pkceDeps: CodexPkceDeps = {
        browser: async () => {
          browserOpens++;
        },
        callback: async (options) => {
          const redirectUri = `http://localhost:${options.port}/auth/callback`;
          await options.openBrowser(options.authorize(redirectUri));
          return { authCode: "isolated-test-auth-code", state: options.state, redirectUri };
        },
        fetch: Object.assign(
          async (input: Parameters<typeof fetch>[0]) => {
            const url = input instanceof Request ? input.url : String(input);
            assert.ok(env.CLAUDISH_TEST_UPSTREAM, "the harness configures its test upstream");
            assert.equal(url, new URL("/oauth/token", env.CLAUDISH_TEST_UPSTREAM).href);
            return Response.json({
              access_token: material.access_token,
              refresh_token: material.refresh_token,
              expires_in: 3600,
              token_type: "Bearer",
              id_token: idToken("test-codex-identity"),
            });
          },
          { preconnect: () => {} }
        ) as typeof fetch,
      };
      const logged: string[] = [];
      const original = console.log;
      console.log = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      };
      try {
        await CodexOAuth.getInstance().login(pkceDeps);
      } finally {
        console.log = original;
      }

      assert.equal(browserOpens, 1);
      assert.equal(existsSync(legacyPath), false, "the Keychain branch never writes the file");
      const saved = JSON.parse(readFileSync(defaultConfig, "utf8")).subscriptionAccounts[
        "openai-codex"
      ].accounts as Row[];
      assert.equal(saved.length, 1);
      assert.equal(saved[0]!.store, "keychain");
      assert.equal(saved[0]!.label, "default");
      invalidateKeychainCache();
      const item = await keychain.read({ ...ref, id: saved[0]!.id }, { uncached: true });
      assert.ok(item, "the login is a Keychain item");
      assert.equal(digest(item.accessToken), digest(material.access_token));
      assert.equal(digest(item.refreshToken), digest(material.refresh_token));
      assert.equal(item.fingerprint, fingerprintOf(material.refresh_token));
      assert.equal(fake.adds().length, 1);
      const joined = logged.join("\n");
      assert.equal(joined.includes(material.refresh_token), false, "no token on stdout");
      assert.equal(joined.includes(material.access_token), false, "no token on stdout");
      return;
    }
    default:
      throw new Error(`unknown scenario: ${scenario}`);
  }
}

const watchdog = setTimeout(() => process.exit(124), 22_000);
try {
  await run();
  fake.assertTranscript();
} finally {
  clearTimeout(watchdog);
}
