/**
 * Isolated child for legacy-move-resume-journal.test.ts (MTL-372 review round).
 *
 * Runs under a temp HOME handed in by the parent, with the fake `security`
 * installed before any account module is imported. Never the real Keychain,
 * never the real ~/.claudish.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeSecurity } from "./fake-security.test-helper.js";
import type { StoredTokenRecord, TokenJournal } from "./token-store.js";
import type { AccountRef, SubscriptionAccountsEntry } from "./types.js";

type Row = SubscriptionAccountsEntry["accounts"][number];

const scenario = process.argv[2]!;
const home = process.env.HOME!;
assert.ok(home && home !== "/", "a dedicated temp HOME is mandatory");
assert.equal(process.env.CLAUDISH_DISABLE_KEYCHAIN, "1", "child must boot with Keychain disabled");
assert.equal(process.env.CLAUDISH_ACCOUNTS_DIR, join(home, ".claudish", "accounts"));
const fake = new FakeSecurity(home);

// Every side-effect seam goes in before any account API is imported.
const { setKeychainTestDeps, invalidateKeychainCache } = await import(
  "../../providers/keychain.js"
);
setKeychainTestDeps(fake.deps("darwin"));
delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
delete process.env.CLAUDISH_ACCOUNT_STORE;
delete process.env.CLAUDISH_KEYCHAIN_FILE;
globalThis.fetch = Object.assign(
  async () => {
    throw new Error("outbound network is forbidden in legacy-move tests");
  },
  { preconnect: () => {} }
) as typeof fetch;

const { CodexAccountManagement } = await import("./management.js");
const { LegacyCodexFileStore, KeychainTokenStore, fingerprintOf } = await import(
  "./token-store.js"
);
const { AccountRegistry, setAccountRegistryForTests } = await import("./registry.js");
const { legacyCodexCredentialsPath } = await import("./paths.js");

const env = process.env;
const appHome = join(home, ".claudish");
const configPath = join(appHome, "config.json");
const legacyPath = legacyCodexCredentialsPath(env);
mkdirSync(appHome, { recursive: true, mode: 0o700 });
mkdirSync(env.CLAUDISH_ACCOUNTS_DIR!, { recursive: true, mode: 0o700 });
const ref: AccountRef = { provider: "openai-codex", id: "aaaaaaaaaaaa", label: "default" };
const legacy = new LegacyCodexFileStore({ env, path: legacyPath });
const keychain = new KeychainTokenStore({ env });
const registry = new AccountRegistry({
  env,
  configPath: () => configPath,
  legacyCodexPath: () => legacyPath,
});
setAccountRegistryForTests(registry);
const management = (moveHooks?: { beforePublish?: () => void }) =>
  new CodexAccountManagement({
    env,
    configPath: () => configPath,
    print: () => {},
    confirm: async () => {
      throw new Error("unexpected interactive confirmation");
    },
    pkce: async () => {
      throw new Error("unexpected PKCE call");
    },
    invalidate: () => registry.invalidate(),
    ...(moveHooks ? { moveHooks } : {}),
  });

const row: Row = {
  id: ref.id,
  label: ref.label,
  store: "legacy-codex-file",
  enabled: true,
  identity: { chatgptAccountId: "test-codex-identity" },
  addedAt: "2026-01-02T03:04:05.000Z",
};
writeFileSync(
  configPath,
  `${JSON.stringify({ subscriptionAccounts: { "openai-codex": { generation: 1, accounts: [row] } } }, null, 2)}\n`,
  { mode: 0o600 }
);
registry.invalidate();

const refreshToken = "legacy-refresh-marker-original";
const source: StoredTokenRecord = {
  accessToken: "legacy-access-marker-original",
  refreshToken,
  expiresAt: Date.now() + 86_400_000,
  accountId: "test-codex-identity",
  generation: 7,
  fingerprint: fingerprintOf(refreshToken),
  updatedAt: 1_780_000_000_000,
};
await legacy.write(ref, source);

async function destination(): Promise<StoredTokenRecord> {
  invalidateKeychainCache();
  const stored = await keychain.read(ref, { uncached: true });
  assert.ok(stored, "the Keychain item must exist");
  return stored;
}

// Attempt 1: writes and verifies the item, then stops before M6 (the config
// lock was busy, or the process stopped).
const injectedStop = new Error("simulated stop before publication");
try {
  await management({
    beforePublish: () => {
      throw injectedStop;
    },
  }).moveLegacyLogin();
} catch (error) {
  assert.equal(error, injectedStop, "only the injected stop may escape");
}
registry.invalidate();
assert.equal(existsSync(legacyPath), true, "attempt 1 must not delete the file");
assert.equal(fake.adds().length, 1, "attempt 1 wrote the item once");
const unpublished = await destination();
assert.equal(unpublished.journal ?? null, null, "attempt 1's item carries no journal");

// Between the attempts, the still-authoritative file changes WITHOUT a new
// generation or fingerprint.
const journal: TokenJournal = {
  state: "unknown",
  from: source.fingerprint,
  at: 1_780_000_100_000,
  pid: 4242,
  host: "test-host",
  nonce: "journal-nonce-marker",
};
const changed: StoredTokenRecord =
  scenario === "journal"
    ? { ...source, journal }
    : scenario === "access-token"
      ? { ...source, accessToken: "legacy-access-marker-reissued" }
      : scenario === "expires-at"
        ? { ...source, expiresAt: source.expiresAt + 60_000 }
        : (() => {
            throw new Error(`unknown scenario ${scenario}`);
          })();
await legacy.write(ref, changed);
const authoritative = await legacy.read(ref, { uncached: true });
assert.ok(authoritative);
assert.equal(authoritative.generation, unpublished.generation, "same generation by construction");
assert.equal(
  authoritative.fingerprint,
  unpublished.fingerprint,
  "same fingerprint by construction"
);

// Attempt 2 publishes, and must carry the CURRENT file, not attempt 1's item.
const outcome = await management().moveLegacyLogin();
assert.equal(outcome.kind, "moved");
const published = await destination();
assert.equal(published.accessToken === authoritative.accessToken, true, "access token is stale");
assert.equal(published.refreshToken === authoritative.refreshToken, true, "refresh token differs");
assert.equal(published.expiresAt, authoritative.expiresAt, "expiresAt is stale");
assert.equal(published.generation, authoritative.generation);
assert.equal(published.fingerprint, authoritative.fingerprint);
assert.deepEqual(published.journal ?? null, authoritative.journal ?? null, "journal was dropped");
assert.equal(fake.adds().length, 2, "attempt 2 must rewrite the stale item");
assert.equal(existsSync(legacyPath), false);
fake.assertTranscript();
