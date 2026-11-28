/**
 * The caller's plugin copies for a `create_session` child started outside setup_from's
 * repository, read from Claude Code itself.
 *
 * Claude Code picks a plugin's copy from its own launch directory, so a child in another
 * repository can load another version of a plugin the caller loads, or none. Rather than
 * re-implementing that choice, claudish starts Claude Code twice, quietly: once in the caller's
 * own launch directory with the caller's launch flags and `CLAUDE_CONFIG_DIR`, read from the
 * caller's process (the MCP host), and once in work_dir with the flags, settings layer and
 * environment the child gets. It reads the `plugins` of each `system`/`init` event: the exact
 * copies each would load. A caller copy the child would not load is handed over as
 * `--plugin-dir <path>`. Any doubt hands over nothing.
 *
 * The probes run only on a machine with no managed policy source at all, outside Windows and
 * WSL ({@link PluginProbeRefusal} `managed_policy_present`), and with no setting that runs a
 * helper at a `-p` boot where a probe would load it.
 * See ai-docs/architecture/mcp-sessions.md § The caller's plugin copies: `--plugin-dir`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import {
  type SettingSource,
  enabledSettingSources,
  findClaudeBinary,
  userSettingsFile,
} from "../claude-runner.js";
import { log } from "../logger.js";
import { claudePathIn } from "../pane/pane-launch.js";
import type { HostEnv, HostLaunchReader } from "./host-launch.js";
import {
  type ManagedPaths,
  launchSettingsFiles,
  launchSettingsFilesByTier,
  managedPolicySourcePresent,
  mergeSettingsLayers,
  readSettingsValue,
  realOrResolved,
  sharesMainCheckout,
  writePrivateJson,
} from "./inherited-settings.js";
import {
  CALLER_LAUNCH_ENV_KEYS,
  type CallerLaunchEnvKey,
  PROBE_COWORK_SWITCH,
  PROBE_MODE_VARS,
  PROBE_PLUGIN_VARS,
} from "./probe-launch-vars.js";

type SettingsLayer = Record<string, unknown>;

/** The {@link CALLER_LAUNCH_ENV_KEYS} values a caller probe is given. */
type CallerEnv = Partial<Record<CallerLaunchEnvKey, string>>;

/**
 * How long one probe may take, end to end: the binary lookup, the run to its exit, and the
 * wait for its process group to be gone. The quiet probe exits in about 1 s (0.25 s with the
 * network denied, 2.8 s when a plugin MCP server is started, which the quiet flags prevent),
 * so 10 s leaves a loaded machine ten times the measured time while bounding what a stuck
 * probe adds to `create_session`.
 */
export const PLUGIN_PROBE_TIMEOUT_MS = 10_000;

/**
 * The probe's `ANTHROPIC_BASE_URL`: port 9 on loopback, which nothing listens on (a port
 * below 1024 needs root). `/effort` makes no model request; were a later Claude Code to make
 * one, it would reach no one.
 */
export const PLUGIN_PROBE_BASE_URL = "http://127.0.0.1:9";

/** Stdout one probe may print; more is a failure, not a buffer. */
const PROBE_OUTPUT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The part of the deadline kept for the wait after a kill: a probe still running at
 * `deadline - PROBE_REAP_MS` is killed, so the wait for its group ends by the deadline.
 * A quarter of the deadline when that is shorter.
 */
const PROBE_REAP_MS = 2_000;

/** How often a killed probe's process group is checked for being gone. */
const GROUP_POLL_MS = 20;

/** One entry of the init event's `plugins`: a copy Claude Code loaded. */
export interface LoadedPlugin {
  name: string;
  /** The copy's absolute path; `builtin` for Claude Code's own plugins. */
  path: string;
  /** `<name>@<marketplace>`; `<name>@inline` for a `--plugin-dir` or `--plugin-url` copy. */
  source: string;
  version?: string;
}

/** Why a probe gave no plugin list. Each one hands over nothing. */
export type PluginProbeCause =
  | "no_claude_binary"
  | "spawn_failed"
  /** the probe exited, or its wrapper did, before an init event */
  | "exited_before_init"
  /** the deadline passed: the probe, or its binary lookup, was killed */
  | "timeout"
  | "plugins_malformed"
  | "assistant_before_init"
  | "output_too_large"
  /** the probe exited 0 after init with no `result` event */
  | "no_result"
  /**
   * a `result` event before init, a second one, or one that is not exactly
   * `subtype: "success"` with `is_error: false`
   */
  | "bad_result"
  /** the probe exited non-zero, or on a signal, after init */
  | "nonzero_exit"
  /** `/effort` became a turn: a model's assistant event, or a `result` with `num_turns` not 0 */
  | "turns"
  /** the MCP server shut down while the probe ran: it was killed */
  | "aborted";

export type PluginProbeResult =
  | { ok: true; plugins: LoadedPlugin[] }
  | { ok: false; cause: PluginProbeCause };

/** One probe: the cwd, argv and environment to start Claude Code with. */
export interface PluginProbeRequest {
  cwd: string;
  args: string[];
  env: Record<string, string>;
  /** The whole probe's deadline ({@link PLUGIN_PROBE_TIMEOUT_MS}). */
  timeoutMs: number;
  /** Aborted at server shutdown: the probe is killed and answers `aborted`. */
  signal?: AbortSignal;
}

/** Starts one probe and reads its plugin list; injected by tests. Never rejects on purpose. */
export type PluginProbeRunner = (request: PluginProbeRequest) => Promise<PluginProbeResult>;

/**
 * Finds the `claude` a probe starts, stopping when `signal` aborts; it answers only once
 * anything it started is gone ({@link findClaudeBinary}).
 */
export type BinaryLookup = (
  env: Record<string, string>,
  signal: AbortSignal
) => Promise<string | null>;

/** A caller plugin copy a child is handed with `--plugin-dir`. */
export interface InheritedPlugin {
  /** The copy's `source`, `<name>@<marketplace>`. */
  id: string;
  version: string | undefined;
  /** The caller's copy, absolute. Never written to `spawn.json`. */
  path: string;
}

/**
 * Why no probe was started, each handing over nothing:
 * - `plugin_url`: the child or the caller passes `--plugin-url`, which a probe never
 *   downloads, so a marketplace copy the url plugin shadows would look loaded
 * - `managed_policy_present`: a managed policy source exists in any form, readable or not
 *   ({@link managedPolicySourcePresent}), the child or the caller passes `--managed-settings`,
 *   or the machine is Windows or WSL, whose policy claudish does not read. A managed policy can
 *   run hooks, set an `env` that outranks the probe's own, or pin a login, so no probe runs
 *   beside one
 * - `await_initialize`: the child or the caller is launched with `--await-initialize`,
 *   `--initialize-fields` or `--managed-settings-in-initialize`, under which Claude Code reads
 *   settings, plugins, MCP servers or managed settings from its stdin, where no probe sees them
 * - `caller_argv_unreadable`: the caller's process (the MCP host) has no launch argv claudish
 *   can read exactly, or is not a Claude Code launch whose flags its argv holds
 * - `caller_env_unreadable`: the environment the caller's process was started with cannot be
 *   read exactly, so its `CLAUDE_CONFIG_DIR` (which decides its install rows and user
 *   settings), its plugin variables and its launch mode switches are unknown
 * - `caller_mode_unmodelled`: the caller runs in safe mode (`--safe-mode`, or
 *   `CLAUDE_CODE_SAFE_MODE` true in its effective environment: its launch environment with its
 *   settings `env` blocks over it, {@link callerEffectiveEnv}) or bare mode (`--bare`, or
 *   `CLAUDE_CODE_SIMPLE`). Claude Code 2.1.332 keeps the init `plugins` list in both, but runs
 *   none of those plugins' commands or skills, so a copy handed over would give the child what
 *   the caller does not run ({@link callerModeRefusal}). Also: the caller or the child selects
 *   cowork plugins mode ({@link PROBE_COWORK_SWITCH} on, or `--cowork`), whose plugin folder and
 *   user settings file claudish does not model, or a caller settings `env` block moves
 *   `CLAUDE_CONFIG_DIR`
 * - `caller_settings_unreadable`: the caller's own `--settings`, or a user, project or local
 *   settings file whose `env` block the caller applies, cannot be read or parsed
 * - `setup_from_not_caller`: setup_from and the caller's launch directory do not share a main
 *   checkout (outside Git: are not the same folder), so setup_from's settings were not what the
 *   caller started under
 * - `work_dir_command_setting`: work_dir's project or local settings (or those of the child's
 *   `--project-config-root`) define a setting whose value is a command (`apiKeyHelper`,
 *   `statusLine`, ...), or cannot be parsed; the work_dir probe would load them without the
 *   trust dialog the child stops at
 * - `user_command_setting`: the user settings a probe loads define a helper a `-p` boot can run
 *   before any model turn ({@link USER_STARTUP_HELPERS}), or cannot be parsed
 * - `caller_command_setting`: the project or local settings of the caller's launch directory (or
 *   of the caller's `--project-config-root`) define such a helper, or cannot be parsed. The
 *   caller trusted that directory, so Claude Code would run a helper there at the probe's boot
 */
export type PluginProbeRefusal =
  | "plugin_url"
  | "managed_policy_present"
  | "await_initialize"
  | "caller_argv_unreadable"
  | "caller_env_unreadable"
  | "caller_mode_unmodelled"
  | "caller_settings_unreadable"
  | "setup_from_not_caller"
  | "work_dir_command_setting"
  | "user_command_setting"
  | "caller_command_setting";

/** `spawn.json`'s `pluginProbe`: `ok`, the cause a probe failed with, or why none started. */
export type PluginProbeOutcome = "ok" | PluginProbeCause | PluginProbeRefusal;

export interface PluginHandover {
  plugins: InheritedPlugin[];
  outcome: PluginProbeOutcome;
}

