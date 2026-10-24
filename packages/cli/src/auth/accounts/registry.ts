/**
 * The ACCOUNT LIST: which accounts are configured, read FAIL-CLOSED.
 *
 * This module answers one question — *"is a subscription pool configured for
 * this provider?"* — and that question decides **who pays**. It is the same fact
 * the availability predicate and the synchronous billing probe both read, through
 * this one accessor, so the two cannot drift.
 *
 * ## Why it does NOT call `loadConfig()`
 *
 * `loadConfig()` catches every read and parse failure and returns
 * `{...DEFAULT_CONFIG}` (`profile-config.ts`, the catch at the end of the
 * function). `subscriptionAccounts` is then `undefined`, `hasConfiguredAccounts()`
 * is false, the credential composite takes the api-key half — and a flat-rate
 * user signs a metered request because their config file was briefly unreadable.
 * `CodexOAuth.loadCredentials()` had the identical shape for the legacy file —
 * catch, return `null`, read by `hasCredentials()` as "no credentials" — until
 * the V16b fix: an unreadable file now answers "a login is configured" there and
 * fails visibly at sign time. This module still reads that file itself, because
 * it needs more than that singleton gives: its own three outcomes, a
 * last-known-good account list, a throw when there is none, and a re-stat on
 * every answer, where the singleton reads once and re-reads only on the request
 * path.
 *
 * So this module parses both documents ITSELF and keeps three outcomes apart:
 *
 * - **present** — parsed and VALID; the account list is what it says.
 * - **absent** — `stat` says `ENOENT`. A legitimately empty account list. Any
 *   other `stat` error (a permission-denied parent, for one) is `failed`:
 *   `existsSync` answers `false` for those too, which is how an unreadable
 *   directory used to read as "no accounts".
 * - **failed** — any read, parse or VALIDATION error. NEVER "no accounts".
 *
 * On `failed` the last known-good account list is served. When there has never been
 * one in this process, {@link AccountRegistry.hasConfiguredAccounts} **throws**
 * a typed source error: I/O (or invalid legacy bytes) is transient 503; invalid
 * config bytes are terminal 400. Neither is absence or permission to sign a key.
 * The shared auth verdict controls continuation, never a fabricated credential 401.
 *
 * ## Validation REJECTS, it never drops or accepts
 *
 * Every entry is checked against `SubscriptionAccountsSchema` (`config-schema.ts`,
 * the same schema the mutation path writes against) and then against the rules
 * the schema cannot express:
 *
 * - **the id** must match `ACCOUNT_ID_PATTERN`. It is interpolated into the lock
 *   and token PATHS; a hand-edited `"../../../tmp/x"` would otherwise put a
 *   refresh token outside `~/.claudish/accounts`. `paths.ts` refuses such an id
 *   too — this is the first of two lines of defence, not the only one.
 * - **ids are unique per provider**, because two rows with one id share one token
 *   file and one refresh gate.
 * - **at most one Codex row may use the legacy store**, and no Claude row may: the
 *   legacy store is ONE file, and two accounts on it are one refresh token with
 *   two gates — two concurrent exchanges and an `invalid_grant`.
 * - **`switchAtByWindow` keys are ones the usage layer can produce.** Codex's are
 *   the header-pair slot ids in `CODEX_WINDOW_SLOTS`; Anthropic's are discovered
 *   from lower-cased header names, so a key that could never be a lower-cased
 *   header token can never match. `{"7d": 0.8}` on Codex is REJECTED rather than
 *   accepted and silently never matched.
 *
 * A malformed entry fails the WHOLE read, naming the bad field. Dropping the bad
 * row would silently change who pays; accepting it would silently never apply.
 *
 * ## Reloading
 *
 * The account list is re-read when either document's mtime, size or inode
 * changes, checked before every answer. The stamp is recorded only once the
 * document's bytes were actually READ: a transient `EACCES`/`EMFILE` on the first
 * read of a `serve` process must be retried on the next answer, not cached as a
 * permanent `failed` until the file happens to change. A parse or validation
 * failure IS cached against the stamp, because it is a pure function of bytes
 * that cannot change without the stamp changing.
 */

