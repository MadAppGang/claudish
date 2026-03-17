/**
 * Claudish Config TUI
 *
 * Interactive configuration menu for claudish. Allows users to:
 *   - Set/remove API keys (stored in ~/.claudish/config.json)
 *   - Configure custom provider endpoints
 *   - Manage profiles (delegates to profile-commands.ts)
 *   - Set routing rules
 *   - Toggle telemetry
 *   - View current configuration
 *
 * Usage: claudish config
 */

import { select, input, password, confirm } from "@inquirer/prompts";
import {
  loadConfig,
  saveConfig,
  setApiKey,
  removeApiKey,
  setEndpoint,
  removeEndpoint,
} from "./profile-config.js";

// ANSI colors (matches profile-commands.ts)
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

// ─── Provider Definitions ────────────────────────────────

interface ProviderDef {
  name: string;
  displayName: string;
  apiKeyEnvVar: string;
  description: string;
  keyUrl: string;
  endpointEnvVar?: string;
  defaultEndpoint?: string;
  aliases?: string[];
}

const PROVIDERS: ProviderDef[] = [
  {
    name: "openrouter",
    displayName: "OpenRouter",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
    description: "580+ models, default backend",
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    name: "gemini",
    displayName: "Google Gemini",
    apiKeyEnvVar: "GEMINI_API_KEY",
    description: "Direct Gemini API (g@, google@)",
    keyUrl: "https://aistudio.google.com/app/apikey",
    endpointEnvVar: "GEMINI_BASE_URL",
    defaultEndpoint: "https://generativelanguage.googleapis.com",
  },
  {
    name: "openai",
    displayName: "OpenAI",
    apiKeyEnvVar: "OPENAI_API_KEY",
    description: "Direct OpenAI API (oai@)",
    keyUrl: "https://platform.openai.com/api-keys",
    endpointEnvVar: "OPENAI_BASE_URL",
    defaultEndpoint: "https://api.openai.com",
  },
  {
    name: "minimax",
    displayName: "MiniMax",
    apiKeyEnvVar: "MINIMAX_API_KEY",
    description: "MiniMax API (mm@, mmax@)",
    keyUrl: "https://www.minimaxi.com/",
    endpointEnvVar: "MINIMAX_BASE_URL",
    defaultEndpoint: "https://api.minimax.io",
  },
  {
    name: "kimi",
    displayName: "Kimi / Moonshot",
    apiKeyEnvVar: "MOONSHOT_API_KEY",
    description: "Kimi API (kimi@, moon@)",
    keyUrl: "https://platform.moonshot.cn/",
    aliases: ["KIMI_API_KEY"],
    endpointEnvVar: "MOONSHOT_BASE_URL",
    defaultEndpoint: "https://api.moonshot.ai",
  },
  {
    name: "glm",
    displayName: "GLM / Zhipu",
    apiKeyEnvVar: "ZHIPU_API_KEY",
    description: "GLM API (glm@, zhipu@)",
    keyUrl: "https://open.bigmodel.cn/",
    aliases: ["GLM_API_KEY"],
    endpointEnvVar: "ZHIPU_BASE_URL",
    defaultEndpoint: "https://open.bigmodel.cn",
  },
  {
    name: "zai",
    displayName: "Z.AI",
    apiKeyEnvVar: "ZAI_API_KEY",
    description: "Z.AI API (zai@)",
    keyUrl: "https://z.ai/",
    endpointEnvVar: "ZAI_BASE_URL",
    defaultEndpoint: "https://api.z.ai",
  },
  {
    name: "ollamacloud",
    displayName: "OllamaCloud",
    apiKeyEnvVar: "OLLAMA_API_KEY",
    description: "Cloud Ollama (oc@, llama@)",
    keyUrl: "https://ollama.com/account",
    endpointEnvVar: "OLLAMACLOUD_BASE_URL",
    defaultEndpoint: "https://ollama.com",
  },
  {
    name: "opencode",
    displayName: "OpenCode Zen",
    apiKeyEnvVar: "OPENCODE_API_KEY",
    description: "OpenCode Zen (zen@) — optional for free models",
    keyUrl: "https://opencode.ai/",
    endpointEnvVar: "OPENCODE_BASE_URL",
    defaultEndpoint: "https://opencode.ai/zen",
  },
  {
    name: "litellm",
    displayName: "LiteLLM",
    apiKeyEnvVar: "LITELLM_API_KEY",
    description: "LiteLLM proxy (ll@, litellm@)",
    keyUrl: "https://docs.litellm.ai/",
    endpointEnvVar: "LITELLM_BASE_URL",
  },
  {
    name: "vertex",
    displayName: "Vertex AI",
    apiKeyEnvVar: "VERTEX_API_KEY",
    description: "Vertex AI Express (v@, vertex@)",
    keyUrl: "https://console.cloud.google.com/vertex-ai",
  },
  {
    name: "poe",
    displayName: "Poe",
    apiKeyEnvVar: "POE_API_KEY",
    description: "Poe API (poe@)",
    keyUrl: "https://poe.com/",
  },
];

