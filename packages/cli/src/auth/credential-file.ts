/**
 * This process's copy of ONE credential file, kept in step with the file on disk.
 *
 * A long-lived claudish (`claudish --mcp`, `serve`, a pane child) used to read its OAuth
 * login once, in a constructor, and keep that copy for its whole life. After
 * `claudish login grok` rewrote `~/.claudish/grok-oauth.json` in another terminal, an
 * older MCP server kept presenting the revoked refresh token and answering `Grok token
 * refresh failed: Refresh token has been revoked` until it was restarted
 * (model-failures-2026-10-21.md, D1).
 *
 * There is no timer. The file is checked with one path `stat` at the moments a caller
 * asks (before signing, before refreshing, before reporting a dead login), and re-read
 * only when its stamp moved. The stamp is recorded per path, so a test seam that swaps
 * the path always reads the new file.
 *
 * Four disk states, and why the fourth exists: an OLDER claudish on the same machine
 * writes this file in place (`openSync(path, "w")`), so between its truncate and its
 * write a reader sees a 0-byte or partial file. If that read meant "no credentials", one
 * torn read would sign a subscription user out, and the routing chain would walk the
 * request onto a metered provider. So a file that exists but cannot be read, parsed or
 * validated is `unreadable`: the last good credentials are kept, the new stamp is NOT
 * recorded (the next call reads again), and only ENOENT means `removed`.
 *
 * Never logs a credential value: log lines carry the label and the path only.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { log } from "../logger.js";

/** What identifies one version of a file without reading it. */
export interface FileStamp {
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

/**
 * `null` = the file does not exist (ENOENT only). Any other stat error (EACCES, EIO …)
 * is `{ error }`, which a caller treats as "unreadable", never as "removed".
 */
export function statCredentialFile(path: string): FileStamp | null | { error: string } {
  try {
    const st = statSync(path);
    return { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return null;
    return { error: code ?? String(err) };
  }
}

function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/**
 * Write `data` as JSON: a new temp file (`<path>.tmp-<pid>-<hex>`, opened "wx", mode
 * 0600), fsync, rename onto `path`. A reader sees the old file or the new one, never a
 * partial one. Returns the new stamp. Throws with the old file intact on any failure.
 */
export function writeCredentialFileAtomic(path: string, data: unknown): FileStamp {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify(data, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Never created, or already renamed.
    }
    throw err;
  }
  const stamp = statCredentialFile(path);
  if (!stamp || "error" in stamp) throw new Error(`credential file vanished after write: ${path}`);
  return stamp;
}

/**
 * Which login a credential belongs to. A refresh keeps the lineage when the server
 * does not rotate the refresh token and moves it when it does; a NEW login always
 * moves it. With no refresh token the access token stands in.
 */
function lineageOf(credentials: { access_token: string; refresh_token?: string }): string {
  return credentials.refresh_token
    ? `refresh:${credentials.refresh_token}`
    : `access:${credentials.access_token}`;
}

/** What became of a refreshed credential this process tried to write back. */
export type SaveRefreshedResult<T> =
  /** The file still held `base`'s lineage; `next` was written. */
  | { outcome: "saved" }
  /** Another process wrote a different login during the exchange; nothing written. */
  | { outcome: "newer-on-disk"; onDisk: T }
  /** The file was deleted during the exchange (a logout); nothing written. */
  | { outcome: "removed" }
  /** Still unreadable after the bounded re-read: it may be a newer login caught mid-write. */
  | { outcome: "unreadable" }
  /** The atomic write itself failed (EACCES, ENOSPC); the old file is intact. */
  | { outcome: "write-failed" };

/**
 * unchanged  : same path, same stamp as the last GOOD read
 * reloaded   : the stamp moved; the file parsed and validated; `value` replaced
 * removed    : ENOENT; `value` becomes null
 * unreadable : the file exists but cannot be read, parsed or validated; `value` keeps
 *              the last good credentials and the stamp is not recorded
 */
export type DiskSync = "unchanged" | "reloaded" | "removed" | "unreadable";

/** Re-reads of an unreadable file before `settle()` gives up, and the pause between them. */
const SETTLE_RETRIES = 3;
const SETTLE_DELAY_MS = 25;

export interface CredentialFileOptions<T> {
  /** Read per call, so a test path seam works. */
  path: () => string;
  validate: (data: unknown) => data is T;
  /** Log label: "GrokOAuth", "KimiOAuth". */
  label: string;
}

export class CredentialFileState<T extends { access_token: string; refresh_token?: string }> {
  private current: T | null = null;
  /** The path and stamp of the last GOOD read (or of a confirmed absence). */
  private recorded: { path: string; stamp: FileStamp | null } | null = null;

