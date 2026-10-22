import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AccountsFault } from "../../test-upstream.js";
import { readHolder } from "./file-lock.js";
import { InvalidGrantError, type TokenExchange, TokenManager } from "./token-manager.js";
import {
  FileTokenStore,
  type ReadOptions,
  type StoredTokenRecord,
  type TokenStore,
  fingerprintOf,
} from "./token-store.js";
import { type AccountRef, PersistOutcomeUnknownError, RefreshUnavailableError } from "./types.js";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");
const ref: AccountRef = {
  provider: "openai-codex",
  id: "abc123def456",
  label: "work",
};
let dir = "";

function stored(
  accessToken = "access-old",
  refreshToken = "refresh-old",
  generation = 0,
  expiresAt = NOW - 1
): StoredTokenRecord {
  return {
    accessToken,
    refreshToken,
    expiresAt,
    generation,
    fingerprint: fingerprintOf(refreshToken),
    updatedAt: NOW,
  };
}

function cloneRecord(record: StoredTokenRecord | null): StoredTokenRecord | null {
  return record === null ? null : structuredClone(record);
}

function faultEnv(fault: AccountsFault): NodeJS.ProcessEnv {
  return {
    CLAUDISH_TEST_UPSTREAM: "http://127.0.0.1:4010",
    CLAUDISH_ACCOUNTS_FAULT: fault,
    CLAUDISH_DISABLE_KEYCHAIN: "1",
    CLAUDISH_DISABLE_OP: "1",
  };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class MemoryStore implements TokenStore {
  readonly kind = "file" as const;
  value: StoredTokenRecord | null;
  reads: ReadOptions[] = [];
  writes: StoredTokenRecord[] = [];
  events: string[] = [];

  constructor(value: StoredTokenRecord | null) {
    this.value = cloneRecord(value);
  }

  async read(_ref: AccountRef, opts: ReadOptions = {}): Promise<StoredTokenRecord | null> {
    this.reads.push({ ...opts });
    if (opts.uncached) this.events.push("uncached-read");
    return cloneRecord(this.value);
  }

  async write(_ref: AccountRef, record: StoredTokenRecord): Promise<void> {
    this.events.push("write");
    this.writes.push(structuredClone(record));
    this.value = structuredClone(record);
  }

  async delete(): Promise<void> {
    this.value = null;
  }

  describe(): string {
    return "memory test store";
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-token-manager-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("TokenManager refresh coordination", () => {
  test("single-flights concurrent refreshes within one process", async () => {
    const store = new MemoryStore(stored());
    let exchangeCalls = 0;
    let releaseExchange: (() => void) | undefined;
    const exchangeStarted = new Promise<void>((resolve) => {
      releaseExchange = resolve;
    });
    const exchange: TokenExchange = {
      refresh: async () => {
        exchangeCalls++;
        await exchangeStarted;
        // PROVISIONAL: constructed OAuth token response; replace with a captured
        // Codex refresh response shape when the Phase V token probe is recorded.
        return {
          accessToken: "access-new",
          refreshToken: "refresh-new",
          expiresAt: NOW + 3_600_000,
        };
      },
    };
    const manager = new TokenManager({
      store,
      exchange,
      now: () => NOW,
      lockPathFor: () => join(dir, "single-flight.lock"),
    });

    const requests = Array.from({ length: 6 }, () => manager.getAccessToken(ref));
    while (exchangeCalls === 0) await Bun.sleep(1);
    expect(exchangeCalls).toBe(1);
    releaseExchange?.();
    const results = await Promise.all(requests);

    expect(results.map((result) => result.accessToken)).toEqual(
      Array.from({ length: 6 }, () => "access-new")
    );
    expect(exchangeCalls).toBe(1);

    // Mutation caught: remove the provider:id inFlight map; all six calls reach
    // the exchange rather than sharing the first promise.
  });

  test("re-reads uncached after taking the gate and skips an exchange another holder completed", async () => {
    const expired = stored();
    const fresh = stored("access-fresh", "refresh-fresh", 1, NOW + 3_600_000);
    let reads = 0;
    const store = new MemoryStore(expired);
    store.read = async (_account, opts = {}) => {
      store.reads.push({ ...opts });
      reads++;
      return cloneRecord(reads === 1 ? expired : fresh);
    };
    let exchangeCalls = 0;
    const manager = new TokenManager({
      store,
      exchange: {
        refresh: async () => {
          exchangeCalls++;
          throw new Error("the gate-holder's fresh record should suppress refresh");
        },
      },
      now: () => NOW,
      lockPathFor: () => join(dir, "reread.lock"),
    });

    const result = await manager.getAccessToken(ref);

    expect(result.accessToken).toBe("access-fresh");
    expect(result.refreshed).toBe(false);
    expect(store.reads).toEqual([{ uncached: false }, { uncached: true }]);
    expect(exchangeCalls).toBe(0);

    // Mutation caught: remove the post-acquire uncached re-read; the stale expired
    // record reaches the exchange and the test throws.
  });

  test("fails closed when the refresh gate is unavailable and never exchanges unlocked", async () => {
    const store = new MemoryStore(stored());
    const nonDirectory = join(dir, "not-a-directory");
    writeFileSync(nonDirectory, "blocks refresh lock directory creation", "utf8");
    let exchangeCalls = 0;
    const manager = new TokenManager({
      store,
      exchange: {
        refresh: async () => {
          exchangeCalls++;
          return {
            accessToken: "must-not-be-used",
            expiresAt: NOW + 3_600_000,
          };
        },
      },
      now: () => NOW,
      lockPathFor: () => join(nonDirectory, "refresh.lock"),
    });

    await expect(manager.getAccessToken(ref)).rejects.toBeInstanceOf(RefreshUnavailableError);
    await expect(manager.getAccessToken(ref)).rejects.toThrow("refresh disabled");
    expect(exchangeCalls).toBe(0);
    expect(store.reads.every((opts, index) => index % 2 === 0 || opts.uncached === true)).toBe(
      true
    );

    // Mutation caught: switch the file lock to onUnavailable:"proceed" or call
    // refreshUnderGate from the catch; the injected exchange runs without a lock.
  });

  test("recovers an invalid_grant rotation race by re-reading and retrying the new material", async () => {
    const old = stored();
    const rotated = stored("access-rotated", "refresh-rotated", 1, NOW - 1);
    const store = new MemoryStore(old);
    const presented: string[] = [];
    const exchange: TokenExchange = {
      refresh: async (record) => {
        presented.push(record.refreshToken);
        if (presented.length === 1) {
          // Simulate another authorized owner rotating the store while this
          // exchange was in flight; the endpoint rejects reuse with invalid_grant.
          store.value = cloneRecord(rotated);
          throw new InvalidGrantError("refresh token already rotated");
        }
        // PROVISIONAL: constructed successful retry response; replace with the
        // real Codex invalid_grant + rotated-token transcript from Phase V.
        return {
          accessToken: "access-final",
          refreshToken: "refresh-final",
          expiresAt: NOW + 3_600_000,
        };
      },
    };
    const manager = new TokenManager({
      store,
      exchange,
      now: () => NOW,
      lockPathFor: () => join(dir, "rotation-race.lock"),
    });

    const result = await manager.getAccessToken(ref);

    expect(presented).toEqual(["refresh-old", "refresh-rotated"]);
    expect(result.accessToken).toBe("access-final");
    expect(result.record.generation).toBe(2);

    // Mutation caught: classify the first invalid_grant as revoked without an
    // uncached re-read; the retry never presents refresh-rotated.
  });

  test("does not retain a refreshed token in memory when its final persist fails", async () => {
    const store = new MemoryStore(stored());
    let failFinalPersist = true;
    store.write = async (_account, record) => {
      store.writes.push(structuredClone(record));
      if (record.journal) {
        store.value = structuredClone(record);
        return;
      }
      if (failFinalPersist) {
        failFinalPersist = false;
        throw new Error("injected final persist failure");
      }
      store.value = structuredClone(record);
    };
    let exchangeCalls = 0;
    const manager = new TokenManager({
      store,
      exchange: {
        refresh: async () => {
          exchangeCalls++;
          return {
            accessToken: `access-new-${exchangeCalls}`,
            refreshToken: `refresh-new-${exchangeCalls}`,
            expiresAt: NOW + 3_600_000,
          };
        },
      },
      now: () => NOW,
      lockPathFor: () => join(dir, "persist-failure.lock"),
    });

    await expect(manager.getAccessToken(ref)).rejects.toThrow("injected final persist failure");
    expect(store.value?.accessToken).toBe("access-old");
    expect(store.value?.journal?.state).toBe("refreshing");

    const retry = await manager.getAccessToken(ref);
    expect(retry.accessToken).toBe("access-new-2");
    expect(retry.accessToken).not.toBe("access-new-1");
    expect(exchangeCalls).toBe(2);

    // Mutation caught: cache/return access-new-1 before the final write resolves;
    // the first promise fulfills or the second call reuses access-new-1.
  });

  test("forced refresh exchanges a rejected token with fifty minutes left", async () => {
    const store = new MemoryStore(stored("access-rejected", "refresh-old", 4, NOW + 50 * 60_000));
    let exchangeCalls = 0;
    const manager = new TokenManager({
      store,
      exchange: {
        refresh: async () => {
          exchangeCalls++;
          // PROVISIONAL: constructed OAuth token response; replace with a captured
          // Codex refresh response shape when the Phase V token probe is recorded.
          return {
            accessToken: "access-replacement",
            refreshToken: "refresh-replacement",
            expiresAt: NOW + 3_600_000,
          };
        },
      },
      now: () => NOW,
      lockPathFor: () => join(dir, "forced-fresh.lock"),
    });

    const result = await manager.getAccessToken(ref, {
      rejectedAccessToken: "access-rejected",
    });

    expect(result.accessToken).toBe("access-replacement");
    expect(result.refreshed).toBe(true);
    expect(result.record.generation).toBe(5);
    expect(exchangeCalls).toBe(1);

    // Mutation caught: drop the rejected-token comparison under the gate. The
    // fifty-minute token looks fresh and is returned without an exchange.
  });

  test("forced refresh adopts a token another process already replaced", async () => {
    const rejected = stored("access-rejected", "refresh-old", 4, NOW + 50 * 60_000);
    const replacement = stored("access-peer", "refresh-peer", 5, NOW + 50 * 60_000);
    const store = new MemoryStore(rejected);
    let reads = 0;
    store.read = async (_account, opts = {}) => {
      store.reads.push({ ...opts });
      reads++;
      return cloneRecord(reads === 1 ? rejected : replacement);
    };
    let exchangeCalls = 0;
    const manager = new TokenManager({
      store,
      exchange: {
        refresh: async () => {
          exchangeCalls++;
          throw new Error("the peer replacement must suppress the exchange");
        },
      },
      now: () => NOW,
      lockPathFor: () => join(dir, "forced-peer.lock"),
    });

    const result = await manager.getAccessToken(ref, {
      rejectedAccessToken: "access-rejected",
    });

    expect(result.accessToken).toBe("access-peer");
    expect(result.refreshed).toBe(false);
    expect(exchangeCalls).toBe(0);
    expect(store.reads).toEqual([{ uncached: true }, { uncached: true }]);

    // Mutation caught: force every named refresh to exchange even when the
    // under-gate record no longer carries the rejected bearer.
  });

  test("a forced request never coalesces onto a non-forced in-flight result", async () => {
    const original = stored("access-rejected", "refresh-old", 4, NOW + 50 * 60_000);
    const store = new MemoryStore(original);
    const firstReadEntered = deferred();
    const releaseFirstRead = deferred();
    let reads = 0;
    store.read = async (_account, opts = {}) => {
      store.reads.push({ ...opts });
      reads++;
      const atRead = cloneRecord(store.value);
      if (reads === 1) {
        firstReadEntered.resolve(undefined);
        await releaseFirstRead.promise;
      }
      return atRead;
    };
    let exchangeCalls = 0;
    const manager = new TokenManager({
      store,
      exchange: {
        refresh: async () => {
          exchangeCalls++;
          return {
            accessToken: "access-forced",
            refreshToken: "refresh-forced",
            expiresAt: NOW + 3_600_000,
          };
        },
      },
      now: () => NOW,
      lockPathFor: () => join(dir, "forced-vs-normal.lock"),
    });

    const normal = manager.getAccessToken(ref);
    await firstReadEntered.promise;
    const forced = manager.getAccessToken(ref, { rejectedAccessToken: "access-rejected" });
    await Bun.sleep(10);
    releaseFirstRead.resolve(undefined);
    const [normalResult, forcedResult] = await Promise.all([normal, forced]);

    expect(normalResult.accessToken).toBe("access-rejected");
    expect(forcedResult.accessToken).toBe("access-forced");
    expect(exchangeCalls).toBe(1);

    // Mutation caught: key every in-process flight only by provider:id. The
    // forced caller joins the blocked normal read and receives access-rejected.
  });

  test("journal-persist-timeout-uncommitted stops before the exchange when its write id is absent", async () => {
    const store = new MemoryStore(stored());
    let exchangeCalls = 0;
    const manager = new TokenManager({
      store,
      exchange: {
        refresh: async () => {
          exchangeCalls++;
          return { accessToken: "must-not-run", expiresAt: NOW + 3_600_000 };
        },
      },
      now: () => NOW,
      lockPathFor: () => join(dir, "journal-timeout-uncommitted.lock"),
      env: faultEnv("journal-persist-timeout-uncommitted"),
      newWriteId: () => "journal-write-id",
    });

    await expect(manager.getAccessToken(ref)).rejects.toBeInstanceOf(RefreshUnavailableError);
    expect(exchangeCalls).toBe(0);
    expect(store.value?.accessToken).toBe("access-old");
    expect(store.value?.journal).toBeUndefined();

    // Mutation caught: resolve an ambiguous journal write by unchanged generation
    // or fingerprint. The absent write is treated as committed and exchange runs.
  });

  test("persist-timeout-uncommitted marks the journal unknown when its write id is absent", async () => {
    const store = new MemoryStore(stored());
    const manager = new TokenManager({
      store,
      exchange: {
        refresh: async () => ({
          accessToken: "access-new",
          // Deliberately no refresh token: fingerprint equality must not be accepted
          // as proof that the final write committed.
          expiresAt: NOW + 3_600_000,
        }),
      },
      now: () => NOW,
      lockPathFor: () => join(dir, "final-timeout-uncommitted.lock"),
      env: faultEnv("persist-timeout-uncommitted"),
      newWriteId: (() => {
        let id = 0;
        return () => `write-${++id}`;
      })(),
    });

    await expect(manager.getAccessToken(ref)).rejects.toBeInstanceOf(PersistOutcomeUnknownError);
    expect(store.value?.accessToken).toBe("access-old");
    expect(store.value?.journal?.state).toBe("unknown");
    expect(store.value?.generation).toBe(0);

    // Mutation caught: resolve by fingerprint equality. Because the vendor did
    // not rotate the refresh token, the missing final write is falsely committed.
  });

  test("journal-persist-throw fails before any exchange or store write", async () => {
    const store = new MemoryStore(stored());
    let exchangeCalls = 0;
    const manager = new TokenManager({
      store,
      exchange: {
        refresh: async () => {
          exchangeCalls++;
          return { accessToken: "must-not-run", expiresAt: NOW + 3_600_000 };
        },
      },
      now: () => NOW,
      lockPathFor: () => join(dir, "journal-throw.lock"),
      env: faultEnv("journal-persist-throw"),
    });

    await expect(manager.getAccessToken(ref)).rejects.toBeInstanceOf(RefreshUnavailableError);
    expect(exchangeCalls).toBe(0);
    expect(store.writes).toEqual([]);

    // Mutation caught: accept journal-persist-throw without injecting at the
    // journal write; the exchange and final persist both run.
  });

  test("journal-persist-timeout-committed proves the journal write by id and continues", async () => {
    const store = new MemoryStore(stored());
    let exchangeCalls = 0;
    const manager = new TokenManager({
      store,
      exchange: {
        refresh: async () => {
          store.events.push("exchange");
          exchangeCalls++;
          return { accessToken: "access-new", expiresAt: NOW + 3_600_000 };
        },
      },
      now: () => NOW,
      lockPathFor: () => join(dir, "journal-timeout-committed.lock"),
      env: faultEnv("journal-persist-timeout-committed"),
    });

    const result = await manager.getAccessToken(ref);

    expect(result.accessToken).toBe("access-new");
    expect(exchangeCalls).toBe(1);
    expect(store.reads.filter((read) => read.uncached)).toHaveLength(3);
    expect(store.events).toEqual([
      "uncached-read", // under-gate
      "write", // journal
      "uncached-read", // journal-resolve
      "exchange",
      "uncached-read", // pre-persist
      "write", // final
    ]);
    expect(store.writes).toHaveLength(2);

    // Mutation caught: accept the fault name without injecting the ambiguous
    // acknowledgement; the journal-resolve read disappears, leaving two uncached reads.
  });

  test("persist-throw fires only after a successful exchange and leaves the journal open", async () => {
    const store = new MemoryStore(stored());
    let exchangeCalls = 0;
    const manager = new TokenManager({
      store,
      exchange: {
        refresh: async () => {
          exchangeCalls++;
          return { accessToken: "access-new", expiresAt: NOW + 3_600_000 };
        },
      },
      now: () => NOW,
      lockPathFor: () => join(dir, "final-throw.lock"),
      env: faultEnv("persist-throw"),
    });

    await expect(manager.getAccessToken(ref)).rejects.toBeInstanceOf(PersistOutcomeUnknownError);
    expect(exchangeCalls).toBe(1);
    expect(store.value?.accessToken).toBe("access-old");
    expect(store.value?.journal?.state).toBe("refreshing");

    // Mutation caught: inject persist-throw at the journal write, or accept it
    // without a final-write site. The exchange count or resulting journal differs.
  });

  test("persist-timeout-committed proves the final write by id and returns it", async () => {
    const store = new MemoryStore(stored());
    const manager = new TokenManager({
      store,
      exchange: {
        refresh: async () => {
          store.events.push("exchange");
          return {
            accessToken: "access-new",
            refreshToken: "refresh-new",
            expiresAt: NOW + 3_600_000,
          };
        },
      },
      now: () => NOW,
      lockPathFor: () => join(dir, "final-timeout-committed.lock"),
      env: faultEnv("persist-timeout-committed"),
    });

    const result = await manager.getAccessToken(ref);

    expect(result.accessToken).toBe("access-new");
    expect(store.value?.accessToken).toBe("access-new");
    expect(store.value?.generation).toBe(1);
    expect(store.reads.filter((read) => read.uncached)).toHaveLength(3);
    expect(store.events).toEqual([
      "uncached-read", // under-gate
      "write", // journal
      "exchange",
      "uncached-read", // pre-persist
      "write", // final
      "uncached-read", // final-write resolver
    ]);

    // Mutation caught: accept the fault name without injecting the ambiguous
    // acknowledgement; the resolver read disappears, leaving two uncached reads.
  });

  test("lock-hold-forever enters its injected hold while owning the live gate", async () => {
    const store = new MemoryStore(stored());
    const entered = deferred();
    const release = deferred();
    const lockPath = join(dir, "hold-forever.lock");
    let exchangeCalls = 0;
    const manager = new TokenManager({
      store,
      exchange: {
        refresh: async () => {
          exchangeCalls++;
          return { accessToken: "access-new", expiresAt: NOW + 3_600_000 };
        },
      },
      now: () => NOW,
      lockPathFor: () => lockPath,
      env: faultEnv("lock-hold-forever"),
      holdForever: async () => {
        entered.resolve(undefined);
        await release.promise;
      },
    });

    const request = manager.getAccessToken(ref);
    await Promise.race([
      entered.promise,
      Bun.sleep(500).then(() => {
        throw new Error("lock-hold-forever did not enter its hold seam");
      }),
    ]);
    expect(readHolder(lockPath)).not.toBeNull();
    expect(exchangeCalls).toBe(0);

    release.resolve(undefined);
    expect((await request).accessToken).toBe("access-new");
    expect(existsSync(lockPath)).toBe(false);

    // Mutation caught: accept lock-hold-forever without invoking holdForever.
    // The exchange runs before the hold barrier can be observed.
  });

  test("steal-lock-mid-exchange fences the original holder before its final write", async () => {
    const store = new MemoryStore(stored());
    const lockPath = join(dir, "steal-mid-exchange.lock");
    const manager = new TokenManager({
      store,
      exchange: {
        refresh: async () => ({
          accessToken: "access-new",
          refreshToken: "refresh-new",
          expiresAt: NOW + 3_600_000,
        }),
      },
      now: () => NOW,
      lockPathFor: () => lockPath,
      env: faultEnv("steal-lock-mid-exchange"),
    });

    await expect(manager.getAccessToken(ref)).rejects.toBeInstanceOf(RefreshUnavailableError);
    expect(store.value?.accessToken).toBe("access-old");
    expect(store.value?.journal?.state).toBe("refreshing");
    expect(readHolder(lockPath)?.nonce).toBeDefined();

    // Mutation caught: accept steal-lock-mid-exchange without replacing the gate
    // nonce. The final persist succeeds and returns access-new.
  });

  test("steal-lock-after-fence changes the gate during the documented final-write window", async () => {
    const store = new MemoryStore(stored());
    const lockPath = join(dir, "steal-after-fence.lock");
    const manager = new TokenManager({
      store,
      exchange: {
        refresh: async () => ({
          accessToken: "access-new",
          refreshToken: "refresh-new",
          expiresAt: NOW + 3_600_000,
        }),
      },
      now: () => NOW,
      lockPathFor: () => lockPath,
      env: faultEnv("steal-lock-after-fence"),
    });

    const result = await manager.getAccessToken(ref);

    expect(result.accessToken).toBe("access-new");
    expect(store.value?.accessToken).toBe("access-new");
    expect(readHolder(lockPath)?.nonce).toBeDefined();

    // Mutation caught: merely log steal-lock-after-fence, or inject it before the
    // fence. The successor lock is absent, or the final write is rejected.
  });

  test("crash-after-refresh exits with the durable journal still open", async () => {
    const tokenPath = join(dir, "crash-token.json");
    const lockPath = join(dir, "crash-refresh.lock");
    const fileStore = new FileTokenStore({ pathFor: () => tokenPath });
    await fileStore.write(ref, stored());
    const tokenStoreUrl = pathToFileURL(join(import.meta.dir, "token-store.ts")).href;
    const tokenManagerUrl = pathToFileURL(join(import.meta.dir, "token-manager.ts")).href;
    const worker = `
      const [{ FileTokenStore }, { TokenManager }] = await Promise.all([
        import(${JSON.stringify(tokenStoreUrl)}),
        import(${JSON.stringify(tokenManagerUrl)})
      ]);
      const ref = { provider: "openai-codex", id: "abc123def456", label: "work" };
      const store = new FileTokenStore({ pathFor: () => process.env.CLAUDISH_WORKER_TOKEN_PATH });
      const manager = new TokenManager({
        store,
        exchange: {
          refresh: async () => ({
            accessToken: "access-new",
            refreshToken: "refresh-new",
            expiresAt: ${NOW + 3_600_000}
          })
        },
        now: () => ${NOW},
        lockPathFor: () => process.env.CLAUDISH_WORKER_LOCK_PATH,
        env: process.env
      });
      await manager.getAccessToken(ref);
    `;
    const child = Bun.spawn([process.execPath, "--eval", worker], {
      env: {
        ...process.env,
        ...faultEnv("crash-after-refresh"),
        CLAUDISH_WORKER_TOKEN_PATH: tokenPath,
        CLAUDISH_WORKER_LOCK_PATH: lockPath,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    expect(exitCode).toBe(9);
    expect(stderr).not.toContain("must-not");
    const disk = JSON.parse(readFileSync(tokenPath, "utf8")) as StoredTokenRecord;
    expect(disk.accessToken).toBe("access-old");
    expect(disk.journal?.state).toBe("refreshing");
    expect(existsSync(lockPath)).toBe(true);

    // PROVISIONAL: constructed successful OAuth result; replace it with a captured
    // Codex refresh response when the Phase V probe is recorded.
    // Mutation caught: accept crash-after-refresh without exiting between the
    // exchange and final write. The child exits 0 and access-new reaches disk.
  });

  test("serializes four OS processes against a rotating endpoint and never refreshes unlocked", async () => {
    const tokenPath = join(dir, "shared-token.json");
    const lockPath = join(dir, "shared-refresh.lock");
    const fileStore = new FileTokenStore({ pathFor: () => tokenPath });
    await fileStore.write(ref, stored());

    let validRefreshToken = "refresh-old";
    let exchangeCount = 0;
    const endpoint = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const presented = await request.text();
        if (presented !== validRefreshToken) {
          // PROVISIONAL: constructed invalid_grant response. Replace with a real
          // rotating Codex endpoint capture from the Phase V concurrency probe.
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        exchangeCount++;
        const nextGeneration = exchangeCount;
        validRefreshToken = `refresh-${nextGeneration}`;
        await Bun.sleep(150);
        return Response.json({
          accessToken: `access-${nextGeneration}`,
          refreshToken: validRefreshToken,
          expiresAt: NOW + 3_600_000,
        });
      },
    });

    const tokenStoreUrl = pathToFileURL(join(import.meta.dir, "token-store.ts")).href;
    const tokenManagerUrl = pathToFileURL(join(import.meta.dir, "token-manager.ts")).href;
    const worker = `
      const [{ FileTokenStore }, { InvalidGrantError, TokenManager }] = await Promise.all([
        import(${JSON.stringify(tokenStoreUrl)}),
        import(${JSON.stringify(tokenManagerUrl)})
      ]);
      const ref = { provider: "openai-codex", id: "abc123def456", label: "work" };
      const store = new FileTokenStore({ pathFor: () => process.env.CLAUDISH_WORKER_TOKEN_PATH });
      const exchange = {
        async refresh(record) {
          const response = await fetch(process.env.CLAUDISH_WORKER_ENDPOINT, {
            method: "POST",
            body: record.refreshToken
          });
          if (!response.ok) throw new InvalidGrantError("refresh token already used");
          return response.json();
        }
      };
      const manager = new TokenManager({
        store,
        exchange,
        now: () => ${NOW},
        lockPathFor: () => process.env.CLAUDISH_WORKER_LOCK_PATH
      });
      try {
        const result = await manager.getAccessToken(ref);
        process.stdout.write(JSON.stringify({ pid: process.pid, token: result.accessToken }));
      } catch (error) {
        process.stderr.write(error?.stack ?? String(error));
        process.exitCode = 1;
      }
    `;

    try {
      const children = Array.from({ length: 4 }, () =>
        Bun.spawn([process.execPath, "--eval", worker], {
          env: {
            ...process.env,
            CLAUDISH_DISABLE_KEYCHAIN: "1",
            CLAUDISH_WORKER_TOKEN_PATH: tokenPath,
            CLAUDISH_WORKER_LOCK_PATH: lockPath,
            CLAUDISH_WORKER_ENDPOINT: endpoint.url.toString(),
          },
          stdout: "pipe",
          stderr: "pipe",
        })
      );
      const results = await Promise.all(
        children.map(async (child) => {
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          return { exitCode, stdout, stderr };
        })
      );

      expect(results.map((result) => result.exitCode)).toEqual([0, 0, 0, 0]);
      expect(results.map((result) => result.stderr)).toEqual(["", "", "", ""]);
      const outputs = results.map(
        (result) => JSON.parse(result.stdout) as { pid: number; token: string }
      );
      expect(new Set(outputs.map((output) => output.pid)).size).toBe(4);
      expect(outputs.map((output) => output.token)).toEqual([
        "access-1",
        "access-1",
        "access-1",
        "access-1",
      ]);
      expect(exchangeCount).toBe(1);
      expect((await fileStore.read(ref, { uncached: true }))?.generation).toBe(1);
    } finally {
      endpoint.stop(true);
    }

    // Mutation caught: remove O_EXCL or skip the under-lock re-read. More than
    // one child presents refresh-old; the rotating endpoint records extra
    // exchanges or returns invalid_grant.
  }, 15_000);
});
