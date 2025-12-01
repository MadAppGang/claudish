import { ENV } from "./config.js";
import type { ClaudishConfig } from "./types.js";
import { loadModelInfo, getAvailableModels } from "./model-loader.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fuzzyScore } from "./utils.js";
import { getProfile, getDefaultProfile, getModelMapping } from "./profile-config.js";
import { getAvailableApiKeys, categorizeModelsByAccess, filterModelsByQuery, printSetupGuidance, getApiKeyDescription } from "./model-discovery.js";

// Read version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf-8")
);
const VERSION = packageJson.version;

/**
 * Check if the command is a model listing command that doesn't need API key validation
 */
function isModelListingCommand(args: string[]): boolean {
  return args.includes("--models") ||
         args.includes("-s") ||
         args.includes("--search") ||
         args.includes("--top-models") ||
         args.includes("--list-models");
}

/**
 * Get current version
 */
export function getVersion(): string {
  return VERSION;
}

/**
 * Parse CLI arguments and environment variables
 */
export async function parseArgs(args: string[]): Promise<ClaudishConfig> {
  const config: Partial<ClaudishConfig> = {
    model: undefined, // Will prompt interactively if not provided
    autoApprove: true, // Skip permissions by default (--dangerously-skip-permissions)
    dangerous: false,
    interactive: false, // Single-shot mode by default
    debug: false, // No debug logging by default
    logLevel: "info", // Default to info level (structured logging with truncated content)
    quiet: undefined, // Will be set based on mode (true for single-shot, false for interactive)
    jsonOutput: false, // No JSON output by default
    monitor: false, // Monitor mode disabled by default
    stdin: false, // Read prompt from stdin instead of args
    freeOnly: false, // Show all models by default
    claudeArgs: [],
  };

  // Check for environment variable overrides
  // Priority order: CLAUDISH_MODEL (Claudish-specific) > ANTHROPIC_MODEL (Claude Code standard)
  // CLI --model flag will override both (handled later in arg parsing)
  const claudishModel = process.env[ENV.CLAUDISH_MODEL];
  const anthropicModel = process.env[ENV.ANTHROPIC_MODEL];

  if (claudishModel) {
    config.model = claudishModel; // Claudish-specific takes priority
  } else if (anthropicModel) {
    config.model = anthropicModel; // Fall back to Claude Code standard
  }

  // Parse model mappings from env vars
  // Priority: CLAUDISH_MODEL_* (highest) > ANTHROPIC_DEFAULT_* / CLAUDE_CODE_SUBAGENT_MODEL (fallback)
  config.modelOpus = process.env[ENV.CLAUDISH_MODEL_OPUS] || process.env[ENV.ANTHROPIC_DEFAULT_OPUS_MODEL];
  config.modelSonnet = process.env[ENV.CLAUDISH_MODEL_SONNET] || process.env[ENV.ANTHROPIC_DEFAULT_SONNET_MODEL];
  config.modelHaiku = process.env[ENV.CLAUDISH_MODEL_HAIKU] || process.env[ENV.ANTHROPIC_DEFAULT_HAIKU_MODEL];
  config.modelSubagent = process.env[ENV.CLAUDISH_MODEL_SUBAGENT] || process.env[ENV.CLAUDE_CODE_SUBAGENT_MODEL];

  const envPort = process.env[ENV.CLAUDISH_PORT];
  if (envPort) {
    const port = Number.parseInt(envPort, 10);
    if (!Number.isNaN(port)) {
      config.port = port;
    }
  }

  // Parse command line arguments
  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "--model" || arg === "-m") {
      const modelArg = args[++i];
      if (!modelArg) {
        console.error("--model requires a value");
        await printAllModels(false, false); // jsonOutput=false, forceUpdate=false
        process.exit(1);
      }
      config.model = modelArg; // Accept any model ID
    } else if (arg === "--model-opus") { // Model mapping flags
      const val = args[++i];
      if (val) config.modelOpus = val;
    } else if (arg === "--model-sonnet") {
      const val = args[++i];
      if (val) config.modelSonnet = val;
    } else if (arg === "--model-haiku") {
      const val = args[++i];
      if (val) config.modelHaiku = val;
    } else if (arg === "--model-subagent") {
      const val = args[++i];
      if (val) config.modelSubagent = val;
    } else if (arg === "--port") {
      const portArg = args[++i];
      if (!portArg) {
        console.error("--port requires a value");
        process.exit(1);
      }
      const port = Number.parseInt(portArg, 10);
      if (Number.isNaN(port) || port < 1 || port > 65535) {
        console.error(`Invalid port: ${portArg}`);
        process.exit(1);
      }
      config.port = port;
    } else if (arg === "--no-auto-approve") {
      config.autoApprove = false;
    } else if (arg === "--dangerous") {
      config.dangerous = true;
    } else if (arg === "--interactive" || arg === "-i") {
      config.interactive = true;
    } else if (arg === "--debug" || arg === "-d") {
      config.debug = true;
    } else if (arg === "--log-level") {
      const levelArg = args[++i];
      if (!levelArg || !["debug", "info", "minimal"].includes(levelArg)) {
        console.error("--log-level requires one of: debug, info, minimal");
        process.exit(1);
      }
      config.logLevel = levelArg as "debug" | "info" | "minimal";
    } else if (arg === "--quiet" || arg === "-q") {
      config.quiet = true;
    } else if (arg === "--verbose" || arg === "-v") {
      config.quiet = false;
    } else if (arg === "--json") {
      config.jsonOutput = true;
    } else if (arg === "--monitor") {
      config.monitor = true;
    } else if (arg === "--stdin") {
      config.stdin = true;
    } else if (arg === "--free") {
      config.freeOnly = true;
    } else if (arg === "--profile" || arg === "-p") {
      const profileArg = args[++i];
      if (!profileArg) {
        console.error("--profile requires a profile name");
        process.exit(1);
      }
      config.profile = profileArg;
    } else if (arg === "--cost-tracker") {
      // Enable cost tracking for this session
      config.costTracking = true;
      // In monitor mode, we'll track costs instead of proxying
      if (!config.monitor) {
        config.monitor = true; // Switch to monitor mode to track requests
      }
    } else if (arg === "--audit-costs") {
      // Special mode to just show cost analysis
      config.auditCosts = true;
    } else if (arg === "--reset-costs") {
      // Reset accumulated cost statistics
      config.resetCosts = true;
    } else if (arg === "--version") {
      printVersion();
      process.exit(0);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--help-ai") {
      printAIAgentGuide();
      process.exit(0);
    } else if (arg === "--init") {
      await initializeClaudishSkill();
      process.exit(0);
    } else if (arg === "--top-models") {
      // Show recommended/top models using smart discovery system
      const hasJsonFlag = args.includes("--json");
      const forceUpdate = args.includes("--force-update");

      // Use smart discovery system instead of hardcoded OpenRouter-only models
      await printAllModels(hasJsonFlag, forceUpdate);
      process.exit(0);
    } else if (arg === "--models" || arg === "-s" || arg === "--search") {
      // Check for optional search query (next arg that doesn't start with --)
      const nextArg = args[i + 1];
      const hasQuery = nextArg && !nextArg.startsWith("--");
      const query = hasQuery ? args[++i] : null;

      const hasJsonFlag = args.includes("--json");
      const forceUpdate = args.includes("--force-update");

      if (query) {
        // Search mode: fuzzy search all models
        await searchAndPrintModels(query, forceUpdate);
      } else {
        // List mode: show all models grouped by provider
        await printAllModels(hasJsonFlag, forceUpdate);
      }
      process.exit(0);
    } else {
      // All remaining args go to claude CLI
      config.claudeArgs = args.slice(i);
      break;
    }

    i++;
  }

  // Determine if this will be interactive mode BEFORE API key check
  // If no prompt provided and not explicitly interactive, default to interactive mode
  // Exception: --stdin mode reads prompt from stdin, so don't default to interactive
  if ((!config.claudeArgs || config.claudeArgs.length === 0) && !config.stdin) {
    config.interactive = true;
  }

  // Handle API keys based on mode
  if (config.monitor) {
    // Monitor mode: extracts API key from Claude Code's requests
    // No need for user to provide API key - we intercept it from Claude Code
    // IMPORTANT: Unset ANTHROPIC_API_KEY if it's a placeholder, so Claude Code uses its native auth
    if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.includes('placeholder')) {
      delete process.env.ANTHROPIC_API_KEY;
      if (!config.quiet) {
        console.log("[claudish] Removed placeholder API key - Claude Code will use native authentication");
      }
    }

    if (!config.quiet) {
      console.log("[claudish] Monitor mode enabled - proxying to real Anthropic API");
      console.log("[claudish] API key will be extracted from Claude Code's requests");
      console.log("[claudish] Ensure you are logged in to Claude Code (claude auth login)");
    }
  } else {
    // Check if this is a model listing command that doesn't need API validation
    const isListing = isModelListingCommand(args);

    if (!isListing) {
      // OpenRouter/Poe mode: requires API key for the selected provider
      const openrouterApiKey = process.env[ENV.OPENROUTER_API_KEY];
      const poeApiKey = process.env[ENV.POE_API_KEY];

      // Determine which provider is needed based on model
      const needsPoe = config.model?.startsWith("poe/") || false;
      const needsOpenRouter = !needsPoe; // Default to OpenRouter for non-Poe models

      if (needsPoe) {
        // Poe mode: requires Poe API key
        if (!poeApiKey) {
          if (!config.interactive) {
            console.error("Error: POE_API_KEY environment variable is required for Poe models");
            console.error("Get your API key from: https://poe.com/blog/introducing-the-poe-api");
            console.error("");
            console.error("Set it now:");
            console.error("  export POE_API_KEY='your-poe-api-key'");
            process.exit(1);
          }
          // Will be prompted for in interactive mode
          config.poeApiKey = undefined;
        } else {
          config.poeApiKey = poeApiKey;
        }
        config.openrouterApiKey = openrouterApiKey; // May be needed for other models
      } else if (needsOpenRouter) {
        // OpenRouter mode: requires OpenRouter API key
        if (!openrouterApiKey) {
          if (!config.interactive) {
            console.error("Error: OPENROUTER_API_KEY environment variable is required for OpenRouter models");
            console.error("Get your API key from: https://openrouter.ai/keys");
            console.error("");
            console.error("Set it now:");
            console.error("  export OPENROUTER_API_KEY='sk-or-v1-...'");
            process.exit(1);
          }
          // Will be prompted for in interactive mode
          config.openrouterApiKey = undefined;
        } else {
          config.openrouterApiKey = openrouterApiKey;
        }
        config.poeApiKey = poeApiKey; // May be needed if user switches to Poe models
      } else {
        // No model specified yet, need both API keys for flexibility
        config.openrouterApiKey = openrouterApiKey;
        config.poeApiKey = poeApiKey;
      }
    } else {
      // Model listing command - just set API keys without validation
      config.openrouterApiKey = process.env[ENV.OPENROUTER_API_KEY];
      config.poeApiKey = process.env[ENV.POE_API_KEY];
    }

    // Note: ANTHROPIC_API_KEY is NOT required here
    // claude-runner.ts automatically sets a placeholder if not provided (see line 138)
    // This allows single-variable setup - users only need OPENROUTER_API_KEY and/or POE_API_KEY
    config.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  }

  // Set default for quiet mode if not explicitly set
  // Single-shot mode: quiet by default
  // Interactive mode: verbose by default
  // JSON output: always quiet
  if (config.quiet === undefined) {
    config.quiet = !config.interactive;
  }
  if (config.jsonOutput) {
    config.quiet = true; // JSON output mode is always quiet
  }

  // Apply profile model mappings (profile < CLI flags < env vars for override order)
  // Profile provides defaults, CLI flags override, env vars override CLI
  if (config.profile || !config.modelOpus || !config.modelSonnet || !config.modelHaiku || !config.modelSubagent) {
    const profileModels = getModelMapping(config.profile);

    // Apply profile models only if not set by CLI flags
    if (!config.modelOpus && profileModels.opus) {
      config.modelOpus = profileModels.opus;
    }
    if (!config.modelSonnet && profileModels.sonnet) {
      config.modelSonnet = profileModels.sonnet;
    }
    if (!config.modelHaiku && profileModels.haiku) {
      config.modelHaiku = profileModels.haiku;
    }
    if (!config.modelSubagent && profileModels.subagent) {
      config.modelSubagent = profileModels.subagent;
    }
  }

  return config as ClaudishConfig;
}

