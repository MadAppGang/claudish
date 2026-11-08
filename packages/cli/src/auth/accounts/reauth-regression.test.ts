import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountPool } from "./pool.js";
import { AccountRegistry } from "./registry.js";
import { StateStore } from "./state-store.js";
import { ExchangeOutcomeUnknownError, InvalidGrantError, TokenManager } from "./token-manager.js";
import { type StoredTokenRecord, type TokenStore, fingerprintOf } from "./token-store.js";
import {
  type AccountRef,
  NeedsReauthError,
  PersistOutcomeUnknownError,
  RefreshUnavailableError,
} from "./types.js";

const NOW = 1_800_000_000_000;
const ref: AccountRef = { provider: "openai-codex", id: "abc123def456", label: "work" };
let dir: string;
let now: number;
let state: StateStore;
let exchanges: number;
let networkCalls: number;
const realFetch = globalThis.fetch;

// PROVISIONAL: synthetic token material; replace with sanitized Phase V token records.
function record(refreshToken = "old", generation = 4): StoredTokenRecord {
  return {
    accessToken: "access",
    refreshToken,
    generation,
    fingerprint: fingerprintOf(refreshToken),
    expiresAt: NOW + 3_600_000,
    updatedAt: NOW,
  };
}
class Store implements TokenStore {
  readonly kind = "file" as const;
  value = record();
  writes: StoredTokenRecord[] = [];
  async read() {
    return structuredClone(this.value);
  }
  async write(_ref: AccountRef, value: StoredTokenRecord) {
    this.writes.push(structuredClone(value));
    this.value = structuredClone(value);
  }
  async delete() {}
  describe() {
    return "isolated memory store";
  }
}
function mark(value = record(), attempts = 3) {
  return {
    since: now,
    attempts,
    lastReason: "the vendor rejected the refresh token",
    failedFingerprint: value.fingerprint,
    failedGeneration: value.generation,
  };
}
function manager(
  store: Store,
  refresh = async () => {
    exchanges++;
    throw new InvalidGrantError();
  }
) {
  return new TokenManager({
    store,
    state,
    exchange: { refresh },
    now: () => now,
    lockPathFor: () => join(dir, "refresh.lock"),
    newWriteId: (() => {
      let n = 0;
      return () => `write-${++n}`;
    })(),
  });
}
function pool(store: TokenStore) {
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      subscriptionAccounts: {
        "openai-codex": {
          generation: 1,
          accounts: [
            { id: ref.id, label: ref.label, store: "file", addedAt: "2026-09-12T00:00:00Z" },
          ],
        },
      },
    })
  );
  return new AccountPool("openai-codex", {
    registry: new AccountRegistry({
      configPath: () => configPath,
      legacyCodexPath: () => join(dir, "missing.json"),
    }),
    state,
    now: () => now,
    storeFactory: () => store,
    env: { CLAUDISH_DISABLE_KEYCHAIN: "1", CLAUDISH_ACCOUNTS_DIR: dir },
  });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-reauth-final-"));
  now = NOW;
  exchanges = 0;
  networkCalls = 0;
  // PROVISIONAL: replace this invalid_grant response with a sanitized Phase V capture.
  globalThis.fetch = (async () => {
    networkCalls++;
    return Response.json({ error: "invalid_grant", error_description: "revoked" }, { status: 400 });
  }) as unknown as typeof fetch;
  state = new StateStore({
    path: join(dir, "state.json"),
    lockPath: join(dir, "state.lock"),
    now: () => now,
  });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

for (const moved of [record("new"), record("old", 5)]) {
  test(`acquire heals immediately at ${moved.fingerprint}/${moved.generation}`, async () => {
    // Mutation: remove acquire's pre-selection heal, or either material comparison.
    await state.setNeedsReauth(ref, mark());
    const store = new Store();
    store.value = moved;
    let writes = 0;
    store.write = async () => {
      writes++;
      throw new Error("no exchange or journal expected");
    };
    const p = pool(store);
    expect((await p.acquire()).accessToken).toBe("access");
    expect((await p.acquire()).account.id).toBe(ref.id);
    expect(writes).toBe(0);
    expect(networkCalls).toBe(0);
    expect(state.stateFor(ref).state.needsReauth).toBeUndefined();
    const disk = new StateStore({
      path: join(dir, "state.json"),
      lockPath: join(dir, "state.lock"),
    });
    expect(disk.stateFor(ref).state.needsReauth).toBeUndefined();
  });
}

