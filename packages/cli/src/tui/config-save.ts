import type { KeySource } from "../auth/credentials/types.js";

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
 * The sentence added to a key-saved status line when another store still
 * outranks the saved key in a new launch (`credentials.sourcesOutranking`).
 * This process signs with the saved key either way; a new process resolves the
 * environment first, then `config.json`, then the vaults. Empty when nothing
 * outranks it.
 */
export function outrankedKeyNote(envVar: string, outranking: readonly KeySource[]): string {
  const where: string[] = [];
  if (outranking.includes("environment")) where.push(`the ${envVar} exported in your shell`);
  if (outranking.includes("config")) where.push(`${envVar} in ~/.claudish/config.json apiKeys`);
  if (where.length === 0) return "";
  return ` This session signs with it, but new launches still use ${where.join(" and ")}, which outranks it: remove that to use the new key.`;
}