/**
 * The probe's own flags. `-p /effort` (no argument) prints the init event and answers locally
 * with its usage line (no model request, no setting written, no credential needed). The boot
 * itself still starts the claude.ai connector fetch, to Anthropic's own host; the probe holds
 * no login to sign it with, since the host-managed marker keeps the stored sign-ins off limits
 * and every credential and handoff variable is withheld, and the server-managed settings fetch
 * is never eligible in a probe ({@link PROBE_HOST_MANAGED_MARKER}). Claude Code emits init only
 * after the prompt is processed, so the prompt must do no work: `/cost`, an alias of `/usage`, fetches plan usage and scans 7 days of transcripts on a
 * Claude subscription login and took 8 to 9 s. `disableAllHooks` (in the settings file) keeps
 * plugin `SessionStart` hooks from running; `--strict-mcp-config` keeps plugin MCP servers from
 * starting; `--no-session-persistence` writes no transcript.
 */
const QUIET_FLAGS = [
  "--output-format",
  "stream-json",
  "--verbose",
  "--settings",
  "<settings file>",
  "--strict-mcp-config",
  "--no-session-persistence",
];

/**
 * Launch flags that change which plugins load, each taking one path. `--project-config-root`
 * (hidden in 2.1.332's help) moves the project settings Claude Code reads, and with them
 * `enabledPlugins`. `--plugin-url` and `--managed-settings` are not forwarded: a launch passing
 * one starts no probe.
 */
const PLUGIN_PATH_FLAGS = ["--plugin-dir", "--plugin-dir-no-mcp", "--project-config-root"];

/**
 * The flags under which Claude Code 2.1.332 reads its first stdin line as an `initialize`
 * request that can carry inline plugins, MCP servers, settings (`--initialize-fields=settings`)
 * and managed settings (`--managed-settings-in-initialize`); each of the last two needs
 * `--await-initialize`, and Claude Code treats any of the three as that mode (`ye()`).
 */
const INITIALIZE_FLAGS = [
  "--await-initialize",
  "--initialize-fields",
  "--managed-settings-in-initialize",
];

/** Launch flags that change which plugins load, each taking one value that is not a path. */
const PLUGIN_VALUE_FLAGS = ["--setting-sources"];

/**
 * Launch flags that change which plugins load, taking no value. Each only takes away what a
 * launch loads or runs (Claude Code 2.1.332's help: `--safe-mode` disables installed plugins,
 * hooks and MCP servers; `--bare` skips hooks and plugin sync; `--restricted` ignores the user,
 * project and local settings files), so a probe given one runs less, never more.
 */
const PLUGIN_BOOLEAN_FLAGS = ["--safe-mode", "--bare", "--restricted"];

/** Whether `flags` pass `flag`, in either spelling. */
function passes(flags: readonly string[], flag: string): boolean {
  return flags.some((t) => t === flag || t.startsWith(`${flag}=`));
}

/**
 * Whether `flags` hold `flag` exactly, before any `--`, as Claude Code 2.1.332 reads a mode
 * flag (`kZt`, `Zv`): after `--` it is a prompt word, not the flag.
 */
function passesBeforeEnd(flags: readonly string[], flag: string): boolean {
  const at = flags.indexOf(flag);
  const end = flags.indexOf("--");
  return at !== -1 && (end === -1 || at < end);
}

/**
 * The flags of a launch that change which plugins load, in their order, each as `--flag value`
 * (both spellings read). A relative path ({@link PLUGIN_PATH_FLAGS}) is resolved against
 * `base`, the directory the launch resolves it against: the caller's own cwd for the caller
 * probe, and work_dir for the child probe.
 */
function pluginLoadingFlags(flags: readonly string[], base: string): string[] {
  const out: string[] = [];
  const push = (flag: string, value: string) =>
    out.push(flag, PLUGIN_PATH_FLAGS.includes(flag) ? resolve(base, value) : value);
  const takesValue = (flag: string) =>
    PLUGIN_PATH_FLAGS.includes(flag) || PLUGIN_VALUE_FLAGS.includes(flag);
  for (let i = 0; i < flags.length; i++) {
    const token = flags[i] as string;
    if (PLUGIN_BOOLEAN_FLAGS.includes(token)) {
      out.push(token);
      continue;
    }
    if (takesValue(token)) {
      const value = flags[i + 1];
      if (value !== undefined) push(token, value);
      i++;
      continue;
    }
    const eq = token.indexOf("=");
    const flag = eq > 0 ? token.slice(0, eq) : "";
    if (takesValue(flag)) push(flag, token.slice(eq + 1));
  }
  return out;
}

/**
 * One probe's argv: {@link QUIET_FLAGS} with `settingsFile`, the launch's plugin-loading flags
 * with relative paths resolved against `base`, then `-p /effort` last, so no variadic flag can
 * take the prompt as its value.
 */
export function pluginProbeArgs(
  settingsFile: string,
  launchFlags: readonly string[],
  base: string
): string[] {
  const quiet = QUIET_FLAGS.map((flag) => (flag === "<settings file>" ? settingsFile : flag));
  return [...quiet, ...pluginLoadingFlags(launchFlags, base), "-p", "/effort"];
}

/**
 * Claude Code 2.1.332's provider switches (its `IR` list): each sends model requests to
 * another provider's endpoint with that provider's own credentials. `CLAUDE_CODE_USE_` is not a
 * prefix rule: `CLAUDE_CODE_USE_COWORK_PLUGINS` changes which plugins load, and a launch that
 * sets it gets no probe.
 * The boot canary compares this list with the binary's `CLAUDE_CODE_USE_*` names.
 */
export const PROBE_PROVIDER_SWITCHES = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
];

/** The provider endpoints' own base URLs in Claude Code 2.1.332. */
const PROVIDER_BASE_URLS = [
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
];

/**
 * Claude Code 2.1.332's environment switches that start a settings helper at boot, with no
 * model turn: `CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER` runs `proxyAuthHelper` (`G2o`/`OLt`), and
 * `CLAUDE_CODE_ENABLE_TELEMETRY` builds the OTLP exporter, which prefetches `otelHeadersHelper`
 * (`prefetchOtelHeadersFromHelper`). The other helpers wait for a provider switch the probe
 * withholds already (`awsAuthRefresh`, `awsCredentialExport`: Bedrock and AWS; `gcpAuthRefresh`:
 * Vertex and Google Cloud). The boot canary runs a user `proxyAuthHelper` and `otelHeadersHelper`
 * with both switches in the server environment and turns red on either marker.
 */
export const PROBE_STARTUP_HELPER_SWITCHES = [
  "CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER",
  "CLAUDE_CODE_ENABLE_TELEMETRY",
];

/**
 * The switches that make Claude Code 2.1.332 treat a base URL other than Anthropic's as its own
 * API, and so make the remote managed settings eligible beside the probe's closed base URL:
 * `ha(){if(K9())return!0;return cd()}` with
 * `K9(){return s._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL??Vn().clientDataUrl.assumesFirstPartyBaseUrl}`,
 * the second set only from a document `CLAUDE_CODE_CLIENT_DATA_URL` names
 * (`assume_first_party_base_url`).
 */
const PROBE_FIRST_PARTY_SWITCHES = [
  "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
  "CLAUDE_CODE_CLIENT_DATA_URL",
];

/**
 * The marker every probe boots with, `1`. Claude Code 2.1.332 reads its stored sign-ins only
 * when it is unset: `T4e(){return Pc()||xd()||TH()}` with
 * `Pc(){return s.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST||uH()}` keeps the credential store off
 * limits (`if(T4e()){r.storeOffLimits=!0;return}`, before the stored `enterpriseGateway`
 * sign-in is restored), and `getHybridSettingsOrganization` (`Kra`) returns null under it, so
 * no stored `hybridOauth` organization sign-in applies. Those two are the only ways the remote
 * managed settings stay eligible beside the closed base URL: eligibility answers
 * `custom_base_url` for a first-party launch whose `ANTHROPIC_BASE_URL` is not Anthropic's
 * (`e=be()!=="firstParty"?"third_party_provider":!ha()?"custom_base_url":void 0;if(e)return
 * C(!1)??{eligible:!1,ineligibleReason:e}`, `C` being the hybrid sign-in). So a probe fetches no
 * remote policy at boot, and no policy `SessionStart` hook can arrive that way, even though a
 * managed hook runs under a non-managed `disableAllHooks` ("Hooks configured in managed settings
 * (they run even under a non-managed disableAllHooks)"). With the store off limits a probe also
 * reads no stored Claude subscription login: the boot canary's `/cost` boot under this marker
 * does not answer with the subscription line. Measured on 2.1.332: the probe's plugin list and
 * result are the same with and without the marker.
 */
export const PROBE_HOST_MANAGED_MARKER = "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST";

/**
 * The credential handoffs Claude Code 2.1.332 reads beside the host-managed marker, which the
 * probe sets itself. Under the marker its init runs `REr()` before the managed settings load:
 * `if(!s.CLAUDE_CODE_HOST_CREDS_FILE||!He(s.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST))return;let
 * e=await h();`, where `h()` reads the file `CLAUDE_CODE_HOST_CREDS_FILE` names (a regular file
 * or a pipe, mode 0600, naming a live pid) and writes its `env` into `process.env`, the bearer
 * `ANTHROPIC_AUTH_TOKEN` included, after the probe withheld it. The bearer's name is
 * `Cpn(){return s.CLAUDE_CODE_HOST_AUTH_ENV_VAR||"ANTHROPIC_AUTH_TOKEN"}`, so
 * `CLAUDE_CODE_HOST_AUTH_ENV_VAR` can point it at any variable the parent holds;
 * `CLAUDE_CODE_HOST_AUTH_ASK_AT_START` lets the file's endpoints win over blank launch values
 * (`n=s.CLAUDE_CODE_HOST_AUTH_ASK_AT_START?a??"":a||void 0`). A host token refresh is wired by
 * `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH` and timed by `CLAUDE_CODE_HOST_AUTH_REFRESH_TIMEOUT_MS`,
 * and `mo()` takes `token:s.CLAUDE_CODE_LAUNCHER_RUNS_API_KEY_HELPER&&!s.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH&&s.ANTHROPIC_AUTH_TOKEN`.
 * The boot reads a credential from a descriptor when one is named
 * (`if(s.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR||s.CLAUDE_BG_AUTH_SNAPSHOT_PATH&&...)BP();if(s.CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR)sXt();if(s.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR)W4();if(s.CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR)Vu()`),
 * and `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `CLAUDE_CODE_SESSION_ACCESS_TOKEN` and
 * `CLAUDE_SESSION_INGRESS_TOKEN_FILE` hand over a sign-in or a session token. The boot canary
 * arms a creds file holding a placeholder token and turns red when a production boot reads it.
 */