// ─── Helpers ─────────────────────────────────────────────

/**
 * Mask a key for display — show first 6 and last 4 chars
 */
function maskKey(key: string): string {
  if (key.length <= 12) return "***";
  return key.slice(0, 6) + "..." + key.slice(-4);
}

// ─── Connection Tests ─────────────────────────────────────

async function testProviderConnection(provider: ProviderDef, key: string): Promise<void> {
  console.log(`${DIM}Testing ${provider.displayName}...${RESET}`);

  try {
    let url: string;
    let headers: Record<string, string>;

    if (provider.name === "openrouter") {
      url = "https://openrouter.ai/api/v1/models";
      headers = { Authorization: `Bearer ${key}` };
    } else if (provider.name === "gemini") {
      url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
      headers = {};
    } else if (provider.name === "openai") {
      url = "https://api.openai.com/v1/models";
      headers = { Authorization: `Bearer ${key}` };
    } else if (provider.name === "litellm") {
      const config = loadConfig();
      const baseUrl = config.endpoints?.["LITELLM_BASE_URL"] || process.env.LITELLM_BASE_URL;
      if (!baseUrl) {
        console.log(`${YELLOW}LiteLLM requires a base URL. Configure it in Providers.${RESET}`);
        return;
      }
      url = `${baseUrl}/v1/models`;
      headers = { Authorization: `Bearer ${key}` };
    } else {
      // Generic: just confirm key is set
      console.log(
        `${GREEN}Key is set${RESET} (${maskKey(key)}). No automated test available for ${provider.displayName}.`
      );
      return;
    }

    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      console.log(`${GREEN}Connection successful!${RESET} API key is valid.`);
    } else {
      const text = await response.text().catch(() => "");
      console.log(`${YELLOW}HTTP ${response.status}:${RESET} ${text.slice(0, 100)}`);
    }
  } catch (error) {
    console.log(
      `${YELLOW}Connection failed:${RESET} ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// ─── API Keys Sub-menu ───────────────────────────────────

async function configureProviderKey(provider: ProviderDef): Promise<void> {
  const config = loadConfig();
  const currentKey = config.apiKeys?.[provider.apiKeyEnvVar];
  const envKey = process.env[provider.apiKeyEnvVar];

  console.log(`\n${BOLD}${provider.displayName}${RESET}`);
  console.log(`${DIM}${provider.description}${RESET}`);
  console.log(`${DIM}Get your API key from: ${CYAN}${provider.keyUrl}${RESET}`);

  if (envKey) {
    console.log(`${DIM}Environment: ${GREEN}${maskKey(envKey)}${RESET}`);
  }
  if (currentKey) {
    console.log(`${DIM}Config:      ${GREEN}${maskKey(currentKey)}${RESET}`);
  }
  console.log("");

  const actionChoices: Array<{ name: string; value: string }> = [
    { name: "Set API key", value: "set" },
  ];
  if (currentKey) {
    actionChoices.push({ name: "Remove stored key", value: "remove" });
  }
  actionChoices.push({ name: "Test connection", value: "test" });
  actionChoices.push({ name: "<- Back", value: "back" });

  const action = await select({
    message: `Action for ${provider.displayName}:`,
    choices: actionChoices,
  });

  if (action === "back") return;

  if (action === "set") {
    const key = await password({
      message: `Enter ${provider.apiKeyEnvVar}:`,
      mask: "*",
    });

    if (key.trim()) {
      setApiKey(provider.apiKeyEnvVar, key.trim());
      // Also set in process.env for current session
      process.env[provider.apiKeyEnvVar] = key.trim();
      console.log(`${GREEN}API key saved${RESET} to ~/.claudish/config.json`);
      console.log(`${DIM}This key will be loaded automatically on next run.${RESET}`);
    } else {
      console.log(`${YELLOW}No key entered, nothing saved.${RESET}`);
    }
  }

  if (action === "remove") {
    const confirmed = await confirm({ message: "Remove stored API key?", default: false });
    if (confirmed) {
      removeApiKey(provider.apiKeyEnvVar);
      console.log(`${GREEN}API key removed${RESET} from config.`);
    }
  }

  if (action === "test") {
    const key = currentKey || envKey;
    if (!key) {
      console.log(`${YELLOW}No API key set. Please set a key first.${RESET}`);
      return;
    }
    await testProviderConnection(provider, key);
  }
}

async function configApiKeys(): Promise<void> {
  while (true) {
    const config = loadConfig();

    const choices = PROVIDERS.map((p) => {
      const envSet = !!process.env[p.apiKeyEnvVar];
      const configSet = !!config.apiKeys?.[p.apiKeyEnvVar];

      let status: string;
      if (envSet && configSet) {
        status = `${GREEN}set (env + config)${RESET}`;
      } else if (envSet) {
        status = `${GREEN}set (env)${RESET}`;
      } else if (configSet) {
        status = `${GREEN}set (config)${RESET}`;
      } else {
        status = `${DIM}not set${RESET}`;
      }

      return {
        name: `${p.displayName.padEnd(18)} ${status}`,
        value: p.name,
        description: p.description,
      };
    });

    choices.push({ name: "<- Back", value: "back", description: "" });

    const selected = await select({
      message: "Select a provider to configure its API key:",
      choices,
    });

    if (selected === "back") return;

    const provider = PROVIDERS.find((p) => p.name === selected);
    if (!provider) return;
    await configureProviderKey(provider);
    console.log("");
  }
}

// ─── Endpoints Sub-menu ───────────────────────────────────

async function configEndpoints(): Promise<void> {
  const configurable = PROVIDERS.filter((p) => p.endpointEnvVar);

  while (true) {
    const config = loadConfig();

    const choices = configurable.map((p) => {
      const envVar = p.endpointEnvVar!;
      const configVal = config.endpoints?.[envVar];
      const envVal = process.env[envVar];

      let status: string;
      if (envVal && configVal) {
        status = `${GREEN}custom (env + config)${RESET}`;
      } else if (envVal) {
        status = `${GREEN}custom (env)${RESET}`;
      } else if (configVal) {
        status = `${GREEN}${configVal.slice(0, 30)}${configVal.length > 30 ? "..." : ""}${RESET}`;
      } else {
        status = `${DIM}default${RESET}`;
      }

      return {
        name: `${p.displayName.padEnd(18)} ${status}`,
        value: p.name,
        description: `${envVar}${p.defaultEndpoint ? ` (default: ${p.defaultEndpoint})` : ""}`,
      };
    });

    choices.push({ name: "<- Back", value: "back", description: "" });

    const selected = await select({
      message: "Select a provider to configure its endpoint:",
      choices,
    });

    if (selected === "back") return;

    const provider = configurable.find((p) => p.name === selected);
    if (!provider || !provider.endpointEnvVar) return;

    await configureProviderEndpoint(provider);
    console.log("");
  }
}

async function configureProviderEndpoint(provider: ProviderDef): Promise<void> {
  const envVar = provider.endpointEnvVar!;
  const config = loadConfig();
  const currentVal = config.endpoints?.[envVar];
  const envVal = process.env[envVar];

  console.log(`\n${BOLD}${provider.displayName} Endpoint${RESET}`);
  console.log(`${DIM}Env var: ${CYAN}${envVar}${RESET}`);
  if (provider.defaultEndpoint) {
    console.log(`${DIM}Default: ${provider.defaultEndpoint}${RESET}`);
  }
  if (envVal) {
    console.log(`${DIM}Environment: ${GREEN}${envVal}${RESET}`);
  }
  if (currentVal) {
    console.log(`${DIM}Config:      ${GREEN}${currentVal}${RESET}`);
  }
  console.log("");

  const actionChoices: Array<{ name: string; value: string }> = [
    { name: "Set custom endpoint URL", value: "set" },
  ];
  if (currentVal) {
    actionChoices.push({ name: "Reset to default (remove stored)", value: "remove" });
  }
  actionChoices.push({ name: "<- Back", value: "back" });

  const action = await select({
    message: `Action for ${provider.displayName} endpoint:`,
    choices: actionChoices,
  });

  if (action === "back") return;

  if (action === "set") {
    const url = await input({
      message: `Enter ${envVar}:`,
      default: currentVal || provider.defaultEndpoint || "",
    });

    if (url.trim()) {
      setEndpoint(envVar, url.trim());
      process.env[envVar] = url.trim();
      console.log(`${GREEN}Endpoint saved${RESET} to ~/.claudish/config.json`);
    } else {
      console.log(`${YELLOW}No URL entered, nothing saved.${RESET}`);
    }
  }

  if (action === "remove") {
    const confirmed = await confirm({
      message: `Remove stored endpoint? (will revert to default: ${provider.defaultEndpoint || "none"})`,
      default: false,
    });
    if (confirmed) {
      removeEndpoint(envVar);
      console.log(`${GREEN}Endpoint removed${RESET} from config.`);
    }
  }
}

// ─── Profiles Sub-menu ────────────────────────────────────

async function configProfiles(): Promise<void> {
  while (true) {
    const choice = await select({
      message: "Profile management:",
      choices: [
        { name: "List all profiles", value: "list" },
        { name: "Add a new profile", value: "add" },
        { name: "Edit an existing profile", value: "edit" },
        { name: "Set default profile", value: "use" },
        { name: "Remove a profile", value: "remove" },
        { name: "<- Back", value: "back" },
      ],
    });

    if (choice === "back") return;

    const { profileCommand } = await import("./profile-commands.js");
    await profileCommand([choice]).catch((err: unknown) => {
      if (
        err &&
        typeof err === "object" &&
        "name" in err &&
        (err as { name: string }).name === "ExitPromptError"
      ) {
        return;
      }
      throw err;
    });
    console.log("");
  }
}

// ─── Routing Rules Sub-menu ───────────────────────────────

async function configRouting(): Promise<void> {
  while (true) {
    const config = loadConfig();
    const rules = config.routing ?? {};
    const ruleCount = Object.keys(rules).length;

    console.log(`\n${BOLD}Routing Rules${RESET}`);
    if (ruleCount === 0) {
      console.log(`${DIM}No custom routing rules configured.${RESET}`);
    } else {
      console.log(`${DIM}${ruleCount} rule(s) defined:${RESET}`);
      for (const [pattern, chain] of Object.entries(rules)) {
        console.log(`  ${CYAN}${pattern}${RESET} -> ${chain.join(" | ")}`);
      }
    }
    console.log(
      `\n${DIM}Format: pattern -> provider[@model], with fallback chain separated by commas.${RESET}`
    );
    console.log(
      `${DIM}Example pattern: "kimi-*" -> ["kimi@kimi-k2", "openrouter@kimi-k2"]${RESET}`
    );
    console.log("");

    const action = await select({
      message: "Routing rules actions:",
      choices: [
        { name: "Add a routing rule", value: "add" },
        ...(ruleCount > 0 ? [{ name: "Remove a routing rule", value: "remove" }] : []),
        { name: "Clear all routing rules", value: "clear", ...(ruleCount === 0 ? {} : {}) },
        { name: "<- Back", value: "back" },
      ],
    });

    if (action === "back") return;

    if (action === "add") {
      const pattern = await input({
        message: "Model name pattern (e.g. kimi-*, gpt-4o, *):",
      });

      if (!pattern.trim()) {
        console.log(`${YELLOW}No pattern entered.${RESET}`);
        continue;
      }

      const chainStr = await input({
        message: "Routing chain (comma-separated, e.g. kimi@kimi-k2,openrouter@kimi/kimi-k2):",
      });

      if (!chainStr.trim()) {
        console.log(`${YELLOW}No routing chain entered.${RESET}`);
        continue;
      }

      const chain = chainStr
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      if (!config.routing) config.routing = {};
      config.routing[pattern.trim()] = chain;
      saveConfig(config);
      console.log(`${GREEN}Routing rule added:${RESET} ${pattern.trim()} -> ${chain.join(" | ")}`);
    }

    if (action === "remove" && ruleCount > 0) {
      const patterns = Object.keys(rules);
      const toRemove = await select({
        message: "Select rule to remove:",
        choices: patterns.map((p) => ({
          name: `${p} -> ${rules[p].join(" | ")}`,
          value: p,
        })),
      });

      const confirmed = await confirm({
        message: `Remove routing rule for "${toRemove}"?`,
        default: false,
      });

      if (confirmed) {
        if (config.routing) {
          delete config.routing[toRemove];
          if (Object.keys(config.routing).length === 0) {
            delete config.routing;
          }
          saveConfig(config);
          console.log(`${GREEN}Routing rule removed.${RESET}`);
        }
      }
    }

    if (action === "clear") {
      if (ruleCount === 0) {
        console.log(`${DIM}No routing rules to clear.${RESET}`);
        continue;
      }
      const confirmed = await confirm({
        message: `Clear all ${ruleCount} routing rule(s)?`,
        default: false,
      });
      if (confirmed) {
        delete config.routing;
        saveConfig(config);
        console.log(`${GREEN}All routing rules cleared.${RESET}`);
      }
    }

    console.log("");
  }
}

// ─── Telemetry Sub-menu ───────────────────────────────────

async function configTelemetry(): Promise<void> {
  const config = loadConfig();
  const telemetry = config.telemetry;
  const envOverride = process.env.CLAUDISH_TELEMETRY;
  const envDisabled = envOverride === "0" || envOverride === "false" || envOverride === "off";

  console.log(`\n${BOLD}Telemetry${RESET}`);

  if (envDisabled) {
    console.log(`Status: ${YELLOW}DISABLED${RESET} (CLAUDISH_TELEMETRY env var override)`);
  } else if (!telemetry) {
    console.log(`Status: ${DIM}not yet configured${RESET} (disabled until you opt in)`);
  } else {
    const state = telemetry.enabled ? `${GREEN}ENABLED${RESET}` : `${YELLOW}DISABLED${RESET}`;
    console.log(`Status: ${state}`);
    if (telemetry.askedAt) {
      console.log(`${DIM}Configured: ${telemetry.askedAt}${RESET}`);
    }
  }

  console.log(`
${DIM}When enabled, anonymous error reports include:${RESET}
  ${DIM}- Claudish version, error type, provider name, model ID${RESET}
  ${DIM}- Platform, runtime, install method${RESET}
  ${DIM}- Sanitized error message (no paths, no credentials)${RESET}
  ${DIM}- Ephemeral session ID (not stored, not correlatable)${RESET}

${DIM}Never collected: prompt content, AI responses, API keys, file paths.${RESET}
`);

  const action = await select({
    message: "Telemetry action:",
    choices: [
      {
        name: telemetry?.enabled ? "Disable telemetry" : "Enable telemetry",
        value: telemetry?.enabled ? "off" : "on",
      },
      { name: "Reset consent (will prompt again on next error)", value: "reset" },
      { name: "<- Back", value: "back" },
    ],
  });

  if (action === "back") return;

  if (action === "on") {
    config.telemetry = {
      ...(config.telemetry ?? {}),
      enabled: true,
      askedAt: config.telemetry?.askedAt ?? new Date().toISOString(),
    };
    saveConfig(config);
    console.log(`${GREEN}Telemetry enabled.${RESET} Anonymous error reports will be sent.`);
  }

  if (action === "off") {
    config.telemetry = {
      ...(config.telemetry ?? {}),
      enabled: false,
      askedAt: config.telemetry?.askedAt ?? new Date().toISOString(),
    };
    saveConfig(config);
    console.log(`${YELLOW}Telemetry disabled.${RESET} No error reports will be sent.`);
  }

  if (action === "reset") {
    const confirmed = await confirm({
      message: "Reset telemetry consent? You will be prompted again on the next error.",
      default: false,
    });
    if (confirmed && config.telemetry) {
      delete config.telemetry.askedAt;
      config.telemetry.enabled = false;
      saveConfig(config);
      console.log(`${GREEN}Telemetry consent reset.${RESET}`);
    }
  }

  console.log("");
}

// ─── Show Config ──────────────────────────────────────────

function showCurrentConfig(): void {
  const config = loadConfig();

  console.log(`\n${BOLD}Current Configuration${RESET}`);
  console.log(`${DIM}~/.claudish/config.json${RESET}\n`);

  // Default profile
  console.log(`${BOLD}Default Profile:${RESET} ${CYAN}${config.defaultProfile}${RESET}`);
  const profileCount = Object.keys(config.profiles).length;
  console.log(
    `${BOLD}Profiles:${RESET} ${profileCount} defined (run ${CYAN}claudish profile list${RESET} for details)\n`
  );

  // API Keys
  console.log(`${BOLD}API Keys${RESET} ${DIM}(env var → source)${RESET}`);
  const allKeyVars = PROVIDERS.map((p) => p.apiKeyEnvVar);
  let anyKey = false;
  for (const envVar of allKeyVars) {
    const envVal = process.env[envVar];
    const configVal = config.apiKeys?.[envVar];
    if (!envVal && !configVal) continue;
    anyKey = true;

    const provider = PROVIDERS.find((p) => p.apiKeyEnvVar === envVar);
    const displayName = provider?.displayName ?? envVar;

    let sourceStr: string;
    if (envVal && configVal) {
      sourceStr = `${GREEN}${maskKey(envVal)}${RESET} ${DIM}(env, config also set)${RESET}`;
    } else if (envVal) {
      sourceStr = `${GREEN}${maskKey(envVal)}${RESET} ${DIM}(env only)${RESET}`;
    } else {
      sourceStr = `${GREEN}${maskKey(configVal!)}${RESET} ${DIM}(config)${RESET}`;
    }

    console.log(`  ${displayName.padEnd(16)} ${sourceStr}`);
  }
  if (!anyKey) {
    console.log(`  ${DIM}No API keys configured.${RESET}`);
  }
  console.log("");

  // Custom Endpoints
  const configuredEndpoints = Object.entries(config.endpoints ?? {});
  const envEndpoints = PROVIDERS.filter(
    (p) =>
      p.endpointEnvVar && process.env[p.endpointEnvVar] && !config.endpoints?.[p.endpointEnvVar!]
  );
  if (configuredEndpoints.length > 0 || envEndpoints.length > 0) {
    console.log(`${BOLD}Custom Endpoints${RESET}`);
    for (const [k, v] of configuredEndpoints) {
      const provider = PROVIDERS.find((p) => p.endpointEnvVar === k);
      const displayName = provider?.displayName ?? k;
      console.log(`  ${displayName.padEnd(16)} ${GREEN}${v}${RESET} ${DIM}(config)${RESET}`);
    }
    for (const p of envEndpoints) {
      const envVal = process.env[p.endpointEnvVar!]!;
      console.log(
        `  ${p.displayName.padEnd(16)} ${GREEN}${envVal}${RESET} ${DIM}(env only)${RESET}`
      );
    }
    console.log("");
  }

  // Routing rules
  const rules = config.routing ?? {};
  const ruleCount = Object.keys(rules).length;
  if (ruleCount > 0) {
    console.log(`${BOLD}Routing Rules${RESET}`);
    for (const [pattern, chain] of Object.entries(rules)) {
      console.log(`  ${CYAN}${pattern}${RESET} -> ${chain.join(" | ")}`);
    }
    console.log("");
  }

  // Telemetry
  const telemetry = config.telemetry;
  const telemetryStatus = !telemetry
    ? `${DIM}not configured${RESET}`
    : telemetry.enabled
      ? `${GREEN}enabled${RESET}`
      : `${YELLOW}disabled${RESET}`;
  console.log(`${BOLD}Telemetry:${RESET} ${telemetryStatus}`);
  console.log("");
}

// ─── Main Menu ────────────────────────────────────────────

/**
 * Entry point for `claudish config`
 */
export async function configCommand(): Promise<void> {
  console.log(`\n${BOLD}${CYAN}Claudish Configuration${RESET}\n`);

  while (true) {
    const choice = await select({
      message: "What would you like to configure?",
      choices: [
        { name: "API Keys         -- Set up provider API keys", value: "apikeys" },
        { name: "Providers        -- Configure custom endpoints", value: "providers" },
        { name: "Profiles         -- Manage model profiles", value: "profiles" },
        { name: "Routing Rules    -- Custom model routing", value: "routing" },
        { name: "Telemetry        -- Toggle anonymous error reporting", value: "telemetry" },
        { name: "Show Config      -- View current configuration", value: "show" },
        { name: "<- Exit", value: "exit" },
      ],
    });

    switch (choice) {
      case "apikeys":
        await configApiKeys();
        break;
      case "providers":
        await configEndpoints();
        break;
      case "profiles":
        await configProfiles();
        break;
      case "routing":
        await configRouting();
        break;
      case "telemetry":
        await configTelemetry();
        break;
      case "show":
        showCurrentConfig();
        break;
      case "exit":
        return;
    }

    console.log("");
  }
}
