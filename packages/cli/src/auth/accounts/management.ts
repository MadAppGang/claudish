/**
 * Explicit Codex account mutations: `claudish account add|login|enable|disable|remove codex`.
 *
 * Every mutation is a short raw `config.json` transaction under the shared
 * config lock (`config-lock.ts`), never `loadConfig` + `saveConfig`. No lock is
 * held across a human (a confirmation, a label prompt) or across PKCE: the
 * browser can take minutes, and a refresh waiting on a gate that long fails.
 *
 * Lock order is account gate → config lock → `state.lock`, the order
 * `ai-docs/architecture/accounts.md` fixes for the pool. Token material is
 * persisted and read back BEFORE a row naming it is published; a row is
 * published or removed in ONE atomic config write, together with the legacy
 * suppression marker when the legacy file is what goes away.
 *
 * Reads never enroll. The legacy login (`codex-oauth.json`, synthesized as
 * `default`) becomes a configured row only through an explicit add, enable or
 * disable, which says so before it happens; its refresh gate stays
 * `legacy-codex` (`accountRefreshLockPath`), shared with the `CodexOAuth` facade.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { confirm, input } from "@inquirer/prompts";
import { activeConfigFile } from "../../profile-config.js";
import { type CodexPkceResult, loginCodexPkce } from "../codex-pkce.js";
import { mutateAccountsConfig, withRawConfigTransaction } from "./config-lock.js";
import { FileLockUnavailableError } from "./file-lock.js";
import { accountRefreshLockPath, legacyCodexCredentialsPath } from "./paths.js";
import { type AcquireGateOptions, withRefreshGate } from "./refresh-lock.js";
import { AccountRegistry, getAccountRegistry } from "./registry.js";
import { type StateStore, getStateStore } from "./state-store.js";
import {
  type StoredTokenRecord,
  type TokenStore,
  TokenStoreAmbiguousWriteError,
  defaultAccountStore,
  fingerprintOf,
  storeFor,
} from "./token-store.js";
import {
  ACCOUNT_ID_PATTERN,
  ACCOUNT_LABEL_PATTERN,
  type AccountIdentity,
  type AccountRecord,
  type AccountRef,
  type AccountStoreKind,
  RefreshUnavailableError,
  type SubscriptionAccountsEntry,
} from "./types.js";

const PROVIDER = "openai-codex";
type ConfigRow = SubscriptionAccountsEntry["accounts"][number];

export type CodexManagementCommand =
  | { verb: "add"; label?: string }
  | { verb: "login" | "enable" | "disable"; label?: string; id?: string }
  | { verb: "remove"; label?: string; id?: string; yes?: boolean; deleteFile?: boolean };

export const OWNED_ACCOUNTS_NOTICE =
  "Add only Codex accounts you own and pay for. Switching between subscriptions may be " +
  "restricted by OpenAI's terms; this tool is not permission to bypass them. Accept and continue?";

const LEGACY_LOGIN_REFUSED =
  "Codex accounts are managed by `claudish account`, or the legacy login was removed. " +
  "Run `claudish account add codex` for a new account, or " +
  "`claudish account login codex <label>` to log an existing one in again.";

/** How long a finished legacy browser login waits for a busy config lock. */
const LEGACY_SAVE_WAIT_MS = 15_000;

