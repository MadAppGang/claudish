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
import { readFileSync, statSync } from "node:fs";
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

  /**
   * Hold `next` as this process's credentials after THIS process wrote it to `path`,
   * recording the file's current stamp so our own write is not read back as a change.
   */
  adoptWritten(next: T): void {
    const path = this.opts.path();
    const stamp = statCredentialFile(path);
    this.current = next;
    this.recorded = stamp && !("error" in stamp) ? { path, stamp } : null;
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
