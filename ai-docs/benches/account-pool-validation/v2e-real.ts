/**
 * V2e on a REAL account (Jack's decision, 2026-11-02): the keychain memo bypass, raced by two
 * built `claudish serve` processes against the REAL OpenAI token endpoint.
 *
 *   bun ai-docs/benches/account-pool-validation/v2e-real.ts --out <dir> [--account <id>]
 *
 * `--account` (default `dc53ea1b2616`) may also name a `legacy-codex-file` account (Jack,
 * 2026-11-03: the default account `4463fa7e5c82`). The same race then runs on
 * `~/.claudish/codex-oauth.json` through the product's `LegacyCodexFileStore`, under the
 * product's `accountRefreshLockPath` gate (`legacy-codex.lock`), and is labelled a file-store
 * race: it is NOT V2e evidence, which is the keychain row. The steps below name the keychain.
 *
 * What it does, in order:
 *   1. checks that `dc53ea1b2616` is a keychain account in the real config;
 *   2. with the account's REFRESH GATE held (the product's own `withRefreshGate` on
 *      `~/.claudish/accounts/locks/openai-codex/dc53ea1b2616.lock`, the lock every claudish
 *      process on the Mac takes before it rotates this account): reads the item UNCACHED,
 *      refuses an open refresh journal, marks the token expired (`expiresAt = 0`, every other
 *      field unchanged) through the product's `writeKeychainItem`, and reads it back
 *      (`v2e-real-lib.ts` `forceExpiry`). Prints only generation, expiry and a fingerprint
 *      prefix: never a token;
 *   3. starts two `serve` processes with the REAL HOME (so `security` finds the login keychain),
 *      a run-only config naming only that account (`CLAUDISH_CONFIG`), and the REAL accounts
 *      folder, so their refresh gate is the same lock;
 *   4. posts one request to each in the same tick and reports status, account, generation;
 *   5. at the end, however it ends (error, SIGINT, SIGTERM, no race; `shutdownUnderGate`):
 *      stops issuing requests, then waits up to 60 s for the account's REFRESH GATE, so a serve
 *      that is persisting a rotation OpenAI already accepted finishes first. Holding the gate,
 *      it kills both serves and, if the item is STILL the forced one (same generation and
 *      fingerprint, `expiresAt === 0`, no journal, every other field unchanged), puts the
 *      original expiry back (`restoreUnderGate`); then releases. Gate not free in 60 s: kills
 *      anyway and prints that a refresh may have been interrupted (a `claudish` login may be
 *      needed). A second Ctrl-C prints "finishing safely, please wait" and skips nothing.
 *      It never writes over a newer generation. Writes the serves' full stdout and stderr to
 *      --out and scans every file there for credential shapes.
 *
 * The rollback snapshot is kept BEFORE the expiry write (`forceExpiry`'s `onSnapshot`): a
 * write that commits and then throws, or a verification read that throws, is restored in
 * place under the same gate hold, and the end restores again if that failed.
 *
 * Review round 8: the serves run in their OWN process group (`startServe({detached: true})`),
 * so a terminal Ctrl-C reaches only this process and never a serve mid-rotation; the run
 * itself (`v2e-real-run.ts` `createRealRun`) stops at every await point once the end began,
 * registers each serve at spawn, decides the restore with the gate held, and writes every
 * file of --out and every console line redacted. This file only wires the live pieces.
 *
 * Exit code: 1 when anything threw, the restore failed, the shape scan found anything, or ANY
 * verdict field is false. The output separates the observational result from the strict V2e
 * form, which also needs both replies inside the 3 s memo window; otherwise it prints
 * "NOT EVIDENCE for the strict V2e form".
 *
 * A `security` call that waits (the product's own 10 s bound) stops the script.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { accountRefreshLockPath } from "../../../packages/cli/src/auth/accounts/paths.ts";
import {
  isGateUnavailable,
  withRefreshGate,
} from "../../../packages/cli/src/auth/accounts/refresh-lock.ts";
import {
  LegacyCodexFileStore,
  type StoredTokenRecord,
} from "../../../packages/cli/src/auth/accounts/token-store.ts";
import {
  readKeychainItem,
  writeKeychainItem,
} from "../../../packages/cli/src/providers/keychain.ts";
import { scanCredentialShapes, writeScanned } from "./cred-shape-scan.ts";
import { SLOT, postMessage, startServe } from "./direct.ts";
import {
  type Gate,
  type ItemStore,
  type RealRecord,
  compareAndWriteStore,
  installSafeSignals,
  needsReauthOf,
  planAccount,
} from "./v2e-real-lib.ts";
import { createRealRun } from "./v2e-real-run.ts";

const PROVIDER = "openai-codex";
const SERVICE = "claudish-accounts";
const HOME = userInfo().homedir;

const argOf = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i < 0 ? undefined : process.argv[i + 1];
};
const outArg = argOf("--out");
if (!outArg) {
  console.error("usage: v2e-real.ts --out <dir> [--account <id>]   (default account dc53ea1b2616)");
  process.exit(2);
}
const ACCOUNT_ID = argOf("--account") ?? "dc53ea1b2616";
const OUT = resolve(outArg);
mkdirSync(OUT, { recursive: true });

type ConfigAccount = { id: string; store?: string };
const realAccount = (): ConfigAccount | undefined => {
  const realCfg = JSON.parse(readFileSync(join(HOME, ".claudish", "config.json"), "utf8"));
  return realCfg.subscriptionAccounts?.[PROVIDER]?.accounts?.find(
    (a: ConfigAccount) => a.id === ACCOUNT_ID
  );
};

// The store and the gate follow the account's `store` in the real config. The lock path is
// the product's own `accountRefreshLockPath`: the legacy file's gate is `legacy-codex.lock`.
const plan = planAccount(realAccount(), ACCOUNT_ID, (r) => accountRefreshLockPath(r, { HOME }));

const KC_ACCOUNT = `${PROVIDER}:${ACCOUNT_ID}`;
/** The product's own keychain read (uncached) and write: every field of the record kept. */
const keychainStore: ItemStore = {
  async read() {
    const raw = readKeychainItem(SERVICE, KC_ACCOUNT, { uncached: true });
    return raw === null ? null : (JSON.parse(raw) as RealRecord);
  },
  async write(record) {
    writeKeychainItem(SERVICE, KC_ACCOUNT, JSON.stringify(record));
  },
};

