/**
 * Profile Management Commands
 *
 * Implements CLI commands for managing Claudish profiles:
 * - claudish init: Initial setup wizard
 * - claudish profile list: List all profiles
 * - claudish profile add: Add a new profile
 * - claudish profile remove <name>: Remove a profile
 * - claudish profile use <name>: Set default profile
 * - claudish profile show [name]: Show profile details
 */

import {
  loadConfig,
  saveConfig,
  getProfile,
  getDefaultProfile,
  getProfileNames,
  setProfile,
  deleteProfile,
  setDefaultProfile,
  createProfile,
  listProfiles,
  configExists,
  getConfigPath,
  type Profile,
  type ModelMapping,
} from "./profile-config.js";
import {
  selectModel,
  selectModelsForProfile,
  promptForProfileName,
  promptForProfileDescription,
  selectProfile,
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

/**
 * Initial setup wizard
 * Creates the first profile and config file
 */
export async function initCommand(): Promise<void> {
  console.log(`\n${BOLD}${CYAN}Claudish Setup Wizard${RESET}\n`);

  if (configExists()) {
    const overwrite = await confirm({
      message: "Configuration already exists. Do you want to reconfigure?",
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
  console.log(`${BOLD}Step 1: Create your default profile${RESET}\n`);

  const profileName = await promptForProfileName([]);
  const description = await promptForProfileDescription();

  console.log(`\n${BOLD}Step 2: Select models for each Claude tier${RESET}`);
  console.log(
    `${DIM}These models will be used when Claude Code requests specific model types.${RESET}\n`
  );

  const models = await selectModelsForProfile();

  // Create and save profile
  const profile = createProfile(profileName, models, description);

  // Set as default
  setDefaultProfile(profileName);

  console.log(`\n${GREEN}✓${RESET} Configuration saved to: ${CYAN}${getConfigPath()}${RESET}`);
  console.log(`\n${BOLD}Profile created:${RESET}`);
  printProfile(profile, true);

  console.log(`\n${BOLD}Usage:${RESET}`);
  console.log(`  ${CYAN}claudish${RESET}              # Use default profile`);
  console.log(`  ${CYAN}claudish -p ${profileName}${RESET}   # Use this profile explicitly`);
  console.log(`  ${CYAN}claudish profile add${RESET}  # Add another profile`);
  console.log("");
}

/**
 * List all profiles
 */
export async function profileListCommand(): Promise<void> {
  const profiles = listProfiles();
  const config = loadConfig();

  if (profiles.length === 0) {
    console.log("No profiles found. Run 'claudish init' to create one.");
    return;
  }

  console.log(`\n${BOLD}Claudish Profiles${RESET}\n`);
  console.log(`${DIM}Config: ${getConfigPath()}${RESET}\n`);

  for (const profile of profiles) {
    const isDefault = profile.name === config.defaultProfile;
    printProfile(profile, isDefault);
    console.log("");
  }
}

/**
 * Add a new profile
 */
export async function profileAddCommand(): Promise<void> {
  console.log(`\n${BOLD}${CYAN}Add New Profile${RESET}\n`);

  const existingNames = getProfileNames();
  const name = await promptForProfileName(existingNames);
  const description = await promptForProfileDescription();

  console.log(`\n${BOLD}Select models for this profile:${RESET}\n`);
  const models = await selectModelsForProfile();

  const profile = createProfile(name, models, description);

  console.log(`\n${GREEN}✓${RESET} Profile "${name}" created.`);
  printProfile(profile, false);

  const setAsDefault = await confirm({
    message: "Set this profile as default?",
    default: false,
  });

  if (setAsDefault) {
    setDefaultProfile(name);
    console.log(`${GREEN}✓${RESET} "${name}" is now the default profile.`);
  }
}

/**
 * Remove a profile
 */
export async function profileRemoveCommand(name?: string): Promise<void> {
  const profiles = getProfileNames();

  if (profiles.length === 0) {
    console.log("No profiles to remove.");
    return;
  }

  if (profiles.length === 1) {
    console.log("Cannot remove the last profile. Create another one first.");
    return;
  }

  let profileName = name;

  if (!profileName) {
    const profileList = listProfiles();
    profileName = await selectProfile(
      profileList.map((p) => ({
        name: p.name,
        description: p.description,
        isDefault: p.name === loadConfig().defaultProfile,
      }))
    );
  }

  const profile = getProfile(profileName);
  if (!profile) {
    console.log(`Profile "${profileName}" not found.`);
    return;
  }

  const confirmed = await confirmAction(
    `Are you sure you want to delete profile "${profileName}"?`
  );

  if (!confirmed) {
    console.log("Cancelled.");
    return;
  }

  try {
    deleteProfile(profileName);
    console.log(`${GREEN}✓${RESET} Profile "${profileName}" deleted.`);
  } catch (error) {
    console.error(`Error: ${error}`);
  }
}

/**
 * Set default profile
 */
export async function profileUseCommand(name?: string): Promise<void> {
  const profiles = getProfileNames();

  if (profiles.length === 0) {
    console.log("No profiles found. Run 'claudish init' to create one.");
    return;
  }

  let profileName = name;

  if (!profileName) {
    const profileList = listProfiles();
    profileName = await selectProfile(
      profileList.map((p) => ({
        name: p.name,
        description: p.description,
        isDefault: p.name === loadConfig().defaultProfile,
      }))
    );
  }

  const profile = getProfile(profileName);
  if (!profile) {
    console.log(`Profile "${profileName}" not found.`);
    return;
  }

  setDefaultProfile(profileName);
  console.log(`${GREEN}✓${RESET} "${profileName}" is now the default profile.`);
}

/**
 * Show profile details
 */
export async function profileShowCommand(name?: string): Promise<void> {
  let profileName = name;

  if (!profileName) {
    const config = loadConfig();
    profileName = config.defaultProfile;
  }

  const profile = getProfile(profileName);
  if (!profile) {
    console.log(`Profile "${profileName}" not found.`);
    return;
  }

  const config = loadConfig();
  const isDefault = profileName === config.defaultProfile;

  console.log("");
  printProfile(profile, isDefault, true);
}

/**
 * Edit an existing profile
 */
export async function profileEditCommand(name?: string): Promise<void> {
  const profiles = getProfileNames();

  if (profiles.length === 0) {
    console.log("No profiles found. Run 'claudish init' to create one.");
    return;
  }

  let profileName = name;

  if (!profileName) {
    const profileList = listProfiles();
    profileName = await selectProfile(
      profileList.map((p) => ({
        name: p.name,
        description: p.description,
        isDefault: p.name === loadConfig().defaultProfile,
      }))
    );
  }

  const profile = getProfile(profileName);
  if (!profile) {
    console.log(`Profile "${profileName}" not found.`);
    return;
  }

  console.log(`\n${BOLD}Editing profile: ${profileName}${RESET}\n`);
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
    setProfile(profile);
    console.log(`${GREEN}✓${RESET} Description updated.`);
    return;
  }

  if (whatToEdit === "all") {
    const models = await selectModelsForProfile();
    profile.models = { ...profile.models, ...models };
    setProfile(profile);
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
  setProfile(profile);
  console.log(`${GREEN}✓${RESET} ${tierName} model updated to: ${newModel}`);
}

/**
 * Print a profile
 */
function printProfile(profile: Profile, isDefault: boolean, verbose = false): void {
  const defaultBadge = isDefault ? ` ${YELLOW}(default)${RESET}` : "";
  console.log(`${BOLD}${profile.name}${RESET}${defaultBadge}`);

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

/**
 * Main profile command router
 */
export async function profileCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  const name = args[1];

  switch (subcommand) {
    case "list":
    case "ls":
      await profileListCommand();
      break;
    case "add":
    case "new":
    case "create":
      await profileAddCommand();
      break;
    case "remove":
    case "rm":
    case "delete":
      await profileRemoveCommand(name);
      break;
    case "use":
    case "default":
    case "set":
      await profileUseCommand(name);
      break;
    case "show":
    case "view":
      await profileShowCommand(name);
      break;
    case "edit":
      await profileEditCommand(name);
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

${BOLD}Examples:${RESET}
  claudish profile list
  claudish profile add
  claudish profile use frontend
  claudish profile remove debug
`);
}
