/**
 * Claudish Profile Configuration
 *
 * Manages user profiles for model mapping.
 * Config file location: ~/.claudish/config.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Config directory and file paths
const CONFIG_DIR = join(homedir(), ".claudish");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

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
 * Root configuration structure
 */
export interface ClaudishProfileConfig {
  version: string;
  defaultProfile: string;
  profiles: Record<string, Profile>;
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
      description: "Default profile - balanced performance and cost",
      models: {
        opus: "x-ai/grok-3-beta",
        sonnet: "x-ai/grok-code-fast-1",
        haiku: "google/gemini-2.5-flash",
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  },
};

/**
 * Ensure config directory exists
 */
function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * Load configuration from file
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
    return {
      version: config.version || DEFAULT_CONFIG.version,
      defaultProfile: config.defaultProfile || DEFAULT_CONFIG.defaultProfile,
      profiles: config.profiles || DEFAULT_CONFIG.profiles,
    };
  } catch (error) {
    console.error(`Warning: Failed to load config, using defaults: ${error}`);
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Save configuration to file
 */
export function saveConfig(config: ClaudishProfileConfig): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Check if config file exists
 */
export function configExists(): boolean {
  return existsSync(CONFIG_FILE);
}

/**
 * Get config file path
 */
export function getConfigPath(): string {
  return CONFIG_FILE;
}

/**
 * Get a profile by name
 * Returns undefined if profile doesn't exist
 */
export function getProfile(name: string): Profile | undefined {
  const config = loadConfig();
  return config.profiles[name];
}

/**
 * Get the default profile
 */
export function getDefaultProfile(): Profile {
  const config = loadConfig();
  const profile = config.profiles[config.defaultProfile];

  if (!profile) {
    // Fallback to first profile or create default
    const firstProfile = Object.values(config.profiles)[0];
    if (firstProfile) {
      return firstProfile;
    }
    return DEFAULT_CONFIG.profiles.default;
  }

  return profile;
}

/**
 * Get all profile names
 */
export function getProfileNames(): string[] {
  const config = loadConfig();
  return Object.keys(config.profiles);
}

/**
 * Add or update a profile
 */
export function setProfile(profile: Profile): void {
  const config = loadConfig();

  const existingProfile = config.profiles[profile.name];
  if (existingProfile) {
    profile.createdAt = existingProfile.createdAt;
  } else {
    profile.createdAt = new Date().toISOString();
  }
  profile.updatedAt = new Date().toISOString();

  config.profiles[profile.name] = profile;
  saveConfig(config);
}

/**
 * Delete a profile
 * Cannot delete the last profile or the default profile if it's the only one
 */
export function deleteProfile(name: string): boolean {
  const config = loadConfig();

  if (!config.profiles[name]) {
    return false;
  }

  const profileCount = Object.keys(config.profiles).length;
  if (profileCount <= 1) {
    throw new Error("Cannot delete the last profile");
  }

  delete config.profiles[name];

  // If we deleted the default profile, set a new default
  if (config.defaultProfile === name) {
    config.defaultProfile = Object.keys(config.profiles)[0];
  }

  saveConfig(config);
  return true;
}

/**
 * Set the default profile
 */
export function setDefaultProfile(name: string): void {
  const config = loadConfig();

  if (!config.profiles[name]) {
    throw new Error(`Profile "${name}" does not exist`);
  }

  config.defaultProfile = name;
  saveConfig(config);
}

/**
 * Get model mapping from a profile
 * Falls back to environment variables if profile doesn't have a mapping
 */
export function getModelMapping(profileName?: string): ModelMapping {
  const profile = profileName ? getProfile(profileName) : getDefaultProfile();

  if (!profile) {
    return {};
  }

  return profile.models;
}

/**
 * Create a new profile with the given models
 */
export function createProfile(name: string, models: ModelMapping, description?: string): Profile {
  const now = new Date().toISOString();
  const profile: Profile = {
    name,
    description,
    models,
    createdAt: now,
    updatedAt: now,
  };

  setProfile(profile);
  return profile;
}

/**
 * List all profiles with their details
 */
export function listProfiles(): Profile[] {
  const config = loadConfig();
  return Object.values(config.profiles).map((profile) => ({
    ...profile,
    isDefault: profile.name === config.defaultProfile,
  })) as (Profile & { isDefault?: boolean })[];
}
