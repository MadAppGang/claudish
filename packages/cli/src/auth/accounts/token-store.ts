/**
 * Where an account's token material lives, and the one rule every backing store
 * obeys:
 *
 * > **A read THROWS on failure and returns `null` only for a confirmed absence.**
 *
 * That is the difference between "the keychain is locked" and "this user has no
 * subscription". Collapsing them is how an unreadable store becomes a metered
 * charge: the availability predicate would answer false, the credential chain
 * would fall through to the api-key half, and a flat-rate user would be billed
 * per token for a request they thought their subscription covered. Nothing here
 * ever answers a failure with absence.
 *
 * Three stores:
 *
 * | Kind | Where | When |
 * |---|---|---|
 * | `keychain` | service `claudish-accounts`, one JSON blob per account | macOS default |
 * | `file` | `~/.claudish/accounts/tokens/<provider>/<id>.json` | Linux/WSL, and tests |
 * | `legacy-codex-file` | `~/.claudish/codex-oauth.json` | the migration base |
 *
 * ## `CLAUDISH_DISABLE_KEYCHAIN` is checked HERE, not only by `hasKeychainSource()`
 *
 * That flag is read in exactly one other place in the codebase, and a new store
 * calling the keychain engine directly would walk straight past it — spawning
 * `security` inside a test suite that believed it was hermetic, which is how a
 * previous run reached a developer's real login keychain. So `KeychainTokenStore`
 * checks the flag ITSELF and degrades to `FileTokenStore`.
 *
 * ## `CLAUDISH_KEYCHAIN_FILE` does NOT select the file store
 *
 * It is a trailing `security` argument that redirects every operation to a
 * throwaway keychain, and it exists precisely so live verification has a safe
 * target. Treating it as "use plaintext files" would both make safe
 * keychain-backed validation impossible and hand a macOS user who set the
 * documented isolation variable a plaintext token file. **Only
 * `CLAUDISH_DISABLE_KEYCHAIN` disables the Keychain.**
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { log } from "../../logger.js";
import {
  KEYCHAIN_ACCOUNTS_SERVICE,
  deleteKeychainItem,
  isKeychainSupported,
  readKeychainItem,
  writeKeychainItem,
} from "../../providers/keychain.js";
import { accountsFaultArmed, testUpstreamActive } from "../../test-upstream.js";
import { atomicWriteFileSync } from "./atomic-write.js";
import { accountTokenPath, legacyCodexCredentialsPath } from "./paths.js";
import type { AccountProvider, AccountRef, AccountStoreKind } from "./types.js";

/** A rotation in flight, made durable BEFORE the exchange. */
export interface TokenJournal {
  state: "refreshing" | "unknown" | "dual-refreshing";
  /** The fingerprint the rotation started from. */
  from: string;
  at: number;
  pid: number;
  host: string;
  /** The gate nonce of the actor that opened it. */
  nonce: string;
  /** Dual-store only: destinations known to have committed. */
  committed?: string[];
}

/** One account's stored material. */
export interface StoredTokenRecord {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  /** `chatgpt-account-id` / Anthropic account uuid, when known. */
  accountId?: string;
  /**
   * Monotonic per account. Bumped on every successful persist, and the ONLY way
   * a waiter can tell "someone rotated while I queued" from "nothing happened".
   */
  generation: number;
  /** `sha256(refreshToken).slice(0,16)` — an identity for the material, not the material. */
  fingerprint: string;
  journal?: TokenJournal | null;
  updatedAt: number;
  /**
   * A random id minted for EVERY persist, and the ONLY thing an ambiguous write
   * is resolved by.
   *
   * Neither `generation` nor `fingerprint` can answer "did my write land?": a
   * journal write changes neither, and a final persist whose vendor did not
   * rotate the refresh token keeps the fingerprint. Comparing those resolved
   * every ambiguous journal write as committed. A `writeId` that is not on
   * disk did not commit.
   */
  writeId?: string;
}

/** A store read failed. Never confused with an absence. */
export class TokenStoreReadError extends Error {
  readonly store: AccountStoreKind;
  constructor(store: AccountStoreKind, detail: string) {
    super(`Could not read the ${store} token store: ${detail}`);
    this.name = "TokenStoreReadError";
    this.store = store;
  }
}

