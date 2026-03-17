/**
 * Update Command
 *
 * Implements `claudish update` command:
 * - Detects installation method (npm, bun, brew)
 * - Shows current vs. latest version
 * - Prompts for confirmation
 * - Executes appropriate update command
 * - Clears update cache after successful update
 */

import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { getVersion } from "./cli.js";
import { clearCache, compareVersions, fetchLatestVersion } from "./update-checker.js";

// ANSI color codes
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";

interface InstallationInfo {
  method: "npm" | "bun" | "brew" | "unknown";
  path: string;
}

/**
 * Detect installation method from process.argv[1] path
 */
function detectInstallationMethod(): InstallationInfo {
  const scriptPath = process.argv[1] || "";

  // Priority 1: Homebrew
  if (scriptPath.includes("/opt/homebrew/") || scriptPath.includes("/usr/local/Cellar/")) {
    return { method: "brew", path: scriptPath };
  }

  // Priority 2: Bun
  if (scriptPath.includes("/.bun/")) {
    return { method: "bun", path: scriptPath };
  }

  // Priority 3: npm
  if (
    scriptPath.includes("/node_modules/") ||
    scriptPath.includes("/nvm/") ||
    scriptPath.includes("/npm/")
  ) {
    return { method: "npm", path: scriptPath };
  }

  // Unknown installation
  return { method: "unknown", path: scriptPath };
}

/**
 * Get update command for installation method
 */
function getUpdateCommand(method: InstallationInfo["method"]): string {
  switch (method) {
    case "npm":
      return "npm install -g claudish@latest";
    case "bun":
      return "bun add -g claudish@latest";
    case "brew":
      return "brew upgrade claudish";
    case "unknown":
      return ""; // No command for unknown
  }
}

/**
 * Prompt user for confirmation
 */
function promptUser(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.toLowerCase().trim();
      resolve(normalized === "y" || normalized === "yes" || normalized === "");
    });
  });
}

/**
 * Execute update command
 */
async function executeUpdate(command: string): Promise<boolean> {
  try {
    console.log(`\n${BOLD}Updating...${RESET}\n`);

    // Use execSync with shell for cross-platform compatibility
    execSync(command, {
      stdio: "inherit",
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    });

    console.log(`\n${GREEN}✓${RESET} ${BOLD}Update complete!${RESET}`);
    console.log(`${CYAN}Please restart any running claudish sessions.${RESET}\n`);
    return true;
  } catch (error) {
    console.error(`\n${RED}✗${RESET} ${BOLD}Update failed.${RESET}`);
    console.error(`${YELLOW}Try manually:${RESET}`);
    console.error(`  ${command}\n`);
    return false;
  }
}

/**
 * Print manual update instructions
 */
function printManualInstructions(): void {
  console.log(`\n${BOLD}Unable to detect installation method.${RESET}`);
  console.log(`${YELLOW}Please update manually:${RESET}\n`);
  console.log(`  ${CYAN}npm:${RESET}  npm install -g claudish@latest`);
  console.log(`  ${CYAN}bun:${RESET}  bun install -g claudish@latest`);
  console.log(`  ${CYAN}brew:${RESET} brew upgrade claudish\n`);
}

/**
 * Main update command entry point
 */
export async function updateCommand(): Promise<void> {
  // Get current version and installation info
  const currentVersion = getVersion();
  const installInfo = detectInstallationMethod();

  console.log(`claudish v${currentVersion}`);
  console.log(`Installation: ${installInfo.method}`);
  console.log(`\n${BOLD}Checking for updates...${RESET}\n`);

  // Fetch latest version
  const latestVersion = await fetchLatestVersion();

  if (!latestVersion) {
    console.error(`${RED}✗${RESET} Unable to fetch latest version from npm registry.`);
    console.error(`${YELLOW}Please check your internet connection and try again.${RESET}\n`);
    process.exit(1);
  }

  // Compare versions
  const comparison = compareVersions(latestVersion, currentVersion);

  if (comparison <= 0) {
    console.log(`${GREEN}✓${RESET} ${BOLD}Already up-to-date!${RESET}`);
    console.log(`${CYAN}Current version: ${currentVersion}${RESET}\n`);
    process.exit(0);
  }

  // Show version comparison
  console.log(`${BOLD}Current version:${RESET} ${YELLOW}${currentVersion}${RESET}`);
  console.log(`${BOLD}Latest version:${RESET}  ${GREEN}${latestVersion}${RESET}\n`);

  if (installInfo.method === "unknown") {
    printManualInstructions();
    process.exit(1);
  }

  // Get update command
  const command = getUpdateCommand(installInfo.method);

  console.log(`${BOLD}Update command:${RESET} ${command}\n`);

  // Prompt for confirmation
  const shouldUpdate = await promptUser(`${BOLD}Proceed with update? [Y/n]${RESET} `);

  if (!shouldUpdate) {
    console.log(`\n${YELLOW}Update cancelled.${RESET}`);
    console.log(`${CYAN}Update later with: ${command}${RESET}\n`);
    process.exit(0);
  }

  // Execute update
  const success = await executeUpdate(command);

  if (success) {
    // Clear update cache so next run checks fresh
    clearCache();
    process.exit(0);
  } else {
    process.exit(1);
  }
}