/**
 * Cache Management Constants
 */
const CACHE_MAX_AGE_DAYS = 2;
const MODELS_JSON_PATH = join(__dirname, "../recommended-models.json");
const ALL_MODELS_JSON_PATH = join(__dirname, "../all-models.json");

/**
 * Search all available models with smart discovery and print results
 */
async function searchAndPrintModels(query: string, forceUpdate: boolean): Promise<void> {
  // Show API key status
  console.log(`🔑 ${getApiKeyDescription()}\n`);

  // Get models using smart discovery system
  const { getAllModelsForSearch } = await import("./model-selector.js");
  const allModels = await getAllModelsForSearch();

  // Filter by search query
  const filteredModels = filterModelsByQuery(allModels, query);

  // Categorize by accessibility
  const categorized = categorizeModelsByAccess(filteredModels);

  // Show available models first
  if (categorized.available.length > 0) {
    console.log(`✅ ${categorized.available.length} Available Models:\n`);
    console.log("  Model                          Provider    Pricing     Context");
    console.log("  " + "─".repeat(75));

    for (const model of categorized.available.slice(0, 10)) {
      printModelRow(model);
    }

    if (categorized.available.length > 10) {
      console.log(`  ... and ${categorized.available.length - 10} more available models\n`);
    }
  }

  // Show models requiring API keys
  if (categorized.needsOpenRouter.length > 0) {
    console.log(`📡 ${categorized.needsOpenRouter.length} Models Need OpenRouter API Key:\n`);
    console.log("  Model                          Provider    Pricing     Context");
    console.log("  " + "─".repeat(75));

    for (const model of categorized.needsOpenRouter.slice(0, 5)) {
      printModelRow(model);
    }

    if (categorized.needsOpenRouter.length > 5) {
      console.log(`  ... and ${categorized.needsOpenRouter.length - 5} more models\n`);
    }
  }

  if (categorized.needsPoe.length > 0) {
    console.log(`🟣 ${categorized.needsPoe.length} Models Need Poe API Key:\n`);
    console.log("  Model                          Provider    Pricing     Context");
    console.log("  " + "─".repeat(75));

    for (const model of categorized.needsPoe.slice(0, 5)) {
      printModelRow(model);
    }

    if (categorized.needsPoe.length > 5) {
      console.log(`  ... and ${categorized.needsPoe.length - 5} more models\n`);
    }
  }

  if (filteredModels.length === 0) {
    console.log(`No models found matching "${query}"`);
  } else {
    console.log(`Found ${filteredModels.length} total models matching "${query}"`);
  }

  // Show setup guidance if needed
  const keys = getAvailableApiKeys();
  if (!keys.openrouter || !keys.poe) {
    printSetupGuidance();
  }

  console.log("\nUse a model: claudish --model <model-id>");
}

