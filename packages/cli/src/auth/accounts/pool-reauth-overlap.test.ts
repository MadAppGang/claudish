/**
 * MTL-372 review round 4, R4-1: overlapping acquires and the re-auth stamp.
 *
 * Each lease stamps the row as a re-auth attempt before it awaits, and a lease
 * that tried no credential withdraws the stamp. The withdrawal used to put back
 * the value it saw at stamp time. With two acquires in flight on one row, the
 * second saw the FIRST one's stamp, so when both withdrew (first, then second)
 * the first's in-flight stamp came back as if committed. A later request read
 * the due `needsReauth` retry as "attempted just now" and answered the terminal
 * NeedsReauthError with nothing attempted.
 *
 * Isolation: temp directory for config, state and locks; an in-memory fake
 * store whose reads are released two at a time; config reads fail through the
 * registry's `readFile` seam; the token endpoint is a test-scoped `fetch` stub.
 * No Keychain, no real ~/.claudish.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RefreshUnavailableError } from "./errors.js";
import { AccountPool } from "./pool.js";
import { AccountRegistry } from "./registry.js";
import { StateStore } from "./state-store.js";
import { type StoredTokenRecord, type TokenStore, fingerprintOf } from "./token-store.js";
import type { AccountRef } from "./types.js";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const ID = "4463fa7e5c82";
const REF: AccountRef = { provider: "openai-codex", id: ID, label: "default" };

let dir = "";
let configPath = "";
let state: StateStore;
let failConfigRead = false;
let realFetch: typeof fetch;
let exchanged = 0;

function writeConfig(): void {
  writeFileSync(
    configPath,
    `${JSON.stringify({
      subscriptionAccounts: {
        "openai-codex": {
          generation: 1,
          accounts: [
            {
              id: ID,
              label: "default",
              store: "file",
              identity: { chatgptAccountId: "acct-owner" },
              addedAt: "2026-09-12T00:00:00.000Z",
            },
          ],
        },
      },
    })}\n`,
    "utf8"
  );
}

/** The material the mark failed against: same generation, same fingerprint. */
function sameMaterial(): StoredTokenRecord {
  return {
    accessToken: "access-owner",
    refreshToken: "refresh-owner",
    expiresAt: NOW + 3_600_000,
    generation: 1,
    fingerprint: fingerprintOf("refresh-owner"),
    accountId: "acct-owner",
    updatedAt: NOW,
  };
}

function poolWith(read: () => Promise<StoredTokenRecord | null>): AccountPool {
  return new AccountPool("openai-codex", {
    registry: new AccountRegistry({
      configPath: () => configPath,
      legacyCodexPath: () => join(dir, "codex-oauth.json"),
      env: { CLAUDISH_DISABLE_KEYCHAIN: "1" },
      readFile: (path) => {
        if (failConfigRead && path === configPath) {
          throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), {
            code: "EACCES",
          });
        }
        return readFileSync(path, "utf-8");
      },
    }),
    state,
    now: () => NOW,
    env: { CLAUDISH_DISABLE_KEYCHAIN: "1", CLAUDISH_ACCOUNTS_DIR: join(dir, "accounts") },
    storeFactory: (): TokenStore => ({
      kind: "file",
      read,
      write: async () => {},
      delete: async () => {},
      describe: () => "isolated fake store",
    }),
  });
}

async function thrownBy(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (err) {
    return err;
  }
  throw new Error("expected the acquire to throw");
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "claudish-pool-reauth-overlap-"));
  configPath = join(dir, "config.json");
  failConfigRead = false;
  exchanged = 0;
  state = new StateStore({
    path: join(dir, "state.json"),
    lockPath: join(dir, "state.lock"),
    now: () => NOW,
  });
  writeConfig();
  await state.setNeedsReauth(REF, {
    since: NOW - 10 * 60_000, // due: 60 s after one attempt
    attempts: 1,
    lastReason: "invalid_grant",
    failedGeneration: 1,
    failedFingerprint: fingerprintOf("refresh-owner"),
  });
  realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.endsWith("/oauth/token")) throw new Error(`unexpected fetch: ${url}`);
      exchanged++;
      return Response.json({
        access_token: "access-exchanged",
        refresh_token: "refresh-exchanged",
        expires_in: 3600,
        token_type: "Bearer",
      });
    },
    { preconnect: () => {} }
  ) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  failConfigRead = false;
  rmSync(dir, { recursive: true, force: true });
});

describe("overlapping acquires that both tried no credential (R4-1)", () => {
  test("a recovered request still gets its due exchange", async () => {
    // Phase 1, every store read empty with the account list unreadable. The two
    // self-heal reads (one per acquire) are released together, so both acquires
    // reach the lease. The second joins the first's in-process lease (the token
    // manager's single flight: one lease read), and that read is held for 50 ms,
    // so both acquires have stamped the row before it settles. The first to
    // stamp then withdraws first, the order that resurrected its stamp.
    let recovered = false;
    let reads = 0;
    let healReads: Array<() => void> = [];
    const pool = poolWith(async () => {
      if (recovered) return sameMaterial();
      reads++;
      await new Promise<void>((release) => {
        if (reads > 2) {
          setTimeout(release, 50);
          return;
        }
        healReads.push(release);
        if (healReads.length === 2) {
          const batch = healReads;
          healReads = [];
          for (const go of batch) go();
        }
      });
      failConfigRead = true;
      return null;
    });

    const [first, second] = await Promise.all([thrownBy(pool.acquire()), thrownBy(pool.acquire())]);
    expect(first).toBeInstanceOf(RefreshUnavailableError);
    expect(second).toBeInstanceOf(RefreshUnavailableError);
    expect(exchanged).toBe(0);
    expect(reads).toBe(3);

    recovered = true;
    failConfigRead = false;
    const next = await pool.acquire();

    expect(next.accessToken).toBe("access-exchanged");
    expect(exchanged).toBe(1);
    // Mutation caught: restore puts back the value saved at stamp time. The
    // second acquire saved the first one's in-flight stamp and put it back last,
    // so the next request read "attempted just now" and got NeedsReauthError.
  });

  test("control: one acquire alone leaves no stamp either", async () => {
    let recovered = false;
    const pool = poolWith(async () => {
      if (recovered) return sameMaterial();
      failConfigRead = true;
      return null;
    });

    expect(await thrownBy(pool.acquire())).toBeInstanceOf(RefreshUnavailableError);

    recovered = true;
    failConfigRead = false;
    const next = await pool.acquire();

    expect(next.accessToken).toBe("access-exchanged");
    expect(exchanged).toBe(1);
  });
});
