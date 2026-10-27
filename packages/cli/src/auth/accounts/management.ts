/**
 * Explicit Codex account mutations: `claudish account add|login|enable|disable|remove|rename codex`.
 *
 * Every mutation is a short raw `config.json` transaction under the shared
 * config lock (`config-lock.ts`), never `loadConfig` + `saveConfig`. No lock is
 * held across a human (a confirmation) or across PKCE: the
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
import { confirm } from "@inquirer/prompts";
import { activeConfigFile } from "../../profile-config.js";
import { type CodexPkceResult, loginCodexPkce } from "../codex-pkce.js";
import {
  ACCOUNT_LABEL_RULE,
  deriveAccountLabel,
  emailMatches,
  labelTaken,
  shellWord,
} from "./account-label.js";
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

/** `selector` is a label or the account's email; `add --label` is the only `label`. */
export type CodexManagementCommand =
  | { verb: "add"; label?: string }
  | { verb: "login" | "enable" | "disable"; selector?: string; id?: string }
  | { verb: "remove"; selector?: string; id?: string; yes?: boolean; deleteFile?: boolean }
  | { verb: "rename"; selector?: string; id?: string; newLabel: string };

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
              `\`claudish account remove codex ${shellWord(legacy.label)} --delete-file\`.`
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

function display(identity: AccountIdentity, label: string): string {
  const raw = identity.email || identity.chatgptAccountId || "identity unavailable";
  // Vendor claims reach a terminal: drop C0 control bytes, DEL and C1 (0x7f-0x9f).
  const shown = [...raw]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code > 0x1f && !(code >= 0x7f && code <= 0x9f);
    })
    .join("");
  // A label that is the email already says it; only the plan is news.
  const text = identity.email && label.toLowerCase() === identity.email.toLowerCase() ? "" : shown;
  if (!identity.plan) return text;
  return text ? `${text}, ${identity.plan}` : identity.plan;
}

/** ` (identity)` after a label, or nothing when there is nothing to add. */
function note(identity: AccountIdentity, label: string): string {
  const text = display(identity, label);
  return text ? ` (${text})` : "";
}

/** The label with the id a `--id` can take, so a selector by email shows what it resolved to. */
function named(row: AccountRecord): string {
  return row.legacy ? `${row.label} (legacy login)` : `${row.label} (id ${row.id})`;
}

function stableIdentity(identity: AccountIdentity): string {
  const stable = identity.chatgptAccountId?.trim();
  if (!stable) {
    throw new Error("Codex login returned no stable chatgpt_account_id; no account was saved.");
  }
  return stable;
}

function validLabel(label: string): void {
  if (!ACCOUNT_LABEL_PATTERN.test(label)) throw new Error(ACCOUNT_LABEL_RULE);
}

/**
 * A selector is a label or an email, which may lie outside the label pattern
 * (`o'brien@x.com`). Only length and control characters are refused.
 */
