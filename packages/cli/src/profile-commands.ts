/**
 * Profile Management Commands
 *
 * Implements CLI commands for managing Claudish profiles:
 * - claudish init [--local|--global]: Initial setup wizard
 * - claudish profile list [--local|--global]: List all profiles
 * - claudish profile add [--local|--global]: Add a new profile
 * - claudish profile remove <name> [--local|--global]: Remove a profile
 * - claudish profile use <name> [--local|--global]: Set default profile
 * - claudish profile show [name] [--local|--global]: Show profile details
 * - claudish profile edit [name] [--local|--global]: Edit a profile
 */

import {
  loadConfig,
  loadLocalConfig,
  getProfile,
  getDefaultProfile,
  getProfileNames,
  setProfile,
  deleteProfile,
  setDefaultProfile,
  createProfile,
  listAllProfiles,
  configExistsForScope,
  getConfigPath,
  getConfigPathForScope,
  getLocalConfigPath,
  localConfigExists,
  isProjectDirectory,
  type Profile,
  type ProfileScope,
  type ProfileWithScope,
  type ModelMapping,
} from "./profile-config.js";
import {
  selectModel,
  selectModelsForProfile,
  promptForProfileName,
  promptForProfileDescription,
  confirmAction,
} from "./model-selector.js";
import { select, confirm } from "@inquirer/prompts";

// ANSI colors
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";

// ─── Scope Utilities ─────────────────────────────────────

/**
 * Extract --local/--global flag from args
 */
function parseScopeFlag(args: string[]): {
  scope: ProfileScope | undefined;
  remainingArgs: string[];
} {
  const remainingArgs: string[] = [];
  let scope: ProfileScope | undefined;

  for (const arg of args) {
    if (arg === "--local") {
      scope = "local";
    } else if (arg === "--global") {
      scope = "global";
    } else {
      remainingArgs.push(arg);
    }
  }

  return { scope, remainingArgs };
}

/**
 * Interactively prompt for scope if not provided via flag
 */
async function resolveScope(scopeFlag: ProfileScope | undefined): Promise<ProfileScope> {
  if (scopeFlag) return scopeFlag;

  const inProject = isProjectDirectory();
  const defaultScope = inProject ? "local" : "global";

  return select({
    message: "Where should this be saved?",
    choices: [
      {
        name: `Local (.claudish.json in this project)${inProject ? " (recommended)" : ""}`,
        value: "local" as ProfileScope,
      },
      {
        name: `Global (~/.claudish/config.json)${!inProject ? " (recommended)" : ""}`,
        value: "global" as ProfileScope,
      },
    ],
    default: defaultScope,
  });
}

/**
 * Format a scope badge for display
 */
function scopeBadge(scope: ProfileScope, shadowed?: boolean): string {
  if (scope === "local") {
    return `${MAGENTA}[local]${RESET}`;
  }
  if (shadowed) {
    return `${DIM}[global, shadowed]${RESET}`;
  }
  return `${DIM}[global]${RESET}`;
}

// ─── Commands ────────────────────────────────────────────

/**
 * Initial setup wizard
 * Creates the first profile and config file
 */
export async function initCommand(scopeFlag?: ProfileScope): Promise<void> {
  console.log(`\n${BOLD}${CYAN}Claudish Setup Wizard${RESET}\n`);

  const scope = await resolveScope(scopeFlag);
  const configPath = getConfigPathForScope(scope);

  if (configExistsForScope(scope)) {
    const overwrite = await confirm({
      message: `${scope === "local" ? "Local" : "Global"} configuration already exists. Do you want to reconfigure?`,
      default: false,
    });

    if (!overwrite) {
      console.log("Setup cancelled.");
      return;
    }
  }

  console.log(
    `${DIM}This wizard will help you set up Claudish with your preferred models.${RESET}\n`
  );

  // Create default profile
  const profileName = "default";

  console.log(`${BOLD}Step 1: Select models for each Claude tier${RESET}`);
  console.log(
    `${DIM}These models will be used when Claude Code requests specific model types.${RESET}\n`
  );

  const models = await selectModelsForProfile();

  // Create and save profile
  const profile = createProfile(profileName, models, undefined, scope);

  // Set as default
  setDefaultProfile(profileName, scope);

  console.log(`\n${GREEN}✓${RESET} Configuration saved to: ${CYAN}${configPath}${RESET}`);
  console.log(`\n${BOLD}Profile created:${RESET}`);
  printProfile(profile, true, false, scope);

  console.log(`\n${BOLD}Usage:${RESET}`);
  console.log(`  ${CYAN}claudish${RESET}              # Use default profile`);
  console.log(`  ${CYAN}claudish profile add${RESET}  # Add another profile`);
  if (scope === "local") {
    console.log(`\n${DIM}Local config applies only when running from this directory.${RESET}`);
  }
  console.log("");
}

