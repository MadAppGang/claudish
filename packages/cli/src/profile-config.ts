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

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TransportType } from "./handlers/shared/remote-provider-types.js";

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
 * Root configuration structure
 */
export interface ClaudishProfileConfig {
  version: string;
  defaultProfile: string;
  profiles: Record<string, Profile>;
  /** Telemetry consent state. Absent = never prompted. */
  telemetry?: TelemetryConsent;
  /** User-defined provider configurations. Keyed by canonical provider name. */
  providers?: Record<string, UserProviderConfig>;
}

/**
 * User-defined provider configuration (in ~/.claudish/config.json)
 *
 * Example:
 *   "navy": {
 *     "displayName": "Navy AI",
 *     "baseUrl": "https://api.navy",
 *     "apiPath": "/v1/chat/completions",
 *     "apiKeyEnvVar": "NAVY_API_KEY",
 *     "shortcuts": ["navy"]
 *   }
 *
 * Then: `claudish --model navy@gpt-5 "task"`
 */
export interface UserProviderConfig {
  displayName?: string;
  /** Transport type. Picks from existing transports. Defaults to "openai". */
  transport?: TransportType;
  baseUrl?: string;
  apiPath?: string;
  apiKeyEnvVar?: string;
  apiKeyAliases?: string[];
  apiKeyDescription?: string;
  apiKeyUrl?: string;
  authScheme?: "bearer" | "x-api-key" | "none";
  shortcuts?: string[];
  legacyPrefixes?: string[];
  nativeModelPatterns?: string[];
  headers?: Record<string, string>;
  publicKeyFallback?: boolean;
  tokenStrategy?: "delta-aware" | "accumulate-both" | "local";
  capabilities?: {
    supportsTools?: boolean;
    supportsVision?: boolean;
    supportsStreaming?: boolean;
    supportsJsonMode?: boolean;
    supportsReasoning?: boolean;
  };
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
async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
}

/**
 * Load global configuration from ~/.claudish/config.json
 * Returns default config if file doesn't exist
 */
export async function loadConfig(): Promise<ClaudishProfileConfig> {
  await ensureConfigDir();

  try {
    const content = await readFile(CONFIG_FILE, "utf-8");
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
    // Preserve user-defined providers if present
    if (config.providers !== undefined) {
      merged.providers = config.providers;
    }
    return merged;
  } catch (error) {
    // File doesn't exist or is invalid — return defaults
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_CONFIG };
    }
    console.error(`Warning: Failed to load config, using defaults: ${error}`);
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Save global configuration to file
 */
