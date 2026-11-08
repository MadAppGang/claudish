/**
 * MTL-372 review round 4, R4-2: an exchange of the legacy file's token from a
 * stale account list.
 *
 * Another process ran the move to M6 (the Keychain row published, the config
 * now says `store: "keychain"`) and crashed before M8 deleted
 * `codex-oauth.json`. This process's registry still holds the pre-move list,
 * and `config.json` cannot be read just now, so the registry keeps serving that
 * last-known-good copy, which names `legacy-codex-file`. The token in the file
 * is expiring. `before-exchange` used to accept the stale row, write the
 * journal and exchange the file's refresh token: the token the Keychain copy
 * also holds, which the rotation kills.
 *
 * Now `before-exchange` re-reads the list for a `legacy-codex-file` row and,
 * when the read fails, answers transient 503 before any journal or exchange.
 *
 * Isolation: temp directory for config, state and locks; in-memory fake stores
 * that count writes; config reads fail through the registry's `readFile` seam;
 * the token endpoint is a test-scoped `fetch` stub. No Keychain, no real
 * ~/.claudish.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyAuthFailure } from "../../handlers/shared/auth-failure.js";
import { RefreshUnavailableError } from "./errors.js";
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
let failConfigRead = false;
let realFetch: typeof fetch;
let exchanged = 0;
/** Writes and deletes per store kind: the journal is a write too. */
let mutations: Record<string, number> = {};

function writeConfig(store: string, generation: number): void {
  writeFileSync(
    configPath,
    `${JSON.stringify({
      subscriptionAccounts: {
        "openai-codex": {
          generation,
          ...(store === "keychain" ? { legacyCodexSuppressed: true } : {}),
          accounts: [
            {
              id: ID,
              label: "default",
              store,
              identity: { chatgptAccountId: "acct-owner" },
              addedAt: "2026-09-12T00:00:00.000Z",
            },
          ],
        },
      },
    })}\n`,
    "utf8"
  );
}

/** The file's token: expiring, so a lease must exchange it. */
function expiringRecord(): StoredTokenRecord {
  return {
    accessToken: "access-shared",
    refreshToken: "refresh-shared",
    expiresAt: NOW - 1_000,
    generation: 1,
    fingerprint: fingerprintOf("refresh-shared"),
    accountId: "acct-owner",
    updatedAt: NOW - 3_600_000,
  };
}

/**
 * The store for `rowStore`. On the first read of the legacy file the other
 * process's M6 lands (config rewritten to the Keychain row) and the config
 * read starts failing, when `publishAndFail` is set.
 */
function poolWith(opts: { rowStore: string; publishAndFail: boolean }): AccountPool {
  return new AccountPool("openai-codex", {
    registry: new AccountRegistry({
      configPath: () => configPath,
      legacyCodexPath: () => join(dir, "codex-oauth.json"),
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
    state: new StateStore({
      path: join(dir, "state.json"),
      lockPath: join(dir, "state.lock"),
      now: () => NOW,
    }),
    now: () => NOW,
    env: { CLAUDISH_DISABLE_KEYCHAIN: "1", CLAUDISH_ACCOUNTS_DIR: join(dir, "accounts") },
    storeFactory: (record): TokenStore => ({
      kind: "file",
      read: async () => {
        if (opts.publishAndFail && record.store === opts.rowStore && !failConfigRead) {
          writeConfig("keychain", 2);
          failConfigRead = true;
        }
        return expiringRecord();
      },
      write: async () => {
        mutations[record.store] = (mutations[record.store] ?? 0) + 1;
      },
      delete: async () => {
        mutations[record.store] = (mutations[record.store] ?? 0) + 1;
      },
      describe: () => `isolated fake ${record.store} store`,
    }),
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
  expect(err).toBeInstanceOf(RefreshUnavailableError);
  const failure = classifyAuthFailure(err);
  expect(failure.kind).toBe("transient");
  expect(failure.kind === "transient" ? failure.status : undefined).toBe(503);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-pool-legacy-exchange-stale-"));
  configPath = join(dir, "config.json");
  failConfigRead = false;
  exchanged = 0;
  mutations = {};
  writeConfig("legacy-codex-file", 1);
  realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.endsWith("/oauth/token")) throw new Error(`unexpected fetch: ${url}`);
      exchanged++;
      return Response.json({
        access_token: "access-rotated",
        refresh_token: "refresh-rotated",
        expires_in: 3600,
        token_type: "Bearer",
      });
    },
    { preconnect: () => {} }
  ) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  failConfigRead = false;
  rmSync(dir, { recursive: true, force: true });
});

describe("a legacy file exchange while the list is stale and unreadable (R4-2)", () => {
  test("pinned: transient 503, no exchange, no journal, stores unchanged", async () => {
    const pool = poolWith({ rowStore: "legacy-codex-file", publishAndFail: true });

    const err = await thrownBy(pool.acquire({ pin: PIN }));

    expectTransient503(err);
    expect(exchanged).toBe(0);
    expect(mutations).toEqual({});
    // Mutation caught: before-exchange validated against the last-known-good
    // copy, saw the unchanged legacy-codex-file row, journaled and exchanged
    // the refresh token the published Keychain row also holds.
  });

  test("unpinned: transient 503, no exchange, no journal, stores unchanged", async () => {
    const pool = poolWith({ rowStore: "legacy-codex-file", publishAndFail: true });

    const err = await thrownBy(pool.acquire());

    expectTransient503(err);
    expect(exchanged).toBe(0);
    expect(mutations).toEqual({});
  });
});

describe("controls: what the fix must not change", () => {
  test("a legacy-codex-file row with a readable list still exchanges", async () => {
    const pool = poolWith({ rowStore: "legacy-codex-file", publishAndFail: false });

    const lease = await pool.acquire({ pin: PIN });

    expect(lease.accessToken).toBe("access-rotated");
    expect(exchanged).toBe(1);
  });

  test("a non-legacy row keeps exchanging from the last-known-good copy", async () => {
    writeConfig("file", 1);
    const pool = new AccountPool("openai-codex", {
      registry: new AccountRegistry({
        configPath: () => configPath,
        legacyCodexPath: () => join(dir, "codex-oauth.json"),
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
      state: new StateStore({
        path: join(dir, "state.json"),
        lockPath: join(dir, "state.lock"),
        now: () => NOW,
      }),
      now: () => NOW,
      env: { CLAUDISH_DISABLE_KEYCHAIN: "1", CLAUDISH_ACCOUNTS_DIR: join(dir, "accounts") },
      storeFactory: (): TokenStore => ({
        kind: "file",
        read: async () => {
          failConfigRead = true; // the list goes unreadable; nothing was published
          return expiringRecord();
        },
        write: async () => {},
        delete: async () => {},
        describe: () => "isolated fake file store",
      }),
    });

    const lease = await pool.acquire({ pin: PIN });

    expect(lease.accessToken).toBe("access-rotated");
    expect(exchanged).toBe(1);
    // Scope guard: only a legacy-codex-file exchange re-reads the list; a
    // short config outage must not stop every account's refresh.
  });
});