const PROBE_HOST_HANDOFF_VARS = [
  "CLAUDE_CODE_HOST_CREDS_FILE",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
  "CLAUDE_CODE_HOST_AUTH_ASK_AT_START",
  "CLAUDE_CODE_HOST_AUTH_REFRESH_TIMEOUT_MS",
  "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
  "CLAUDE_CODE_LAUNCHER_RUNS_API_KEY_HELPER",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
  "CLAUDE_BG_AUTH_SNAPSHOT_PATH",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
];

/** The handoff variable a canary creds file is named by: {@link PROBE_HOST_HANDOFF_VARS}' first. */
export const PROBE_HOST_CREDS_FILE_VAR = "CLAUDE_CODE_HOST_CREDS_FILE";

/**
 * Credentials, credential handoffs, provider switches, provider base URLs, startup helper
 * switches and first-party base URL switches the probe's settings `env` block sets empty
 * ({@link PROBE_SETTINGS_ENV}), so that a user, project or local settings layer cannot restore
 * one: the probe needs no login, with them a request could leave the closed base URL for another
 * endpoint or carry a handed-over token, a helper would run a command for a probe that needs
 * none, and the remote managed settings could become eligible. The host-managed marker is listed
 * too: the block sets its own value. The spawn environment needs no such list: it is built from
 * an allowlist ({@link pluginProbeEnv}).
 */
const PROBE_SETTINGS_EMPTY_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  ...PROBE_HOST_HANDOFF_VARS,
  ...PROBE_PROVIDER_SWITCHES,
  ...PROVIDER_BASE_URLS,
  ...PROBE_STARTUP_HELPER_SWITCHES,
  ...PROBE_FIRST_PARTY_SWITCHES,
  PROBE_HOST_MANAGED_MARKER,
];

/**
 * Every variable the probe takes from its parent; nothing else is copied. The process basics
 * (`PATH`, `HOME`, user, shell, temp folder, locale, terminal, the XDG folders), `CLAUDE_PATH`
 * (read by the binary lookup), and the `CLAUDE_CONFIG_DIR`, {@link PROBE_PLUGIN_VARS} and
 * {@link PROBE_MODE_VARS} of the launch the probe stands for (the caller's own for the caller
 * probe, {@link callerEnvOf}). Locale variables pass by the `LC_` prefix.
 */
const PROBE_PARENT_VARS: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "TERM",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PATH",
  ...PROBE_PLUGIN_VARS,
  ...PROBE_MODE_VARS,
];

/** Whether the probe takes `key` from its parent: {@link PROBE_PARENT_VARS} or a locale `LC_*`. */
function isProbeParentVar(key: string): boolean {
  return PROBE_PARENT_VARS.includes(key) || /^LC_[A-Z]+$/.test(key);
}

/**
 * The probe's environment, built from scratch: the {@link isProbeParentVar} names the parent
 * holds, then the probe's own values: `ANTHROPIC_BASE_URL` {@link PLUGIN_PROBE_BASE_URL},
 * {@link PROBE_HOST_MANAGED_MARKER} `1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` `1`. No
 * credential, handoff, socket, provider switch or helper switch reaches it, named here or not.
 */
export function pluginProbeEnv(
  parentEnv: Record<string, string | undefined>
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value !== undefined && isProbeParentVar(key)) env[key] = value;
  }
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env[PROBE_HOST_MANAGED_MARKER] = "1";
  env.ANTHROPIC_BASE_URL = PLUGIN_PROBE_BASE_URL;
  return env;
}

function isPlainObject(value: unknown): value is SettingsLayer {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The probe's settings-file `env` block: the closed base URL, every
 * {@link PROBE_SETTINGS_EMPTY_VARS} empty, and {@link PROBE_HOST_MANAGED_MARKER} `1`. Claude Code applies settings `env` blocks in source order
 * user, project, local, flag, policy, a later one winning, so this `--settings` block outranks
 * a user, project or local `env` that would restore a key or a gateway (measured on 2.1.332:
 * a flag `env` base URL and key beat user ones, and an empty key reads as no login; the boot
 * canary pins it with a user `env` naming a listener). Only a managed `env` outranks it, and
 * no probe runs beside any managed policy source.
 */
const PROBE_SETTINGS_ENV: Record<string, string> = {
  ANTHROPIC_BASE_URL: PLUGIN_PROBE_BASE_URL,
  ...Object.fromEntries(PROBE_SETTINGS_EMPTY_VARS.map((key) => [key, ""])),
  [PROBE_HOST_MANAGED_MARKER]: "1",
};

/**
 * The settings whose value is a command Claude Code runs, as Claude Code 2.1.332 lists them
 * (`Nrd`). The work_dir is not trusted, and `-p` skips the trust dialog the pane child would
 * stop at, so a probe there could run one that the child never would. The boot canary compares
 * this list with the binary's own.
 */
export const COMMAND_SETTINGS = [
  "apiKeyHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "fileSuggestion",
  "gcpAuthRefresh",
  "otelHeadersHelper",
  "processWrapper",
  "policyHelpers",
  "proxyAuthHelper",
  "statusLine",
  "subagentStatusLine",
];

/**
 * One probe's `--settings` content: `layer` (the caller's own `--settings` for the caller
 * probe, the inherited settings layer for the work_dir probe; null for none) without its
 * `hooks` and every {@link COMMAND_SETTINGS} key, neither of which changes which plugins load,
 * with `disableAllHooks: true` and {@link PROBE_SETTINGS_ENV} over it. A layer `env` key equal
 * to one of those in any case is dropped: Claude Code reads `env` keys case-insensitively.
 */
export function pluginProbeSettings(layer: SettingsLayer | null): SettingsLayer {
  const base: SettingsLayer = structuredClone(layer ?? {});
  for (const key of ["hooks", ...COMMAND_SETTINGS]) delete base[key];
  if (isPlainObject(base.env)) {
    const closed = new Set(Object.keys(PROBE_SETTINGS_ENV));
    base.env = Object.fromEntries(
      Object.entries(base.env).filter(([key]) => !closed.has(key.toUpperCase()))
    );
  } else {
    delete base.env;
  }
  return mergeSettingsLayers(base, { disableAllHooks: true, env: { ...PROBE_SETTINGS_ENV } });
}

/**
 * The user-level settings a `-p` boot of Claude Code 2.1.332 can run before any model turn,
 * whatever the probe's environment: the credential and header helpers (the bundle lists exactly
 * these six together: `va=["apiKeyHelper","proxyAuthHelper","awsCredentialExport",
 * "awsAuthRefresh","gcpAuthRefresh","otelHeadersHelper"]`), and `policyHelpers`, a managed key
 * that costs nothing to refuse beside. User settings are trusted, so no trust dialog stops them.
 * The other {@link COMMAND_SETTINGS} do not run under `-p`: `statusLine` and `fileSuggestion`
 * run only from the interactive status line and `@` file suggester (`jbs`, `bLi`, each with one
 * caller in the interface), `subagentStatusLine` only from the interface's task rows, and
 * `processWrapper` is the "Corporate launcher argv prefix for the background-agent supervisor",
 * which a `-p` boot does not start. The boot canary's user settings set those four to markers.
 */
export const USER_STARTUP_HELPERS = [
  "apiKeyHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "gcpAuthRefresh",
  "otelHeadersHelper",
  "policyHelpers",
  "proxyAuthHelper",
];

/**
 * The text of the settings file at `path`: null when nothing is there, `unreadable` when it
 * cannot be opened or read, or is not a regular file. It is opened without blocking and checked
 * on the open descriptor, then read from it, so a named pipe put in its place, even between
 * the check and the read, never blocks the server.
 */
function readRegularFile(path: string): string | null | "unreadable" {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? null : "unreadable";
  }
  try {
    if (!fstatSync(fd).isFile()) return "unreadable";
    return readFileSync(fd, "utf-8");
  } catch {
    return "unreadable";
  } finally {
    closeSync(fd);
  }
}

/**
 * The first of `paths` that defines a `keys` entry, with the key, or that cannot be read or
 * parsed or is not a regular file (`key` undefined, {@link readRegularFile}); else undefined.
 * A missing file defines nothing.
 */
function commandSettingIn(
  paths: readonly string[],
  keys: readonly string[]
): { path: string; key?: string } | undefined {
  for (const path of paths) {
    const text = readRegularFile(path);
    if (text === null) continue;
    if (text === "unreadable") return { path };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { path };
    }
    if (!isPlainObject(parsed)) return { path };
    const key = keys.find((k) => parsed[k] !== undefined && parsed[k] !== null);
    if (key !== undefined) return { path, key };
  }
  return undefined;
}

/**
 * An init event's `plugins`, or null when the field is missing, not a list, or holds an entry
 * without string `name`, `path` and `source` or with a `version` that is not a string.
 */
export function initPluginsOf(event: unknown): LoadedPlugin[] | null {
  const list = isPlainObject(event) ? event.plugins : undefined;
  if (!Array.isArray(list)) return null;
  const plugins: LoadedPlugin[] = [];
  for (const item of list) {
    if (!isPlainObject(item)) return null;
    const { name, path, source, version } = item;
    if (typeof name !== "string" || typeof path !== "string" || typeof source !== "string") {
      return null;
    }
    if (version !== undefined && typeof version !== "string") return null;
    plugins.push({ name, path, source, ...(version !== undefined ? { version } : {}) });
  }
  return plugins;
}

