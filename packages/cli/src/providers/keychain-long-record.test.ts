import { afterEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  KeychainTokenStore,
  type StoredTokenRecord,
  TokenStoreAmbiguousWriteError,
  TokenStoreWriteError,
  fingerprintOf,
} from "../auth/accounts/token-store.js";
import type { AccountRef } from "../auth/accounts/types.js";
import {
  type KeychainDeps,
  KeychainError,
  type KeychainRunResult,
  readKeychainItem,
  setKeychainTestDeps,
  writeKeychainItem,
} from "./keychain.js";

// Measured in root-cause.md §1 and §5: each 4095-character chunk executes,
// including an unterminated first command; only the LAST result survives.
function echoedCommand(chunk: string): KeychainRunResult {
  const command = chunk.trim();
  return {
    code: 1,
    stdout: "",
    stderr: `security: unknown command "${command}"\n${command}: returned 1\n`,
  };
}

function quotedOption(command: string, flag: string): string | undefined {
  const match = new RegExp(`(?:^| )${flag} "((?:\\\\.|[^"\\\\])*)`).exec(command);
  return match?.[1]?.replace(/\\([\\"])/g, "$1");
}

function measuredRunner() {
  const items = new Map<string, string>();
  const stdinCalls: string[] = [];
  const run: KeychainDeps["run"] = (args, stdin) => {
    if (args.length === 1 && args[0] === "-i") {
      if (stdin === undefined) throw new Error("missing test stdin");
      stdinCalls.push(stdin);
      let last: KeychainRunResult = { code: 0, stdout: "", stderr: "" };
      for (let offset = 0; offset < stdin.length; offset += 4095) {
        const chunk = stdin.slice(offset, offset + 4095);
        if (!chunk.startsWith("add-generic-password ")) {
          last = echoedCommand(chunk);
          continue;
        }
        const service = quotedOption(chunk, "-s");
        const account = quotedOption(chunk, "-a");
        const hex = quotedOption(chunk, "-X");
        const text = quotedOption(chunk, "-w");
        if (
          service === undefined ||
          account === undefined ||
          (hex === undefined && text === undefined)
        ) {
          throw new Error("unsupported test command");
        }
        items.set(
          JSON.stringify([service, account]),
          hex === undefined ? (text as string) : Buffer.from(hex, "hex").toString("utf8")
        );
        last = { code: 0, stdout: "", stderr: "" };
      }
      return last;
    }
    if (args[0] === "find-generic-password" && args.includes("-w")) {
      const service = args[args.indexOf("-s") + 1];
      const account = args[args.indexOf("-a") + 1];
      const value = items.get(JSON.stringify([service, account]));
      return value === undefined
        ? { code: 44, stdout: "", stderr: "" }
        : { code: 0, stdout: `${value}\n`, stderr: "" };
    }
    throw new Error(`unexpected test command: ${args[0]}`);
  };
  return { run, stdinCalls };
}

function installRunner(run: KeychainDeps["run"]) {
  setKeychainTestDeps({
    platform: () => "darwin",
    run,
    runAsync: async () => {
      throw new Error("unexpected asynchronous keychain call");
    },
    spawnAsync: () => {
      throw new Error("unexpected spawned keychain call");
    },
  });
}

function printable(length: number): string {
  return randomBytes(length).toString("base64url").slice(0, length);
}

function tokenRecord(bytes: number): StoredTokenRecord {
  const record: StoredTokenRecord = {
    accessToken: `${printable(24)}.${printable(1100)}.${printable(74)}`,
    refreshToken: "",
    expiresAt: Date.parse("2026-10-27T12:00:00.000Z"),
    accountId: "46230acd-be0b-4000-8000-000000000000",
    generation: 2,
    fingerprint: "0".repeat(16),
    updatedAt: Date.parse("2026-10-26T12:00:00.000Z"),
    writeId: printable(32),
  };
  record.refreshToken = printable(bytes - JSON.stringify(record).length);
  record.fingerprint = fingerprintOf(record.refreshToken);
  return record;
}

function captureError(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

function keychainError(action: () => void): KeychainError {
  const error = captureError(action);
  expect(error).toBeInstanceOf(KeychainError);
  return error as KeychainError;
}

function containsSlice(message: string, value: string): boolean {
  for (let offset = 0; offset <= value.length - 16; offset++) {
    if (message.includes(value.slice(offset, offset + 16))) return true;
  }
  return false;
}

const service = "claudish-accounts";
const account = "openai-codex:46230acdbe0b";
const ambiguousWrite = /killed by|timed out|ETIMEDOUT|EIO/i;
const ref: AccountRef = { provider: "openai-codex", id: "46230acdbe0b", label: "work" };

afterEach(() => {
  setKeychainTestDeps(null);
});

describe("writeKeychainItem long account records", () => {
  // REGRESSION: MTL-268 account add codex fails with the macOS Keychain store (security -i splits an over-long stdin line, and stderr echoes the secret) — Fixed in /dev:fix session dev-fix-20261026-115216-a3f9c1d2
  it("round-trips a 2.5 KB token record without splitting a security stdin line", () => {
    // Mutation caught: hex-only carriage doubles a realistic record past the stdin limit.
    const fake = measuredRunner();
    installRunner(fake.run);
    const record = JSON.stringify(tokenRecord(2560));
    expect(record.length).toBe(2560);

    const error = captureError(() => writeKeychainItem(service, account, record));
    expect({ writeSucceeded: error === undefined }).toEqual({ writeSucceeded: true });
    expect(fake.stdinCalls.length).toBeGreaterThan(0);
    for (const stdin of fake.stdinCalls) {
      for (const line of stdin.split("\n")) expect(line.length).toBeLessThanOrEqual(4095);
    }
    expect(readKeychainItem(service, account, { uncached: true })).toBe(record);
  });

  it("rejects a 5 KB printable value before security and without disclosing any slice", () => {
    // Mutation caught: removing the pre-spawn cap executes a truncated secret command.
    const fake = measuredRunner();
    installRunner(fake.run);
    const value = printable(5120);
    const error = keychainError(() => writeKeychainItem(service, account, value));

    expect(fake.stdinCalls).toHaveLength(0);
    expect(containsSlice(error.message, value)).toBe(false);
    expect(containsSlice(error.message, Buffer.from(value).toString("hex"))).toBe(false);
    expect(error.message).not.toMatch(ambiguousWrite);
  });

  it("accepts exactly 4000 stdin bytes and rejects 4001 before security", () => {
    // Mutation caught: moving the cap toward 4095 accepts a 4001-byte command.
    const fake = measuredRunner();
    installRunner(fake.run);
    const short = printable(10);
    writeKeychainItem(service, account, short);
    expect(fake.stdinCalls).toHaveLength(1);
    const overhead = Buffer.byteLength(fake.stdinCalls[0] as string, "utf8") - short.length;
    fake.stdinCalls.length = 0;

    const value = printable(4000 - overhead);
    writeKeychainItem(service, account, value);
    expect(fake.stdinCalls).toHaveLength(1);
    expect(Buffer.byteLength(fake.stdinCalls[0] as string, "utf8")).toBe(4000);
    expect(readKeychainItem(service, account, { uncached: true })).toBe(value);
    fake.stdinCalls.length = 0;

    keychainError(() => writeKeychainItem(service, account, `${value}a`));
    expect(fake.stdinCalls).toHaveLength(0);
  });

  it("counts multi-byte service characters as UTF-8 bytes in the cap", () => {
    // Mutation caught: comparing line.length accepts a command over 4000 UTF-8 bytes.
    const fake = measuredRunner();
    installRunner(fake.run);
    const unicodeService = "é".repeat(60);
    const short = printable(10);
    writeKeychainItem(unicodeService, account, short);
    expect(fake.stdinCalls).toHaveLength(1);
    const line = fake.stdinCalls[0] as string;
    const value = printable(4000 - (line.length - short.length));
    expect(line.length - short.length + value.length).toBeLessThanOrEqual(4000);
    expect(Buffer.byteLength(line, "utf8") - short.length + value.length).toBeGreaterThan(4000);
    fake.stdinCalls.length = 0;

    keychainError(() => writeKeychainItem(unicodeService, account, value));
    expect(fake.stdinCalls).toHaveLength(0);
  });

  it("keeps captured fixed security text in a write failure", () => {
    // Mutation caught: an overly strict allowlist reduces fixed errors to security exited N.
    // Verbatim miss stderr: ai-docs/reports/keychain-security-cli-measurements.md §2.
    const stderr =
      "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.";
    installRunner(() => ({ code: 45, stdout: "", stderr }));

    const error = keychainError(() => writeKeychainItem(service, account, printable(80)));
    expect(error.message).toStartWith("Failed to store");
    expect(error.message).toContain(stderr);
  });

  it("preserves spawn-error ambiguity but filters the same unflagged stderr", async () => {
    // Mutation caught: passing spawn errors through the security allowlist loses ETIMEDOUT.
    const stderr = "spawn /usr/bin/security ETIMEDOUT";
    const record = tokenRecord(2560);
    for (const spawnError of [true, false]) {
      const result: KeychainRunResult = { code: 1, stdout: "", stderr };
      if (spawnError) result.spawnError = true;
      installRunner(() => result);
      const error = keychainError(() => writeKeychainItem(service, account, printable(80)));
      const store = new KeychainTokenStore({ env: {} });
      const rejected = await store.write(ref, record).then(
        () => undefined,
        (error: unknown) => error
      );

      if (spawnError) {
        expect(error.message).toMatch(ambiguousWrite);
        expect(rejected).toBeInstanceOf(TokenStoreAmbiguousWriteError);
      } else {
        expect(error.message).not.toMatch(ambiguousWrite);
        expect(rejected).toBeInstanceOf(TokenStoreWriteError);
        expect(rejected).not.toBeInstanceOf(TokenStoreAmbiguousWriteError);
      }
    }
  });

  for (const carrier of ["hex", "plaintext"] as const) {
    it(`does not disclose an echoed ${carrier} fragment in a write error`, () => {
      // Mutation caught: splicing raw security stderr leaks a fragment, not the full secret.
      const canary = printable(160);
      const encoded = carrier === "hex" ? Buffer.from(canary).toString("hex") : canary;
      const fragment = encoded.slice(32, 80);
      installRunner(() => echoedCommand(fragment));

      const error = keychainError(() => writeKeychainItem(service, account, canary));
      expect(error.message.includes(fragment)).toBe(false);
    });
  }

  it("preserves killed-call ambiguity with partial stderr but not for a size refusal", () => {
    // Mutation caught: a nonempty stderr hides the killed-call classification marker.
    installRunner(() => ({ code: -1, stdout: "", stderr: "security: SecKeychain" }));
    const killed = keychainError(() => writeKeychainItem(service, account, printable(80)));
    expect(killed.message).toMatch(ambiguousWrite);

    const fake = measuredRunner();
    installRunner(fake.run);
    const capped = keychainError(() => writeKeychainItem(service, account, printable(5120)));
    expect(capped.message).not.toMatch(ambiguousWrite);
    expect(fake.stdinCalls).toHaveLength(0);
  });

  it("classifies a 5 KB store refusal as definite and round-trips a 2.5 KB stored record", async () => {
    // Mutation caught: the store must reject oversize records definitively and accept real token sizes.
    const fake = measuredRunner();
    installRunner(fake.run);
    const store = new KeychainTokenStore({ env: {} });
    const large = tokenRecord(5120);
    const record = tokenRecord(2560);
    const rejected = await store.write(ref, large).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(rejected).toBeInstanceOf(TokenStoreWriteError);
    expect(rejected).not.toBeInstanceOf(TokenStoreAmbiguousWriteError);

    const written = await store.write(ref, record).then(
      () => true,
      () => false
    );
    expect({ storeWriteSucceeded: written }).toEqual({ storeWriteSucceeded: true });
    expect(await store.read(ref, { uncached: true })).toEqual(record);
    expect(fake.stdinCalls.length).toBeGreaterThan(0);
    for (const stdin of fake.stdinCalls) {
      for (const line of stdin.split("\n")) expect(line.length).toBeLessThanOrEqual(4095);
    }
  });
});