/** A store write failed, and the outcome is KNOWN to be "did not commit". */
export class TokenStoreWriteError extends Error {
  readonly store: AccountStoreKind;
  constructor(store: AccountStoreKind, detail: string) {
    super(`Could not write the ${store} token store: ${detail}`);
    this.name = "TokenStoreWriteError";
    this.store = store;
  }
}

/**
 * A write whose outcome is genuinely UNKNOWN — a `security` call that timed out,
 * an `EIO`. The caller must re-read uncached before deciding anything, and must
 * never write a record back "to be safe": that converts an ambiguous success
 * into definite loss of the new refresh token.
 */
export class TokenStoreAmbiguousWriteError extends Error {
  readonly store: AccountStoreKind;
  constructor(store: AccountStoreKind, detail: string) {
    super(`The ${store} token store write outcome is unknown: ${detail}`);
    this.name = "TokenStoreAmbiguousWriteError";
    this.store = store;
  }
}

export interface ReadOptions {
  /**
   * Bypass every cache, including the keychain engine's 3 s burst memo.
   *
   * MANDATORY under the refresh gate. Inside that window the memo would return
   * the pre-rotation token after another process rotated it, and exchanging a
   * revoked refresh token is `invalid_grant` — a logged-out account.
   */
  uncached?: boolean;
}

export interface TokenStore {
  readonly kind: AccountStoreKind;
  /** Throws on failure; `null` ONLY for a confirmed absence. */
  read(ref: AccountRef, opts?: ReadOptions): Promise<StoredTokenRecord | null>;
  write(ref: AccountRef, record: StoredTokenRecord): Promise<void>;
  delete(ref: AccountRef): Promise<void>;
  /** For `account status` — never contains material. */
  describe(): string;
}

/** `sha256(refreshToken).slice(0,16)`. An identity, never reversible to the token. */
export function fingerprintOf(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex").slice(0, 16);
}

function parseRecord(kind: AccountStoreKind, text: string): StoredTokenRecord {
  let raw: Partial<StoredTokenRecord>;
  try {
    raw = JSON.parse(text) as Partial<StoredTokenRecord>;
  } catch (err) {
    // A corrupt record is a FAILED read, never an absence — and never a raw
    // SyntaxError escaping the store's typed contract.
    throw new TokenStoreReadError(
      kind,
      `the stored record is not JSON (${(err as Error).message})`
    );
  }
  if (typeof raw?.accessToken !== "string" || typeof raw?.refreshToken !== "string") {
    throw new TokenStoreReadError(kind, "the stored record has no token pair");
  }
  return {
    accessToken: raw.accessToken,
    refreshToken: raw.refreshToken,
    expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : 0,
    generation: typeof raw.generation === "number" ? raw.generation : 0,
    fingerprint:
      typeof raw.fingerprint === "string" ? raw.fingerprint : fingerprintOf(raw.refreshToken),
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
    ...(typeof raw.accountId === "string" ? { accountId: raw.accountId } : {}),
    ...(raw.journal ? { journal: raw.journal } : {}),
    ...(typeof raw.writeId === "string" ? { writeId: raw.writeId } : {}),
  };
}

/**
 * `lstat`, with `ENOENT` (and `ENOTDIR`) the ONLY route to "absent".
 *
 * `existsSync` answers `false` for a permission-denied parent directory too,
 * which would turn an unreadable store into "no credential" — the exact collapse
 * this module's contract forbids.
 */
function lstatOrAbsent(kind: AccountStoreKind, path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new TokenStoreReadError(kind, err instanceof Error ? err.message : String(err));
  }
}

/** The fault the e2e uses to make "a store read FAILED" an observable event. */
function faultStoreRead(kind: AccountStoreKind, env: NodeJS.ProcessEnv): void {
  if (accountsFaultArmed("store-read-throws", env)) {
    throw new TokenStoreReadError(kind, "CLAUDISH_ACCOUNTS_FAULT=store-read-throws");
  }
}

