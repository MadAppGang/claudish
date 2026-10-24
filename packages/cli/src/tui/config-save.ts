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