import { readFileSync, statSync } from "node:fs";
import { log } from "../../logger.js";
import { activeConfigFile } from "../../profile-config.js";
import { accountsFaultArmed } from "../../test-upstream.js";
import type { StrategyName } from "./allowance/types.js";
import {
  isConfigObject as isRecord,
  parseAccountsBlock,
  withLenientStrategy,
} from "./config-validation.js";
import { legacyCodexCredentialsPath } from "./paths.js";
import {
  ACCOUNT_PROVIDERS,
  AccountListInvalidError,
  AccountListUnavailableError,
  type AccountProvider,
  type AccountRecord,
  type AccountSourceFailure,
  type AccountSourceFailureType,
  DEFAULT_SWITCH_AT,
  LEGACY_CODEX_ACCOUNT_ID,
  type SubscriptionAccountsConfig,
} from "./types.js";

/**
 * The id the synthesized legacy Codex account carries. Defined in `types.ts` so
 * `paths.ts` can accept it without importing this module; re-exported here
 * because callers already import it from the account list.
 */
export { LEGACY_CODEX_ACCOUNT_ID };
/** What `account list` shows for it. */
export const LEGACY_CODEX_LABEL = "default";

/** How a source read went. The three outcomes that must never collapse. */
export type SourceState = "present" | "absent" | "failed";

export interface SourceStatus {
  state: SourceState;
  /** Why it failed. Never contains credential material. */
  error?: string;
  failure?: AccountSourceFailure;
  /** The source cannot contribute to the current configured/suppressed pool. */
  ignored?: boolean;
  /** Whether a last-known-good value is being served instead. */
  servingLastKnownGood?: boolean;
  path: string;
}

export interface AccountListSnapshot {
  accounts: Record<AccountProvider, AccountRecord[]>;
  settings: SubscriptionAccountsConfig;
  config: SourceStatus;
  legacy: SourceStatus;
  /** The account-list generation as configured, per provider. */
  generation: Partial<Record<AccountProvider, number>>;
}

export interface AccountRegistryOptions {
  /** Where `config.json` is. Defaults to the ACTIVE config file (`--config` aware). */
  configPath?: () => string;
  /** Where the legacy Codex credential file is. */
  legacyCodexPath?: () => string;
  /** Injected clock, so a test never waits for an mtime to move. */
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /**
   * The file reader. A seam so a test can make ONE read fail transiently
   * (`EMFILE`, `EACCES`) and prove the next answer retries it.
   */
  readFile?: (path: string) => string;
}

/** A file's identity, for change detection. */
interface Stamp {
  mtimeMs: number;
  size: number;
  ino: number;
}

/** What `stat` said, with `ENOENT` the ONLY route to "absent". */
type Probe =
  | { kind: "absent" }
  | { kind: "present"; stamp: Stamp }
  | { kind: "failed"; error: string };

