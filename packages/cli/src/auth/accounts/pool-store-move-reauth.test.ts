/**
 * A store-only move (the legacy Codex file move, MTL-372) on an account with a
 * `needsReauth` mark (review round 2, Gemini G1).
 *
 * `acquire` stamps a lease as the row's re-auth attempt before it leases. A
 * store-only move during that lease tried no credential, yet the stamp stayed:
 * a DUE retry then read "attempted just now" on the next pass, the rebound
 * Keychain row was blocked as needs-reauth, and a single-account pool answered
 * a terminal NeedsReauthError (401), which walks a bare chain onto a metered
 * hop. And when the move landed between `healReauthMarks`' list read and its
 * store read, the old store read empty and the mark was never healed against
 * the new store.
 *
 * Isolation: temp directory for config, state and locks; in-memory fake token
 * stores. No Keychain, no real ~/.claudish, no network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyAuthFailure } from "../../handlers/shared/auth-failure.js";
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

function writeConfig(store: string, generation: number): void {
  writeFileSync(
    configPath,
    `${JSON.stringify({
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      subscriptionAccounts: {
        "openai-codex": {
          generation,
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

/** Generation 1 is the material the mark failed against. */
function material(generation: number): StoredTokenRecord {
  return {
    accessToken: `access-gen-${generation}`,
    refreshToken: "refresh-owner",
    expiresAt: NOW + 3_600_000,
    generation,
    fingerprint: fingerprintOf("refresh-owner"),
    accountId: "acct-owner",
    updatedAt: NOW,
  };
}

async function markNeedsReauth(sinceAgoMs: number): Promise<void> {
  await state.setNeedsReauth(REF, {
    since: NOW - sinceAgoMs,
    attempts: 1,
    lastReason: "invalid_grant",
    failedGeneration: 1,
    failedFingerprint: fingerprintOf("refresh-owner"),
  });
}

/** `reads` per store kind; `onRead` decides what each read returns. */
function poolWith(onRead: (store: string, n: number) => StoredTokenRecord | null) {
  const reads: Record<string, number> = {};
  const pool = new AccountPool("openai-codex", {
    registry: new AccountRegistry({
      configPath: () => configPath,
      legacyCodexPath: () => join(dir, "codex-oauth.json"),
      env: { CLAUDISH_DISABLE_KEYCHAIN: "1" },
    }),
    state,
    now: () => NOW,
    env: { CLAUDISH_DISABLE_KEYCHAIN: "1", CLAUDISH_ACCOUNTS_DIR: join(dir, "accounts") },
    storeFactory: (record): TokenStore => ({
      kind: "file",
      read: async () => {
        reads[record.store] = (reads[record.store] ?? 0) + 1;
        return onRead(record.store, reads[record.store]!);
      },
      write: async () => {},
      delete: async () => {},
      describe: () => `isolated fake ${record.store} store`,
    }),
  });
  return { pool, reads };
}

