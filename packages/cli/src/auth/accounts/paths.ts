/**
 * Every filesystem location the account pool owns, in one place.
 *
 * ```
 * ~/.claudish/accounts/state.json                    (0600) shared cross-process state
 * ~/.claudish/accounts/state.lock                          the state lock
 * ~/.claudish/accounts/locks/<provider>/<id>.lock          the refresh gate
 * ~/.claudish/accounts/tokens/<provider>/<id>.json   (0600) the file token store
 * ~/.claudish/accounts/usage/{raw,hourly}/<day>.jsonl (0600) the usage ledger
 * ~/.claudish/accounts/allowance-alerts.json         (0600) shared allowance alert memory
 * ~/.claudish/codex-oauth.json                             the LEGACY Codex account
 * ~/.claudish/config.json                                  the account list (no secrets)
 * ```
 *
 * ## Why the provider namespace is in the path and not in the filename
 *
 * Account ids are generated per vendor from the same 12-character alphabet, so
 * two vendors CAN mint the same id. `locks/openai-codex/<id>.lock` and
 * `locks/native-anthropic/<id>.lock` are then different files; `locks/<id>.lock`
 * would be one file, and a Codex refresh would block a Claude refresh while both
 * wrote the same token file. V15 (ai-docs/architecture/accounts-validation.md)
 * runs both vendors in ONE temp HOME with the same id deliberately seeded under
 * both, which is the only arrangement in which that collision is observable.
 *
 * ## Both path segments are validated HERE, not only by the account list
 *
 * `registry.ts` rejects a configured account whose id does not match
 * `ACCOUNT_ID_PATTERN`, which is the first line of defence. This is the second:
 * a caller that builds an `AccountRef` by hand, or a future reader that forgets
 * the pattern, still cannot turn `"../../../tmp/x"` into a token file outside the
 * accounts directory, because the path builder itself refuses the segment.
 * Throwing is the only safe answer — silently sanitising an id would map two
 * different ids onto one file.
 *
 * ## `CLAUDISH_ACCOUNTS_DIR`
 *
 * A test seam for the multi-process e2e, which drives the real built binary and
 * therefore has no module registry to patch. It relocates the accounts directory
 * ONLY — the config file still follows `--config` / `CLAUDISH_CONFIG` through
 * `config-override.ts`, because that is one authority and a second answer to
 * "which config is live" is exactly the drift this repo has paid for before.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  ACCOUNT_ID_PATTERN,
  type AccountRecord,
  LEGACY_CODEX_ACCOUNT_ID,
  isAccountProvider,
} from "./types.js";

/** A provider or account id that must never be interpolated into a path. */
export class UnsafeAccountPathError extends Error {
  constructor(detail: string) {
    super(`Refusing to build an account path: ${detail}`);
    this.name = "UnsafeAccountPathError";
  }
}

/** Render an untrusted segment for an error message, bounded and quoted. */
function shown(value: string): string {
  const quoted = JSON.stringify(value);
  return quoted.length > 60 ? `${quoted.slice(0, 57)}…"` : quoted;
}

/**
 * Throw unless `provider` is a pool vendor and `accountId` is a generated id
 * (or the legacy Codex sentinel, under `openai-codex` only).
 *
 * Exported so a caller that computes a path some other way can apply the same
 * rule rather than a second, drifting copy of it.
 */
export function assertSafeAccountSegments(provider: string, accountId: string): void {
  if (!isAccountProvider(provider)) {
    throw new UnsafeAccountPathError(`${shown(provider)} is not an account provider`);
  }
  if (provider === "openai-codex" && accountId === LEGACY_CODEX_ACCOUNT_ID) return;
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new UnsafeAccountPathError(
      `account id ${shown(accountId)} is not a generated id (${ACCOUNT_ID_PATTERN.source})`
    );
  }
}

/** `~/.claudish`, or the accounts-dir override's parent when one is set. */
export function claudishHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME && env.HOME.length > 0 ? env.HOME : homedir(), ".claudish");
}

