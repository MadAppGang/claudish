import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHolder } from "./file-lock.js";
import { blockerFor } from "./policy.js";
import { AccountRegistry, setAccountRegistryForTests } from "./registry.js";
import {
  type AccountsState,
  StateStore,
  getStateStore,
  setStateStoreForTests,
} from "./state-store.js";
import type { AccountRef, UsageSnapshot } from "./types.js";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");
const work: AccountRef = { provider: "openai-codex", id: "abc123def456", label: "work" };
let dir = "";
let statePath = "";
let lockPath = "";

function usage(observedAt: number, usedFraction: number): UsageSnapshot {
  return {
    observedAt,
    windows: [
      {
        slot: "primary",
        displayId: "7d",
        lengthMinutes: 10_080,
        usedFraction,
        resetAt: NOW + 60_000,
      },
    ],
  };
}

function writeState(value: unknown): string {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(statePath, text, "utf8");
  return text;
}

function readState(): AccountsState {
  return JSON.parse(readFileSync(statePath, "utf8")) as AccountsState;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-state-store-test-"));
  statePath = join(dir, "state.json");
  lockPath = join(dir, "state.lock");
});

afterEach(() => {
  setStateStoreForTests(null);
  setAccountRegistryForTests(null);
  try {
    chmodSync(dir, 0o700);
    chmodSync(statePath, 0o600);
  } catch {
    // The temp directory or state file may already be gone.
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("StateStore field-wise updates", () => {
  test("two writers preserve independent fields and newest observedAt wins", async () => {
    const writerA = new StateStore({ path: statePath, lockPath, now: () => NOW });
    const writerB = new StateStore({ path: statePath, lockPath, now: () => NOW });

    writerA.read();
    writerB.read();
    await writerA.markExhausted(work, NOW + 120_000);
    // Hold a stale view in A while B publishes the newest usage observation.
    writerA.read(true);
    await writerB.recordUsage(work, usage(NOW + 2_000, 0.8));
    await writerA.recordUsage(work, usage(NOW + 1_000, 0.3));

    const state = readState().providers["openai-codex"]?.accounts[work.id];
    expect(state?.exhaustedUntil).toBe(NOW + 120_000);
    expect(state?.usage?.observedAt).toBe(NOW + 2_000);
    expect(state?.usage?.windows[0]?.usedFraction).toBe(0.8);

    // Mutation caught: persist the pre-lock cached snapshot or replace the whole
    // account node; either erases B's newer usage or A's exhaustion mark.
  });

  test("active compare-and-set re-reads and refuses to reapply a deleted target", async () => {
    writeState({
      version: 1,
      providers: {
        "openai-codex": {
          active: "account-a",
          accounts: { "account-a": {}, "account-b": {} },
        },
      },
    });
    const live = new Set(["account-a", "account-b"]);
    const writerA = new StateStore({
      path: statePath,
      lockPath,
      accountListHas: (_provider, id) => live.has(id),
    });
    const writerB = new StateStore({
      path: statePath,
      lockPath,
      accountListHas: (_provider, id) => live.has(id),
    });

    writerA.read();
    await writerB.setActive("openai-codex", "account-b", "account-a");
    await writerA.setActive("openai-codex", "account-deleted", "account-a");

    expect(readState().providers["openai-codex"]?.active).toBe("account-b");

    // Mutation caught: skip the under-lock CAS/reapply account-list check, which points
    // active at account-deleted after the concurrent move to account-b.
  });

  test("publishes state by atomic replacement and leaves old bytes intact when temp creation fails", async () => {
    const lockedDir = join(dir, "read-only");
    const protectedState = join(lockedDir, "state.json");
    const separateLock = join(dir, "writable-state.lock");
    mkdirSync(lockedDir);
    await Bun.write(
      protectedState,
      `${JSON.stringify({ version: 1, providers: {}, sentinel: "old-complete-document" })}\n`
    );
    const oldBytes = readFileSync(protectedState, "utf8");
    chmodSync(lockedDir, 0o500);
    const store = new StateStore({ path: protectedState, lockPath: separateLock, now: () => NOW });

    try {
      await expect(store.markExhausted(work, NOW + 60_000)).resolves.toBe(false);
      expect(store.dropped()).toContainEqual({
        field: "exhaustedUntil",
        account: work.label,
        reason: expect.stringMatching(/^state\.json could not be written/),
        at: NOW,
      });
      expect(store.stateFor(work).state.exhaustedUntil).toBe(NOW + 60_000);
      expect(readFileSync(protectedState, "utf8")).toBe(oldBytes);
      expect(readdirSync(lockedDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
    } finally {
      chmodSync(lockedDir, 0o700);
    }

    // Mutation caught: replace temp+rename with a truncating write to the existing
    // writable file; that write succeeds despite the non-writable directory and
    // changes the old bytes instead of failing before publication.
  });

  test("an exhaustedUntil in the past clears lazily at the selection boundary", () => {
    writeState({
      version: 1,
      providers: {
        "openai-codex": {
          accounts: { [work.id]: { exhaustedUntil: NOW - 1 } },
        },
      },
    });
    const store = new StateStore({ path: statePath, lockPath, now: () => NOW });
    const { state } = store.stateFor(work);

    expect(
      blockerFor(
        {
          ref: work,
          order: 0,
          enabled: true,
          usage: null,
          usageFailed: false,
          exhaustedUntil: state.exhaustedUntil,
          needsReauth: null,
          isActive: true,
        },
        NOW,
        { now: NOW }
      )
    ).toBeNull();

    // Mutation caught: treat any stored exhaustedUntil as blocking without first
    // comparing it to the injected clock.
  });

  test("never overwrites another account when state.json cannot be read under the lock", async () => {
    const other: AccountRef = {
      provider: "openai-codex",
      id: "def456abc123",
      label: "personal",
    };
    writeState({
      version: 1,
      providers: {
        "openai-codex": {
          accounts: {
            [work.id]: { lastSeenAt: NOW - 2_000 },
            [other.id]: { exhaustedUntil: NOW + 300_000, lastSeenAt: NOW - 1_000 },
          },
        },
      },
    });
    chmodSync(statePath, 0o000);
    const store = new StateStore({ path: statePath, lockPath, now: () => NOW });

    expect(store.read().kind).toBe("failed");
    expect(await store.markExhausted(work, NOW + 60_000)).toBe(false);
    chmodSync(statePath, 0o600);

    const disk = readState();
    expect(disk.providers["openai-codex"]?.accounts[other.id]).toEqual({
      exhaustedUntil: NOW + 300_000,
      lastSeenAt: NOW - 1_000,
    });
    expect(disk.providers["openai-codex"]?.accounts[work.id]?.exhaustedUntil).toBeUndefined();
    expect(store.dropped()[0]?.reason).toContain("was not overwritten");

    // Mutation caught: turn every under-lock read failure into an empty document
    // and persist A's mark; B's complete state disappears from disk.
  });

  test("moves corrupt state aside before starting a fresh document", async () => {
    writeFileSync(statePath, "{not-json", "utf8");
    const store = new StateStore({ path: statePath, lockPath, now: () => NOW });

    expect(store.read().kind).toBe("failed");
    expect(await store.markExhausted(work, NOW + 60_000)).toBe(true);

    const evidencePath = `${statePath}.corrupt-${NOW}`;
    expect(readFileSync(evidencePath, "utf8")).toBe("{not-json");
    expect(readState().providers["openai-codex"]?.accounts[work.id]?.exhaustedUntil).toBe(
      NOW + 60_000
    );

    // Mutation caught: overwrite a corrupt document in place instead of moving
    // the original bytes aside under state.lock.
  });

  test("revalidates cached state and observes a second writer without writing itself", async () => {
    writeState({ version: 1, providers: {} });
    const reader = new StateStore({ path: statePath, lockPath, now: () => NOW });
    const writer = new StateStore({ path: statePath, lockPath, now: () => NOW });
    const other: AccountRef = {
      provider: "openai-codex",
      id: "def456abc123",
      label: "personal",
    };

    expect(reader.read().state.providers["openai-codex"]).toBeUndefined();
    await writer.markExhausted(other, NOW + 90_000);

    expect(reader.stateFor(other).state.exhaustedUntil).toBe(NOW + 90_000);

    // Mutation caught: return the process cache forever when force=false. The
    // reader keeps its original empty view after the second writer commits.
  });

  test("carries a lock-dropped mark into the next successful write", async () => {
    const other: AccountRef = {
      provider: "openai-codex",
      id: "def456abc123",
      label: "personal",
    };
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 42, host: "foreign-host", nonce: "remote", at: NOW })}\n`,
      "utf8"
    );
    const store = new StateStore({
      path: statePath,
      lockPath,
      now: () => NOW,
      lockDeps: { hostname: () => "local-host" },
    });

    expect(await store.markExhausted(work, NOW + 120_000)).toBe(false);
    expect(store.stateFor(work).state.exhaustedUntil).toBe(NOW + 120_000);
    expect(store.dropped()).toHaveLength(1);

    rmSync(lockPath);
    await store.recordUsage(other, usage(NOW, 0.2));

    const disk = readState().providers["openai-codex"]?.accounts;
    expect(disk?.[work.id]?.exhaustedUntil).toBe(NOW + 120_000);
    expect(disk?.[other.id]?.usage?.windows[0]?.usedFraction).toBe(0.2);
    expect(store.dropped()).toEqual([]);

    // Mutation caught: clear the pending overlay after any successful write. A's
    // dropped exhaustion mark vanishes when B's usage write lands.
  });

  test("the process StateStore refuses an active id removed from the account list", async () => {
    const configPath = join(dir, "config.json");
    const legacyPath = join(dir, "codex-oauth.json");
    const accountsDirectory = join(dir, "process-accounts");
    const previousAccountsDir = process.env.CLAUDISH_ACCOUNTS_DIR;
    process.env.CLAUDISH_ACCOUNTS_DIR = accountsDirectory;
    const accountList = new AccountRegistry({
      configPath: () => configPath,
      legacyCodexPath: () => legacyPath,
      env: { CLAUDISH_DISABLE_KEYCHAIN: "1" },
    });
    setAccountRegistryForTests(accountList);
    setStateStoreForTests(null);

    try {
      writeFileSync(
        configPath,
        `${JSON.stringify({
          version: "1.0.0",
          defaultProfile: "default",
          profiles: {},
          subscriptionAccounts: {
            "openai-codex": {
              generation: 1,
              accounts: [
                {
                  id: work.id,
                  label: work.label,
                  store: "file",
                  addedAt: "2026-09-12T00:00:00.000Z",
                },
              ],
            },
          },
        })}\n`,
        "utf8"
      );
      expect(accountList.hasConfiguredAccounts("openai-codex")).toBe(true);

      writeFileSync(
        configPath,
        `${JSON.stringify({
          version: "1.0.0",
          defaultProfile: "default",
          profiles: {},
          subscriptionAccounts: {
            "openai-codex": { generation: 2, accounts: [] },
          },
        })}\n`,
        "utf8"
      );
      accountList.invalidate();
      expect(accountList.hasConfiguredAccounts("openai-codex")).toBe(false);

      const subject = getStateStore();
      expect(await subject.setActive("openai-codex", work.id)).toBe(true);
      expect(subject.activeId("openai-codex")).toBeUndefined();
      const disk = JSON.parse(
        readFileSync(join(accountsDirectory, "state.json"), "utf8")
      ) as AccountsState;
      expect(disk.providers["openai-codex"]?.active).toBeUndefined();
    } finally {
      setStateStoreForTests(null);
      setAccountRegistryForTests(null);
      if (previousAccountsDir === undefined) delete process.env.CLAUDISH_ACCOUNTS_DIR;
      else process.env.CLAUDISH_ACCOUNTS_DIR = previousAccountsDir;
    }

    // Mutation caught: construct the process store without accountListHas. Its
    // permissive default writes a sticky pointer to the deleted account.
  });

  test("rechecks state.lock ownership immediately before publishing", async () => {
    writeState({
      version: 1,
      providers: {
        "openai-codex": { active: work.id, accounts: { [work.id]: {} } },
      },
    });
    let replaced = false;
    const store = new StateStore({
      path: statePath,
      lockPath,
      now: () => NOW,
      accountListHas: () => {
        if (!replaced) {
          const current = readHolder(lockPath);
          if (!current) throw new Error("expected state.lock to be held");
          writeFileSync(
            lockPath,
            `${JSON.stringify({ ...current, nonce: "successor-nonce" })}\n`,
            "utf8"
          );
          replaced = true;
        }
        return true;
      },
    });

    expect(await store.setActive("openai-codex", "def456abc123", work.id)).toBe(false);
    expect(readState().providers["openai-codex"]?.active).toBe(work.id);
    expect(store.dropped()[0]?.reason).toContain("state.lock was lost before the write");

    // Mutation caught: remove the final handle.holdsLock() fence in
    // writeUnderLock; the stolen-from writer publishes the new active id.
  });
});
