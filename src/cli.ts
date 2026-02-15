import { ENV } from "./config.js";
import type { ClaudishConfig } from "./types.js";
import { loadModelInfo, getAvailableModels } from "./model-loader.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fuzzyScore } from "./utils.js";
import { getModelMapping } from "./profile-config.js";
// Re-export from centralized provider-resolver for backwards compatibility
export {
  resolveModelProvider,
  validateApiKeysForModels,
  getMissingKeyError,
  getMissingKeysError,
  getMissingKeyResolutions,
  requiresOpenRouterKey,
  isLocalModel,
  type ProviderCategory,
  type ProviderResolution,
} from "./providers/provider-resolver.js";

// Read version from package.json (with fallback for compiled binaries)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let VERSION = "4.6.9"; // Fallback version for compiled binaries
try {
  const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));
  VERSION = packageJson.version;
} catch {
  // Running as compiled binary - use fallback version
}

/**
 * Get current version
 */
export function getVersion(): string {
  return VERSION;
}

/**
 * Clear all model caches (OpenRouter, LiteLLM, pricing)
 * Called when --force-update flag is used
 */
function clearAllModelCaches(): void {
  const cacheDir = join(homedir(), ".claudish");
  if (!existsSync(cacheDir)) return;

  const cachePatterns = ["all-models.json", "pricing-cache.json"];
  let cleared = 0;

  try {
    const files = readdirSync(cacheDir);
    for (const file of files) {
      if (cachePatterns.includes(file) || file.startsWith("litellm-models-")) {
        unlinkSync(join(cacheDir, file));
        cleared++;
      }
    }
    if (cleared > 0) {
      console.error(`🗑️  Cleared ${cleared} cache file(s)`);
    }
  } catch (error) {
    console.error(`Warning: Could not clear caches: ${error}`);
  }
}

/**
 * Parse CLI arguments and environment variables
 */
export async function parseArgs(args: string[]): Promise<ClaudishConfig> {
  const config: Partial<ClaudishConfig> = {
    model: undefined, // Will prompt interactively if not provided
    autoApprove: false, // Don't skip permissions by default (safer)
    dangerous: false,
    interactive: false, // Single-shot mode by default
    debug: false, // No debug logging by default
    logLevel: "info", // Default to info level (structured logging with truncated content)
    quiet: undefined, // Will be set based on mode (true for single-shot, false for interactive)
    jsonOutput: false, // No JSON output by default
    streamOutput: false, // No NDJSON streaming by default
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
  config.modelOpus =
    process.env[ENV.CLAUDISH_MODEL_OPUS] || process.env[ENV.ANTHROPIC_DEFAULT_OPUS_MODEL];
  config.modelSonnet =
    process.env[ENV.CLAUDISH_MODEL_SONNET] || process.env[ENV.ANTHROPIC_DEFAULT_SONNET_MODEL];
  config.modelHaiku =
    process.env[ENV.CLAUDISH_MODEL_HAIKU] || process.env[ENV.ANTHROPIC_DEFAULT_HAIKU_MODEL];
  config.modelSubagent =
    process.env[ENV.CLAUDISH_MODEL_SUBAGENT] || process.env[ENV.CLAUDE_CODE_SUBAGENT_MODEL];

  const envPort = process.env[ENV.CLAUDISH_PORT];
  if (envPort) {
    const port = Number.parseInt(envPort, 10);
    if (!Number.isNaN(port)) {
      config.port = port;
    }
  }

  // Check for tool summarization env var
  const envSummarizeTools = process.env[ENV.CLAUDISH_SUMMARIZE_TOOLS];
  if (envSummarizeTools === "true" || envSummarizeTools === "1") {
    config.summarizeTools = true;
  }

  // Parse command line arguments
  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "--model" || arg === "-m") {
      const modelArg = args[++i];
      if (!modelArg) {
        console.error("--model requires a value");
        printAvailableModels();
        process.exit(1);
      }
      config.model = modelArg; // Accept any model ID
    } else if (arg === "--model-opus") {
      // Model mapping flags
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
    } else if (arg === "--auto-approve" || arg === "-y") {
      config.autoApprove = true;
    } else if (arg === "--no-auto-approve") {
      config.autoApprove = false;
    } else if (arg === "--dangerous") {
      config.dangerous = true;
    } else if (arg === "--interactive" || arg === "-i") {
      config.interactive = true;
    } else if (arg === "--debug" || arg === "-d") {
      config.debug = true;
      // Default to debug log level when --debug is enabled (can be overridden by --log-level)
      if (config.logLevel === "info") {
        config.logLevel = "debug";
      }
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
    } else if (arg === "--stream") {
      config.streamOutput = true;
      config.quiet = true; // Stream mode is always quiet
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
      // Show recommended/top models (curated list)
      const hasJsonFlag = args.includes("--json");
      const forceUpdate = args.includes("--force-update");

      if (forceUpdate) clearAllModelCaches();

      // Auto-update if cache is stale (>2 days) or if --force-update is specified
      await checkAndUpdateModelsCache(forceUpdate);

      if (hasJsonFlag) {
        printAvailableModelsJSON();
      } else {
        printAvailableModels();
      }
      process.exit(0);
    } else if (arg === "--models" || arg === "--list-models" || arg === "-s" || arg === "--search") {
      // Check for optional search query (next arg that doesn't start with --)
      const nextArg = args[i + 1];
      const hasQuery = nextArg && !nextArg.startsWith("--");
      const query = hasQuery ? args[++i] : null;

      const hasJsonFlag = args.includes("--json");
      const forceUpdate = args.includes("--force-update");

      if (forceUpdate) clearAllModelCaches();

      if (query) {
        // Search mode: fuzzy search all models
        await searchAndPrintModels(query, forceUpdate);
      } else {
        // List mode: show all models grouped by provider
        await printAllModels(hasJsonFlag, forceUpdate);
      }
      process.exit(0);
    } else if (arg === "--summarize-tools") {
      // Summarize tool descriptions to reduce prompt size for local models
      config.summarizeTools = true;
    } else if (arg === "--litellm-url") {
      const val = args[++i];
      if (!val) {
        console.error("--litellm-url requires a URL");
        process.exit(1);
      }
      config.litellmBaseUrl = val;
    } else if (arg === "--litellm-key") {
      const val = args[++i];
      if (!val) {
        console.error("--litellm-key requires a value");
        process.exit(1);
      }
      config.litellmApiKey = val;
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

  // Handle monitor mode setup
  if (config.monitor) {
    // Monitor mode: proxies to real Anthropic API for monitoring/debugging
    // Uses Claude Code's native authentication (from `claude auth login`)
    //
    // Remove any placeholder API keys so Claude Code uses its stored credentials
    if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.includes("placeholder")) {
      delete process.env.ANTHROPIC_API_KEY;
    }

    if (!config.quiet) {
      console.log("[claudish] Monitor mode enabled - proxying to real Anthropic API");
      console.log("[claudish] Using Claude Code's native authentication");
      console.log("[claudish] Tip: Run with --debug to see request/response details");
    }
  }

  // Collect available API keys (NO validation here - validation happens in index.ts AFTER model selection)
  // This ensures we know which model the user wants before checking if they have the right key
  config.openrouterApiKey = process.env[ENV.OPENROUTER_API_KEY];
  config.anthropicApiKey = process.env.ANTHROPIC_API_KEY;

  // CLI flags take precedence over env vars for LiteLLM
  config.litellmBaseUrl = config.litellmBaseUrl || process.env.LITELLM_BASE_URL;
  config.litellmApiKey = config.litellmApiKey || process.env.LITELLM_API_KEY;

  // Set environment variables so provider registry can access them
  if (config.litellmBaseUrl) {
    process.env.LITELLM_BASE_URL = config.litellmBaseUrl;
  }
  if (config.litellmApiKey) {
    process.env.LITELLM_API_KEY = config.litellmApiKey;
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
  if (
    config.profile ||
    !config.modelOpus ||
    !config.modelSonnet ||
    !config.modelHaiku ||
    !config.modelSubagent
  ) {
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
// Use ~/.claudish/ for writable cache (binaries can't write to __dirname)
const CLAUDISH_CACHE_DIR = join(homedir(), ".claudish");
const ALL_MODELS_JSON_PATH = join(CLAUDISH_CACHE_DIR, "all-models.json");

/**
 * Fetch locally available Ollama models
 * Returns empty array if Ollama is not running
 */
async function fetchOllamaModels(): Promise<any[]> {
  const ollamaHost =
    process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL || "http://localhost:11434";

  try {
    const response = await fetch(`${ollamaHost}/api/tags`, {
      signal: AbortSignal.timeout(3000), // 3 second timeout
    });

    if (!response.ok) return [];

    const data = (await response.json()) as { models?: any[] };
    const models = data.models || [];

    // Fetch capabilities for each model in parallel
    const modelsWithCapabilities = await Promise.all(
      models.map(async (m: any) => {
        let capabilities: string[] = [];
        try {
          const showResponse = await fetch(`${ollamaHost}/api/show`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: m.name }),
            signal: AbortSignal.timeout(2000),
          });
          if (showResponse.ok) {
            const showData = (await showResponse.json()) as { capabilities?: string[] };
            capabilities = showData.capabilities || [];
          }
        } catch {
          // Ignore capability fetch errors
        }

        const supportsTools = capabilities.includes("tools");
        const isEmbeddingModel =
          capabilities.includes("embedding") || m.name.toLowerCase().includes("embed");
        const sizeInfo = m.details?.parameter_size || "unknown size";
        const toolsIndicator = supportsTools ? "✓ tools" : "✗ no tools";

        return {
          id: `ollama/${m.name}`,
          name: m.name,
          description: `Local Ollama model (${sizeInfo}, ${toolsIndicator})`,
          provider: "ollama",
          context_length: null, // Ollama doesn't expose this in /api/tags
          pricing: { prompt: "0", completion: "0" }, // Free (local)
          isLocal: true,
          supportsTools,
          isEmbeddingModel,
          capabilities,
          details: m.details,
          size: m.size,
        };
      })
    );

    // Filter out embedding models - they can't be used for chat/completion
    return modelsWithCapabilities.filter((m: any) => !m.isEmbeddingModel);
  } catch (e) {
    // Ollama not running or not reachable
    return [];
  }
}

