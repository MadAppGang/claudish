/**
 * Isolated child for legacy-move-facade-drop.test.ts (MTL-372, review round 3:
 * R3-4 and R3-5). Same isolation as legacy-move-stale-list-worker: a temp HOME
 * from the parent, the fake `security` installed and outbound `fetch` refused
 * before any account module loads, the config read failed through the
 * registry's `readFile` seam. Never the real Keychain or ~/.claudish.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

const { setKeychainTestDeps } = await import("../../providers/keychain.js");
setKeychainTestDeps(fake.deps("darwin"));
delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
delete process.env.CLAUDISH_ACCOUNT_STORE;
delete process.env.CLAUDISH_KEYCHAIN_FILE;

/** No token exchange is expected in any scenario here. */
const tokenRequests: string[] = [];
globalThis.fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0]) => {
    tokenRequests.push(input instanceof Request ? input.url : String(input));
    throw new Error("no network request is expected in this scenario");
  },
  { preconnect: () => {} }
) as typeof fetch;

const { LegacyCodexFileStore, fingerprintOf } = await import("./token-store.js");
const { AccountRegistry, setAccountRegistryForTests } = await import("./registry.js");
const { MeteredEscapeError } = await import("./errors.js");
const { legacyCodexCredentialsPath } = await import("./paths.js");

const env = process.env;
const appHome = join(home, ".claudish");
const configPath = join(appHome, "config.json");
const legacyPath = legacyCodexCredentialsPath(env);
mkdirSync(appHome, { recursive: true, mode: 0o700 });
mkdirSync(env.CLAUDISH_ACCOUNTS_DIR!, { recursive: true, mode: 0o700 });
const ref: AccountRef = { provider: "openai-codex", id: "aaaaaaaaaaaa", label: "default" };
const legacy = new LegacyCodexFileStore({ env, path: legacyPath });

let failConfigRead = false;
const registry = new AccountRegistry({
  env,
  configPath: () => configPath,
  legacyCodexPath: () => legacyPath,
  readFile: (path) => {
    if (failConfigRead && path === configPath) {
      throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), {
        code: "EACCES",
      });
    }
    return readFileSync(path, "utf-8");
  },
});
setAccountRegistryForTests(registry);

function seedConfig(rows: Row[] = [], marker = false): void {
  const config = {
    subscriptionAccounts: {
      "openai-codex": {
        generation: 1,
        accounts: rows,
        ...(marker ? { legacyCodexSuppressed: true } : {}),
      },
    },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  registry.invalidate();
}
function publishedMoveConfig(): void {
  seedConfig(
    [
      {
        id: ref.id,
        label: ref.label,
        store: "keychain",
        enabled: true,
        identity: { chatgptAccountId: "test-codex-identity" },
        addedAt: "2026-01-02T03:04:05.000Z",
      },
    ],
    true
  );
}
function token(suffix: string): StoredTokenRecord {
  const refreshToken = `legacy-refresh-marker-${suffix}`;
  return {
    accessToken: `legacy-access-marker-${suffix}`,
    refreshToken,
    expiresAt: Date.now() + 3_600_000,
    accountId: "test-codex-identity",
    generation: 3,
    fingerprint: fingerprintOf(refreshToken),
    updatedAt: 1_780_000_000_000,
  };
}
async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

/** A facade holding a valid bearer, with the registry warm on the pre-move list. */
async function signingFacade() {
  seedConfig([]);
  await legacy.write(ref, token("mem"));
  const mod = await import("../codex-oauth.js");
  mod.CodexOAuth._resetInstanceForTests();
  const oauth = mod.CodexOAuth.getInstance();
  assert.equal(await oauth.getAccessToken(), "legacy-access-marker-mem");
  assert.equal(registry.isSynthesizedLegacyOnly(), true);
  const { CodexOAuthHalf } = await import("../credentials/codex-credential.js");
  return { ...mod, oauth, half: new CodexOAuthHalf() };
}

/** The move published and left the file behind; another process rotated it. */
async function leftoverAfterMove(): Promise<void> {
  await legacy.write(ref, token("disk"));
  publishedMoveConfig();
}

function unwritableGate(oauth: { _setRefreshGateOptionsForTests: (o: { path: string }) => void }) {
  const blocked = join(home, "gate-blocked");
  writeFileSync(blocked, "not a directory");
  oauth._setRefreshGateOptionsForTests({ path: join(blocked, "held.lock") });
}

async function run(): Promise<void> {
  switch (scenario) {
    case "require-oauth-after-move-drop": {
      // R3-4: the facade dropped its token because the move published; a
      // request latched to OAuth then re-enters the legacy half.
      const { oauth, half, CodexOAuthLocalError } = await signingFacade();
      await leftoverAfterMove();
      await rejection(oauth.forceRefresh());
      assert.equal(oauth.hasCredentials(), false, "the move dropped the in-memory token");

      const err = await rejection(half.getRequestAuth({ model: "gpt-test", requireOAuth: true }));

      assert.ok(err instanceof CodexOAuthLocalError, "transient, retried on the same hop");
      assert.equal(err instanceof MeteredEscapeError, false);
      return;
    }
    case "require-oauth-after-move-drop-list-unreadable": {
      // R3-4 with the stale snapshot: the config read fails after the drop.
      const { oauth, half, CodexOAuthLocalError } = await signingFacade();
      await leftoverAfterMove();
      await rejection(oauth.forceRefresh());
      failConfigRead = true;

      const err = await rejection(half.getRequestAuth({ model: "gpt-test", requireOAuth: true }));

      assert.ok(err instanceof CodexOAuthLocalError, "an unreadable list is transient");
      return;
    }
    case "require-oauth-genuine-logout": {
      // Control for R3-4: a readable list, no rows, the file gone.
      const { oauth, half, CodexOAuthRefreshError } = await signingFacade();
      rmSync(legacyPath);
      const refresh = await rejection(oauth.forceRefresh());
      assert.ok(refresh instanceof CodexOAuthRefreshError);

      const err = await rejection(half.getRequestAuth({ model: "gpt-test", requireOAuth: true }));

      assert.ok(err instanceof MeteredEscapeError, "a genuine logout stays terminal");
      return;
    }
    case "gate-unavailable-move-drops-bearer": {
      // R3-5: gate unavailable, ownership "elsewhere": the old bearer stops signing.
      const { oauth, CodexOAuthLocalError } = await signingFacade();
      await leftoverAfterMove();
      unwritableGate(oauth);

      await rejection(oauth.forceRefresh());
      const next = await rejection(oauth.getAccessToken());

      assert.ok(next instanceof CodexOAuthLocalError, "the old bearer is not used");
      assert.equal(tokenRequests.length, 0);
      return;
    }
    case "gate-unavailable-logout-drops-bearer": {
      // R3-5: gate unavailable, the file gone and the list readable: a logout.
      const { oauth, CodexOAuthRefreshError } = await signingFacade();
      rmSync(legacyPath);
      unwritableGate(oauth);

      await rejection(oauth.forceRefresh());
      const next = await rejection(oauth.getAccessToken());

      assert.ok(next instanceof CodexOAuthRefreshError, "the old bearer is not used");
      return;
    }
    case "gate-unavailable-unreadable-keeps-bearer": {
      // Control for R3-5: ownership "unknown" keeps the in-memory bearer.
      const { oauth } = await signingFacade();
      await leftoverAfterMove();
      failConfigRead = true;
      unwritableGate(oauth);

      await rejection(oauth.forceRefresh());

      assert.equal(await oauth.getAccessToken(), "legacy-access-marker-mem");
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