/**
 * Print a single model row in the search results
 */
function printModelRow(model: any): void {
  // Format model ID (truncate if too long)
  const modelId = model.id.length > 30 ? model.id.substring(0, 27) + "..." : model.id;
  const modelIdPadded = modelId.padEnd(30);

  // Determine provider from ID
  const providerName = model.id.split('/')[0];
  const provider = providerName.length > 10 ? providerName.substring(0, 7) + "..." : providerName;
  const providerPadded = provider.padEnd(10);

  // Format pricing (handle special cases: negative = varies, 0 = free)
  const promptPrice = parseFloat(model.pricing?.prompt || "0") * 1000000;
  const completionPrice = parseFloat(model.pricing?.completion || "0") * 1000000;
  const avg = (promptPrice + completionPrice) / 2;
  let pricing: string;
  if (avg < 0) {
    pricing = "varies";  // Auto-router or dynamic pricing
  } else if (avg === 0) {
    pricing = "FREE";
  } else {
    pricing = `$${avg.toFixed(2)}/1M`;
  }
  const pricingPadded = pricing.padEnd(10);

  // Context
  const contextLen = model.context_length || model.top_provider?.context_length || 0;
  const context = contextLen > 0 ? `${Math.round(contextLen/1000)}K` : "N/A";
  const contextPadded = context.padEnd(7);

  console.log(`  ${modelIdPadded} ${providerPadded} ${pricingPadded} ${contextPadded}`);
}

