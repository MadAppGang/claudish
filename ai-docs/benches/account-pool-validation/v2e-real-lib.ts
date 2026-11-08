/**
 * The decisions of `v2e-real.ts` (V2e on a REAL account), free of the keychain and of the
 * network so `v2e-real-lib.test.ts` can pin them with fakes. v2e-real.ts wires the real
 * pieces: the product's refresh gate (`withRefreshGate`, the lock every claudish process
 * on the Mac takes before it rotates this account) and the product's own keychain read and
 * write (`readKeychainItem(..., {uncached: true})`, `writeKeychainItem`).
 *
 * Review round 6 (GPT and Gemini, HIGH): the script forced expiry with an unlocked
 * read-modify-write. A rotation by another claudish process between the read and the write
 * was overwritten with the old (revoked) refresh token, and an aborted run left the real
 * token marked expired. Both are closed here:
 *   - `forceExpiry` reads UNCACHED with the gate held, refuses an open journal, checks the
 *     fence before the write and reads the result back;
 *   - `restoreIfStillForced` puts the original expiry back, under the same gate, only when
 *     the item is still exactly what this run forced (same generation, same fingerprint,
 *     `expiresAt === 0`, no journal, every other field unchanged). It never writes over a
 *     newer generation.
 *
 * Review round 7 (GPT HIGH 1 + 2, Gemini LOW 2):
 *   - the rollback snapshot is handed to the caller BEFORE the expiry write (`onSnapshot`),
 *     and any failure after it (a write that commits and then throws: the product's
 *     `writeKeychainItem` reads back itself; a verification read that throws) re-reads under
 *     the SAME gate hold and restores only the unchanged forced record;
 *   - `shutdownUnderGate`: an interrupted run stops issuing requests, then waits (bounded)
 *     for the account's refresh gate, so a serve that is persisting a rotation OpenAI already
 *     accepted finishes first; holding the gate it kills the serves and restores; it never
 *     kills silently when the gate stays busy.
 */

/** The keychain record as raw JSON: every field is kept on a write, known or not. */
export type RealRecord = Record<string, unknown> & {
  generation?: number;
  expiresAt?: number;
  fingerprint?: string;
  journal?: unknown;
};

/** The one item, read uncached and written whole. */
export interface ItemStore {
  /** Uncached read; null when the item is absent. */
  read(): Promise<RealRecord | null>;
  write(record: RealRecord): Promise<void>;
}

/** Runs `work` with the account's refresh gate held; `holdsLock` is the product's fence. */
export type Gate = <T>(work: (holdsLock: () => boolean) => Promise<T>) => Promise<T>;

const sameExceptExpiry = (a: RealRecord, b: RealRecord) => {
  const { expiresAt: _a, ...ra } = a;
  const { expiresAt: _b, ...rb } = b;
  return JSON.stringify(ra) === JSON.stringify(rb);
};

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** `forceExpiry`'s refusal when the run's end began first: nothing was written. */
export const RUN_ENDING = "the run is ending: not forcing expiry (nothing written)";

/**
 * Mark the item expired (`expiresAt = 0`), every other field unchanged, with the gate held.
 * The record written is the one read AFTER acquiring the gate, so a rotation that landed
 * while this script waited is the base, never overwritten. Throws (writing nothing) when the
 * item is absent, a journal is open (a refresh is in progress or was interrupted), or the
 * gate was lost before the write.
 *
 * `onSnapshot` receives the original record BEFORE the write, so the caller's end-of-run
 * restore has it whatever happens next (a signal included). A failure after the snapshot
 * restores in place, under this same gate hold, when the item is still the unchanged forced
 * record; the error then names what the in-place restore found.
 *
 * `stopping` is asked WITH THE GATE HELD, on entry and again right before the snapshot and
 * the write (review round 8, GPT HIGH 2): a run whose end began while this call waited for the
 * gate writes nothing. Between that last check and the write there is no await, so the end
 * (which sets `stopping` before it waits for the same gate) cannot slip in between.
 */