/**
 * Search all available models and print results
 */
async function searchAndPrintModels(query: string, forceUpdate: boolean): Promise<void> {
  let models: any[] = [];

  // Check cache for all models
  if (!forceUpdate && existsSync(ALL_MODELS_JSON_PATH)) {
    try {
      const cacheData = JSON.parse(readFileSync(ALL_MODELS_JSON_PATH, "utf-8"));
      const lastUpdated = new Date(cacheData.lastUpdated);
      const now = new Date();
      const ageInDays = (now.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);

      if (ageInDays <= CACHE_MAX_AGE_DAYS) {
        models = cacheData.models;
      }
    } catch (e) {
      // Ignore cache error
    }
  }

  // Fetch if no cache or stale
  if (models.length === 0) {
    console.error("🔄 Fetching all models from OpenRouter (this may take a moment)...");
    try {
      const response = await fetch("https://openrouter.ai/api/v1/models");
      if (!response.ok) throw new Error(`API returned ${response.status}`);

      const data = (await response.json()) as { data: any[] };
      models = data.data;

      // Cache result - ensure directory exists
      mkdirSync(CLAUDISH_CACHE_DIR, { recursive: true });
      writeFileSync(
        ALL_MODELS_JSON_PATH,
        JSON.stringify({
          lastUpdated: new Date().toISOString(),
          models,
        }),
        "utf-8"
      );

      console.error(`✅ Cached ${models.length} models`);
    } catch (error) {
      console.error(`❌ Failed to fetch models: ${error}`);
      process.exit(1);
    }
  }

  // Fetch local Ollama models and add to search
  const ollamaModels = await fetchOllamaModels();
  if (ollamaModels.length > 0) {
    console.error(`🏠 Found ${ollamaModels.length} local Ollama models`);
    models = [...ollamaModels, ...models];
  }

  // Fetch OpenAI direct models from models.dev if OPENAI_API_KEY is set
  if (process.env.OPENAI_API_KEY) {
    try {
      const modelsDevResponse = await fetch("https://models.dev/api.json", {
        signal: AbortSignal.timeout(5000),
      });
      if (modelsDevResponse.ok) {
        const modelsDevData = await modelsDevResponse.json();
        const openaiData = modelsDevData.openai;
        if (openaiData?.models) {
          const openaiModels = Object.entries(openaiData.models)
            .filter(([id, _]: [string, any]) => {
              const lowerId = id.toLowerCase();
              return (
                lowerId.startsWith("gpt-") ||
                lowerId.startsWith("o1-") ||
                lowerId.startsWith("o3-") ||
                lowerId.startsWith("o4-") ||
                lowerId.startsWith("chatgpt-")
              );
            })
            .map(([id, m]: [string, any]) => {
              const inputCost = m.cost?.input || 2;
              const outputCost = m.cost?.output || 8;
              const contextLen = m.limit?.context || 128000;
              const inputModalities = m.modalities?.input || [];
              return {
                id: `oai/${id}`,
                name: m.name || id,
                description: `OpenAI direct model`,
                context_length: contextLen,
                pricing: {
                  prompt: String(inputCost / 1000000),
                  completion: String(outputCost / 1000000),
                },
                isOAIDirect: true,
                supportsTools: m.tool_call === true,
                supportsReasoning: m.reasoning === true,
                supportsVision:
                  inputModalities.includes("image") || inputModalities.includes("video"),
              };
            });
          console.error(`🔑 Found ${openaiModels.length} OpenAI direct models`);
          models = [...openaiModels, ...models];
        }
      }
    } catch {
      // Ignore models.dev fetch errors
    }
  }

  // Fetch GLM Coding Plan models from models.dev if GLM_CODING_API_KEY is set
  if (process.env.GLM_CODING_API_KEY) {
    try {
      const glmCodingModels = await fetchGLMCodingModels();
      if (glmCodingModels.length > 0) {
        console.error(`🔑 Found ${glmCodingModels.length} GLM Coding Plan models`);
        models = [...glmCodingModels, ...models];
      }
    } catch {
      // Ignore fetch errors
    }
  }

  // Perform fuzzy search
  const results = models
    .map((model) => {
      const nameScore = fuzzyScore(model.name || "", query);
      const idScore = fuzzyScore(model.id || "", query);
      const descScore = fuzzyScore(model.description || "", query) * 0.5; // Lower weight for description

      return {
        model,
        score: Math.max(nameScore, idScore, descScore),
      };
    })
    .filter((item) => item.score > 0.2) // Filter low relevance
    .sort((a, b) => b.score - a.score)
    .slice(0, 20); // Top 20 results

  if (results.length === 0) {
    console.log(`No models found matching "${query}"`);
    return;
  }

  // ANSI color codes
  const RED = "\x1b[31m";
  const GREEN = "\x1b[32m";
  const RESET = "\x1b[0m";
  const DIM = "\x1b[2m";

  console.log(`\nFound ${results.length} matching models:\n`);
  console.log("  Model                          Provider    Pricing     Context  Score");
  console.log("  " + "─".repeat(80));

  for (const { model, score } of results) {
    // Format model ID with proper prefix for explicit routing
    // Local models (ollama/) get ollama@ prefix, OpenRouter models get openrouter@ prefix
    let fullModelId: string;
    if (model.isLocal) {
      // Convert ollama/model-name to ollama@model-name
      fullModelId = model.id.replace("ollama/", "ollama@");
    } else if (model.id.startsWith("zen/")) {
      // Already has zen/ prefix, convert to zen@
      fullModelId = model.id.replace("zen/", "zen@");
    } else if (model.id.startsWith("oai/") || model.isOAIDirect) {
      // OAI direct model - convert oai/model to oai@model
      fullModelId = model.id.replace("oai/", "oai@");
    } else {
      // OpenRouter model - add openrouter@ prefix
      fullModelId = `openrouter@${model.id}`;
    }
    const modelId = fullModelId.length > 30 ? fullModelId.substring(0, 27) + "..." : fullModelId;
    const modelIdPadded = modelId.padEnd(30);

    // Determine provider from original ID
    const providerName = model.id.split("/")[0];
    const provider = providerName.length > 10 ? providerName.substring(0, 7) + "..." : providerName;
    const providerPadded = provider.padEnd(10);

    // Format pricing (handle special cases: local, negative = varies, 0 = free)
    let pricing: string;
    if (model.isLocal) {
      pricing = "LOCAL";
    } else {
      const promptPrice = parseFloat(model.pricing?.prompt || "0") * 1000000;
      const completionPrice = parseFloat(model.pricing?.completion || "0") * 1000000;
      const avg = (promptPrice + completionPrice) / 2;
      if (avg < 0) {
        pricing = "varies"; // Auto-router or dynamic pricing
      } else if (avg === 0) {
        pricing = "FREE";
      } else {
        pricing = `$${avg.toFixed(2)}/1M`;
      }
    }
    const pricingPadded = pricing.padEnd(10);

    // Context
    const contextLen = model.context_length || model.top_provider?.context_length || 0;
    const context = contextLen > 0 ? `${Math.round(contextLen / 1000)}K` : "N/A";
    const contextPadded = context.padEnd(7);

    // Color code local models based on tool support
    if (model.isLocal && model.supportsTools === false) {
      console.log(
        `  ${RED}${modelIdPadded} ${providerPadded} ${pricingPadded} ${contextPadded} ${(score * 100).toFixed(0)}% ✗ no tools${RESET}`
      );
    } else if (model.isLocal && model.supportsTools === true) {
      console.log(
        `  ${GREEN}${modelIdPadded}${RESET} ${providerPadded} ${pricingPadded} ${contextPadded} ${(score * 100).toFixed(0)}%`
      );
    } else {
      console.log(
        `  ${modelIdPadded} ${providerPadded} ${pricingPadded} ${contextPadded} ${(score * 100).toFixed(0)}%`
      );
    }
  }
  console.log("");
  console.log(
    `${DIM}Local models: ${RED}red${RESET}${DIM} = no tool support (incompatible), ${GREEN}green${RESET}${DIM} = compatible${RESET}`
  );
  console.log("");
  console.log("Use OpenRouter model: claudish --model openrouter@<provider/model-id>");
  console.log("OpenAI direct model:  claudish --model oai@<model-name>");
  console.log("Local Ollama model:   claudish --model ollama@<model-name>");
  console.log("OpenCode Zen model:   claudish --model zen@<model-id>");
}