/**
 * List all profiles
 */
export async function profileListCommand(scopeFilter?: ProfileScope): Promise<void> {
  const allProfiles = listAllProfiles();

  // Filter by scope if flag given
  const profiles = scopeFilter ? allProfiles.filter((p) => p.scope === scopeFilter) : allProfiles;

  if (profiles.length === 0) {
    if (scopeFilter) {
      console.log(
        `No ${scopeFilter} profiles found. Run 'claudish init --${scopeFilter}' to create one.`
      );
    } else {
      console.log("No profiles found. Run 'claudish init' to create one.");
    }
    return;
  }

  console.log(`\n${BOLD}Claudish Profiles${RESET}\n`);

  // Show config paths
  console.log(`${DIM}Global: ${getConfigPath()}${RESET}`);
  if (localConfigExists()) {
    console.log(`${DIM}Local:  ${getLocalConfigPath()}${RESET}`);
  }
  console.log("");

  for (const profile of profiles) {
    printProfileWithScope(profile);
    console.log("");
  }
}

/**
 * Add a new profile
 */
export async function profileAddCommand(scopeFlag?: ProfileScope): Promise<void> {
  console.log(`\n${BOLD}${CYAN}Add New Profile${RESET}\n`);

  const scope = await resolveScope(scopeFlag);
  const existingNames = getProfileNames(scope);
  const name = await promptForProfileName(existingNames);
  const description = await promptForProfileDescription();

  console.log(`\n${BOLD}Select models for this profile:${RESET}\n`);
  const models = await selectModelsForProfile();

  const profile = createProfile(name, models, description, scope);

  console.log(`\n${GREEN}✓${RESET} Profile "${name}" created ${scopeBadge(scope)}.`);
  printProfile(profile, false, false, scope);

  const setAsDefault = await confirm({
    message: `Set this profile as default in ${scope} config?`,
    default: false,
  });

  if (setAsDefault) {
    setDefaultProfile(name, scope);
    console.log(`${GREEN}✓${RESET} "${name}" is now the default ${scope} profile.`);
  }
}

/**
 * Remove a profile
 */
export async function profileRemoveCommand(name?: string, scopeFlag?: ProfileScope): Promise<void> {
  // If no scope flag and name is given, figure out where it lives
  let scope = scopeFlag;
  let profileName = name;

  if (!profileName) {
    // Interactive selection — show all profiles
    const allProfiles = listAllProfiles();
    const selectable = scope ? allProfiles.filter((p) => p.scope === scope) : allProfiles;

    if (selectable.length === 0) {
      console.log("No profiles to remove.");
      return;
    }

    const choice = await select({
      message: "Select a profile to remove:",
      choices: selectable.map((p) => ({
        name: `${p.name} ${scopeBadge(p.scope)}${p.isDefault ? ` ${YELLOW}(default)${RESET}` : ""}`,
        value: `${p.scope}:${p.name}`,
      })),
    });

    const [chosenScope, ...nameParts] = choice.split(":");
    scope = chosenScope as ProfileScope;
    profileName = nameParts.join(":");
  } else if (!scope) {
    // Name given but no scope — check where it exists
    const localConfig = loadLocalConfig();
    const globalConfig = loadConfig();
    const inLocal = localConfig?.profiles[profileName] !== undefined;
    const inGlobal = globalConfig.profiles[profileName] !== undefined;

    if (inLocal && inGlobal) {
      scope = await select({
        message: `Profile "${profileName}" exists in both local and global. Which one to remove?`,
        choices: [
          { name: "Local", value: "local" as ProfileScope },
          { name: "Global", value: "global" as ProfileScope },
        ],
      });
    } else if (inLocal) {
      scope = "local";
    } else if (inGlobal) {
      scope = "global";
    } else {
      console.log(`Profile "${profileName}" not found.`);
      return;
    }
  }

  // Check constraints
  if (scope === "global") {
    const globalNames = getProfileNames("global");
    if (globalNames.length <= 1 && globalNames.includes(profileName)) {
      console.log("Cannot remove the last global profile. Create another one first.");
      return;
    }
  }

  const profile = getProfile(profileName, scope);
  if (!profile) {
    console.log(`Profile "${profileName}" not found in ${scope} config.`);
    return;
  }

  const confirmed = await confirmAction(
    `Are you sure you want to delete profile "${profileName}" from ${scope} config?`
  );

  if (!confirmed) {
    console.log("Cancelled.");
    return;
  }

  try {
    deleteProfile(profileName, scope);
    console.log(`${GREEN}✓${RESET} Profile "${profileName}" deleted from ${scope} config.`);
  } catch (error) {
    console.error(`Error: ${error}`);
  }
}

