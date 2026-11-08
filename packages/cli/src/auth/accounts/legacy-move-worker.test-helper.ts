import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexPkceDeps, CodexPkceResult } from "../codex-pkce.js";
import { FakeSecurity } from "./fake-security.test-helper.js";
import type { AccountManagementDeps, LegacyMoveDeferral, LegacyMoveOutcome } from "./management.js";
import type { StoredTokenRecord } from "./token-store.js";
import type { AccountRef, SubscriptionAccountsEntry } from "./types.js";

type Row = SubscriptionAccountsEntry["accounts"][number];
interface Config {
  subscriptionAccounts: { "openai-codex": SubscriptionAccountsEntry };
}

const scenario = process.argv[2]!;
const home = process.env.HOME!;
assert.ok(home && home !== "/", "a dedicated temp HOME is mandatory");
assert.equal(process.env.CLAUDISH_DISABLE_KEYCHAIN, "1", "child must boot with Keychain disabled");
assert.equal(process.env.CLAUDISH_ACCOUNTS_DIR, join(home, ".claudish", "accounts"));
const fake = new FakeSecurity(home);

// Install ALL side-effect seams before importing any account API. Never restore
// real deps in this child; process exit is teardown.
const { setKeychainTestDeps, invalidateKeychainCache } = await import(
  "../../providers/keychain.js"
);
const platform = scenario === "LM16-linux" ? "linux" : "darwin";
setKeychainTestDeps(fake.deps(platform));
if (scenario !== "LM16-disabled" && scenario !== "L6-routing" && scenario !== "L6-success") {
  delete process.env.CLAUDISH_DISABLE_KEYCHAIN;
}
delete process.env.CLAUDISH_ACCOUNT_STORE;
delete process.env.CLAUDISH_KEYCHAIN_FILE;
// Management success cases inject typed PKCE results. L6 supplies its own fake
// browser/callback/fetch through CodexPkceDeps; global outbound fetch stays denied.
globalThis.fetch = Object.assign(
  async () => {
    throw new Error("outbound network is forbidden in legacy-move tests");
  },
  { preconnect: () => {} }
) as typeof fetch;

const { CodexAccountManagement, codexLoginUsesKeychain, legacyMoveDeferredMessage } = await import(
  "./management.js"
);
const { LegacyCodexFileStore, KeychainTokenStore, fingerprintOf } = await import(
  "./token-store.js"
);
const { AccountRegistry, setAccountRegistryForTests } = await import("./registry.js");
const { accountRefreshLockPath, legacyCodexCredentialsPath, statePath } = await import(
  "./paths.js"
);
const { withRefreshGate } = await import("./refresh-lock.js");
const starter = await import("./legacy-move.js");

const env = process.env;
const appHome = join(home, ".claudish");
const defaultConfig = join(appHome, "config.json");
const legacyPath = legacyCodexCredentialsPath(env);
mkdirSync(appHome, { recursive: true, mode: 0o700 });
mkdirSync(env.CLAUDISH_ACCOUNTS_DIR!, { recursive: true, mode: 0o700 });
let activeConfig = defaultConfig;
const ref: AccountRef = { provider: "openai-codex", id: "aaaaaaaaaaaa", label: "default" };
const legacy = new LegacyCodexFileStore({ env, path: legacyPath });
const keychain = new KeychainTokenStore({ env });
const registry = new AccountRegistry({
  env,
  configPath: () => activeConfig,
  legacyCodexPath: () => legacyPath,
});
setAccountRegistryForTests(registry);
const printed: string[] = [];
const deps: AccountManagementDeps = {
  env,
  configPath: () => activeConfig,
  print: (line) => printed.push(line),
  confirm: async () => {
    throw new Error("unexpected interactive confirmation");
  },
  pkce: async () => {
    throw new Error("unexpected PKCE call");
  },
  // Do not import credential authority just to clear its memo. Registry is real.
  invalidate: () => registry.invalidate(),
};
const management = (more: AccountManagementDeps = {}) =>
  new CodexAccountManagement({ ...deps, ...more });
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const fileHash = (path: string) => (existsSync(path) ? digest(readFileSync(path)) : null);
const entry = (): SubscriptionAccountsEntry => readConfig().subscriptionAccounts["openai-codex"];
const readConfig = (path = activeConfig): Config =>
  JSON.parse(readFileSync(path, "utf8")) as Config;
