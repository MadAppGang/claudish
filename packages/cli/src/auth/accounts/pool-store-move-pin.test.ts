/**
 * A PINNED lease racing the legacy Codex file move (MTL-372, review round).
 *
 * The move rebinds a live row: same id, same `chatgptAccountId`, still enabled,
 * only `store` changes `legacy-codex-file` → `keychain`. A pinned lease (the 401
 * re-sign, a Responses leg pinned to its account) that catches that publish must
 * answer TRANSIENT 503, retried on the same hop, where the pin is kept. A
 * terminal 401 there is retryable to FallbackHandler and walks a subscription
 * user onto a metered hop. A removed row stays terminal for a pin.
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
const PIN: AccountRef = { provider: "openai-codex", id: ID, label: "default" };

let dir = "";
let configPath = "";
let legacyPath = "";
let statePath = "";
let lockPath = "";

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

async function thrownBy(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (err) {
    return err;
  }
  throw new Error("expected the pinned acquire to throw");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-pool-store-move-pin-"));
  configPath = join(dir, "config.json");
  legacyPath = join(dir, "codex-oauth.json");
  statePath = join(dir, "state.json");
  lockPath = join(dir, "state.lock");
  writeConfig([row("legacy-codex-file")], 1);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("pinned lease across a store-only rebind (the legacy file move)", () => {
  test("an empty legacy store after the row moved to the Keychain is transient 503, not terminal", async () => {
    // The move published between selection and the token read, then deleted the file.
    const pool = poolWith(async (record) => {
      if (record.store === "legacy-codex-file") {
        writeConfig([row("keychain")], 2);
        return null;
      }
      return freshRecord();
    });

    const err = await thrownBy(pool.acquire({ pin: PIN }));

    const failure = classifyAuthFailure(err);
    expect(failure.kind).toBe("transient");
    expect(failure.kind === "transient" ? failure.status : undefined).toBe(503);
    expect((err as { terminal?: boolean }).terminal).toBe(false);

    // The retry leases the same id on its Keychain store: the pin is kept.
    const retry = await pool.acquire({ pin: PIN });
    expect(retry.account.id).toBe(ID);
    expect(retry.accessToken).toBe("access-legacy");

    // Mutation caught: validateAccount throws AccountChangedDuringLeaseError
    // (NoUsableAccountError, terminal 401) for a store-only rebind, and tryLease
    // rethrows it for the pin.
  });

  test("a lease that read the old store before the move published is transient 503 for a pin", async () => {
    // The read succeeded from the file; the row was rebound before the post-lease check.
    const pool = poolWith(async (record) => {
      if (record.store === "legacy-codex-file") writeConfig([row("keychain")], 2);
      return freshRecord();
    });

    const err = await thrownBy(pool.acquire({ pin: PIN }));

    const failure = classifyAuthFailure(err);
    expect(failure.kind).toBe("transient");
    expect(failure.kind === "transient" ? failure.status : undefined).toBe(503);

    // Mutation caught: the post-lease stillConfigured check throws a terminal
    // NoUsableAccountError for a pin whose row only changed store.
  });

  test("a pinned row REMOVED during the lease stays terminal", async () => {
    const pool = poolWith(async () => {
      writeConfig([], 2);
      return null;
    });

    const err = await thrownBy(pool.acquire({ pin: PIN }));

    const failure = classifyAuthFailure(err);
    expect(failure.kind).toBe("terminal");
    expect((err as { upstreamStatus?: number }).upstreamStatus).toBe(401);

    // Mutation caught: treat every rebind as transient, so a removed account
    // retries on the same hop forever instead of reporting it cannot serve.
  });

  test("a pinned row whose identity changed during the lease stays terminal", async () => {
    const pool = poolWith(async () => {
      writeConfig([{ ...row("keychain"), identity: { chatgptAccountId: "acct-other" } }], 2);
      return null;
    });

    const err = await thrownBy(pool.acquire({ pin: PIN }));

    expect(classifyAuthFailure(err).kind).toBe("terminal");
  });

  test("a pinned row DISABLED during the lease stays terminal", async () => {
    const pool = poolWith(async () => {
      writeConfig([{ ...row("keychain"), enabled: false }], 2);
      return null;
    });

    const err = await thrownBy(pool.acquire({ pin: PIN }));

    expect(classifyAuthFailure(err).kind).toBe("terminal");
  });
});

describe("unpinned lease across a store-only rebind (B)", () => {
  const spare = {
    id: "def456abc123",
    label: "spare",
    store: "file",
    identity: { chatgptAccountId: "acct-spare" },
    addedAt: "2026-09-12T00:00:00.000Z",
  };

  function movingPool(readFromFileBeforeMove: StoredTokenRecord | null, reads: string[] = []) {
    writeConfig([row("legacy-codex-file"), spare], 1);
    return poolWith(async (record) => {
      reads.push(record.store);
      if (record.store === "legacy-codex-file") {
        writeConfig([row("keychain"), spare], 2);
        return readFromFileBeforeMove;
      }
      if (record.store === "keychain") return { ...freshRecord(), accessToken: "access-keychain" };
      return { ...freshRecord(), accessToken: "access-spare" };
    });
  }

  test("an empty legacy store after the move leases the SAME id from the Keychain store", async () => {
    const reads: string[] = [];
    const pool = movingPool(null, reads);

    const lease = await pool.acquire();

    expect(lease.account.id).toBe(ID);
    expect(lease.accessToken).toBe("access-keychain");
    expect(reads).toEqual(["legacy-codex-file", "keychain"]);

    // Mutation caught: tryLease records the store-only move as a lease failure,
    // which excludes the rebound row and leases spare instead.
  });

  test("a lease read from the old store before the move leases the SAME id again", async () => {
    const reads: string[] = [];
    const pool = movingPool(freshRecord(), reads);

    const lease = await pool.acquire();

    expect(lease.account.id).toBe(ID);
    expect(lease.accessToken).toBe("access-keychain");
    expect(reads).toEqual(["legacy-codex-file", "keychain"]);

    // Mutation caught: the post-lease check records the moved row in
    // context.failed, so the next pass leases spare.
  });

  test("a store-only move does not deprioritise the row for the next request", async () => {
    const pool = movingPool(null);

    await pool.acquire();
    const next = await pool.acquire();

    expect(next.account.id).toBe(ID);
    expect(next.accessToken).toBe("access-keychain");
  });
});
