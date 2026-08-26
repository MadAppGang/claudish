/**
 * Claudish Profile Configuration
 *
 * Manages user profiles for model mapping.
 * Supports two scopes:
 *   - Global: ~/.claudish/config.json (shared across all projects)
 *   - Local:  .claudish.json in project root (project-specific overrides)
 *
 * Resolution order: local config takes priority over global config.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";
import { activeGlobalConfigFile, getConfigFileOverride } from "./config-override.js";

// Config directory and file paths
const CONFIG_DIR = join(homedir(), ".claudish");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const LOCAL_CONFIG_FILENAME = ".claudish.json";

// Run-scoped config override (`--config <file>` / `CLAUDISH_CONFIG`) is owned by
// config-override.ts — the single, dependency-free authority every config reader
// consults (profile-config, op-source, onepassword-config). Re-exported here so
// existing importers keep working; the STATE lives in exactly one place.
export { setConfigFileOverride } from "./config-override.js";

/** The active global-config path — the override if set, else the machine file. */
export function activeConfigFile(): string {
  return activeGlobalConfigFile(CONFIG_FILE);
}

export type ProfileScope = "local" | "global";

/**
 * Model mapping for a profile
 * Maps Claude model types to OpenRouter model IDs
 */
export interface ModelMapping {
  opus?: string; // Model for opus (claude-opus-4-*)
  sonnet?: string; // Model for sonnet (claude-sonnet-4-*)
  haiku?: string; // Model for haiku (claude-haiku-*)
  subagent?: string; // Model for subagents (CLAUDE_CODE_SUBAGENT_MODEL)
}

/**
 * A named profile with model mappings
 */
export interface Profile {
  name: string;
  description?: string;
  models: ModelMapping;
  createdAt: string;
  updatedAt: string;
}

/**
 * Profile with scope metadata for display
 */
export interface ProfileWithScope extends Profile {
  scope: ProfileScope;
  isDefault: boolean;
  shadowed?: boolean; // global profile hidden by same-name local profile
}

/**
 * A single routing destination: either "provider" (uses the original model name)
 * or "provider@model" (uses a specific model on that provider).
 */
export type RoutingEntry = string;

/**
 * Custom routing rules: maps a model name pattern to an ordered list of routing
 * destinations to try. Patterns can be exact names, globs ("kimi-*"), or "*"
 * catch-all. Local .claudish.json rules replace global rules entirely.
 */
export type RoutingRules = Record<string, RoutingEntry[]>;

/**
 * Telemetry consent state. Persisted to ~/.claudish/config.json under the
 * "telemetry" key. Absence of the "telemetry" key means the user has never
 * been prompted (equivalent to enabled: false, askedAt: undefined).
 */
export interface TelemetryConsent {
  /** Explicit opt-in. Default is false (disabled until user says yes). */
  enabled: boolean;
  /**
   * ISO 8601 UTC timestamp of when the user was asked. Absent means the user
   * has never seen the consent prompt. This is the gate for re-prompting.
   */
  askedAt?: string;
  /**
   * Claudish version string when the user was first prompted. Stored for
   * future re-consent logic (e.g., if schema changes significantly).
   */
  promptedVersion?: string;
}

/**
 * Anonymous usage stats consent state. Persisted to ~/.claudish/config.json
 * under the "stats" key. Stats are OFF by default — user must explicitly enable.
 */
export interface StatsConsent {
  /** Explicit opt-in. Default: false (disabled until user says yes). */
  enabled: boolean;
  /** ISO 8601 UTC of when the user first enabled stats. */
  enabledAt?: string;
  /** ISO 8601 UTC of last monthly banner shown. */
  lastMonthlyPrompt?: string;
  /** ISO 8601 UTC of last successful batch send. */
  lastSentAt?: string;
  /** Claudish version when first prompted. */
  promptedVersion?: string;
}

/**
 * Root configuration structure
 */