/**
 * Set default profile
 */
export async function profileUseCommand(name?: string, scopeFlag?: ProfileScope): Promise<void> {
  let scope = scopeFlag;
  let profileName = name;

  if (!profileName) {
    // Show all profiles for selection
    const allProfiles = listAllProfiles();
    const selectable = scope ? allProfiles.filter((p) => p.scope === scope) : allProfiles;

    if (selectable.length === 0) {
      console.log("No profiles found. Run 'claudish init' to create one.");
      return;
    }

    const choice = await select({
      message: "Select a profile to set as default:",
      choices: selectable.map((p) => ({
        name: `${p.name} ${scopeBadge(p.scope)}${p.isDefault ? ` ${YELLOW}(default)${RESET}` : ""}`,
        value: `${p.scope}:${p.name}`,
      })),
    });

    const [chosenScope, ...nameParts] = choice.split(":");
    scope = chosenScope as ProfileScope;
    profileName = nameParts.join(":");
  }

  // If no scope yet, resolve it
  if (!scope) {
    // The profile must be set as default in the config where it exists
    const localConfig = loadLocalConfig();
    const globalConfig = loadConfig();
    const inLocal = localConfig?.profiles[profileName] !== undefined;
    const inGlobal = globalConfig.profiles[profileName] !== undefined;

    if (inLocal && inGlobal) {
      scope = await select({
        message: `Profile "${profileName}" exists in both configs. Set as default in which?`,
        choices: [
          { name: "Local", value: "local" as ProfileScope },
          { name: "Global", value: "global" as ProfileScope },
        ],
      });
    } else if (inLocal) {
      scope = "local";
    } else if (inGlobal) {
      scope = "global";
    } else {
      console.log(`Profile "${profileName}" not found.`);
      return;
    }
  }

  const profile = getProfile(profileName, scope);
  if (!profile) {
    console.log(`Profile "${profileName}" not found in ${scope} config.`);
    return;
  }

  setDefaultProfile(profileName, scope);
  console.log(`${GREEN}✓${RESET} "${profileName}" is now the default ${scope} profile.`);
}

/**
 * Show profile details
 */
export async function profileShowCommand(name?: string, scopeFlag?: ProfileScope): Promise<void> {
  let profileName = name;
  let scope = scopeFlag;

  if (!profileName) {
    // Show the effective default profile
    const defaultProfile = scope ? getDefaultProfile(scope) : getDefaultProfile();
    profileName = defaultProfile.name;

    // Determine which scope it came from
    if (!scope) {
      const localConfig = loadLocalConfig();
      if (localConfig?.profiles[profileName]) {
        scope = "local";
      } else {
        scope = "global";
      }
    }
  }

  // If no scope, figure out where it lives (prefer local)
  if (!scope) {
    const localConfig = loadLocalConfig();
    if (localConfig?.profiles[profileName]) {
      scope = "local";
    } else {
      scope = "global";
    }
  }

  const profile = getProfile(profileName, scope);
  if (!profile) {
    console.log(`Profile "${profileName}" not found.`);
    return;
  }

  // Check if it's default in its scope
  let isDefault = false;
  if (scope === "local") {
    const localConfig = loadLocalConfig();
    isDefault = localConfig?.defaultProfile === profileName;
  } else {
    const config = loadConfig();
    isDefault = config.defaultProfile === profileName;
  }

  console.log("");
  printProfile(profile, isDefault, true, scope);
}