/**
 * Print ALL available models with smart discovery and accessibility indicators
 */
async function printAllModels(jsonOutput: boolean, forceUpdate: boolean): Promise<void> {
  // Show API key status
  console.log(`🔑 ${getApiKeyDescription()}\n`);

  // Get models using smart discovery system
  const { getAllModelsForSearch } = await import("./model-selector.js");
  const allModels = await getAllModelsForSearch();

  // Categorize by accessibility
  const categorized = categorizeModelsByAccess(allModels);

  // JSON output
  if (jsonOutput) {
    console.log(JSON.stringify({
      totalModels: allModels.length,
      availableModels: categorized.available.length,
      needsOpenRouter: categorized.needsOpenRouter.length,
      needsPoe: categorized.needsPoe.length,
      lastUpdated: new Date().toISOString().split('T')[0],
      models: allModels.map(m => ({
        id: m.id,
        name: m.name,
        description: m.description,
        provider: m.provider,
        context: m.context_length || m.top_provider?.context_length,
        pricing: m.pricing,
        available: categorized.available.includes(m)
      }))
    }, null, 2));
    return;
  }

  // Show available models first
  if (categorized.available.length > 0) {
    console.log(`✅ Available Models (${categorized.available.length}):\n`);

    // Group available models by provider
    const byProvider = new Map<string, any[]>();
    for (const model of categorized.available) {
      const provider = model.id.split('/')[0];
      if (!byProvider.has(provider)) {
        byProvider.set(provider, []);
      }
      byProvider.get(provider)!.push(model);
    }

    // Sort providers alphabetically
    const sortedProviders = [...byProvider.keys()].sort();

    for (const provider of sortedProviders) {
      const providerModels = byProvider.get(provider)!;
      console.log(`  ${provider.toUpperCase()} (${providerModels.length} models)`);
      console.log("  " + "─".repeat(70));

      for (const model of providerModels.slice(0, 10)) { // Limit per provider
        printModelRow(model);
      }

      if (providerModels.length > 10) {
        console.log(`    ... and ${providerModels.length - 10} more ${provider} models`);
      }
      console.log("");
    }
  }

  // Show models requiring API keys
  if (categorized.needsOpenRouter.length > 0) {
    console.log(`📡 Models Requiring OpenRouter API Key (${categorized.needsOpenRouter.length}):\n`);
    console.log("  Get your key at: https://openrouter.ai/keys\n");
    console.log("  Top OpenRouter models:");
    console.log("  " + "─".repeat(70));

    // Show top 10 OpenRouter models
    const topOpenRouter = categorized.needsOpenRouter.slice(0, 10);
    for (const model of topOpenRouter) {
      printModelRow(model);
    }

    if (categorized.needsOpenRouter.length > 10) {
      console.log(`  ... and ${categorized.needsOpenRouter.length - 10} more models\n`);
    }
  }

  if (categorized.needsPoe.length > 0) {
    console.log(`🟣 Models Requiring Poe API Key (${categorized.needsPoe.length}):\n`);
    console.log("  Get your key at: https://poe.com/blog/introducing-the-poe-api\n");
    console.log("  Top Poe models:");
    console.log("  " + "─".repeat(70));

    // Show top 10 Poe models
    const topPoe = categorized.needsPoe.slice(0, 10);
    for (const model of topPoe) {
      printModelRow(model);
    }

    if (categorized.needsPoe.length > 10) {
      console.log(`  ... and ${categorized.needsPoe.length - 10} more models\n`);
    }
  }

  // Show setup guidance if needed
  const keys = getAvailableApiKeys();
  if (!keys.openrouter || !keys.poe) {
    printSetupGuidance();
  }

  console.log(`\nTotal: ${allModels.length} models (${categorized.available.length} available, ${categorized.needsOpenRouter.length + categorized.needsPoe.length} need API keys)`);
  console.log("Use:         claudish --model <model-id>");
  console.log("Search:       claudish --models <query>");
  console.log("Top models:   claudish --top-models");
  console.log("Force update: claudish --models --force-update\n");
}

/**
 * Check if models cache is stale (older than CACHE_MAX_AGE_DAYS)
 */
function isCacheStale(): boolean {
  if (!existsSync(MODELS_JSON_PATH)) {
    return true; // No cache file = stale
  }

  try {
    const jsonContent = readFileSync(MODELS_JSON_PATH, "utf-8");
    const data = JSON.parse(jsonContent);

    if (!data.lastUpdated) {
      return true; // No timestamp = stale
    }

    const lastUpdated = new Date(data.lastUpdated);
    const now = new Date();
    const ageInDays = (now.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);

    return ageInDays > CACHE_MAX_AGE_DAYS;
  } catch (error) {
    // If we can't read/parse, consider it stale
    return true;
  }
}

/**
 * Fetch models from OpenRouter and update recommended-models.json
 *
 * IMPORTANT: This function matches the exact models shown on OpenRouter's programming page:
 * https://openrouter.ai/models?categories=programming&fmt=cards&order=top-weekly
 *
 * **Why hardcoded list?**
 * The OpenRouter website uses client-side rendering (React/Next.js), making it impossible
 * to scrape the HTML with simple HTTP requests. The API doesn't expose the "top-weekly"
 * ranking either. Therefore, we maintain a manually curated list based on the website.
 *
 * **Filtering rules:**
 * 1. Match the top 10 models from the "Top Weekly" programming category (verified manually)
 * 2. Take only ONE model per provider (the top-ranked one)
 *
 * **Maintenance:** Update this list when the OpenRouter website rankings change.
 * Last verified: 2025-11-19
 */