/**
 * Whether `<path>/.claude-plugin/plugin.json` is a regular file whose `name` is `name`. A
 * `--plugin-dir` copy is named by that manifest, else by its folder name (Claude Code's `Vdt`:
 * the basename without `.zip`), so a cache folder such as `.../alpha/2.0.0` with no manifest
 * would load as `2.0.0@inline` beside the child's own `alpha`.
 */
function manifestNames(path: string, name: string): boolean {
  const manifest = join(path, ".claude-plugin", "plugin.json");
  try {
    // only a regular file is read: a read of a named pipe with no writer blocks the server
    if (!statSync(manifest).isFile()) return false;
    const parsed: unknown = JSON.parse(readFileSync(manifest, "utf-8"));
    return isPlainObject(parsed) && parsed.name === name;
  } catch {
    return false;
  }
}

/**
 * The caller copies a child is handed, in the caller's order: every caller entry with an
 * absolute path whose `source` is not `<name>@inline` (a launch flag's copy, not an install
 * row's) and that the child loads at another path or not at all. A plugin the child loads from
 * its own launch flag (an `@inline` entry of the same `name`) is left out: that copy is the
 * child's own choice, and a second `--plugin-dir` copy of one name loads beside it. A copy whose
 * manifest does not name it ({@link manifestNames}) is left out with a log line naming its id.
 * One path is handed over once.
 */
export function pluginsToHandOver(
  caller: readonly LoadedPlugin[],
  child: readonly LoadedPlugin[]
): InheritedPlugin[] {
  const childPaths = new Map(child.map((p) => [p.source, p.path]));
  const childInline = new Set(child.filter((p) => p.source.endsWith("@inline")).map((p) => p.name));
  const seen = new Set<string>();
  const plugins: InheritedPlugin[] = [];
  for (const p of caller) {
    if (p.source.endsWith("@inline") || !isAbsolute(p.path)) continue;
    if (childPaths.get(p.source) === p.path || seen.has(p.path)) continue;
    if (childInline.has(p.name)) {
      log(
        `[mcp-session] plugin ${p.source} not handed over: the child loads ${p.name} from its own --plugin-dir`
      );
      continue;
    }
    if (!manifestNames(p.path, p.name)) {
      log(
        `[mcp-session] plugin ${p.source} not handed over: its copy has no .claude-plugin/plugin.json naming it ${p.name}`
      );
      continue;
    }
    seen.add(p.path);
    plugins.push({ id: p.source, version: p.version, path: p.path });
  }
  return plugins;
}

/**
 * `plugins` without every id the child's settings layer turns off: an `enabledPlugins` entry
 * for that id whose value is anything but `true`. A `--plugin-dir` copy loads as
 * `<name>@inline`, which that entry does not match, so a hand-over would bring the plugin back.
 * Each dropped id gets a log line.
 */
function withoutLayerDisabled(
  plugins: InheritedPlugin[],
  layer: SettingsLayer | null
): InheritedPlugin[] {
  const enabled = isPlainObject(layer?.enabledPlugins) ? layer.enabledPlugins : {};
  return plugins.filter((p) => {
    if (!Object.hasOwn(enabled, p.id) || enabled[p.id] === true) return true;
    log(`[mcp-session] plugin ${p.id} not handed over: the child's settings turn it off`);
    return false;
  });
}

/** What one stdout event of a probe adds. */
type ProbeEvent =
  | { kind: "init"; plugins: LoadedPlugin[] }
  | { kind: "result"; success: boolean; turns: unknown }
  | { kind: "fail"; cause: PluginProbeCause }
  | null;

/**
 * What one stdout line of a probe says, given whether init was already seen: an init event's
 * plugins (or `plugins_malformed`), a `result` event (a success only for exactly
 * `subtype: "success"` and `is_error: false`, as `/effort` answers; anything else, a missing
 * field included, is not one), a failure for an `assistant` event before init or a model's
 * `assistant` event after it (`/effort` answers with a `<synthetic>` one), or null (any other
 * line, JSON or not).
 */
function probeLineEvent(line: string, afterInit: boolean): ProbeEvent {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isPlainObject(event)) return null;
  if (event.type === "assistant") {
    if (!afterInit) return { kind: "fail", cause: "assistant_before_init" };
    const model = isPlainObject(event.message) ? event.message.model : undefined;
    return model === "<synthetic>" ? null : { kind: "fail", cause: "turns" };
  }
  if (event.type === "result") {
    const success = event.subtype === "success" && event.is_error === false;
    return { kind: "result", success, turns: event.num_turns };
  }
  if (event.type !== "system" || event.subtype !== "init" || afterInit) return null;
  const plugins = initPluginsOf(event);
  return plugins ? { kind: "init", plugins } : { kind: "fail", cause: "plugins_malformed" };
}

/** Whether any process of the group `pgid` still exists. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Kills a probe's whole process group, else the probe alone. */
function killProbe(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

/**
 * The binary `findBinary` answers, or `timeout` once `stopMs` pass, or `aborted` when `signal`
 * aborts first. Either stop aborts the lookup's own signal, and the answer waits for the
 * lookup to settle, so nothing it started outlives it; but never past `hardMs`, the probe's
 * deadline: a lookup shell that `SIGKILL` cannot reap (a hung mount) would otherwise hold
 * `create_session` and the shutdown that waits for it. A lookup that outlives the deadline is
 * logged and left behind.
 */
async function lookupBinary(
  findBinary: BinaryLookup,
  env: Record<string, string>,
  stopMs: number,
  hardMs: number,
  signal: AbortSignal | undefined
): Promise<string | null | "timeout" | "aborted"> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), Math.max(0, stopMs));
  const onAbort = () => stop.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  const outlived = new Promise<"outlived">((settle) => {
    hardTimer = setTimeout(() => settle("outlived"), Math.max(0, hardMs));
  });
  let binary: string | null | "outlived";
  try {
    const found = Promise.resolve()
      .then(() => findBinary(env, stop.signal))
      .catch(() => null);
    binary = await Promise.race([found, outlived]);
  } finally {
    clearTimeout(timer);
    clearTimeout(hardTimer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (binary === "outlived") {
    stop.abort();
    log(
      "[mcp-session] the plugin probe's binary lookup outlived the probe's deadline after it was stopped; the probe answers without it"
    );
  }
  if (signal?.aborted) return "aborted";
  if (stop.signal.aborted) return "timeout";
  return binary === "outlived" ? "timeout" : binary;
}

/**
 * A probe runner over `findBinary`. It starts the `claude` the child would start (`CLAUDE_PATH`
 * first) in `request.cwd`, stdin `/dev/null`, in its own process group, and reads stdout to the
 * probe's exit. The plugin list counts only for init first, then exactly one `result` event
 * with `subtype: "success"`, `is_error: false` and `num_turns: 0`, then exit 0. Otherwise it
 * fails closed with the first cause seen: an `assistant` event before init, a model's
 * `assistant` event after it (`turns`), a malformed `plugins` field, a `result` before init, a
 * second one or one that is not that success (`bad_result`), more than
 * {@link PROBE_OUTPUT_MAX_BYTES} of output, `request.signal` aborting (`aborted`), the deadline
 * (`timeout`), or at the exit `exited_before_init`, `nonzero_exit`, `no_result` or `turns`.
 *
 * The deadline is end to end: `request.timeoutMs` from the call, binary lookup included. The
 * lookup is stopped at the kill time or on abort and waited out, never past the deadline
 * ({@link lookupBinary}). A probe still running at the deadline less the reap time
 * ({@link PROBE_REAP_MS}, at most a quarter of the deadline) is killed. The process group is
 * killed on every way out, an early exit of a wrapper whose own child lives on included, and
 * the result returns once the group is gone, or at the deadline, whichever is first; stdout is
 * then let go, so a descendant outside the group that holds it keeps nothing waiting.
 *
 * The binary is started by an absolute path. An absolute `CLAUDE_PATH` or found path is used as
 * is (the spawn follows its symlinks). A relative one is read in `serverDir()` (this process's
 * directory, where the lookup checked it), never in `request.cwd`: `./bin/claude` would
 * otherwise name another file in the probe's cwd, which is the caller's or the child's
 * repository. It is accepted only with no empty, `.` or `..` segment past one leading `./` and
 * no trailing slash, then joined to `serverDir()` as text, which is exactly the path the kernel
 * walks, and it must name a file this process may execute (`claudePathIn`); any other relative
 * value starts no probe (`no_claude_binary`).
 */
export function pluginProbeRunner(
  findBinary: BinaryLookup,
  serverDir: () => string = () => process.cwd()
): PluginProbeRunner {
  return async (request) => {
    const { signal } = request;
    const deadline = Date.now() + request.timeoutMs;
    const killAt = deadline - Math.min(PROBE_REAP_MS, Math.floor(request.timeoutMs / 4));
    if (signal?.aborted) return { ok: false, cause: "aborted" };
    const base = serverDir();
    const named = request.env.CLAUDE_PATH;
    const claudePath = named ? startablePath(base, named) : undefined;
    if (claudePath === null) return { ok: false, cause: "no_claude_binary" };
    const env = claudePath ? { ...request.env, CLAUDE_PATH: claudePath } : request.env;
    const binary = await lookupBinary(
      findBinary,
      env,
      killAt - Date.now(),
      deadline - Date.now(),
      signal
    );
    if (binary === "timeout" || binary === "aborted") return { ok: false, cause: binary };
    const path = binary ? startablePath(base, binary) : null;
    if (path === null) return { ok: false, cause: "no_claude_binary" };
    return runProbe(path, request, deadline, killAt);
  };
}

/** `named` as is when absolute, else what {@link claudePathIn} makes of it in `base`. */
function startablePath(base: string, named: string): string | null {
  return isAbsolute(named) ? named : claudePathIn(base, named);
}

function runProbe(
  binary: string,
  request: PluginProbeRequest,
  deadline: number,
  killAt: number
): Promise<PluginProbeResult> {
  const { signal } = request;
  return new Promise<PluginProbeResult>((settle) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, request.args, {
        cwd: request.cwd,
        env: request.env,
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
      });
    } catch {
      settle({ ok: false, cause: "spawn_failed" });
      return;
    }
    const pgid = child.pid;
    let plugins: LoadedPlugin[] | null = null;
    let turns: { value: unknown } | null = null;
    let failure: PluginProbeCause | null = null;
    let exitCode: number | null = null;
    let exited = false;
    let stdoutDone = false;
    let pending = "";
    let bytes = 0;
    let settled = false;
    let poll: ReturnType<typeof setInterval> | undefined;

    const verdict = (): PluginProbeResult => {
      if (failure) return { ok: false, cause: failure };
      if (!plugins) return { ok: false, cause: "exited_before_init" };
      if (exitCode !== 0) return { ok: false, cause: "nonzero_exit" };
      if (!turns) return { ok: false, cause: "no_result" };
      if (turns.value !== 0) return { ok: false, cause: "turns" };
      return { ok: true, plugins };
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(deadlineTimer);
      clearInterval(poll);
      signal?.removeEventListener("abort", onAbort);
      // a descendant outside the group can hold stdout open past the deadline: let it go
      child.stdout?.destroy();
      settle(verdict());
    };
    // Settles once the probe has exited, its stdout is read, and its group is gone.
    const settleWhenGone = () => {
      if (settled || !exited || !stdoutDone) return;
      if (pgid === undefined || !groupAlive(pgid)) return finish();
      if (!poll) {
        poll = setInterval(() => {
          if (pgid === undefined || !groupAlive(pgid)) finish();
        }, GROUP_POLL_MS);
      }
    };
    const fail = (cause: PluginProbeCause) => {
      failure ??= cause;
      killProbe(child);
      // a probe that never exits still settles: its group was killed
      stdoutDone = true;
      settleWhenGone();
    };
    const readLine = (line: string) => {
      const event = probeLineEvent(line, plugins !== null);
      if (!event) return;
      if (event.kind === "fail") return fail(event.cause);
      if (event.kind === "init") {
        plugins = event.plugins;
        return;
      }
      // exactly one result, after init, and a success
      if (plugins === null || turns !== null || !event.success) return fail("bad_result");
      turns = { value: event.turns };
    };
    const onAbort = () => fail("aborted");
    const killTimer = setTimeout(() => fail("timeout"), Math.max(0, killAt - Date.now()));
    const deadlineTimer = setTimeout(
      () => {
        failure ??= "timeout";
        finish();
      },
      Math.max(0, deadline - Date.now())
    );
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (failure) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > PROBE_OUTPUT_MAX_BYTES) return fail("output_too_large");
      pending += chunk;
      for (let nl = pending.indexOf("\n"); nl >= 0 && !failure; nl = pending.indexOf("\n")) {
        readLine(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
      }
    });
    child.stdout?.on("close", () => {
      if (!failure && pending) readLine(pending);
      pending = "";
      stdoutDone = true;
      settleWhenGone();
    });
    child.on("error", () => {
      if (child.pid === undefined) {
        failure ??= "spawn_failed";
        exited = true;
        stdoutDone = true;
        finish();
      }
    });
    child.on("exit", (code) => {
      exitCode = code;
      exited = true;
      // a wrapper that exits leaves its own children in the group: they go too
      killProbe(child);
      settleWhenGone();
    });
  });
}

