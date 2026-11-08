import { readFileSync, realpathSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-write.js";
import { isConfigObject, validateRawConfig } from "./config-validation.js";
import { AccountListInvalidError, AccountListUnavailableError } from "./errors.js";
import { FileLockUnavailableError, acquireFileLockSync } from "./file-lock.js";
import type { AccountProvider, SubscriptionAccountsEntry } from "./types.js";

/** The caller supplies activeConfigFile(); this dependency leaf never imports it. */
export function configLockPath(configPath: string): string {
  return `${configPath}.lock`;
}

/**
 * How long a config transaction waits for another process's holder. Every
 * holder is a synchronous read-modify-write of one small file, so a live
 * holder is gone within milliseconds; giving up at once failed a TUI save on
 * any concurrent write. Short, because the wait blocks the event loop.
 */
export const CONFIG_LOCK_WAIT_MS = 250;

/**
 * The config file is unusable as a whole — not JSON, or not a JSON object —
 * so nothing can be saved into it. Distinct from {@link AccountListInvalidError},
 * which names a field inside `subscriptionAccounts`.
 */
export class ConfigInvalidError extends Error {
  constructor(
    readonly path: string,
    readonly detail: string
  ) {
    super(`Cannot save ${path}: ${detail}. Repair or remove the file, then retry.`);
    this.name = "ConfigInvalidError";
  }
}

/**
 * The file the config path names. A `config.json` symlinked into a dotfiles
 * repository is written THROUGH the link: an atomic rename onto the link path
 * would replace the link with a plain file. A missing file keeps its own path.
 */
function resolveConfigTarget(configPath: string): string {
  try {
    return realpathSync(configPath);
  } catch {
    return configPath;
  }
}

function readRawConfig(configPath: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    const detail = err instanceof Error ? err.message : String(err);
    throw new AccountListUnavailableError(configPath, detail, 503, {
      source: "config",
      path: configPath,
      type: "io",
      detail,
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigInvalidError(configPath, "it is not valid JSON");
  }
  if (!isConfigObject(raw)) throw new ConfigInvalidError(configPath, "it is not a JSON object");
  try {
    validateRawConfig(raw);
    return raw;
  } catch (err) {
    throw new AccountListInvalidError({
      source: "config",
      path: configPath,
      type: "invalid",
      detail: err instanceof Error ? err.message : "invalid document",
    });
  }
}

/** No await, unlocked fallback or stale in-memory account publication is permitted. */
export function withRawConfigTransaction<T>(
  configPath: string,
  update: (raw: Record<string, unknown>) => { config: Record<string, unknown>; result: T },
  opts: { waitMs?: number } = {}
): T {
  const target = resolveConfigTarget(configPath);
  const handle = acquireFileLockSync(configLockPath(target), {
    staleMs: 10_000,
    waitMs: opts.waitMs ?? CONFIG_LOCK_WAIT_MS,
  });
  try {
    const raw = readRawConfig(target);
    const before = JSON.stringify(raw);
    const { config, result } = update(raw);
    validateRawConfig(config);
    const after = JSON.stringify(config);
    if (before !== after) {
      if (!handle.holdsLock())
        throw new FileLockUnavailableError(
          handle.path,
          "timeout",
          "config ownership lost before persist"
        );
      atomicWriteFileSync(target, JSON.stringify(config, null, 2), { mode: 0o600 });
    }
    return result;
  } finally {
    handle.release();
  }
}

/** Account publication owns its generation; unrelated raw fields remain intact. */
export function mutateAccountsConfig(
  configPath: string,
  provider: AccountProvider,
  update: (entry: SubscriptionAccountsEntry) => void
): boolean {
  return withRawConfigTransaction(configPath, (raw) => {
    const block = isConfigObject(raw.subscriptionAccounts) ? raw.subscriptionAccounts : {};
    const entry = (block[provider] ?? { generation: 0, accounts: [] }) as SubscriptionAccountsEntry;
    const before = JSON.stringify(entry);
    const generation = entry.generation;
    const result: unknown = update(entry);
    if (result !== null && typeof result === "object" && "then" in result) {
      throw new TypeError("Account config updates must be synchronous");
    }
    const changed = before !== JSON.stringify(entry);
    if (changed) {
      entry.generation = generation + 1;
      block[provider] = entry;
      raw.subscriptionAccounts = block;
    }
    return { config: raw, result: changed };
  });
}
