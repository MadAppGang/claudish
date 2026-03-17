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
import { join } from "node:path";

// Config directory and file paths
const CONFIG_DIR = join(homedir(), ".claudish");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const LOCAL_CONFIG_FILENAME = ".claudish.json";

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
  ensureConfigDir();

  if (!existsSync(CONFIG_FILE)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const content = readFileSync(CONFIG_FILE, "utf-8");
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
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
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
 * Get path to local config file (.claudish.json in CWD)
 */
export function getLocalConfigPath(): string {
  return join(process.cwd(), LOCAL_CONFIG_FILENAME);
}

/**
 * Check if local config file exists
 */
export function localConfigExists(): boolean {
  return existsSync(getLocalConfigPath());
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
  const localPath = getLocalConfigPath();

  if (!existsSync(localPath)) {
    return null;
  }

  try {
    const content = readFileSync(localPath, "utf-8");
    const config = JSON.parse(content) as ClaudishProfileConfig;

    const local: ClaudishProfileConfig = {
      version: config.version || DEFAULT_CONFIG.version,
      defaultProfile: config.defaultProfile || "",
      profiles: config.profiles || {},
    };
    // Preserve custom routing rules if present
    if (config.routing !== undefined) {
      local.routing = config.routing;
    }
    return local;
  } catch (error) {
    console.error(`Warning: Failed to load local config: ${error}`);
    return null;
  }
}

/**
 * Save local configuration to .claudish.json in CWD
 */
export function saveLocalConfig(config: ClaudishProfileConfig): void {
  writeFileSync(getLocalConfigPath(), JSON.stringify(config, null, 2), "utf-8");
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
    if (local && local.defaultProfile && local.profiles[local.defaultProfile]) {
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
  if (local && local.defaultProfile) {
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