export interface ClaudishProfileConfig {
  version: string;
  defaultProfile: string;
  profiles: Record<string, Profile>;
  /** Telemetry consent state. Absent = never prompted. */
  telemetry?: TelemetryConsent;
  /** Anonymous usage stats consent state. Absent = never configured (defaults to disabled). */
  stats?: StatsConsent;
  /**
   * Custom routing rules. Local .claudish.json rules replace global rules entirely.
   * Maps model name patterns (exact, glob, or "*") to ordered lists of routing entries.
   */
  routing?: RoutingRules;
  /** API keys stored in config (NOT env files). Env vars take precedence at runtime. */
  apiKeys?: Record<string, string>;
  /** Custom provider endpoints (env var name → URL) */
  endpoints?: Record<string, string>;
  /**
   * 1Password imports. Each entry is a glob (`op://.../*` or
   * `op://.../<section>/<fieldGlob>`) that expands to MANY env vars named by
   * field label, OR a single `op://vault/item/[section]/field` reference named
   * by its trailing field label. Resolved at startup (explicit opt-in → a
   * failure hard-fails). Env vars already set always win.
   */
  onepassword?: string[];
  /**
   * The 1Password account URL (e.g. `my-team.1password.com`) to use for SDK
   * DesktopAuth when no OP_SERVICE_ACCOUNT_TOKEN / OP_ACCOUNT is set. Saved by
   * the interactive multi-account picker, or set manually. Resolves below
   * OP_ACCOUNT (env) but above auto-detection.
   */
  onepasswordAccount?: string;
  /**
   * 1Password Environment IDs to load at startup (SDK beta API). Each entry's
   * variables are hydrated into process.env (overwrite, mirroring `--op-env`).
   * Persisted form of the `--op-env <id>` flag. Resolved below `--op-env` but
   * above `onepassword[]` single refs/globs. A failure hard-fails (explicit
   * opt-in, like all 1Password sources).
   */
  onepasswordEnvironments?: string[];
  /**
   * macOS Keychain backend state.
   *
   * `enabled` is a LAZINESS GATE, not a record of what is stored. It says only
   * "this machine uses the keychain backend", which lets `hasKeychainSource()`
   * answer synchronously without spawning `security` for a user who has never
   * opted in. The stored variable NAMES are deliberately not mirrored here: the
   * keychain enumerates its own contents in one ~28ms call, and a second copy
   * of a list is a second thing that can be wrong.
   *
   * Set automatically on the first successful keychain write.
   */
  keychain?: {
    enabled?: boolean;
  };
  /**
   * Opt IN to using a real ANTHROPIC_API_KEY for native Claude models, accepting
   * metered API billing. Default (absent/false) hides the key so Claude Code
   * uses the claude.ai subscription — a key bundled into a shared .env /
   * 1Password Environment alongside other providers' keys must not silently
   * switch billing. Overridden by CLAUDISH_ANTHROPIC_API_BILLING and
   * --anthropic-api-billing.
   */
  anthropicApiBilling?: boolean;
  /** Built-in local providers explicitly enabled in global config. */
  localProviders?: string[];
  /** ISO timestamp when user confirmed auto-approve behavior. Absent = never confirmed. */
  autoApproveConfirmedAt?: string;
  /** Diagnostic output mode: auto (default), logfile, off */
  diagMode?: "auto" | "logfile" | "off";

  /**
   * Always enable claudish's own debug logging (equivalent to passing
   * `-d` / `--debug-claudish` on every run). Writes a full debug log to
   * `logs/claudish_*.log` and bumps the log level to `debug`.
   * Precedence: `-d` / `--no-debug-claudish` flag > CLAUDISH_DEBUG env > this field.
   */
  debug?: boolean;

