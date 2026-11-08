/**
 * Isolated child for legacy-move-stale-list.test.ts (MTL-372, review round 2).
 *
 * The legacy facade deciding from a STALE account list: a warm registry whose
 * config read fails serves its last-known-good copy without throwing, so
 * "no exception" is not "fresh". Runs under a temp HOME handed in by the
 * parent, with the fake `security` installed and outbound `fetch` replaced
 * before any account module is imported. Never the real Keychain, never the
 * real ~/.claudish. The config read fails through the registry's `readFile`
 * seam.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const { LegacyCodexFileStore, fingerprintOf } = await import("./token-store.js");
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

/** While set, every read of config.json fails as an EACCES would. */
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

const fileHash = (path: string) =>
  existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;

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
function keychainRow(): Row {
  return {
    id: ref.id,
    label: ref.label,
    store: "keychain",
    enabled: true,
    identity: { chatgptAccountId: "test-codex-identity" },
    addedAt: "2026-01-02T03:04:05.000Z",
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
/** The published state the move leaves: a keychain row and the marker. */
function publishedMoveConfig(): void {
  seedConfig([keychainRow()], true);
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

/**
 * The facade loaded an expired legacy login, and the registry is WARM with the
 * pre-move list: the synthesized legacy account alone.
 */
async function warmPreMove(suffix: string, expiresAt = Date.now() - 60_000) {
  seedConfig([]);
  await legacy.write(ref, token(suffix, expiresAt));
  const mod = await facade();
  const oauth = mod.CodexOAuth.getInstance();
  assert.equal(oauth.hasCredentials(), true, "the facade loaded the file before the move");
  assert.equal(registry.isSynthesizedLegacyOnly(), true, "the registry holds the pre-move list");
  return { ...mod, oauth };
}

/** The config read now fails, and the registry answers from the stale copy WITHOUT throwing. */
function assertServedStale(): void {
  registry.invalidate();
  const snapshot = registry.snapshot("openai-codex");
  assert.equal(snapshot.config.state, "failed");
  assert.equal(snapshot.config.servingLastKnownGood, true);
}

async function run(): Promise<void> {
  switch (scenario) {
    case "file-left-list-unreadable": {
      // HIGH 1: the move published (keychain row + marker) and stopped before
      // M8, so the file is still there; the next config read fails. The stale
      // pre-move copy says "synthesized only": trusting it exchanges the
      // refresh token the Keychain item also holds, revoking it.
      const { oauth, CodexOAuthLocalError, CodexOAuthRefreshError } = await warmPreMove("left");
      publishedMoveConfig();
      failConfigRead = true;
      const before = fileHash(legacyPath);
      onTokenRequest = rotatedResponse;

      const err = await rejection(oauth.getAccessToken());

      assert.equal(tokenRequests.length, 0, "no exchange on a stale account list");
      assert.ok(err instanceof CodexOAuthLocalError, "a transient local error");
      assert.equal(err instanceof CodexOAuthRefreshError, false);
      assert.equal("upstreamStatus" in (err as object), false);
      assert.equal(fileHash(legacyPath), before, "the file is untouched");
      assertServedStale();
      return;
    }
    case "file-gone-list-unreadable": {
      // HIGH 2a: the move published and deleted the file; the next config read
      // fails. The stale pre-move copy has no configured row, and with the file
      // gone no synthesized one either: "no accounts" is unproven, not a logout.
      const { oauth, CodexOAuthLocalError, CodexOAuthRefreshError } = await warmPreMove("gone");
      publishedMoveConfig();
      rmSync(legacyPath);
      failConfigRead = true;

      const err = await rejection(oauth.getAccessToken());

      assert.ok(err instanceof CodexOAuthLocalError, "a transient local error");
      assert.equal(err instanceof CodexOAuthRefreshError, false, "not the terminal login demand");
      assert.equal(tokenRequests.length, 0);
      assertServedStale();
      return;
    }
    case "file-gone-logout-warm": {
      // Control for 2a: the list reads fine and names nothing: a real logout.
      const { oauth, CodexOAuthRefreshError } = await warmPreMove("logout");
      rmSync(legacyPath);

      const err = await rejection(oauth.getAccessToken());

      assert.ok(err instanceof CodexOAuthRefreshError, "a logout is terminal");
      return;
    }
    case "file-present-list-readable": {
      // Control for 1: a readable synthesized-only list still lets the facade refresh.
      const { oauth } = await warmPreMove("own");
      onTokenRequest = rotatedResponse;

      const access = await oauth.getAccessToken();

      assert.equal(tokenRequests.length, 1);
      assert.equal(access, "rotated-access-marker");
      const saved = await legacy.read(ref, { uncached: true });
      assert.equal(saved?.refreshToken, "rotated-refresh-marker", "the rotation is saved");
      return;
    }
    case "list-unreadable-after-exchange-saves": {
      // Control for 1: the post-exchange rule is unchanged. After the vendor
      // rotated, an unreadable list keeps the save: the file is the rotated
      // token's only home.
      const { oauth } = await warmPreMove("after");
      onTokenRequest = () => {
        seedConfig([]);
        failConfigRead = true;
        return rotatedResponse();
      };

      const access = await oauth.getAccessToken();

      assert.equal(tokenRequests.length, 1);
      assert.equal(access, "rotated-access-marker");
      const saved = await legacy.read(ref, { uncached: true });
      assert.equal(saved?.refreshToken, "rotated-refresh-marker", "the rotation is saved");
      return;
    }
    case "forced-refresh-leftover-no-adopt": {
      // G2 (a, c): the facade holds a still-valid bearer; another process
      // rotated the file; then the move published and left the file behind.
      // The 401 re-sign (a forced refresh) must neither adopt the dead file's
      // token nor keep signing with the in-memory one.
      const { oauth, CodexOAuthLocalError } = await warmPreMove("mem", Date.now() + 3_600_000);
      assert.equal(await oauth.getAccessToken(), "legacy-access-marker-mem");
      await legacy.write(ref, token("disk", Date.now() + 3_600_000));
      publishedMoveConfig();

      const err = await rejection(oauth.forceRefresh());

      assert.ok(err instanceof CodexOAuthLocalError, "transient, not an adopted token");
      assert.equal(tokenRequests.length, 0);
      const next = await rejection(oauth.getAccessToken());
      assert.ok(next instanceof CodexOAuthLocalError, "the old in-memory bearer is not used");
      return;
    }
    case "gate-unavailable-leftover-no-adopt": {
      // G2 (b): the same leftover, with the refresh gate unavailable. The
      // catch path adopted any fresh file token without asking whose it is.
      const { oauth, CodexOAuthLocalError } = await warmPreMove("mem", Date.now() + 3_600_000);
      assert.equal(await oauth.getAccessToken(), "legacy-access-marker-mem");
      await legacy.write(ref, token("disk", Date.now() + 3_600_000));
      publishedMoveConfig();
      const blocked = join(home, "gate-blocked");
      writeFileSync(blocked, "not a directory");
      oauth._setRefreshGateOptionsForTests({ path: join(blocked, "held.lock") });

      const err = await rejection(oauth.forceRefresh());

      assert.ok(err instanceof CodexOAuthLocalError, "the unwritable-gate error, no adoption");
      assert.equal(tokenRequests.length, 0);
      return;
    }
    case "forced-refresh-logout-drops-bearer": {
      // G2 (c), `!onDisk`: a logout deleted the file while this process held a
      // valid bearer. After the terminal answer the bearer stops signing.
      const { oauth, CodexOAuthRefreshError } = await warmPreMove("mem", Date.now() + 3_600_000);
      assert.equal(await oauth.getAccessToken(), "legacy-access-marker-mem");
      rmSync(legacyPath);

      const err = await rejection(oauth.forceRefresh());
      assert.ok(err instanceof CodexOAuthRefreshError, "a logout is terminal");

      const next = await rejection(oauth.getAccessToken());
      assert.ok(next instanceof CodexOAuthRefreshError, "the old bearer is not used");
      return;
    }
    case "forced-refresh-unreadable-keeps-bearer": {
      // Control for G2 (c): an unreadable list is not a logout; the in-memory
      // bearer is kept and the refresh answers transient.
      const { oauth, CodexOAuthLocalError } = await warmPreMove("mem", Date.now() + 3_600_000);
      assert.equal(await oauth.getAccessToken(), "legacy-access-marker-mem");
      publishedMoveConfig();
      failConfigRead = true;

      const err = await rejection(oauth.forceRefresh());
      assert.ok(err instanceof CodexOAuthLocalError);
      assert.equal(tokenRequests.length, 0);

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
