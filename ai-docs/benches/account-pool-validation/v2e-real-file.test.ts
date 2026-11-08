/**
 * `v2e-real.ts --account <legacy-codex-file id>` (Jack, 2026-11-03): the same race on
 * `codex-oauth.json`. Pins the three things that differ from the keychain run, against the
 * PRODUCT's own lock-path function and file store, in a temp HOME: no keychain, no network.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountLockPath,
  accountRefreshLockPath,
} from "../../../packages/cli/src/auth/accounts/paths.ts";
import {
  LegacyCodexFileStore,
  type StoredTokenRecord,
} from "../../../packages/cli/src/auth/accounts/token-store.ts";
import {
  CHANGED_UNDER_US,
  FILE_STORE_RACE,
  type Gate,
  type ItemStore,
  NOT_STRICT_EVIDENCE,
  type RealRecord,
  type RealVerdict,
  classifyVerdict,
  compareAndWriteStore,
  forceExpiry,
  planAccount,
  restoreUnderGate,
} from "./v2e-real-lib.ts";

const ID = "4463fa7e5c82";

describe("planAccount: the store and the product's lock path", () => {
  const env = { HOME: "/home/x" };
  const lockOf = (r: Parameters<typeof accountRefreshLockPath>[0]) =>
    accountRefreshLockPath(r, env);

  test("legacy-codex-file: the gate is legacy-codex.lock, not <id>.lock", () => {
    const p = planAccount({ id: ID, store: "legacy-codex-file" }, ID, lockOf);
    expect(p.kind).toBe("legacy-codex-file");
    expect(p.lockPath.endsWith("/legacy-codex.lock")).toBe(true);
    // The path a serve takes for this account is not the one an id-built path names.
    expect(p.lockPath).not.toBe(accountLockPath("openai-codex", ID, env));
  });
  test("keychain: the gate is <id>.lock (unchanged)", () => {
    const p = planAccount({ id: "dc53ea1b2616", store: "keychain" }, "dc53ea1b2616", lockOf);
    expect(p).toEqual({
      kind: "keychain",
      lockPath: accountLockPath("openai-codex", "dc53ea1b2616", env),
    });
  });
  test("absent account or another store: refused", () => {
    expect(() => planAccount(undefined, ID, lockOf)).toThrow("not in the real config");
    expect(() => planAccount({ id: ID, store: "file" }, ID, lockOf)).toThrow("uses store file");
  });
});

describe("classifyVerdict on a file store: never V2e, the memo window does not apply", () => {
  const all: RealVerdict = {
    bothOk: true,
    generationAdvancedByOne: true,
    fingerprintChanged: true,
    expiryInFuture: true,
    allOnThisAccount: true,
    noReauth: true,
    memoWindowMet: false,
  };
  test("all race fields true, memo missed: exit 0, labelled, strict false", () => {
    const c = classifyVerdict(all, "legacy-codex-file");
    expect(c).toMatchObject({ exitCode: 0, observational: true, strict: false });
    expect(c.lines[1]).toContain(FILE_STORE_RACE);
    expect(c.lines.join("\n")).not.toContain("strict V2e form: PASS");
  });
  test("memo met: still not strict, still labelled", () => {
    const c = classifyVerdict({ ...all, memoWindowMet: true }, "legacy-codex-file");
    expect(c.strict).toBe(false);
    expect(c.lines[1]).toContain(FILE_STORE_RACE);
  });
  test("a race field false: exit 1", () => {
    expect(classifyVerdict({ ...all, noReauth: false }, "legacy-codex-file").exitCode).toBe(1);
  });
  test("keychain default unchanged: memo missed fails", () => {
    const c = classifyVerdict(all);
    expect(c.exitCode).toBe(1);
    expect(c.lines.join("\n")).toContain(NOT_STRICT_EVIDENCE);
  });
});

describe("forceExpiry + restore through the product's LegacyCodexFileStore", () => {
  const ORIGINAL = {
    access_token: "access-legacy",
    refresh_token: "refresh-legacy",
    expires_at: 2_000_000_000_000,
    account_id: "acct-1",
    id_token: "kept-unknown-key",
    last_refresh: "2026-11-01T00:00:00Z",
  };
  const setup = () => {
    const path = join(mkdtempSync(join(tmpdir(), "v2e-file-")), "codex-oauth.json");
    writeFileSync(path, JSON.stringify(ORIGINAL), { mode: 0o600 });
    const legacy = new LegacyCodexFileStore({ path });
    const ref = { provider: "openai-codex", id: ID } as never;
    const store: ItemStore = {
      read: async () => (await legacy.read(ref)) as RealRecord | null,
      write: async (r) => legacy.write(ref, r as unknown as StoredTokenRecord),
    };
    const gate: Gate = (work) => work(() => true);
    return { path, store, gate };
  };

  test("forced: expires_at 0, every other key in the file kept", async () => {
    const { path, store, gate } = setup();
    const { forced } = await forceExpiry(store, gate);
    expect(forced.expiresAt).toBe(0);
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.expires_at).toBe(0);
    expect(file.id_token).toBe("kept-unknown-key");
    expect(file.last_refresh).toBe(ORIGINAL.last_refresh);
    expect(file.refresh_token).toBe(ORIGINAL.refresh_token);
  });

  test("restored: the original expiry back, tokens and unknown keys unchanged", async () => {
    const { path, store, gate } = setup();
    const { before } = await forceExpiry(store, gate);
    expect(await restoreUnderGate(store, () => true, before)).toBe("restored");
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.expires_at).toBe(ORIGINAL.expires_at);
    expect(file.access_token).toBe(ORIGINAL.access_token);
    expect(file.id_token).toBe("kept-unknown-key");
  });

  /**
   * Review round 10 (GPT HIGH 1): an ungated legacy login (`CodexOAuth.login`) lands between the
   * gated read and the write. The store used by v2e-real.ts must refuse and keep the login.
   */
  const LOGIN = {
    access_token: "access-new-login",
    refresh_token: "refresh-new-login",
    expires_at: 2_200_000_000_000,
    claudish_generation: 7,
  };
  const loginLandsOnRead = (path: string, store: ItemStore, onRead: number): ItemStore => {
    let reads = 0;
    return {
      async read() {
        reads++;
        if (reads === onRead) writeFileSync(path, JSON.stringify(LOGIN));
        return store.read();
      },
      write: (r) => store.write(r),
    };
  };

  test("R10: a login after the force's read: the force refuses, the login is kept", async () => {
    const { path, store, gate } = setup();
    // read 1: forceExpiry's gated read; read 2: the compare-and-write re-read.
    const guarded = compareAndWriteStore(loginLandsOnRead(path, store, 2));
    await expect(forceExpiry(guarded, gate)).rejects.toThrow(CHANGED_UNDER_US);
    expect(JSON.parse(readFileSync(path, "utf8")).refresh_token).toBe("refresh-new-login");
  });

  test("R10: a login after the restore's read: the restore refuses, the login is kept", async () => {
    const { path, store, gate } = setup();
    const { before } = await forceExpiry(compareAndWriteStore(store), gate);
    // read 1: restoreUnderGate's read; read 2: the compare-and-write re-read.
    const guarded = compareAndWriteStore(loginLandsOnRead(path, store, 2));
    await expect(restoreUnderGate(guarded, () => true, before)).rejects.toThrow(CHANGED_UNDER_US);
    expect(JSON.parse(readFileSync(path, "utf8")).refresh_token).toBe("refresh-new-login");
  });

  test("R10: compare-and-write lets the ordinary force and restore through", async () => {
    const { path, store, gate } = setup();
    const guarded = compareAndWriteStore(store);
    const { before } = await forceExpiry(guarded, gate);
    expect(await restoreUnderGate(guarded, () => true, before)).toBe("restored");
    expect(JSON.parse(readFileSync(path, "utf8")).expires_at).toBe(ORIGINAL.expires_at);
  });

  test("a rotation after the force (new refresh token): restore writes nothing", async () => {
    const { path, store, gate } = setup();
    const { before } = await forceExpiry(store, gate);
    const rotated = {
      ...JSON.parse(readFileSync(path, "utf8")),
      access_token: "access-rotated",
      refresh_token: "refresh-rotated",
      expires_at: 2_100_000_000_000,
      claudish_generation: 1,
    };
    writeFileSync(path, JSON.stringify(rotated));
    expect(await restoreUnderGate(store, () => true, before)).not.toBe("restored");
    expect(JSON.parse(readFileSync(path, "utf8")).refresh_token).toBe("refresh-rotated");
  });
});
