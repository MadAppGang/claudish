/**
 * Auto-update checker for Claudish
 *
 * Checks npm registry for new versions and prompts user to update.
 * Caches the check result to avoid checking on every run (once per day).
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const isWindows = platform() === "win32";

const NPM_REGISTRY_URL = "https://registry.npmjs.org/claudish/latest";
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

interface UpdateCache {
  lastCheck: number;
  latestVersion: string | null;
}

/**
 * Get cache file path
 * Uses platform-appropriate cache directory:
 * - Windows: %LOCALAPPDATA%\claudish or %USERPROFILE%\AppData\Local\claudish
 * - Unix/macOS: ~/.cache/claudish
 */
function getCacheFilePath(): string {
  let cacheDir: string;

  if (isWindows) {
    // Windows: Use LOCALAPPDATA or fall back to AppData\Local
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    cacheDir = join(localAppData, "claudish");
  } else {
    // Unix/macOS: Use ~/.cache/claudish
    cacheDir = join(homedir(), ".cache", "claudish");
  }

  try {
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
    return join(cacheDir, "update-check.json");
  } catch {
    // Fall back to temp directory if home cache fails
    return join(tmpdir(), "claudish-update-check.json");
  }
}

/**
 * Read cached update check result
 */
function readCache(): UpdateCache | null {
  try {
    const cachePath = getCacheFilePath();
    if (!existsSync(cachePath)) {
      return null;
    }
    const data = JSON.parse(readFileSync(cachePath, "utf-8"));
    return data as UpdateCache;
  } catch {
    return null;
  }
}

/**
 * Write update check result to cache
 */
function writeCache(latestVersion: string | null): void {
  try {
    const cachePath = getCacheFilePath();
    const data: UpdateCache = {
      lastCheck: Date.now(),
      latestVersion,
    };
    writeFileSync(cachePath, JSON.stringify(data), "utf-8");
  } catch {
    // Silently fail - caching is optional
  }
}

/**
 * Check if cache is still valid (less than 24 hours old)
 */
function isCacheValid(cache: UpdateCache): boolean {
  const age = Date.now() - cache.lastCheck;
  return age < CACHE_MAX_AGE_MS;
}

/**
 * Clear the update cache (called after successful update)
 */
function clearCache(): void {
  try {
    const cachePath = getCacheFilePath();
    if (existsSync(cachePath)) {
      unlinkSync(cachePath);
    }
  } catch {
    // Silently fail
  }
}

/**
 * Semantic version comparison
 * Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.replace(/^v/, "").split(".").map(Number);
  const parts2 = v2.replace(/^v/, "").split(".").map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

/**
 * Fetch latest version from npm registry
 */
async function fetchLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout

    const response = await fetch(NPM_REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return data.version || null;
  } catch {
    // Network error, timeout, or parsing error - silently fail
    return null;
  }
}

/**
 * Prompt user for confirmation
 */
function promptUser(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr, // Use stderr so it doesn't interfere with JSON output
    });

    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.toLowerCase().trim();
      resolve(normalized === "y" || normalized === "yes");
    });
  });
}

/**
 * Run npm install -g claudish
 */
function runUpdate(): boolean {
  try {
    console.error("\n[claudish] Updating...\n");

    // Use execSync with shell: true for cross-platform compatibility
    // Windows needs shell to find npm.cmd
    const result = execSync("npm install -g claudish@latest", {
      stdio: "inherit",
      encoding: "utf-8",
      shell: true,
    });

    console.error("\n[claudish] Update complete! Please restart claudish.\n");
    return true;
  } catch (error) {
    console.error("\n[claudish] Update failed. Try manually:");
    console.error("  npm install -g claudish@latest\n");
    return false;
  }
}

/**
 * Check for updates and prompt user
 *
 * Uses a cache to avoid checking npm on every run (once per 24 hours).
 *
 * @param currentVersion - Current installed version
 * @param options - Configuration options
 * @returns true if update was performed (caller should exit), false otherwise
 */
export async function checkForUpdates(
  currentVersion: string,
  options: {
    quiet?: boolean;
    skipPrompt?: boolean;
  } = {}
): Promise<boolean> {
  const { quiet = false, skipPrompt = false } = options;

  let latestVersion: string | null = null;

  // Check cache first
  const cache = readCache();
  if (cache && isCacheValid(cache)) {
    // Use cached version
    latestVersion = cache.latestVersion;
  } else {
    // Cache is stale or doesn't exist - fetch from npm
    latestVersion = await fetchLatestVersion();
    // Update cache (even if null - to avoid repeated failed requests)
    writeCache(latestVersion);
  }

  if (!latestVersion) {
    // Couldn't fetch - silently continue
    return false;
  }

  // Compare versions
  if (compareVersions(latestVersion, currentVersion) <= 0) {
    // Already up to date
    return false;
  }

  // New version available!
  if (!quiet) {
    console.error("");
    console.error("━".repeat(60));
    console.error(`  New version available: ${currentVersion} → ${latestVersion}`);
    console.error("━".repeat(60));
    console.error("");
  }

  if (skipPrompt) {
    // Just notify, don't prompt
    if (!quiet) {
      console.error("  Update with: npm install -g claudish@latest\n");
    }
    return false;
  }

  // Prompt user
  const shouldUpdate = await promptUser("  Would you like to update now? [y/N] ");

  if (!shouldUpdate) {
    if (!quiet) {
      console.error("\n  Skipped. Update later with: npm install -g claudish@latest\n");
    }
    return false;
  }

  // Run update
  const success = runUpdate();

  if (success) {
    // Clear cache so next run checks fresh
    clearCache();
    // Exit after successful update so user can restart with new version
    return true;
  }

  return false;
}
