/**
 * claudish's own two Muse Code credential files, in `~/.claudish`:
 *
 * - `meta-muse-oauth.json` — claudish's OWN login (`claudish login muse`).
 * - `meta-muse-borrowed.json` — claudish's COPY of the Muse Code CLI's `dca:`
 *   access token. Written only after a Keychain read AND a mint that confirmed
 *   the subscription, by a process allowed to read the Keychain
 *   (`credentialPromptRole()` not `never`). It is what lets a `team` slot, an
 *   MCP session or a piped launch use the borrowed login without ever opening
 *   a Keychain dialog itself, and without an env handoff (an env var would
 *   reach the child's Claude Code, whose Bash tool can print it).
 *
 * claudish never writes the Muse Code CLI's own Keychain item.
 *
 * Both files: mode 0600, written atomically (temp file + rename, so a crash
 * never leaves a truncated credential), validated on read. A file is VALID when
 * it parses and carries a non-empty string `access_token` ({@link isValidMuseStore}),
 * the one predicate every reader uses. Muse Code's own logout revokes the token
 * remotely, after which a mint answers 401 and the copy is useless;
 * `claudish logout muse` removes both files ({@link deleteMuseStores}).
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type MuseStoreKind = "own-login" | "borrowed-copy";

/** What a borrowed copy holds. `schema` versions the file, not the token. */
export interface MuseBorrowedCopy {
  schema: 1;
  access_token: string;
  /** ISO time the copy was written. */
  copied_at: string;
  /** The tier the confirming mint named, for display and the source-switch log. */
  subs_tier_name?: string;
}

/** The fields claudish reads from either file. Other fields are kept as written. */
export interface MuseStoreRecord {
  access_token: string;
  subs_tier_name?: string;
  [key: string]: unknown;
}

const FILE_NAMES: Record<MuseStoreKind, string> = {
  "own-login": "meta-muse-oauth.json",
  "borrowed-copy": "meta-muse-borrowed.json",
};

/** `~/.claudish`, the directory both files and the Keychain read lock live in. */
export function defaultMuseStoreDir(): string {
  return join(homedir(), ".claudish");
}

/** The path of one store file. */
export function museStorePath(kind: MuseStoreKind, dir: string = defaultMuseStoreDir()): string {
  return join(dir, FILE_NAMES[kind]);
}

/** The one validity predicate: parsed, and a non-empty string `access_token`. */
export function isValidMuseStore(value: unknown): value is MuseStoreRecord {
  if (!value || typeof value !== "object") return false;
  const token = (value as Record<string, unknown>).access_token;
  return typeof token === "string" && token.trim().length > 0;
}

/** Read and validate one store file; null when absent, unreadable or invalid. */
export function readMuseStore(
  kind: MuseStoreKind,
  dir: string = defaultMuseStoreDir()
): MuseStoreRecord | null {
  const path = museStorePath(kind, dir);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isValidMuseStore(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Write one store file: 0600, atomically. The directory is created 0700 when
 * missing. Refuses a record that would not read back as valid.
 */
export function writeMuseStore(
  kind: MuseStoreKind,
  record: MuseStoreRecord,
  dir: string = defaultMuseStoreDir()
): void {
  if (!isValidMuseStore(record)) {
    throw new Error(`refusing to write an invalid Muse Code ${kind} file (no access_token)`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = museStorePath(kind, dir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  // `mode` applies only when the file is created; a leftover temp file of the
  // same name would keep its own mode, so set it explicitly before the rename.
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Write the borrowed copy of a `dca:` token whose mint confirmed the subscription. */
export function writeBorrowedCopy(
  accessToken: string,
  subsTierName: string | undefined,
  dir: string = defaultMuseStoreDir(),
  now: () => Date = () => new Date()
): void {
  const copy: MuseBorrowedCopy = {
    schema: 1,
    access_token: accessToken,
    copied_at: now().toISOString(),
    ...(subsTierName ? { subs_tier_name: subsTierName } : {}),
  };
  writeMuseStore("borrowed-copy", copy as unknown as MuseStoreRecord, dir);
}

/** Remove both claudish files (`claudish logout muse`). Never touches the Keychain. */
export function deleteMuseStores(dir: string = defaultMuseStoreDir()): void {
  for (const kind of Object.keys(FILE_NAMES) as MuseStoreKind[]) {
    rmSync(museStorePath(kind, dir), { force: true });
  }
}
