import { VERSION } from "./version.js";
import { ENV } from "./config.js";
import type { ClaudishConfig } from "./types.js";
import {
  loadModelInfo,
  getAvailableModels,
  getRecommendedModels,
  searchModels,
  getModelsByProvider,
  getProviderList,
  getTop100Models,
  groupRecommendedModels,
  collectRoutingPrefixes,
  computeQuickPicks,
  normalizePricingDisplay,
  FIREBASE_SLUG_TO_PROVIDER_NAME,
  type RecommendedModelGroup,
  type ModelDoc,
} from "./model-loader.js";
import { compareByReleaseDateDesc } from "./model-selector.js";
import { BUILTIN_PROVIDERS } from "./providers/provider-definitions.js";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getModelMapping, loadConfig, loadLocalConfig } from "./profile-config.js";
import { buildLegacyHint, resolveDefaultProvider } from "./default-provider.js";
import { parseModelSpec } from "./providers/model-parser.js";
import { type FallbackRoute } from "./providers/auto-route.js";
import {
  loadRoutingRules,
  matchRoutingRule,
  buildRoutingChain,
} from "./providers/routing-rules.js";
import {
  resolveApiKeyProvenance,
  type KeyProvenance,
} from "./providers/api-key-provenance.js";
import { API_KEY_MAP } from "./providers/api-key-map.js";
import {
  probeLink,
  describeProbeState,
  type ProbeResult,
} from "./providers/probe-live.js";
import { startProbeTui } from "./probe/probe-tui-runtime.js";
import type {
  ProbeAppState,
  ProbeLinkState,
  ProbeStepState,
} from "./probe/probe-tui-app.js";
import {
  printProbeResults,
  type ModelResult as PrintableModelResult,
} from "./probe/probe-results-printer.js";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Get current version
 */
export function getVersion(): string {
  return VERSION;
}

/**
 * Clear writable claudish caches (pricing, LiteLLM, recommended models).
 * Called when --force-update flag is used.
 *
 * NOTE: We intentionally do NOT delete `all-models.json` — that file is the
 * OpenRouter catalog resolver's slim-catalog cache, sourced from Firebase.
 * Deleting it would force a cold re-warm on every --force-update call.
 */
