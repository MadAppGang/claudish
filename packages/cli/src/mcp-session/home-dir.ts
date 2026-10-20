// ─── Where the sessions directory and Claude Code's config live ──────────────
//
// The sessions directory: ONE rule, shared with the magus `claudish` plugin monitor
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

// ─── Claude Code's project directory name for a cwd ──────────────────────────

/** Claude Code keeps a project directory name to this many slug characters. */
export const PROJECT_DIR_SLUG_MAX = 200;

/** Claude Code's 32-bit string hash (`(h << 5) - h + charCode`, per UTF-16 unit). */
function claudeCodeStringHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * Claude Code's project directory name for a cwd: every character outside
 * `[A-Za-z0-9]` becomes `-` (so `/.claude/` becomes `--claude-`). A slug longer than
 * 200 characters is cut to 200 and suffixed `-<base36 |hash(cwd)|>`, the hash taken
 * over the WHOLE path, not the slug. Read from Claude Code 2.1.291's own bundle
 * (`k(e)=e.replace(/[^a-zA-Z0-9]/g,"-")`, `eI(e)` truncates at `Rle=200` and appends
 * `Le(e)=Math.abs(hash(e)).toString(36)`) and MEASURED: a live 2.1.291 run in a
 * 259-character cwd wrote `<200 slug chars>-g32rlu`, which this function reproduces.
 * The one rule: `slugForPath` (session/session-discovery.ts) and every transcript path
 * claudish derives go through it.
 */
export function projectDirNameFor(cwd: string): string {
  const slug = cwd.replace(/[^A-Za-z0-9]/g, "-");
  if (slug.length <= PROJECT_DIR_SLUG_MAX) return slug;
  return `${slug.slice(0, PROJECT_DIR_SLUG_MAX)}-${Math.abs(claudeCodeStringHash(cwd)).toString(36)}`;
}