function saveConfig(value: Config, path = activeConfig): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
function seedConfig(rows: Row[] = [], marker = false): void {
  saveConfig({
    subscriptionAccounts: {
      "openai-codex": {
        generation: 1,
        accounts: rows,
        ...(marker ? { legacyCodexSuppressed: true } : {}),
      },
    },
  });
  registry.invalidate();
}
function row(overrides: Partial<Row> = {}): Row {
  return {
    id: ref.id,
    label: ref.label,
    store: "legacy-codex-file",
    enabled: true,
    identity: {
      chatgptAccountId: "test-codex-identity",
      email: "test@example.invalid",
      plan: "test-plan",
    },
    addedAt: "2026-01-02T03:04:05.000Z",
    ...overrides,
  };
}
function token(suffix = "original", generation = 7): StoredTokenRecord {
  const refreshToken = "legacy-refresh-marker-" + suffix;
  return {
    accessToken: "legacy-access-marker-" + suffix,
    refreshToken,
    expiresAt: Date.now() + 86_400_000,
    accountId: "test-codex-identity",
    generation,
    fingerprint: fingerprintOf(refreshToken),
    updatedAt: 1_780_000_000_000,
    writeId: "source-write-marker",
  };
}
function loginResult(suffix: string, accountId = "test-codex-identity"): CodexPkceResult {
  const material = token(suffix);
  return {
    credentials: {
      access_token: material.accessToken,
      refresh_token: material.refreshToken,
      expires_at: material.expiresAt,
      account_id: accountId,
    },
    identity: { chatgptAccountId: accountId, email: "test@example.invalid", plan: "test-plan" },
  };
}
function assertSavedLogin(actual: StoredTokenRecord, result: CodexPkceResult): void {
  assert.equal(
    digest(actual.accessToken),
    digest(result.credentials.access_token),
    "saved access material differs"
  );
  assert.equal(
    digest(actual.refreshToken),
    digest(result.credentials.refresh_token),
    "saved refresh material differs"
  );
  assert.equal(actual.fingerprint, fingerprintOf(result.credentials.refresh_token));
  assert.equal(actual.accountId, result.identity.chatgptAccountId);
  assert.equal(actual.expiresAt, result.credentials.expires_at);
}
async function assertNoOwnedNotice(lines: string[]): Promise<void> {
  const { OWNED_ACCOUNTS_NOTICE } = await import("./management.js");
  assert.equal(
    entry().noticeAcceptedAt,
    undefined,
    "single-account login must not record notice acceptance"
  );
  assert.equal(
    [...printed, ...lines].join("\n").includes(OWNED_ACCOUNTS_NOTICE),
    false,
    "single-account login must not print the owned-accounts notice"
  );
}
async function seedLegacy(record = token(), rows: Row[] = [row()]): Promise<StoredTokenRecord> {
  seedConfig(rows);
  await legacy.write(ref, record);
  const stored = await legacy.read(ref, { uncached: true });
  assert.ok(stored, "test source must be readable");
  return stored;
}
async function destination(id = ref.id): Promise<StoredTokenRecord> {
  invalidateKeychainCache();
  const stored = await keychain.read({ ...ref, id }, { uncached: true });
  assert.ok(stored, "published item must exist");
  return stored;
}
function sameMaterial(actual: StoredTokenRecord, expected: StoredTokenRecord): void {
  assert.equal(digest(actual.accessToken), digest(expected.accessToken), "access material differs");
  assert.equal(
    digest(actual.refreshToken),
    digest(expected.refreshToken),
    "refresh material differs"
  );
  assert.equal(actual.fingerprint, expected.fingerprint);
  assert.equal(actual.generation, expected.generation);
  assert.equal(actual.accountId, expected.accountId);
  assert.equal(actual.expiresAt, expected.expiresAt);
  assert.deepEqual(actual.journal, expected.journal);
}
function snapshotBytes(): { config: string | null; legacy: string | null } {
  return { config: fileHash(activeConfig), legacy: fileHash(legacyPath) };
}
function assertKept(before: ReturnType<typeof snapshotBytes>): void {
  assert.deepEqual(snapshotBytes(), before, "file and config must remain byte-identical");
}
function deferred(outcome: LegacyMoveOutcome, reason: LegacyMoveDeferral): void {
  assert.equal(outcome.kind, "deferred");
  if (outcome.kind !== "deferred") throw new Error("expected deferred outcome");
  assert.equal(outcome.reason, reason);
  // Assert booleans, never put token contents in assertion diagnostics.
  assert.equal(outcome.detail.includes("legacy-refresh-marker"), false);
  assert.equal(outcome.detail.includes("legacy-access-marker"), false);
}
function moved(outcome: LegacyMoveOutcome): Extract<LegacyMoveOutcome, { kind: "moved" }> {
  assert.equal(outcome.kind, "moved");
  if (outcome.kind !== "moved") throw new Error("expected moved outcome");
  return outcome;
}
async function stopAt(hook: "beforePublish" | "beforeDelete"): Promise<void> {
  const injectedStop = new Error("simulated process stop at " + hook);
  try {
    await management({
      moveHooks: {
        [hook]: () => {
          throw injectedStop;
        },
      },
    }).moveLegacyLogin();
  } catch (error) {
    // A seam may propagate the injected stop; production failures must still
    // obey the outcome contract. The test asserts durable crash-state below,
    // not whether a test-hook exception is caught by the product.
    assert.equal(error, injectedStop, "only the explicitly injected stop may escape");
  }
}
async function until(predicate: () => boolean, label: string, timeout = 8_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, label + " did not become ready");
    await Bun.sleep(10);
  }
}

