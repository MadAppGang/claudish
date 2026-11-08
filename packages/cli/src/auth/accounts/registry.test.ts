import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountRegistry, LEGACY_CODEX_ACCOUNT_ID } from "./registry.js";
import { FileTokenStore, TokenStoreWriteError, fingerprintOf } from "./token-store.js";
import { AccountListInvalidError, AccountListUnavailableError } from "./types.js";

let dir = "";
let configPath = "";
let legacyPath = "";

function registry(): AccountRegistry {
  return new AccountRegistry({
    configPath: () => configPath,
    legacyCodexPath: () => legacyPath,
    env: { CLAUDISH_DISABLE_KEYCHAIN: "1" },
  });
}

function configuredAccount(id = "abc123def456"): Record<string, unknown> {
  return {
    version: "1.0.0",
    defaultProfile: "default",
    profiles: {},
    subscriptionAccounts: {
      "openai-codex": {
        generation: 4,
        accounts: [
          {
            id,
            label: "work",
            store: "file",
            addedAt: "2026-09-12T00:00:00.000Z",
          },
        ],
      },
    },
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudish-registry-test-"));
  configPath = join(dir, "config.json");
  legacyPath = join(dir, "codex-oauth.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("AccountRegistry fail-closed account list", () => {
  test("keeps present, absent, and failed config outcomes distinct", () => {
    const absent = registry();
    expect(absent.snapshot("openai-codex").config.state).toBe("absent");
    expect(absent.hasConfiguredAccounts("openai-codex")).toBe(false);

    writeJson(configPath, configuredAccount());
    const present = registry();
    const presentSnapshot = present.snapshot("openai-codex");
    expect(presentSnapshot.config.state).toBe("present");
    expect(presentSnapshot.accounts["openai-codex"].map((account) => account.label)).toEqual([
      "work",
    ]);

    writeFileSync(configPath, '{"subscriptionAccounts":', "utf8");
    const failed = registry();
    expect(() => failed.snapshot("openai-codex")).toThrow(AccountListInvalidError);
    try {
      failed.snapshot("openai-codex");
      throw new Error("expected an invalid account list");
    } catch (error) {
      expect(error).toBeInstanceOf(AccountListInvalidError);
      expect(error).toMatchObject({ terminal: true, transient: false, upstreamStatus: 400 });
      expect((error as Error).message).toContain(configPath);
      expect((error as Error).message).toContain("invalid JSON");
    }
    expect(failed.sources().config.state).toBe("failed");
    expect(failed.sources().config.servingLastKnownGood).toBe(false);

    // Mutation caught: route the read through loadConfig(), whose parse catch
    // returns DEFAULT_CONFIG and collapses failed into an empty/absent account list.
  });

  test("serves the last-known-good config account list after truncation", () => {
    writeJson(configPath, configuredAccount());
    const subject = registry();
    expect(subject.hasConfiguredAccounts("openai-codex")).toBe(true);

    writeFileSync(configPath, "{", "utf8");
    subject.invalidate();
    const snapshot = subject.snapshot("openai-codex");

    expect(snapshot.config.state).toBe("failed");
    expect(snapshot.config.servingLastKnownGood).toBe(true);
    expect(snapshot.accounts["openai-codex"].map((account) => account.label)).toEqual(["work"]);
    expect(subject.hasConfiguredAccounts("openai-codex")).toBe(true);

    // Mutation caught: replace the cached account list on parse failure with an empty
    // object, which turns the final presence predicate false.
  });

  test("throws rather than returning an empty account list when config.json is unreadable", () => {
    mkdirSync(configPath);
    const subject = registry();

    expect(() => subject.hasConfiguredAccounts("openai-codex")).toThrow(
      /Refusing to treat an unreadable account list as an empty one/
    );
    expect(subject.sources().config.state).toBe("failed");

    // Mutation caught: catch readFileSync errors and return false from the
    // configuration predicate.
  });

  test("keeps absent and failed legacy credential outcomes distinct", () => {
    writeJson(configPath, { version: "1.0.0", defaultProfile: "default", profiles: {} });
    const absent = registry();
    expect(absent.snapshot("openai-codex").legacy.state).toBe("absent");
    expect(absent.hasConfiguredAccounts("openai-codex")).toBe(false);

    writeFileSync(legacyPath, "{", "utf8");
    const truncated = registry();
    expect(() => truncated.hasConfiguredAccounts("openai-codex")).toThrow(
      AccountListUnavailableError
    );
    expect(truncated.sources().legacy.state).toBe("failed");

    rmSync(legacyPath, { force: true });
    mkdirSync(legacyPath);
    const unreadable = registry();
    expect(() => unreadable.hasConfiguredAccounts("openai-codex")).toThrow(
      AccountListUnavailableError
    );
    expect(unreadable.sources().legacy.state).toBe("failed");

    // Mutation caught: call CodexOAuth.hasCredentials(), whose read/parse catch
    // returns null and turns both legacy failures into clean absence.
  });

  test("serves the last-known-good legacy account list after the file becomes unreadable", () => {
    writeJson(configPath, { version: "1.0.0", defaultProfile: "default", profiles: {} });
    writeJson(legacyPath, {
      access_token: "access-old",
      refresh_token: "refresh-old",
      expires_at: 1,
      account_id: "acct-1",
    });
    const subject = registry();
    expect(subject.hasConfiguredAccounts("openai-codex")).toBe(true);

    rmSync(legacyPath);
    mkdirSync(legacyPath);
    subject.invalidate();
    const snapshot = subject.snapshot("openai-codex");

    expect(snapshot.legacy.state).toBe("failed");
    expect(snapshot.legacy.servingLastKnownGood).toBe(true);
    expect(snapshot.accounts["openai-codex"]).toHaveLength(1);
    expect(snapshot.accounts["openai-codex"][0]?.identity.chatgptAccountId).toBe("acct-1");

    // Mutation caught: discard lastGoodLegacy after a read failure, which makes
    // the synthesized account list disappear.
  });

  test("synthesizes a default legacy account in memory without writing config", () => {
    writeJson(legacyPath, {
      access_token: "access-old",
      refresh_token: "refresh-old",
      expires_at: 1,
      account_id: "acct-legacy",
    });
    const before = readdirSync(dir).sort();

    const snapshot = registry().snapshot("openai-codex");

    expect(snapshot.accounts["openai-codex"]).toHaveLength(1);
    expect(snapshot.accounts["openai-codex"][0]).toMatchObject({
      // The design pins the user-visible LABEL (`default (legacy file)` in
      // `list`/`status`, and `account remove default`), never the internal id —
      // which is a sentinel the user never types. V15 says so directly: a row
      // "cannot rely on the id `default`, which `^[a-z0-9]{12}$` forbids".
      id: LEGACY_CODEX_ACCOUNT_ID,
      label: "default",
      legacy: true,
      store: "legacy-codex-file",
    });
    expect(readdirSync(dir).sort()).toEqual(before);

    // Mutation caught: require subscriptionAccounts before consulting the legacy
    // file, or persist the synthesized migration account into config.json.
  });

  test("rejects a traversal id as a whole read and cannot create a token outside the accounts directory", async () => {
    const maliciousId = "../../../tmp/x";
    const accountsDirectory = join(dir, "accounts");
    const escapedTokenPath = join(dir, "tmp", "x.json");
    writeJson(configPath, configuredAccount(maliciousId));
    const subject = registry();

    expect(() => subject.snapshot("openai-codex")).toThrow(AccountListInvalidError);
    expect(subject.sources().config.error).toContain(
      'subscriptionAccounts["openai-codex"]["accounts"][0]["id"]'
    );

    const store = new FileTokenStore({
      env: {
        CLAUDISH_ACCOUNTS_DIR: accountsDirectory,
        CLAUDISH_DISABLE_KEYCHAIN: "1",
      },
    });
    await expect(
      store.write(
        { provider: "openai-codex", id: maliciousId, label: "unsafe" },
        {
          accessToken: "access-provisional",
          refreshToken: "refresh-provisional",
          expiresAt: Date.parse("2026-09-12T13:00:00.000Z"),
          generation: 1,
          fingerprint: fingerprintOf("refresh-provisional"),
          updatedAt: Date.parse("2026-09-12T12:00:00.000Z"),
        }
      )
    ).rejects.toBeInstanceOf(TokenStoreWriteError);
    expect(existsSync(escapedTokenPath)).toBe(false);

    // PROVISIONAL: constructed token material; replace it with a captured Codex
    // record once the Phase V token probe is available.
    // Mutations caught: skip entry id validation, or let paths.ts interpolate an
    // unchecked id. The first accepts the whole account list; the second creates
    // escapedTokenPath outside accountsDirectory.
  });

  test("rejects a Codex window key that the usage layer cannot produce", () => {
    const config = configuredAccount();
    const subscriptionAccounts = config.subscriptionAccounts as Record<
      string,
      Record<string, unknown>
    >;
    (subscriptionAccounts["openai-codex"] as Record<string, unknown>).switchAtByWindow = {
      "7d": 0.8,
    };
    writeJson(configPath, config);
    const subject = registry();

    expect(() => subject.snapshot("openai-codex")).toThrow(AccountListInvalidError);
    expect(subject.sources().config.error).toContain(
      'subscriptionAccounts["openai-codex"]["switchAtByWindow"]["7d"]'
    );
    expect(subject.sources().config.error).toContain('"7d" is not a Codex window slot');

    // Mutation caught: cast switchAtByWindow without checking the slot ids emitted
    // by the Codex usage layer; the invalid key becomes a silently dead setting.
  });

  test("rejects duplicate ids instead of sharing one token file and refresh gate", () => {
    const config = configuredAccount();
    const subscriptionAccounts = config.subscriptionAccounts as Record<
      string,
      Record<string, unknown>
    >;
    const entry = subscriptionAccounts["openai-codex"] as Record<string, unknown>;
    const accounts = entry.accounts as Array<Record<string, unknown>>;
    accounts.push({ ...accounts[0], label: "personal" });
    writeJson(configPath, config);
    const subject = registry();

    expect(() => subject.snapshot("openai-codex")).toThrow(AccountListInvalidError);
    expect(subject.sources().config.error).toContain(
      'subscriptionAccounts["openai-codex"]["accounts"][1]["id"]'
    );
    expect(subject.sources().config.error).toContain("duplicates accounts[0]");

    // Mutation caught: validate each row in isolation but omit the per-provider id
    // uniqueness check; both rows are then accepted onto the same durable paths.
  });

  test("retries a transient read failure without requiring the file to change", () => {
    writeJson(configPath, configuredAccount());
    let reads = 0;
    const subject = new AccountRegistry({
      configPath: () => configPath,
      legacyCodexPath: () => legacyPath,
      env: { CLAUDISH_DISABLE_KEYCHAIN: "1" },
      readFile: (path) => {
        reads++;
        if (reads === 1) {
          const error = new Error("injected EMFILE") as NodeJS.ErrnoException;
          error.code = "EMFILE";
          throw error;
        }
        return readFileSync(path, "utf8");
      },
    });

    expect(() => subject.hasConfiguredAccounts("openai-codex")).toThrow(
      AccountListUnavailableError
    );
    expect(reads).toBe(1);
    expect(subject.hasConfiguredAccounts("openai-codex")).toBe(true);
    expect(reads).toBe(2);

    // Mutation caught: stamp the file before its bytes are read. The second call
    // sees the unchanged stamp and keeps serving the cached failed outcome.
  });

  test("account-list-read-throws produces a failed source rather than an empty account list", () => {
    writeJson(configPath, configuredAccount());
    const subject = new AccountRegistry({
      configPath: () => configPath,
      legacyCodexPath: () => legacyPath,
      env: {
        CLAUDISH_DISABLE_KEYCHAIN: "1",
        CLAUDISH_TEST_UPSTREAM: "http://127.0.0.1:4010",
        CLAUDISH_ACCOUNTS_FAULT: "account-list-read-throws",
      },
    });

    expect(() => subject.hasConfiguredAccounts("openai-codex")).toThrow(
      /CLAUDISH_ACCOUNTS_FAULT=account-list-read-throws/
    );
    expect(subject.sources().config.state).toBe("failed");
    expect(subject.sources().config.servingLastKnownGood).toBe(false);

    // Mutation caught: accept account-list-read-throws in accountsFault() without
    // calling its injection site; the readable config returns true instead.
  });
});