/**
 * Edit an existing profile
 */
export async function profileEditCommand(name?: string, scopeFlag?: ProfileScope): Promise<void> {
  let scope = scopeFlag;
  let profileName = name;

  if (!profileName) {
    // Show all profiles for selection
    const allProfiles = listAllProfiles();
    const selectable = scope ? allProfiles.filter((p) => p.scope === scope) : allProfiles;

    if (selectable.length === 0) {
      console.log("No profiles found. Run 'claudish init' to create one.");
      return;
    }

    const choice = await select({
      message: "Select a profile to edit:",
      choices: selectable.map((p) => ({
        name: `${p.name} ${scopeBadge(p.scope)}${p.isDefault ? ` ${YELLOW}(default)${RESET}` : ""}`,
        value: `${p.scope}:${p.name}`,
      })),
    });

    const [chosenScope, ...nameParts] = choice.split(":");
    scope = chosenScope as ProfileScope;
    profileName = nameParts.join(":");
  } else if (!scope) {
    // Name given but no scope — check where it exists (prefer local)
    const localConfig = loadLocalConfig();
    const globalConfig = loadConfig();
    const inLocal = localConfig?.profiles[profileName] !== undefined;
    const inGlobal = globalConfig.profiles[profileName] !== undefined;

    if (inLocal && inGlobal) {
      scope = await select({
        message: `Profile "${profileName}" exists in both configs. Which one to edit?`,
        choices: [
          { name: "Local", value: "local" as ProfileScope },
          { name: "Global", value: "global" as ProfileScope },
        ],
      });
    } else if (inLocal) {
      scope = "local";
    } else if (inGlobal) {
      scope = "global";
    } else {
      console.log(`Profile "${profileName}" not found.`);
      return;
    }
  }

  const profile = getProfile(profileName, scope);
  if (!profile) {
    console.log(`Profile "${profileName}" not found in ${scope} config.`);
    return;
  }

  console.log(`\n${BOLD}Editing profile: ${profileName}${RESET} ${scopeBadge(scope!)}\n`);
  console.log(`${DIM}Current models:${RESET}`);
  printModelMapping(profile.models);
  console.log("");

  const whatToEdit = await select({
    message: "What do you want to edit?",
    choices: [
      { name: "All models", value: "all" },
      { name: "Opus model only", value: "opus" },
      { name: "Sonnet model only", value: "sonnet" },
      { name: "Haiku model only", value: "haiku" },
      { name: "Subagent model only", value: "subagent" },
      { name: "Description", value: "description" },
      { name: "Cancel", value: "cancel" },
    ],
  });

  if (whatToEdit === "cancel") {
    return;
  }

  if (whatToEdit === "description") {
    const newDescription = await promptForProfileDescription();
    profile.description = newDescription;
    setProfile(profile, scope!);
    console.log(`${GREEN}✓${RESET} Description updated.`);
    return;
  }

  if (whatToEdit === "all") {
    const models = await selectModelsForProfile();
    profile.models = { ...profile.models, ...models };
    setProfile(profile, scope!);
    console.log(`${GREEN}✓${RESET} All models updated.`);
    return;
  }

  // Edit single model
  const tier = whatToEdit as keyof ModelMapping;
  const tierName = tier.charAt(0).toUpperCase() + tier.slice(1);

  const newModel = await selectModel({
    message: `Select new model for ${tierName}:`,
  });

  profile.models[tier] = newModel;
  setProfile(profile, scope!);
  console.log(`${GREEN}✓${RESET} ${tierName} model updated to: ${newModel}`);
}

// ─── Display Helpers ─────────────────────────────────────

/**
 * Print a profile (with optional scope badge)
 */