async function updateModelsFromOpenRouter(): Promise<void> {
  console.error("🔄 Updating model recommendations from OpenRouter...");

  try {
    // Top Weekly Programming Models (manually verified from the website)
    // Source: https://openrouter.ai/models?categories=programming&fmt=cards&order=top-weekly
    // Last verified: 2025-11-19
    //
    // This list represents the EXACT ranking shown on OpenRouter's website.
    // The website is client-side rendered (React), so we can't scrape it with HTTP.
    // The API doesn't expose the "top-weekly" ranking, so we maintain this manually.
    const topWeeklyProgrammingModels = [
      "google/gemini-3-pro-preview",      // #0: Google Gemini 3 Pro Preview (New!)
      "openai/gpt-5.1-codex",             // #0: OpenAI Codex 5.1 (New!)
      "x-ai/grok-code-fast-1",            // #1: xAI Grok Code Fast 1
      "anthropic/claude-sonnet-4.5",      // #2: Anthropic Claude Sonnet 4.5
      "google/gemini-2.5-flash",          // #3: Google Gemini 2.5 Flash
      "minimax/minimax-m2",               // #4: MiniMax M2
      "anthropic/claude-sonnet-4",        // #5: Anthropic Claude Sonnet 4
      "z-ai/glm-4.6",                     // #6: Z.AI GLM 4.6
      "anthropic/claude-haiku-4.5",       // #7: Anthropic Claude Haiku 4.5
      "openai/gpt-5",                     // #8: OpenAI GPT-5
      "qwen/qwen3-vl-235b-a22b-instruct", // #9: Qwen3 VL 235B
      "openrouter/polaris-alpha",         // #10: Polaris Alpha (OpenRouter experimental)
    ];

    // Fetch model metadata from OpenRouter API
    const apiResponse = await fetch("https://openrouter.ai/api/v1/models");
    if (!apiResponse.ok) {
      throw new Error(`OpenRouter API returned ${apiResponse.status}`);
    }

    const openrouterData = await apiResponse.json();
    const allModels = openrouterData.data;

    // Build a map for quick lookup
    const modelMap = new Map();
    for (const model of allModels) {
      modelMap.set(model.id, model);
    }

    // Build recommendations list following the exact website ranking
    const recommendations: any[] = [];
    const providers = new Set<string>();

    for (const modelId of topWeeklyProgrammingModels) {
      const provider = modelId.split("/")[0];

      // Filter 1: Skip Anthropic models (not needed in Claudish)
      if (provider === "anthropic") {
        continue;
      }

      // Filter 2: Only ONE model per provider (take the first/top-ranked)
      if (providers.has(provider)) {
        continue;
      }

      const model = modelMap.get(modelId);
      if (!model) {
        // Model not in API - assume it's no longer available or strictly private
        // User requested to skip these models rather than showing placeholders
        console.error(`⚠️  Model ${modelId} not found in OpenRouter API - skipping`);
        continue;
      }

      const name = model.name || modelId;
      const description = model.description || `${name} model`;
      const architecture = model.architecture || {};
      const topProvider = model.top_provider || {};
      const supportedParams = model.supported_parameters || [];

      // Calculate pricing (handle both per-token and per-million formats)
      const promptPrice = parseFloat(model.pricing?.prompt || "0");
      const completionPrice = parseFloat(model.pricing?.completion || "0");

      const inputPrice = promptPrice > 0
        ? `$${(promptPrice * 1000000).toFixed(2)}/1M`
        : "FREE";
      const outputPrice = completionPrice > 0
        ? `$${(completionPrice * 1000000).toFixed(2)}/1M`
        : "FREE";
      const avgPrice = (promptPrice > 0 || completionPrice > 0)
        ? `$${((promptPrice + completionPrice) / 2 * 1000000).toFixed(2)}/1M`
        : "FREE";

      // Determine category based on description and capabilities
      let category = "programming"; // default since we're filtering programming models
      const lowerDesc = description.toLowerCase() + " " + name.toLowerCase();

      if (lowerDesc.includes("vision") || lowerDesc.includes("vl-") || lowerDesc.includes("multimodal")) {
        category = "vision";
      } else if (lowerDesc.includes("reason")) {
        category = "reasoning";
      }

      recommendations.push({
        id: modelId,
        name,
        description,
        provider: provider.charAt(0).toUpperCase() + provider.slice(1),
        category,
        priority: recommendations.length + 1,
        pricing: {
          input: inputPrice,
          output: outputPrice,
          average: avgPrice
        },
        context: topProvider.context_length
          ? `${Math.floor(topProvider.context_length / 1000)}K`
          : "N/A",
        maxOutputTokens: topProvider.max_completion_tokens || null,
        modality: architecture.modality || "text->text",
        supportsTools: supportedParams.includes("tools") || supportedParams.includes("tool_choice"),
        supportsReasoning: supportedParams.includes("reasoning") || supportedParams.includes("include_reasoning"),
        supportsVision: (architecture.input_modalities || []).includes("image") ||
                       (architecture.input_modalities || []).includes("video"),
        isModerated: topProvider.is_moderated || false,
        recommended: true
      });

      providers.add(provider);
    }

    // Read existing version if available
    let version = "1.1.5"; // default
    if (existsSync(MODELS_JSON_PATH)) {
      try {
        const existing = JSON.parse(readFileSync(MODELS_JSON_PATH, "utf-8"));
        version = existing.version || version;
      } catch {
        // Use default version
      }
    }

    // Create new JSON structure
    const updatedData = {
      version,
      lastUpdated: new Date().toISOString().split('T')[0], // YYYY-MM-DD format
      source: "https://openrouter.ai/models?categories=programming&fmt=cards&order=top-weekly",
      models: recommendations
    };

    // Write to file
    writeFileSync(MODELS_JSON_PATH, JSON.stringify(updatedData, null, 2), "utf-8");

    console.error(`✅ Updated ${recommendations.length} models (last updated: ${updatedData.lastUpdated})`);
  } catch (error) {
    console.error(`❌ Failed to update models: ${error instanceof Error ? error.message : String(error)}`);
    console.error("   Using cached models (if available)");
  }
}