async function thrownBy(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (err) {
    return err;
  }
  throw new Error("expected the acquire to throw");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-pool-store-move-reauth-"));
  configPath = join(dir, "config.json");
  state = new StateStore({
    path: join(dir, "state.json"),
    lockPath: join(dir, "state.lock"),
    now: () => NOW,
  });
  writeConfig("legacy-codex-file", 1);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a due needsReauth retry across a store-only move (G1)", () => {
  /**
   * Legacy read 1 is `healReauthMarks` (same material: no heal). Read 2 is the
   * lease: the move publishes and the file is gone. The Keychain item holds a
   * later generation, which heals the mark when leased.
   */
  function movingDuringLease() {
    return poolWith((store, n) => {
      if (store === "legacy-codex-file") {
        if (n === 1) return material(1);
        writeConfig("keychain", 2);
        return null;
      }
      return material(2);
    });
  }

  test("an unpinned single-account pool leases the Keychain item, not a terminal 401", async () => {
    await markNeedsReauth(10 * 60_000); // retry due: 60 s after one attempt
    const { pool, reads } = movingDuringLease();

    const lease = await pool.acquire();

    expect(lease.account.id).toBe(ID);
    expect(lease.accessToken).toBe("access-gen-2");
    expect(reads).toEqual({ "legacy-codex-file": 2, keychain: 1 });
    // Mutation caught: the re-auth stamp from the store-move pass stays, the
    // next pass sees the due retry as "attempted just now" and the pool
    // answers NeedsReauthError.
  });

  test("a pinned lease's same-hop retry is not blocked by the move pass's stamp", async () => {
    await markNeedsReauth(10 * 60_000);
    const { pool } = movingDuringLease();

    const err = await thrownBy(pool.acquire({ pin: REF }));
    expect(classifyAuthFailure(err).kind).toBe("transient");

    const retry = await pool.acquire({ pin: REF });
    expect(retry.account.id).toBe(ID);
    expect(retry.accessToken).toBe("access-gen-2");
    // Mutation caught: the pool-level stamp survives the pinned throw, so the
    // retry's fresh context blocks the pin as needs-reauth (terminal).
  });

  test("after a pinned store-move, the next unpinned request still gets its due exchange", async () => {
    // A pin is honoured even when needs-reauth, so the stamp cannot show on the
    // pin's own retry; it shows on the NEXT request, whose context is copied
    // from the pool's map. The realistic move: the Keychain item holds the
    // file's material verbatim, so no heal applies and the due retry is an
    // exchange. The token endpoint is a test-scoped fetch stub.
    await markNeedsReauth(10 * 60_000);
    const { pool } = poolWith((store, n) => {
      if (store === "legacy-codex-file") {
        if (n === 1) return material(1);
        writeConfig("keychain", 2);
        return null;
      }
      return material(1);
    });
    const exchanged: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.endsWith("/oauth/token")) throw new Error(`unexpected fetch: ${url}`);
        exchanged.push(url);
        return Response.json({
          access_token: "access-exchanged",
          refresh_token: "refresh-exchanged",
          expires_in: 3600,
          token_type: "Bearer",
        });
      },
      { preconnect: () => {} }
    ) as typeof fetch;
    try {
      const err = await thrownBy(pool.acquire({ pin: REF }));
      expect(classifyAuthFailure(err).kind).toBe("transient");

      const next = await pool.acquire();

      expect(next.account.id).toBe(ID);
      expect(next.accessToken).toBe("access-exchanged");
      expect(exchanged).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
    }
    // Mutation caught: the pinned throw leaves the pool-level stamp, so the
    // next request reads the due retry as "attempted just now" and the
    // single-account pool answers a terminal NeedsReauthError.
  });

  test("two store-only moves of one row do not spend the removal budget", async () => {
    // No mark, so no heal read: legacy → keychain during the first lease (an
    // empty store), then keychain → file after the second (the post-lease check).
    const { pool, reads } = poolWith((store) => {
      if (store === "legacy-codex-file") {
        writeConfig("keychain", 2);
        return null;
      }
      if (store === "keychain") {
        writeConfig("file", 3);
        return material(2);
      }
      return material(3);
    });

    const lease = await pool.acquire();

    expect(lease.accessToken).toBe("access-gen-3");
    expect(reads.file).toBe(1);
    // Mutation caught: each store-move pass consumes one of the records + 1
    // attempts, and the pool answers "account list changed during selection".
  });
});

describe("healReauthMarks when the move lands mid-heal (G1)", () => {
  test("an empty old store heals against the rebound record", async () => {
    await markNeedsReauth(10_000); // NOT due: the heal is the only way in
    const { pool } = poolWith((store) => {
      if (store === "legacy-codex-file") {
        writeConfig("keychain", 2);
        return null;
      }
      return material(2);
    });

    const lease = await pool.acquire();

    expect(lease.account.id).toBe(ID);
    expect(lease.accessToken).toBe("access-gen-2");
    expect(state.stateFor(REF).state.needsReauth).toBeUndefined();
    // Mutation caught: healReauthMarks gives up on the empty legacy read, the
    // Keychain row stays blocked and the pool answers NeedsReauthError.
  });

  test("control: an empty store with the row unchanged keeps the mark", async () => {
    await markNeedsReauth(10_000);
    const { pool } = poolWith(() => null);

    const err = await thrownBy(pool.acquire());

    expect(classifyAuthFailure(err).kind).toBe("terminal");
    expect(state.stateFor(REF).state.needsReauth).toBeDefined();
  });
});