/**
 * Print ALL available models from OpenRouter and local Ollama
 */
async function printAllModels(jsonOutput: boolean, forceUpdate: boolean): Promise<void> {
  let models: any[] = [];

  // Fetch local Ollama models and OpenCode Zen models in parallel
  const [ollamaModels, zenModels] = await Promise.all([
    fetchOllamaModels(),
    fetchZenModels(),
  ]);

  // Check cache for all models
  if (!forceUpdate && existsSync(ALL_MODELS_JSON_PATH)) {
    try {
      const cacheData = JSON.parse(readFileSync(ALL_MODELS_JSON_PATH, "utf-8"));
      const lastUpdated = new Date(cacheData.lastUpdated);
      const now = new Date();
      const ageInDays = (now.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);

      if (ageInDays <= CACHE_MAX_AGE_DAYS) {
        models = cacheData.models;
        if (!jsonOutput) {
          console.error(
            `✓ Using cached models (last updated: ${cacheData.lastUpdated.split("T")[0]})`
          );
        }
      }
    } catch (e) {
      // Ignore cache error
    }
  }

  // Fetch if no cache or stale
  if (models.length === 0) {
    console.error("🔄 Fetching all models from OpenRouter...");
    try {
      const response = await fetch("https://openrouter.ai/api/v1/models");
      if (!response.ok) throw new Error(`API returned ${response.status}`);

      const data = (await response.json()) as { data: any[] };
      models = data.data;

      // Cache result - ensure directory exists
      mkdirSync(CLAUDISH_CACHE_DIR, { recursive: true });
      writeFileSync(
        ALL_MODELS_JSON_PATH,
        JSON.stringify({
          lastUpdated: new Date().toISOString(),
          models,
        }),
        "utf-8"
      );

      console.error(`✅ Cached ${models.length} models`);
    } catch (error) {
      console.error(`❌ Failed to fetch models: ${error}`);
      process.exit(1);
    }
  }

  // JSON output
  if (jsonOutput) {
    const allModels = [...ollamaModels, ...zenModels, ...models];
    console.log(
      JSON.stringify(
        {
          count: allModels.length,
          localCount: ollamaModels.length,
          zenCount: zenModels.length,
          lastUpdated: new Date().toISOString().split("T")[0],
          models: allModels.map((m) => {
            // Add proper prefix for explicit routing
            let id: string;
            if (m.isLocal) {
              id = m.id.replace("ollama/", "ollama@");
            } else if (m.isZen || m.id.startsWith("zen/")) {
              id = m.id.replace("zen/", "zen@");
            } else {
              id = `openrouter@${m.id}`;
            }
            return {
              id,
              name: m.name,
              context: m.context_length || m.top_provider?.context_length,
              pricing: m.pricing,
              isLocal: m.isLocal || false,
              isZen: m.isZen || false,
            };
          }),
        },
        null,
        2
      )
    );
    return;
  }

  // ANSI color codes
  const RED = "\x1b[31m";
  const GREEN = "\x1b[32m";
  const RESET = "\x1b[0m";
  const DIM = "\x1b[2m";

  // Print local Ollama models first if available
  if (ollamaModels.length > 0) {
    const toolCapableCount = ollamaModels.filter((m: any) => m.supportsTools).length;
    console.log(
      `\n🏠 LOCAL OLLAMA MODELS (${ollamaModels.length} installed, ${toolCapableCount} with tool support):\n`
    );
    console.log("    Model                                     Size         Params    Tools");
    console.log("  " + "─".repeat(76));

    for (const model of ollamaModels) {
      // Convert ollama/model-name to ollama@model-name for explicit routing
      const fullId = model.id.replace("ollama/", "ollama@");
      const modelId = fullId.length > 35 ? fullId.substring(0, 32) + "..." : fullId;
      const modelIdPadded = modelId.padEnd(38);
      const size = model.size ? `${(model.size / 1e9).toFixed(1)}GB` : "N/A";
      const sizePadded = size.padEnd(12);
      const params = model.details?.parameter_size || "N/A";
      const paramsPadded = params.padEnd(8);

      if (model.supportsTools) {
        console.log(`    ${modelIdPadded} ${sizePadded} ${paramsPadded}  ${GREEN}✓${RESET}`);
      } else {
        console.log(`    ${RED}${modelIdPadded} ${sizePadded} ${paramsPadded}  ✗ no tools${RESET}`);
      }
    }
    console.log("");
    console.log(`  ${GREEN}✓${RESET} = Compatible with Claude Code (supports tool calling)`);
    console.log(
      `  ${RED}✗${RESET} = Not compatible ${DIM}(Claude Code requires tool support)${RESET}`
    );
    console.log("");
    console.log("  Use: claudish --model ollama@<model-name>");
    console.log("  Pull a compatible model: ollama pull llama3.2");
  } else {
    console.log("\n🏠 LOCAL OLLAMA: Not running or no models installed");
    console.log("   Start Ollama: ollama serve");
    console.log("   Pull a model: ollama pull llama3.2");
  }

  // Print OpenCode Zen models (free ones don't need API key)
  if (zenModels.length > 0) {
    const freeCount = zenModels.filter((m: any) => m.isFree).length;
    console.log(`\n🔮 OPENCODE ZEN (${zenModels.length} models, ${freeCount} FREE - no API key needed):\n`);
    console.log("    Model                          Context    Pricing      Tools");
    console.log("  " + "─".repeat(68));

    // Sort: free models first, then by context size
    const sortedModels = [...zenModels].sort((a, b) => {
      if (a.isFree && !b.isFree) return -1;
      if (!a.isFree && b.isFree) return 1;
      return (b.context_length || 0) - (a.context_length || 0);
    });

    for (const model of sortedModels) {
      // Convert zen/model-id to zen@model-id for explicit routing
      const fullId = model.id.replace("zen/", "zen@");
      const modelId = fullId.length > 30 ? fullId.substring(0, 27) + "..." : fullId;
      const modelIdPadded = modelId.padEnd(32);
      const contextLen = model.context_length || 0;
      const context = contextLen > 0 ? `${Math.round(contextLen / 1000)}K` : "N/A";
      const contextPadded = context.padEnd(10);
      const pricing = model.isFree ? `${GREEN}FREE${RESET}` : `$${(parseFloat(model.pricing?.prompt || "0") + parseFloat(model.pricing?.completion || "0")).toFixed(1)}/M`;
      const pricingPadded = model.isFree ? "FREE        " : pricing.padEnd(12);
      const tools = model.supportsTools ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;

      console.log(`    ${modelIdPadded} ${contextPadded} ${pricingPadded} ${tools}`);
    }
    console.log("");
    console.log(`  ${DIM}FREE models work without API key!${RESET}`);
    console.log("  Use: claudish --model zen@<model-id>");
  }

  // Group by provider
  const byProvider = new Map<string, any[]>();
  for (const model of models) {
    const provider = model.id.split("/")[0];
    if (!byProvider.has(provider)) {
      byProvider.set(provider, []);
    }
    byProvider.get(provider)!.push(model);
  }

  // Sort providers alphabetically
  const sortedProviders = [...byProvider.keys()].sort();

  console.log(`\n☁️  OPENROUTER MODELS (${models.length} total):\n`);

  for (const provider of sortedProviders) {
    const providerModels = byProvider.get(provider)!;
    console.log(`\n  ${provider.toUpperCase()} (${providerModels.length} models)`);
    console.log("  " + "─".repeat(70));

    for (const model of providerModels) {
      // Format model ID with openrouter@ prefix for explicit routing
      const fullId = `openrouter@${model.id}`;
      const modelId = fullId.length > 40 ? fullId.substring(0, 37) + "..." : fullId;
      const modelIdPadded = modelId.padEnd(42);

      // Format pricing (handle special cases: negative = varies, 0 = free)
      const promptPrice = parseFloat(model.pricing?.prompt || "0") * 1000000;
      const completionPrice = parseFloat(model.pricing?.completion || "0") * 1000000;
      const avg = (promptPrice + completionPrice) / 2;
      let pricing: string;
      if (avg < 0) {
        pricing = "varies"; // Auto-router or dynamic pricing
      } else if (avg === 0) {
        pricing = "FREE";
      } else {
        pricing = `$${avg.toFixed(2)}/1M`;
      }
      const pricingPadded = pricing.padEnd(12);

      // Context
      const contextLen = model.context_length || model.top_provider?.context_length || 0;
      const context = contextLen > 0 ? `${Math.round(contextLen / 1000)}K` : "N/A";
      const contextPadded = context.padEnd(8);

      console.log(`    ${modelIdPadded} ${pricingPadded} ${contextPadded}`);
    }
  }

  console.log("\n");
  console.log("Use OpenRouter model:  claudish --model openrouter@<provider/model-id>");
  console.log("  Example:             claudish --model openrouter@google/gemini-2.0-flash-exp:free");
  console.log("Local Ollama model:    claudish --model ollama@<model-name>");
  console.log("OpenCode Zen model:    claudish --model zen@<model-id>");
  console.log("Search:                claudish --search <query>");
  console.log("Top models:            claudish --top-models");
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
    // Last verified: 2026-01-05
    //
    // This list represents the EXACT ranking shown on OpenRouter's website.
    // The website is client-side rendered (React), so we can't scrape it with HTTP.
    // The API doesn't expose the "top-weekly" ranking, so we maintain this manually.
    const topWeeklyProgrammingModels = [
      "x-ai/grok-code-fast-1", // #1: xAI Grok Code Fast 1
      "minimax/minimax-m2.1", // #2: MiniMax M2.1 (Updated)
      "z-ai/glm-4.7", // #3: Z.AI GLM 4.7 (Updated)
      "google/gemini-3-pro-preview", // #4: Google Gemini 3 Pro Preview
      "openai/gpt-5.3", // #5: OpenAI GPT-5.3 (Updated)
      "moonshotai/kimi-k2-thinking", // #6: MoonShot Kimi K2 Thinking (New!)
      "deepseek/deepseek-v3.2", // #7: DeepSeek V3.2 (New!)
      "qwen/qwen3-vl-235b-a22b-thinking", // #8: Qwen3 VL 235B Thinking (Updated)
      "anthropic/claude-sonnet-4.5", // #9: Anthropic Claude Sonnet 4.5
      "anthropic/claude-sonnet-4", // #10: Anthropic Claude Sonnet 4
      "anthropic/claude-haiku-4.5", // #11: Anthropic Claude Haiku 4.5
    ];

    // Fetch model metadata from OpenRouter API
    const apiResponse = await fetch("https://openrouter.ai/api/v1/models");
    if (!apiResponse.ok) {
      throw new Error(`OpenRouter API returned ${apiResponse.status}`);
    }

    const openrouterData = (await apiResponse.json()) as { data: any[] };
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

      const inputPrice = promptPrice > 0 ? `$${(promptPrice * 1000000).toFixed(2)}/1M` : "FREE";
      const outputPrice =
        completionPrice > 0 ? `$${(completionPrice * 1000000).toFixed(2)}/1M` : "FREE";
      const avgPrice =
        promptPrice > 0 || completionPrice > 0
          ? `$${(((promptPrice + completionPrice) / 2) * 1000000).toFixed(2)}/1M`
          : "FREE";

      // Determine category based on description and capabilities
      let category = "programming"; // default since we're filtering programming models
      const lowerDesc = description.toLowerCase() + " " + name.toLowerCase();

      if (
        lowerDesc.includes("vision") ||
        lowerDesc.includes("vl-") ||
        lowerDesc.includes("multimodal")
      ) {
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
          average: avgPrice,
        },
        context: topProvider.context_length
          ? `${Math.floor(topProvider.context_length / 1000)}K`
          : "N/A",
        maxOutputTokens: topProvider.max_completion_tokens || null,
        modality: architecture.modality || "text->text",
        supportsTools: supportedParams.includes("tools") || supportedParams.includes("tool_choice"),
        supportsReasoning:
          supportedParams.includes("reasoning") || supportedParams.includes("include_reasoning"),
        supportsVision:
          (architecture.input_modalities || []).includes("image") ||
          (architecture.input_modalities || []).includes("video"),
        isModerated: topProvider.is_moderated || false,
        recommended: true,
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
      lastUpdated: new Date().toISOString().split("T")[0], // YYYY-MM-DD format
      source: "https://openrouter.ai/models?categories=programming&fmt=cards&order=top-weekly",
      models: recommendations,
    };

    // Write to file
    writeFileSync(MODELS_JSON_PATH, JSON.stringify(updatedData, null, 2), "utf-8");

    console.error(
      `✅ Updated ${recommendations.length} models (last updated: ${updatedData.lastUpdated})`
    );
  } catch (error) {
    console.error(
      `❌ Failed to update models: ${error instanceof Error ? error.message : String(error)}`
    );
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
claudish - Run Claude Code with any AI model (OpenRouter, Gemini, OpenAI, MiniMax, Kimi, GLM, Z.AI, Local)

USAGE:
  claudish                                # Interactive mode (default, shows model selector)
  claudish [OPTIONS] <claude-args...>     # Single-shot mode (requires --model)

MODEL ROUTING:
  New syntax: provider@model[:concurrency]
    google@gemini-3-pro              Direct Google API (explicit)
    openrouter@google/gemini-3-pro   OpenRouter (explicit)
    oai@gpt-5.3                      Direct OpenAI API (shortcut)
    ollama@llama3.2:3                Local Ollama with 3 concurrent requests
    ollama@llama3.2:0                Local Ollama with no limits

  Provider shortcuts:
    g, gemini    -> Google Gemini     google@gemini-3-pro
    oai          -> OpenAI Direct     oai@gpt-5.3
    xai, x-ai    -> xAI Direct        xai@grok-4-1-fast-reasoning
    or           -> OpenRouter        or@openai/gpt-5.3
    mm, mmax     -> MiniMax Direct    mm@MiniMax-M2.1
    kimi, moon   -> Kimi Direct       kimi@kimi-k2-thinking-turbo
    kc           -> Kimi Coding       kc@kimi-for-coding
    glm, zhipu   -> GLM Direct        glm@glm-4.7
    zai          -> Z.AI Direct       zai@glm-4.7
    oc           -> OllamaCloud       oc@llama-3.1
    llama,lc,meta-> OllamaCloud       llama@llama-3.1
    zen          -> OpenCode Zen      zen@grok-code
    v, vertex    -> Vertex AI         v@gemini-2.5-flash
    go           -> Gemini CodeAssist go@gemini-2.5-flash
    poe          -> Poe               poe@GPT-4o
    litellm, ll  -> LiteLLM           litellm@model-name
    ollama       -> Ollama (local)    ollama@llama3.2
    lms,lmstudio -> LM Studio (local) lms@qwen
    vllm         -> vLLM (local)      vllm@model
    mlx          -> MLX (local)       mlx@model

  Native model auto-detection (when no provider specified):
    google/*, gemini-*      -> Google API
    openai/*, gpt-*, o1-*   -> OpenAI API
    x-ai/*, xai/*, grok-*   -> xAI API
    meta-llama/*, llama-*   -> OllamaCloud
    minimax/*, abab-*       -> MiniMax API
    moonshot/*, kimi-*      -> Kimi API
    zhipu/*, glm-*          -> GLM API
    poe:*                   -> Poe
    anthropic/*, claude-*   -> Native Anthropic
    (unknown vendor/)       -> Error (use openrouter@vendor/model)

  Legacy syntax (deprecated, still works):
    g/, gemini/      Google Gemini API      claudish --model g/gemini-2.0-flash "task"
    oai/             OpenAI Direct API      claudish --model oai/gpt-4o "task"
    xai/, x-ai/      xAI Direct API         claudish --model xai/grok-4-1-fast-reasoning "task"
    mmax/, mm/       MiniMax Direct API     claudish --model mmax/MiniMax-M2.1 "task"
    kimi/, moonshot/ Kimi Direct API        claudish --model kimi/kimi-k2-thinking-turbo "task"
    kc/              Kimi Coding API        claudish --model kc/kimi-for-coding "task"
    ollama/          Ollama (local)         claudish --model ollama/llama3.2 "task"
    http://...       Custom endpoint        claudish --model http://localhost:8000/model "task"

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
  --stream                 Stream NDJSON events directly (bypasses Claude Code)
                           Output: {"event":"delta","content":"..."}
  --stdin                  Read prompt from stdin (useful for large prompts or piping)
  --free                   Show only FREE models in the interactive selector
  --monitor                Monitor mode - proxy to REAL Anthropic API and log all traffic
  -y, --auto-approve       Skip permission prompts (--dangerously-skip-permissions)
  --no-auto-approve        Explicitly enable permission prompts (default)
  --dangerous              Pass --dangerouslyDisableSandbox to Claude Code
  --cost-tracker           Enable cost tracking for API usage (NB!)
  --audit-costs            Show cost analysis report
  --reset-costs            Reset accumulated cost statistics
  --litellm-url URL        LiteLLM proxy base URL (e.g., https://your-instance.com)
  --litellm-key KEY        LiteLLM API key (optional, depends on proxy configuration)
  --models                 List ALL models (OpenRouter + OpenCode Zen + Ollama)
  --models <query>         Fuzzy search all models by name, ID, or description
  --top-models             List recommended/top programming models (curated)
  --json                   Output in JSON format (use with --models or --top-models)
  --force-update           Force refresh model cache from OpenRouter API
  --version                Show version information
  -h, --help               Show this help message
  --help-ai                Show AI agent usage guide (file-based patterns, sub-agents)
  --init                   Install Claudish skill in current project (.claude/skills/)

PROFILE MANAGEMENT:
  claudish init [--local|--global]            Setup wizard - create config and first profile
  claudish profile list [--local|--global]    List all profiles (both scopes by default)
  claudish profile add [--local|--global]     Add a new profile
  claudish profile remove [name] [--local|--global]  Remove a profile
  claudish profile use [name] [--local|--global]     Set default profile
  claudish profile show [name] [--local|--global]    Show profile details
  claudish profile edit [name] [--local|--global]    Edit a profile

  Scope flags:
    --local   Target .claudish.json in the current directory (project-specific)
    --global  Target ~/.claudish/config.json (shared across projects)
    (omit)    Prompted interactively; suggests local if in a project directory

UPDATE:
  claudish update          Check for updates and install latest version

AUTHENTICATION:
  --gemini-login           Login to Gemini Code Assist via OAuth (for go@ prefix)
  --gemini-logout          Clear Gemini OAuth credentials
  --kimi-login             Login to Kimi/Moonshot AI via OAuth (for kimi@ prefix)
  --kimi-logout            Clear Kimi OAuth credentials

MODEL MAPPING (per-role override):
  --model-opus <model>     Model for Opus role (planning, complex tasks)
  --model-sonnet <model>   Model for Sonnet role (default coding)
  --model-haiku <model>    Model for Haiku role (fast tasks, background)
  --model-subagent <model> Model for sub-agents (Task tool)

CUSTOM MODELS:
  Claudish accepts ANY valid OpenRouter model ID, even if not in --list-models
  Example: claudish --model openrouter@your_provider/custom-model-123 "task"

MODES:
  • Interactive mode (default): Shows model selector, starts persistent session
  • Single-shot mode: Runs one task in headless mode and exits (requires --model)

NOTES:
  • Permission prompts are ENABLED by default (normal Claude Code behavior)
  • Use -y or --auto-approve to skip permission prompts
  • Model selector appears ONLY in interactive mode when --model not specified
  • Use --dangerous to disable sandbox (use with extreme caution!)

ENVIRONMENT VARIABLES:
  Claudish automatically loads .env file from current directory.

  Claude Code installation:
  CLAUDE_PATH                     Custom path to Claude Code binary (optional)
                                  Default search order:
                                  1. CLAUDE_PATH env var
                                  2. ~/.claude/local/claude (local install)
                                  3. Global PATH (npm -g install)

  API Keys (at least one required for cloud models):
  OPENROUTER_API_KEY              OpenRouter API key (default backend)
  GEMINI_API_KEY                  Google Gemini API key (for g/ prefix)
  VERTEX_API_KEY                  Vertex AI Express API key (for v/ prefix)
  VERTEX_PROJECT                  Vertex AI project ID (OAuth mode, for v/ prefix)
  VERTEX_LOCATION                 Vertex AI region (default: us-central1)
  OPENAI_API_KEY                  OpenAI API key (for oai/ prefix)
  MINIMAX_API_KEY                 MiniMax API key (for mmax/, mm/ prefix)
  MOONSHOT_API_KEY                Kimi/Moonshot API key (for kimi/, moonshot/ prefix)
  KIMI_API_KEY                    Alias for MOONSHOT_API_KEY
  KIMI_CODING_API_KEY             Kimi Coding API key (for kc/ prefix, from kimi.com/code membership)
  ZHIPU_API_KEY                   GLM/Zhipu API key (for glm/, zhipu/ prefix)
  GLM_API_KEY                     Alias for ZHIPU_API_KEY
  OLLAMA_API_KEY                  OllamaCloud API key (for oc/ prefix)
  OPENCODE_API_KEY                OpenCode Zen API key (optional - free models work without it)
  LITELLM_BASE_URL                LiteLLM proxy base URL (required for litellm@ prefix)
  LITELLM_API_KEY                 LiteLLM API key (optional, depends on proxy configuration)
  ANTHROPIC_API_KEY               Placeholder (prevents Claude Code dialog)
  ANTHROPIC_AUTH_TOKEN            Placeholder (prevents Claude Code login screen)

  Custom endpoints:
  GEMINI_BASE_URL                 Custom Gemini endpoint
  OPENAI_BASE_URL                 Custom OpenAI/Azure endpoint
  MINIMAX_BASE_URL                Custom MiniMax endpoint
  MOONSHOT_BASE_URL               Custom Kimi/Moonshot endpoint
  KIMI_BASE_URL                   Alias for MOONSHOT_BASE_URL
  ZHIPU_BASE_URL                  Custom GLM/Zhipu endpoint
  GLM_BASE_URL                    Alias for ZHIPU_BASE_URL
  OLLAMACLOUD_BASE_URL            Custom OllamaCloud endpoint (default: https://ollama.com)
  OPENCODE_BASE_URL               Custom OpenCode Zen endpoint (default: https://opencode.ai/zen)

  Local providers:
  OLLAMA_BASE_URL                 Ollama server (default: http://localhost:11434)
  OLLAMA_HOST                     Alias for OLLAMA_BASE_URL
  LMSTUDIO_BASE_URL               LM Studio server (default: http://localhost:1234)
  VLLM_BASE_URL                   vLLM server (default: http://localhost:8000)
  MLX_BASE_URL                    MLX server (default: http://127.0.0.1:8080)

  Model settings:
  CLAUDISH_MODEL                  Default model to use (default: openai/gpt-5.3)
  CLAUDISH_PORT                   Default port for proxy
  CLAUDISH_CONTEXT_WINDOW         Override context window size

  Model mapping (per-role):
  CLAUDISH_MODEL_OPUS             Override model for Opus role
  CLAUDISH_MODEL_SONNET           Override model for Sonnet role
  CLAUDISH_MODEL_HAIKU            Override model for Haiku role
  CLAUDISH_MODEL_SUBAGENT         Override model for sub-agents

EXAMPLES:
  # Interactive mode (default) - shows model selector
  claudish
  claudish --interactive

  # Interactive mode with only FREE models
  claudish --free

  # New @ syntax - explicit provider routing
  claudish --model google@gemini-3-pro "implement user authentication"
  claudish --model openrouter@openai/gpt-5.3 "add tests for login"
  claudish --model oai@gpt-5.3 "direct to OpenAI"

  # Native model auto-detection (provider detected from model name)
  claudish --model gpt-4o "routes to OpenAI API (detected from model name)"
  claudish --model llama-3.1-70b "routes to OllamaCloud (detected)"
  claudish --model openrouter@deepseek/deepseek-r1 "explicit OpenRouter for unknown vendors"

  # Direct Gemini API (multiple ways)
  claudish --model google@gemini-2.0-flash "explicit Google"
  claudish --model g@gemini-2.0-flash "shortcut"
  claudish --model gemini-2.5-pro "auto-detected from model name"

  # Vertex AI (Google Cloud - supports Google + partner models)
  VERTEX_API_KEY=... claudish --model v@gemini-2.5-flash "Express mode"
  VERTEX_PROJECT=my-project claudish --model vertex@gemini-2.5-flash "OAuth mode"

  # Direct OpenAI API
  claudish --model oai@gpt-4o "implement feature"
  claudish --model oai@o1 "complex reasoning"

  # Direct MiniMax API
  claudish --model mm@MiniMax-M2.1 "implement feature"
  claudish --model mmax@MiniMax-M2 "code review"

  # Direct Kimi API (with reasoning support)
  claudish --model kimi@kimi-k2-thinking-turbo "complex analysis"

  # Kimi Coding (subscription-based, API key or OAuth)
  claudish --model kc@kimi-for-coding "implement feature"

  # Direct GLM API
  claudish --model glm@glm-4.7 "code generation"

  # OpenCode Zen (free models)
  claudish --model zen@grok-code "implement feature"

  # Local models with concurrency control
  claudish --model ollama@llama3.2 "default sequential (1 at a time)"
  claudish --model ollama@llama3.2:3 "allow 3 concurrent requests"
  claudish --model ollama@llama3.2:0 "no limits (bypass queue)"
  claudish --model lms@qwen2.5-coder "LM Studio shortcut"

  # Per-role model mapping (works with all syntaxes)
  claudish --model-opus oai@gpt-5.3 --model-sonnet google@gemini-3-pro --model-haiku mm@MiniMax-M2.1

  # Use stdin for large prompts (e.g., git diffs, code review)
  echo "Review this code..." | claudish --stdin --model g@gemini-2.0-flash
  git diff | claudish --stdin --model oai@gpt-5.3 "Review these changes"

  # Monitor mode - understand how Claude Code works
  claudish --monitor --debug "analyze code structure"

  # Skip permission prompts (auto-approve)
  claudish -y "make changes to config"
  claudish --auto-approve "refactor the function"

  # Dangerous mode (disable sandbox - use with extreme caution)
  claudish --dangerous "refactor entire codebase"

  # Both flags (fully autonomous - no prompts, no sandbox)
  claudish -y --dangerous "refactor entire codebase"

  # With custom port
  claudish --port 3000 "analyze code structure"

  # Pass flags to claude
  claudish --model xai@grok-code-fast-1 --verbose "debug issue"

  # JSON output for tool integration (quiet by default)
  claudish --json "list 5 prime numbers"

  # Streaming NDJSON output (bypasses Claude Code, direct API calls)
  claudish --stream --model gpt-4o "Hello world"
  cat prompt.txt | claudish --stream --stdin --model gemini-2.0-flash
  claudish --stream --model grok-code "Explain recursion" | jq -c 'select(.event=="delta")'

  # Verbose mode in single-shot (show [claudish] logs)
  claudish --verbose "analyze code structure"

LOCAL MODELS (Ollama, LM Studio, vLLM):
  # Use local Ollama model (prefix syntax)
  claudish --model ollama/llama3.2 "implement feature"
  claudish --model ollama:codellama "review this code"

  # Use local LM Studio model
  claudish --model lmstudio/qwen2.5-coder "write tests"

  # Use any OpenAI-compatible endpoint (URL syntax)
  claudish --model "http://localhost:11434/llama3.2" "task"
  claudish --model "http://192.168.1.100:8000/mistral" "remote server"

  # Custom Ollama endpoint
  OLLAMA_BASE_URL=http://192.168.1.50:11434 claudish --model ollama/llama3.2 "task"
  OLLAMA_HOST=http://192.168.1.50:11434 claudish --model ollama/llama3.2 "task"

AVAILABLE MODELS:
  List all models:     claudish --models  (includes OpenRouter, OpenCode Zen, Ollama)
  Search models:       claudish --models <query>
  Top recommended:     claudish --top-models
  Free models only:    claudish --free  (interactive selector with free models)
  JSON output:         claudish --models --json
  Force cache update:  claudish --models --force-update
  (Cache auto-updates every 2 days)

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
    console.error(
      "https://github.com/MadAppGang/claude-code/blob/main/mcp/claudish/AI_AGENT_GUIDE.md"
    );
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
    console.log('   - User: "use Grok to implement feature X"');
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
      // Add openrouter@ prefix for explicit routing
      const displayModel = model === "custom" ? model : `openrouter@${model}`;
      console.log(`  ${displayModel}`);
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
    // Format model ID with openrouter@ prefix for explicit routing
    const fullModelId = model.id.startsWith("openrouter@") ? model.id : `openrouter@${model.id}`;
    const modelId = fullModelId.length > 30 ? fullModelId.substring(0, 27) + "..." : fullModelId;
    const modelIdPadded = modelId.padEnd(30);

    // Format provider (max 10 chars)
    const provider =
      model.provider.length > 10 ? model.provider.substring(0, 7) + "..." : model.provider;
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

    console.log(
      `  ${modelIdPadded} ${providerPadded} ${pricingPadded} ${contextPadded} ${capabilities}`
    );
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

    // Add openrouter@ prefix to model IDs for explicit routing
    const outputData = {
      ...data,
      models: data.models.map((model: any) => ({
        ...model,
        id: model.id.startsWith("openrouter@") ? model.id : `openrouter@${model.id}`,
      })),
    };

    // Output clean JSON to stdout
    console.log(JSON.stringify(outputData, null, 2));
  } catch (error) {
    // If JSON file doesn't exist, construct from model info
    const models = getAvailableModels();
    const modelInfo = loadModelInfo();

    const output = {
      version: VERSION,
      lastUpdated: new Date().toISOString().split("T")[0],
      source: "runtime",
      models: models
        .filter((m) => m !== "custom")
        .map((modelId) => {
          const info = modelInfo[modelId];
          return {
            // Add openrouter@ prefix for explicit routing
            id: `openrouter@${modelId}`,
            name: info.name,
            description: info.description,
            provider: info.provider,
            priority: info.priority,
          };
        }),
    };

    console.log(JSON.stringify(output, null, 2));
  }
}

/**
 * Fetch ALL OpenCode Zen models from models.dev API
 * Returns all models with full metadata, marks free ones
 */
async function fetchZenModels(): Promise<any[]> {
  try {
    const response = await fetch("https://models.dev/api.json", {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    const opencode = data.opencode;
    if (!opencode?.models) return [];

    // Get all models with metadata
    return Object.entries(opencode.models)
      .map(([id, m]: [string, any]) => {
        const isFree = m.cost?.input === 0 && m.cost?.output === 0;
        return {
          id: `zen/${id}`,
          name: m.name || id,
          context_length: m.limit?.context || 128000,
          max_output: m.limit?.output || 32000,
          pricing: isFree ? { prompt: "0", completion: "0" } : { prompt: String(m.cost?.input || 0), completion: String(m.cost?.output || 0) },
          isZen: true,
          isFree,
          supportsTools: m.tool_call || false,
          supportsReasoning: m.reasoning || false,
        };
      });
  } catch {
    return [];
  }
}

/**
 * Fetch GLM Coding Plan models from models.dev API
 * Returns all models with full metadata (subscription-based, all free)
 */
async function fetchGLMCodingModels(): Promise<any[]> {
  try {
    const response = await fetch("https://models.dev/api.json", {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    const codingPlan = data["zai-coding-plan"];
    if (!codingPlan?.models) return [];

    return Object.entries(codingPlan.models)
      .map(([id, m]: [string, any]) => {
        const inputModalities = m.modalities?.input || [];
        return {
          id: `gc/${id}`,
          name: m.name || id,
          description: `GLM Coding Plan model (subscription)`,
          context_length: m.limit?.context || 131072,
          pricing: { prompt: "0", completion: "0" },
          isGLMCoding: true,
          isSubscription: true,
          supportsTools: m.tool_call || false,
          supportsReasoning: m.reasoning || false,
          supportsVision: inputModalities.includes("image") || inputModalities.includes("video"),
        };
      });
  } catch {
    return [];
  }
}