/**
 * Check cache staleness and update if needed
 */
async function checkAndUpdateModelsCache(forceUpdate: boolean = false): Promise<void> {
  if (forceUpdate) {
    console.error("🔄 Force update requested...");
    await updateModelsFromOpenRouter();
    return;
  }

  if (isCacheStale()) {
    console.error("⚠️  Model cache is stale (>2 days old), updating...");
    await updateModelsFromOpenRouter();
  } else {
    // Cache is fresh, show timestamp in stderr (won't affect JSON output)
    try {
      const data = JSON.parse(readFileSync(MODELS_JSON_PATH, "utf-8"));
      console.error(`✓ Using cached models (last updated: ${data.lastUpdated})`);
    } catch {
      // Silently fallthrough if can't read
    }
  }
}

/**
 * Print version information
 */
function printVersion(): void {
  console.log(`claudish version ${VERSION}`);
}

/**
 * Print help message
 */
function printHelp(): void {
  console.log(`
claudish - Run Claude Code with OpenRouter & Poe models

USAGE:
  claudish                                # Interactive mode (default, shows model selector)
  claudish [OPTIONS] <claude-args...>     # Single-shot mode (requires --model)

OPTIONS:
  -i, --interactive        Run in interactive mode (default when no prompt given)
  -m, --model <model>      OpenRouter model to use (required for single-shot mode)
  -p, --profile <name>     Use named profile for model mapping (default: uses default profile)
  --port <port>            Proxy server port (default: random)
  -d, --debug              Enable debug logging to file (logs/claudish_*.log)
  --log-level <level>      Log verbosity: debug (full), info (truncated), minimal (labels only)
  -q, --quiet              Suppress [claudish] log messages (default in single-shot mode)
  -v, --verbose            Show [claudish] log messages (default in interactive mode)
  --json                   Output in JSON format for tool integration (implies --quiet)
  --stdin                  Read prompt from stdin (useful for large prompts or piping)
  --free                   Show only FREE models in the interactive selector
  --monitor                Monitor mode - proxy to REAL Anthropic API and log all traffic
  --no-auto-approve        Disable auto permission skip (prompts enabled)
  --dangerous              Pass --dangerouslyDisableSandbox to Claude Code
  --cost-tracker           Enable cost tracking for API usage (NB!)
  --audit-costs            Show cost analysis report
  --reset-costs            Reset accumulated cost statistics
  --models                 List ALL available models (OpenRouter + Poe) with accessibility indicators
  --models <query>         Fuzzy search all models by name, ID, or description
  --top-models             List top models from all available providers based on your API keys
  --json                   Output in JSON format (use with --models or --top-models)
  --force-update           Force refresh model cache from available APIs
  --version                Show version information
  -h, --help               Show this help message
  --help-ai                Show AI agent usage guide (file-based patterns, sub-agents)
  --init                   Install Claudish skill in current project (.claude/skills/)

PROFILE MANAGEMENT:
  claudish init            Setup wizard - create config and first profile
  claudish profile list    List all profiles
  claudish profile add     Add a new profile
  claudish profile remove  Remove a profile (interactive or claudish profile remove <name>)
  claudish profile use     Set default profile (interactive or claudish profile use <name>)
  claudish profile show    Show profile details (default profile or claudish profile show <name>)
  claudish profile edit    Edit a profile (interactive or claudish profile edit <name>)

MODEL MAPPING (per-role override):
  --model-opus <model>     Model for Opus role (planning, complex tasks)
  --model-sonnet <model>   Model for Sonnet role (default coding)
  --model-haiku <model>    Model for Haiku role (fast tasks, background)
  --model-subagent <model> Model for sub-agents (Task tool)

CUSTOM MODELS:
  Claudish accepts ANY valid OpenRouter OR Poe model ID, even if not in --list-models
  OpenRouter example: claudish --model your_provider/custom-model-123 "task"
  Poe example: claudish --model poe/your-model-name "task"

MODES:
  • Interactive mode (default): Shows model selector, starts persistent session
  • Single-shot mode: Runs one task in headless mode and exits (requires --model)

NOTES:
  • Permission prompts are SKIPPED by default (--dangerously-skip-permissions)
  • Use --no-auto-approve to enable permission prompts
  • Model selector appears ONLY in interactive mode when --model not specified
  • Use --dangerous to disable sandbox (use with extreme caution!)

ENVIRONMENT VARIABLES:
  Claudish automatically loads .env file from current directory.

  OPENROUTER_API_KEY              Required for OpenRouter models: Your OpenRouter API key
                                    Get from: https://openrouter.ai/keys
  POE_API_KEY                     Required for Poe models: Your Poe API key
                                    Get from: https://poe.com/blog/introducing-the-poe-api
  CLAUDISH_MODEL                  Default model to use (takes priority)
  ANTHROPIC_MODEL                 Claude Code standard: model to use (fallback)
  CLAUDISH_PORT                   Default port for proxy
  CLAUDISH_ACTIVE_MODEL_NAME      Auto-set by claudish (read-only) - shows active model

  Model mapping (CLAUDISH_* takes priority over ANTHROPIC_DEFAULT_*):
  CLAUDISH_MODEL_OPUS             Override model for Opus role
  CLAUDISH_MODEL_SONNET           Override model for Sonnet role
  CLAUDISH_MODEL_HAIKU            Override model for Haiku role
  CLAUDISH_MODEL_SUBAGENT         Override model for sub-agents
  ANTHROPIC_DEFAULT_OPUS_MODEL    Claude Code standard: Opus model (fallback)
  ANTHROPIC_DEFAULT_SONNET_MODEL  Claude Code standard: Sonnet model (fallback)
  ANTHROPIC_DEFAULT_HAIKU_MODEL   Claude Code standard: Haiku model (fallback)
  CLAUDE_CODE_SUBAGENT_MODEL      Claude Code standard: sub-agent model (fallback)

EXAMPLES:
  # Interactive mode (default) - shows model selector
  claudish
  claudish --interactive

  # Interactive mode with only FREE models
  claudish --free

  # Interactive mode with pre-selected model
  claudish --model x-ai/grok-code-fast-1
  claudish --model poe/grok-4-fast-reasoning

  # Single-shot mode - one task and exit (requires --model or CLAUDISH_MODEL env var)
  claudish --model openai/gpt-5-codex "implement user authentication"
  claudish --model x-ai/grok-code-fast-1 "add tests for login"
  claudish --model poe/grok-4 "debug the issue"

  # Per-role model mapping (use different models for different Claude Code roles)
  claudish --model-opus openai/gpt-5 --model-sonnet x-ai/grok-code-fast-1 --model-haiku minimax/minimax-m2

  # Use named profiles for pre-configured model mappings
  claudish -p frontend "implement component"
  claudish --profile debug "investigate error"

  # Hybrid: Native Anthropic for Opus, OpenRouter for Sonnet/Haiku
  claudish --model-opus claude-3-opus-20240229 --model-sonnet x-ai/grok-code-fast-1

  # Use stdin for large prompts (e.g., git diffs, code review)
  echo "Review this code..." | claudish --stdin --model x-ai/grok-code-fast-1
  git diff | claudish --stdin --model openai/gpt-5-codex "Review these changes"

  # Monitor mode - understand how Claude Code works (requires real Anthropic API key)
  claudish --monitor --debug "analyze code structure"

  # Disable auto-approve (require manual confirmation)
  claudish --no-auto-approve "make changes to config"

  # Dangerous mode (disable sandbox - use with extreme caution)
  claudish --dangerous "refactor entire codebase"

  # Both flags (fully autonomous)
  claudish --dangerous "refactor entire codebase"

  # With custom port
  claudish --port 3000 "analyze code structure"

  # Pass flags to claude
  claudish --model x-ai/grok-code-fast-1 --verbose "debug issue"

  # JSON output for tool integration (quiet by default)
  claudish --json "list 5 prime numbers"

  # Verbose mode in single-shot (show [claudish] logs)
  claudish --verbose "analyze code structure"

AVAILABLE MODELS:
  List all models:     claudish --models                 # Shows available models based on your API keys
  Search models:       claudish --models <query>         # Fuzzy search across all providers
  Top recommended:     claudish --top-models              # Smart recommendations from your available providers
  JSON output:         claudish --models --json           # Export model data with availability info
  Force cache update:  claudish --models --force-update   # Refresh from all available APIs
  (Works with any combination of API keys: OpenRouter, Poe, both, or none)

MORE INFO:
  GitHub: https://github.com/MadAppGang/claude-code
  OpenRouter: https://openrouter.ai
`);
}

