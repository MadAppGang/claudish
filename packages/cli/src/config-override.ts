/**
 * Process-wide config-file override — the single authority behind
 * `--config <file>` / `CLAUDISH_CONFIG`.
 *
 * When set, `<file>` TOTALLY replaces BOTH the machine global
 * (`~/.claudish/config.json`) and the project (`./.claudish.json`) config for
 * the whole run, in EVERY config reader:
 *   - profile-config's `loadConfig()` (global) + `loadLocalConfig()` (→ null).
 *   - op-source's `hasOpSources()` sniff + `readConfigRaw()`.
 *   - onepassword-config's `readAllOnepasswordEnvironments` /
 *     `listOnepasswordImports` / `readOnepasswordAccount`, via the
 *     override-aware `defaultOpConfigPaths`.
 *
 * WHY THIS IS FUNDAMENTAL — NOT A "disable 1Password" HACK. The override does
 * not SUPPRESS 1Password; it makes the override file the ONLY config. A test/QA
 * file that names no `op://` source means `hasOpSources()` returns false on its
 * own, so the lazy 1Password gate never opens and the SDK is never touched — no
 * auth prompt. Conversely, if a user DID put an `op://` ref in the override
 * file, it would resolve normally (on demand), because the mechanism is faithful
 * substitution, not selective disabling. This is the same on-demand model that
 * already lets `--version`/`help`/`update` run without a 1Password prompt.
 *
 * Zero-dependency ON PURPOSE: profile-config, op-source, onepassword-config, and
 * index all import this without any risk of an import cycle — it depends on
 * nothing but its own module-level state.
 */

/**
 * A global/project config-path pair. Structurally identical to
 * onepassword-config's `OpConfigPaths` (kept local here so this module stays
 * dependency-free); the two are mutually assignable.
 */
export interface ConfigPathPair {
  global: () => string;
  project: () => string;
}

/**
 * The project path used when an override is active: a path that never exists,
 * so `existsSync()` is false (no project overlay under an override) and any
 * accidental write fails loudly instead of landing in a junk file. Empty string
 * is portable — Node/Bun `existsSync("")` is false on every platform, and
 * `writeFileSync("")` throws ENOENT.
 */
const SUPPRESSED_PROJECT_CONFIG = "";

let overridePath: string | null = null;

/** Set (absolute path) or clear (null) the per-run config-file override. */
export function setConfigFileOverride(path: string | null): void {
  overridePath = path;
}

/** The raw override path, or null when no `--config`/`CLAUDISH_CONFIG` is active. */
export function getConfigFileOverride(): string | null {
  return overridePath;
}

/** The global config file to read: the override when set, else `realGlobal`. */
export function activeGlobalConfigFile(realGlobal: string): string {
  return overridePath ?? realGlobal;
}

/**
 * Wrap a real global/project path pair so both scopes honor an active override:
 * global → the override file; project → suppressed (no overlay). With no
 * override active, `defaults` is returned unchanged, so behavior is byte-for-
 * byte identical to before for every normal run.
 */
export function activeOpConfigPaths(defaults: ConfigPathPair): ConfigPathPair {
  if (overridePath === null) return defaults;
  const file = overridePath;
  return {
    global: () => file,
    project: () => SUPPRESSED_PROJECT_CONFIG,
  };
}

// ---------------------------------------------------------------------------
// Flag planning — the pure decision half of `--config`
// ---------------------------------------------------------------------------

/**
 * What a `--config`/`CLAUDISH_CONFIG` scan decided. Returning a plan instead of
 * mutating global state (and calling `process.exit`) is what makes the flag
 * logic testable: index.ts keeps the effects, this module keeps the decision.
 */
export type ConfigOverridePlan =
  | { kind: "none" }
  | { kind: "error"; message: string }
  | {
      kind: "apply";
      /** Absolute path to the override file. */
      path: string;
      /** argv with the flag (and its value) removed — the child never sees it. */
      argv: string[];
      /** True when it came from the flag, false when from CLAUDISH_CONFIG. */
      fromFlag: boolean;
    };

/**
 * Filesystem/path seams. Passed in rather than imported so this module keeps its
 * zero-dependency property (see the file header) — importing `node:fs` here
 * would put an fs edge under profile-config, op-source, and onepassword-config.
 */
export interface ConfigOverrideDeps {
  resolve: (p: string) => string;
  exists: (p: string) => boolean;
}

/**
 * Decide the override for a run. Precedence: an explicit `--config` flag wins;
 * otherwise `CLAUDISH_CONFIG` (which is how spawned team/MCP session child claudish
 * processes inherit the parent's override).
 *
 * Both `--config <file>` and `--config=<file>` are accepted. A flag with no
 * usable value is an ERROR, not a silent fallback to the env var — a dangling
 * `--config` must never leak through to parseArgs (or to the child `claude`).
 */
export function planConfigOverride(
  argv: string[],
  env: Record<string, string | undefined>,
  deps: ConfigOverrideDeps
): ConfigOverridePlan {
  const flag = scanConfigFlag(argv);
  let path: string | undefined;

  if (flag) {
    // A following token that is itself a flag is a missing value, not the path —
    // `claudish --config --debug` is a usage error, not a file named "--debug".
    if (!flag.value || flag.value.startsWith("-")) {
      return { kind: "error", message: "[claudish] --config requires a file path" };
    }
    path = flag.value;
  } else {
    path = env.CLAUDISH_CONFIG || undefined;
  }
  if (!path) return { kind: "none" };

  const resolved = deps.resolve(path);
  if (!deps.exists(resolved)) {
    return { kind: "error", message: `[claudish] --config file not found: ${resolved}` };
  }

  const rest = argv.slice();
  if (flag) rest.splice(flag.dropAt, flag.dropCount);
  return { kind: "apply", path: resolved, argv: rest, fromFlag: flag !== null };
}

/** Where `--config` sits in argv and how many tokens it occupies, or null if absent. */
function scanConfigFlag(
  argv: string[]
): { value: string | undefined; dropAt: number; dropCount: number } | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") {
      // A dangling `--config` at the end occupies 1 token, not 2.
      return { value: argv[i + 1], dropAt: i, dropCount: argv[i + 1] === undefined ? 1 : 2 };
    }
    if (a.startsWith("--config=")) {
      return { value: a.slice("--config=".length), dropAt: i, dropCount: 1 };
    }
  }
  return null;
}