/**
 * The product's own `LegacyCodexFileStore` on `~/.claudish/codex-oauth.json`: its read gives
 * the pool's record, its write merges into the file and keeps every other key.
 */
const legacy = new LegacyCodexFileStore({ env: { ...process.env, HOME } });
const legacyRef = { provider: PROVIDER, id: ACCOUNT_ID } as never;
// Compare-and-write: a legacy login writes this file WITHOUT the refresh gate (review round 10).
const fileStore: ItemStore = compareAndWriteStore({
  async read() {
    return (await legacy.read(legacyRef)) as RealRecord | null;
  },
  async write(record) {
    await legacy.write(legacyRef, record as unknown as StoredTokenRecord);
  },
});

const store = plan.kind === "keychain" ? keychainStore : fileStore;
const itemName = plan.kind === "keychain" ? KC_ACCOUNT : legacy.describe();

/** The product's refresh gate for this account, at the path the serves (real HOME) use. */
const gate: Gate = (work) =>
  withRefreshGate(PROVIDER, ACCOUNT_ID, (handle) => work(() => handle.holdsLock()), {
    path: plan.lockPath,
  });

/**
 * The same gate, retried on the product's acquire timeout (20 s per try) until `boundMs` has
 * passed. Only a TIMEOUT is retried, and never once `work` has started.
 */
const gateWithin =
  (boundMs: number): Gate =>
  async (work) => {
    const deadline = Date.now() + boundMs;
    for (;;) {
      let entered = false;
      try {
        return await gate((holdsLock) => {
          entered = true;
          return work(holdsLock);
        });
      } catch (err) {
        const retry =
          !entered && isGateUnavailable(err) && err.reason === "timeout" && Date.now() < deadline;
        if (!retry) throw err;
      }
    }
  };

const serveEnv: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME,
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  LANG: "en_US.UTF-8",
  TERM: "dumb",
  CLAUDISH_CONFIG: join(OUT, "config.json"),
  CLAUDISH_ACCOUNTS_LOG: join(OUT, "accounts.jsonl"),
  CLAUDISH_DISABLE_OP: "1",
  CLAUDISH_STATS: "0",
  CLAUDISH_TELEMETRY: "0",
};

const run = createRealRun({
  account: ACCOUNT_ID,
  kcAccount: itemName,
  storeKind: plan.kind,
  store,
  gate,
  gateWithin,
  runConfig() {
    const realCfg = JSON.parse(readFileSync(join(HOME, ".claudish", "config.json"), "utf8"));
    const section = realCfg.subscriptionAccounts?.[PROVIDER];
    const acct = section?.accounts?.find((a: { id: string }) => a.id === ACCOUNT_ID);
    // Re-read: the store this run planned for must still be the account's store.
    if (!acct || acct.store !== plan.kind)
      throw new Error(`${ACCOUNT_ID} is no longer a ${plan.kind} account in the real config`);
    return { subscriptionAccounts: { [PROVIDER]: { ...section, accounts: [acct] } } };
  },
  slots: [{ slot: SLOT, model: "gpt-6.1-sol", provider: PROVIDER }],
  // Detached: the serves are in their OWN process group, so a terminal Ctrl-C reaches only
  // this process, which kills them after it holds the refresh gate (review round 8, GPT HIGH 1).
  startServe: (onSpawn) =>
    startServe({
      env: serveEnv,
      cwd: OUT,
      slotsPath: join(OUT, "slots.json"),
      onSpawn,
      detached: true,
    }),
  postMessage: (url) => postMessage(url, "Reply with the single word: ok"),
  readAccountsLog: () => readFileSync(join(OUT, "accounts.jsonl"), "utf8"),
  readNeedsReauth() {
    // Only THIS account's mark, at the path the state store writes it.
    try {
      const st = JSON.parse(
        readFileSync(join(HOME, ".claudish", "accounts", "state.json"), "utf8")
      );
      return needsReauthOf(st, ACCOUNT_ID);
    } catch {
      return "state.json not readable";
    }
  },
  // Every file of --out is written redacted; the bench seeded nothing, so nothing is known.
  writeOut: (name, text) => writeScanned(join(OUT, name), text, []),
  scanOut: () => scanCredentialShapes(OUT, []),
  print: (line) => console.log(line),
  printErr: (line) => console.error(line),
});

installSafeSignals(
  process,
  (signal) => run.interrupt(signal),
  (code) => process.exit(code),
  (line) => console.error(line)
);
// Safety net only: the end has normally killed and confirmed every tree already. A detached
// serve is not killed by the terminal, so nothing this run spawned may outlive this process.
process.on("exit", () => run.killAllSync());

await run.main();
process.exitCode = run.exitCode();