  constructor(private readonly opts: CredentialFileOptions<T>) {}

  /** The last GOOD credentials, or null when never loaded or removed. No I/O. */
  get value(): T | null {
    return this.current;
  }

  /** stat; compare with the recorded {path, stamp}; read only when either differs. */
  syncFromDisk(): DiskSync {
    const path = this.opts.path();
    const label = this.opts.label;
    const stamp = statCredentialFile(path);

    if (stamp === null) {
      if (this.current !== null) log(`[${label}] credential file removed on disk; signed out`);
      this.current = null;
      this.recorded = { path, stamp: null };
      return "removed";
    }
    if ("error" in stamp) return this.unreadable(path);

    const recorded = this.recorded;
    if (recorded && recorded.path === path && recorded.stamp && sameStamp(recorded.stamp, stamp)) {
      return "unchanged";
    }

    let data: unknown;
    try {
      data = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return this.unreadable(path);
    }
    if (!this.opts.validate(data)) return this.unreadable(path);

    const firstLoad = recorded === null || recorded.path !== path;
    this.current = data;
    this.recorded = { path, stamp };
    log(
      firstLoad
        ? `[${label}] Loaded credentials from file`
        : `[${label}] credential file changed on disk; reloaded`
    );
    return "reloaded";
  }

  /** `syncFromDisk()`, and on "unreadable" re-read up to 3 times, 25 ms apart. */
  async settle(): Promise<DiskSync> {
    let result = this.syncFromDisk();
    for (let i = 0; i < SETTLE_RETRIES && result === "unreadable"; i++) {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));
      result = this.syncFromDisk();
    }
    return result;
  }

  /** A login: the user's intent, written unconditionally (atomic). */
  saveLogin(next: T): void {
    const path = this.opts.path();
    const stamp = writeCredentialFileAtomic(path, next);
    this.current = next;
    this.recorded = { path, stamp };
  }

  /**
   * Hold `next` in memory WITHOUT writing it or recording a stamp: the next sync
   * reads the file again, and a newer login that finished writing wins.
   */
  keepInMemory(next: T): void {
    this.current = next;
  }

  /**
   * A refresh result. Settles first, then writes `next` ONLY if the file still holds
   * `base`'s lineage (compare-and-set on the login, not on the stamp: our own
   * previous write also moves the stamp). A refresh that raced a login therefore
   * cannot undo the login. Never throws.
   */
  async saveRefreshed(base: T, next: T): Promise<SaveRefreshedResult<T>> {
    const label = this.opts.label;
    const sync = await this.settle();
    if (sync === "unreadable") {
      log(
        `[${label}] credential file unreadable after the token refresh; kept the refreshed token in memory, not written`
      );
      return { outcome: "unreadable" };
    }
    const onDisk = this.current;
    if (sync === "removed" || onDisk === null) return { outcome: "removed" };
    if (lineageOf(onDisk) !== lineageOf(base)) {
      log(`[${label}] credential file changed during the token refresh; kept the newer file`);
      return { outcome: "newer-on-disk", onDisk };
    }
    const path = this.opts.path();
    try {
      const stamp = writeCredentialFileAtomic(path, next);
      this.current = next;
      this.recorded = { path, stamp };
      log(`[${label}] Credentials saved to ${path}`);
      return { outcome: "saved" };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code ?? "error";
      log(
        `[${label}] could not write the refreshed credentials (${path}, ${code}); kept them in memory`
      );
      return { outcome: "write-failed" };
    }
  }

  /** Forget the in-memory credentials (a logout in this process). */
  forget(): void {
    this.current = null;
  }

  private unreadable(path: string): DiskSync {
    log(
      `[${this.opts.label}] credential file unreadable (${path}); kept the last good credentials`
    );
    return "unreadable";
  }
}

