/**
 * MTL-372 review round 3: the pool's empty-store answer while the account
 * list cannot be read.
 *
 * R3-2: `AccountListUnreadableDuringLeaseError` tried no credential, yet the
 * lease's re-auth stamp stayed. A later request then read a DUE `needsReauth`
 * retry as "attempted just now" and answered the terminal NeedsReauthError.
 *
 * R3-3: the registry re-reads `config.json` only on a stat-stamp change, so a
 * read that fails on an UNCHANGED file (`chmod 000`, EMFILE) kept reporting
 * "present", and the empty store answered NeedsReauthError.
 *
 * Isolation: temp directory for config, state and locks; in-memory fake
 * stores; config reads fail through the registry's `readFile` seam; the token
 * endpoint is a test-scoped `fetch` stub. No Keychain, no real ~/.claudish.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NeedsReauthError, RefreshUnavailableError } from "./errors.js";
import { AccountPool } from "./pool.js";
import { AccountRegistry } from "./registry.js";
import { StateStore } from "./state-store.js";
import { type StoredTokenRecord, type TokenStore, fingerprintOf } from "./token-store.js";
import type { AccountRef } from "./types.js";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const ID = "4463fa7e5c82";
const REF: AccountRef = { provider: "openai-codex", id: ID, label: "default" };

let dir = "";
let configPath = "";
let state: StateStore;
let failConfigRead = false;
let realFetch: typeof fetch;
let exchanged = 0;

function writeConfig(generation: number): void {
  writeFileSync(
    configPath,
    `${JSON.stringify({
      subscriptionAccounts: {
        "openai-codex": {
          generation,
          accounts: [
            {
              id: ID,
              label: "default",
              store: "file",
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

/** The material the mark failed against: generation 1, same fingerprint. */
function sameMaterial(): StoredTokenRecord {
  return {
    accessToken: "access-owner",
    refreshToken: "refresh-owner",
    expiresAt: NOW + 3_600_000,
    generation: 1,
    fingerprint: fingerprintOf("refresh-owner"),
    accountId: "acct-owner",
    updatedAt: NOW,
  };
}

function poolWith(read: () => StoredTokenRecord | null): AccountPool {
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
    state,
    now: () => NOW,
    env: { CLAUDISH_DISABLE_KEYCHAIN: "1", CLAUDISH_ACCOUNTS_DIR: join(dir, "accounts") },
    storeFactory: (): TokenStore => ({
      kind: "file",
      read: async () => read(),
      write: async () => {},
      delete: async () => {},
      describe: () => "isolated fake store",
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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "claudish-pool-unreadable-reauth-"));
  configPath = join(dir, "config.json");
  failConfigRead = false;
  exchanged = 0;
  state = new StateStore({
    path: join(dir, "state.json"),
    lockPath: join(dir, "state.lock"),
    now: () => NOW,
  });
  writeConfig(1);
  realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.endsWith("/oauth/token")) throw new Error(`unexpected fetch: ${url}`);
      exchanged++;
      return Response.json({
        access_token: "access-exchanged",
        refresh_token: "refresh-exchanged",
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

describe("an unreadable list is not a re-auth attempt (R3-2)", () => {
  async function dueMark(): Promise<void> {
    await state.setNeedsReauth(REF, {
      since: NOW - 10 * 60_000, // due: 60 s after one attempt
      attempts: 1,
      lastReason: "invalid_grant",
      failedGeneration: 1,
      failedFingerprint: fingerprintOf("refresh-owner"),
    });
  }

  /** Phase 1: every store read is empty and the config read fails (a changed file). */
  function twoPhasePool() {
    let phase: 1 | 2 = 1;
    const pool = poolWith(() => {
      if (phase === 1) {
        writeConfig(2); // a changed stamp: independent of R3-3's invalidate
        failConfigRead = true;
        return null;
      }
      return sameMaterial();
    });
    return {
      pool,
      recover: () => {
        phase = 2;
        failConfigRead = false;
      },
    };
  }

  test("unpinned: the next request still gets its due exchange", async () => {
    await dueMark();
    const { pool, recover } = twoPhasePool();

    const first = await thrownBy(pool.acquire());
    expect(first).toBeInstanceOf(RefreshUnavailableError);

    recover();
    const next = await pool.acquire();

    expect(next.accessToken).toBe("access-exchanged");
    expect(exchanged).toBe(1);
    // Mutation caught: tryLease records the 503 and leaseStep keeps the stamp;
    // the next request reads the due retry as "attempted just now" and answers
    // NeedsReauthError.
  });

  test("pinned: the next request still gets its due exchange", async () => {
    await dueMark();
    const { pool, recover } = twoPhasePool();

    const first = await thrownBy(pool.acquire({ pin: REF }));
    expect(first).toBeInstanceOf(RefreshUnavailableError);

    recover();
    const next = await pool.acquire();

    expect(next.accessToken).toBe("access-exchanged");
    expect(exchanged).toBe(1);
    // Mutation caught: the pinned rethrow skips the restore.
  });
});

describe("an unchanged config file whose read fails (R3-3)", () => {
  test("an empty store answers transient, not NeedsReauthError", async () => {
    // The file is NOT rewritten: only the read fails, as chmod 000 or EMFILE would.
    const pool = poolWith(() => {
      failConfigRead = true;
      return null;
    });

    const err = await thrownBy(pool.acquire({ pin: REF }));

    expect(err).not.toBeInstanceOf(NeedsReauthError);
    expect(err).toBeInstanceOf(RefreshUnavailableError);
    // Mutation caught: no invalidate before the store-empty snapshot, so the
    // unchanged stamp keeps "present" and the pin gets NeedsReauthError.
  });

  test("control: a readable unchanged config and an empty store still need a login", async () => {
    const pool = poolWith(() => null);

    const err = await thrownBy(pool.acquire({ pin: REF }));

    expect(err).toBeInstanceOf(NeedsReauthError);
  });
});