/** The production runner: the `claude` the child would start ({@link findClaudeBinary}). */
export const spawnPluginProbe: PluginProbeRunner = pluginProbeRunner(findClaudeBinary);

/** The policy platform of the machine: Windows and WSL get no probe. */
export type PolicyPlatform = "windows" | "wsl" | "other";

/**
 * `platform` as Claude Code 2.1.332 classes it for policy: `windows` on win32; `wsl` on Linux
 * with `WSL_DISTRO_NAME` or `WSL_INTEROP` set, or a lower-cased `/proc/version`
 * (`readProcVersion`) holding `microsoft` or `wsl`; else `other`.
 */
export function policyPlatformOf(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  readProcVersion: () => string
): PolicyPlatform {
  if (platform === "win32") return "windows";
  if (platform !== "linux") return "other";
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return "wsl";
  try {
    const version = readProcVersion().toLowerCase();
    return version.includes("microsoft") || version.includes("wsl") ? "wsl" : "other";
  } catch {
    return "other";
  }
}

/** {@link policyPlatformOf} for this process. */
export function hostPolicyPlatform(env: Record<string, string | undefined>): PolicyPlatform {
  return policyPlatformOf(process.platform, env, () => readFileSync("/proc/version", "utf-8"));
}

/**
 * Subcommands under which a Claude Code process holds no launch flags in its argv: a
 * pre-started spare (`bg-spare`) gets its session's flags over a socket when claimed.
 */
const FLAGLESS_SUBCOMMANDS = ["bg-spare", "bg-pty-host", "daemon"];

/** Whether `program` is a native Claude Code: `claude`, or a binary under `claude/versions/`. */
function isClaudeProgram(program: string): boolean {
  const name = basename(program);
  return (
    name === "claude" ||
    name === "claude.exe" ||
    /[/\\]claude[/\\]versions[/\\][^/\\]+$/.test(program)
  );
}

/**
 * The launch flags in a Claude Code process's argv: everything after a native `claude`, or
 * after `node`/`bun` and the npm package's `cli.js` (no runtime option before it). Null for any
 * other program, a runtime option, or a process whose argv holds no launch flags (a pre-started
 * spare, the daemon).
 */
export function callerLaunchFlags(argv: readonly string[]): string[] | null {
  const program = argv[0];
  if (program === undefined) return null;
  let flags: string[];
  if (isClaudeProgram(program)) {
    flags = argv.slice(1);
  } else if (/^(node|nodejs|bun)(\.exe)?$/.test(basename(program))) {
    const script = argv[1];
    if (!script || !/[/\\]@anthropic-ai[/\\]claude-code[/\\]cli\.m?js$/.test(script)) return null;
    flags = argv.slice(2);
  } else {
    return null;
  }
  if (FLAGLESS_SUBCOMMANDS.includes(flags[0] ?? "")) return null;
  if (flags.some((t) => t.startsWith("--bg-"))) return null;
  return flags;
}

/** What {@link inheritedPluginsFor} needs. */
export interface PluginHandoverInput {
  /** setup_from's real path; undefined without setup inheritance. */
  setupReal: string | undefined;
  childCwd: string;
  /** The inherited settings layer the child gets as `--settings`. */
  layer: SettingsLayer | null;
  /** The child's `claude_flags`, which the child probe gets too. */
  childFlags: readonly string[];
  /** The server's environment, from which the child's is built. */
  env: Record<string, string | undefined>;
  managed: Partial<ManagedPaths>;
  /** The caller's Claude Code process: the MCP host. */
  hostPid: number;
  /** Reads the host's argv, cwd and launch environment keys exactly (`readHostLaunch`). */
  readHostLaunch: HostLaunchReader;
  /** This machine's {@link PolicyPlatform} ({@link hostPolicyPlatform}). */
  policyPlatform: PolicyPlatform;
  /** Default {@link spawnPluginProbe}. */
  runner?: PluginProbeRunner;
  /** Default {@link PLUGIN_PROBE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Aborted at server shutdown: every probe is killed, and the settings files go. */
  signal?: AbortSignal;
  /** Where the probes' temp folders go and are swept ({@link sweepStaleProbeDirs}); `tmpdir()`. */
  probeTmpRoot?: string;
  /** Whether a pid is alive, for the sweep; default {@link pidAlive}. */
  pidAlive?: (pid: number) => boolean;
}

type Refusal = { outcome: PluginProbeRefusal; line: string };

/**
 * Whether Claude Code 2.1.332 reads `value` as on:
 * `He(e){if(!e)return!1;…let n=String(e).toLowerCase().trim();return["1","true","yes","on"].includes(n)}`.
 */
function claudeEnvTrue(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase().trim());
}

/**
 * The caller's launch modes the probe does not model: safe mode,
 * `ms(){return He(process.env.CLAUDE_CODE_SAFE_MODE)||kZt("--safe-mode")||!1}`, and bare mode,
 * `eo(){return He(process.env.CLAUDE_CODE_SIMPLE)||kZt("--bare")}` (`kZt` matches the exact
 * argument before any `--`). Measured on 2.1.332: under either, the init `plugins` list is the
 * same as without it, while the plugin command and skill loaders return nothing
 * (`if(Jo("plugins",{explicitlyRequested:…}))return[]`). The probe reads that list, so it would
 * hand the child copies whose commands and skills the caller never runs; a child given them by
 * `--plugin-dir` loads them (`explicitlyRequested`). Each switch is read from the caller's
 * effective environment ({@link callerEffectiveEnv}), so one set only in a settings `env` block
 * counts.
 *
 * Two switches act at launch only. 2.1.332 picks the setting sources (`qNs`) and the cowork
 * settings file inside `eagerLoadSettings`
 * (`sea(){…qNs(),v(),ds("eagerLoadSettings_end")…}`), before any settings `env` block is
 * applied. Restricted mode is modelled: it changes the list itself, and the probe gets the
 * caller's launch switch; a settings layer that reads it otherwise refuses, since the probe's
 * own boot could act on that value. Cowork plugins mode refuses when it is on at launch or in
 * any settings layer: a later `0` never clears a launch `1`.
 */
function callerModeRefusal(
  flags: readonly string[],
  effective: CallerEffectiveEnv
): Refusal | undefined {
  const beforeEnd = (flag: string) => passesBeforeEnd(flags, flag);
  const mode = (on: boolean, name: string) =>
    on
      ? {
          outcome: "caller_mode_unmodelled" as const,
          line: `the caller runs in ${name}, which keeps its plugin list but runs none of those plugins' commands or skills, so a copy handed over would give the child what the caller does not run`,
        }
      : undefined;
  if (effective.everOn(PROBE_COWORK_SWITCH) || beforeEnd("--cowork")) {
    return coworkRefusal("the caller's");
  }
  if (effective.movesConfigDir) {
    return {
      outcome: "caller_mode_unmodelled",
      line: "a settings env block of the caller sets CLAUDE_CONFIG_DIR, which moves the settings Claude Code reads after they were read, and claudish does not model that",
    };
  }
  if (effective.movesRestricted) {
    return {
      outcome: "caller_mode_unmodelled",
      line: "a settings env block of the caller sets CLAUDE_CODE_RESTRICTED other than its launch did, after the launch chose its setting sources, and a probe booted with that value could choose others",
    };
  }
  return (
    mode(effective.mayBeOn("CLAUDE_CODE_SAFE_MODE") || beforeEnd("--safe-mode"), "safe mode") ??
    mode(effective.mayBeOn("CLAUDE_CODE_SIMPLE") || beforeEnd("--bare"), "bare mode")
  );
}