const peers: ReturnType<typeof Bun.spawn>[] = [];
function spawnPeer(id: string) {
  const worker = fileURLToPath(import.meta.url);
  const child = Bun.spawn([process.execPath, worker, "peer-move", id], {
    // env was already stripped by the parent; re-arm disabled-until-fake boot.
    env: { ...env, CLAUDISH_DISABLE_KEYCHAIN: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  peers.push(child);
  const completion = Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([code, stdout, stderr]) => {
    assert.equal(code, 0, "peer failed: " + stdout + stderr);
    return JSON.parse(readFileSync(join(home, "result-" + id), "utf8")) as LegacyMoveOutcome;
  });
  // Attach immediately: a failed peer must not create an unhandled rejection
  // before its barrier has been released by the coordinating process.
  void completion.catch(() => {});
  return { child, completion, id };
}
async function readyPeers(ids: string[]): Promise<void> {
  await until(() => ids.every((id) => existsSync(join(home, "ready-" + id))), "peers");
  for (const id of ids) writeFileSync(join(home, "go-" + id), "");
  await until(() => ids.every((id) => existsSync(join(home, "started-" + id))), "started movers");
}
function signal<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function run(): Promise<void> {
  if (scenario === "peer-config-lock") {
    // REQ-12: a real synchronous transaction in another process.
    const { withRawConfigTransaction } = await import("./config-lock.js");
    withRawConfigTransaction(defaultConfig, (raw) => {
      writeFileSync(join(home, "config-holder-ready"), "");
      const deadline = Date.now() + 8_000;
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(join(home, "config-holder-release"))) {
        assert.ok(Date.now() < deadline, "config holder release barrier timed out");
        // The public transaction is synchronous; block only this isolated child.
        Atomics.wait(sleeper, 0, 0, 10);
      }
      return { config: { ...raw, qaConcurrentWriter: "preserved" }, result: undefined };
    });
    return;
  }
  if (scenario === "peer-move") {
    const id = process.argv[3]!;
    assert.equal(
      starter.legacyMoveApplies(env, defaultConfig, registry),
      true,
      "peer must observe a legacy target before publication"
    );
    writeFileSync(join(home, "ready-" + id), "");
    await until(() => existsSync(join(home, "go-" + id)), "peer start barrier");
    writeFileSync(join(home, "started-" + id), "");
    const outcome = await management().moveLegacyLogin();
    writeFileSync(join(home, "result-" + id), JSON.stringify(outcome));
    return;
  }

  switch (scenario) {
    case "LM1": {
      // REQ-1
      const source = await seedLegacy(token(), []);
      utimesSync(legacyPath, new Date("2026-01-02T03:04:05Z"), new Date("2026-01-02T03:04:05Z"));
      const expectedAddedAt = new Date(statSync(legacyPath).mtimeMs).toISOString();
      const enrolled: Row[][] = [];
      const outcome = moved(
        await management({
          moveHooks: {
            afterEnroll: () => {
              enrolled.push(structuredClone(entry().accounts));
              assert.equal(existsSync(legacyPath), true);
              assert.equal(fake.adds().length, 0, "enrolment must precede the Keychain write");
            },
          },
        }).moveLegacyLogin()
      );
      assert.equal(enrolled.length, 1);
      assert.equal(enrolled[0]!.length, 1);
      assert.match(outcome.id, /^[a-z0-9]{12}$/);
      assert.notEqual(outcome.id, "legacy-codex");
      assert.equal(enrolled[0]![0]!.id, outcome.id);
      assert.equal(enrolled[0]![0]!.store, "legacy-codex-file");
      assert.equal(outcome.label, "default");
      assert.equal(outcome.fileDeleted, true);
      assert.equal(entry().accounts.length, 1);
      assert.equal(entry().accounts[0]!.id, outcome.id);
      assert.equal(entry().accounts[0]!.store, "keychain");
      assert.equal(entry().accounts[0]!.addedAt, expectedAddedAt);
      assert.equal(entry().accounts[0]!.identity?.chatgptAccountId, source.accountId);
      assert.equal(entry().noticeAcceptedAt, undefined);
      assert.equal(entry().legacyCodexSuppressed, true);
      assert.equal(existsSync(legacyPath), false);
      assert.equal(registry.hasConfiguredAccounts("openai-codex"), true);
      sameMaterial(await destination(outcome.id), source);
      assert.equal(fake.adds().length, 1);
      break;
    }
    case "LM2": {
      // REQ-2
      const first = row({ enabled: false, label: "my-default" });
      const second = row({
        id: "bbbbbbbbbbbb",
        label: "second",
        store: "keychain",
        identity: { chatgptAccountId: "second-identity" },
      });
      await seedLegacy(token(), [first, second]);
      const state = JSON.stringify({
        active: ref.id,
        accounts: {
          [ref.id]: {
            usage: { observedAt: 1780000000000, windows: [] },
            exhaustedUntil: 9999999999999,
          },
        },
      });
      writeFileSync(statePath(env), state, { mode: 0o600 });
      const beforeState = fileHash(statePath(env));
      const outcome = moved(await management().moveLegacyLogin());
      assert.equal(outcome.id, ref.id);
      assert.deepEqual(entry().accounts, [{ ...first, store: "keychain" }, second]);
      assert.equal(entry().legacyCodexSuppressed, true);
      assert.equal(fileHash(statePath(env)), beforeState);
      assert.equal(
        fake.item("openai-codex:bbbbbbbbbbbb"),
        undefined,
        "second item must not be touched"
      );
      assert.equal(fake.adds().length, 1);
      break;
    }
    case "LM3-oversize": {
      // REQ-3 / REQ-33: security's 4095-byte input limit
      const large = token();
      large.accessToken = "oversize-access-marker-" + "x".repeat(5000);
      await seedLegacy(large);
      const before = snapshotBytes();
      deferred(await management().moveLegacyLogin(), "keychain-write-failed");
      assertKept(before);
      assert.equal(
        fake.adds().length,
        0,
        "oversize material must be refused before security is called"
      );
      break;
    }
    case "LM3":
    case "LM4":
    case "LM6":
    case "LM7": {
      // REQ-3/4/6/7: byte-level negative controls use an already-enrolled row.
      await seedLegacy();
      const before = snapshotBytes();
      const settings = {
        LM3: { writeExit: 1 },
        LM4: { writeKilled: "before" as const },
        LM6: { truncateStored: true },
        LM7: { readExit: 1 },
      };
      fake.faults(settings[scenario]);
      const outcome = await management().moveLegacyLogin();
      const reasons = {
        LM3: "keychain-write-failed",
        LM4: "keychain-unverified",
        LM6: "keychain-write-failed",
        LM7: "keychain-unreadable",
      } as const;
      deferred(outcome, reasons[scenario]);
      assertKept(before);
      assert.equal(registry.listAccounts("openai-codex")[0]!.store, "legacy-codex-file");
      assert.equal(registry.hasConfiguredAccounts("openai-codex"), true);
      assert.equal(
        fake.adds().length,
        scenario === "LM7" ? 0 : 1,
        "ambiguous writes are not retried"
      );
      break;
    }
    case "LM4-wrong-proof": {
      // REQ-4: same lineage is insufficient without THIS writeId.
      await seedLegacy();
      const before = snapshotBytes();
      const outcome = await management({
        newStore: () => ({
          kind: "keychain",
          read: async (account, opts) => {
            const stored = await keychain.read(account, opts);
            return stored ? { ...stored, writeId: "another-writer-proof" } : null;
          },
          write: (account, stored) => keychain.write(account, stored),
          delete: (account) => keychain.delete(account),
          describe: () => "Keychain with competing read-back proof",
        }),
      }).moveLegacyLogin();
      deferred(outcome, "keychain-unverified");
      assertKept(before);
      assert.equal(fake.adds().length, 1);
      break;
    }
    case "LM5": {
      // REQ-5
      const source = await seedLegacy();
      fake.faults({ writeKilled: "after" });
      moved(await management().moveLegacyLogin());
      sameMaterial(await destination(), source);
      assert.equal(fake.adds().length, 1);
      assert.equal(existsSync(legacyPath), false);
      break;
    }
    case "LM8-torn":
    case "LM8-empty":
    case "LM8-no-pair":
    case "LM8-file-denied":
    case "LM8-parent-denied": {
      // REQ-8
      await seedLegacy();
      if (scenario === "LM8-torn") writeFileSync(legacyPath, "{");
      if (scenario === "LM8-empty") writeFileSync(legacyPath, "");
      if (scenario === "LM8-no-pair")
        writeFileSync(legacyPath, JSON.stringify({ access_token: "test-marker" }));
      const before = snapshotBytes();
      const denied =
        scenario === "LM8-file-denied"
          ? legacyPath
          : scenario === "LM8-parent-denied"
            ? appHome
            : null;
      if (denied) chmodSync(denied, 0);
      let outcome: LegacyMoveOutcome;
      try {
        outcome = await management().moveLegacyLogin();
      } finally {
        if (denied) chmodSync(denied, denied === appHome ? 0o700 : 0o600);
      }
      deferred(outcome!, "file-unreadable");
      assertKept(before);
      assert.equal(fake.calls().length, 0);
      break;
    }
    case "LM9-same":
    case "LM9-generation":
    case "LM9-rotated": {
      // REQ-9: synthesized population also proves fixed-id enrolment.
      let source = await seedLegacy(token(), []);
      await stopAt("beforePublish");
      assert.equal(entry().accounts.length, 1);
      const enrolledId = entry().accounts[0]!.id;
      assert.equal(entry().accounts[0]!.store, "legacy-codex-file");
      assert.equal(existsSync(legacyPath), true);
      assert.ok(fake.item("openai-codex:" + enrolledId));
      assert.equal(fake.adds().length, 1);
      if (scenario === "LM9-rotated") {
        await legacy.write(ref, token("rotated-after-stop", source.generation + 1));
        source = (await legacy.read(ref, { uncached: true }))!;
      }
      if (scenario === "LM9-generation") {
        await legacy.write(ref, { ...source, generation: source.generation + 1 });
        source = (await legacy.read(ref, { uncached: true }))!;
      }
      const outcome = moved(await management().moveLegacyLogin());
      assert.equal(outcome.id, enrolledId);
      sameMaterial(await destination(enrolledId), source);
      assert.equal(fake.adds().length, scenario === "LM9-same" ? 1 : 2);
      assert.equal(
        fake.itemNames().length,
        1,
        "a failed attempt must not orphan an item under another id"
      );
      assert.equal(existsSync(legacyPath), false);
      break;
    }
    case "LM10": {
      // REQ-10
      await seedLegacy();
      await stopAt("beforeDelete");
      assert.equal(entry().accounts[0]!.store, "keychain");
      assert.equal(entry().legacyCodexSuppressed, true);
      assert.equal(existsSync(legacyPath), true);
      const published = fileHash(activeConfig);
      assert.deepEqual(await management().moveLegacyLogin(), { kind: "leftover-deleted" });
      assert.equal(fileHash(activeConfig), published);
      assert.equal(existsSync(legacyPath), false);
      assert.equal(fake.adds().length, 1);
      break;
    }
    case "LM11": {
      // REQ-11
      const source = await seedLegacy();
      let rewrittenHash: string | null = null;
      const outcome = moved(
        await management({
          moveHooks: {
            beforeDelete: async () => {
              await legacy.write(ref, token("older-build-login", source.generation + 1));
              rewrittenHash = fileHash(legacyPath);
            },
          },
        }).moveLegacyLogin()
      );
      assert.equal(outcome.fileDeleted, false);
      assert.ok(rewrittenHash);
      assert.equal(fileHash(legacyPath), rewrittenHash);
      sameMaterial(await destination(), source);
      assert.equal(entry().legacyCodexSuppressed, true);
      break;
    }
    case "LM12-busy-lock": {
      // REQ-12: contention precisely at M6, after the verified write.
      const { CONFIG_LOCK_WAIT_MS } = await import("./config-lock.js");
      assert.equal(CONFIG_LOCK_WAIT_MS, 250);
      const source = await seedLegacy();
      const before = snapshotBytes();
      let publishStartedAt: number | undefined;
      let holderCompletion: Promise<void> | undefined;
      try {
        const outcome = await management({
          moveHooks: {
            beforePublish: async () => {
              const child = Bun.spawn(
                [process.execPath, fileURLToPath(import.meta.url), "peer-config-lock"],
                {
                  env: { ...env, CLAUDISH_DISABLE_KEYCHAIN: "1" },
                  stdout: "pipe",
                  stderr: "pipe",
                }
              );
              peers.push(child);
              holderCompletion = Promise.all([
                child.exited,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
              ]).then(([code, stdout, stderr]) => {
                assert.equal(code, 0, "config holder failed: " + stdout + stderr);
              });
              void holderCompletion.catch(() => {});
              await until(
                () => existsSync(join(home, "config-holder-ready")),
                "config transaction holder"
              );
              publishStartedAt = Date.now();
            },
          },
        }).moveLegacyLogin();

        deferred(outcome, "config-unavailable");
        assert.ok(
          publishStartedAt !== undefined,
          "contention must occur at publication, not initial inspection"
        );
        assert.ok(
          Date.now() - publishStartedAt >= CONFIG_LOCK_WAIT_MS,
          "publication must wait the configured 250 ms before refusing"
        );
        assertKept(before);
        assert.equal(entry().accounts[0]!.store, "legacy-codex-file");
        assert.equal(fake.adds().length, 1);
        sameMaterial(await destination(), source);
      } finally {
        writeFileSync(join(home, "config-holder-release"), "");
        await holderCompletion;
      }
      const afterWriter = JSON.parse(readFileSync(activeConfig, "utf8")) as Record<string, unknown>;
      assert.equal(afterWriter.qaConcurrentWriter, "preserved");
      assert.equal(fileHash(legacyPath), before.legacy);
      assert.equal(entry().accounts[0]!.store, "legacy-codex-file");
      registry.invalidate();

      const outcome = moved(await management().moveLegacyLogin());
      assert.equal(outcome.id, ref.id);
      assert.equal(outcome.fileDeleted, true);
      assert.equal(existsSync(legacyPath), false);
      assert.equal(entry().accounts[0]!.store, "keychain");
      assert.equal(entry().legacyCodexSuppressed, true);
      assert.equal(
        (JSON.parse(readFileSync(activeConfig, "utf8")) as Record<string, unknown>)
          .qaConcurrentWriter,
        "preserved",
        "retry must merge the concurrent writer, never restore the old config"
      );
      sameMaterial(await destination(), source);
      assert.ok(
        fake.adds().length === 1 || fake.adds().length === 2,
        "retry may resume the verified item or overwrite it once"
      );
      assert.equal(fake.itemNames().length, 1);
      break;
    }
    case "LM12-invalid-config": {
      // REQ-12 complementary branch, NOT the busy-lock acceptance.
      const source = await seedLegacy();
      const configBytes = readFileSync(activeConfig);
      const beforeFile = fileHash(legacyPath);
      const outcome = await management({
        moveHooks: {
          beforePublish: () => {
            writeFileSync(activeConfig, "{");
          },
        },
      }).moveLegacyLogin();
      deferred(outcome, "config-unavailable");
      assert.equal(fileHash(legacyPath), beforeFile);
      assert.equal(
        readFileSync(activeConfig, "utf8"),
        "{",
        "failed publication cannot overwrite another writer"
      );
      assert.equal(fake.adds().length, 1);
      writeFileSync(activeConfig, configBytes);
      registry.invalidate();
      moved(await management().moveLegacyLogin());
      sameMaterial(await destination(), source);
      assert.equal(fake.adds().length, 1, "verified unpublished material should be reused");
      break;
    }
    case "LM13": {
      // REQ-13: MUST fail when the move bypasses the real refresh gate.
      const source = await seedLegacy();
      let peer: ReturnType<typeof spawnPeer> | undefined;
      let rotated: StoredTokenRecord | undefined;
      const gatePath = accountRefreshLockPath(
        {
          provider: "openai-codex",
          id: ref.id,
          store: "legacy-codex-file",
        },
        env
      );
      await withRefreshGate(
        "openai-codex",
        "legacy-codex",
        async () => {
          peer = spawnPeer("gate-mover");
          await readyPeers(["gate-mover"]);
          // An observation window required by LM13, not a readiness substitute:
          // readiness is acknowledged by files before this clock starts.
          await Bun.sleep(300);
          assert.equal(fake.adds().length, 0, "move wrote while the refresher still held the gate");
          assert.equal(existsSync(join(home, "result-gate-mover")), false);
          await legacy.write(ref, token("rotation-under-gate", source.generation + 1));
          rotated = (await legacy.read(ref, { uncached: true }))!;
        },
        { path: gatePath, gen: source.generation }
      );
      assert.ok(peer);
      moved(await peer.completion);
      assert.ok(rotated);
      sameMaterial(await destination(), rotated);
      assert.notEqual((await destination()).fingerprint, source.fingerprint);
      assert.equal(fake.adds().length, 1);
      break;
    }
    case "LM14": {
      // REQ-14
      const source = await seedLegacy(token(), []);
      let a: ReturnType<typeof spawnPeer> | undefined;
      let b: ReturnType<typeof spawnPeer> | undefined;
      const gatePath = accountRefreshLockPath(
        {
          provider: "openai-codex",
          id: ref.id,
          store: "legacy-codex-file",
        },
        env
      );
      await withRefreshGate(
        "openai-codex",
        "legacy-codex",
        async () => {
          a = spawnPeer("first");
          b = spawnPeer("second");
          await readyPeers(["first", "second"]);
          await Bun.sleep(300);
          assert.equal(fake.adds().length, 0);
        },
        { path: gatePath, gen: source.generation }
      );
      assert.ok(a && b);
      const outcomes = await Promise.all([a.completion, b.completion]);
      assert.deepEqual(outcomes.map((outcome) => outcome.kind).sort(), ["already-moved", "moved"]);
      assert.equal(fake.adds().length, 1);
      assert.equal(entry().accounts.length, 1);
      sameMaterial(await destination(entry().accounts[0]!.id), source);
      assert.equal(existsSync(legacyPath), false);
      break;
    }
    case "LM15": {
      // REQ-15
      seedConfig([row({ store: "keychain" })], true);
      assert.deepEqual(await management().moveLegacyLogin(), {
        kind: "not-applicable",
        reason: "no-legacy-account",
      });
      assert.equal(fake.calls().length, 0);
      break;
    }
    case "LM16-linux":
    case "LM16-disabled": {
      // REQ-16
      await seedLegacy();
      const before = snapshotBytes();
      assert.equal(codexLoginUsesKeychain(env), false);
      assert.deepEqual(await management().moveLegacyLogin(), {
        kind: "not-applicable",
        reason: "no-keychain",
      });
      assertKept(before);
      assert.equal(fake.calls().length, 0);
      break;
    }
    case "LM17": {
      // REQ-17
      await seedLegacy(token(), []);
      const defaultHash = fileHash(defaultConfig);
      activeConfig = join(appHome, "alternate.json");
      env.CLAUDISH_CONFIG = activeConfig;
      seedConfig([]);
      const before = snapshotBytes();
      assert.deepEqual(await management().moveLegacyLogin(), {
        kind: "not-applicable",
        reason: "alternate-config",
      });
      assertKept(before);
      assert.equal(fileHash(defaultConfig), defaultHash);
      assert.equal(fake.calls().length, 0);
      break;
    }
    case "LM18": {
      // REQ-18: registry projections, NOT the absent billing-probe API.
      await seedLegacy(token(), []);
      const stages: string[] = [];
      const observe = (stage: string) => {
        stages.push(stage);
        assert.equal(registry.hasConfiguredAccounts("openai-codex"), true, stage);
        assert.equal(registry.mayHaveConfiguredAccounts("openai-codex"), true, stage);
        const configured = entry().accounts;
        assert.ok(
          configured.length > 0 || existsSync(legacyPath),
          "no gap without a configured credential"
        );
      };
      observe("before");
      moved(
        await management({
          moveHooks: {
            afterEnroll: () => observe("afterEnroll"),
            beforePublish: () => observe("beforePublish"),
            beforeDelete: () => observe("beforeDelete"),
          },
        }).moveLegacyLogin()
      );
      observe("after");
      assert.deepEqual(stages, ["before", "afterEnroll", "beforePublish", "beforeDelete", "after"]);
      break;
    }
    case "LM19": {
      // REQ-19
      const record = token();
      record.journal = {
        state: "unknown",
        from: record.fingerprint,
        at: record.updatedAt,
        pid: 99999,
        host: "test-host",
        nonce: "test-gate-nonce",
      };
      const source = await seedLegacy(record);
      const state = {
        accounts: {
          [ref.id]: {
            needsReauth: { failedGeneration: source.generation, fingerprint: source.fingerprint },
          },
        },
      };
      writeFileSync(statePath(env), JSON.stringify(state), { mode: 0o600 });
      const savedState = fileHash(statePath(env));
      moved(await management().moveLegacyLogin());
      const copied = await destination();
      sameMaterial(copied, source);
      assert.ok(copied.writeId, "copy must carry its own write proof");
      assert.notEqual(copied.writeId, source.writeId);
      assert.equal(
        fileHash(statePath(env)),
        savedState,
        "saved needsReauth evidence cannot be reset by a copy"
      );
      break;
    }
    case "L1": {
      // REQ-20: actual persistence through the real Keychain store and fake security.
      seedConfig([]);
      assert.equal(existsSync(legacyPath), false);
      const result = loginResult("fresh-login");

      const lines = await management({ pkce: async () => result }).loginCodex();

      assert.equal(entry().accounts.length, 1);
      const created = entry().accounts[0]!;
      assert.match(created.id, /^[a-z0-9]{12}$/);
      assert.equal(created.label, "default");
      assert.equal(created.store, "keychain");
      assert.notEqual(created.enabled, false);
      assert.equal(created.identity?.chatgptAccountId, result.identity.chatgptAccountId);
      assert.equal(
        existsSync(legacyPath),
        false,
        "fresh Keychain login must never create the shared file"
      );
      assertSavedLogin(await destination(created.id), result);
      assert.equal(fake.itemNames().length, 1);
      assert.equal(fake.adds().length, 1);
      await assertNoOwnedNotice(lines);
      break;
    }
    case "L2": {
      // REQ-21: the durable move must finish before the PKCE result is requested.
      const source = await seedLegacy(token(), []);
      const result = loginResult("relogin-after-move");
      let movedRow: Row | undefined;
      let copied: StoredTokenRecord | undefined;

      const lines = await management({
        pkce: async () => {
          assert.equal(entry().accounts.length, 1);
          movedRow = structuredClone(entry().accounts[0]!);
          assert.equal(movedRow.store, "keychain");
          assert.equal(movedRow.label, "default");
          assert.equal(entry().legacyCodexSuppressed, true);
          assert.equal(
            existsSync(legacyPath),
            false,
            "login must await deletion/publication before PKCE"
          );
          copied = await destination(movedRow.id);
          sameMaterial(copied, source);
          return result;
        },
      }).loginCodex();

      assert.ok(movedRow && copied, "PKCE must run after a completed move");
      assert.equal(entry().accounts.length, 1);
      const loggedIn = entry().accounts[0]!;
      assert.equal(
        loggedIn.id,
        movedRow.id,
        "re-login must reuse the moved row, not add another account"
      );
      assert.equal(loggedIn.label, movedRow.label);
      assert.equal(loggedIn.addedAt, movedRow.addedAt);
      assert.equal(loggedIn.store, "keychain");
      assert.equal(loggedIn.identity?.chatgptAccountId, source.accountId);
      const saved = await destination(loggedIn.id);
      assertSavedLogin(saved, result);
      assert.equal(saved.generation, source.generation + 1);
      assert.notEqual(saved.writeId, copied.writeId);
      assert.equal(entry().legacyCodexSuppressed, true);
      assert.equal(existsSync(legacyPath), false);
      assert.equal(fake.itemNames().length, 1);
      assert.equal(
        fake.adds().length,
        2,
        "copy and successful re-login each persist once to the same item"
      );
      await assertNoOwnedNotice(lines);
      break;
    }
    case "L4": {
      // REQ-23: MTL-371, the alternate config does not own the shared file.
      await seedLegacy();
      const defaultHash = fileHash(defaultConfig);
      const legacyHash = fileHash(legacyPath);
      activeConfig = join(appHome, "alternate.json");
      env.CLAUDISH_CONFIG = activeConfig;
      seedConfig([]);
      const result = loginResult("alternate-login", "alternate-codex-identity");

      const lines = await management({ pkce: async () => result }).loginCodex();

      assert.equal(
        fileHash(defaultConfig),
        defaultHash,
        "alternate login must not mutate the default config"
      );
      assert.equal(
        fileHash(legacyPath),
        legacyHash,
        "alternate login must not overwrite or consume shared material"
      );
      assert.equal(entry().accounts.length, 1);
      const created = entry().accounts[0]!;
      assert.match(created.id, /^[a-z0-9]{12}$/);
      assert.notEqual(created.id, ref.id);
      assert.equal(created.label, "default");
      assert.equal(created.store, "keychain");
      assert.equal(created.identity?.chatgptAccountId, result.identity.chatgptAccountId);
      assertSavedLogin(await destination(created.id), result);
      assert.equal(
        fake.item("openai-codex:" + ref.id),
        undefined,
        "default legacy row must not be moved"
      );
      assert.equal(fake.itemNames().length, 1);
      assert.equal(fake.adds().length, 1);
      await assertNoOwnedNotice(lines);
      break;
    }
    case "L6-success": {
      // REQ-25: exercise the unchanged legacy login, not a hand-written save callback.
      seedConfig([]);
      assert.equal(env.CLAUDISH_DISABLE_KEYCHAIN, "1");
      assert.equal(codexLoginUsesKeychain(env), false);
      const { CodexOAuth } = await import("../codex-oauth.js");
      CodexOAuth._resetInstanceForTests();
      const material = loginResult("disabled-keychain-login").credentials;
      const now = Date.now();
      const pkceDeps: CodexPkceDeps = {
        now: () => now,
        browser: async () => {},
        callback: async (options) => {
          const redirectUri = "http://localhost:" + options.port + "/auth/callback";
          await options.openBrowser(options.authorize(redirectUri));
          return { authCode: "isolated-test-auth-code", state: options.state, redirectUri };
        },
        fetch: Object.assign(
          async (input: Parameters<typeof fetch>[0]) => {
            const url = input instanceof Request ? input.url : String(input);
            assert.ok(
              env.CLAUDISH_TEST_UPSTREAM,
              "the isolated harness must configure its test upstream"
            );
            const tokenUrl = new URL("/oauth/token", env.CLAUDISH_TEST_UPSTREAM).href;
            assert.equal(url, tokenUrl, "fake fetch permits only the isolated token exchange");
            return Response.json({
              access_token: material.access_token,
              refresh_token: material.refresh_token,
              expires_in: 3600,
              token_type: "Bearer",
            });
          },
          { preconnect: () => {} }
        ) as typeof fetch,
      };

      await CodexOAuth.getInstance().login(pkceDeps);

      assert.equal(existsSync(legacyPath), true);
      const saved = await legacy.read(ref, { uncached: true });
      assert.ok(
        saved,
        "successful disabled-Keychain login must persist readable legacy credentials"
      );
      assert.equal(digest(saved.accessToken), digest(material.access_token));
      assert.equal(digest(saved.refreshToken), digest(material.refresh_token));
      assert.equal(saved.fingerprint, fingerprintOf(material.refresh_token));
      assert.ok(saved.expiresAt > now, "legacy credential must have a usable expiry");
      if (process.platform !== "win32") assert.equal(statSync(legacyPath).mode & 0o777, 0o600);
      assert.equal(
        entry().accounts.length,
        0,
        "disabled-Keychain login must not enroll an account row"
      );
      assert.equal(fake.calls().length, 0, "legacy login must never reach even the fake Keychain");
      break;
    }
    case "L7": {
      // REQ-26: another stable identity must not replace a configured row.
      seedConfig([row({ store: "keychain", label: "my-default" })], true);
      const source = token();
      await keychain.write(ref, source);
      const before = snapshotBytes();
      const beforeItem = fake.item("openai-codex:" + ref.id);
      assert.ok(beforeItem);
      const beforeItemHash = digest(beforeItem);
      const initialAdds = fake.adds().length;
      const result = loginResult("wrong-identity-login", "different-codex-identity");

      await assert.rejects(
        management({ pkce: async () => result }).loginCodex(),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /different Codex identity/i);
          assert.ok(error.message.includes("my-default"), "refusal must name the configured label");
          assert.ok(
            error.message.includes("claudish account add codex"),
            "refusal must explain how to add the identity"
          );
          assert.ok(
            error.message.includes("claudish account remove codex my-default"),
            "refusal must explain how to remove the configured identity"
          );
          assert.equal(
            error.message.includes("claudish logout codex"),
            false,
            "refusal must not recommend the unsupported configured-row logout"
          );
          assert.ok(
            error.message.includes("claudish login codex"),
            "replacement guidance must include login again"
          );
          return true;
        }
      );

      assertKept(before);
      const afterItem = fake.item("openai-codex:" + ref.id);
      assert.ok(afterItem, "refusal must not delete the existing Keychain item");
      assert.equal(
        digest(afterItem),
        beforeItemHash,
        "refusal must leave every byte of the item unchanged"
      );
      sameMaterial(await destination(), source);
      assert.equal(fake.adds().length, initialAdds);
      assert.equal(fake.itemNames().length, 1);
      break;
    }
    case "L3": {
      // REQ-22
      seedConfig(
        [
          row({ store: "keychain" }),
          row({
            id: "bbbbbbbbbbbb",
            label: "second",
            store: "keychain",
            identity: { chatgptAccountId: "second-identity" },
          }),
        ],
        true
      );
      const before = snapshotBytes();
      let pkceCalls = 0;
      await assert.rejects(
        management({
          pkce: async () => {
            pkceCalls++;
            throw new Error("browser must not open");
          },
        }).loginCodex(),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Codex has 2 accounts/);
          assert.ok(error.message.includes("claudish account login codex"));
          return true;
        }
      );
      assert.equal(pkceCalls, 0);
      assertKept(before);
      assert.equal(fake.calls().length, 0);
      break;
    }
    case "L5": {
      // REQ-24
      await seedLegacy();
      const before = snapshotBytes();
      fake.faults({ readExit: 1 });
      let pkceCalls = 0;
      await assert.rejects(
        management({
          pkce: async () => {
            pkceCalls++;
            throw new Error("browser must not open");
          },
        }).loginCodex(),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Keychain/i);
          assert.match(error.message, /kept/i);
          assert.match(error.message, /unlock/i);
          return true;
        }
      );
      assert.equal(pkceCalls, 0);
      assertKept(before);
      assert.equal(fake.adds().length, 0);
      break;
    }
    case "L6-routing": {
      // REQ-25 partial; successful legacy PKCE/file write is blocked.
      seedConfig([]);
      assert.equal(codexLoginUsesKeychain(env), false);
      assert.equal(fake.calls().length, 0);
      break;
    }
    default:
      await supplementary();
  }
}

