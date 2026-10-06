// ─── Where the sessions directory and Claude Code's config live ──────────────
//
// ONE rule, shared with the magus `claudish` plugin monitor
// (`plugins/claudish/scripts/session-monitor.ts` `sessionsDirFrom`), which
// polls the directory this process writes. If the two resolve it differently,
// every run is written where the monitor is not looking and nothing errors.
//
// The home directory is `$HOME` first, `os.homedir()` only when HOME is unset
// or empty. Bun's `os.homedir()` ignores a `HOME` changed at runtime (it reads
// the account's home from the password database), so a sandbox or launcher
// that sets HOME — madbench sets `HOME=<workDir>` — sent claudish to the real
// account home while the monitor, reading `$HOME`, watched the sandbox.

import { homedir } from "node:os";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

/** `$HOME` when set and non-empty, else `os.homedir()`. */
export function userHomeFrom(env: Env, homedirFn: () => string = homedir): string {
  const home = env.HOME;
  return home && home.length > 0 ? home : homedirFn();
}

/**
 * `CLAUDISH_SESSIONS_DIR` when set and non-empty, else
 * `<home>/.claudish/sessions` with `<home>` from `userHomeFrom`.
 */
export function sessionsDirFrom(env: Env, homedirFn: () => string = homedir): string {
  const explicit = env.CLAUDISH_SESSIONS_DIR;
  if (explicit && explicit.length > 0) return explicit;
  return join(userHomeFrom(env, homedirFn), ".claudish", "sessions");
}