// ---------------------------------------------------------------------------
// File store
// ---------------------------------------------------------------------------

export interface FileTokenStoreOptions {
  /** Override the path (tests point it at a temp HOME). */
  pathFor?: (ref: AccountRef) => string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Plaintext, `0600`, in a `0700` directory.
 *
 * A genuine fallback where there is no Keychain (Linux/WSL) and the default in
 * tests. `account status` prints a visible plaintext warning wherever it is live,
 * because a user who believes their token is encrypted at rest and is wrong has
 * been told something untrue by omission.
 */
export class FileTokenStore implements TokenStore {
  readonly kind = "file" as const;
  private readonly pathFor: (ref: AccountRef) => string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: FileTokenStoreOptions = {}) {
    this.env = opts.env ?? process.env;
    this.pathFor = opts.pathFor ?? ((ref) => accountTokenPath(ref.provider, ref.id, this.env));
  }

  /** The path, with an unsafe account segment reported as the given typed failure. */
  private pathOrThrow(ref: AccountRef, fail: (detail: string) => Error): string {
    try {
      return this.pathFor(ref);
    } catch (err) {
      throw fail(err instanceof Error ? err.message : String(err));
    }
  }

  async read(ref: AccountRef, _opts: ReadOptions = {}): Promise<StoredTokenRecord | null> {
    faultStoreRead(this.kind, this.env);
    const path = this.pathOrThrow(ref, (d) => new TokenStoreReadError(this.kind, d));
    const link = lstatOrAbsent(this.kind, path);
    if (!link) return null;
    // A symlink here would let anything that can write the directory redirect a
    // token write somewhere world-readable. Refuse rather than follow.
    if (link.isSymbolicLink()) {
      throw new TokenStoreReadError(this.kind, `${path} is a symlink; refusing to follow it`);
    }
    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch (err) {
      throw new TokenStoreReadError(this.kind, err instanceof Error ? err.message : String(err));
    }
    return parseRecord(this.kind, text);
  }