/** `~/.claudish/accounts`, or `CLAUDISH_ACCOUNTS_DIR` when set. */
export function accountsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDISH_ACCOUNTS_DIR;
  if (override && override.length > 0) return override;
  return join(claudishHome(env), "accounts");
}

/** The shared cross-process state document. */
export function statePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(accountsDir(env), "state.json");
}

/** The lock guarding {@link statePath}'s read-modify-write. */
export function stateLockFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(accountsDir(env), "state.lock");
}

/**
 * The usage ledger's root (allowance architecture §2.1):
 *
 * ```
 * usage/raw/YYYY-MM-DD.jsonl     (0600) one UTC day of rows, appended
 * usage/hourly/YYYY-MM-DD.jsonl  (0600) the hourly rollup of ONE closed day
 * usage/compact.lock                    the compaction lock
 * ```
 */
export function usageDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(accountsDir(env), "usage");
}

/** `usage/raw/`, one segment per UTC day. */
export function usageRawDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(usageDir(env), "raw");
}

/** `usage/hourly/`, one rollup per closed UTC day. */
export function usageHourlyDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(usageDir(env), "hourly");
}

/** `YYYY-MM-DD` is the only name a segment may have, so no row can choose a path. */
const USAGE_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function assertUsageDay(day: string): void {
  if (!USAGE_DAY_PATTERN.test(day)) {
    throw new UnsafeAccountPathError(`usage day ${shown(day)} is not YYYY-MM-DD`);
  }
}

/** The raw segment of one UTC day. */
export function usageRawPath(day: string, env: NodeJS.ProcessEnv = process.env): string {
  assertUsageDay(day);
  return join(usageRawDir(env), `${day}.jsonl`);
}

/** The hourly rollup of one closed UTC day. */
export function usageHourlyPath(day: string, env: NodeJS.ProcessEnv = process.env): string {
  assertUsageDay(day);
  return join(usageHourlyDir(env), `${day}.jsonl`);
}

/** The compaction lock: a try-lock, never waited on. */
export function usageCompactLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(usageDir(env), "compact.lock");
}

/** The shared alert memory and the announced transition ids (allowance §2.4). */
export function allowanceAlertsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(accountsDir(env), "allowance-alerts.json");
}

/** The try-lock around the alert memory's read-modify-write (allowance §2.4). */
export function allowanceAlertsLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(accountsDir(env), "allowance-alerts.lock");
}

/**
 * The refresh gate for one account. Provider-namespaced — see the header.
 *
 * Throws {@link UnsafeAccountPathError} for a segment that is not a pool vendor
 * or a generated id.
 */
export function accountLockPath(
  provider: string,
  accountId: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  assertSafeAccountSegments(provider, accountId);
  return join(accountsDir(env), "locks", provider, `${accountId}.lock`);
}

/** Enrollment changes metadata identity, never the legacy file's refresh gate. */
export function accountRefreshLockPath(
  record: Pick<AccountRecord, "provider" | "id" | "store">,
  env: NodeJS.ProcessEnv = process.env
): string {
  assertSafeAccountSegments(record.provider, record.id);
  if (record.store === "legacy-codex-file" && record.provider !== "openai-codex") {
    throw new UnsafeAccountPathError("the legacy store belongs to Codex");
  }
  return accountLockPath(
    record.provider,
    record.store === "legacy-codex-file" ? LEGACY_CODEX_ACCOUNT_ID : record.id,
    env
  );
}

/**
 * The file token store's path for one account. Provider-namespaced.
 *
 * Throws {@link UnsafeAccountPathError} for a segment that is not a pool vendor
 * or a generated id.
 */
export function accountTokenPath(
  provider: string,
  accountId: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  assertSafeAccountSegments(provider, accountId);
  return join(accountsDir(env), "tokens", provider, `${accountId}.json`);
}

/**
 * The legacy single-account Codex credential file.
 *
 * Left exactly where it is. It is the entire migration base — every current
 * single-account Codex user — and moving it would log all of them out.
 */
export function legacyCodexCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(claudishHome(env), "codex-oauth.json");
}