function validSelector(selector: string): void {
  const control = [...selector].some((ch) => {
    const code = ch.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
  if (selector.length < 1 || selector.length > 254 || control) {
    throw new Error(
      "An account selector is a label or an email: 1 to 254 characters, no control characters."
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

  /** Every configured row, then the synthesized legacy login when there is one. */
  private rowsOf(entry: SubscriptionAccountsEntry): AccountRecord[] {
    const rows = entry.accounts.map(asRecord);
    const legacy = this.synthesizedLegacy(entry);
    if (legacy) rows.push(legacy);
    return rows;
  }

  /** Label, `--id`, or both naming the SAME row; never a row position. */
  private resolve(
    entry: SubscriptionAccountsEntry,
    target: { label?: string; id?: string }
  ): AccountRecord {
    const rows = this.rowsOf(entry);
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

  /**
   * What the command line named. `--id` filters first; then an exact label wins;
   * only without one, the accounts whose login email matches (case-insensitive).
   * One email match is the row; several are an error that lists them, because a
   * guess could point a `remove` at the wrong account.
   */
  private select(
    entry: SubscriptionAccountsEntry,
    target: { selector?: string; id?: string }
  ): AccountRecord {
    const rows = this.rowsOf(entry).filter(
      (row) => target.id === undefined || row.id === target.id
    );
    const { selector } = target;
    if (selector === undefined) {
      if (rows.length === 1) return rows[0];
      throw new Error("No such Codex account; run `claudish account list`.");
    }
    const exact = rows.filter((row) => row.label === selector);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      throw new Error("Ambiguous Codex account; name it with --id <generated-id>.");
    }
    const byEmail = rows.filter((row) => emailMatches(row.identity.email, selector));
    if (byEmail.length === 1) return byEmail[0];
    if (byEmail.length === 0)
      throw new Error("No such Codex account; run `claudish account list`.");
    throw new Error(
      `More than one Codex account has the email ${selector}: ${byEmail.map(named).join(", ")}. ` +
        "Name one by label, or pass --id <generated-id>." +
        (byEmail.some((row) => row.legacy)
          ? " The legacy login has no --id; name it by its label."
          : "")
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

  /** `login`'s check: the label is free (exact) and the identity is not another row's. */
  private refuseDuplicate(
    entry: SubscriptionAccountsEntry,
    identity: AccountIdentity,
    label: string,
    except?: string
  ): void {
    const rows = this.rowsOf(entry);
    for (const row of rows) {
      if (row.id !== except && row.label === label) {
        throw new Error(`A Codex account labelled ${label} already exists.`);
      }
    }
    this.refuseIdentity(rows, identity, except);
  }

  /** Duplicate key: `chatgptAccountId` across every row (disabled too) and the unsuppressed legacy login. */
  private refuseIdentity(rows: AccountRecord[], identity: AccountIdentity, except?: string): void {
    const stable = stableIdentity(identity);
    for (const row of rows) {
      if (row.id === except) continue;
      if (row.identity.chatgptAccountId === stable) {
        throw new Error(`This Codex identity is already registered as ${row.label}.`);
      }
    }
  }

  /**
   * The label a new row gets, from the live entry: an explicit label must be
   * free, otherwise the login's email with the clash ladder. Called again under
   * the config lock, so a concurrent add that took the bare email makes this
   * one `<email>-<plan>`.
   */
  private chooseLabel(rows: AccountRecord[], identity: AccountIdentity, explicit?: string): string {
    const taken = rows.map((row) => row.label);
    if (explicit !== undefined) {
      if (labelTaken(taken, explicit)) {
        throw new Error(`A Codex account labelled ${explicit} already exists.`);
      }
      return explicit;
    }
    return deriveAccountLabel({
      email: identity.email,
      plan: identity.plan,
      chatgptAccountId: identity.chatgptAccountId,
      taken,
    });
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
    if (command.verb === "add") {
      if (command.label !== undefined) validLabel(command.label);
      return this.add(command.label);
    }
    if (command.verb === "rename") validLabel(command.newLabel);
    if (command.id !== undefined && !ACCOUNT_ID_PATTERN.test(command.id)) {
      throw new Error(
        "--id takes a generated account id, as `claudish account list --json` shows."
      );
    }
    if (command.selector === undefined && command.id === undefined) {
      throw new Error("Name the Codex account by label or email, or with --id <generated-id>.");
    }
    if (command.selector !== undefined) validSelector(command.selector);
    const target = this.inspect((entry) => this.select(entry, command));
    if (command.verb === "login") return this.login(target);
    if (command.verb === "rename") return this.rename(target, command.newLabel);
    if (command.verb === "remove") return this.remove(target, command);
    return this.setEnabled(target, command.verb === "enable");
  }

  // -- add -----------------------------------------------------------------

  private async add(requestedLabel?: string): Promise<string[]> {
    const initial = this.inspect((entry) => {
      const legacy = this.synthesizedLegacy(entry);
      if (
        requestedLabel !== undefined &&
        labelTaken(
          this.rowsOf(entry).map((r) => r.label),
          requestedLabel
        )
      ) {
        throw new Error(`A Codex account labelled ${requestedLabel} already exists.`);
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
        `This add also enrolls your working legacy login as ${initial.legacy.label}` +
          `${note(initial.legacy.identity, initial.legacy.label)}, store legacy-codex-file. ` +
          "Its credential file stays where it is and is not copied."
      );
    }
    const store = this.deps.newStore?.() ?? defaultAccountStore(this.env);
    this.print(
      `New Codex account${requestedLabel === undefined ? "" : ` ${requestedLabel}`}; ` +
        `store: ${store.kind}.` +
        (store.kind === "file"
          ? " Warning: its tokens are kept in plaintext files readable only by you (0600)."
          : "")
    );

    const result = await (this.deps.pkce ?? loginCodexPkce)();
    stableIdentity(result.identity);
    // The gate, the token store and the Keychain item key on the id; the label is
    // chosen under the lock, from the live account list, so it is blank here.
    const row: ConfigRow = {
      id: initial.id,
      label: "",
      identity: result.identity,
      store: store.kind,
      enabled: true,
      addedAt: new Date(this.now()).toISOString(),
    };
    const record = asRecord(row);
    let finalLabel = "";

    await this.gate(record, async (holds) => {
      // Rechecked after the browser: a concurrent add may have taken the label or identity.
      // Choosing here makes an exhausted ladder fail before any token is written.
      this.inspect((entry) => {
        if (entry.accounts.some((a) => a.id === row.id))
          throw new Error("The generated account id is taken; retry the add.");
        const rows = this.rowsOf(entry);
        this.refuseIdentity(rows, result.identity);
        this.chooseLabel(rows, result.identity, requestedLabel);
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
          const rows = this.rowsOf(entry);
          this.refuseIdentity(rows, result.identity);
          // Derived again from the live entry: the row published is the row checked.
          const label = this.chooseLabel(rows, result.identity, requestedLabel);
          const legacy = rows.find((r) => r.legacy);
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
          entry.accounts.push({ ...row, label });
          entry.noticeAcceptedAt ??= acceptedAt;
          finalLabel = label;
        });
      } catch (error) {
        await this.cleanupUnpublished(store, record, error);
      }
    });
    await this.invalidate();
    return [
      `Added Codex account ${finalLabel}${note(result.identity, finalLabel)}; store: ${store.kind}.`,
    ];
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
      return [`Codex account ${named(target)}: login saved.`];
    }
    this.print(`Logging in Codex account ${named(target)}; store: ${target.store}.`);
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
      `Codex account ${named(target)}${note(result.identity, target.label)}: login saved; store: ` +
        `${target.store}. A recorded needs-login mark clears on the account's next use.`,
    ];
  }

  // -- enable / disable ----------------------------------------------------

  private async setEnabled(target: AccountRecord, enabled: boolean): Promise<string[]> {
    if (target.legacy) {
      this.print(
        `This enrolls your legacy login ${named(target)}${note(target.identity, target.label)} as a ` +
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
      `Codex account ${named(target)} ${changed ? "" : "is already "}${enabled ? "enabled" : "disabled"}.`,
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

  // -- rename --------------------------------------------------------------

  /** Only the label moves: id, order, enabled, store, identity, usage and exhaustion stay. */
  private async rename(target: AccountRecord, newLabel: string): Promise<string[]> {
    if (target.legacy) {
      // Nothing to enroll when the name does not change.
      if (target.label === newLabel) {
        return [`Codex account ${named(target)} is already labelled ${newLabel}.`];
      }
      if (!target.identity.chatgptAccountId) {
        throw new Error(
          "The legacy Codex login records no account id, so enrolling it cannot be checked for " +
            "duplicates. Run `claudish login codex` once to refresh it, then retry."
        );
      }
    }
    let changed = false;
    await this.gate(target, async (holds) => {
      changed = mutateAccountsConfig(this.configPath(), PROVIDER, (entry) => {
        this.fence(holds);
        const current = this.resolve(
          entry,
          target.legacy ? { label: target.label } : { id: target.id }
        );
        sameTarget(current, target);
        // Idempotent: the same label is not written and the generation does not move.
        if (current.label === newLabel) return;
        const others = this.rowsOf(entry)
          .filter((row) => row.id !== current.id)
          .map((row) => row.label);
        // Case-insensitive against every OTHER row, so a case-only rename of this one is allowed.
        if (labelTaken(others, newLabel)) {
          throw new Error(`A Codex account labelled ${newLabel} already exists.`);
        }
        if (current.legacy) {
          entry.accounts.push({
            id: this.newId(entry),
            label: newLabel,
            identity: current.identity,
            store: "legacy-codex-file",
            enabled: true,
            addedAt: current.addedAt,
          });
          return;
        }
        const row = entry.accounts.find((a) => a.id === target.id);
        if (row) row.label = newLabel;
      });
    });
    if (changed) await this.invalidate();
    if (changed && target.legacy) {
      // Printed only once the write happened: the gated checks above can still refuse.
      this.print(
        `This enrolled your legacy login ${named(target)}${note(target.identity, target.label)} as a ` +
          "configured account, store legacy-codex-file; its credential file stays where it is."
      );
    }
    return [
      changed
        ? `Renamed Codex account ${named(target)} to ${newLabel}.`
        : `Codex account ${named(target)} is already labelled ${newLabel}.`,
    ];
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
        `Remove Codex account ${named(target)}${note(target.identity, target.label)}` +
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
      `Removed Codex account ${named(target)}${note(target.identity, target.label)}. ` +
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