/**
 * One settings `env` block a launch applies to its `process.env` before plugins load. Claude
 * Code 2.1.332 applies them in source order, a later one winning
 * (`ks=["userSettings","projectSettings","localSettings","flagSettings","policySettings"]`,
 * `Jr(){…let t=new Set(e);t.add("flagSettings"),t.add("policySettings");let o=ks.filter((i)=>t.has(i));…}`
 * and `for(let H of Jr()){let F=this.filterSettingsEnv(he(H)?.env,H,…);if(eK(H)){…Object.assign(process.env,F);…}else this.assignFromAboveTheRepository(F)}`
 * with `assignFromAboveTheRepository(e){Object.assign(process.env,e);…}`), and a `-p` boot
 * runs that pass before it loads plugins (`if(ge()){T1();…` ahead of `plugin_init`; the
 * interactive boot runs it once the folder is trusted). The managed layer is never read: no
 * probe runs beside a managed policy source.
 */
interface EnvLayer {
  env: Record<string, string>;
  /**
   * A project or local layer: 2.1.332 leaves many keys a project's settings set out of
   * `process.env` (`pt(e,n,r,E,_,f){if(!e||!eK(n))return e;…if(!z(S)||…)continue;…delete g[S]…`,
   * "project-scoped settings can't set this key"), so its value may or may not apply.
   */
  mayBeDropped: boolean;
}

/**
 * The string values of a settings `env` block, as 2.1.332 keeps them: a string as it is, a
 * number or a boolean as its string, any other value left out
 * (`g=typeof l==="string"?l:typeof l==="number"||typeof l==="boolean"?String(l):void 0`).
 * Undefined for an `env` that is present and not an object.
 */
function envStringsOf(layer: SettingsLayer): Record<string, string> | undefined {
  if (layer.env === undefined) return {};
  if (!isPlainObject(layer.env)) return undefined;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(layer.env)) {
    if (typeof value === "string") env[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") env[key] = String(value);
  }
  return env;
}

/**
 * The `env` block of the settings file at `path`: null for a missing file, `unreadable` for
 * one that cannot be read or parsed, is not a regular file ({@link readRegularFile}), is not an
 * object, or holds an `env` that is not one.
 */
function envOfSettingsFile(path: string): Record<string, string> | null | "unreadable" {
  const text = readRegularFile(path);
  if (text === null || text === "unreadable") return text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed)) return "unreadable";
    return envStringsOf(parsed) ?? "unreadable";
  } catch {
    return "unreadable";
  }
}

/**
 * The project and local settings files a launch in `cwd` reads, those of its last
 * `--project-config-root` too (resolved against `cwd`), each tier only when `sources` loads it.
 */
function projectAndLocalFiles(
  cwd: string,
  flags: readonly string[],
  sources: ReadonlySet<SettingSource> | null
): string[] {
  const root = lastFlagValue(flags, "--project-config-root");
  const dirs = [cwd, ...(root && root !== "missing" ? [resolve(cwd, root)] : [])];
  const tiers = dirs.map((dir) => launchSettingsFilesByTier(dir, sources));
  return [...tiers.flatMap((t) => t.project), ...tiers.flatMap((t) => t.local)];
}

/** What the caller's settings `env` blocks make of its launch environment. */
interface CallerEffectiveEnv {
  /**
   * Each {@link CALLER_LAUNCH_ENV_KEYS} value the caller probe is given: the launch's, then
   * the user and `--settings` layers' over it, except the {@link LAUNCH_ONLY_KEYS}, which are
   * the launch's alone. A project or local value is left to the probe's own boot, which reads
   * the same files and keeps or drops each key as Claude Code does.
   */
  passed: CallerEnv;
  /**
   * Whether `key` (any case) is on, as 2.1.332 reads it, in any order of applying or dropping
   * each project and local layer: a project value can be dropped, so a project `0` does not
   * clear a user `1`.
   */
  mayBeOn: (key: string) => boolean;
  /**
   * Whether `key` is on at launch or in any settings layer: for a switch read before any
   * `env` block applies, which a later `0` cannot clear.
   */
  everOn: (key: string) => boolean;
  /** Whether a settings layer sets `CLAUDE_CONFIG_DIR` (any case) to another value. */
  movesConfigDir: boolean;
  /**
   * Whether a settings layer sets `CLAUDE_CODE_RESTRICTED` (any case) to a value whose on/off
   * reading differs from the launch's (`--restricted` before any `--`, or the launch env).
   */
  movesRestricted: boolean;
}

/**
 * The keys the caller read at launch only, before any settings `env` block applied: the config
 * dir, which decides where the user settings were read, and the restricted switch, which
 * decided which settings sources were read ({@link callerModeRefusal}).
 */
const LAUNCH_ONLY_KEYS: readonly string[] = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_RESTRICTED"];

/**
 * The caller's settings `env` layers: user settings (in its own config dir), its project and
 * local settings, then its `--settings`, each tier only when the caller loads it: none of the
 * first three under restricted mode at launch
 * (`qNs(){…if(Zv("--restricted")||ILe())m(""),…}`), else as its `--setting-sources` says. Only
 * the keys asked for are ever read from a block; no value is logged. A layer that cannot be read
 * or parsed answers `caller_settings_unreadable`.
 *
 * `home` is the server's `HOME`: the caller's own is not read ({@link HostEnv}), so a caller
 * with no `CLAUDE_CONFIG_DIR` is taken to share the server's home, as the user settings gate
 * ({@link userSettingsRefusal}) takes it too.
 */
function callerEffectiveEnv(
  launch: { flags: readonly string[]; cwd: string; layer: SettingsLayer | null; hostEnv: HostEnv },
  home: string
): CallerEffectiveEnv | Refusal {
  const { flags, cwd, hostEnv } = launch;
  const restricted =
    passesBeforeEnd(flags, "--restricted") || claudeEnvTrue(hostEnv.CLAUDE_CODE_RESTRICTED);
  const sources: ReadonlySet<SettingSource> | null = restricted
    ? new Set()
    : enabledSettingSources(flags);
  const unreadable = (what: string): Refusal => ({
    outcome: "caller_settings_unreadable",
    line: `${what} cannot be read or parsed, so claudish cannot tell which launch mode its env block sets for the caller`,
  });
  const layers: EnvLayer[] = [];
  if (sources === null || sources.has("user")) {
    const file = userSettingsFile(hostEnv.CLAUDE_CONFIG_DIR, home, cwd);
    const env = envOfSettingsFile(file);
    if (env === "unreadable") return unreadable(`the caller's user settings ${file}`);
    if (env) layers.push({ env, mayBeDropped: false });
  }
  for (const file of projectAndLocalFiles(cwd, flags, sources)) {
    const env = envOfSettingsFile(file);
    if (env === "unreadable") return unreadable(`the caller's settings ${file}`);
    if (env) layers.push({ env, mayBeDropped: true });
  }
  if (launch.layer) {
    const env = envStringsOf(launch.layer);
    if (env === undefined) return unreadable("the caller's own --settings");
    layers.push({ env, mayBeDropped: false });
  }

  const passed: CallerEnv = {};
  for (const key of CALLER_LAUNCH_ENV_KEYS) {
    let value = hostEnv[key];
    if (!LAUNCH_ONLY_KEYS.includes(key)) {
      for (const layer of layers)
        if (!layer.mayBeDropped && key in layer.env) value = layer.env[key];
    }
    if (value !== undefined) passed[key] = value;
  }
  const valuesOf = (env: Record<string, string>, key: string) =>
    Object.entries(env).filter(([k]) => k.toUpperCase() === key);
  const mayBeOn = (key: string) => {
    let possible = new Set<string | undefined>([(hostEnv as Record<string, string>)[key]]);
    for (const layer of layers) {
      const set = valuesOf(layer.env, key).map(([, v]) => v);
      if (set.length === 0) continue;
      possible = layer.mayBeDropped ? new Set([...possible, ...set]) : new Set(set);
    }
    return [...possible].some(claudeEnvTrue);
  };
  const everOn = (key: string) =>
    claudeEnvTrue((hostEnv as Record<string, string>)[key]) ||
    layers.some((layer) => valuesOf(layer.env, key).some(([, v]) => claudeEnvTrue(v)));
  const movesConfigDir = layers.some((layer) =>
    valuesOf(layer.env, "CLAUDE_CONFIG_DIR").some(([, v]) => v !== hostEnv.CLAUDE_CONFIG_DIR)
  );
  const movesRestricted = layers.some((layer) =>
    valuesOf(layer.env, "CLAUDE_CODE_RESTRICTED").some(([, v]) => claudeEnvTrue(v) !== restricted)
  );
  return { passed, mayBeOn, everOn, movesConfigDir, movesRestricted };
}

/**
 * Whether the child's launch selects cowork plugins mode: {@link PROBE_COWORK_SWITCH} on in
 * any case in its spawn environment (the server's), in the inherited layer's `env`, or in the
 * `env` of a settings file the child probe reads (its user settings, work_dir's project and
 * local settings). A file that cannot be parsed is left to the later gates, which refuse it.
 */