function printProfile(
  profile: Profile,
  isDefault: boolean,
  verbose = false,
  scope?: ProfileScope
): void {
  const defaultBadge = isDefault ? ` ${YELLOW}(default)${RESET}` : "";
  const scopeTag = scope ? ` ${scopeBadge(scope)}` : "";
  console.log(`${BOLD}${profile.name}${RESET}${defaultBadge}${scopeTag}`);

  if (profile.description) {
    console.log(`  ${DIM}${profile.description}${RESET}`);
  }

  printModelMapping(profile.models);

  if (verbose) {
    console.log(`  ${DIM}Created: ${profile.createdAt}${RESET}`);
    console.log(`  ${DIM}Updated: ${profile.updatedAt}${RESET}`);
  }
}

/**
 * Print a ProfileWithScope (used in list command)
 */
function printProfileWithScope(profile: ProfileWithScope): void {
  const defaultBadge = profile.isDefault ? ` ${YELLOW}(default)${RESET}` : "";
  const badge = scopeBadge(profile.scope, profile.shadowed);
  console.log(`${BOLD}${profile.name}${RESET}${defaultBadge} ${badge}`);

  if (profile.shadowed) {
    console.log(`  ${DIM}(overridden by local profile of same name)${RESET}`);
  }

  if (profile.description) {
    console.log(`  ${DIM}${profile.description}${RESET}`);
  }

  printModelMapping(profile.models);
}

/**
 * Print model mapping
 */
function printModelMapping(models: ModelMapping): void {
  console.log(`  ${CYAN}opus${RESET}:     ${models.opus || DIM + "not set" + RESET}`);
  console.log(`  ${CYAN}sonnet${RESET}:   ${models.sonnet || DIM + "not set" + RESET}`);
  console.log(`  ${CYAN}haiku${RESET}:    ${models.haiku || DIM + "not set" + RESET}`);
  if (models.subagent) {
    console.log(`  ${CYAN}subagent${RESET}: ${models.subagent}`);
  }
}

// ─── Command Router ──────────────────────────────────────

/**
 * Main profile command router
 */
export async function profileCommand(args: string[]): Promise<void> {
  const { scope, remainingArgs } = parseScopeFlag(args);
  const subcommand = remainingArgs[0];
  const name = remainingArgs[1];

  switch (subcommand) {
    case "list":
    case "ls":
      await profileListCommand(scope);
      break;
    case "add":
    case "new":
    case "create":
      await profileAddCommand(scope);
      break;
    case "remove":
    case "rm":
    case "delete":
      await profileRemoveCommand(name, scope);
      break;
    case "use":
    case "default":
    case "set":
      await profileUseCommand(name, scope);
      break;
    case "show":
    case "view":
      await profileShowCommand(name, scope);
      break;
    case "edit":
      await profileEditCommand(name, scope);
      break;
    default:
      // No subcommand - show help
      printProfileHelp();
  }
}

/**
 * Print profile command help
 */
function printProfileHelp(): void {
  console.log(`
${BOLD}Usage:${RESET} claudish profile <command> [options]

${BOLD}Commands:${RESET}
  ${CYAN}list${RESET}, ${CYAN}ls${RESET}              List all profiles
  ${CYAN}add${RESET}, ${CYAN}new${RESET}             Add a new profile
  ${CYAN}remove${RESET} ${DIM}[name]${RESET}        Remove a profile
  ${CYAN}use${RESET} ${DIM}[name]${RESET}           Set default profile
  ${CYAN}show${RESET} ${DIM}[name]${RESET}          Show profile details
  ${CYAN}edit${RESET} ${DIM}[name]${RESET}          Edit a profile

${BOLD}Scope Flags:${RESET}
  ${CYAN}--local${RESET}              Target .claudish.json in the current directory
  ${CYAN}--global${RESET}             Target ~/.claudish/config.json (default)
  ${DIM}If neither flag is given, you'll be prompted interactively.${RESET}

${BOLD}Examples:${RESET}
  claudish profile list
  claudish profile list --local
  claudish profile add --local
  claudish profile add --global
  claudish profile use frontend --local
  claudish profile remove debug --global
  claudish init --local
`);
}
