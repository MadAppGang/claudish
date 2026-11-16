import { credentials } from "../auth/credentials/authority.js";
import { configLabel } from "../auth/credentials/key-sources.js";
import type { KeySource, OutrankingSource } from "../auth/credentials/types.js";

/** What a Keychain copy did. Counts and variable NAMES only, never a value. */
export interface KeychainCopyOutcome {
  created: number;
  replaced: number;
  /** Variables that could not be stored, by name. */
  skipped: string[];
  /** Variables that were stored, by name. */
  written: string[];
}

/**
 * Drop the authority's memo for every provider whose key variable a Keychain
 * copy just wrote, and only those: a key the user saved for another provider
 * (`credentials.replaceKey`) keeps signing.
 */
export function invalidateAfterKeychainCopy(outcome: Pick<KeychainCopyOutcome, "written">): void {
  credentials.invalidateKeyVars(outcome.written);
}

/**
 * The status line for a config save that was refused.
 *
 * `saveConfig()` throws when another claudish process holds `config.json.lock`
 * past the bounded wait, or when the file on disk cannot be parsed. Thrown
 * from a keyboard handler, that reached `uncaughtException` and exited the
 * TUI. Every save site catches it, keeps the dialog and the user's values, and
 * shows this instead. Nothing was written.
 */
export function configSaveFailure(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `Not saved — ${detail}`;
}

/**
 * The status line after a key was saved to `config.json`. `keychainFailure`,
 * when given, is why the Keychain write failed and the key fell back to
 * `config.json`. `note` ({@link outrankedKeyNote}) is appended either way: a
 * shell export outranks a config.json key in a new launch whichever path
 * stored it.
 */
export function configKeySavedStatus(
  displayName: string,
  envVar: string,
  note: string,
  keychainFailure?: string
): string {
  return keychainFailure === undefined
    ? `Key saved for ${displayName} (${envVar}).${note}`
    : `Keychain write failed (${keychainFailure}) — saved to config.json instead.${note}`;
}

/**
 * The sentence added to a key-saved status line when another store still
 * outranks the saved key in a new launch (`credentials.sourcesOutranking`).
 * This process signs with the saved key either way; a new process resolves the
 * environment first, then `config.json`, then the vaults. Empty when nothing
 * outranks it. An entry that names its variable (an exported alias) is named by
 * that variable; a bare source is named by `envVar`.
 */
export function outrankedKeyNote(
  envVar: string,
  outranking: readonly (KeySource | OutrankingSource)[]
): string {
  const entries = outranking.map((e) => (typeof e === "string" ? { source: e, envVar } : e));
  const varOf = (source: KeySource) => entries.find((e) => e.source === source)?.envVar;
  const where: string[] = [];
  const exported = varOf("environment");
  if (exported) where.push(`the ${exported} exported in your shell`);
  const configured = varOf("config");
  if (configured) where.push(`${configured} in ${configLabel()} apiKeys`);
  if (where.length === 0) return "";
  const [verb, pronoun] = where.length > 1 ? ["outrank", "them"] : ["outranks", "that"];
  return ` This session signs with it, but new launches still use ${where.join(" and ")}, which ${verb} it: remove ${pronoun} to use the new key.`;
}