export async function saveConfig(config: ClaudishProfileConfig): Promise<void> {
  await ensureConfigDir();
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Check if global config file exists
 */
export async function configExists(): Promise<boolean> {
  try {
    await access(CONFIG_FILE);
    return true;
  } catch {
    return false;
  }
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
export async function localConfigExists(): Promise<boolean> {
  try {
    await access(getLocalConfigPath());
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect if CWD looks like a project directory
 */
export async function isProjectDirectory(): Promise<boolean> {
  const cwd = process.cwd();
  const markers = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", ".claudish.json"];
  for (const f of markers) {
    try {
      await access(join(cwd, f));
      return true;
    } catch {
      // continue checking
    }
  }
  return false;
}

/**
 * Load local configuration from .claudish.json in CWD
 * Returns null if file doesn't exist
 */
export async function loadLocalConfig(): Promise<ClaudishProfileConfig | null> {
  const localPath = getLocalConfigPath();

  try {
    const content = await readFile(localPath, "utf-8");
    const config = JSON.parse(content) as ClaudishProfileConfig;

    return {
      version: config.version || DEFAULT_CONFIG.version,
      defaultProfile: config.defaultProfile || "",
      profiles: config.profiles || {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    console.error(`Warning: Failed to load local config: ${error}`);
    return null;
  }
}

/**
 * Save local configuration to .claudish.json in CWD
 */
export async function saveLocalConfig(config: ClaudishProfileConfig): Promise<void> {
  await writeFile(getLocalConfigPath(), JSON.stringify(config, null, 2), "utf-8");
}

// ─── Scope-Aware Operations ─────────────────────────────

async function loadConfigForScope(scope: ProfileScope): Promise<ClaudishProfileConfig> {
  if (scope === "local") {
    return (await loadLocalConfig()) || { version: "1.0.0", defaultProfile: "", profiles: {} };
  }
  return loadConfig();
}

async function saveConfigForScope(config: ClaudishProfileConfig, scope: ProfileScope): Promise<void> {
  if (scope === "local") {
    await saveLocalConfig(config);
  } else {
    await saveConfig(config);
  }
}

/**
 * Check if config exists for a given scope
 */
export async function configExistsForScope(scope: ProfileScope): Promise<boolean> {
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
export async function getProfile(name: string, scope?: ProfileScope): Promise<Profile | undefined> {
  if (scope === "local") {
    const local = await loadLocalConfig();
    return local?.profiles[name];
  }
  if (scope === "global") {
    const config = await loadConfig();
    return config.profiles[name];
  }

  // No scope: local first, then global
  const local = await loadLocalConfig();
  if (local?.profiles[name]) {
    return local.profiles[name];
  }
  const config = await loadConfig();
  return config.profiles[name];
}

/**
 * Get the default profile with optional scope
 * - scope="local": only local config's default
 * - scope="global": only global config's default
 * - scope=undefined: local default first (if local config exists and has a non-empty defaultProfile),
 *   otherwise fall through to global
 */
export async function getDefaultProfile(scope?: ProfileScope): Promise<Profile> {
  if (scope === "local") {
    const local = await loadLocalConfig();
    if (local && local.defaultProfile && local.profiles[local.defaultProfile]) {
      return local.profiles[local.defaultProfile];
    }
    // Local config exists but no valid default, return empty
    return DEFAULT_CONFIG.profiles.default;
  }

  if (scope === "global") {
    const config = await loadConfig();
    const profile = config.profiles[config.defaultProfile];
    if (profile) return profile;
    const firstProfile = Object.values(config.profiles)[0];
    if (firstProfile) return firstProfile;
    return DEFAULT_CONFIG.profiles.default;
  }

  // No scope: local-first resolution
  const local = await loadLocalConfig();
  if (local && local.defaultProfile) {
    // Resolve the name local-first, then global
    const profile = await getProfile(local.defaultProfile);
    if (profile) return profile;
  }

  // Fall through to global
  const config = await loadConfig();
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
export async function getProfileNames(scope?: ProfileScope): Promise<string[]> {
  if (scope === "local") {
    const local = await loadLocalConfig();
    return local ? Object.keys(local.profiles) : [];
  }
  if (scope === "global") {
    const config = await loadConfig();
    return Object.keys(config.profiles);
  }

  // Merged set
  const local = await loadLocalConfig();
  const config = await loadConfig();
  const names = new Set<string>([
    ...(local ? Object.keys(local.profiles) : []),
    ...Object.keys(config.profiles),
  ]);
  return [...names];
}

/**
 * Add or update a profile in the specified scope
 */
export async function setProfile(profile: Profile, scope: ProfileScope = "global"): Promise<void> {
  const config = await loadConfigForScope(scope);

  const existingProfile = config.profiles[profile.name];
  if (existingProfile) {
    profile.createdAt = existingProfile.createdAt;
  } else {
    profile.createdAt = new Date().toISOString();
  }
  profile.updatedAt = new Date().toISOString();

  config.profiles[profile.name] = profile;
  await saveConfigForScope(config, scope);
}

/**
 * Delete a profile from the specified scope
 * For global scope: cannot delete the last profile
 * For local scope: can delete any profile (local config can be empty)
 */
export async function deleteProfile(name: string, scope: ProfileScope = "global"): Promise<boolean> {
  const config = await loadConfigForScope(scope);

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

  await saveConfigForScope(config, scope);
  return true;
}

/**
 * Set the default profile in the specified scope
 */
export async function setDefaultProfile(name: string, scope: ProfileScope = "global"): Promise<void> {
  const config = await loadConfigForScope(scope);

  if (!config.profiles[name]) {
    // For setting default, the profile must exist in the target scope
    throw new Error(`Profile "${name}" does not exist in ${scope} config`);
  }

  config.defaultProfile = name;
  await saveConfigForScope(config, scope);
}

/**
 * Get model mapping from a profile
 * Uses local-first resolution when no scope is given
 */
export async function getModelMapping(profileName?: string): Promise<ModelMapping> {
  const profile = profileName ? await getProfile(profileName) : await getDefaultProfile();

  if (!profile) {
    return {};
  }

  return profile.models;
}

/**
 * Create a new profile with the given models in the specified scope
 */
export async function createProfile(
  name: string,
  models: ModelMapping,
  description?: string,
  scope: ProfileScope = "global"
): Promise<Profile> {
  const now = new Date().toISOString();
  const profile: Profile = {
    name,
    description,
    models,
    createdAt: now,
    updatedAt: now,
  };

  await setProfile(profile, scope);
  return profile;
}

/**
 * List profiles from a single scope (legacy behavior for global)
 */
export async function listProfiles(): Promise<Profile[]> {
  const config = await loadConfig();
  return Object.values(config.profiles).map((profile) => ({
    ...profile,
    isDefault: profile.name === config.defaultProfile,
  })) as (Profile & { isDefault?: boolean })[];
}

/**
 * List all profiles from both scopes with scope metadata
 */
export async function listAllProfiles(): Promise<ProfileWithScope[]> {
  const globalConfig = await loadConfig();
  const localConfig = await loadLocalConfig();
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