async function supplementary(): Promise<void> {
  if (scenario === "background") {
    // REQ-27
    await seedLegacy();
    starter._resetLegacyMoveForTests();
    const entered = signal<void>();
    const release = signal<void>();
    let now = 100_000;
    const options = {
      env,
      configPath: () => activeConfig,
      registry,
      now: () => now,
      management: {
        ...deps,
        moveHooks: {
          beforePublish: async () => {
            entered.resolve();
            await release.promise;
            throw new Error("defer first background publication");
          },
        },
      },
    };
    assert.equal(starter.startLegacyCodexMove(options), undefined);
    const first = starter._legacyMoveForTests();
    assert.ok(first);
    await entered.promise;
    const { CodexOAuth } = await import("../codex-oauth.js");
    CodexOAuth._resetInstanceForTests();
    const facade = CodexOAuth.getInstance();
    assert.equal(
      digest(await facade.getAccessToken()),
      digest(token().accessToken),
      "pre-move facade keeps signing while background move waits"
    );
    starter.startLegacyCodexMove(options);
    assert.equal(starter._legacyMoveForTests(), first, "concurrent triggers must share one flight");
    release.resolve();
    assert.equal((await first).kind, "deferred");
    const calls = fake.calls().length;
    assert.equal(starter.LEGACY_MOVE_RETRY_MS, 600_000);
    now += starter.LEGACY_MOVE_RETRY_MS - 1;
    starter.startLegacyCodexMove(options);
    assert.equal(fake.calls().length, calls, "request-path cooldown prevents another attempt");
    // Explicit command ignores the request-path cooldown and resumes existing item.
    moved(await management().moveLegacyLogin());
    starter._resetLegacyMoveForTests();
    return;
  }
  if (scenario === "background-boundary") {
    // REQ-27, exact retry threshold
    await seedLegacy();
    starter._resetLegacyMoveForTests();
    fake.faults({ readExit: 1 });
    let now = 200_000;
    const options = {
      env,
      configPath: () => activeConfig,
      registry,
      now: () => now,
      management: deps,
    };
    starter.startLegacyCodexMove(options);
    const first = starter._legacyMoveForTests();
    assert.ok(first);
    deferred(await first, "keychain-unreadable");
    now += starter.LEGACY_MOVE_RETRY_MS - 1;
    const count = fake.calls().length;
    starter.startLegacyCodexMove(options);
    await Bun.sleep(0);
    assert.equal(starter._legacyMoveForTests(), first);
    assert.equal(fake.calls().length, count);
    fake.faults({});
    now++;
    starter.startLegacyCodexMove(options);
    const next = starter._legacyMoveForTests();
    assert.ok(next);
    assert.notEqual(next, first, "retry must start at the 10-minute boundary");
    moved(await next);
    return;
  }
  if (scenario === "verb-enable" || scenario === "verb-disable" || scenario === "verb-rename") {
    // REQ-28
    await seedLegacy();
    const verb = scenario.slice(5);
    const commands = {
      enable: { verb: "enable" as const, selector: "default" },
      disable: { verb: "disable" as const, selector: "default" },
      rename: { verb: "rename" as const, selector: "default", newLabel: "renamed" },
    };
    assert.ok(verb === "enable" || verb === "disable" || verb === "rename");
    const lines = await management().run(commands[verb]);
    assert.equal(entry().accounts[0]!.store, "keychain");
    assert.equal(entry().legacyCodexSuppressed, true);
    assert.equal(existsSync(legacyPath), false);
    assert.equal(entry().accounts[0]!.enabled, verb !== "disable");
    assert.equal(entry().accounts[0]!.label, verb === "rename" ? "renamed" : "default");
    assert.equal(
      [...lines, ...printed].some((line) => /credential file stays/i.test(line)),
      false
    );
    return;
  }
  if (scenario === "verb-deferred-add" || scenario === "verb-deferred-login") {
    // REQ-28
    await seedLegacy();
    const before = snapshotBytes();
    fake.faults({ readExit: 1 });
    let pkceCalls = 0;
    const command =
      scenario === "verb-deferred-add"
        ? { verb: "add" as const, label: "new-account" }
        : { verb: "login" as const, selector: "default" };
    await assert.rejects(
      management({
        pkce: async () => {
          pkceCalls++;
          throw new Error("browser must not open");
        },
      }).run(command),
      /kept/i
    );
    assert.equal(pkceCalls, 0);
    assertKept(before);
    return;
  }
  if (scenario === "read-only") {
    // REQ-28, supplied read APIs only
    await seedLegacy(token(), []);
    const before = snapshotBytes();
    assert.equal(registry.hasConfiguredAccounts("openai-codex"), true);
    assert.equal(registry.listAccounts("openai-codex").length, 1);
    assert.equal(registry.snapshot("openai-codex").accounts["openai-codex"][0]!.legacy, true);
    assertKept(before);
    assert.equal(fake.calls().length, 0);
    return;
  }
  if (scenario === "facade-moved" || scenario === "facade-logout") {
    // REQ-29
    await seedLegacy(token(), []);
    const { CodexOAuth, CodexOAuthLocalError, CodexOAuthRefreshError } = await import(
      "../codex-oauth.js"
    );
    CodexOAuth._resetInstanceForTests();
    const facade = CodexOAuth.getInstance();
    assert.equal(facade.hasCredentials(), true);
    if (scenario === "facade-moved") {
      moved(await management().moveLegacyLogin());
    } else {
      await legacy.delete(ref);
      registry.invalidate();
    }
    assert.equal(existsSync(legacyPath), false);
    await assert.rejects(facade.forceRefresh(), (error: unknown) => {
      assert.ok(error instanceof Error);
      if (scenario === "facade-moved") {
        assert.ok(error instanceof CodexOAuthLocalError);
        assert.equal(error instanceof CodexOAuthRefreshError, false);
        assert.equal("upstreamStatus" in error, false);
        assert.match(error.message, /moved|Keychain|retry/i);
      } else {
        assert.ok(error instanceof CodexOAuthRefreshError);
        assert.equal(error.upstreamStatus, 401);
      }
      return true;
    });
    return;
  }
  if (scenario === "display") {
    // REQ-31
    seedConfig([row({ store: "keychain" })], true);
    const { hasOAuthCredentials } = await import("../oauth-registry.js");
    assert.equal(hasOAuthCredentials("openai-codex"), true);
    assert.equal(fake.calls().length, 0, "display uses configuration, not readiness");
    seedConfig([], true);
    assert.equal(hasOAuthCredentials("openai-codex"), false);
    assert.equal(fake.calls().length, 0);
    return;
  }
  if (scenario === "messages") {
    // REQ-32
    const reasons: LegacyMoveDeferral[] = [
      "gate-busy",
      "file-unreadable",
      "keychain-unreadable",
      "keychain-write-failed",
      "keychain-unverified",
      "config-unavailable",
      "target-changed",
    ];
    for (const reason of reasons) {
      const message = legacyMoveDeferredMessage(
        { kind: "deferred", reason, detail: "test failure" },
        env
      );
      assert.match(message, /Keychain/i);
      assert.match(message, /kept/i);
      assert.ok(message.includes(reason));
      if (reason === "gate-busy" || reason === "config-unavailable")
        assert.match(message, /retry in a moment/i);
      if (reason.startsWith("keychain-")) assert.match(message, /unlock.*keychain/i);
      if (reason === "file-unreadable") assert.match(message, /repair or remove/i);
    }
    assert.equal(fake.calls().length, 0);
    return;
  }
  if (scenario === "target-changed") {
    // REQ-32 / §3.2 sameTarget
    await seedLegacy();
    const beforeFile = fileHash(legacyPath);
    const outcome = await management({
      moveHooks: {
        beforePublish: () => {
          const config = readConfig();
          config.subscriptionAccounts["openai-codex"].accounts[0]!.identity = {
            chatgptAccountId: "changed-by-another-config-writer",
          };
          saveConfig(config);
        },
      },
    }).moveLegacyLogin();
    deferred(outcome, "target-changed");
    assert.equal(entry().accounts[0]!.store, "legacy-codex-file");
    assert.equal(
      entry().accounts[0]!.identity?.chatgptAccountId,
      "changed-by-another-config-writer"
    );
    assert.equal(fileHash(legacyPath), beforeFile);
    return;
  }
  throw new Error("unknown isolated test scenario: " + scenario);
}

// Test-process watchdog only: it never starts, times out, or kills security.
const watchdog = setTimeout(() => {
  for (const child of peers) if (child.exitCode === null) child.kill();
  process.exit(124);
}, 22_000);
try {
  await run();
  fake.assertTranscript();
} finally {
  clearTimeout(watchdog);
  // Child processes are owned by this scenario; never kill product security.
  for (const child of peers) {
    if (child.exitCode === null) child.kill();
  }
  await Promise.all(peers.map((child) => child.exited));
}