function probe(path: string): Probe {
  try {
    const st = statSync(path);
    return { kind: "present", stamp: { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino } };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // ENOTDIR: a path component is a regular file, so this document cannot exist.
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/** `null` stands for "absent". */
function sameStamp(a: Stamp | null, b: Stamp | null): boolean {
  if (a === null || b === null) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;
}

function emptyAccounts(): Record<AccountProvider, AccountRecord[]> {
  return { "native-anthropic": [], "openai-codex": [] };
}

/** Which of the two documents a refresh is about. */
type SourceName = "config" | "legacy";

/**
 * The in-memory account list, with last-known-good retention per source.
 *
 * One instance per process (see {@link getAccountRegistry}); a test builds its
 * own with explicit paths and never touches the real `~/.claudish`.
 */
export class AccountRegistry {
  private readonly configPath: () => string;
  private readonly legacyPath: () => string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly readFile: (path: string) => string;

  /** The stamp whose bytes were last READ. `undefined` = re-read on the next answer. */
  private configStamp: Stamp | null | undefined;
  private legacyStamp: Stamp | null | undefined;

  /** Last successfully parsed config account list. `undefined` = never had one. */
  private lastGoodSettings: SubscriptionAccountsConfig | undefined;
  private lastGoodLegacy: AccountRecord | null | undefined;

  private configStatus: SourceStatus;
  private legacyStatus: SourceStatus;

  /** The last failure LOGGED per source, so a retried failure logs once, not per answer. */
  private readonly loggedFailure: Record<SourceName, string | undefined> = {
    config: undefined,
    legacy: undefined,
  };

  constructor(opts: AccountRegistryOptions = {}) {
    this.env = opts.env ?? process.env;
    this.configPath = opts.configPath ?? (() => activeConfigFile());
    this.legacyPath = opts.legacyCodexPath ?? (() => legacyCodexCredentialsPath(this.env));
    this.readFile = opts.readFile ?? ((path) => readFileSync(path, "utf-8"));
    this.configStatus = { state: "absent", path: this.configPath() };
    this.legacyStatus = { state: "absent", path: this.legacyPath() };
  }

  /** Force the next answer to re-read both documents. */
  invalidate(): void {
    this.configStamp = undefined;
    this.legacyStamp = undefined;
  }

  /** An unknown `strategy` value reads as sticky; logged once per provider and value. */
  private readonly warnedStrategy = new Set<string>();
  private warnUnknownStrategy(provider: string, value: unknown): void {
    const shown = String(typeof value === "string" ? value : typeof value).slice(0, 32);
    const key = `${provider}\u0000${shown}`;
    if (this.warnedStrategy.has(key)) return;
    this.warnedStrategy.add(key);
    log(
      `[accounts] ${provider}: unknown strategy "${shown}" in subscriptionAccounts; selection stays sticky`
    );
  }

  private logFailure(source: SourceName, message: string): void {
    if (this.loggedFailure[source] === message) return;
    this.loggedFailure[source] = message;
    log(message);
  }

  /**
   * The shared read step for both documents.
   *
   * Returns the bytes, or `null` when the answer is already settled (unchanged
   * since the last read, absent, or failed) — in which case `onAbsent`/`onFailed`
   * have run. The stamp is recorded ONLY when the bytes were read.
   */
  private readSource(
    source: SourceName,
    path: string,
    handlers: {
      stamp: Stamp | null | undefined;
      setStamp: (stamp: Stamp | null | undefined) => void;
      onAbsent: () => void;
      onFailed: (detail: string, type: AccountSourceFailureType) => void;
    }
  ): { text: string; stamp: Stamp } | null {
    const p = probe(path);
    const current = p.kind === "present" ? p.stamp : null;
    if (p.kind !== "failed" && handlers.stamp !== undefined && sameStamp(current, handlers.stamp)) {
      return null;
    }

    if (p.kind === "absent") {
      // ABSENT — a legitimate empty account list, and the only clean way to be one.
      handlers.setStamp(null);
      this.loggedFailure[source] = undefined;
      handlers.onAbsent();
      return null;
    }
    if (p.kind === "failed") {
      // Not recorded: the next answer retries.
      handlers.setStamp(undefined);
      handlers.onFailed(p.error, "io");
      return null;
    }

    try {
      if (accountsFaultArmed("account-list-read-throws", this.env)) {
        throw new Error("CLAUDISH_ACCOUNTS_FAULT=account-list-read-throws");
      }
      return { text: this.readFile(path), stamp: p.stamp };
    } catch (err) {
      // An I/O failure is transient by nature (EACCES, EMFILE, EIO): leave the
      // stamp unrecorded so the NEXT answer retries instead of serving this
      // failure until the file happens to change.
      handlers.setStamp(undefined);
      handlers.onFailed(err instanceof Error ? err.message : String(err), "io");
      return null;
    }
  }

  // -- config.json ---------------------------------------------------------

  private refreshConfig(): void {
    const path = this.configPath();
    const failed = (detail: string, type: AccountSourceFailureType) => {
      // FAILED. Never "no accounts" — see the header.
      this.configStatus = {
        state: "failed",
        error: detail,
        failure: { source: "config", path, type, detail },
        path,
        servingLastKnownGood: this.lastGoodSettings !== undefined,
      };
      this.logFailure("config", `[accounts] account-list read FAILED for ${path}: ${detail}`);
    };
    const read = this.readSource("config", path, {
      stamp: this.configStamp,
      setStamp: (stamp) => {
        this.configStamp = stamp;
      },
      onAbsent: () => {
        this.lastGoodSettings = {};
        this.configStatus = { state: "absent", path };
      },
      onFailed: failed,
    });
    if (!read) return;

    // The bytes were read: a parse or validation outcome is a pure function of
    // them, so it is safe to cache against this stamp.
    this.configStamp = read.stamp;
    try {
      const raw = JSON.parse(read.text) as unknown;
      if (!isRecord(raw)) throw new Error("config is not an object");
      const settings =
        raw.subscriptionAccounts === undefined
          ? {}
          : parseAccountsBlock(
              withLenientStrategy(raw.subscriptionAccounts, (provider, value) =>
                this.warnUnknownStrategy(provider, value)
              )
            );
      this.lastGoodSettings = settings;
      this.configStatus = { state: "present", path };
      this.loggedFailure.config = undefined;
    } catch (err) {
      // JSON parser messages can quote source bytes, including credentials.
      failed(
        err instanceof SyntaxError
          ? "invalid JSON"
          : err instanceof Error
            ? err.message
            : "invalid document",
        "invalid"
      );
    }
  }

  // -- the legacy Codex file ----------------------------------------------

  private refreshLegacy(): void {
    const path = this.legacyPath();
    const failed = (detail: string, type: AccountSourceFailureType) => {
      this.legacyStatus = {
        state: "failed",
        error: detail,
        failure: { source: "legacy", path, type, detail },
        path,
        servingLastKnownGood: this.lastGoodLegacy !== undefined,
      };
      this.logFailure(
        "legacy",
        `[accounts] legacy Codex account-list read FAILED for ${path}: ${detail}`
      );
    };
    const read = this.readSource("legacy", path, {
      stamp: this.legacyStamp,
      setStamp: (stamp) => {
        this.legacyStamp = stamp;
      },
      onAbsent: () => {
        this.lastGoodLegacy = null;
        this.legacyStatus = { state: "absent", path };
      },
      onFailed: failed,
    });
    if (!read) return;

    this.legacyStamp = read.stamp;
    try {
      const parsed = JSON.parse(read.text) as unknown;
      if (!isRecord(parsed)) throw new Error("credential file is not an object");
      // A file with no refresh token cannot serve, but it EXISTS and was
      // readable: that is a present-and-empty account list, not a failure.
      const usable = typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0;
      this.lastGoodLegacy = usable
        ? {
            id: LEGACY_CODEX_ACCOUNT_ID,
            label: LEGACY_CODEX_LABEL,
            provider: "openai-codex",
            identity:
              typeof parsed.account_id === "string" ? { chatgptAccountId: parsed.account_id } : {},
            store: "legacy-codex-file",
            enabled: true,
            addedAt: new Date(read.stamp.mtimeMs).toISOString(),
            legacy: true,
          }
        : null;
      this.legacyStatus = { state: "present", path };
      this.loggedFailure.legacy = undefined;
    } catch (err) {
      // JSON parser messages can quote source bytes, including credentials.
      failed(
        err instanceof SyntaxError
          ? "invalid JSON"
          : err instanceof Error
            ? err.message
            : "invalid document",
        "invalid"
      );
    }
  }

  /** Suppressed/explicit pools never depend on an unrelated legacy file. */
  private refreshLegacySource(): boolean {
    const entry = this.lastGoodSettings?.["openai-codex"];
    if (entry?.legacyCodexSuppressed || (entry?.accounts.length ?? 0) > 0) {
      this.legacyStatus = { state: "absent", path: this.legacyPath(), ignored: true };
      this.legacyStamp = undefined;
      return false;
    }
    this.refreshLegacy();
    return true;
  }

  // -- the answers ---------------------------------------------------------

  /**
   * The whole account list, with each source's state attached.
   *
   * Throws `AccountListUnavailableError` when a source failed and has no
   * last-known-good — the caller cannot be handed an account list that pretends the
   * unreadable half is empty.
   *
   * `scope` narrows WHICH failure is fatal. The legacy Codex file is an input to
   * the Codex account list alone, so an unreadable one must not fail a Claude answer:
   * failing closed is right for the predicate that decides who pays for a Codex
   * request, and is just an unrelated outage for a Claude one. `config.json`
   * carries both account lists, so its failure is always fatal.
   */
  snapshot(scope?: AccountProvider): AccountListSnapshot {
    this.refreshConfig();
    this.refreshLegacySource();

    if (this.configStatus.state === "failed" && this.lastGoodSettings === undefined) {
      if (this.configStatus.failure?.type === "invalid") {
        throw new AccountListInvalidError(this.configStatus.failure);
      }
      throw new AccountListUnavailableError(
        this.configStatus.path,
        this.configStatus.error,
        503,
        this.configStatus.failure
      );
    }
    const legacyMatters = scope === undefined || scope === "openai-codex";
    if (
      legacyMatters &&
      this.legacyStatus.state === "failed" &&
      this.lastGoodLegacy === undefined
    ) {
      throw new AccountListUnavailableError(
        this.legacyStatus.path,
        this.legacyStatus.error,
        503,
        this.legacyStatus.failure
      );
    }

    const settings = this.lastGoodSettings ?? {};
    const accounts = emptyAccounts();
    const generation: Partial<Record<AccountProvider, number>> = {};

    for (const provider of ACCOUNT_PROVIDERS) {
      const entry = settings[provider];
      if (!entry) continue;
      generation[provider] = entry.generation;
      // A vendor-level `enabled: false` disables the whole pool; the rows are
      // still listed so `account status` can say WHY nothing is selectable.
      for (const a of entry.accounts) {
        accounts[provider].push({
          id: a.id,
          label: a.label,
          provider,
          identity: a.identity ?? {},
          store: a.store,
          enabled: entry.enabled !== false && a.enabled !== false,
          addedAt: a.addedAt,
          legacy: false,
        });
      }
    }

    // The legacy account is synthesized IN MEMORY, and only when no Codex
    // account is configured: once the user has a real pool, the legacy file is
    // migration debris rather than a second account with a name they never gave.
    const legacy = this.lastGoodLegacy ?? null;
    if (
      legacy &&
      !settings["openai-codex"]?.legacyCodexSuppressed &&
      accounts["openai-codex"].length === 0
    ) {
      accounts["openai-codex"].push(legacy);
    }

    return {
      accounts,
      settings,
      generation,
      config: this.configStatus,
      legacy: this.legacyStatus,
    };
  }

  /**
   * **The presence fact.** Configuration only — no Keychain call, no token file
   * opened, no `await`.
   *
   * Exhaustion, `needsReauth` and an unreadable token store are all READINESS
   * facts and none of them may lower this: it answers a CONFIGURATION question.
   */
  hasConfiguredAccounts(provider: AccountProvider): boolean {
    return this.snapshot(provider).accounts[provider].length > 0;
  }

  /** Safety/unsigned billing projection: unknown presence reserves OAuth. */
  mayHaveConfiguredAccounts(provider: AccountProvider): boolean {
    try {
      return this.hasConfiguredAccounts(provider);
    } catch {
      return true;
    }
  }

  /** Confirmed migration-only case; never permits a legacy read on unknown input. */
  isSynthesizedLegacyOnly(): boolean {
    const snapshot = this.snapshot("openai-codex");
    const rows = snapshot.accounts["openai-codex"];
    const entry = snapshot.settings["openai-codex"];
    return (
      !entry?.legacyCodexSuppressed &&
      !entry?.accounts.length &&
      rows.length === 1 &&
      rows[0].legacy
    );
  }

  /** Every configured account for one provider, in config order. */
  listAccounts(provider: AccountProvider): AccountRecord[] {
    return this.snapshot(provider).accounts[provider];
  }

  /** Pool settings for one provider, with the design's defaults applied. */
  settingsFor(provider: AccountProvider): {
    switchAt: number;
    switchAtByWindow: Record<string, number>;
    enabled: boolean;
    noticeAcceptedAt?: string;
    generation: number;
    strategy: StrategyName;
  } {
    const entry = this.snapshot(provider).settings[provider];
    return {
      switchAt: entry?.switchAt ?? DEFAULT_SWITCH_AT,
      switchAtByWindow: entry?.switchAtByWindow ?? {},
      enabled: entry?.enabled !== false,
      generation: entry?.generation ?? 0,
      strategy: entry?.strategy ?? "sticky",
      ...(entry?.noticeAcceptedAt ? { noticeAcceptedAt: entry.noticeAcceptedAt } : {}),
    };
  }

  /** Source states, for `account status` — it must be able to SAY "failed". */
  sources(): { config: SourceStatus; legacy: SourceStatus } {
    this.refreshConfig();
    this.refreshLegacySource();
    return { config: this.configStatus, legacy: this.legacyStatus };
  }
}

// ---------------------------------------------------------------------------
// Process singleton + the test seam
// ---------------------------------------------------------------------------

let registry: AccountRegistry | null = null;

/** The process-wide account list. Cheap: it re-reads only when a file changed. */
export function getAccountRegistry(): AccountRegistry {
  if (!registry) registry = new AccountRegistry();
  return registry;
}

/**
 * Replace (or with `null`, restore) the process registry.
 *
 * The seam exists so a test can point the account list at a temp HOME without an env
 * variable and without `mock.module()`, whose registry is process-global in Bun
 * and has broken sibling e2e files in this repo before.
 */
export function setAccountRegistryForTests(next: AccountRegistry | null): void {
  registry = next;
}