  /**
   * Default provider for bare model names. One of the builtin names
   * (openrouter, litellm, openai, anthropic, google) or a key from `customEndpoints`.
   * Precedence: --default-provider flag > CLAUDISH_DEFAULT_PROVIDER env > this field.
   * Phase 2 wires this into the routing fallback chain.
   */
  defaultProvider?: string;

  /**
   * Named custom endpoints. Each entry is either a "simple" config
   * (URL + format + key) or a "complex" config (full provider profile).
   * NOTE: This is distinct from the legacy `endpoints?: Record<string, string>` field
   * which is just an env-var → URL map for builtin providers.
   * Validation of entries happens at the consumption site (Phase 3) via Zod, not here.
   */
  customEndpoints?: Record<string, unknown>;

  /**
   * Opt-out surface for the endpoint catalog that ships inside the package
   * (`providers/predefined-catalog.ts`): `{ enabled?, disable?, enable? }`.
   * Validated at the consumption site (`providers/predefined-endpoints.ts`) via
   * Zod, not here — `loadConfig` stays Zod-free.
   *
   * SCOPE: global only, exactly like `customEndpoints`. That is not an
   * oversight — the two are read as ONE object, because a suppression set built
   * from a wider scope than the endpoints it suppresses would delete a provider
   * outright (a project-level `customEndpoints.groq` would suppress the bundled
   * row while the replacement, loaded from global config only, never registers).
   */
  predefinedEndpoints?: Record<string, unknown>;

  /**
   * Layer 4 behavior-compatibility settings (rule severities, hooks, observer).
   * Validated at the consumption site via Zod in behavior/config.ts, not here —
   * `loadConfig` runs on lightweight startup paths and stays Zod-free.
   */
  behavior?: Record<string, unknown>;