for (const [attempts, delay] of [
  [1, 60_000],
  [2, 300_000],
  [3, 1_800_000],
] as const) {
  test(`same material remains blocked for retry interval ${delay}`, async () => {
    // Mutation: heal unchanged material or flatten the 1/5/30-minute schedule.
    await state.setNeedsReauth(ref, mark(record(), attempts));
    const store = new Store();
    const p = pool(store);
    now += delay - 1;
    await expect(p.acquire()).rejects.toBeInstanceOf(NeedsReauthError);
    expect(state.stateFor(ref).state.needsReauth?.attempts).toBe(attempts);
    expect(networkCalls).toBe(0);
    now++;
    await expect(p.acquire()).rejects.toBeInstanceOf(NeedsReauthError);
    expect(networkCalls).toBe(1);
    expect(state.stateFor(ref).state.needsReauth?.attempts).toBe(attempts + 1);
    await expect(p.acquire()).rejects.toBeInstanceOf(NeedsReauthError);
    expect(networkCalls).toBe(1);
  });
}

test("an unreadable store cannot heal a mark during acquire", async () => {
  // Mutation: treat a failed probe as moved material.
  const baseline = mark();
  await state.setNeedsReauth(ref, baseline);
  const store = new Store();
  store.read = async () => {
    throw new Error("EACCES");
  };
  await expect(pool(store).acquire()).rejects.toBeInstanceOf(NeedsReauthError);
  expect(state.stateFor(ref).state.needsReauth).toEqual(baseline);
});

test("compare-and-clear preserves a newer failure and clears only the observed pair", async () => {
  // Mutation: remove failedAgainst, or compare only fingerprint and ignore generation.
  const baseline = mark();
  for (const newer of [mark(record("new")), mark(record("old", 5))]) {
    await state.setNeedsReauth(ref, newer);
    await state.clearNeedsReauth(ref, {
      failedAgainst: {
        failedFingerprint: baseline.failedFingerprint,
        failedGeneration: baseline.failedGeneration,
      },
    });
    expect(state.stateFor(ref).state.needsReauth).toEqual(newer);
    await state.clearNeedsReauth(ref, {
      failedAgainst: {
        failedFingerprint: newer.failedFingerprint,
        failedGeneration: newer.failedGeneration,
      },
    });
    expect(state.stateFor(ref).state.needsReauth).toBeUndefined();
  }
});

for (const interrupted of [false, true]) {
  test(`invalid_grant closes journal and retains ${interrupted ? "interrupted" : "revoked"} diagnosis on retry`, async () => {
    // Mutations: omit closeAnsweredJournal, bump generation on close, reuse writeId,
    // drop markedDead, or recompute the interrupted reason on the second failure.
    const store = new Store();
    if (interrupted)
      store.value.journal = {
        state: "refreshing",
        from: store.value.fingerprint,
        at: now,
        pid: 1,
        host: "other",
        nonce: "predecessor",
      };
    const tm = manager(store);
    await expect(tm.getAccessToken(ref, { forceRefresh: true })).rejects.toBeInstanceOf(
      NeedsReauthError
    );
    expect(exchanges).toBe(1);
    expect(store.value.journal).toBeNull();
    expect(store.value.fingerprint).toBe(record().fingerprint);
    expect(store.value.generation).toBe(4);
    expect(store.writes.at(-1)?.writeId).not.toBe(store.writes.at(-2)?.writeId);
    const first = state.stateFor(ref).state.needsReauth;
    expect(first?.failedFingerprint).toBe(record().fingerprint);
    expect(first?.failedGeneration).toBe(4);
    expect(first?.lastReason).toContain(
      interrupted ? "a token rotation was interrupted" : "the vendor rejected"
    );
    now += 60_001;
    await expect(tm.getAccessToken(ref)).rejects.toBeInstanceOf(NeedsReauthError);
    expect(exchanges).toBe(2);
    expect(state.stateFor(ref).state.needsReauth?.lastReason).toBe(first?.lastReason);
    expect(state.stateFor(ref).state.needsReauth?.attempts).toBe(2);
    expect(await tm.healNeedsReauth(ref)).toBe(false);
    store.value = record("replacement");
    expect(await tm.healNeedsReauth(ref)).toBe(true);
    expect(state.stateFor(ref).state.needsReauth).toBeUndefined();
  });
}