  async write(ref: AccountRef, record: StoredTokenRecord): Promise<void> {
    const path = this.pathOrThrow(ref, (d) => new TokenStoreWriteError(this.kind, d));
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      throw new TokenStoreWriteError(
        this.kind,
        `${path} is a symlink; refusing to write through it`
      );
    }
    try {
      atomicWriteFileSync(path, `${JSON.stringify(record, null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      });
    } catch (err) {
      throw new TokenStoreWriteError(this.kind, err instanceof Error ? err.message : String(err));
    }
  }

  async delete(ref: AccountRef): Promise<void> {
    rmSync(
      this.pathOrThrow(ref, (d) => new TokenStoreWriteError(this.kind, d)),
      { force: true }
    );
  }

  describe(): string {
    return "plaintext file (0600)";
  }
}

// ---------------------------------------------------------------------------
// Keychain store
// ---------------------------------------------------------------------------

export interface KeychainTokenStoreOptions {
  env?: NodeJS.ProcessEnv;
  /** The store used when the Keychain is disabled or unsupported. */
  fallback?: TokenStore;
}

/** `openai-codex:abc123def456` — provider-namespaced inside the one service. */
export function keychainAccountName(provider: AccountProvider, id: string): string {
  return `${provider}:${id}`;
}

/**
 * The macOS Keychain store, service `claudish-accounts`.
 *
 * Reads on the refresh path pass `uncached`, so they never route through the 3 s
 * value memo; reads for DISPLAY may use it.
 */
export class KeychainTokenStore implements TokenStore {
  readonly kind = "keychain" as const;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fallback: TokenStore;

  constructor(opts: KeychainTokenStoreOptions = {}) {
    this.env = opts.env ?? process.env;
    this.fallback = opts.fallback ?? new FileTokenStore({ env: this.env });
  }

  /**
   * True when this store must not touch `security` at all.
   *
   * Read at CALL time, never captured at construction: a test that sets the flag
   * after importing the module must still be protected, and the whole point of
   * the flag is that it cannot be walked past.
   */
  private disabled(): boolean {
    return this.env.CLAUDISH_DISABLE_KEYCHAIN === "1" || !isKeychainSupported();
  }

  async read(ref: AccountRef, opts: ReadOptions = {}): Promise<StoredTokenRecord | null> {
    if (this.disabled()) return this.fallback.read(ref, opts);
    faultStoreRead(this.kind, this.env);
    let raw: string | null;
    try {
      raw = readKeychainItem(KEYCHAIN_ACCOUNTS_SERVICE, keychainAccountName(ref.provider, ref.id), {
        ...(opts.uncached ? { uncached: true } : {}),
      });
    } catch (err) {
      // A locked keychain, a denied ACL, a killed `security` — all FAILURES.
      throw new TokenStoreReadError(this.kind, err instanceof Error ? err.message : String(err));
    }
    // `null` here is exit 44: the item genuinely is not there.
    if (raw === null) return null;
    return parseRecord(this.kind, raw);
  }

  async write(ref: AccountRef, record: StoredTokenRecord): Promise<void> {
    if (this.disabled()) return this.fallback.write(ref, record);
    try {
      writeKeychainItem(
        KEYCHAIN_ACCOUNTS_SERVICE,
        keychainAccountName(ref.provider, ref.id),
        JSON.stringify(record)
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // A timeout or an IO error is AMBIGUOUS: `writeKeychainSecret` invalidates,
      // writes and reads back, so a killed call may or may not have committed.
      // Saying "failed" here would make the caller write the pre-rotation record
      // back and lose a rotation that did land.
      if (/killed by|timed out|ETIMEDOUT|EIO/i.test(detail)) {
        throw new TokenStoreAmbiguousWriteError(this.kind, detail);
      }
      throw new TokenStoreWriteError(this.kind, detail);
    }
  }

  async delete(ref: AccountRef): Promise<void> {
    if (this.disabled()) return this.fallback.delete(ref);
    deleteKeychainItem(KEYCHAIN_ACCOUNTS_SERVICE, keychainAccountName(ref.provider, ref.id));
  }

  describe(): string {
    return this.disabled()
      ? `keychain disabled → ${this.fallback.describe()}`
      : `macOS Keychain (${KEYCHAIN_ACCOUNTS_SERVICE})`;
  }
}

// ---------------------------------------------------------------------------
// Legacy Codex file
// ---------------------------------------------------------------------------

/** The on-disk shape `claudish login codex` has always written. */
interface LegacyCodexFile {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  account_id?: string;
  /** Added by the pool; older files simply do not have it. */
  claudish_generation?: number;
  claudish_journal?: TokenJournal | null;
  /** The pool's per-persist write id — see `StoredTokenRecord.writeId`. */
  claudish_write_id?: string;
}

export interface LegacyCodexFileStoreOptions {
  path?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * `~/.claudish/codex-oauth.json`, read and written in its ORIGINAL shape.
 *
 * The file is left exactly where it is and keeps its existing keys, because
 * `CodexOAuth` still reads it and every current single-account Codex user is
 * behind it. The two fields the pool needs (`generation`, `journal`) are added
 * under `claudish_`-prefixed names that the old reader ignores — a file this
 * store has written is still a file the old reader can use, which is what makes
 * the migration reversible.
 */
export class LegacyCodexFileStore implements TokenStore {
  readonly kind = "legacy-codex-file" as const;
  private readonly path: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: LegacyCodexFileStoreOptions = {}) {
    this.env = opts.env ?? process.env;
    this.path = opts.path ?? legacyCodexCredentialsPath(this.env);
  }

  async read(_ref: AccountRef, _opts: ReadOptions = {}): Promise<StoredTokenRecord | null> {
    faultStoreRead(this.kind, this.env);
    if (!lstatOrAbsent(this.kind, this.path)) return null;
    let text: string;
    try {
      text = readFileSync(this.path, "utf-8");
    } catch (err) {
      throw new TokenStoreReadError(this.kind, err instanceof Error ? err.message : String(err));
    }
    let raw: LegacyCodexFile;
    try {
      raw = JSON.parse(text) as LegacyCodexFile;
    } catch (err) {
      throw new TokenStoreReadError(this.kind, err instanceof Error ? err.message : String(err));
    }
    if (!raw?.access_token || !raw?.refresh_token) {
      throw new TokenStoreReadError(this.kind, "the credential file has no token pair");
    }
    return {
      accessToken: raw.access_token,
      refreshToken: raw.refresh_token,
      expiresAt: typeof raw.expires_at === "number" ? raw.expires_at : 0,
      generation: typeof raw.claudish_generation === "number" ? raw.claudish_generation : 0,
      fingerprint: fingerprintOf(raw.refresh_token),
      updatedAt: 0,
      ...(raw.account_id ? { accountId: raw.account_id } : {}),
      ...(raw.claudish_journal ? { journal: raw.claudish_journal } : {}),
      ...(typeof raw.claudish_write_id === "string" ? { writeId: raw.claudish_write_id } : {}),
    };
  }

  async write(_ref: AccountRef, record: StoredTokenRecord): Promise<void> {
    // Preserve every key already in the file. A whole-document rewrite from the
    // pool's own view would silently drop anything a newer (or older) claudish
    // keeps there.
    let existing: Record<string, unknown> = {};
    try {
      if (existsSync(this.path)) {
        existing = JSON.parse(readFileSync(this.path, "utf-8")) as Record<string, unknown>;
      }
    } catch {
      // Unreadable: the write below still lands, and the fields we own are the
      // only ones we can honestly claim to know.
      existing = {};
    }
    const merged = {
      ...existing,
      access_token: record.accessToken,
      refresh_token: record.refreshToken,
      expires_at: record.expiresAt,
      ...(record.accountId ? { account_id: record.accountId } : {}),
      claudish_generation: record.generation,
      claudish_journal: record.journal ?? null,
      ...(record.writeId ? { claudish_write_id: record.writeId } : {}),
    };
    try {
      atomicWriteFileSync(this.path, JSON.stringify(merged, null, 2), { mode: 0o600 });
    } catch (err) {
      throw new TokenStoreWriteError(this.kind, err instanceof Error ? err.message : String(err));
    }
  }

  async delete(_ref: AccountRef): Promise<void> {
    rmSync(this.path, { force: true });
  }

  describe(): string {
    return `legacy credential file (${this.path})`;
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * The store for one account's declared `store` kind.
 *
 * `CLAUDISH_ACCOUNT_STORE=file` is honoured only when `CLAUDISH_TEST_UPSTREAM` is
 * also set, or the platform has no Keychain at all. Without that coupling, an env
 * var alone would move a macOS user's refresh tokens into plaintext.
 */
export function storeFor(kind: AccountStoreKind, env: NodeJS.ProcessEnv = process.env): TokenStore {
  if (kind === "legacy-codex-file") return new LegacyCodexFileStore({ env });
  if (kind === "file") return new FileTokenStore({ env });

  const forcedFile = env.CLAUDISH_ACCOUNT_STORE === "file";
  if (forcedFile && (testUpstreamActive(env) || !isKeychainSupported())) {
    log("[accounts] CLAUDISH_ACCOUNT_STORE=file honoured (test upstream, or no Keychain here)");
    return new FileTokenStore({ env });
  }
  if (forcedFile) {
    log(
      "[accounts] CLAUDISH_ACCOUNT_STORE=file IGNORED: it is honoured only alongside " +
        "CLAUDISH_TEST_UPSTREAM, or where the platform has no Keychain"
    );
  }
  return new KeychainTokenStore({ env });
}

/**
 * Where a NEW account's material goes, as the store that will actually hold it.
 *
 * The row records this store's `kind`, so it must be the real destination: a
 * disabled Keychain delegates to the file store, and recording `keychain` for
 * that row would send a later process (with the Keychain enabled) to an empty
 * item. `CLAUDISH_KEYCHAIN_FILE` stays a Keychain, never plaintext.
 */
export function defaultAccountStore(env: NodeJS.ProcessEnv = process.env): TokenStore {
  if (env.CLAUDISH_DISABLE_KEYCHAIN === "1" || !isKeychainSupported()) {
    return new FileTokenStore({ env });
  }
  return storeFor("keychain", env);
}
