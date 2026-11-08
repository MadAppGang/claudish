/**
 * Durable, atomic file replacement: temp → fsync(file) → rename → fsync(dir).
 *
 * ## Why a truncating write is not good enough for a token file
 *
 * `openSync(path, "w")` truncates FIRST and writes second. A crash, a full disk
 * or a kill between those two steps leaves a ZERO-BYTE credential file, and the
 * refresh token it held is gone — the user is logged out with no error and no
 * way back except a browser re-login. That is the failure
 * `auth/codex-oauth.ts`'s `saveCredentials` had.
 *
 * A rename onto the final name is atomic on POSIX, so a reader sees either the
 * whole old file or the whole new one and never a truncated one. The two
 * `fsync`s are what make the guarantee survive a power loss rather than only a
 * process death: `fsync(fd)` puts the BYTES on the medium, `fsync(dir)` puts the
 * DIRECTORY ENTRY there. Without the second, a crash can leave the rename
 * unrecorded and the temp file orphaned.
 *
 * The directory fsync is best-effort: some filesystems and platforms reject
 * `fsync` on a directory fd (Windows, some network mounts). The rename has
 * already happened by then, so a failure there costs durability across a power
 * cut, never correctness — and refusing the whole write for it would be worse.
 *
 * Extracted from `providers/grok/grok-credentials.ts:382-384`, which had the
 * temp+rename half and neither fsync.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export interface AtomicWriteOptions {
  /** Mode for BOTH the temp file and the final file. Defaults to 0600. */
  mode?: number;
  /** Create the parent directory (recursively) if missing. Defaults to true. */
  mkdir?: boolean;
  /** Mode for a directory created by `mkdir`. Defaults to 0700. */
  dirMode?: number;
  /** fsync the parent directory after the rename. Defaults to true. */
  fsyncDir?: boolean;
}

/**
 * Write `data` to `path` atomically and durably.
 *
 * Throws on any failure of the steps that matter (mkdir, open, write,
 * fsync(file), rename), after removing the temp file — an exception here means
 * "the old contents are still there", never "the file is now half written".
 */
export function atomicWriteFileSync(
  path: string,
  data: string | Uint8Array,
  opts: AtomicWriteOptions = {}
): void {
  const mode = opts.mode ?? 0o600;
  const dir = dirname(path);

  if (opts.mkdir !== false) {
    mkdirSync(dir, { recursive: true, mode: opts.dirMode ?? 0o700 });
  }

  // The temp name carries pid + randomness so two processes racing on the same
  // path cannot write into each other's temp file. Same directory as the target,
  // because `rename` is only atomic within one filesystem.
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;

  try {
    // `openSync`'s mode is masked by the process umask, so a 0022 umask turns a
    // requested 0600 into 0600 but a requested 0644 into 0644 — and, more to the
    // point, an inherited umask cannot be relied on to be restrictive. The
    // explicit `chmod` below is what makes 0600 a guarantee rather than a
    // request, and it runs BEFORE the rename so the file is never briefly
    // readable under its final name.
    const fd = openSync(tmp, "wx", mode);
    try {
      writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data));
      // Bytes on the medium before the rename publishes the name.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* the temp file is debris at worst */
    }
    throw err;
  }

  if (opts.fsyncDir !== false) {
    try {
      const dirFd = openSync(dir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Best effort — see the header. The rename already happened.
    }
  }
}
