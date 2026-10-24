import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeychainTestDeps } from "../../providers/keychain.js";
import {
  FileTokenStore,
  KeychainTokenStore,
  type StoredTokenRecord,
  type TokenStore,
  TokenStoreReadError,
  fingerprintOf,
} from "./token-store.js";
import type { AccountRef } from "./types.js";

const ref: AccountRef = {
  provider: "openai-codex",
  id: "abc123def456",
  label: "work",
};
let dir = "";
let previousKeychainFile: string | undefined;

function record(): StoredTokenRecord {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: Date.parse("2026-09-12T13:00:00.000Z"),
    generation: 2,
    fingerprint: fingerprintOf("refresh-token"),
    updatedAt: Date.parse("2026-09-12T12:00:00.000Z"),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-token-store-test-"));
  previousKeychainFile = process.env.CLAUDISH_KEYCHAIN_FILE;
  process.env.CLAUDISH_KEYCHAIN_FILE = join(dir, "isolated.keychain-db");
});

afterEach(() => {
  setKeychainTestDeps(null);
  if (previousKeychainFile === undefined) delete process.env.CLAUDISH_KEYCHAIN_FILE;
  else process.env.CLAUDISH_KEYCHAIN_FILE = previousKeychainFile;
  rmSync(dir, { recursive: true, force: true });
});

describe("account token stores", () => {
  test("KeychainTokenStore reads only from the claudish-accounts service", async () => {
    const calls: string[][] = [];
    setKeychainTestDeps({
      platform: () => "darwin",
      run: (args) => {
        calls.push(args);
        // PROVISIONAL: constructed item-not-found result. Replace with the real
        // `security find-generic-password` exit-44 transcript captured in
        // ai-docs/reports/keychain-security-cli-measurements.md §7.
        return { code: 44, stdout: "", stderr: "item not found" };
      },
    });
    const store = new KeychainTokenStore({ env: {} });

    expect(await store.read(ref)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "find-generic-password",
      "-s",
      "claudish-accounts",
      "-a",
      "openai-codex:abc123def456",
      "-w",
      join(dir, "isolated.keychain-db"),
    ]);
    expect(calls[0]?.[2]).not.toBe("claudish");

    // Mutation caught: change KEYCHAIN_ACCOUNTS_SERVICE to `claudish`; the exact
    // service argument changes and would make env hydration see the token blob.
  });

  test("KeychainTokenStore honors its own disable flag without invoking security", async () => {
    let securityCalls = 0;
    let fallbackReads = 0;
    setKeychainTestDeps({
      platform: () => "darwin",
      run: () => {
        securityCalls++;
        throw new Error("security must not be called");
      },
    });
    const fallback: TokenStore = {
      kind: "file",
      read: async () => {
        fallbackReads++;
        return record();
      },
      write: async () => {},
      delete: async () => {},
      describe: () => "isolated fallback",
    };
    const store = new KeychainTokenStore({
      env: { CLAUDISH_DISABLE_KEYCHAIN: "1" },
      fallback,
    });

    expect((await store.read(ref))?.accessToken).toBe("access-token");
    expect(fallbackReads).toBe(1);
    expect(securityCalls).toBe(0);

    // Mutation caught: remove KeychainTokenStore.disabled(); the test invokes the
    // injected security runner instead of the isolated fallback.
  });

  test("a keychain read failure throws and is never reported as absence", async () => {
    setKeychainTestDeps({
      platform: () => "darwin",
      run: () => {
        // PROVISIONAL: constructed locked-keychain failure. Replace with a real
        // throwaway-keychain transcript captured via the procedure in keychain.md.
        return { code: 1, stdout: "", stderr: "User interaction is not allowed" };
      },
    });
    const store = new KeychainTokenStore({ env: {} });

    await expect(store.read(ref)).rejects.toBeInstanceOf(TokenStoreReadError);
    await expect(store.read(ref)).rejects.toThrow("User interaction is not allowed");

    // Mutation caught: catch a non-44 security failure and return null, collapsing
    // an unreadable keychain into a confirmed missing token.
  });

  test("store-read-throws makes a readable file-store path fail rather than look absent", async () => {
    const store = new FileTokenStore({
      pathFor: () => join(dir, "missing-but-faulted.json"),
      env: {
        CLAUDISH_TEST_UPSTREAM: "http://127.0.0.1:4010",
        CLAUDISH_ACCOUNTS_FAULT: "store-read-throws",
      },
    });

    await expect(store.read(ref)).rejects.toBeInstanceOf(TokenStoreReadError);
    await expect(store.read(ref)).rejects.toThrow("CLAUDISH_ACCOUNTS_FAULT=store-read-throws");

    // Mutation caught: accept store-read-throws in accountsFault() without calling
    // faultStoreRead; the missing path returns null as a clean absence.
  });

  test("FileTokenStore writes token material with mode 0600", async () => {
    const path = join(dir, "tokens", "openai-codex", `${ref.id}.json`);
    const store = new FileTokenStore({ pathFor: () => path });

    await store.write(ref, record());

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect((await store.read(ref))?.refreshToken).toBe("refresh-token");

    // Mutation caught: drop the explicit post-write 0600 mode; a permissive file
    // mode makes this assertion read 0644 under the normal test umask.
  });
});
