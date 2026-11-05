/**
 * The two empty-store branches under the refresh gate re-validate the row
 * before demanding a login (MTL-372 review round 2, Gemini G3).
 *
 * `resolve` already asks `validateAccount(ref, "store-empty")` when the store
 * is empty. `refreshUnderGate` (the uncached re-read under the gate) and
 * `exchangeAndPersist` (the re-read after the vendor rotated) threw
 * `NeedsReauthError` straight away, so a store emptied there by a store-only
 * move answered a terminal 401 instead of the transient retry.
 *
 * Isolation: injected store, exchange and validator; the gate lives in a temp
 * directory. No Keychain, no real ~/.claudish, no network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NeedsReauthError, RefreshUnavailableError } from "./errors.js";
import { TokenManager } from "./token-manager.js";
import { type StoredTokenRecord, type TokenStore, fingerprintOf } from "./token-store.js";
import type { AccountRef } from "./types.js";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const REF: AccountRef = { provider: "openai-codex", id: "4463fa7e5c82", label: "default" };

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-tm-store-empty-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function expiring(): StoredTokenRecord {
  return {
    accessToken: "access-old",
    refreshToken: "refresh-old",
    expiresAt: NOW - 1_000,
    generation: 1,
    fingerprint: fingerprintOf("refresh-old"),
    accountId: "acct-owner",
    updatedAt: NOW,
  };
}

/** `answers[i]` is what read i returns; the last one repeats. */
function managerWith(
  answers: Array<StoredTokenRecord | null>,
  validate: (phase: string) => void
): { manager: TokenManager; phases: string[]; exchanges: () => number } {
  const phases: string[] = [];
  let reads = 0;
  let exchanges = 0;
  const store: TokenStore = {
    kind: "file",
    read: async () => answers[Math.min(reads++, answers.length - 1)] ?? null,
    write: async () => {},
    delete: async () => {},
    describe: () => "isolated fake store",
  };
  const manager = new TokenManager({
    store,
    exchange: {
      refresh: async () => {
        exchanges++;
        return {
          accessToken: "access-new",
          refreshToken: "refresh-new",
          expiresAt: NOW + 3_600_000,
        };
      },
    },
    lockPathFor: () => join(dir, "gate.lock"),
    now: () => NOW,
    env: {},
    validateAccount: (_ref, phase) => {
      phases.push(phase);
      validate(phase);
    },
  });
  return { manager, phases, exchanges: () => exchanges };
}

const movedOnEmpty = (phase: string) => {
  if (phase === "store-empty") throw new RefreshUnavailableError("account store moved");
};

describe("empty store under the refresh gate (G3)", () => {
  test("refreshUnderGate: emptied before the uncached re-read is re-validated", async () => {
    // Read 1: resolve (expiring, so a refresh). Read 2: the uncached re-read, empty.
    const { manager, phases, exchanges } = managerWith([expiring(), null], movedOnEmpty);

    const err = await manager.getAccessToken(REF).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RefreshUnavailableError);
    expect(err).not.toBeInstanceOf(NeedsReauthError);
    expect(phases).toEqual(["before-exchange", "store-empty"]);
    expect(exchanges()).toBe(0);
    // Mutation caught: refreshUnderGate throws NeedsReauthError without asking.
  });

  test("exchangeAndPersist: emptied during the exchange is re-validated", async () => {
    // Reads 1-2 as above but present; read 3 (after the exchange) is empty.
    const { manager, phases, exchanges } = managerWith(
      [expiring(), expiring(), null],
      movedOnEmpty
    );

    const err = await manager.getAccessToken(REF).catch((e: unknown) => e);

    expect(exchanges()).toBe(1);
    expect(err).toBeInstanceOf(RefreshUnavailableError);
    expect(err).not.toBeInstanceOf(NeedsReauthError);
    expect(phases).toEqual(["before-exchange", "before-persist", "store-empty"]);
    // Mutation caught: exchangeAndPersist throws NeedsReauthError without asking.
  });

  test("control: a validator that accepts the row leaves the login demand", async () => {
    const { manager } = managerWith([expiring(), null], () => {});

    const err = await manager.getAccessToken(REF).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NeedsReauthError);
  });
});