function childCoworkRefusal(input: PluginHandoverInput, childReal: string): Refusal | undefined {
  const on = (env: Record<string, unknown> | undefined) =>
    Object.entries(env ?? {}).some(
      ([k, v]) =>
        k.toUpperCase() === PROBE_COWORK_SWITCH && typeof v === "string" && claudeEnvTrue(v)
    );
  const sources = enabledSettingSources(input.childFlags);
  const files = [
    ...(sources === null || sources.has("user")
      ? [userSettingsFile(input.env.CLAUDE_CONFIG_DIR, input.env.HOME ?? "", childReal)]
      : []),
    ...projectAndLocalFiles(childReal, input.childFlags, sources),
  ];
  const layerEnv = isPlainObject(input.layer?.env) ? envStringsOf(input.layer) : undefined;
  const found =
    passes(input.childFlags, "--cowork") ||
    on(input.env) ||
    on(layerEnv) ||
    files.some((file) => {
      const env = envOfSettingsFile(file);
      return env !== null && env !== "unreadable" && on(env);
    });
  return found ? coworkRefusal("the child's") : undefined;
}

/** The refusal for a launch (`whose`) in cowork plugins mode. */
function coworkRefusal(whose: string): Refusal {
  return {
    outcome: "caller_mode_unmodelled",
    line: `${whose} launch selects cowork plugins mode (CLAUDE_CODE_USE_COWORK_PLUGINS or --cowork), whose cowork_plugins folder and cowork_settings.json claudish does not model`,
  };
}

/** Why no probe may start for a launch's own flags (`whose`: the child's or the caller's). */
function launchFlagRefusal(flags: readonly string[], whose: string): Refusal | undefined {
  if (passes(flags, "--managed-settings")) {
    return {
      outcome: "managed_policy_present",
      line: `${whose} launch passes --managed-settings, a managed policy source`,
    };
  }
  if (passes(flags, "--plugin-url")) {
    return {
      outcome: "plugin_url",
      line: `${whose} launch passes --plugin-url, which the plugin probe never downloads, so it cannot tell which marketplace copies that plugin shadows`,
    };
  }
  const initialize = INITIALIZE_FLAGS.find((flag) => passes(flags, flag));
  if (initialize !== undefined) {
    return {
      outcome: "await_initialize",
      line: `${whose} launch passes ${initialize}, under which Claude Code reads settings, plugins or MCP servers from its stdin, which the plugin probe never sees`,
    };
  }
  return undefined;
}

/**
 * Why no probe may start under the machine's managed policy: Windows or WSL, or any managed
 * policy source present ({@link managedPolicySourcePresent}) as each of `probes` sees it: its
 * environment (whose `CLAUDE_CONFIG_DIR` names the server-managed cache and the hybrid sign-in
 * cache) and its cwd, against which a relative `CLAUDE_CONFIG_DIR` resolves. Called with
 * setup_from and work_dir under the server's environment, then with the caller's launch
 * directory under the caller's. The line names the platform or the source, never a value.
 */
function managedPolicyRefusal(
  input: PluginHandoverInput,
  probes: readonly { cwd: string; env: Record<string, string | undefined> }[]
): Refusal | undefined {
  if (input.policyPlatform !== "other") {
    const where = input.policyPlatform === "windows" ? "Windows" : "WSL";
    return {
      outcome: "managed_policy_present",
      line: `claudish does not read the managed policy on ${where}, so no plugin probe runs there`,
    };
  }
  let present: string | undefined;
  for (const { cwd, env } of probes) {
    present ??= managedPolicySourcePresent(input.managed, env, cwd);
  }
  if (present === undefined) return undefined;
  return {
    outcome: "managed_policy_present",
    line: `the managed policy source ${present} exists, and no plugin probe runs beside a managed policy`,
  };
}

/**
 * Why no probe may start in `childReal` for its own settings files, or those of the child's
 * last `--project-config-root` (resolved against `childReal`), else undefined.
 */
function workDirRefusal(childReal: string, childFlags: readonly string[]): Refusal | undefined {
  const found = projectCommandSetting(childReal, childFlags, COMMAND_SETTINGS);
  if (found === undefined) return undefined;
  return {
    outcome: "work_dir_command_setting",
    line:
      found.key === undefined
        ? `${found.path} cannot be parsed, so claudish cannot tell whether it defines a command the work_dir probe would run`
        : `${found.path} sets ${found.key}, a command the work_dir probe would run without the trust dialog`,
  };
}

/**
 * The first of the project and local settings files a launch in `cwd` reads (those of `cwd`,
 * then those of its last `--project-config-root`, resolved against `cwd`) that defines a `keys`
 * entry or cannot be parsed ({@link commandSettingIn}), else undefined.
 */
function projectCommandSetting(
  cwd: string,
  flags: readonly string[],
  keys: readonly string[]
): { path: string; key?: string } | undefined {
  const root = lastFlagValue(flags, "--project-config-root");
  const dirs = [cwd, ...(root && root !== "missing" ? [resolve(cwd, root)] : [])];
  let found: { path: string; key?: string } | undefined;
  for (const dir of dirs) found ??= commandSettingIn(launchSettingsFiles(dir), keys);
  return found;
}

/**
 * Why no probe may start in the caller's launch directory for its own project and local
 * settings, or those of the caller's `--project-config-root`: one defines a
 * {@link USER_STARTUP_HELPERS} key or cannot be parsed. The caller trusted that directory, so
 * Claude Code would run such a helper at the caller probe's boot (2.1.332 blocks a project
 * `apiKeyHelper` only where trust is not confirmed). Checked whatever the caller's
 * `--setting-sources`: a refusal costs a hand-over, never a wrong one.
 */
function callerProjectRefusal(callerReal: string, flags: readonly string[]): Refusal | undefined {
  const found = projectCommandSetting(callerReal, flags, USER_STARTUP_HELPERS);
  if (found === undefined) return undefined;
  return {
    outcome: "caller_command_setting",
    line:
      found.key === undefined
        ? `${found.path} cannot be parsed, so claudish cannot tell whether the caller probe would run a helper from it`
        : `${found.path} sets ${found.key}, a helper the caller probe's boot can run before any model turn`,
  };
}

/** One probe as the user settings gate sees it: its cwd, its launch flags and its environment. */
interface ProbeLaunch {
  cwd: string;
  flags: readonly string[];
  env: Record<string, string | undefined>;
}

/**
 * Why no probe may start for the user settings the probes load: the `settings.json` in each
 * probe's config dir (its own environment's `CLAUDE_CONFIG_DIR`, else `~/.claude`, resolved
 * against that probe's cwd; {@link userSettingsFile}), for each probe whose `--setting-sources`
 * loads the user tier, defining a {@link USER_STARTUP_HELPERS} key or failing to parse. Else
 * undefined.
 */
function userSettingsRefusal(probes: readonly ProbeLaunch[]): Refusal | undefined {
  const files = probes.flatMap(({ cwd, flags, env }) => {
    const sources = enabledSettingSources(flags);
    if (sources !== null && !sources.has("user")) return [];
    return [userSettingsFile(env.CLAUDE_CONFIG_DIR, env.HOME ?? "", cwd)];
  });
  const found = commandSettingIn([...new Set(files)], USER_STARTUP_HELPERS);
  if (found === undefined) return undefined;
  return {
    outcome: "user_command_setting",
    line:
      found.key === undefined
        ? `the user settings ${found.path} cannot be parsed, so claudish cannot tell whether a probe would run a helper from them`
        : `the user settings ${found.path} set ${found.key}, a helper a probe boot can run before any model turn`,
  };
}

/**
 * The caller's own launch: its flags, its cwd, its `--settings` content and the
 * {@link CALLER_LAUNCH_ENV_KEYS} values its probe is given ({@link CallerEffectiveEnv.passed}).
 */
interface CallerLaunch {
  flags: string[];
  cwd: string;
  layer: SettingsLayer | null;
  hostEnv: CallerEnv;
}

/**
 * The value of the last `flag` in `flags` (both spellings; Claude Code keeps the last one of
 * `--settings` and `--project-config-root`), `missing` for one with no value, else undefined.
 */
function lastFlagValue(flags: readonly string[], flag: string): string | "missing" | undefined {
  let value: string | "missing" | undefined;
  for (let i = 0; i < flags.length; i++) {
    const token = flags[i] as string;
    if (token === flag) {
      value = flags[i + 1] ?? "missing";
      i++;
    } else if (token.startsWith(`${flag}=`)) {
      value = token.slice(flag.length + 1);
    }
  }
  return value;
}

/**
 * The caller's launch, read from the MCP host's process ({@link PluginHandoverInput.hostPid}),
 * or why no probe may start for it: an argv that cannot be read exactly or holds no Claude Code
 * launch flags (`caller_argv_unreadable`), a {@link launchFlagRefusal}, a launch environment
 * whose keys cannot be read exactly (`caller_env_unreadable`), a `--settings` (inline JSON, or a
 * path resolved against the host's cwd) or a settings file whose `env` block the caller applies
 * that cannot be read or parsed (`caller_settings_unreadable`, {@link callerEffectiveEnv}), a
 * safe, bare or cowork plugins mode launch in its effective environment
 * (`caller_mode_unmodelled`, {@link callerModeRefusal}), or a launch directory that does not
 * share setup_from's main checkout (`setup_from_not_caller`: outside Git, a folder other than
 * setup_from).
 */
