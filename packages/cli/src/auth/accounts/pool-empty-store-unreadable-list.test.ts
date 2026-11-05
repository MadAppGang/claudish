/**
 * A pool lease whose store is EMPTY while the account list cannot be read
 * (MTL-372, review round 2, HIGH 2b).
 *
 * `AccountRegistry.snapshot()` throws only when a source read failed and there
 * is no last-known-good copy. A warm registry serves the copy and reports the
 * failure only in `snapshot.config.state`. That copy can predate the legacy
 * file move, so it still shows the `legacy-codex-file` row the move rebound:
 * the binding looks unchanged, and the empty-store branch used to answer the
 * terminal `NeedsReauthError` (401), which walks a bare chain onto a metered
 * hop. Unknown is not "needs a login": the answer must be transient 503.
 *
 * Isolation: a temp directory for config, state and lock; the token store is
 * an in-memory fake; the config read fails through the registry's `readFile`
 * seam. No Keychain, no real ~/.claudish, no network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyAuthFailure } from "../../handlers/shared/auth-failure.js";
import { NeedsReauthError, RefreshUnavailableError } from "./errors.js";
import { AccountPool } from "./pool.js";
import { AccountRegistry } from "./registry.js";
import { StateStore } from "./state-store.js";
import { type StoredTokenRecord, type TokenStore, fingerprintOf } from "./token-store.js";
import type { AccountRef } from "./types.js";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const ID = "4463fa7e5c82";
const PIN: AccountRef = { provider: "openai-codex", id: ID, label: "default" };

let dir = "";
let configPath = "";
let legacyPath = "";
let statePath = "";
let lockPath = "";
/** While set, every read of config.json fails as an EACCES would. */
let failConfigRead = false;

function writeConfig(rows: Array<Record<string, unknown>>, generation: number): void {
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        version: "1.0.0",
        defaultProfile: "default",
        profiles: {},
        subscriptionAccounts: { "openai-codex": { generation, accounts: rows } },
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function row(store: string): Record<string, unknown> {
  return {
    id: ID,
    label: "default",
    store,
    identity: { chatgptAccountId: "acct-owner" },
    addedAt: "2026-09-12T00:00:00.000Z",
  };
}

function freshRecord(): StoredTokenRecord {
  return {
    accessToken: "access-legacy",
    refreshToken: "refresh-legacy",
    expiresAt: NOW + 3_600_000,
    generation: 1,
    fingerprint: fingerprintOf("refresh-legacy"),
    accountId: "acct-owner",
    updatedAt: NOW,
  };
}

function poolWith(read: (record: { store: string }) => Promise<StoredTokenRecord | null>) {
  return new AccountPool("openai-codex", {
    registry: new AccountRegistry({
      configPath: () => configPath,
      legacyCodexPath: () => legacyPath,
      env: { CLAUDISH_DISABLE_KEYCHAIN: "1" },
      readFile: (path) => {
        if (failConfigRead && path === configPath) {
          throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), {
            code: "EACCES",
          });
        }
        return readFileSync(path, "utf-8");
      },
    }),
    state: new StateStore({ path: statePath, lockPath, now: () => NOW }),
    now: () => NOW,
    env: { CLAUDISH_DISABLE_KEYCHAIN: "1", CLAUDISH_ACCOUNTS_DIR: join(dir, "accounts") },
    storeFactory: (record): TokenStore => ({
      kind: "file",
      read: () => read(record),
      write: async () => {},
      delete: async () => {},
      describe: () => `isolated fake ${record.store} store`,
    }),
  });
}

/**
 * The legacy file vanished (the move published and deleted it) and the
 * config read now fails: the registry serves its pre-move copy.
 */
function vanishedWhileListUnreadable() {
  return poolWith(async (record) => {
    if (record.store === "legacy-codex-file") {
      writeConfig([row("keychain")], 2);
      failConfigRead = true;
      return null;
    }
    return freshRecord();
  });
}

async function thrownBy(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (err) {
    return err;
  }
  throw new Error("expected the acquire to throw");
}

function expectTransient503(err: unknown): void {
  expect(err).not.toBeInstanceOf(NeedsReauthError);
  expect(err).toBeInstanceOf(RefreshUnavailableError);
  const failure = classifyAuthFailure(err);
  expect(failure.kind).toBe("transient");
  expect(failure.kind === "transient" ? failure.status : undefined).toBe(503);
  expect((err as { terminal?: boolean }).terminal).toBe(false);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-pool-empty-store-unreadable-"));
  configPath = join(dir, "config.json");
  legacyPath = join(dir, "codex-oauth.json");
  statePath = join(dir, "state.json");
  lockPath = join(dir, "state.lock");
  failConfigRead = false;
  writeConfig([row("legacy-codex-file")], 1);
});

afterEach(() => {
  failConfigRead = false;
  rmSync(dir, { recursive: true, force: true });
});

describe("empty store while the account list cannot be read (HIGH 2b)", () => {
  test("a PINNED lease is transient 503, not NeedsReauthError", async () => {
    const pool = vanishedWhileListUnreadable();

    const err = await thrownBy(pool.acquire({ pin: PIN }));

    expectTransient503(err);
    // Mutation caught: the empty-store branch validates against the
    // last-known-good copy, sees the unchanged legacy-codex-file row and
    // throws the terminal NeedsReauthError (401).
  });

  test("an UNPINNED lease is transient 503, not NeedsReauthError", async () => {
    const pool = vanishedWhileListUnreadable();

    const err = await thrownBy(pool.acquire());

    expectTransient503(err);
    // Mutation caught: same as above; the pool then reports every account as
    // needing a browser login.
  });

  test("once the list reads again, the same id leases from its Keychain store", async () => {
    const pool = vanishedWhileListUnreadable();
    await thrownBy(pool.acquire({ pin: PIN }));

    failConfigRead = false;
    const retry = await pool.acquire({ pin: PIN });

    expect(retry.account.id).toBe(ID);
    expect(retry.accessToken).toBe("access-legacy");
  });
});

describe("controls: what the fix must not change", () => {
  test("config readable, row unchanged, store empty: still NeedsReauthError (pinned)", async () => {
    const pool = poolWith(async () => null);

    const err = await thrownBy(pool.acquire({ pin: PIN }));

    expect(err).toBeInstanceOf(NeedsReauthError);
    expect(classifyAuthFailure(err).kind).toBe("terminal");
    // Mutation caught: every empty store answered transient, so a genuine
    // missing login retries the same hop forever.
  });

  test("config readable, row unchanged, store empty: still NeedsReauthError (unpinned)", async () => {
    const pool = poolWith(async () => null);

    const err = await thrownBy(pool.acquire());

    expect(err).toBeInstanceOf(NeedsReauthError);
  });

  test("an unreadable list with material in the store still leases from the last-known-good copy", async () => {
    const pool = poolWith(async () => {
      writeConfig([row("legacy-codex-file")], 2);
      failConfigRead = true;
      return freshRecord();
    });

    const lease = await pool.acquire({ pin: PIN });

    expect(lease.account.id).toBe(ID);
    expect(lease.accessToken).toBe("access-legacy");
    // Scope guard: a failed config read is "unknown" only for an EMPTY store.
    // Selection and the post-lease check keep serving the last-known-good
    // copy; refusing there would turn a short config outage into a Codex one.
  });
});