  /**
   * Apply a model's catalog provider-preset (e.g. `reasoning.mode=pro`) while
   * the Claude Code session is in ultracode. Opt-in and default OFF — a pro
   * preset burns quota faster, so it must never turn itself on.
   * Precedence: --pro-on-ultracode flag > CLAUDISH_PRO_ON_ULTRACODE env >
   * project `.claudish.json` > this field > false. The scoped read is
   * `readProOnUltracode()`, NOT this allowlist — see its doc comment.
   */
  proOnUltracode?: boolean;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: ClaudishProfileConfig = {
  version: "1.0.0",
  defaultProfile: "default",
  profiles: {
    default: {
      name: "default",
      description: "Default profile - shows model selector when no model specified",
      models: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  },
};

// ─── Global Config ───────────────────────────────────────

/**
 * Ensure global config directory exists
 */
function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * Load global configuration from ~/.claudish/config.json
 * Returns default config if file doesn't exist
 */
export function loadConfig(): ClaudishProfileConfig {
  const activeFile = activeConfigFile();
  // Only touch ~/.claudish when reading the real machine file — an override
  // points elsewhere and must not create the machine dir as a side effect.
  if (!getConfigFileOverride()) ensureConfigDir();

  if (!existsSync(activeFile)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const content = readFileSync(activeFile, "utf-8");
    const config = JSON.parse(content) as ClaudishProfileConfig;

    // Validate and merge with defaults
    const merged: ClaudishProfileConfig = {
      version: config.version || DEFAULT_CONFIG.version,
      defaultProfile: config.defaultProfile || DEFAULT_CONFIG.defaultProfile,
      profiles: config.profiles || DEFAULT_CONFIG.profiles,
    };
    // Preserve telemetry consent state if present
    if (config.telemetry !== undefined) {
      merged.telemetry = config.telemetry;
    }
    // Preserve stats consent state if present
    if (config.stats !== undefined) {
      merged.stats = config.stats;
    }
    // Preserve custom routing rules if present
    if (config.routing !== undefined) {
      merged.routing = config.routing;
    }
    if (config.apiKeys !== undefined) {
      merged.apiKeys = config.apiKeys;
    }
    if (config.endpoints !== undefined) {
      merged.endpoints = config.endpoints;
    }
    if (config.onepassword !== undefined) {
      merged.onepassword = config.onepassword;
    }
    if (config.onepasswordAccount !== undefined) {
      merged.onepasswordAccount = config.onepasswordAccount;
    }
    if (config.onepasswordEnvironments !== undefined) {
      merged.onepasswordEnvironments = config.onepasswordEnvironments;
    }
    // Same trap as onepasswordEnvironments below: omitted from this allowlist,
    // the block survives on disk until the first global save and is then
    // silently dropped — which would quietly disable the keychain backend.
    if (config.keychain !== undefined) {
      merged.keychain = config.keychain;
    }
    if (config.anthropicApiBilling !== undefined) {
      merged.anthropicApiBilling = config.anthropicApiBilling;
    }
    if (config.localProviders !== undefined) {
      merged.localProviders = Array.from(new Set(config.localProviders)).sort();
    }
    if (config.autoApproveConfirmedAt !== undefined) {
      merged.autoApproveConfirmedAt = config.autoApproveConfirmedAt;
    }
    if (config.defaultProvider !== undefined) {
      merged.defaultProvider = config.defaultProvider;
    }
    if (config.debug !== undefined) {
      merged.debug = config.debug;
    }
    if (config.customEndpoints !== undefined) {
      merged.customEndpoints = config.customEndpoints;
    }
    // Without this line the block survives on disk until the first global save
    // and is then silently dropped — the trap `onepasswordEnvironments` hit.
    if (config.predefinedEndpoints !== undefined) {
      merged.predefinedEndpoints = config.predefinedEndpoints;
    }
    if (config.behavior !== undefined) {
      merged.behavior = config.behavior;
    }
    // Same trap as keychain/onepasswordEnvironments above: omitted from this
    // allowlist, the field survives on disk until the first global save and is
    // then silently dropped — quietly turning the feature off with no error.
    if (config.proOnUltracode !== undefined) {
      merged.proOnUltracode = config.proOnUltracode;
    }
    return merged;
  } catch (error) {
    console.error(`Warning: Failed to load config, using defaults: ${error}`);
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Save global configuration to file
 */
export function saveConfig(config: ClaudishProfileConfig): void {
  // Writes target the ACTIVE file: with a --config override, persist to that
  // file (never mutate ~/.claudish/config.json with override-derived data).
  if (!getConfigFileOverride()) ensureConfigDir();
  writeFileSync(activeConfigFile(), JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Check if global config file exists
 */
export function configExists(): boolean {
  return existsSync(CONFIG_FILE);
}

/**
 * Get global config file path
 */
export function getConfigPath(): string {
  return CONFIG_FILE;
}

// ─── Local Config ────────────────────────────────────────

/**
 * Get path to local config file (.claudish.json).
 *
 * Walks up from cwd to find an existing .claudish.json so users can run
 * `claudish` from any subdirectory of their project. Walk-up stops at:
 *   - $HOME (don't escape into the user's home dir)
 *   - The git repo root (presence of `.git`) — bounds project scope
 *   - The filesystem root
 *
 * If no .claudish.json is found in the walk-up chain, returns the path at
 * cwd so first-time saves create the file at the user's working directory
 * (preserves prior "create at cwd" semantics for fresh projects).
 *
 * Behavior change vs. v7.x: previously cwd-only. This unifies how every
 * local-config consumer (Profiles, Routing, custom endpoints) discovers
 * the project file. Documented in app-tsx-split PR.
 */
export function getLocalConfigPath(): string {
  const home = homedir();
  let dir = process.cwd();
  const root = parse(dir).root;

  while (dir !== root && dir !== home) {
    const candidate = join(dir, LOCAL_CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, ".git"))) {
      // At git root; if .claudish.json doesn't exist here, stop walking and
      // return this path so first-time saves create the file at the git root
      // (the natural project boundary), not at cwd or somewhere above the repo.
      return candidate;
    }
    dir = dirname(dir);
  }
  // No project boundary found — fall back to cwd.
  return join(process.cwd(), LOCAL_CONFIG_FILENAME);
}

/**
 * Check if local config file exists
 */
export function localConfigExists(): boolean {
  return existsSync(getLocalConfigPath());
}

/**
 * The two config scopes `readProOnUltracode` consults, as thunks.
 *
 * A seam rather than direct calls because `homedir()` cannot be re-pointed at
 * runtime in Bun — the same approach as onepassword-config.test.ts.
 */
export interface ScopedConfigPaths {
  global: () => string;
  project: () => string;
}

const defaultScopedConfigPaths: ScopedConfigPaths = {
  // activeConfigFile(), NOT the raw CONFIG_FILE constant: `--config <file>` /
  // CLAUDISH_CONFIG must redirect this read like every other config reader,
  // and `bun run test:safe` relies on that to stay off the real machine file.
  global: () => activeConfigFile(),
  project: () => getLocalConfigPath(),
};

/**
 * Read `proOnUltracode` from the project file, else the global file.
 *
 * Deliberately a RAW per-file read rather than `loadConfig()`. `loadConfig`
 * merges only the global scope through its allowlist, so a project
 * `.claudish.json` that sets ONLY this key would be invisible to it. That is
 * the whole point of this function, not an oversight.
 *
 * Returns undefined when neither scope states a boolean — the caller then
 * applies its own default (false).
 */
export function readProOnUltracode(
  paths: ScopedConfigPaths = defaultScopedConfigPaths
): boolean | undefined {
  for (const pathFn of [paths.project, paths.global]) {
    try {
      const path = pathFn();
      if (!existsSync(path)) continue;
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
      if (typeof parsed?.proOnUltracode === "boolean") return parsed.proOnUltracode;
    } catch {
      // Garbled/unreadable file → skip this scope rather than fail the run.
    }
  }
  return undefined;
}

/**
 * Detect if CWD looks like a project directory
 */
export function isProjectDirectory(): boolean {
  const cwd = process.cwd();
  return [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", ".claudish.json"].some(
    (f) => existsSync(join(cwd, f))
  );
}

/**
 * Load local configuration from .claudish.json in CWD
 * Returns null if file doesn't exist
 */
export function loadLocalConfig(): ClaudishProfileConfig | null {
  // A --config override fully replaces machine settings, so the project
  // .claudish.json is ignored for this run (otherwise it would merge back in).
  if (getConfigFileOverride()) return null;

  const localPath = getLocalConfigPath();

  if (!existsSync(localPath)) {
    return null;
  }

  try {
    const content = readFileSync(localPath, "utf-8");
    const config = JSON.parse(content) as ClaudishProfileConfig;

    // Preserve ALL keys present in the file. A read-modify-write cycle
    // (loadLocalConfig → mutate one field → saveLocalConfig) must never drop
    // other settings the user has in `.claudish.json` (e.g. onepasswordAccount,
    // defaultProvider, diagMode). We only backfill the structural fields that
    // downstream code assumes are always present.
    return {
      ...config,
      version: config.version || DEFAULT_CONFIG.version,
      defaultProfile: config.defaultProfile ?? "",
      profiles: config.profiles ?? {},
    };
  } catch (error) {
    console.error(`Warning: Failed to load local config: ${error}`);
    return null;
  }
}

/**
 * Save local configuration to .claudish.json. Prunes empty containers so
 * deleting the last project rule doesn't leave a stub `{"routing": {}}`
 * file behind. If the entire local config carries no meaningful state
 * (no profiles, no routing), the file is unlinked instead of written.
 */
export function saveLocalConfig(config: ClaudishProfileConfig): void {
  // Drop an EMPTY routing object so the on-disk file stays tidy (an empty
  // `{"routing": {}}` carries no rules). This is cosmetic, not data loss.
  const toWrite: ClaudishProfileConfig = { ...config };
  if (toWrite.routing !== undefined && Object.keys(toWrite.routing).length === 0) {
    delete toWrite.routing;
  }

  // Always write what we're given. We deliberately do NOT delete the file when
  // profiles/routing are empty: `.claudish.json` may legitimately hold other
  // settings (onepasswordAccount, defaultProvider, diagMode, …). Deleting it on
  // a profile/routing change would silently wipe those — destructive. Mirror
  // the global saveConfig(): persist the config as-is.
  writeFileSync(getLocalConfigPath(), JSON.stringify(toWrite, null, 2), "utf-8");
}

// ─── Scope-Aware Operations ─────────────────────────────

function loadConfigForScope(scope: ProfileScope): ClaudishProfileConfig {
  if (scope === "local") {
    return loadLocalConfig() || { version: "1.0.0", defaultProfile: "", profiles: {} };
  }
  return loadConfig();
}

function saveConfigForScope(config: ClaudishProfileConfig, scope: ProfileScope): void {
  if (scope === "local") {
    saveLocalConfig(config);
  } else {
    saveConfig(config);
  }
}

/**
 * Check if config exists for a given scope
 */
export function configExistsForScope(scope: ProfileScope): boolean {
  if (scope === "local") {
    return localConfigExists();
  }
  return configExists();
}

/**
 * Get config file path for a given scope
 */
export function getConfigPathForScope(scope: ProfileScope): string {
  if (scope === "local") {
    return getLocalConfigPath();
  }
  return getConfigPath();
}

/**
 * Get a profile by name with optional scope
 * - scope="local": only local config
 * - scope="global": only global config
 * - scope=undefined: local first, then global
 */
export function getProfile(name: string, scope?: ProfileScope): Profile | undefined {
  if (scope === "local") {
    const local = loadLocalConfig();
    return local?.profiles[name];
  }
  if (scope === "global") {
    const config = loadConfig();
    return config.profiles[name];
  }

  // No scope: local first, then global
  const local = loadLocalConfig();
  if (local?.profiles[name]) {
    return local.profiles[name];
  }
  const config = loadConfig();
  return config.profiles[name];
}

/**
 * Get the default profile with optional scope
 * - scope="local": only local config's default
 * - scope="global": only global config's default
 * - scope=undefined: local default first (if local config exists and has a non-empty defaultProfile),
 *   otherwise fall through to global
 */
export function getDefaultProfile(scope?: ProfileScope): Profile {
  if (scope === "local") {
    const local = loadLocalConfig();
    if (local?.defaultProfile && local.profiles[local.defaultProfile]) {
      return local.profiles[local.defaultProfile];
    }
    // Local config exists but no valid default — return empty
    return DEFAULT_CONFIG.profiles.default;
  }

  if (scope === "global") {
    const config = loadConfig();
    const profile = config.profiles[config.defaultProfile];
    if (profile) return profile;
    const firstProfile = Object.values(config.profiles)[0];
    if (firstProfile) return firstProfile;
    return DEFAULT_CONFIG.profiles.default;
  }

  // No scope: local-first resolution
  const local = loadLocalConfig();
  if (local?.defaultProfile) {
    // Resolve the name local-first, then global
    const profile = getProfile(local.defaultProfile);
    if (profile) return profile;
  }

  // Fall through to global
  const config = loadConfig();
  const profile = config.profiles[config.defaultProfile];
  if (profile) return profile;
  const firstProfile = Object.values(config.profiles)[0];
  if (firstProfile) return firstProfile;
  return DEFAULT_CONFIG.profiles.default;
}

/**
 * Get all profile names with optional scope
 * - scope="local"/"global": names from that scope only
 * - scope=undefined: merged set from both
 */
export function getProfileNames(scope?: ProfileScope): string[] {
  if (scope === "local") {
    const local = loadLocalConfig();
    return local ? Object.keys(local.profiles) : [];
  }
  if (scope === "global") {
    const config = loadConfig();
    return Object.keys(config.profiles);
  }

  // Merged set
  const local = loadLocalConfig();
  const config = loadConfig();
  const names = new Set<string>([
    ...(local ? Object.keys(local.profiles) : []),
    ...Object.keys(config.profiles),
  ]);
  return [...names];
}

/**
 * Add or update a profile in the specified scope
 */
export function setProfile(profile: Profile, scope: ProfileScope = "global"): void {
  const config = loadConfigForScope(scope);

  const existingProfile = config.profiles[profile.name];
  if (existingProfile) {
    profile.createdAt = existingProfile.createdAt;
  } else {
    profile.createdAt = new Date().toISOString();
  }
  profile.updatedAt = new Date().toISOString();

  config.profiles[profile.name] = profile;
  saveConfigForScope(config, scope);
}

/**
 * Delete a profile from the specified scope
 * For global scope: cannot delete the last profile
 * For local scope: can delete any profile (local config can be empty)
 */
export function deleteProfile(name: string, scope: ProfileScope = "global"): boolean {
  const config = loadConfigForScope(scope);

  if (!config.profiles[name]) {
    return false;
  }

  // Only enforce "last profile" constraint on global scope
  if (scope === "global") {
    const profileCount = Object.keys(config.profiles).length;
    if (profileCount <= 1) {
      throw new Error("Cannot delete the last global profile");
    }
  }

  delete config.profiles[name];

  // If we deleted the default profile, set a new default
  if (config.defaultProfile === name) {
    const remaining = Object.keys(config.profiles);
    config.defaultProfile = remaining.length > 0 ? remaining[0] : "";
  }

  saveConfigForScope(config, scope);
  return true;
}

/**
 * Set the default profile in the specified scope
 */
export function setDefaultProfile(name: string, scope: ProfileScope = "global"): void {
  const config = loadConfigForScope(scope);

  if (!config.profiles[name]) {
    // For setting default, the profile must exist in the target scope
    throw new Error(`Profile "${name}" does not exist in ${scope} config`);
  }

  config.defaultProfile = name;
  saveConfigForScope(config, scope);
}

/**
 * Get model mapping from a profile
 * Uses local-first resolution when no scope is given
 */
export function getModelMapping(profileName?: string): ModelMapping {
  const profile = profileName ? getProfile(profileName) : getDefaultProfile();

  if (!profile) {
    return {};
  }

  return profile.models;
}

/**
 * Create a new profile with the given models in the specified scope
 */
export function createProfile(
  name: string,
  models: ModelMapping,
  description?: string,
  scope: ProfileScope = "global"
): Profile {
  const now = new Date().toISOString();
  const profile: Profile = {
    name,
    description,
    models,
    createdAt: now,
    updatedAt: now,
  };

  setProfile(profile, scope);
  return profile;
}

/**
 * List profiles from a single scope (legacy behavior for global)
 */
export function listProfiles(): Profile[] {
  const config = loadConfig();
  return Object.values(config.profiles).map((profile) => ({
    ...profile,
    isDefault: profile.name === config.defaultProfile,
  })) as (Profile & { isDefault?: boolean })[];
}

/**
 * List all profiles from both scopes with scope metadata
 */
export function listAllProfiles(): ProfileWithScope[] {
  const globalConfig = loadConfig();
  const localConfig = loadLocalConfig();
  const result: ProfileWithScope[] = [];

  // Local profiles first
  if (localConfig) {
    for (const profile of Object.values(localConfig.profiles)) {
      result.push({
        ...profile,
        scope: "local",
        isDefault: profile.name === localConfig.defaultProfile,
      });
    }
  }

  // Global profiles (mark shadowed if local has same name)
  const localNames = localConfig ? new Set(Object.keys(localConfig.profiles)) : new Set<string>();

  for (const profile of Object.values(globalConfig.profiles)) {
    result.push({
      ...profile,
      scope: "global",
      isDefault: profile.name === globalConfig.defaultProfile,
      shadowed: localNames.has(profile.name),
    });
  }

  return result;
}

// ─── API Key Helpers ──────────────────────────────────────

/**
 * Get a stored API key from ~/.claudish/config.json
 */
export function getApiKey(envVar: string): string | undefined {
  const config = loadConfig();
  return config.apiKeys?.[envVar];
}

/**
 * Store an API key in ~/.claudish/config.json
 */
export function setApiKey(envVar: string, value: string): void {
  const config = loadConfig();
  if (!config.apiKeys) config.apiKeys = {};
  config.apiKeys[envVar] = value;
  saveConfig(config);
}

/**
 * Remove a stored API key from ~/.claudish/config.json
 */
export function removeApiKey(envVar: string): void {
  const config = loadConfig();
  if (config.apiKeys) {
    delete config.apiKeys[envVar];
    saveConfig(config);
  }
}

// ─── Keychain Helpers ─────────────────────────────────────

/**
 * Is the macOS Keychain backend in use on this machine?
 *
 * A cheap SYNC sniff, and the only thing standing between a user who has never
 * touched the keychain and a `security` spawn they do not need. Reads config
 * only — it never asks the keychain anything, which is the point.
 */
export function isKeychainEnabled(): boolean {
  try {
    return loadConfig().keychain?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Turn the keychain backend on or off in `~/.claudish/config.json`.
 *
 * Enabling does NOT move any secret; it only tells claudish the store is worth
 * consulting. Disabling likewise leaves stored items untouched — they simply
 * stop being read. Removing the secrets themselves is `claudish keychain rm`,
 * which is a separate and deliberately explicit act.
 */
export function setKeychainEnabled(enabled: boolean): void {
  const config = loadConfig();
  if (!config.keychain) config.keychain = {};
  config.keychain.enabled = enabled;
  saveConfig(config);
}

// ─── Endpoint Helpers ─────────────────────────────────────

/**
 * Get a stored custom endpoint URL from ~/.claudish/config.json
 */
export function getEndpoint(name: string): string | undefined {
  const config = loadConfig();
  return config.endpoints?.[name];
}

/**
 * Store a custom endpoint URL in ~/.claudish/config.json
 */
export function setEndpoint(name: string, value: string): void {
  const config = loadConfig();
  if (!config.endpoints) config.endpoints = {};
  config.endpoints[name] = value;
  saveConfig(config);
}

/**
 * Remove a stored custom endpoint from ~/.claudish/config.json
 */
export function removeEndpoint(name: string): void {
  const config = loadConfig();
  if (config.endpoints) {
    delete config.endpoints[name];
    saveConfig(config);
  }
}

// ─── Local Provider Helpers ─────────────────────────────────

/**
 * Check whether a built-in local provider is explicitly enabled in
 * ~/.claudish/config.json.
 */
export function isLocalProviderEnabled(
  providerName: string,
  config: { localProviders?: string[] } = loadConfig()
): boolean {
  return (config.localProviders ?? []).includes(providerName);
}

/**
 * Enable a built-in local provider in ~/.claudish/config.json.
 */
export function enableLocalProvider(providerName: string): void {
  const config = loadConfig();
  const providers = new Set(config.localProviders ?? []);
  providers.add(providerName);
  config.localProviders = Array.from(providers).sort();
  saveConfig(config);
}

/**
 * Disable a built-in local provider in ~/.claudish/config.json.
 */
export function disableLocalProvider(providerName: string): void {
  const config = loadConfig();
  const providers = new Set(config.localProviders ?? []);
  providers.delete(providerName);
  if (providers.size > 0) {
    config.localProviders = Array.from(providers).sort();
  } else {
    delete config.localProviders;
  }
  saveConfig(config);
}