/**
 * Print AI agent usage guide
 */
function printAIAgentGuide(): void {
  try {
    const guidePath = join(__dirname, "../AI_AGENT_GUIDE.md");
    const guideContent = readFileSync(guidePath, "utf-8");
    console.log(guideContent);
  } catch (error) {
    console.error("Error reading AI Agent Guide:");
    console.error(error instanceof Error ? error.message : String(error));
    console.error("\nThe guide should be located at: AI_AGENT_GUIDE.md");
    console.error("You can also view it online at:");
    console.error("https://github.com/MadAppGang/claude-code/blob/main/mcp/claudish/AI_AGENT_GUIDE.md");
    process.exit(1);
  }
}

/**
 * Initialize Claudish skill in current project
 */
async function initializeClaudishSkill(): Promise<void> {
  console.log("🔧 Initializing Claudish skill in current project...\n");

  // Get current working directory
  const cwd = process.cwd();
  const claudeDir = join(cwd, ".claude");
  const skillsDir = join(claudeDir, "skills");
  const claudishSkillDir = join(skillsDir, "claudish-usage");
  const skillFile = join(claudishSkillDir, "SKILL.md");

  // Check if skill already exists
  if (existsSync(skillFile)) {
    console.log("✅ Claudish skill already installed at:");
    console.log(`   ${skillFile}\n`);
    console.log("💡 To reinstall, delete the file and run 'claudish --init' again.");
    return;
  }

  // Get source skill file from Claudish installation
  const sourceSkillPath = join(__dirname, "../skills/claudish-usage/SKILL.md");

  if (!existsSync(sourceSkillPath)) {
    console.error("❌ Error: Claudish skill file not found in installation.");
    console.error(`   Expected at: ${sourceSkillPath}`);
    console.error("\n💡 Try reinstalling Claudish:");
    console.error("   npm install -g claudish@latest");
    process.exit(1);
  }

  try {
    // Create directories if they don't exist
    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true });
      console.log("📁 Created .claude/ directory");
    }

    if (!existsSync(skillsDir)) {
      mkdirSync(skillsDir, { recursive: true });
      console.log("📁 Created .claude/skills/ directory");
    }

    if (!existsSync(claudishSkillDir)) {
      mkdirSync(claudishSkillDir, { recursive: true });
      console.log("📁 Created .claude/skills/claudish-usage/ directory");
    }

    // Copy skill file
    copyFileSync(sourceSkillPath, skillFile);
    console.log("✅ Installed Claudish skill at:");
    console.log(`   ${skillFile}\n`);

    // Print success message with next steps
    console.log("━".repeat(60));
    console.log("\n🎉 Claudish skill installed successfully!\n");
    console.log("📋 Next steps:\n");
    console.log("1. Reload Claude Code to discover the skill");
    console.log("   - Restart Claude Code, or");
    console.log("   - Re-open your project\n");
    console.log("2. Use Claudish with external models:");
    console.log("   - User: \"use Grok to implement feature X\"");
    console.log("   - Claude will automatically use the skill\n");
    console.log("💡 The skill enforces best practices:");
    console.log("   ✅ Mandatory sub-agent delegation");
    console.log("   ✅ File-based instruction patterns");
    console.log("   ✅ Context window protection\n");
    console.log("📖 For more info: claudish --help-ai\n");
    console.log("━".repeat(60));

  } catch (error) {
    console.error("\n❌ Error installing Claudish skill:");
    console.error(error instanceof Error ? error.message : String(error));
    console.error("\n💡 Make sure you have write permissions in the current directory.");
    process.exit(1);
  }
}