export interface AccountManagementDeps {
  configPath?: () => string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  newId?: () => string;
  pkce?: () => Promise<CodexPkceResult>;
  confirm?: (message: string) => Promise<boolean>;
  label?: () => Promise<string>;
  print?: (message: string) => void;
  store?: (kind: AccountStoreKind) => TokenStore;
  newStore?: () => TokenStore;
  state?: StateStore;
  gateOptions?: Pick<AcquireGateOptions, "deps">;
  invalidate?: () => Promise<void> | void;
  legacyLogin?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// The legacy `claudish login codex`
// ---------------------------------------------------------------------------

function codexEntry(raw: Record<string, unknown>): SubscriptionAccountsEntry | undefined {
  const block = raw.subscriptionAccounts as
    | { "openai-codex"?: SubscriptionAccountsEntry }
    | undefined;
  return block?.[PROVIDER];
}

function refuseManagedLegacyLogin(raw: Record<string, unknown>): void {
  const entry = codexEntry(raw);
  if (entry?.legacyCodexSuppressed || entry?.accounts.length) throw new Error(LEGACY_LOGIN_REFUSED);
}

/**
 * Before the browser: `claudish login codex` is the legacy login only while no
 * Codex row is configured and the legacy file was never removed. Otherwise its
 * write would overwrite an enrolled row's material, or land in a file the
 * registry durably ignores. A legacy-only user passes with nothing written.
 */
export function assertLegacyCodexLoginPermitted(configPath = activeConfigFile()): void {
  withRawConfigTransaction(configPath, (raw) => {
    refuseManagedLegacyLogin(raw);
    return { config: raw, result: undefined };
  });
}

/**
 * `claudish logout codex` deletes the legacy credential file. While Codex rows
 * are configured that file may be an enrolled row's material, and removing a
 * row has its own contract (gate, suppression marker, `--delete-file`), so the
 * logout is refused and names the account verb. A legacy-only user passes.
 */
export function assertLegacyCodexLogoutPermitted(configPath = activeConfigFile()): void {
  withRawConfigTransaction(configPath, (raw) => {
    const rows = codexEntry(raw)?.accounts ?? [];
    if (rows.length > 0) {
      const legacy = rows.find((row) => row.store === "legacy-codex-file");
      throw new Error(
        legacy
          ? `The legacy Codex login is account ${legacy.label}. Remove it with ` +
              `\`claudish account remove codex ${legacy.label} --delete-file\`.`
          : "Codex accounts are managed by `claudish account`; remove one with " +
              "`claudish account remove codex <label>`."
      );
    }
    return { config: raw, result: undefined };
  });
}

/**
 * After the browser: re-check and run the legacy merge write under the config
 * lock, so an `account add` enrolling the file or a remove suppressing it is
 * ordered against this write. A busy lock is waited out (bounded): a completed
 * browser login is not discarded because a TUI save held the lock for a moment.
 */
export async function saveLegacyCodexLogin(
  write: () => void,
  opts: { configPath?: string; waitMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<void> {
  const configPath = opts.configPath ?? activeConfigFile();
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.waitMs ?? LEGACY_SAVE_WAIT_MS);
  for (;;) {
    try {
      withRawConfigTransaction(configPath, (raw) => {
        refuseManagedLegacyLogin(raw);
        write();
        return { config: raw, result: undefined };
      });
      return;
    } catch (err) {
      const busy = err instanceof FileLockUnavailableError && err.reason === "timeout";
      if (!busy || Date.now() >= deadline) throw err;
      await sleep(100);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function display(identity: AccountIdentity): string {
  const raw = identity.email || identity.chatgptAccountId || "identity unavailable";
  // Vendor claims reach a terminal: drop C0 control bytes and DEL.
  const shown = [...raw].filter((ch) => ch.charCodeAt(0) > 0x1f && ch !== "\x7f").join("");
  return identity.plan ? `${shown}, ${identity.plan}` : shown;
}

function stableIdentity(identity: AccountIdentity): string {
  const stable = identity.chatgptAccountId?.trim();
  if (!stable) {
    throw new Error("Codex login returned no stable chatgpt_account_id; no account was saved.");
  }
  return stable;
}

function validLabel(label: string): void {
  if (!ACCOUNT_LABEL_PATTERN.test(label)) {
    throw new Error(
      "An account label starts with a letter, digit or underscore and has at most 32 letters, " +
        "digits, spaces, dots, underscores or hyphens."
    );
  }
}

function asRecord(row: ConfigRow): AccountRecord {
  return {
    ...row,
    provider: PROVIDER,
    identity: row.identity ?? {},
    enabled: row.enabled !== false,
    legacy: false,
  };
}

/** The row resolved before a lock is still the same account under it. */
function sameTarget(current: AccountRecord, expected: AccountRecord): void {
  if (
    current.id !== expected.id ||
    current.store !== expected.store ||
    current.identity.chatgptAccountId !== expected.identity.chatgptAccountId
  ) {
    throw new Error("The Codex account changed while the command was pending; retry it.");
  }
}

export class CodexAccountManagement {
  private readonly env: NodeJS.ProcessEnv;
  private readonly configPath: () => string;
  private readonly now: () => number;
  private readonly ask: (message: string) => Promise<boolean>;
  private readonly print: (message: string) => void;

  constructor(private readonly deps: AccountManagementDeps = {}) {
    this.env = deps.env ?? process.env;
    this.configPath = deps.configPath ?? activeConfigFile;
    this.now = deps.now ?? Date.now;
    this.ask = deps.confirm ?? ((message) => confirm({ message, default: false }));
    this.print = deps.print ?? console.log;
  }

  /**
   * The synthesized `default`, judged from the raw entry already read under the
   * config lock: none once a row exists or after suppression. A legacy file
   * that cannot be read throws — an enrollment must not guess its identity.
   */
  private synthesizedLegacy(entry: SubscriptionAccountsEntry): AccountRecord | undefined {
    if (entry.legacyCodexSuppressed || entry.accounts.length > 0) return undefined;
    const config = this.configPath();
    const registry = new AccountRegistry({
      configPath: () => config,
      legacyCodexPath: () => legacyCodexCredentialsPath(this.env),
      env: this.env,
      // The raw entry above already decided rows and suppression; read the legacy file only.
      readFile: (path) => (path === config ? "{}" : readFileSync(path, "utf-8")),
    });
    return registry.snapshot(PROVIDER).accounts[PROVIDER].find((row) => row.legacy);
  }

  private inspect<T>(read: (entry: SubscriptionAccountsEntry) => T): T {
    return withRawConfigTransaction(this.configPath(), (raw) => ({
      config: raw,
      result: read(codexEntry(raw) ?? { generation: 0, accounts: [] }),
    }));
  }

  /** Label, `--id`, or both naming the SAME row; never a row position. */
  private resolve(
    entry: SubscriptionAccountsEntry,
    target: { label?: string; id?: string }
  ): AccountRecord {
    const rows = entry.accounts.map(asRecord);
    const legacy = this.synthesizedLegacy(entry);
    if (legacy) rows.push(legacy);
    const matches = rows.filter(
      (row) =>
        (target.id === undefined || row.id === target.id) &&
        (target.label === undefined || row.label === target.label)
    );
    if (matches.length === 1) return matches[0];
    throw new Error(
      matches.length > 1
        ? "Ambiguous Codex account; name it with --id <generated-id>."
        : "No such Codex account; run `claudish account list`."
    );
  }

  private newId(entry: SubscriptionAccountsEntry, reserved?: string): string {
    for (let attempt = 0; attempt < 16; attempt++) {
      const id = this.deps.newId?.() ?? randomBytes(6).toString("hex");
      if (!ACCOUNT_ID_PATTERN.test(id))
        throw new Error("The account id generator returned an invalid id.");
      if (id !== reserved && !entry.accounts.some((row) => row.id === id)) return id;
    }
    throw new Error("Could not generate an unused account id.");
  }

  /** Duplicate key: `chatgptAccountId` across every row (disabled too) and the unsuppressed legacy login. */
  private refuseDuplicate(
    entry: SubscriptionAccountsEntry,
    identity: AccountIdentity,
    label: string,
    except?: string
  ): void {
    const stable = stableIdentity(identity);
    const rows = entry.accounts.map(asRecord);
    const legacy = this.synthesizedLegacy(entry);
    if (legacy) rows.push(legacy);
    for (const row of rows) {
      if (row.id === except) continue;
      if (row.label === label) throw new Error(`A Codex account labelled ${label} already exists.`);
      if (row.identity.chatgptAccountId === stable) {
        throw new Error(`This Codex identity is already registered as ${row.label}.`);
      }
    }
  }

  private store(kind: AccountStoreKind): TokenStore {
    return this.deps.store?.(kind) ?? storeFor(kind, this.env);
  }

  private async gate<T>(
    row: AccountRecord,
    work: (holds: () => boolean) => Promise<T>
  ): Promise<T> {
    return withRefreshGate(PROVIDER, row.id, (handle) => work(() => handle.holdsLock()), {
      ...this.deps.gateOptions,
      path: accountRefreshLockPath(row, this.env),
    });
  }

  private fence(holds: () => boolean): void {
    if (!holds())
      throw new RefreshUnavailableError("account gate ownership lost before management persist");
  }

  private async invalidate(): Promise<void> {
    getAccountRegistry().invalidate();
    if (this.deps.invalidate) await this.deps.invalidate();
    else {
      // Also clears this process's signed-arm record for the provider.
      const { credentials } = await import("../credentials/authority.js");
      credentials.invalidate(PROVIDER);
    }
  }

  /** Write, then PROVE the write by its id; an ambiguous write is read back, never retried. */
  private async persist(
    store: TokenStore,
    ref: AccountRef,
    record: StoredTokenRecord
  ): Promise<void> {
    try {
      await store.write(ref, record);
    } catch (error) {
      if (!(error instanceof TokenStoreAmbiguousWriteError)) throw error;
    }
    const proven = await store.read(ref, { uncached: true });
    if (
      !proven ||
      proven.writeId !== record.writeId ||
      proven.generation !== record.generation ||
      proven.fingerprint !== record.fingerprint
    ) {
      throw new Error(
        "The Codex login could not be read back from its store; no account metadata was published."
      );
    }
  }

  private tokens(result: CodexPkceResult, previous?: StoredTokenRecord | null): StoredTokenRecord {
    const credentials = result.credentials;
    if (
      !credentials.access_token ||
      !credentials.refresh_token ||
      !Number.isFinite(credentials.expires_at)
    ) {
      throw new Error("The Codex login returned invalid token material; no account was saved.");
    }
    return {
      accessToken: credentials.access_token,
      refreshToken: credentials.refresh_token,
      expiresAt: credentials.expires_at,
      accountId: stableIdentity(result.identity),
      // A newer generation is what the guarded needsReauth self-heal keys on.
      generation: (previous?.generation ?? 0) + 1,
      fingerprint: fingerprintOf(credentials.refresh_token),
      journal: null,
      updatedAt: this.now(),
      writeId: randomBytes(16).toString("hex"),
    };
  }

  async run(command: CodexManagementCommand): Promise<string[]> {
    if (command.label !== undefined) validLabel(command.label);
    if (command.verb === "add") return this.add(command.label);
    if (command.id !== undefined && !ACCOUNT_ID_PATTERN.test(command.id)) {
      throw new Error(
        "--id takes a generated account id, as `claudish account list --json` shows."
      );
    }
    if (command.label === undefined && command.id === undefined) {
      throw new Error("Name the Codex account by label, or with --id <generated-id>.");
    }
    const target = this.inspect((entry) => this.resolve(entry, command));
    if (command.verb === "login") return this.login(target);
    if (command.verb === "remove") return this.remove(target, command);
    return this.setEnabled(target, command.verb === "enable");
  }

  // -- add -----------------------------------------------------------------

  private async add(requestedLabel?: string): Promise<string[]> {
    const label =
      requestedLabel ??
      (await (this.deps.label ?? (() => input({ message: "Codex account label:" })))());
    validLabel(label);
    const initial = this.inspect((entry) => {
      const legacy = this.synthesizedLegacy(entry);
      if (entry.accounts.some((row) => row.label === label) || legacy?.label === label) {
        throw new Error(`A Codex account labelled ${label} already exists.`);
      }
      if (legacy && !legacy.identity.chatgptAccountId) {
        throw new Error(
          "The legacy Codex login records no account id, so enrolling it cannot be checked for " +
            "duplicates. Run `claudish login codex` once to refresh it, then retry."
        );
      }
      return { notice: entry.noticeAcceptedAt, legacy, id: this.newId(entry) };
    });
    if (!initial.notice && !(await this.ask(OWNED_ACCOUNTS_NOTICE))) {
      return ["Cancelled; no account was added."];
    }
    const acceptedAt = new Date(this.now()).toISOString();
    if (initial.legacy) {
      this.print(
        `This add also enrolls your working legacy login as ${initial.legacy.label} ` +
          `(${display(initial.legacy.identity)}), store legacy-codex-file. Its credential file ` +
          "stays where it is and is not copied."
      );
    }
    const store = this.deps.newStore?.() ?? defaultAccountStore(this.env);
    this.print(
      `New Codex account ${label}; store: ${store.kind}.` +
        (store.kind === "file"
          ? " Warning: its tokens are kept in plaintext files readable only by you (0600)."
          : "")
    );

    const result = await (this.deps.pkce ?? loginCodexPkce)();
    stableIdentity(result.identity);
    const row: ConfigRow = {
      id: initial.id,
      label,
      identity: result.identity,
      store: store.kind,
      enabled: true,
      addedAt: new Date(this.now()).toISOString(),
    };
    const record = asRecord(row);

    await this.gate(record, async (holds) => {
      // Rechecked after the browser: a concurrent add may have taken the label or identity.
      this.inspect((entry) => {
        if (entry.accounts.some((a) => a.id === row.id))
          throw new Error("The generated account id is taken; retry the add.");
        this.refuseDuplicate(entry, result.identity, label);
      });
      if (await store.read(record, { uncached: true })) {
        throw new Error("A token item already exists for the generated account id; retry the add.");
      }
      try {
        this.fence(holds);
        await this.persist(store, record, this.tokens(result));
        this.fence(holds);
        mutateAccountsConfig(this.configPath(), PROVIDER, (entry) => {
          this.fence(holds);
          if (entry.accounts.some((a) => a.id === row.id))
            throw new Error("The generated account id is taken; retry the add.");
          this.refuseDuplicate(entry, result.identity, label);
          const legacy = this.synthesizedLegacy(entry);
          if (legacy) {
            if (legacy.identity.chatgptAccountId !== initial.legacy?.identity.chatgptAccountId) {
              throw new Error(
                "The legacy Codex login changed during the add; retry to confirm its enrollment."
              );
            }
            entry.accounts.push({
              id: this.newId(entry, row.id),
              label: legacy.label,
              identity: legacy.identity,
              store: "legacy-codex-file",
              enabled: true,
              addedAt: legacy.addedAt,
            });
          }
          entry.accounts.push(row);
          entry.noticeAcceptedAt ??= acceptedAt;
        });
      } catch (error) {
        await this.cleanupUnpublished(store, record, error);
      }
    });
    await this.invalidate();
    return [`Added Codex account ${label} (${display(result.identity)}); store: ${store.kind}.`];
  }

  /**
   * Delete only the NEW token item, and only when the row is confirmed
   * unpublished. Never restores an old config document.
   */
  private async cleanupUnpublished(
    store: TokenStore,
    record: AccountRecord,
    error: unknown
  ): Promise<never> {
    let published: boolean | undefined;
    try {
      published = this.inspect((entry) => entry.accounts.some((a) => a.id === record.id));
    } catch {
      published = undefined;
    }
    if (published === false) {
      try {
        await store.delete(record);
      } catch {
        throw new Error(
          `The add was not published, and cleanup of its new token item (${store.kind}, id ` +
            `${record.id}) failed. Existing accounts were not changed. Cause: ${errorText(error)}`
        );
      }
      throw error;
    }
    throw new Error(
      `The add's outcome is unresolved: its token item (${store.kind}, id ${record.id}) was kept ` +
        "because the account list could not confirm the row is absent. Run `claudish account list`. " +
        `Cause: ${errorText(error)}`
    );
  }

  // -- login ---------------------------------------------------------------

  private async login(target: AccountRecord): Promise<string[]> {
    if (target.legacy) {
      // The unsuppressed synthesized default, with no configured pool: the legacy login, unchanged.
      if (this.deps.legacyLogin) await this.deps.legacyLogin();
      else await (await import("../codex-oauth.js")).CodexOAuth.getInstance().login();
      await this.invalidate();
      return [`Codex account ${target.label}: login saved.`];
    }
    this.print(`Logging in Codex account ${target.label}; store: ${target.store}.`);
    const result = await (this.deps.pkce ?? loginCodexPkce)();
    const stable = stableIdentity(result.identity);
    // A row with no recorded identity (an enrolled legacy login that never had
    // one) has nothing to contradict; the duplicate check below still applies.
    if (target.identity.chatgptAccountId && stable !== target.identity.chatgptAccountId) {
      throw new Error(
        `This login is a different Codex identity than ${target.label}; ` +
          "use `claudish account add codex` for a different account."
      );
    }
    await this.gate(target, async (holds) => {
      const validate = (entry: SubscriptionAccountsEntry) => {
        sameTarget(this.resolve(entry, { id: target.id }), target);
        this.refuseDuplicate(entry, result.identity, target.label, target.id);
      };
      this.inspect(validate);
      const store = this.store(target.store);
      const previous = await store.read(target, { uncached: true });
      // Rechecked after the uncached read: a hand edit of config.json takes no gate.
      this.inspect(validate);
      this.fence(holds);
      await this.persist(store, target, this.tokens(result, previous));
      this.fence(holds);
      // Label, id, order, enabled and store stay; only the display identity may move.
      mutateAccountsConfig(this.configPath(), PROVIDER, (entry) => {
        validate(entry);
        const row = entry.accounts.find((a) => a.id === target.id);
        if (row) row.identity = result.identity;
      });
    });
    await this.invalidate();
    return [
      `Codex account ${target.label} (${display(result.identity)}): login saved; store: ` +
        `${target.store}. A recorded needs-login mark clears on the account's next use.`,
    ];
  }

  // -- enable / disable ----------------------------------------------------

  private async setEnabled(target: AccountRecord, enabled: boolean): Promise<string[]> {
    if (target.legacy) {
      this.print(
        `This enrolls your legacy login ${target.label} (${display(target.identity)}) as a ` +
          "configured account, store legacy-codex-file; its credential file stays where it is."
      );
    }
    let changed = false;
    let poolDisabled = false;
    await this.gate(target, async (holds) => {
      changed = mutateAccountsConfig(this.configPath(), PROVIDER, (entry) => {
        this.fence(holds);
        const current = this.resolve(
          entry,
          target.legacy ? { label: target.label } : { id: target.id }
        );
        sameTarget(current, target);
        poolDisabled = entry.enabled === false;
        if (current.legacy) {
          entry.accounts.push({
            id: this.newId(entry),
            label: current.label,
            identity: current.identity,
            store: "legacy-codex-file",
            enabled,
            addedAt: current.addedAt,
          });
          return;
        }
        const row = entry.accounts.find((a) => a.id === target.id);
        // Idempotent: an unchanged entry is not written and its generation does not move.
        if (row && (row.enabled !== false) !== enabled) row.enabled = enabled;
      });
    });
    if (changed) await this.invalidate();
    const lines = [
      `Codex account ${target.label} ${changed ? "" : "is already "}${enabled ? "enabled" : "disabled"}.`,
    ];
    if (!enabled) {
      lines.push(
        "Configured Codex accounts still reserve the subscription: with no enabled account, " +
          "Codex requests fail visibly instead of using OPENAI_CODEX_API_KEY."
      );
    }
    if (enabled && poolDisabled) {
      lines.push(
        "The Codex pool itself is disabled in config.json (`enabled: false`); no account is selected."
      );
    }
    return lines;
  }

  // -- remove --------------------------------------------------------------

  private async remove(
    target: AccountRecord,
    command: Extract<CodexManagementCommand, { verb: "remove" }>
  ): Promise<string[]> {
    const legacyFile = target.store === "legacy-codex-file";
    if (legacyFile && !command.deleteFile) {
      throw new Error(
        `${target.label} is the legacy Codex login; removing it deletes its credential file, ` +
          "which needs an explicit --delete-file. A label alone never authorizes that."
      );
    }
    if (!legacyFile && command.deleteFile) {
      throw new Error(`--delete-file applies only to the legacy Codex login, not ${target.label}.`);
    }
    if (
      !command.yes &&
      !(await this.ask(
        `Remove Codex account ${target.label} (${display(target.identity)})` +
          `${legacyFile ? " and delete its legacy credential file" : ""}? ` +
          "Requests already in flight cannot be recalled."
      ))
    ) {
      return ["Cancelled; no account was removed."];
    }

    const warnings: string[] = [];
    await this.gate(target, async (holds) => {
      // ONE atomic write: the row goes and, for the legacy file, the suppression
      // marker lands with it — before any token is deleted. A reader sees the old
      // generation or this one; there is no empty, unsuppressed document between.
      mutateAccountsConfig(this.configPath(), PROVIDER, (entry) => {
        this.fence(holds);
        const current = this.resolve(
          entry,
          target.legacy ? { label: target.label } : { id: target.id }
        );
        sameTarget(current, target);
        entry.accounts = entry.accounts.filter((row) => row.id !== target.id);
        // The empty provider entry is kept: it carries the marker.
        if (legacyFile) entry.legacyCodexSuppressed = true;
      });
      await this.invalidate();
      const state = this.deps.state ?? getStateStore();
      try {
        // Compare-and-set against the removed id: `active` is cleared when it
        // named this account, and left alone when it names another.
        if (!(await state.setActive(PROVIDER, target.id, target.id))) {
          warnings.push(
            "Clearing the active-account pointer is pending; state.json was not written."
          );
        }
      } catch {
        warnings.push(
          "Clearing the active-account pointer is pending; state.json was not written."
        );
      }
      try {
        this.fence(holds);
        await this.store(target.store).delete(target);
      } catch {
        warnings.push(
          `The removal is committed, but deleting ${target.label}'s token item (${target.store}) ` +
            `failed; the account was not restored${legacyFile ? " and the legacy login stays suppressed" : ""}.`
        );
      }
    });

    const next = this.inspect((entry): "pool" | "pool-disabled" | "legacy" | "key" => {
      if (entry.accounts.length > 0) {
        return entry.enabled === false || entry.accounts.every((row) => row.enabled === false)
          ? "pool-disabled"
          : "pool";
      }
      return this.synthesizedLegacy(entry) ? "legacy" : "key";
    });
    const nextText = {
      pool: "the remaining Codex accounts",
      "pool-disabled":
        "none: Codex accounts remain configured but all are disabled, so requests fail visibly",
      legacy: "the legacy Codex login",
      key: "OPENAI_CODEX_API_KEY if one is configured, otherwise none",
    }[next];
    return [
      `Removed Codex account ${target.label} (${display(target.identity)}). ` +
        `Next Codex credential for new requests: ${nextText}.`,
      ...(next === "key"
        ? ["Warning: new Codex requests may now use OPENAI_CODEX_API_KEY, billed per token."]
        : []),
      ...warnings,
    ];
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