function clearAllModelCaches(): void {
  const cacheDir = join(homedir(), ".claudish");
  if (!existsSync(cacheDir)) return;

  const cachePatterns = ["pricing-cache.json", "recommended-models-cache.json"];
  let cleared = 0;

  try {
    const files = readdirSync(cacheDir);
    for (const file of files) {
      if (cachePatterns.includes(file)) {
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
 * Parse the --advisor flag value.
 * Format: "model1,model2,model3:collector"
 *   - Split on last ":" → advisors | collector
 *   - No ":" → default collector = "haiku"
 *   - Trailing ":" → no collector (raw concat)
 *   - Single advisor → no collector (passthrough)
 */
export function parseAdvisorFlag(value: string): {
  models: string[];
  collector: string | null;
} {
  const colonIdx = value.lastIndexOf(":");
  let advisorPart: string;
  let collectorPart: string | undefined;

  if (colonIdx >= 0) {
    advisorPart = value.slice(0, colonIdx);
    collectorPart = value.slice(colonIdx + 1).trim();
  } else {
    advisorPart = value;
    collectorPart = undefined;
  }

  const models = advisorPart.split(",").map(s => s.trim()).filter(Boolean);

  let collector: string | null;
  if (models.length <= 1) {
    collector = null;
  } else if (collectorPart === undefined) {
    collector = "haiku";
  } else if (collectorPart === "") {
    collector = null;
  } else {
    collector = collectorPart;
  }

  return { models, collector };
}

/**
 * Parse CLI arguments and environment variables
 */
export async function parseArgs(args: string[]): Promise<ClaudishConfig> {
  const config: Partial<ClaudishConfig> & { claudeArgs: string[] } = {
    model: undefined, // Will prompt interactively if not provided
    autoApprove: true, // Auto-approve enabled by default (confirmed on first run)
    dangerous: false,
    interactive: false, // Single-shot mode by default
    debug: false, // No debug logging by default
    logLevel: "info", // Default to info level (structured logging with truncated content)
    quiet: undefined, // Will be set based on mode (true for single-shot, false for interactive)
    jsonOutput: false, // No JSON output by default
    monitor: false, // Monitor mode disabled by default
    stdin: false, // Read prompt from stdin instead of args
    freeOnly: false, // Show all models by default
    noLogs: false, // Always-on structural logging enabled by default
    diagMode: "auto" as const, // Auto-detect best diagnostic output mode
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
  config.modelFable =
    process.env[ENV.CLAUDISH_MODEL_FABLE] || process.env[ENV.ANTHROPIC_DEFAULT_FABLE_MODEL];
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

  // Load diagMode from settings file (lowest priority — env/CLI override)
  try {
    const fileConfig = loadConfig();
    if (
      fileConfig.diagMode &&
      ["auto", "logfile", "off"].includes(fileConfig.diagMode)
    ) {
      config.diagMode = fileConfig.diagMode;
    }
  } catch {}

  // Check for diagnostic mode env var (overrides settings file)
  const envDiagMode = process.env[ENV.CLAUDISH_DIAG_MODE]?.toLowerCase();
  if (envDiagMode && ["auto", "logfile", "off"].includes(envDiagMode)) {
    config.diagMode = envDiagMode as typeof config.diagMode;
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
    } else if (arg === "--model-fable") {
      const val = args[++i];
      if (val) config.modelFable = val;
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
    } else if (arg === "--monitor") {
      config.monitor = true;
    } else if (arg === "--advisor") {
      const modelsArg = args[++i];
      if (!modelsArg) {
        console.error("--advisor requires a comma-separated list of models (e.g., 'gemini-3-pro,grok-3')");
        process.exit(1);
      }
      const parsed = parseAdvisorFlag(modelsArg);
      config.advisorModels = parsed.models;
      config.advisorCollector = parsed.collector;
      config.monitor = true;
    } else if (arg === "--stdin") {
      config.stdin = true;
    } else if (arg === "--free") {
      config.freeOnly = true;
    } else if (arg === "--force-update") {
      // Force-refresh model caches. Consumed by the --top-models/--list-models
      // branches below AND (after the launcher warm step lands) by
      // warmCatalogIfNeeded() to bypass the TTL check.
      config.forceUpdate = true;
    } else if (arg === "--skip-models-update") {
      // Skip the launcher catalog warm step entirely. No runtime effect yet —
      // wired up by a later commit that introduces warmCatalogIfNeeded().
      config.skipModelsUpdate = true;
    } else if (arg === "--profile") {
      const profileArg = args[++i];
      if (!profileArg) {
        console.error("--profile requires a profile name");
        process.exit(1);
      }
      config.profile = profileArg;
    } else if (arg === "--default-provider") {
      const dpArg = args[++i];
      if (!dpArg) {
        console.error("--default-provider requires a provider name");
        process.exit(1);
      }
      config.defaultProvider = dpArg;
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
    } else if (arg === "--probe") {
      // Probe models — show fallback chain for each model
      const probeModels: string[] = [];
      while (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        probeModels.push(args[++i]);
      }
      // Support comma-separated: --probe minimax-m2.5,kimi-k2.5,gemini-3.1-pro-preview
      const expandedModels = probeModels.flatMap((m) =>
        m
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      );
      if (expandedModels.length === 0) {
        console.error("--probe requires at least one model name");
        console.error("Usage: claudish --probe minimax-m2.5 kimi-k2.5 gemini-3.1-pro-preview");
        console.error("   or: claudish --probe minimax-m2.5,kimi-k2.5,gemini-3.1-pro-preview");
        process.exit(1);
      }
      const hasJsonFlag = args.includes("--json");
      const noProbeFlag = args.includes("--no-probe");
      let probeTimeoutMs = 40000;
      const probeTimeoutIdx = args.indexOf("--probe-timeout");
      if (probeTimeoutIdx !== -1 && probeTimeoutIdx + 1 < args.length) {
        const raw = args[probeTimeoutIdx + 1];
        const parsed = parseInt(raw, 10);
        if (!isNaN(parsed) && parsed > 0) {
          probeTimeoutMs = parsed * 1000;
        }
      }
      await probeModelRouting(expandedModels, hasJsonFlag, {
        live: !noProbeFlag,
        timeoutMs: probeTimeoutMs,
      });
      process.exit(0);
    } else if (arg === "--model-freshness") {
      const { checkModelFreshness } = await import("./providers/model-freshness.js");
      const profileFable = getModelMapping(config.profile).fable;
      const results = await checkModelFreshness({
        currentFable: process.env[ENV.ANTHROPIC_DEFAULT_FABLE_MODEL],
        currentAstra: process.env[ENV.CLAUDISH_MODEL_FABLE] || profileFable,
        force: true,
        quiet: true,
      });
      if (args.includes("--json")) {
        console.log(JSON.stringify({ results }, null, 2));
      } else if (results.length === 0) {
        console.log("Model freshness is unavailable: configure both Fable and Astra pins.");
      } else {
        console.log("\nModel freshness:\n");
        for (const result of results) {
          console.log(
            `  ${result.family.padEnd(7)} ${result.current} -> ${result.latest ?? "unknown"} (${result.status})`
          );
        }
        console.log("\nDetection is read-only; model promotion requires explicit configuration changes.\n");
      }
      process.exit(0);
    } else if (arg === "--top-models") {
      // Show recommended/top models (curated Firebase catalog)
      const hasJsonFlag = args.includes("--json");
      // Read from cliConfig (set by the main argv loop). Fall back to args.includes
      // so behavior is preserved when --force-update appears AFTER --top-models in argv.
      const forceUpdate = config.forceUpdate || args.includes("--force-update");

      if (forceUpdate) clearAllModelCaches();

      await printRecommendedModels(hasJsonFlag, forceUpdate);
      process.exit(0);
    } else if (arg === "--list-providers") {
      // List every provider in the Firebase catalog + active-model count.
      const hasJsonFlag = args.includes("--json");
      try {
        const providers = await getProviderList();
        if (hasJsonFlag) {
          console.log(JSON.stringify({ providers, total: providers.length }, null, 2));
        } else {
          console.log("\nProviders in Firebase catalog:\n");
          console.log("  Slug                 Active models");
          console.log("  " + "─".repeat(40));
          for (const { slug, count } of providers) {
            console.log(`  ${slug.padEnd(20)} ${String(count).padStart(5)}`);
          }
          console.log("\nUsage:  claudish --list-models --provider <slug>");
          console.log("        claudish -s <query>                    (fuzzy search)\n");
        }
        process.exit(0);
      } catch (err) {
        console.error(
          `Failed to fetch providers: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    } else if (
      arg === "--models" ||
      arg === "--list-models" ||
      arg === "-s" ||
      arg === "--search"
    ) {
      // Check for optional search query (next arg that doesn't start with --)
      const nextArg = args[i + 1];
      const hasQuery = nextArg && !nextArg.startsWith("--");
      const query = hasQuery ? args[++i] : null;

      const hasJsonFlag = args.includes("--json");
      // Read from cliConfig (set by the main argv loop). Fall back to args.includes
      // so behavior is preserved when --force-update appears AFTER --list-models in argv.
      const forceUpdate = config.forceUpdate || args.includes("--force-update");

      // Pick up --provider <slug> anywhere in the argv. We DON'T consume it
      // from the loop — it's read-once here and harmless to let the outer
      // passthrough swallow it later because we exit before that.
      const providerIdx = args.indexOf("--provider");
      const providerSlug =
        providerIdx !== -1 && providerIdx + 1 < args.length
          ? args[providerIdx + 1]
          : null;

      if (forceUpdate) clearAllModelCaches();

      if (query && providerSlug) {
        // --provider is a filter for the catalog browser; searches are
        // already Firebase-scoped and don't take a provider slug.
        console.error(
          "Use --provider together with --list-models (without a query) to filter the catalog."
        );
        console.error("For keyword search, drop --provider: claudish -s <query>");
        process.exit(1);
      }

      if (query) {
        // Search mode: on-demand Firebase substring search
        await searchAndPrintModels(query, hasJsonFlag);
      } else if (providerSlug) {
        // Provider filter: Firebase catalog trimmed to one provider
        await printByProvider(providerSlug, hasJsonFlag);
      } else {
        // Default --list-models = top100 ranked Firebase catalog + local footer
        await printTop100(hasJsonFlag);
      }
      process.exit(0);
    } else if (arg === "--summarize-tools") {
      // Summarize tool descriptions to reduce prompt size for local models
      config.summarizeTools = true;
    } else if (arg === "--no-logs") {
      // Disable always-on structural logging to ~/.claudish/logs/
      config.noLogs = true;
    } else if (arg === "--diag-mode" && i + 1 < args.length) {
      const mode = args[++i].toLowerCase();
      if (["auto", "logfile", "off"].includes(mode)) {
        config.diagMode = mode as typeof config.diagMode;
      }
    } else if (arg === "--team" && i + 1 < args.length) {
      const models = args[++i]
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
      config.team = models;
    } else if (arg === "--mode" && i + 1 < args.length) {
      const mode = args[++i].toLowerCase();
      if (["default", "interactive", "json"].includes(mode)) {
        config.teamMode = mode as "default" | "interactive" | "json";
      }
    } else if (arg === "--keep") {
      config.teamKeep = true;
    } else if ((arg === "-f" || arg === "--file") && i + 1 < args.length) {
      config.inputFile = args[++i];
    } else if (arg === "--") {
      // Explicit separator: everything after -- passes directly to Claude Code.
      // This handles edge cases where a value starts with '-' (e.g. a system prompt
      // that begins with a dash, or a flag value that looks like a flag).
      const rest = args.slice(i + 1);
      config.claudeArgs.push(...rest);
      if (rest.length > 0) config._hasPositionalPrompt = true;
      break;
    } else if (arg.startsWith("-")) {
      // Unknown flag: pass through to Claude Code with value consumed if present.
      // Value consumption rule: if the next token exists and does NOT start with '-',
      // treat it as this flag's value. This handles:
      //   --agent detective          → ['--agent', 'detective']
      //   --effort high              → ['--effort', 'high']
      //   --no-session-persistence   → ['--no-session-persistence']  (no value)
      //   --system-prompt "text"     → ['--system-prompt', 'text']
      //   --allowedTools Bash,Edit   → ['--allowedTools', 'Bash,Edit']
      config.claudeArgs.push(arg);
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        config.claudeArgs.push(args[++i]);
      }
    } else {
      // Positional argument (prompt text): pass through to Claude Code in order.
      // Example: claudish --model grok "hello world"
      //          → claudeArgs = ['hello world']
      config.claudeArgs.push(arg);
      config._hasPositionalPrompt = true;
    }

    i++;
  }

  // Determine if this will be interactive mode BEFORE API key check
  // If no prompt provided and not explicitly interactive, default to interactive mode
  // Exception: --stdin mode reads prompt from stdin, so don't default to interactive
  // A "prompt" is a positional arg that appears outside of flag-value pairs.
  // Flags like "--session-id uuid --dangerously-skip-permissions" have no prompt,
  // so they should be interactive too.
  if (!config._hasPositionalPrompt && !config.stdin) {
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
    !config.modelFable ||
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
    if (!config.modelFable && profileModels.fable) {
      config.modelFable = profileModels.fable;
    }
    if (!config.modelSubagent && profileModels.subagent) {
      config.modelSubagent = profileModels.subagent;
    }
  }

  // Phase 1 (LiteLLM-demotion refactor): resolve the effective default provider
  // and emit a one-shot stderr hint when legacy LITELLM auto-promotion kicks in.
  // This currently has no routing effect — Phase 2 wires it into auto-route.
  try {
    const fileConfigForResolver = loadConfig();
    const resolved = resolveDefaultProvider({
      cliFlag: config.defaultProvider,
      config: fileConfigForResolver,
      env: process.env,
    });
    config.resolvedDefaultProvider = resolved;

    if (resolved.legacyAutoPromoted && !config.quiet) {
      const markerFile = join(homedir(), ".claudish", ".legacy-litellm-hint-shown");
      if (!existsSync(markerFile)) {
        const hint = buildLegacyHint(resolved);
        if (hint) {
          console.error(hint);
        }
        try {
          // Touch the marker so we don't show it again. Best-effort — failure is OK.
          mkdirSync(dirname(markerFile), { recursive: true });
          writeFileSync(markerFile, new Date().toISOString(), "utf-8");
        } catch {}
      }
    }
  } catch {}

  return config as ClaudishConfig;
}

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

/** Format a ModelDoc numeric pricing block for display. */
function formatModelDocPricing(pricing: ModelDoc["pricing"]): string {
  if (!pricing) return "N/A";
  const input = typeof pricing.input === "number" ? pricing.input : undefined;
  const output = typeof pricing.output === "number" ? pricing.output : undefined;
  if (input === undefined && output === undefined) return "N/A";
  if ((input ?? 0) === 0 && (output ?? 0) === 0) return "FREE";
  const avg = ((input ?? 0) + (output ?? 0)) / 2;
  return `$${avg.toFixed(2)}/1M`;
}

/** Format a ModelDoc contextWindow (tokens) for display. */
function formatModelDocContext(ctx?: number): string {
  if (!ctx || ctx <= 0) return "N/A";
  if (ctx >= 1_000_000) return `${Math.round(ctx / 1_000_000)}M`;
  return `${Math.round(ctx / 1000)}K`;
}

/** Short capability badges for a ModelDoc. */
function formatModelDocCaps(caps?: ModelDoc["capabilities"]): string {
  if (!caps) return "·";
  const parts: string[] = [];
  if (caps.tools) parts.push("T");
  if (caps.thinking) parts.push("R");
  if (caps.vision) parts.push("V");
  return parts.length > 0 ? parts.join("") : "·";
}

/**
 * Search Firebase's model catalog and print results.
 * No local full-catalog cache — every call hits the network.
 */
async function searchAndPrintModels(query: string, jsonOutput: boolean): Promise<void> {
  let results: ModelDoc[];
  try {
    console.error(`🔄 Searching Firebase catalog for "${query}"...`);
    results = await searchModels(query, 50);
  } catch (error) {
    console.error(
      `❌ Failed to reach Firebase model catalog: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    console.error("   Check your network connection.");
    process.exit(1);
  }

  if (results.length === 0) {
    if (jsonOutput) {
      console.log(JSON.stringify({ query, count: 0, models: [] }, null, 2));
    } else {
      console.log(`No models found matching "${query}"`);
    }
    return;
  }

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          query,
          count: results.length,
          models: results.map((m) => ({
            id: m.modelId,
            provider: m.provider,
            contextWindow: m.contextWindow,
            pricing: m.pricing,
            capabilities: m.capabilities,
            aliases: m.aliases,
            status: m.status,
          })),
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`\nFound ${results.length} matching models:\n`);
  const sorted = [...results].sort(compareByReleaseDateDesc);
  renderModelDocTable(sorted, /* showRank */ false);
  console.log("");
  console.log("Caps: T = tools  R = reasoning  V = vision");
  console.log("");
  console.log("Use any model by its ID: claudish --model <model-id>");
  console.log("Provider shortcuts:      claudish --model or@<id> | google@<id> | oai@<id>");
}

/**
 * Render a flat list of `ModelDoc`s as an indented ranked table using the
 * existing `formatModelDoc*` helpers. Shared between `printTop100` and
 * `printByProvider`.
 */
function renderModelDocTable(models: Array<ModelDoc & { rank?: number }>, showRank: boolean): void {
  const header = showRank
    ? "  #    Model                          Provider    Pricing     Context  Caps  Released"
    : "       Model                          Provider    Pricing     Context  Caps  Released";
  console.log(header);
  console.log("  " + "─".repeat(90));
  for (const m of models) {
    const rankCell = showRank
      ? String(m.rank ?? "").padStart(3) + "  "
      : "     ";
    const rawId = m.modelId;
    const id = rawId.length > 30 ? rawId.substring(0, 27) + "..." : rawId;
    const idPadded = id.padEnd(30);
    const prov = (m.provider || "").padEnd(10);
    const price = formatModelDocPricing(m.pricing).padEnd(10);
    const ctx = formatModelDocContext(m.contextWindow).padEnd(7);
    const caps = formatModelDocCaps(m.capabilities).padEnd(5);
    const released = m.releaseDate ?? "—";
    console.log(`  ${rankCell}${idPadded} ${prov} ${price} ${ctx} ${caps} ${released}`);
  }
}

/**
 * Probe local providers (Ollama daemon, LiteLLM proxy) and print a compact
 * footer. Best-effort — silent on network errors, never throws.
 */
async function printLocalProvidersFooter(): Promise<void> {
  console.log("\nLocal providers");
  console.log("  " + "─".repeat(70));

  // Ollama probe
  let ollamaLine = "  Ollama:    not running";
  try {
    const ollamaModels = await fetchOllamaModels();
    if (ollamaModels.length > 0) {
      const toolCount = ollamaModels.filter((m: any) => m.supportsTools).length;
      ollamaLine = `  Ollama:    ${ollamaModels.length} models installed (${toolCount} with tools) — use: claudish --model ollama@<name>`;
    }
  } catch {
    // Leave the default "not running" line.
  }
  console.log(ollamaLine);

  // LiteLLM probe — claudish no longer fetches LiteLLM's catalog (Firebase-only
  // catalog rule). Just show whether the env vars are set; users can list
  // models on their own LiteLLM instance.
  let litellmLine = "  LiteLLM:   not configured (set LITELLM_BASE_URL + LITELLM_API_KEY)";
  if (process.env.LITELLM_BASE_URL && process.env.LITELLM_API_KEY) {
    litellmLine = "  LiteLLM:   configured — use: claudish --model litellm@<group>";
  }
  console.log(litellmLine);
}

/**
 * Print the top-100 Firebase-ranked catalog plus a local-providers footer.
 * Replaces the legacy `printAllModels` which mixed Ollama + LiteLLM + the
 * curated recommended list in one wall of text.
 */
async function printTop100(jsonOutput: boolean): Promise<void> {
  let response: Awaited<ReturnType<typeof getTop100Models>>;
  try {
    response = await getTop100Models();
  } catch (error) {
    console.error(
      `❌ Failed to load top-100 models from Firebase: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    console.error("   Check your network connection.");
    process.exit(1);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  console.log(
    `\nTop ${response.total} models from Firebase (pool: ${response.poolSize} eligible)\n`
  );

  if (response.models.length === 0) {
    console.log("  No eligible models in the catalog.");
  } else {
    const sorted = [...response.models].sort(compareByReleaseDateDesc);
    renderModelDocTable(sorted, /* showRank */ true);
    console.log("");
    console.log("  Caps: T = tools  R = reasoning  V = vision");
  }

  await printLocalProvidersFooter();

  console.log("");
  console.log("Filter by provider: claudish --list-models --provider <slug>");
  console.log("                    (e.g. opencode-zen, anthropic, openai, google, x-ai)");
  console.log("All providers:      claudish --list-providers");
  console.log("Search by keyword:  claudish -s <query>");
  console.log("Top recommended:    claudish --top-models");
  console.log("");
}

/**
 * Print the Firebase catalog filtered to a single provider slug. No local
 * footer — this view is explicitly scoped by the user and cross-cutting
 * probes would be noise.
 */
async function printByProvider(providerSlug: string, jsonOutput: boolean): Promise<void> {
  let models: ModelDoc[];
  try {
    models = await getModelsByProvider(providerSlug, 200);
  } catch (error) {
    console.error(
      `❌ Failed to load provider catalog from Firebase: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    console.error("   Check your network connection.");
    process.exit(1);
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ provider: providerSlug, count: models.length, models }, null, 2));
    return;
  }

  if (models.length === 0) {
    console.log(
      `\nNo active models found for provider "${providerSlug}". Try \`claudish -s <query>\` to search the full catalog.\n`
    );
    return;
  }

  console.log(`\nProvider: ${providerSlug} (${models.length} active models)\n`);
  const sorted = [...models].sort(compareByReleaseDateDesc);
  renderModelDocTable(sorted, /* showRank */ false);
  console.log("");
  console.log("  Caps: T = tools  R = reasoning  V = vision");
  console.log("");
  console.log("Use any model:      claudish --model <model-id>");
  console.log("Provider shortcuts: claudish --model or@<id> | google@<id> | oai@<id>");
  console.log("");
}

/**
 * Print the Firebase-backed recommended models list (used by --top-models).
 */
async function printRecommendedModels(jsonOutput: boolean, forceUpdate: boolean): Promise<void> {
  let doc: Awaited<ReturnType<typeof getRecommendedModels>>;
  try {
    doc = await getRecommendedModels({ forceRefresh: forceUpdate });
  } catch (error) {
    console.error(
      `❌ Failed to load recommended models: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exit(1);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(doc, null, 2));
    return;
  }

  const lastUpdated = doc.lastUpdated || "unknown";
  const { flagship, fast } = groupRecommendedModels(doc.models);

  // Build a native-prefix lookup: Firebase slug → shortcuts[0] from provider defs.
  const providerByName = new Map(BUILTIN_PROVIDERS.map((p) => [p.name, p] as const));
  const getNativePrefix = (firebaseSlug: string): string | null => {
    const canonical = FIREBASE_SLUG_TO_PROVIDER_NAME[firebaseSlug];
    if (!canonical) return null;
    const def = providerByName.get(canonical);
    if (!def || !def.shortcuts || def.shortcuts.length === 0) return null;
    return def.shortcuts[0];
  };

  const renderGroup = (group: RecommendedModelGroup): void => {
    const m = group.primary;
    const rawId = m.id;
    const modelId = rawId.length > 28 ? rawId.substring(0, 25) + "..." : rawId;
    const modelIdPadded = modelId.padEnd(28);

    const pricing = normalizePricingDisplay(m.pricing?.average);
    const pricingPadded = pricing.padEnd(10);

    const context = m.context || "N/A";
    const contextPadded = context.padEnd(6);

    // Capability glyphs — omit (not blank) when false so the caps column
    // naturally narrows for models without reasoning/vision.
    const caps: string[] = [];
    if (m.supportsTools) caps.push("🔧");
    if (m.supportsReasoning) caps.push("🧠");
    if (m.supportsVision) caps.push("👁️");
    const capabilities = caps.join(" ");

    console.log(`  ${modelIdPadded} ${pricingPadded} ${contextPadded} ${capabilities}`);

    const prefixes = collectRoutingPrefixes(group, getNativePrefix);
    if (prefixes.length > 0) {
      const viaLine = prefixes.map((p) => `${p}@`).join(" · ");
      console.log(`      via: ${viaLine}`);
    }
  };

  console.log(`\nRecommended Models (last updated: ${lastUpdated}):\n`);

  if (flagship.length > 0) {
    console.log("Flagship models");
    console.log("  " + "─".repeat(70));
    for (let i = 0; i < flagship.length; i++) {
      renderGroup(flagship[i]);
      if (i < flagship.length - 1) console.log("");
    }
  }

  if (fast.length > 0) {
    if (flagship.length > 0) console.log("");
    console.log("Fast variants");
    console.log("  " + "─".repeat(70));
    for (let i = 0; i < fast.length; i++) {
      renderGroup(fast[i]);
      if (i < fast.length - 1) console.log("");
    }
  }

  console.log("");
  console.log("  Capabilities: 🔧 Tools  🧠 Reasoning  👁️  Vision");

  // Quick picks — compute over the deduped primaries across both buckets.
  const primaries = [...flagship, ...fast].map((g) => g.primary);
  const picks = computeQuickPicks(primaries);
  const pickLines: string[] = [];
  if (picks.budget)
    pickLines.push(
      `    Budget       → ${picks.budget.id} (${normalizePricingDisplay(
        picks.budget.pricing?.average
      )})`
    );
  if (picks.largeContext)
    pickLines.push(
      `    Large ctx    → ${picks.largeContext.id} (${picks.largeContext.context || "N/A"})`
    );
  if (picks.mostCapable)
    pickLines.push(`    Most capable → ${picks.mostCapable.id}`);
  if (picks.visionCoding)
    pickLines.push(`    Vision+code  → ${picks.visionCoding.id}`);
  if (picks.agentic) pickLines.push(`    Agentic      → ${picks.agentic.id}`);

  if (pickLines.length > 0) {
    console.log("");
    console.log("  Quick picks:");
    for (const line of pickLines) console.log(line);
  }

  console.log("");
  console.log("  Set default:  export CLAUDISH_MODEL=<model>");
  console.log("                 or:  claudish --model <model> ...");
  console.log("");
  console.log("  For more: claudish --list-models                (browse full catalog)");
  console.log("            claudish --list-providers              (list all providers + counts)");
  console.log("            claudish -s <query>                    (search by keyword)");
  console.log("            claudish --top-models --force-update   (refresh from Firebase)");
  console.log("");
}

// Legacy OpenRouter catalog updater was removed when claudish switched to
// Firebase for model information. The --top-models and --list-models commands
// now go directly through `getRecommendedModels()` in model-loader.ts.

/**
 * Print version information
 */
function printVersion(): void {
  console.log(`claudish version ${VERSION}`);
}

/**
 * Probe model routing — show the fallback chain for each model.
 * Warm caches first, then display a table of how each model would be routed.
 *
 * Two paths:
 * - JSON path (--json): runs existing batch logic unchanged, prints JSON to stdout
 * - TUI path (interactive): live-updating progress bars via OpenTUI React on stderr
 */
async function probeModelRouting(
  models: string[],
  jsonOutput: boolean,
  options: { live: boolean; timeoutMs: number } = { live: true, timeoutMs: 40000 }
): Promise<void> {
  // Shared types for both paths
  interface ChainProbe {
    model: string;
    nativeProvider: string;
    isExplicit: boolean;
    routingSource: "direct" | "custom-rules" | "auto-chain";
    matchedPattern?: string;
    chain: Array<{
      provider: string;
      displayName: string;
      modelSpec: string;
      hasCredentials: boolean;
      credentialHint?: string;
      provenance?: KeyProvenance;
      probe?: ProbeResult;
    }>;
    directProbe?: ProbeResult;
    wiring?: {
      formatAdapter: string;
      declaredStreamFormat: string;
      modelTranslator: string;
      contextWindow: number;
      supportsVision: boolean;
      transportOverride: string | null;
      effectiveStreamFormat: string;
    };
  }

  type LiveProxy = { url: string; shutdown: () => Promise<void> };

  // Snapshot user-defined routing keys so we can label matches as
  // "custom-rules" vs "auto-chain" (default rules) in --probe output.
  // Defaults are merged INSIDE loadRoutingRules() but are not returned
  // from loadConfig/loadLocalConfig directly — those reads see only user
  // overrides, which is exactly the discriminator we need here.
  const userRoutingKeys = new Set<string>([
    ...Object.keys(loadConfig().routing ?? {}),
    ...Object.keys(loadLocalConfig()?.routing ?? {}),
  ]);

  /** Build chain + credential data for a single model (shared by both paths) */
  function buildModelChain(modelInput: string) {
    const parsed = parseModelSpec(modelInput);
    const chain = (() => {
      if (parsed.isExplicitProvider) {
        return {
          routes: [] as FallbackRoute[],
          source: "direct" as const,
          matchedPattern: undefined,
        };
      }
      // Routing rules now always include DEFAULT_ROUTING_RULES merged with
      // user overrides — see loadRoutingRules() in providers/routing-rules.ts.
      const routingRules = loadRoutingRules();
      const matched = matchRoutingRule(parsed.model, routingRules);
      if (matched) {
        const matchedPattern = Object.keys(routingRules).find((k) => {
          if (k === parsed.model) return true;
          if (k.includes("*")) {
            const star = k.indexOf("*");
            const prefix = k.slice(0, star);
            const suffix = k.slice(star + 1);
            return parsed.model.startsWith(prefix) && parsed.model.endsWith(suffix);
          }
          return false;
        });
        // Distinguish user overrides from shipped defaults so --probe can show
        // "custom-rules" vs "auto-chain" exactly as before.
        const isUserKey = !!matchedPattern && userRoutingKeys.has(matchedPattern);
        return {
          routes: buildRoutingChain(matched, parsed.model),
          source: isUserKey ? ("custom-rules" as const) : ("auto-chain" as const),
          matchedPattern,
        };
      }
      return {
        routes: [] as FallbackRoute[],
        source: "auto-chain" as const,
        matchedPattern: undefined,
      };
    })();

    const chainDetails = chain.routes.map((route) => {
      const keyInfo = API_KEY_MAP[route.provider];
      let hasCredentials = false;
      let credentialHint: string | undefined;
      let provenance: KeyProvenance | undefined;

      if (!keyInfo) {
        hasCredentials = true;
      } else if (!keyInfo.envVar) {
        hasCredentials = true;
      } else {
        provenance = resolveApiKeyProvenance(keyInfo.envVar, keyInfo.aliases);
        hasCredentials = !!provenance.effectiveValue;
        if (!hasCredentials && keyInfo.aliases) {
          hasCredentials = keyInfo.aliases.some((a) => !!process.env[a]);
        }
        if (!hasCredentials) {
          credentialHint = keyInfo.envVar;
        }
      }

      return {
        provider: route.provider,
        displayName: route.displayName,
        modelSpec: route.modelSpec,
        hasCredentials,
        credentialHint,
        provenance,
        probe: undefined as ProbeResult | undefined,
      };
    });

    return { parsed, chain, chainDetails };
  }

  /** Compute wiring for the first-ready provider in a chain */
  async function computeWiring(
    chainDetails: ReturnType<typeof buildModelChain>["chainDetails"],
    parsedModel: string
  ): Promise<ChainProbe["wiring"]> {
    const firstReadyRoute = chainDetails.find((c) => c.hasCredentials);
    if (!firstReadyRoute) return undefined;

    const providerName = firstReadyRoute.provider;
    const { resolveRemoteProvider } = await import("./providers/remote-provider-registry.js");
    const resolvedSpec = resolveRemoteProvider(firstReadyRoute.modelSpec);
    const modelName = resolvedSpec?.modelName || parsedModel;

    let formatAdapterName = "OpenAIAPIFormat";
    let declaredStreamFormat = "openai-sse";

    const anthropicCompatProviders = ["minimax", "minimax-coding", "kimi", "kimi-coding", "zai"];
    const isMinimaxModel = modelName.toLowerCase().includes("minimax");

    if (anthropicCompatProviders.includes(providerName)) {
      formatAdapterName = "AnthropicAPIFormat";
      declaredStreamFormat = "anthropic-sse";
    } else if (
      (providerName === "opencode-zen" || providerName === "opencode-zen-go") &&
      isMinimaxModel
    ) {
      formatAdapterName = "AnthropicAPIFormat";
      declaredStreamFormat = "anthropic-sse";
    } else if (providerName === "gemini" || providerName === "gemini-codeassist") {
      formatAdapterName = "GeminiAPIFormat";
      declaredStreamFormat = "gemini-sse";
    } else if (providerName === "ollamacloud") {
      formatAdapterName = "OllamaAPIFormat";
      declaredStreamFormat = "openai-sse";
    } else if (providerName === "litellm") {
      formatAdapterName = "LiteLLMAPIFormat";
      declaredStreamFormat = "openai-sse";
    } else {
      formatAdapterName = "OpenAIAPIFormat";
      declaredStreamFormat = "openai-sse";
    }

    const { DialectManager } = await import("./adapters/dialect-manager.js");
    const adapterManager = new DialectManager(modelName);
    const modelTranslator = adapterManager.getAdapter();
    const modelTranslatorName = modelTranslator.getName();

    const TRANSPORT_OVERRIDES: Record<string, string> = {
      litellm: "openai-sse",
      openrouter: "openai-sse",
    };
    const transportOverride = TRANSPORT_OVERRIDES[providerName] || null;

    const modelTranslatorFormat =
      modelTranslatorName !== "DefaultAPIFormat" ? modelTranslator.getStreamFormat() : null;
    const effectiveStreamFormat =
      transportOverride || modelTranslatorFormat || declaredStreamFormat;

    return {
      formatAdapter: formatAdapterName,
      declaredStreamFormat,
      modelTranslator: modelTranslatorName,
      contextWindow: modelTranslator.getContextWindow(),
      supportsVision: modelTranslator.supportsVision(),
      transportOverride,
      effectiveStreamFormat,
    };
  }

  // ── JSON path: existing batch logic, completely unchanged output ──
  if (jsonOutput) {
    const DIM = "\x1b[2m";
    const YELLOW = "\x1b[33m";
    const RESET = "\x1b[0m";

    let liveProxy: LiveProxy | null = null;
    if (options.live) {
      try {
        const { findAvailablePort } = await import("./port-manager.js");
        const { createProxyServer } = await import("./proxy-server.js");
        const probePort = await findAvailablePort(47600);
        console.error(
          `${DIM}Probing providers via live requests (may incur small cost, use --no-probe to skip)...${RESET}`
        );
        liveProxy = await createProxyServer(
          probePort,
          process.env.OPENROUTER_API_KEY,
          undefined,
          false,
          process.env.ANTHROPIC_API_KEY,
          undefined,
          { quiet: true }
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(
          `${YELLOW}Failed to start probe proxy (${msg}). Falling back to static probe.${RESET}`
        );
        liveProxy = null;
      }
    }

    try {
      const results: ChainProbe[] = [];

      for (const modelInput of models) {
        const { parsed, chain, chainDetails } = buildModelChain(modelInput);

        // Direct probe
        let directProbeResult: ProbeResult | undefined;
        if (liveProxy && chain.source === "direct") {
          const directKeyInfo = API_KEY_MAP[parsed.provider];
          const directHasCreds = directKeyInfo?.envVar
            ? !!process.env[directKeyInfo.envVar] ||
              (directKeyInfo.aliases?.some((a) => !!process.env[a]) ?? false)
            : true;
          directProbeResult = await probeLink(
            liveProxy.url,
            {
              provider: parsed.provider,
              modelSpec: modelInput,
              hasCredentials: directHasCreds,
              credentialHint: directKeyInfo?.envVar,
            },
            options.timeoutMs
          ).catch((e) => ({
            state: "error" as const,
            latencyMs: 0,
            errorMessage: String(e instanceof Error ? e.message : e),
          }));
        }

        // Chain probes (batch)
        if (liveProxy) {
          const probes = await Promise.all(
            chainDetails.map((link) => {
              const pinnedSpec = link.modelSpec.includes("@")
                ? link.modelSpec
                : `${link.provider}@${link.modelSpec}`;
              return probeLink(
                liveProxy!.url,
                {
                  provider: link.provider,
                  modelSpec: pinnedSpec,
                  hasCredentials: link.hasCredentials,
                  credentialHint: link.credentialHint,
                },
                options.timeoutMs
              ).catch((e) => ({
                state: "error" as const,
                latencyMs: 0,
                errorMessage: String(e instanceof Error ? e.message : e),
              }));
            })
          );
          for (let i = 0; i < chainDetails.length; i++) {
            chainDetails[i].probe = probes[i];
          }
        }

        const wiring = await computeWiring(chainDetails, parsed.model);

        results.push({
          model: modelInput,
          nativeProvider: parsed.provider,
          isExplicit: parsed.isExplicitProvider,
          routingSource: chain.source,
          matchedPattern: chain.matchedPattern,
          chain: chainDetails,
          directProbe: directProbeResult,
          wiring,
        });
      }

      console.log(JSON.stringify(results, null, 2));
    } finally {
      if (liveProxy) {
        try { await liveProxy.shutdown(); } catch { /* ignore */ }
      }
    }
    return;
  }

  // ── Interactive TUI path (OpenTUI React) ─────────────────────────
  const initialState: ProbeAppState = {
    steps: [],
    links: [],
  };
  const tui = await startProbeTui(initialState);

  const addStep = (name: string, status: ProbeStepState["status"]): void => {
    tui.store.setState((prev) => ({
      ...prev,
      steps: [...prev.steps, { name, status }],
    }));
  };
  const updateStep = (name: string, status: ProbeStepState["status"]): void => {
    tui.store.setState((prev) => ({
      ...prev,
      steps: prev.steps.map((s) => (s.name === name ? { ...s, status } : s)),
    }));
  };
  const setLinks = (links: ProbeLinkState[]): void => {
    tui.store.setState((prev) => ({ ...prev, links }));
  };
  const updateLink = (id: string, patch: Partial<ProbeLinkState>): void => {
    tui.store.setState((prev) => ({
      ...prev,
      links: prev.links.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    }));
  };

  let liveProxy: LiveProxy | null = null;
  try {
    // Step 1: Load routing rules
    addStep("Loading routing rules", "running");
    loadRoutingRules();
    updateStep("Loading routing rules", "done");

    // Step 2: Start live proxy (if enabled)
    if (options.live) {
      addStep("Starting probe proxy", "running");
      try {
        const { findAvailablePort } = await import("./port-manager.js");
        const { createProxyServer } = await import("./proxy-server.js");
        const probePort = await findAvailablePort(47600);
        liveProxy = await createProxyServer(
          probePort,
          process.env.OPENROUTER_API_KEY,
          undefined,
          false,
          process.env.ANTHROPIC_API_KEY,
          undefined,
          { quiet: true }
        );
        updateStep("Starting probe proxy", "done");
      } catch {
        updateStep("Starting probe proxy", "error");
        liveProxy = null;
      }
    }

    // Step 4: Build chains + credential checks
    addStep("Resolving routing chains", "running");
    const modelChains: Array<{
      modelInput: string;
      parsed: ReturnType<typeof parseModelSpec>;
      chain: ReturnType<typeof buildModelChain>["chain"];
      chainDetails: ReturnType<typeof buildModelChain>["chainDetails"];
    }> = [];
    for (const modelInput of models) {
      const { parsed, chain, chainDetails } = buildModelChain(modelInput);
      modelChains.push({ modelInput, parsed, chain, chainDetails });
    }
    updateStep("Resolving routing chains", "done");

    // Step 5: Live probing with progress bars
    const directProbeResults = new Map<string, ProbeResult>();

    if (liveProxy) {
      // Collect all probe links across all models
      const allLinks: Array<{
        id: string;
        displayName: string;
        modelSpec: string;
        provider: string;
        pinnedSpec: string;
        hasCredentials: boolean;
        credentialHint?: string;
        chainDetail: ReturnType<typeof buildModelChain>["chainDetails"][number] | null;
        isDirect: boolean;
        modelInput: string;
      }> = [];

      for (const { modelInput, parsed, chain, chainDetails } of modelChains) {
        if (chain.source === "direct") {
          const directKeyInfo = API_KEY_MAP[parsed.provider];
          const directHasCreds = directKeyInfo?.envVar
            ? !!process.env[directKeyInfo.envVar] ||
              (directKeyInfo.aliases?.some((a) => !!process.env[a]) ?? false)
            : true;
          allLinks.push({
            id: `${modelInput}:direct`,
            displayName: parsed.provider,
            modelSpec: modelInput,
            provider: parsed.provider,
            pinnedSpec: modelInput,
            hasCredentials: directHasCreds,
            credentialHint: directKeyInfo?.envVar,
            chainDetail: null,
            isDirect: true,
            modelInput,
          });
        }
        for (const link of chainDetails) {
          const pinnedSpec = link.modelSpec.includes("@")
            ? link.modelSpec
            : `${link.provider}@${link.modelSpec}`;
          allLinks.push({
            id: `${modelInput}:${link.provider}`,
            displayName: link.displayName,
            modelSpec: pinnedSpec,
            provider: link.provider,
            pinnedSpec,
            hasCredentials: link.hasCredentials,
            credentialHint: link.credentialHint,
            chainDetail: link,
            isDirect: false,
            modelInput,
          });
        }
      }

      // Seed the store with waiting links
      setLinks(
        allLinks.map((l) => ({
          id: l.id,
          model: l.modelInput,
          displayName: l.displayName,
          modelSpec: l.modelSpec,
          status: "waiting",
        }))
      );

      // Fire all probes concurrently, updating per-link state as results arrive
      const probePromises = allLinks.map(async (link) => {
        updateLink(link.id, { status: "probing", startTime: Date.now() });

        const result = await probeLink(
          liveProxy!.url,
          {
            provider: link.provider,
            modelSpec: link.pinnedSpec,
            hasCredentials: link.hasCredentials,
            credentialHint: link.credentialHint,
          },
          options.timeoutMs
        ).catch((e): ProbeResult => ({
          state: "error",
          latencyMs: 0,
          errorMessage: String(e instanceof Error ? e.message : e),
        }));

        if (result.state === "live") {
          updateLink(link.id, { status: "live", endTime: Date.now() });
        } else {
          updateLink(link.id, {
            status: "failed",
            endTime: Date.now(),
            error: describeProbeState(result),
          });
        }

        if (link.isDirect) {
          directProbeResults.set(link.modelInput, result);
        } else if (link.chainDetail) {
          link.chainDetail.probe = result;
        }
      });

      await Promise.all(probePromises);
    }

    // Step 6: Compute wiring for each model BEFORE tearing down TUI
    // (computeWiring does async imports that we want to finish while the
    // progress UI is still up).
    const isLiveProbe = !!liveProxy;
    const printable: PrintableModelResult[] = [];
    for (const { modelInput, parsed, chain, chainDetails } of modelChains) {
      const wiring = await computeWiring(chainDetails, parsed.model);
      printable.push({
        model: modelInput,
        nativeProvider: parsed.provider,
        isExplicit: parsed.isExplicitProvider,
        routingSource: chain.source,
        matchedPattern: chain.matchedPattern,
        chain: chainDetails.map((c) => ({
          provider: c.provider,
          displayName: c.displayName,
          modelSpec: c.modelSpec,
          hasCredentials: c.hasCredentials,
          credentialHint: c.credentialHint,
          provenance: c.provenance,
          probe: c.probe,
        })),
        directProbe: directProbeResults.get(modelInput),
        wiring,
      });
    }

    // Shut down the OpenTUI renderer cleanly BEFORE printing static output.
    // This avoids the OpenTUI in-place reconciliation bug where swapping
    // the component tree from progress-bars to a wide results table garbled
    // the final panel.
    if (liveProxy) {
      try { await liveProxy.shutdown(); } catch { /* ignore */ }
      liveProxy = null;
    }
    await tui.shutdown();

    // Now print the static results table to stderr as plain ANSI text.
    printProbeResults(printable, isLiveProbe);
  } finally {
    if (liveProxy) {
      try { await liveProxy.shutdown(); } catch { /* ignore */ }
    }
    await tui.shutdown();
  }
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
  claudish --team a,b,c "prompt"          # Run models in parallel (magmux grid)
  claudish --team a,b,c -f input.md       # Team mode with file input

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
    or           -> OpenRouter        or@openai/gpt-5.3
    mm, mmax     -> MiniMax Direct    mm@MiniMax-M2.1
    kimi, moon   -> Kimi Direct       kimi@kimi-k2-thinking-turbo
    glm, zhipu   -> GLM Direct        glm@glm-4.7
    zai          -> Z.AI Direct       zai@glm-4.7
    oc           -> OllamaCloud       oc@llama-3.1
    llama,lc,meta-> OllamaCloud       llama@llama-3.1
    zen          -> OpenCode Zen      zen@grok-code
    v, vertex    -> Vertex AI         v@gemini-2.5-flash
    go           -> Gemini CodeAssist go@gemini-2.5-flash
    poe          -> Poe               poe@GPT-4o
    ollama       -> Ollama (local)    ollama@llama3.2
    lms,lmstudio -> LM Studio (local) lms@qwen
    vllm         -> vLLM (local)      vllm@model
    mlx          -> MLX (local)       mlx@model

  Native model auto-detection (when no provider specified):
    google/*, gemini-*      -> Google API
    openai/*, gpt-*, o1-*   -> OpenAI API
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
    mmax/, mm/       MiniMax Direct API     claudish --model mmax/MiniMax-M2.1 "task"
    kimi/, moonshot/ Kimi Direct API        claudish --model kimi/kimi-k2-thinking-turbo "task"
    ollama/          Ollama (local)         claudish --model ollama/llama3.2 "task"
    http://...       Custom endpoint        claudish --model http://localhost:8000/model "task"

OPTIONS:
  -i, --interactive        Run in interactive mode (default when no prompt given)
  -m, --model <model>      OpenRouter model to use (required for single-shot mode)
  -p, --profile <name>     Use named profile for model mapping (default: uses default profile)
  --default-provider <name> Default provider for bare model names (builtin or customEndpoints key)
                           Precedence: this flag > CLAUDISH_DEFAULT_PROVIDER env > config.json
  --port <port>            Proxy server port (default: random)
  -d, --debug              Enable debug logging to file (logs/claudish_*.log)
  --no-logs                Disable always-on structural logging (~/.claudish/logs/)
  --diag-mode <mode>       Diagnostic output: auto (default), logfile, off
                           Also: CLAUDISH_DIAG_MODE env var or "diagMode" in config.json
  --log-level <level>      Log verbosity: debug (full), info (truncated), minimal (labels only)
  -q, --quiet              Suppress [claudish] log messages (default in single-shot mode)
  -v, --verbose            Show [claudish] log messages (default in interactive mode)
  --json                   Output in JSON format for tool integration (implies --quiet)
  --stdin                  Read prompt from stdin (useful for large prompts or piping)
  --free                   Show only FREE models in the interactive selector
  --monitor                Monitor mode - proxy to REAL Anthropic API and log all traffic
  --advisor "m1,m2[:collector]"  Multi-model advisor replacement (implies --monitor)
  -y, --auto-approve       Skip permission prompts (--dangerously-skip-permissions)
  --no-auto-approve        Explicitly enable permission prompts (default)
  --dangerous              Pass --dangerouslyDisableSandbox to Claude Code
  --cost-tracker           Enable cost tracking for API usage (NB!)
  --audit-costs            Show cost analysis report
  --reset-costs            Reset accumulated cost statistics
  --list-models            Top 100 ranked models from Firebase + local providers
  --list-models --provider <slug>
                           Filter Firebase catalog to one provider
                           (e.g. --provider opencode-zen, --provider anthropic)
  --list-providers         List every provider + active-model count
  -s, --search <query>     Search Firebase catalog by keyword — matches model ID,
                           brand synonyms (chatgpt, claude, grok), gateway names
                           (zen, oc, codex), or capabilities (reasoning, vision, free)
  --top-models             List the curated recommended models (flagship + fast)
  --team <models>          Run multiple models in parallel (comma-separated)
                           Example: --team minimax-m2.5,kimi-k2.5 "prompt"
  --mode <mode>            Team mode: default (grid), interactive, json
  -f, --file <path>        Read prompt from file (use with --team or single-shot)
  --probe <models...>      Probe each provider in the fallback chain with a real
                           1-token request (diagnostic, may incur tiny cost)
  --no-probe               Skip live requests, show static chain only
  --probe-timeout <secs>   Per-link timeout for live probes (default: 40)
  --json                   Output in JSON format (use with --list-models, --top-models, --probe)
  --force-update           Force refresh the slim model catalog from Firebase
                           (also clears per-cache files used by --top-models /
                           --list-models; bypasses the launcher catalog TTL)
  --skip-models-update     Skip the launcher catalog warm step entirely
                           (use offline / when you trust the cached catalog)
  --version                Show version information
  -h, --help               Show this help message
  --help-ai                Show AI agent usage guide (file-based patterns, sub-agents)
  --init                   Install Claudish skill in current project (.claude/skills/)
  --                       Separator: everything after passes directly to Claude Code

CLAUDE CODE FLAG PASSTHROUGH:
  Any unrecognized flag is automatically forwarded to Claude Code.
  Claudish flags (--model, --stdin, --quiet, etc.) can appear in any order.

  Examples:
    claudish --model grok --agent test "task"           # --agent passes to Claude Code
    claudish --model grok --effort high --stdin "task"   # --effort passes, --stdin stays
    claudish --model grok --permission-mode plan -i      # Works in interactive mode too

  Use -- when a Claude Code flag value starts with '-':
    claudish --model grok -- --system-prompt "-verbose mode" "task"

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
  claudish login [provider]   Login to an OAuth provider (interactive if no provider given)
  claudish logout [provider]  Clear OAuth credentials (interactive if no provider given)
                              Providers: gemini, kimi

MODEL MAPPING (per-role override):
  --model-opus <model>     Model for Opus role (planning, complex tasks)
  --model-sonnet <model>   Model for Sonnet role (default coding)
  --model-haiku <model>    Model for Haiku role (fast tasks, background)
  --model-fable <model>    Model for Fable role (focused frontier tasks)
  --model-subagent <model> Model for sub-agents (Task tool)
  --model-freshness       Check configured Fable/Astra pins (metadata only, no inference)

CUSTOM MODELS:
  Claudish accepts ANY valid model ID from the Firebase catalog, even if not in --list-models
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
  ZHIPU_API_KEY                   GLM/Zhipu API key (for glm/, zhipu/ prefix)
  GLM_API_KEY                     Alias for ZHIPU_API_KEY
  OLLAMA_API_KEY                  OllamaCloud API key (for oc/ prefix)
  OPENCODE_API_KEY                OpenCode Zen API key (optional - free models work without it)
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
  claudish --model openrouter@x-ai/grok-code-fast-1 --verbose "debug issue"

  # JSON output for tool integration (quiet by default)
  claudish --json "list 5 prime numbers"

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
  Top 100 ranked:      claudish --list-models                 (Firebase-ranked list + local providers)
  By provider:         claudish --list-models --provider <slug>  (e.g. opencode-zen, anthropic, openai, google, x-ai)
  All providers:       claudish --list-providers              (every provider + active-model count)
  Search models:       claudish -s <query>                    (fuzzy: id, brand synonyms, gateways, capabilities)
  Top recommended:     claudish --top-models                  (curated flagship + fast)
  Probe routing:       claudish --probe minimax-m2.5 kimi-k2.5 gemini-3.1-pro-preview
  Free models only:    claudish --free                        (interactive selector with free models)
  JSON output:         claudish --list-models --json | claudish --top-models --json

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
 * Print a terse model hint when `--model` is passed without a value.
 * Backed by the sync recommended-models loader — no network calls here.
 */
function printAvailableModels(): void {
  try {
    const basicModels = getAvailableModels();
    const modelInfo = loadModelInfo();
    console.log("\nAvailable models (type `claudish --top-models` for full table):\n");
    for (const model of basicModels) {
      const info = modelInfo[model];
      if (!info) continue;
      console.log(`  ${model}`);
      console.log(`    ${info.name} - ${info.description}`);
    }
    console.log("");
  } catch (error) {
    console.error(
      `Failed to load available models: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