for (const failure of [
  new Error("token refresh failed: 500"),
  new ExchangeOutcomeUnknownError("timeout after send"),
]) {
  test(`${failure.message} keeps the journal open`, async () => {
    // Mutation: close the journal in the generic/unknown exchange catch.
    const store = new Store();
    await expect(
      manager(store, async () => {
        throw failure;
      }).getAccessToken(ref, { forceRefresh: true })
    ).rejects.toBeInstanceOf(
      failure instanceof ExchangeOutcomeUnknownError
        ? PersistOutcomeUnknownError
        : RefreshUnavailableError
    );
    expect(store.value.journal).toBeTruthy();
    expect(state.stateFor(ref).state.needsReauth).toBeUndefined();
  });
}

test("acquire heal cannot erase a peer failure recorded between comparison and clear", async () => {
  // Mutation: remove compare-and-clear's failedAgainst guard.
  await state.setNeedsReauth(ref, mark());
  const newer = mark(record("new"));
  const peer = new StateStore({
    path: join(dir, "state.json"),
    lockPath: join(dir, "state.lock"),
    now: () => now,
  });
  const clear = state.clearNeedsReauth.bind(state);
  state.clearNeedsReauth = async (account, opts) => {
    await peer.setNeedsReauth(account, newer);
    return clear(account, opts);
  };
  const store = new Store();
  store.value = record("new");
  await expect(pool(store).acquire()).rejects.toBeInstanceOf(NeedsReauthError);
  expect(peer.stateFor(ref).state.needsReauth).toEqual(newer);
  expect(networkCalls).toBe(0);
});

test("a new credential's first rejection starts its own schedule", async () => {
  // Mutation: previousFailureOf inherits a mark about unrelated material.
  const store = new Store();
  store.value = record("new");
  const stale = mark();
  stale.since = now - 1_800_000;
  const tm = manager(store, async () => {
    // A stale writer reintroduces the old mark after the read-site heal.
    await state.setNeedsReauth(ref, stale);
    throw new InvalidGrantError();
  });
  await expect(tm.getAccessToken(ref, { forceRefresh: true })).rejects.toBeInstanceOf(
    NeedsReauthError
  );
  const failure = state.stateFor(ref).state.needsReauth;
  expect(failure?.attempts).toBe(1);
  expect(failure?.since).toBe(now);
  expect(failure?.failedFingerprint).toBe(store.value.fingerprint);
});

test("a second login mid-exchange is never overwritten by journal close", async () => {
  // Mutation: close unconditionally over the presented material after out-of-band retry.
  const store = new Store();
  let calls = 0;
  const tm = manager(store, async () => {
    calls++;
    store.value = record(calls === 1 ? "login-one" : "login-two", 4 + calls);
    throw new InvalidGrantError();
  });
  await expect(tm.getAccessToken(ref, { forceRefresh: true })).rejects.toBeInstanceOf(
    NeedsReauthError
  );
  expect(calls).toBe(2);
  expect(store.value).toEqual(record("login-two", 6));
  expect(store.writes.every((write) => !!write.journal)).toBe(true);
});

test("journal clear rechecks the fence after its uncached read", async () => {
  // Mutation: replace fenced persist with a direct store.write on journal close.
  const store = new Store();
  const read = store.read.bind(store);
  let rejected = false;
  let afterRejection = 0;
  store.read = async () => {
    if (rejected && ++afterRejection === 2) {
      const lock = join(dir, "refresh.lock");
      const holder = JSON.parse(readFileSync(lock, "utf8"));
      writeFileSync(lock, JSON.stringify({ ...holder, nonce: "successor" }));
    }
    return read();
  };
  await expect(
    manager(store, async () => {
      rejected = true;
      throw new InvalidGrantError();
    }).getAccessToken(ref, { forceRefresh: true })
  ).rejects.toBeInstanceOf(NeedsReauthError);
  expect(afterRejection).toBe(2);
  expect(store.writes).toHaveLength(1);
  expect(store.value.journal?.state).toBe("refreshing");
});

test("journal close failure still records needsReauth", async () => {
  // Mutation: let a close persist failure replace the definite invalid_grant.
  const store = new Store();
  const write = store.write.bind(store);
  store.write = async (account, value) => {
    if (!value.journal) throw new Error("close write failed");
    await write(account, value);
  };
  await expect(manager(store).getAccessToken(ref, { forceRefresh: true })).rejects.toBeInstanceOf(
    NeedsReauthError
  );
  expect(state.stateFor(ref).state.needsReauth?.failedFingerprint).toBe(record().fingerprint);
});