export async function forceExpiry(
  store: ItemStore,
  gate: Gate,
  onSnapshot: (before: RealRecord) => void = () => {},
  stopping: () => boolean = () => false
): Promise<{ before: RealRecord; forced: RealRecord }> {
  return gate(async (holdsLock) => {
    if (stopping()) throw new Error(RUN_ENDING);
    const before = await store.read();
    if (!before) throw new Error("the keychain item is absent: nothing to force");
    if (before.journal)
      throw new Error(
        "a refresh journal is open on the item (a refresh is in progress or was interrupted): not forcing expiry"
      );
    if (!holdsLock()) throw new Error("the refresh gate was lost before the write: not writing");
    if (stopping()) throw new Error(RUN_ENDING);
    onSnapshot(structuredClone(before));
    try {
      await store.write({ ...before, expiresAt: 0 });
      const forced = await store.read();
      if (!forced || forced.expiresAt !== 0 || !sameExceptExpiry(forced, before))
        throw new Error("the expiry write did not land as expected; stopped before the race");
      return { before, forced };
    } catch (err) {
      // The write may have committed (an ambiguous write, or a verification that failed
      // after it): re-read under this same hold and put back only the record this run forced.
      let undo: string;
      try {
        undo = await restoreUnderGate(store, holdsLock, before);
      } catch (undoErr) {
        undo = `restore FAILED: ${messageOf(undoErr)}`;
      }
      throw new Error(`${messageOf(err)} (in-place restore: ${undo})`);
    }
  });
}

export type RestoreOutcome =
  | "restored"
  | "absent"
  | "newer-generation"
  | "material-changed"
  | "not-forced"
  | "journal-open";

/**
 * The restore with the gate ALREADY held (`holdsLock` is that hold's fence). Puts
 * `before.expiresAt` back when the item is STILL exactly what this run forced: same
 * generation, same fingerprint, `expiresAt === 0`, no journal, every other field unchanged.
 * Anything else is left alone (a refresh happened, or is in progress) and named.
 */
export async function restoreUnderGate(
  store: ItemStore,
  holdsLock: () => boolean,
  before: RealRecord
): Promise<RestoreOutcome> {
  const cur = await store.read();
  if (!cur) return "absent";
  if (cur.generation !== before.generation) return "newer-generation";
  if (cur.fingerprint !== before.fingerprint) return "material-changed";
  if (cur.expiresAt !== 0) return "not-forced";
  if (cur.journal) return "journal-open";
  if (!sameExceptExpiry(cur, before)) return "material-changed";
  if (!holdsLock()) throw new Error("the refresh gate was lost before the restore: not writing");
  await store.write({ ...cur, expiresAt: before.expiresAt });
  return "restored";
}

/** {@link restoreUnderGate}, taking the gate itself. */
export async function restoreIfStillForced(
  store: ItemStore,
  gate: Gate,
  before: RealRecord
): Promise<RestoreOutcome> {
  return gate((holdsLock) => restoreUnderGate(store, holdsLock, before));
}

/** How long an interrupted run waits for the account's refresh gate before killing anyway. */
export const SHUTDOWN_GATE_BOUND_MS = 60_000;

export interface ShutdownDeps {
  /** Stop issuing requests to the serves (called first, before anything waits). */
  stopIssuing(): void;
  /** The account's refresh gate, acquired within `boundMs` or rejected. */
  gateWithin(boundMs: number): Gate;
  /** The same gate with the product's own acquire timeout: the restore after a forced kill. */
  gate: Gate;
  /** Kill every serve tree and wait for it to be gone. */
  killServes(): Promise<void>;
  /**
   * The end-of-run restore with the gate held; null when this run forced nothing. It is
   * called only once the gate is held, so it decides THEN whether anything was forced (review
   * round 8: a snapshot read before the wait missed an expiry written during it) and answers
   * null when nothing was.
   */
  restore: ((holdsLock: () => boolean) => Promise<RestoreOutcome | null>) | null;
  /** A line the operator must see (stderr). */
  warn(line: string): void;
}

export interface ShutdownResult {
  /** True when the serves were killed with the refresh gate held. */
  killedUnderGate: boolean;
  /** The restore outcome, `FAILED: ...`, or null when nothing was forced. */
  restore: RestoreOutcome | string | null;
}

