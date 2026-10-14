/**
 * Update Command
 *
 * Implements `claudish update` command:
 * - Detects installation method (npm, bun, brew)
 * - Checks for new version
 * - Auto-updates without prompt
 * - Fetches changelog from GitHub Releases API
 * - Displays beautiful changelog with ANSI colors
 */

import { execSync } from "node:child_process";
import { getVersion } from "./cli.js";
import { cliAnsi } from "./theme/ansi.js";
import { clearCache, compareVersions, fetchLatestVersionOrThrow } from "./update-checker.js";

// Theme-aware ANSI escapes, shared by every helper below. Refreshed at command
// entry via refreshAnsi() — NEVER snapshotted at module load, because theme
// detection runs at CLI startup, after this module is imported.
let RESET = "";
let BOLD = "";
let GREEN = "";
let YELLOW = "";
let CYAN = "";
let RED = "";
let MAGENTA = "";
let DIM = "";

function refreshAnsi(): void {
  ({ RESET, BOLD, GREEN, YELLOW, CYAN, RED, MAGENTA, DIM } = cliAnsi());
}

interface InstallationInfo {
  method: "npm" | "bun" | "brew" | "unknown";
  path: string;
}

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
}

interface ChangelogItem {
  type: "feat" | "fix" | "breaking" | "perf" | "chore";
  text: string;
}