/**
 * Print available models in enhanced table format
 */
function printAvailableModels(): void {
  // Try to read enhanced model data from JSON file
  let lastUpdated = "unknown";
  let models: any[] = [];

  try {
    if (existsSync(MODELS_JSON_PATH)) {
      const data = JSON.parse(readFileSync(MODELS_JSON_PATH, "utf-8"));
      lastUpdated = data.lastUpdated || "unknown";
      models = data.models || [];
    }
  } catch {
    // Fallback to basic model list
    const basicModels = getAvailableModels();
    const modelInfo = loadModelInfo();
    for (const model of basicModels) {
      const info = modelInfo[model];
      console.log(`  ${model}`);
      console.log(`    ${info.name} - ${info.description}`);
      console.log("");
    }
    return;
  }

  console.log(`\nAvailable OpenRouter Models (last updated: ${lastUpdated}):\n`);

  // Table header
  console.log("  Model                          Provider    Pricing     Context  Capabilities");
  console.log("  " + "─".repeat(86));

  // Table rows
  for (const model of models) {
    // Format model ID (truncate if too long)
    const modelId = model.id.length > 30 ? model.id.substring(0, 27) + "..." : model.id;
    const modelIdPadded = modelId.padEnd(30);

    // Format provider (max 10 chars)
    const provider = model.provider.length > 10 ? model.provider.substring(0, 7) + "..." : model.provider;
    const providerPadded = provider.padEnd(10);

    // Format pricing (average) - handle special cases
    let pricing = model.pricing?.average || "N/A";

    // Handle special pricing cases
    if (pricing.includes("-1000000")) {
      pricing = "varies"; // Auto-router pricing varies by routed model
    } else if (pricing === "$0.00/1M" || pricing === "FREE") {
      pricing = "FREE";
    }

    const pricingPadded = pricing.padEnd(10);

    // Format context
    const context = model.context || "N/A";
    const contextPadded = context.padEnd(7);

    // Capabilities emojis
    const tools = model.supportsTools ? "🔧" : "  ";
    const reasoning = model.supportsReasoning ? "🧠" : "  ";
    const vision = model.supportsVision ? "👁️ " : "  ";
    const capabilities = `${tools} ${reasoning} ${vision}`;

    console.log(`  ${modelIdPadded} ${providerPadded} ${pricingPadded} ${contextPadded} ${capabilities}`);
  }

  console.log("");
  console.log("  Capabilities: 🔧 Tools  🧠 Reasoning  👁️  Vision");
  console.log("");
  console.log("Set default with: export CLAUDISH_MODEL=<model>");
  console.log("               or: export ANTHROPIC_MODEL=<model>");
  console.log("Or use: claudish --model <model> ...");
  console.log("\nForce update: claudish --list-models --force-update\n");
}

/**
 * Print available models in JSON format
 */
function printAvailableModelsJSON(): void {
  const jsonPath = join(__dirname, "../recommended-models.json");

  try {
    const jsonContent = readFileSync(jsonPath, "utf-8");
    const data = JSON.parse(jsonContent);

    // Output clean JSON to stdout
    console.log(JSON.stringify(data, null, 2));
  } catch (error) {
    // If JSON file doesn't exist, construct from model info
    const models = getAvailableModels();
    const modelInfo = loadModelInfo();

    const output = {
      version: VERSION,
      lastUpdated: new Date().toISOString().split('T')[0],
      source: "runtime",
      models: models
        .filter(m => m !== 'custom')
        .map(modelId => {
          const info = modelInfo[modelId];
          return {
            id: modelId,
            name: info.name,
            description: info.description,
            provider: info.provider,
            priority: info.priority
          };
        })
    };

    console.log(JSON.stringify(output, null, 2));
  }
}