function readCallerLaunch(input: PluginHandoverInput): CallerLaunch | Refusal {
  const { setupReal } = input;
  let launch: ReturnType<HostLaunchReader>;
  try {
    launch = input.readHostLaunch(input.hostPid);
  } catch {
    launch = null;
  }
  const flags = launch ? callerLaunchFlags(launch.argv) : null;
  if (!launch || !flags) {
    return {
      outcome: "caller_argv_unreadable",
      line: `the launch of the caller's process ${input.hostPid} cannot be read as a Claude Code argv, so the caller probe cannot be started with the caller's flags`,
    };
  }
  const refusal = launchFlagRefusal(flags, "the caller's");
  if (refusal) return refusal;
  const hostEnv = launch.env;
  if (!hostEnv) {
    return {
      outcome: "caller_env_unreadable",
      line: `the launch environment of the caller's process ${input.hostPid} cannot be read, so the caller probe cannot be given the caller's CLAUDE_CONFIG_DIR, plugin variables and launch mode switches`,
    };
  }
  const settings = lastFlagValue(flags, "--settings");
  let layer: SettingsLayer | null = null;
  if (settings !== undefined) {
    try {
      if (settings === "missing") throw new Error("no value");
      const inline = settings.trim().startsWith("{");
      layer = readSettingsValue(inline ? settings : resolve(launch.cwd, settings));
    } catch {
      return {
        outcome: "caller_settings_unreadable",
        line: "the caller's own --settings cannot be read or parsed, so claudish cannot tell which plugins it turns off",
      };
    }
  }
  const effective = callerEffectiveEnv(
    { flags, cwd: launch.cwd, layer, hostEnv },
    input.env.HOME ?? ""
  );
  if ("outcome" in effective) return effective;
  const unmodelled = callerModeRefusal(flags, effective);
  if (unmodelled) return unmodelled;
  if (setupReal !== undefined && !sharesMainCheckout(setupReal, launch.cwd)) {
    return {
      outcome: "setup_from_not_caller",
      line: "setup_from and the caller's launch directory do not share a main checkout, so a probe in setup_from would not load what the caller loads",
    };
  }
  return { flags, cwd: launch.cwd, layer, hostEnv: effective.passed };
}

/**
 * The caller probe's base environment: the server's `env` with every {@link CALLER_LAUNCH_ENV_KEYS}
 * key (the config dir, the plugin variables and the launch mode switches) replaced by the
 * caller's own effective value ({@link CallerEffectiveEnv.passed}), or removed when the caller
 * has none. The server's are not
 * the caller's: an MCP server definition's `env` can set any of them for the server alone, and
 * Claude Code removes `CLAUDE_CODE_RESTRICTED`, `CLAUDE_CODE_SAFE_MODE`, `CLAUDE_CODE_SIMPLE`,
 * `CLAUDE_CODE_PLUGIN_DIRS` and two MCP switches from what it hands the processes it starts. Only
 * those keys come from the caller's process.
 */
function callerEnvOf(
  env: Record<string, string | undefined>,
  hostEnv: CallerEnv
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const key of CALLER_LAUNCH_ENV_KEYS) {
    const value = hostEnv[key];
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
}

/** Logs why no probe starts and answers it: no plugin, the refusal as the outcome. */
function refused(refusal: Refusal): PluginHandover {
  log(`[mcp-session] no plugin handed over: ${refusal.line}`);
  return { plugins: [], outcome: refusal.outcome };
}

/**
 * The temp folder prefix of one probe pair's settings files; the folder is
 * `<prefix><server pid>-<six mkdtemp characters>`.
 */
const PROBE_DIR_PREFIX = "claudish-plugin-probe-";

/** A probe temp folder's name: the owning server's pid, or none for a folder named without one. */
const PROBE_DIR_NAME = /^claudish-plugin-probe-(?:(\d{1,10})-)?[A-Za-z0-9]{6}$/;

/**
 * How old a probe temp folder of a live pid must be before a sweep removes it anyway: that pid
 * was reused by another process after the server that made the folder died. A live server's
 * folder is gone within the probe's deadline, far inside this. A folder named without a pid
 * goes at the same age.
 */
const STALE_PROBE_DIR_MS = 10 * 60_000;

/** Whether `pid` names a live process: `kill(pid, 0)` succeeds or is refused (`EPERM`). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Where and how {@link sweepStaleProbeDirs} looks; every field defaults to the real one. */
export interface ProbeDirSweep {
  root?: string;
  now?: number;
  alive?: (pid: number) => boolean;
}

/**
 * Removes, from `root`, every probe temp folder a server killed mid-probe left behind
 * (`SIGKILL` runs no `finally`): a real folder (not a symlink) owned by this user whose name
 * carries a server pid that is gone, at any age. A folder whose pid is alive goes only once
 * last changed more than {@link STALE_PROBE_DIR_MS} before `now` (the pid was reused), and so
 * does one named without a pid. Such a folder holds the caller's `--settings` content at 0600.
 * Run at server start and before each probe pair. Never throws; a folder it cannot inspect or
 * remove stays.
 */
export function sweepStaleProbeDirs(sweep: ProbeDirSweep = {}): void {
  const root = sweep.root ?? tmpdir();
  const now = sweep.now ?? Date.now();
  const alive = sweep.alive ?? pidAlive;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  const uid = process.getuid?.();
  for (const name of names) {
    const match = PROBE_DIR_NAME.exec(name);
    if (!match) continue;
    const path = join(root, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) continue;
      const pid = match[1] === undefined ? undefined : Number(match[1]);
      const ownerGone = pid !== undefined && pid > 0 && !alive(pid);
      if (!ownerGone && now - stat.mtimeMs <= STALE_PROBE_DIR_MS) continue;
      rmSync(path, { recursive: true, force: true });
    } catch {
      // left for the next sweep
    }
  }
}

/**
 * The caller plugin copies a `setup_from` child is handed, with the probe outcome; null when
 * no probe is started: without setup_from, or when work_dir shares setup_from's main checkout
 * (a subfolder or a linked worktree, whose launch directory applies the same install rows).
 *
 * No probe is started, and nothing is handed over, for any {@link PluginProbeRefusal}: the
 * child's flags first, then the managed policy as setup_from and work_dir see it under the
 * server's environment, then cowork plugins mode in the child's launch
 * ({@link childCoworkRefusal}), then the caller's own launch ({@link readCallerLaunch}: its
 * argv, its launch environment, its `--settings`, its effective mode switches, setup_from
 * sharing its launch directory's main checkout), then the managed policy as the caller's launch directory sees it under the
 * caller's environment, then work_dir's own settings files and those of the child's
 * `--project-config-root` ({@link workDirRefusal}), then the caller's own project settings
 * ({@link callerProjectRefusal}), then the user settings each probe loads under its own
 * environment ({@link userSettingsRefusal}). Otherwise both probes run in parallel, each with a
 * private settings file ({@link pluginProbeSettings}) in one temp folder named with this
 * server's pid (swept first, {@link sweepStaleProbeDirs}, and removed once both probes are
 * done): in the caller's own launch directory (the MCP host's cwd, not setup_from: two linked
 * worktrees of one repository can hold different project settings) with the caller's launch
 * flags (relative paths resolved against that directory), the caller's own `--settings` and the
 * caller's own config dir, plugin variables and mode switches ({@link callerEnvOf}), and in
 * work_dir with the child's flags, the inherited layer and the server's environment, as the
 * child gets them. Either probe failing,
 * the runner throwing, or `signal` aborting hands over nothing, with one log line naming the
 * cause and never an environment value. A copy the layer's `enabledPlugins` turns off for the
 * child is not handed over.
 */
export async function inheritedPluginsFor(
  input: PluginHandoverInput
): Promise<PluginHandover | null> {
  const { setupReal } = input;
  if (!setupReal) return null;
  const childReal = realOrResolved(input.childCwd);
  if (sharesMainCheckout(setupReal, childReal)) return null;
  const early =
    launchFlagRefusal(input.childFlags, "the child's") ??
    managedPolicyRefusal(input, [
      { cwd: setupReal, env: input.env },
      { cwd: childReal, env: input.env },
    ]) ??
    childCoworkRefusal(input, childReal);
  const caller = early ?? readCallerLaunch(input);
  if ("outcome" in caller) return refused(caller);
  const callerReal = realOrResolved(caller.cwd);
  const callerEnv = callerEnvOf(input.env, caller.hostEnv);
  const refusal =
    managedPolicyRefusal(input, [{ cwd: callerReal, env: callerEnv }]) ??
    workDirRefusal(childReal, input.childFlags) ??
    callerProjectRefusal(callerReal, caller.flags) ??
    userSettingsRefusal([
      { cwd: callerReal, flags: caller.flags, env: callerEnv },
      { cwd: childReal, flags: input.childFlags, env: input.env },
    ]);
  if (refusal) return refused(refusal);
  const launch = caller;

  const runner = input.runner ?? spawnPluginProbe;
  const root = input.probeTmpRoot ?? tmpdir();
  sweepStaleProbeDirs({ root, ...(input.pidAlive ? { alive: input.pidAlive } : {}) });
  let dir: string | undefined;
  let results: PluginProbeResult[];
  try {
    dir = mkdtempSync(join(root, `${PROBE_DIR_PREFIX}${process.pid}-`));
    const callerSettings = join(dir, "caller-settings.json");
    const childSettings = join(dir, "child-settings.json");
    writePrivateJson(callerSettings, pluginProbeSettings(launch.layer));
    writePrivateJson(childSettings, pluginProbeSettings(input.layer));
    const request = (
      cwd: string,
      args: string[],
      env: Record<string, string | undefined>
    ): PluginProbeRequest => ({
      cwd,
      args,
      env: pluginProbeEnv(env),
      timeoutMs: input.timeoutMs ?? PLUGIN_PROBE_TIMEOUT_MS,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    // Both settle before the settings files go, even when one runner throws.
    const settled = await Promise.allSettled([
      runner(
        request(callerReal, pluginProbeArgs(callerSettings, launch.flags, callerReal), callerEnv)
      ),
      runner(
        request(childReal, pluginProbeArgs(childSettings, input.childFlags, childReal), input.env)
      ),
    ]);
    results = settled.map((s) =>
      s.status === "fulfilled" ? s.value : { ok: false, cause: "spawn_failed" as const }
    );
  } catch {
    results = [{ ok: false, cause: "spawn_failed" }];
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }

  const [callerResult, childResult] = results;
  const failed = results.find((r): r is { ok: false; cause: PluginProbeCause } => !r.ok);
  if (failed || !callerResult?.ok || !childResult?.ok) {
    const cause = failed?.cause ?? "spawn_failed";
    log(`[mcp-session] no plugin handed over: the plugin probe failed (${cause})`);
    return { plugins: [], outcome: cause };
  }
  const plugins = pluginsToHandOver(callerResult.plugins, childResult.plugins);
  return { plugins: withoutLayerDisabled(plugins, input.layer), outcome: "ok" };
}
