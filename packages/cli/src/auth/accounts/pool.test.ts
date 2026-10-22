import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasQuotaExhaustionWording,
  isQuotaExhaustionError,
} from "../../handlers/shared/quota-exhaustion.js";
import { AccountPool } from "./pool.js";
import { AccountRegistry } from "./registry.js";
import { StateStore } from "./state-store.js";
import {
  type StoredTokenRecord,
  type TokenStore,
  TokenStoreReadError,
  fingerprintOf,
} from "./token-store.js";
import {
  AccountListUnavailableError,
  NoUsableAccountError,
  RefreshUnavailableError,
} from "./types.js";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");
let dir = "";
let configPath = "";
let legacyPath = "";
let statePath = "";
let lockPath = "";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function accountList(): AccountRegistry {
  return new AccountRegistry({
    configPath: () => configPath,
    legacyCodexPath: () => legacyPath,
    env: { CLAUDISH_DISABLE_KEYCHAIN: "1" },
  });
}

function freshRecord(accessToken: string): StoredTokenRecord {
  return {
    accessToken,
    refreshToken: `refresh-${accessToken}`,
    expiresAt: NOW + 3_600_000,
    generation: 1,
    fingerprint: fingerprintOf(`refresh-${accessToken}`),
    updatedAt: NOW,
  };
}

function fakeStore(read: TokenStore["read"]): TokenStore {
  return {
    kind: "file",
    read,
    write: async () => {},
    delete: async () => {},
    describe: () => "isolated fake store",
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-pool-test-"));
  configPath = join(dir, "config.json");
  legacyPath = join(dir, "codex-oauth.json");
  statePath = join(dir, "state.json");
  lockPath = join(dir, "state.lock");
  writeJson(configPath, {
    version: "1.0.0",
    defaultProfile: "default",
    profiles: {},
    subscriptionAccounts: {
      "openai-codex": {
        generation: 1,
        accounts: [
          {
            id: "abc123def456",
            label: "work",
            store: "file",
            addedAt: "2026-09-12T00:00:00.000Z",
          },
          {
            id: "def456abc123",
            label: "spare",
            store: "file",
            addedAt: "2026-09-12T00:00:00.000Z",
          },
        ],
      },
    },
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("AccountPool.hasAnyCredentials", () => {
  test("stays true when every configured account is exhausted and never reads token material", () => {
    writeJson(statePath, {
      version: 1,
      providers: {
        "openai-codex": {
          accounts: {
            abc123def456: { exhaustedUntil: NOW + 60_000 },
            def456abc123: { exhaustedUntil: NOW + 120_000 },
          },
        },
      },
    });
    let tokenReads = 0;
    const unreadableStore: TokenStore = {
      kind: "file",
      read: async () => {
        tokenReads++;
        throw new Error("token store unreadable");
      },
      write: async () => {},
      delete: async () => {},
      describe: () => "unreadable fake",
    };
    const pool = new AccountPool("openai-codex", {
      registry: accountList(),
      state: new StateStore({ path: statePath, lockPath, now: () => NOW }),
      now: () => NOW,
      storeFactory: () => unreadableStore,
    });

    expect(pool.hasAnyCredentials()).toBe(true);
    expect(tokenReads).toBe(0);

    // Mutation caught: define credential presence from selection eligibility or
    // stored token material; exhaustion makes it false, or the unreadable store is
    // consulted and swallowed as false, reopening the metered fallback.
  });

  test("throws on an unreadable account list instead of returning false", () => {
    rmSync(configPath);
    mkdirSync(configPath);
    const pool = new AccountPool("openai-codex", {
      registry: accountList(),
      state: new StateStore({ path: statePath, lockPath, now: () => NOW }),
      now: () => NOW,
    });

    expect(() => pool.hasAnyCredentials()).toThrow(AccountListUnavailableError);
    expect(() => pool.hasAnyCredentials()).toThrow(
      /Refusing to treat an unreadable account list as an empty one/
    );

    // Mutation caught: catch AccountListUnavailableError in the presence predicate and
    // return false, which lets a configured subscription fall through to metered.
  });
});

describe("AccountPool.acquire credential failover", () => {
  test("tries the next eligible account when the first has no usable credential", async () => {
    const reads: string[] = [];
    const pool = new AccountPool("openai-codex", {
      registry: accountList(),
      state: new StateStore({ path: statePath, lockPath, now: () => NOW }),
      now: () => NOW,
      storeFactory: (account) =>
        fakeStore(async () => {
          reads.push(account.label);
          return account.label === "work" ? null : freshRecord("access-spare");
        }),
    });

    const lease = await pool.acquire();

    expect(lease.account.label).toBe("spare");
    expect(lease.accessToken).toBe("access-spare");
    expect(reads).toEqual(["work", "spare"]);

    // PROVISIONAL: constructed token material; replace it with a captured Codex
    // record once the Phase V token probe is available.
    // Mutation caught: propagate the first TokenManager credential error instead
    // of excluding work and making one bounded attempt on spare.
  });

  test("all disabled accounts raise NoUsableAccountError without quota wording", async () => {
    writeJson(configPath, {
      version: "1.0.0",
      defaultProfile: "default",
      profiles: {},
      subscriptionAccounts: {
        "openai-codex": {
          generation: 2,
          accounts: [
            {
              id: "abc123def456",
              label: "work",
              store: "file",
              enabled: false,
              addedAt: "2026-09-12T00:00:00.000Z",
            },
            {
              id: "def456abc123",
              label: "spare",
              store: "file",
              enabled: false,
              addedAt: "2026-09-12T00:00:00.000Z",
            },
          ],
        },
      },
    });
    const pool = new AccountPool("openai-codex", {
      registry: accountList(),
      state: new StateStore({ path: statePath, lockPath, now: () => NOW }),
      now: () => NOW,
      storeFactory: () =>
        fakeStore(async () => {
          throw new Error("disabled accounts must not read token material");
        }),
    });

    let thrown: unknown;
    try {
      await pool.acquire();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NoUsableAccountError);
    const error = thrown as NoUsableAccountError;
    expect(hasQuotaExhaustionWording(error.message)).toBe(false);
    expect(isQuotaExhaustionError(error.upstreamStatus, error.message)).toBe(false);
    expect(error.message).toContain("0 of 2 usable");

    // Mutation caught: use AllAccountsExhaustedError whenever selection returns
    // none. Its pinned usage-limit wording trips both production classifiers.
  });

  test("all unreadable token stores raise RefreshUnavailableError without quota wording", async () => {
    const reads: string[] = [];
    const pool = new AccountPool("openai-codex", {
      registry: accountList(),
      state: new StateStore({ path: statePath, lockPath, now: () => NOW }),
      now: () => NOW,
      storeFactory: (account) =>
        fakeStore(async () => {
          reads.push(account.label);
          throw new TokenStoreReadError("file", `${account.label} read failed`);
        }),
    });

    let thrown: unknown;
    try {
      await pool.acquire();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RefreshUnavailableError);
    const error = thrown as RefreshUnavailableError;
    expect(hasQuotaExhaustionWording(error.message)).toBe(false);
    expect(isQuotaExhaustionError(error.upstreamStatus, error.message)).toBe(false);
    expect(error.blockers).toHaveLength(2);
    expect(reads).toEqual(["work", "spare"]);

    // Mutation caught: propagate the first per-account failure, retry an account
    // more than once, or classify a zero-success pass as quota exhaustion instead
    // of transient unavailability.
  });
});