interface ChangelogEntry {
  version: string;
  title: string;
  items: ChangelogItem[];
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
 * Execute update command
 */
async function executeUpdate(command: string): Promise<boolean> {
  try {
    execSync(command, {
      stdio: "inherit",
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    });

    return true;
  } catch {
    console.error(`\n${RED}✗${RESET} ${BOLD}Update failed.${RESET}`);
    console.error(`${YELLOW}Try manually:${RESET}`);
    console.error(`  ${command}\n`);
    return false;
  }
}

/** Map ### section headers to item types (null = skip section) */
const SECTION_TYPE_MAP: Record<string, ChangelogItem["type"] | null> = {
  "new features": "feat",
  features: "feat",
  "bug fixes": "fix",
  fixes: "fix",
  "breaking changes": "breaking",
  performance: "perf",
  "other changes": "chore",
  chore: "chore",
  refactor: "chore",
  documentation: null, // skip entirely
  docs: null,
};

/**
 * Parse a single GitHub release into a ChangelogEntry
 */
function parseRelease(r: GitHubRelease): ChangelogEntry {
  const version = r.tag_name.replace(/^v/, "");

  // Extract title from release name: "v6.9.0 — model catalog overhaul..." → "model catalog overhaul..."
  let title = "";
  const name = r.name || "";
  const dashMatch = name.match(/\s[—–-]\s(.+)$/);
  if (dashMatch) {
    title = dashMatch[1].trim();
  }

  const items: ChangelogItem[] = [];
  if (!r.body) return { version, title, items };

  const lines = r.body.split("\n");
  let currentType: ChangelogItem["type"] | null = "feat"; // default

  for (const line of lines) {
    // Stop at ## Install (boilerplate)
    if (/^##\s+Install/i.test(line)) break;

    // Detect ### section headers
    const sectionMatch = line.match(/^###\s+(.+)$/);
    if (sectionMatch) {
      const sectionName = sectionMatch[1].trim().toLowerCase();
      const mapped = SECTION_TYPE_MAP[sectionName];
      // undefined means unknown section → default to chore; null means skip
      currentType = mapped === undefined ? "chore" : mapped;
      continue;
    }

    // Skip non-bullet lines or if current section is skipped
    if (currentType === null) continue;
    const bulletMatch = line.match(/^[\s]*[-*]\s+(.+)$/);
    if (!bulletMatch) continue;

    let text = bulletMatch[1].trim();

    // Strip commit link suffix: ([`abc1234`](https://...))
    text = text.replace(/\(\[`[a-f0-9]+`\]\([^)]*\)\)\s*$/, "").trim();

    // Strip version prefix: "v6.9.0 — description" → "description"
    text = text.replace(/^v\d+\.\d+\.\d+\s*[—–-]\s*/, "").trim();

    // Skip noise items
    if (/^bump\s+to\s+v/i.test(text)) continue;
    if (/^update\s+CHANGELOG/i.test(text)) continue;
    if (!text) continue;

    items.push({ type: currentType, text });
  }

  return { version, title, items };
}

/**
 * Fetch releases from GitHub Releases API
 * Returns releases between currentVersion (exclusive) and latestVersion (inclusive)
 */
async function fetchChangelog(
  currentVersion: string,
  latestVersion: string
): Promise<ChangelogEntry[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch("https://api.github.com/repos/MadAppGang/claudish/releases", {
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "claudish-updater",
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return [];
    }

    const releases = (await response.json()) as GitHubRelease[];

    // Filter to versions between current (exclusive) and latest (inclusive)
    const relevant = releases.filter((r) => {
      const ver = r.tag_name.replace(/^v/, "");
      return compareVersions(ver, currentVersion) > 0 && compareVersions(ver, latestVersion) <= 0;
    });

    // Sort newest to oldest
    relevant.sort((a, b) => {
      const verA = a.tag_name.replace(/^v/, "");
      const verB = b.tag_name.replace(/^v/, "");
      return compareVersions(verB, verA);
    });

    return relevant.map((r) => parseRelease(r));
  } catch {
    // Network error, timeout, rate limit — gracefully skip
    return [];
  }
}

/**
 * Get symbol and color for a changelog item type
 */
function itemStyle(type: ChangelogItem["type"]): { symbol: string; color: string } {
  switch (type) {
    case "feat":
      return { symbol: "\u2726", color: GREEN }; // ✦
    case "fix":
      return { symbol: "\u2726", color: YELLOW }; // ✦
    case "breaking":
      return { symbol: "\u2726", color: MAGENTA }; // ✦
    case "perf":
      return { symbol: "\u2726", color: CYAN }; // ✦
    case "chore":
      return { symbol: "\u25aa", color: DIM }; // ▪
  }
}

/**
 * Display the changelog with polished ANSI formatting
 */
function displayChangelog(entries: ChangelogEntry[]): void {
  if (entries.length === 0) {
    return;
  }

  // Box header: ┌─...─┐ / │  ✦ What's New  │ / └─...─┘
  const innerWidth = 50;
  const headerLabel = `  ${YELLOW}\u2726${RESET} ${BOLD}What's New${RESET}`;
  // "  ✦ What's New" visible length = 2 + 1 + 1 + 10 = 14
  const headerVisible = 14;
  const headerPad = innerWidth - headerVisible;

  console.log("");
  console.log(`${CYAN}\u250c${"\u2500".repeat(innerWidth + 1)}\u2510${RESET}`);
  console.log(`${CYAN}\u2502${RESET}${headerLabel}${" ".repeat(headerPad)}${CYAN}\u2502${RESET}`);
  console.log(`${CYAN}\u2514${"\u2500".repeat(innerWidth + 1)}\u2518${RESET}`);
  console.log("");

  for (const entry of entries) {
    // Version line: "  v6.9.1  description"
    const titlePart = entry.title ? `  ${entry.title}` : "";
    console.log(`  ${BOLD}${GREEN}v${entry.version}${RESET}${titlePart}`);

    // Dim separator
    console.log(`  ${DIM}${"\u2500".repeat(30)}${RESET}`);

    // Items (only if there are any after filtering)
    for (const item of entry.items) {
      const { symbol, color } = itemStyle(item.type);
      console.log(`    ${color}${symbol}${RESET} ${item.text}`);
    }

    // Blank line between versions
    console.log("");
  }

  console.log(`${CYAN}Please restart any running claudish sessions.${RESET}`);
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
 * Ask the npm CLI for the published version.
 *
 * Fallback for the direct registry fetch: `npm view` honours the user's npm
 * configuration (custom/proxied registry, auth, CA certs) that a bare fetch()
 * knows nothing about, and it has its own retry logic.
 */
function fetchLatestVersionViaNpm(): string | null {
  try {
    const output = execSync("npm view claudish version", {
      encoding: "utf-8",
      timeout: 20000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const version = output.trim();
    return /^\d+\.\d+\.\d+/.test(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the latest published version for the interactive `update` command.
 *
 * Unlike the startup notification (fire-and-forget, 5s, no retry), the user is
 * sitting here waiting — so use a generous timeout, retry, and fall back to the
 * npm CLI before giving up.
 */
async function resolveLatestVersion(): Promise<{ version: string } | { error: string }> {
  let fetchError: string;
  try {
    return { version: await fetchLatestVersionOrThrow({ timeoutMs: 15000, retries: 2 }) };
  } catch (error) {
    fetchError = error instanceof Error ? error.message : String(error);
  }

  const viaNpm = fetchLatestVersionViaNpm();
  if (viaNpm) return { version: viaNpm };

  return { error: fetchError };
}

/** What `performUpdate` did. `unsupported` means the install method is unknown. */
export type UpdateOutcome =
  | { status: "updated"; method: InstallationInfo["method"] }
  | { status: "failed"; method: InstallationInfo["method"] }
  | { status: "unsupported" };

/**
 * Run the upgrade for however claudish was installed, and report what happened.
 *
 * Split out of `updateCommand` so the interactive launcher's "Update now?"
 * prompt reuses the same install detection, the same command table, and the
 * same cache invalidation — without inheriting `updateCommand`'s `process.exit`
 * calls, which a mid-startup prompt must not make on the user's behalf.
 *
 * Prints its own progress and failure text; the caller reports the result.
 */
export async function performUpdate(): Promise<UpdateOutcome> {
  refreshAnsi();
  const installInfo = detectInstallationMethod();

  if (installInfo.method === "unknown") {
    printManualInstructions();
    return { status: "unsupported" };
  }

  const command = getUpdateCommand(installInfo.method);
  console.log(`\n${DIM}Updating...${RESET}\n`);

  const success = await executeUpdate(command);
  if (success) {
    // Clear update cache so the next run checks fresh instead of re-offering
    // the version we just installed.
    clearCache();
    return { status: "updated", method: installInfo.method };
  }
  return { status: "failed", method: installInfo.method };
}

function printUpdateHelp(): void {
  console.log(`Usage: claudish update

Checks the npm registry for the latest claudish release and, when it is newer
than this one, installs it with the package manager that installed this copy
(bun, npm or Homebrew), then shows what changed.

Options:
  -h, --help   Show this help and exit without checking or installing
`);
}

/**
 * Main update command entry point
 */
export async function updateCommand(args: string[] = []): Promise<void> {
  // Before anything touches the network: `update --help` once ran the update.
  if (args.includes("--help") || args.includes("-h")) {
    printUpdateHelp();
    return;
  }
  refreshAnsi();
  // Get current version and installation info
  const currentVersion = getVersion();
  const installInfo = detectInstallationMethod();

  // Fetch latest version
  const result = await resolveLatestVersion();

  if ("error" in result) {
    console.error(`${RED}✗${RESET} Unable to fetch latest version from npm registry.`);
    console.error(`${DIM}Reason: ${result.error}${RESET}`);
    console.error(
      `${YELLOW}The npm registry may be slow or unreachable from this network.${RESET}`
    );
    const manualCommand = getUpdateCommand(installInfo.method);
    if (manualCommand) {
      console.error(`${YELLOW}You can update manually:${RESET}`);
      console.error(`  ${CYAN}${manualCommand}${RESET}\n`);
    } else {
      printManualInstructions();
    }
    process.exit(1);
  }

  const latestVersion = result.version;

  // Compare versions
  const comparison = compareVersions(latestVersion, currentVersion);

  if (comparison <= 0) {
    console.log(`${GREEN}✓${RESET} ${BOLD}Already up-to-date!${RESET}`);
    console.log(`${CYAN}Current version: ${currentVersion}${RESET}\n`);
    process.exit(0);
  }

  // Show header (compact single line)
  console.log(
    `  ${BOLD}claudish${RESET} ${YELLOW}v${currentVersion}${RESET} ${DIM}\u2192${RESET} ${GREEN}v${latestVersion}${RESET}   ${DIM}(${installInfo.method})${RESET}`
  );

  const outcome = await performUpdate();

  if (outcome.status === "unsupported") {
    process.exit(1);
  }

  if (outcome.status === "updated") {
    console.log(`\n  ${GREEN}\u2713${RESET} ${BOLD}Updated successfully${RESET}`);

    // Fetch and display changelog
    const changelog = await fetchChangelog(currentVersion, latestVersion);
    displayChangelog(changelog);

    console.log("");
    process.exit(0);
  } else {
    process.exit(1);
  }
}