export interface RefreshAndCommitOptions<T> {
  /** Whether a credential's access token can still be used without a refresh. */
  isValid: (credentials: T) => boolean;
  /** The terminal "No … credentials found. Please run `claudish login …`" error. */
  noCredentials: () => Error;
}

/**
 * Refresh this process's credentials and commit the result to the file, without ever
 * undoing a login another process wrote meanwhile. ONE implementation, shared by
 * `OAuthManager` and `KimiOAuth`, so the adopt and retry-once rules cannot drift.
 *
 * - `refresh(current)` does the network exchange only and returns the next
 *   credentials; it never writes.
 * - A failed refresh is not reported yet: the file is settled first. If it now holds
 *   a different login (`claudish login` ran elsewhere), that login is used: its token
 *   when still valid, else ONE refresh from its refresh token. Otherwise the original
 *   error is rethrown unchanged (same object), so its classification at the auth
 *   sites is untouched and no status is invented.
 * - The result is committed with `saveRefreshed`: written only if the file still holds
 *   the lineage we refreshed from; a newer login on disk is adopted instead; a deleted
 *   file (logout) is not recreated; an unreadable file or a failed write keeps the
 *   refreshed token in memory and signs with it.
 *
 * Returns the access token to sign with.
 */
export async function refreshAndCommit<T extends { access_token: string; refresh_token?: string }>(
  state: CredentialFileState<T>,
  refresh: (current: T) => Promise<T>,
  opts: RefreshAndCommitOptions<T>,
  label = "credentials"
): Promise<string> {
  const base = state.value;
  if (!base) throw opts.noCredentials();

  let next: T;
  try {
    next = await refresh(base);
  } catch (err) {
    await state.settle();
    const now = state.value;
    if (now && lineageOf(now) !== lineageOf(base)) {
      log(
        `[${label}] token refresh failed, but the credential file changed on disk; using the newer login`
      );
      return useLogin(state, now, refresh, opts, label, false);
    }
    throw err;
  }
  return commit(state, base, next, refresh, opts, label, true);
}

/** Sign with `login` (a login another process wrote): its token if valid, else refresh once. */
async function useLogin<T extends { access_token: string; refresh_token?: string }>(
  state: CredentialFileState<T>,
  login: T,
  refresh: (current: T) => Promise<T>,
  opts: RefreshAndCommitOptions<T>,
  label: string,
  mayRetry: boolean
): Promise<string> {
  if (opts.isValid(login)) return login.access_token;
  const next = await refresh(login);
  return commit(state, login, next, refresh, opts, label, mayRetry);
}

async function commit<T extends { access_token: string; refresh_token?: string }>(
  state: CredentialFileState<T>,
  base: T,
  next: T,
  refresh: (current: T) => Promise<T>,
  opts: RefreshAndCommitOptions<T>,
  label: string,
  mayRetry: boolean
): Promise<string> {
  const result = await state.saveRefreshed(base, next);
  switch (result.outcome) {
    case "saved":
      return next.access_token;
    case "newer-on-disk":
      // Discard our result. A newer login that is already expired is refreshed once;
      // past that one retry, our fresh token signs this request from memory.
      if (opts.isValid(result.onDisk) || mayRetry) {
        return useLogin(state, result.onDisk, refresh, opts, label, false);
      }
      state.keepInMemory(next);
      return next.access_token;
    case "removed":
      // A logout during the exchange is not undone.
      throw opts.noCredentials();
    case "unreadable":
    case "write-failed":
      state.keepInMemory(next);
      return next.access_token;
  }
}