/** Printed when the serves are killed without the gate. Never silent. */
export const killedWithoutGateWarning = (account: string, boundMs: number, why: string) =>
  `WARNING: the refresh gate of ${account} was not free within ${Math.round(boundMs / 1000)} s (${why}); ` +
  "the serves were killed WITHOUT it. A token refresh may have been interrupted after OpenAI " +
  `accepted it: the account may need a \`claudish\` login (if claudish reports that ${account} needs one, log in again).`;

/**
 * The end of a run, in the only order that cannot cut a rotation in half (review round 7,
 * GPT HIGH 2): stop issuing requests; take the account's refresh gate (bounded wait), so a
 * serve between the token exchange and the final persist finishes persisting and releases it
 * first; holding the gate (no serve can START a refresh), kill the serves, then restore;
 * release. The product holds this gate for the whole journal -> exchange -> persist
 * transaction (token-manager.ts `withGate` -> `refreshUnderGate` -> `exchangeAndPersist`).
 * Gate not free within the bound: kill anyway, warn, then restore under the gate (the
 * product's lock steals a dead same-host holder at once).
 */
export async function shutdownUnderGate(
  deps: ShutdownDeps,
  account: string,
  boundMs = SHUTDOWN_GATE_BOUND_MS
): Promise<ShutdownResult> {
  deps.stopIssuing();
  const runRestore = async (holdsLock: () => boolean) => {
    if (!deps.restore) return null;
    try {
      return await deps.restore(holdsLock);
    } catch (err) {
      return `FAILED: ${messageOf(err)}`;
    }
  };
  let entered = false;
  try {
    return await deps.gateWithin(boundMs)(async (holdsLock) => {
      entered = true;
      await deps.killServes();
      return { killedUnderGate: true, restore: await runRestore(holdsLock) };
    });
  } catch (err) {
    if (entered) throw err;
    deps.warn(killedWithoutGateWarning(account, boundMs, messageOf(err)));
    await deps.killServes();
    if (!deps.restore) return { killedUnderGate: false, restore: null };
    try {
      return { killedUnderGate: false, restore: await deps.gate(runRestore) };
    } catch (gateErr) {
      return { killedUnderGate: false, restore: `FAILED: ${messageOf(gateErr)}` };
    }
  }
}

export interface SignalTarget {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

/** Printed when a second signal arrives during the safe finish. */
export const FINISHING_SAFELY = "finishing safely, please wait";

/**
 * SIGINT and SIGTERM run `finish` once, then `exit(code)`. A second signal does NOT skip the
 * safe finish: it prints {@link FINISHING_SAFELY} and is otherwise ignored.
 */
export function installSafeSignals(
  target: SignalTarget,
  finish: (signal: string) => Promise<void>,
  exit: (code: number) => void,
  say: (line: string) => void
): void {
  let started = false;
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    target.on(signal, () => {
      if (started) {
        say(FINISHING_SAFELY);
        return;
      }
      started = true;
      void finish(signal).then(() => exit(code));
    });
  }
}

/**
 * The account's `needsReauth` mark in the real `accounts/state.json`:
 * `providers["openai-codex"].accounts[<id>].needsReauth` (state-store.ts `AccountsState`).
 * Only THIS account counts; a mark on another account is not this run's. Null when absent.
 */
export function needsReauthOf(state: unknown, accountId: string): unknown {
  const st = state as {
    providers?: Record<string, { accounts?: Record<string, { needsReauth?: unknown }> }>;
  } | null;
  return st?.providers?.["openai-codex"]?.accounts?.[accountId]?.needsReauth ?? null;
}

export interface RealVerdict {
  bothOk: boolean;
  /** Generation g -> g + 1: one persisted rotation. NOT a count of token exchanges. */
  generationAdvancedByOne: boolean;
  fingerprintChanged: boolean;
  expiryInFuture: boolean;
  allOnThisAccount: boolean;
  noReauth: boolean;
  /** Both replies within the 3 s memo window: the strict V2e form needs it. */
  memoWindowMet: boolean;
}

export const NOT_STRICT_EVIDENCE = "NOT EVIDENCE for the strict V2e form";

/**
 * Exit code and labels. Any false field fails the exit code. `observational` holds every
 * field except the memo window; `strict` needs the memo window too: without it the second
 * process's re-read may fall outside the memo, so the run says nothing about the memo bypass.
 */
export function classifyVerdict(
  v: RealVerdict,
  kind: RealStoreKind = "keychain"
): {
  exitCode: 0 | 1;
  observational: boolean;
  strict: boolean;
  lines: string[];
} {
  const { memoWindowMet, ...rest } = v;
  // The 3 s memo is the keychain read cache (`MEMO_TTL_MS`). A file-store run has no memo, so
  // the window neither fails it nor makes it V2e evidence.
  const judged = kind === "keychain" ? v : rest;
  const failed = Object.entries(judged)
    .filter(([, ok]) => !ok)
    .map(([k]) => k);
  const observational = Object.values(rest).every(Boolean);
  const strict = kind === "keychain" && observational && memoWindowMet;
  const lines = [
    `observational: ${observational ? "PASS" : "FAIL"}${failed.length ? ` (false: ${failed.join(", ")})` : ""}`,
    kind !== "keychain"
      ? `${FILE_STORE_RACE}: the 3 s memo window does not apply (no keychain memo)`
      : strict
        ? "strict V2e form: PASS (both replies inside the 3 s memo window)"
        : `strict V2e form: ${NOT_STRICT_EVIDENCE}${memoWindowMet ? "" : " (the replies took 3 s or more: the memo window was not met)"}`,
  ];
  return { exitCode: failed.length === 0 ? 0 : 1, observational, strict, lines };
}

/** `compareAndWriteStore`'s refusal: the item changed after this run read it. */
export const CHANGED_UNDER_US =
  "the credential changed after this run read it (a login or a refresh outside the gate?): not writing";

/**
 * A store whose every write first re-reads and refuses unless the item still has the SAME
 * generation and fingerprint as the record being written (review round 10, GPT HIGH 1).
 *
 * `codex-oauth.json` has a writer that does not take the refresh gate: a legacy browser login
 * (`CodexOAuth.login`, `codex-oauth.ts:478`, ungated by design; the product closes it on the
 * refresh side with a pre-persist re-read). Holding the gate therefore does not exclude it, and a
 * write of this run's captured record would put the old token back over the new login. This is
 * the product's own defence, applied to the force and the restore: the window shrinks to the gap
 * between this re-read and the write, the same gap the product's refresh accepts.
 */
export function compareAndWriteStore(inner: ItemStore): ItemStore {
  return {
    read: () => inner.read(),
    async write(record) {
      const cur = await inner.read();
      if (!cur || cur.generation !== record.generation || cur.fingerprint !== record.fingerprint)
        throw new Error(CHANGED_UNDER_US);
      await inner.write(record);
    },
  };
}

/** The label of a run on a file-stored account: the same race, never V2e evidence. */
export const FILE_STORE_RACE = "file-store race, NOT V2e (V2e is the keychain row)";

/** The stores this script can force and restore. */
export type RealStoreKind = "keychain" | "legacy-codex-file";

/**
 * Which store and which refresh gate a real account uses, from its record in the real config.
 * The lock path comes from the product's `accountRefreshLockPath`: the legacy file's gate is
 * `legacy-codex.lock`, NOT `<id>.lock`, so a path built from the id would hold a lock no serve
 * takes. Throws for an absent account or any other store.
 */
export function planAccount(
  account: { provider?: string; id: string; store?: string } | undefined,
  id: string,
  lockPathOf: (record: { provider: "openai-codex"; id: string; store: RealStoreKind }) => string
): { kind: RealStoreKind; lockPath: string } {
  if (!account) throw new Error(`${id} is not in the real config's openai-codex account list`);
  const store = account.store;
  if (store !== "keychain" && store !== "legacy-codex-file")
    throw new Error(`${id} uses store ${String(store)}: only keychain or legacy-codex-file`);
  return {
    kind: store,
    lockPath: lockPathOf({ provider: "openai-codex", id: account.id, store }),
  };
}
