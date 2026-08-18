import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV } from "./config.js";
import { buildLegacyHint, resolveDefaultProvider } from "./default-provider.js";
import {
  FIREBASE_SLUG_TO_PROVIDER_NAME,
  type ModelDoc,
  type RecommendedModelGroup,
  collectRoutingPrefixes,
  computeQuickPicks,
  getAvailableModels,
  getModelsByProvider,
  getProviderList,
  getRecommendedModels,
  getTop100Models,
  groupRecommendedModels,
  loadModelInfo,
  normalizePricingDisplay,
  searchModels,
} from "./model-loader.js";
import { compareByReleaseDateDesc } from "./model-selector.js";
import {
  type ModelResult as PrintableModelResult,
  printProbeResults,
} from "./probe/probe-results-printer.js";
import type {
  ProbeAppState,
  ProbeLinkState,
  ProbeModelResult,
  ProbeStepState,
} from "./probe/probe-tui-app.js";
import { startProbeTui } from "./probe/probe-tui-runtime.js";
import {
  getModelMapping,
  isLocalProviderEnabled,
  loadConfig,
  loadLocalConfig,
} from "./profile-config.js";
import { API_KEY_MAP } from "./providers/api-key-map.js";
import { type KeyProvenance, resolveApiKeyProvenance } from "./providers/api-key-provenance.js";
import type { FallbackRoute } from "./providers/auto-route.js";
import { ensureEndpointsRegistered } from "./providers/endpoint-registration.js";
import { parseModelChain, parseModelSpec } from "./providers/model-parser.js";
import { fetchOllamaModels } from "./providers/ollama-discovery.js";
import { type ProbeResult, describeProbeState } from "./providers/probe-live.js";
import { pinProbeModelSpec, probeProviderRoute } from "./providers/probe-runner.js";
import { BUILTIN_PROVIDERS, getProviderByName } from "./providers/provider-definitions.js";
import {
  buildRoutingChain,
  loadRoutingRules,
  matchRoutingRule,
} from "./providers/routing-rules.js";
import type { ClaudishConfig } from "./types.js";
import { VERSION } from "./version.js";
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
 * Called when --models-refresh flag is used.
 *
 * NOTE: We intentionally do NOT delete `all-models.json` — that file is the
 * OpenRouter catalog resolver's slim-catalog cache, sourced from Firebase.
 * Deleting it would force a cold re-warm on every --models-refresh call.
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

  const models = advisorPart
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

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

  // Load diagMode + debug from settings file (lowest priority — env/CLI override)
  try {
    const fileConfig = loadConfig();
    if (fileConfig.diagMode && ["auto", "logfile", "off"].includes(fileConfig.diagMode)) {
      config.diagMode = fileConfig.diagMode;
    }
    // `"debug": true` in config.json makes every run behave like `-d`.
    if (fileConfig.debug === true) {
      config.debug = true;
    }
  } catch {}

  // Check for diagnostic mode env var (overrides settings file)
  const envDiagMode = process.env[ENV.CLAUDISH_DIAG_MODE]?.toLowerCase();
  if (envDiagMode && ["auto", "logfile", "off"].includes(envDiagMode)) {
    config.diagMode = envDiagMode as typeof config.diagMode;
  }

  // CLAUDISH_DEBUG env var (overrides settings file, still below the CLI flag).
  // Accepts 1/true to enable, 0/false to force-disable (so a globally-set
  // config.debug can be turned off for a single run via the environment).
  const envDebug = process.env[ENV.CLAUDISH_DEBUG]?.toLowerCase();
  if (envDebug === "1" || envDebug === "true") {
    config.debug = true;
  } else if (envDebug === "0" || envDebug === "false") {
    config.debug = false;
  }

  // If debug was enabled via config/env (not the CLI flag, which handles this
  // inline), default the log level to `debug` too — the `-d` flag does the same.
  // `--log-level` later in the arg loop still overrides this.
  if (config.debug && config.logLevel === "info") {
    config.logLevel = "debug";
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
      // A `--model` value may be a CHAIN (`zgo@m+mm@M`) — the ordered, already
      // credential-filtered candidate list a parent process pins onto a spawned
      // child (see MODEL_CHAIN_SEPARATOR). Split it HERE, at the boundary, and
      // keep `config.model` a single spec: every downstream consumer — key
      // validation, session naming, the status line, the env handed to Claude
      // Code — then behaves exactly as it does for an ordinary `--model`, and
      // only the proxy needs to know a chain exists. A plain value yields a
      // one-element chain, so this costs nothing in the common case.
      const chain = parseModelChain(modelArg);
      config.model = chain[0]; // Accept any model ID
      if (chain.length > 1) config.modelChain = chain;
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
    } else if (arg === "--debug-claudish" || arg === "-d") {
      config.debug = true;
      // Default to debug log level when --debug-claudish is enabled (can be overridden by --log-level)
      if (config.logLevel === "info") {
        config.logLevel = "debug";
      }
    } else if (arg === "--no-debug-claudish") {
      // Escape hatch when debug is globally enabled (config.json / CLAUDISH_DEBUG):
      // turn the debug file log off for this single run.
      config.debug = false;
    } else if (arg === "--log-debug") {
      // Renamed in v7.13.0. Fail loudly rather than forwarding an unknown flag
      // to `claude`, which would surface as a confusing error from the child.
      console.error(
        "--log-debug was renamed to --debug-claudish (it enables claudish's own debug log, not Claude Code's --debug)."
      );
      process.exit(1);
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
      // Also remember it so we can forward --verbose to the child `claude` in
      // single-shot/print mode. Claude Code hard-errors on
      // `--print --output-format stream-json` WITHOUT `--verbose`, so a
      // machine consumer (e.g. madbench) that passes --verbose must have it
      // reach `claude`, not just claudish. Forwarded post-parse (see below)
      // once we know whether this is a single-shot session.
      config._sawVerbose = true;
    } else if (arg === "--json") {
      config.jsonOutput = true;
    } else if (arg === "--monitor") {
      config.monitor = true;
    } else if (arg === "--advisor") {
      const modelsArg = args[++i];
      if (!modelsArg) {
        console.error(
          "--advisor requires a comma-separated list of models (e.g., 'gemini-3-pro,grok-3')"
        );
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
    } else if (arg === "--models-refresh") {
      // Force-refresh model caches. Consumed by the --models-top/--models
      // branches below AND (after the launcher warm step lands) by
      // warmCatalogIfNeeded() to bypass the TTL check.
      config.forceUpdate = true;
    } else if (arg === "--models-skip-update") {
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
    } else if (arg === "--anthropic-api-billing") {
      config.anthropicApiBilling = true;
    } else if (arg === "--op-env" || arg.startsWith("--op-env=")) {
      // The actual 1Password Environment read happens early in index.ts
      // (highest priority). Here we only consume the flag + its value so it
      // isn't forwarded to Claude Code as a passthrough arg. Both forms
      // (`--op-env <id>` and `--op-env=<id>`) are accepted, matching index.ts.
      const v = arg.startsWith("--op-env=") ? arg.slice("--op-env=".length) : args[++i];
      if (!v) {
        console.error("--op-env requires a 1Password Environment ID");
        process.exit(1);
      }
      config.opEnv = v;
    } else if (arg === "--op" || arg.startsWith("--op=")) {
      // The actual 1Password glob import happens early in index.ts
      // (applyOpImport), which strips --op from process.argv before parseArgs
      // runs. This defensive branch only fires if --op somehow reaches parseArgs
      // (e.g. a future code path that doesn't go through applyOpImport): consume
      // the flag + its value so it isn't forwarded to Claude Code as a
      // passthrough arg. Both forms (`--op <glob>` and `--op=<glob>`) accepted,
      // matching index.ts. NOTE: `--op-env` is handled above and `=== "--op"`
      // won't match it, so there's no startsWith collision here.
      const v = arg.startsWith("--op=") ? arg.slice("--op=".length) : args[++i];
      if (!v) {
        console.error("--op requires an op:// glob path");
        process.exit(1);
      }
      config.opImport = v;
    } else if (arg === "--cost-track") {
      // Enable cost tracking for this session
      config.costTracking = true;
      // In monitor mode, we'll track costs instead of proxying
      if (!config.monitor) {
        config.monitor = true; // Switch to monitor mode to track requests
      }
    } else if (arg === "--cost-audit") {
      // Special mode to just show cost analysis
      config.auditCosts = true;
    } else if (arg === "--cost-reset") {
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
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isNaN(parsed) && parsed > 0) {
          probeTimeoutMs = parsed * 1000;
        }
      }
      // `--probe` exits inside parseArgs, so it never reaches runCli's
      // registration and never starts a proxy — the two places endpoints are
      // otherwise registered. Without this a bundled (or user-declared)
      // endpoint is absent from the very output whose job is to explain how a
      // model routes, which is the worst possible place for it to be missing.
      ensureEndpointsRegistered();
      await probeModelRouting(expandedModels, hasJsonFlag, {
        live: !noProbeFlag,
        timeoutMs: probeTimeoutMs,
      });
      process.exit(0);
    } else if (arg === "--models-top") {
      // Show recommended/top models (curated Firebase catalog)
      const hasJsonFlag = args.includes("--json");
      // Read from cliConfig (set by the main argv loop). Fall back to args.includes
      // so behavior is preserved when --models-refresh appears AFTER --models-top in argv.
      const forceUpdate = config.forceUpdate || args.includes("--models-refresh");

      if (forceUpdate) clearAllModelCaches();

      await printRecommendedModels(hasJsonFlag, forceUpdate);
      process.exit(0);
    } else if (arg === "--providers") {
      // List every provider in the Firebase catalog + active-model count.
      const hasJsonFlag = args.includes("--json");
      try {
        const providers = await getProviderList();
        if (hasJsonFlag) {
          console.log(JSON.stringify({ providers, total: providers.length }, null, 2));
        } else {
          console.log("\nProviders in Firebase catalog:\n");
          console.log("  Slug                 Active models");
          console.log(`  ${"─".repeat(40)}`);
          for (const { slug, count } of providers) {
            console.log(`  ${slug.padEnd(20)} ${String(count).padStart(5)}`);
          }
          console.log("\nUsage:  claudish --models --provider <slug>");
          console.log("        claudish -s <query>                    (fuzzy search)\n");
        }
        process.exit(0);
      } catch (err) {
        console.error(
          `Failed to fetch providers: ${err instanceof Error ? err.message : String(err)}`
        );
        process.exit(1);
      }
    } else if (arg === "--models" || arg === "-s" || arg === "--models-search") {
      // Check for optional search query (next arg that doesn't start with --)
      const nextArg = args[i + 1];
      const hasQuery = nextArg && !nextArg.startsWith("--");
      const query = hasQuery ? args[++i] : null;

      const hasJsonFlag = args.includes("--json");
      // Read from cliConfig (set by the main argv loop). Fall back to args.includes
      // so behavior is preserved when --models-refresh appears AFTER --models in argv.
      const forceUpdate = config.forceUpdate || args.includes("--models-refresh");

      // Pick up --provider <slug> anywhere in the argv. We DON'T consume it
      // from the loop — it's read-once here and harmless to let the outer
      // passthrough swallow it later because we exit before that.
      const providerIdx = args.indexOf("--provider");
      const providerSlug =
        providerIdx !== -1 && providerIdx + 1 < args.length ? args[providerIdx + 1] : null;

      if (forceUpdate) clearAllModelCaches();

      if (query && providerSlug) {
        // --provider is a filter for the catalog browser; searches are
        // already Firebase-scoped and don't take a provider slug.
        console.error(
          "Use --provider together with --models (without a query) to filter the catalog."
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
        // Default --models = top100 ranked Firebase catalog + local footer
        await printTop100(hasJsonFlag);
      }
      process.exit(0);
    } else if (arg === "--summarize-tools") {
      // Summarize tool descriptions to reduce prompt size for local models
      config.summarizeTools = true;
    } else if (arg === "--log-off") {
      // Disable always-on structural logging to ~/.claudish/logs/
      config.noLogs = true;
    } else if (arg === "--log-diag" && i + 1 < args.length) {
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
    } else if (arg === "--resume" && (i + 1 >= args.length || args[i + 1]!.startsWith("-"))) {
      // A BARE `--resume` (no session id) opens claudish's own picker.
      //
      // `--resume <id>` is untouched and still passes straight through, because that
      // form is unambiguous and Claude Code handles it. Only the id-less form is
      // intercepted, and intercepting it is a strict improvement: forwarded bare, it
      // makes Claude Code list the sessions of the CURRENT DIRECTORY only, which in a
      // worktree is the one place the session you want almost certainly is not.
      //
      // The flag is deliberately NOT pushed to `claudeArgs` here. The picker resolves a
      // concrete id and `index.ts` appends `--resume <id>` itself, so the child always
      // receives the explicit form.
      config._resumePicker = true;
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
      // A passthrough -p/--print flag means the user wants single-shot/print
      // mode. Mark it so the interactive default below doesn't flip
      // interactive=true and launch the picker — which would then forward a
      // bare `-p` (no prompt) to the child `claude` and crash with
      // "Input must be provided either through stdin or as a prompt argument
      // when using --print".
      if (arg === "-p" || arg === "--print") {
        config._hasPrintFlag = true;
      }
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
  if (!config._hasPositionalPrompt && !config.stdin && !config._hasPrintFlag) {
    config.interactive = true;
  }

  // Forward --verbose to the child `claude` in single-shot mode. claudish
  // consumes --verbose/-v as its own log-verbosity flag (above), so it never
  // reaches `claude` on its own. But Claude Code HARD-ERRORS on
  // `--print --output-format stream-json` unless `--verbose` is also present,
  // so a machine consumer that passes --verbose expects it to reach `claude`.
  // Only forward in non-interactive mode (interactive `claude` rejects
  // --verbose), and dedupe against an explicit passthrough --verbose.
  if (
    config._sawVerbose &&
    !config.interactive &&
    !config.claudeArgs.includes("--verbose") &&
    !config.claudeArgs.includes("-v")
  ) {
    config.claudeArgs.push("--verbose");
  }

  // Handle monitor mode setup
  if (config.monitor) {
    // Monitor mode: proxies to real Anthropic API for monitoring/debugging
    // Uses Claude Code's native authentication (from `claude auth login`)
    //
    // Remove any placeholder API keys so Claude Code uses its stored credentials
    if (process.env.ANTHROPIC_API_KEY?.includes("placeholder")) {
      delete process.env.ANTHROPIC_API_KEY;
    }

    if (!config.quiet) {
      console.log("[claudish] Monitor mode enabled - proxying to real Anthropic API");
      console.log("[claudish] Using Claude Code's native authentication");
      console.log("[claudish] Tip: Run with --debug-claudish to see request/response details");
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
  console.log(`  ${"─".repeat(90)}`);
  for (const m of models) {
    const rankCell = showRank ? `${String(m.rank ?? "").padStart(3)}  ` : "     ";
    const rawId = m.modelId;
    const id = rawId.length > 30 ? `${rawId.substring(0, 27)}...` : rawId;
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
  console.log(`  ${"─".repeat(70)}`);

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
  console.log("Filter by provider: claudish --models --provider <slug>");
  console.log("                    (e.g. opencode-zen, anthropic, openai, google, x-ai)");
  console.log("All providers:      claudish --providers");
  console.log("Search by keyword:  claudish -s <query>");
  console.log("Top recommended:    claudish --models-top");
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
 * Print the Firebase-backed recommended models list (used by --models-top).
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
    const modelId = rawId.length > 28 ? `${rawId.substring(0, 25)}...` : rawId;
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
    console.log(`  ${"─".repeat(70)}`);
    for (let i = 0; i < flagship.length; i++) {
      renderGroup(flagship[i]);
      if (i < flagship.length - 1) console.log("");
    }
  }

  if (fast.length > 0) {
    if (flagship.length > 0) console.log("");
    console.log("Fast variants");
    console.log(`  ${"─".repeat(70)}`);
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
  if (picks.mostCapable) pickLines.push(`    Most capable → ${picks.mostCapable.id}`);
  if (picks.visionCoding) pickLines.push(`    Vision+code  → ${picks.visionCoding.id}`);
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
  console.log("  For more: claudish --models                     (browse full catalog)");
  console.log("            claudish --providers                   (list all providers + counts)");
  console.log("            claudish -s <query>                    (search by keyword)");
  console.log("            claudish --models-top --models-refresh (refresh from Firebase)");
  console.log("");
}

// Legacy OpenRouter catalog updater was removed when claudish switched to
// Firebase for model information. The --models-top and --models commands
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
      // Native-anthropic passthrough: a bare name with no vendor "/" and no
      // provider "@" (e.g. "internal") resolves to native-anthropic — the
      // default Claude Code route. The real proxy returns nativeHandler for
      // this (proxy-server.ts) BEFORE the routing engine runs, so the probe
      // must mirror that here rather than letting matchRoutingRule send it to
      // the "*" catch-all → openrouter (which produced the wrong "no live
      // route"). We pin the default Opus model so the probe sends a real
      // request through the passthrough like any other link.
      // NOTE: mirrors the upstream proxy precedence; a later routing worktree
      // may fold this into a shared helper.
      if (parsed.provider === "native-anthropic") {
        // The probe hits the Anthropic API directly, so this must be a real
        // API-valid model id — NOT Claude Code's internal alias (`claude-opus-4-8`
        // is the CLI's tier name and the API rejects it with "not a valid model
        // ID"). `claude-opus-4-1` is the current Opus alias the API accepts
        // (verified against api.anthropic.com). Honor an explicit override.
        const opusModel =
          process.env[ENV.CLAUDISH_MODEL_OPUS] ||
          process.env[ENV.ANTHROPIC_DEFAULT_OPUS_MODEL] ||
          "claude-opus-4-1";
        // IMPORTANT: pin a BARE model name (no `provider@`). The proxy resolves
        // the native passthrough via `isNative` = no "/" AND no "@" — pinning
        // `native-anthropic@...` would set hasExplicitProvider=true and DEFEAT
        // the native branch (the request would 400 / fall to OpenRouter). So
        // pinProbeModelSpec must keep this bare; the proxy then returns the
        // nativeHandler (default Claude Code / Opus).
        return {
          routes: [
            {
              provider: "native-anthropic",
              modelSpec: opusModel,
              displayName: "Claude Code (Opus)",
            },
          ] as FallbackRoute[],
          source: "auto-chain" as const,
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
      const providerDef = getProviderByName(route.provider);
      let hasCredentials = false;
      let credentialHint: string | undefined;
      let provenance: KeyProvenance | undefined;

      if (route.provider === "native-anthropic") {
        // The probe hits the Anthropic API DIRECTLY (api.anthropic.com) via the
        // passthrough, so it needs a real ANTHROPIC_API_KEY. Without one we
        // can't probe — surface that as a clean key-missing row (no request,
        // no 400) telling the user what to set.
        hasCredentials = !!process.env.ANTHROPIC_API_KEY;
        if (!hasCredentials) {
          credentialHint = "ANTHROPIC_API_KEY (required to probe Claude Code)";
        }
      } else if (providerDef?.isLocal) {
        hasCredentials = isLocalProviderEnabled(route.provider);
        if (!hasCredentials) {
          credentialHint = "enable local provider in global config";
        }
      } else if (!keyInfo) {
        hasCredentials = true;
      } else if (!keyInfo.envVar) {
        hasCredentials = true;
      } else {
        provenance = resolveApiKeyProvenance(keyInfo.envVar, keyInfo.aliases);
        hasCredentials = provenance.hasValue;
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

  /**
   * Routing-why one-liner shown on the right of each model header in the
   * Details tab. Kept as a SINGLE function so a later routing worktree can swap
   * the derivation in one place (the current buildModelChain has known bugs that
   * a future worktree will reconcile — this only consumes its output).
   */
  function buildRoutingExplanation(
    parsed: ReturnType<typeof parseModelSpec>,
    chain: ReturnType<typeof buildModelChain>["chain"]
  ): string {
    if (parsed.provider === "native-anthropic") {
      return "native passthrough · default Claude Code (Opus)";
    }
    if (chain.source === "direct") {
      return `explicit · ${parsed.provider} (direct)`;
    }
    if (chain.source === "custom-rules" && chain.matchedPattern) {
      return `custom-rules · matched \`${chain.matchedPattern}\``;
    }
    if (chain.source === "auto-chain") {
      if (chain.matchedPattern && chain.matchedPattern !== "*") {
        return `auto-chain · default rule \`${chain.matchedPattern}\``;
      }
      return "auto-chain · catch-all → openrouter";
    }
    return chain.source;
  }

  /**
   * Build the provider-comparison links the Details tab renders. For EXPLICIT /
   * direct models buildModelChain returns an empty chain (the probe lives in
   * directProbe), so we synthesize a single link carrying that probe — the model
   * still renders one row and the live-count derives from the SAME array as the
   * rows. The model id is the RESOLVED bare id (parsed.model), never the raw
   * provider@-prefixed input, so we never render `provider@provider@model`.
   */
  function buildResultLinks(
    parsed: ReturnType<typeof parseModelSpec>,
    chainDetails: ReturnType<typeof buildModelChain>["chainDetails"],
    directProbe: ProbeResult | undefined
  ): ProbeModelResult["links"] {
    if (chainDetails.length === 0) {
      // Explicit/direct model — one synthetic link from the native provider.
      const directProviderDef = getProviderByName(parsed.provider);
      const directKeyInfo = API_KEY_MAP[parsed.provider];
      const directHasCreds = directProviderDef?.isLocal
        ? isLocalProviderEnabled(parsed.provider)
        : directKeyInfo?.envVar
          ? !!process.env[directKeyInfo.envVar] ||
            (directKeyInfo.aliases?.some((a) => !!process.env[a]) ?? false)
          : true;
      return [
        {
          provider: parsed.provider,
          displayName: directProviderDef?.displayName ?? parsed.provider,
          modelId: parsed.model,
          hasCredentials: directHasCreds,
          credentialHint:
            directProviderDef?.isLocal && !directHasCreds
              ? "enable local provider in global config"
              : directKeyInfo?.envVar,
          probe: directProbe,
        },
      ];
    }
    return chainDetails.map((c) => ({
      provider: c.provider,
      displayName: c.displayName,
      // Strip any redundant provider@ prefix so the row shows displayName + the
      // resolved id only (e.g. "qwen/qwen3-coder", not "openrouter@qwen/…").
      modelId: c.modelSpec.includes("@")
        ? c.modelSpec.slice(c.modelSpec.indexOf("@") + 1)
        : c.modelSpec,
      hasCredentials: c.hasCredentials,
      credentialHint: c.credentialHint,
      probe: c.probe,
    }));
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

    const anthropicCompatProviders = [
      "minimax",
      "minimax-coding",
      "kimi",
      "kimi-coding",
      "qwen-cloud",
      "qwen-payg",
      "z-ai",
    ];
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
    } else if (providerName === "gemini" || providerName === "antigravity") {
      formatAdapterName = "GeminiAPIFormat";
      declaredStreamFormat = "gemini-sse";
    } else if (providerName === "ollamacloud") {
      formatAdapterName = "OllamaAPIFormat";
      declaredStreamFormat = "openai-sse";
    } else if (providerName === "litellm") {
      formatAdapterName = "LiteLLMAPIFormat";
      declaredStreamFormat = "openai-sse";
    } else if (providerName === "devin") {
      // Must come BEFORE the final else. Without it `--probe dv@…` reports
      // OpenAIAPIFormat / openai-sse — exactly the kind of silent wiring lie
      // --probe exists to prevent.
      formatAdapterName = "DevinAPIFormat";
      declaredStreamFormat = "connect-proto";
    } else {
      formatAdapterName = "OpenAIAPIFormat";
      declaredStreamFormat = "openai-sse";
    }

    const { resolveModelDialect } = await import("./adapters/dialect-manager.js");
    const modelTranslator = resolveModelDialect(modelName);
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
          const directProviderDef = getProviderByName(parsed.provider);
          const directHasCreds = directProviderDef?.isLocal
            ? isLocalProviderEnabled(parsed.provider)
            : directKeyInfo?.envVar
              ? !!process.env[directKeyInfo.envVar] ||
                (directKeyInfo.aliases?.some((a) => !!process.env[a]) ?? false)
              : true;
          const directCredentialHint =
            directProviderDef?.isLocal && !directHasCreds
              ? "enable local provider in global config"
              : directKeyInfo?.envVar;
          directProbeResult = await probeProviderRoute(
            liveProxy.url,
            {
              provider: parsed.provider,
              modelSpec: modelInput,
              hasCredentials: directHasCreds,
              credentialHint: directCredentialHint,
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
              return probeProviderRoute(
                liveProxy!.url,
                {
                  provider: link.provider,
                  modelSpec: link.modelSpec,
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
        try {
          await liveProxy.shutdown();
        } catch {
          /* ignore */
        }
      }
    }
    return;
  }

  // ── Interactive TUI path (OpenTUI React) ─────────────────────────
  const initialState: ProbeAppState = {
    steps: [],
    links: [],
    phase: "live",
    results: [],
    activeTab: "summary",
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
          const directProviderDef = getProviderByName(parsed.provider);
          const directHasCreds = directProviderDef?.isLocal
            ? isLocalProviderEnabled(parsed.provider)
            : directKeyInfo?.envVar
              ? !!process.env[directKeyInfo.envVar] ||
                (directKeyInfo.aliases?.some((a) => !!process.env[a]) ?? false)
              : true;
          const directCredentialHint =
            directProviderDef?.isLocal && !directHasCreds
              ? "enable local provider in global config"
              : directKeyInfo?.envVar;
          allLinks.push({
            id: `${modelInput}:direct`,
            displayName: parsed.provider,
            modelSpec: modelInput,
            provider: parsed.provider,
            pinnedSpec: modelInput,
            hasCredentials: directHasCreds,
            credentialHint: directCredentialHint,
            chainDetail: null,
            isDirect: true,
            modelInput,
          });
        }
        for (const link of chainDetails) {
          const pinnedSpec = pinProbeModelSpec(link);
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

        const result = await probeProviderRoute(
          liveProxy!.url,
          {
            provider: link.provider,
            modelSpec: link.modelSpec,
            hasCredentials: link.hasCredentials,
            credentialHint: link.credentialHint,
          },
          options.timeoutMs
        ).catch(
          (e): ProbeResult => ({
            state: "error",
            latencyMs: 0,
            errorMessage: String(e instanceof Error ? e.message : e),
          })
        );

        if (result.state === "live") {
          updateLink(link.id, {
            status: "live",
            endTime: Date.now(),
            timing: result.timing,
          });
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

    // Step 6: Compute wiring for each model while the progress UI is still up
    // (computeWiring does async imports we want to finish before the flip).
    // We build BOTH payloads from the same per-model data:
    //   - `printable` (PrintableModelResult) feeds the non-TTY static printer
    //     and the leaderboard-to-scrollback print on quit.
    //   - `results` (ProbeModelResult) feeds the interactive Details tab.
    const isLiveProbe = !!liveProxy;
    const printable: PrintableModelResult[] = [];
    const results: ProbeModelResult[] = [];
    for (const { modelInput, parsed, chain, chainDetails } of modelChains) {
      const wiring = await computeWiring(chainDetails, parsed.model);
      const directProbe = directProbeResults.get(modelInput);
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
        directProbe,
        wiring,
      });
      results.push({
        model: modelInput,
        nativeProvider: parsed.provider,
        isExplicit: parsed.isExplicitProvider,
        routingSource: chain.source,
        matchedPattern: chain.matchedPattern,
        routingExplanation: buildRoutingExplanation(parsed, chain),
        links: buildResultLinks(parsed, chainDetails, directProbe),
        wiring,
      });
    }

    // TTY gate: `process.stdout.isTTY` is the discriminator that distinguishes a
    // bare interactive run (both std streams are a TTY) from a `… | cat` pipe
    // (stdout is piped, stderr stays a TTY). The literal `stderr.isTTY` would
    // route `… | cat` to the interactive path and hang forever waiting for `q`.
    const interactive = !!process.stdout.isTTY && !!process.stderr.isTTY;

    if (interactive) {
      // STAY INSIDE THE TUI: land results + flip to the "done" phase (tabs),
      // keep the app alive, and wait for the user to quit (q / Esc). Nothing is
      // dumped to stdout. The live proxy can shut down now — all probes are done.
      if (liveProxy) {
        try {
          await liveProxy.shutdown();
        } catch {
          /* ignore */
        }
        liveProxy = null;
      }
      tui.store.setResults(results);
      await tui.waitForQuit();
      await tui.shutdown();
      // Clean exit: nothing dumped to scrollback. Everything (Summary,
      // Leaderboard, Details) was viewable in the tabs while the app ran.
    } else {
      // Non-TTY / piped path — keep today's behavior. Shut down the renderer
      // cleanly BEFORE printing static output (avoids the OpenTUI in-place
      // reconciliation bug) and print the full static results table to stderr.
      if (liveProxy) {
        try {
          await liveProxy.shutdown();
        } catch {
          /* ignore */
        }
        liveProxy = null;
      }
      await tui.shutdown();
      printProbeResults(printable, isLiveProbe);
    }
  } finally {
    if (liveProxy) {
      try {
        await liveProxy.shutdown();
      } catch {
        /* ignore */
      }
    }
    await tui.shutdown();
  }
}

/**
 * Print help message
 */
function printHelp(): void {
  // ── Color palette ─────────────────────────────────────────────────────────
  // Gated on an interactive stdout + the NO_COLOR convention so that
  // `claudish --help | less` / redirecting to a file stays free of escape codes.
  const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;
  const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
  const bold = c("1");
  const dim = c("2");
  const cyan = c("36"); // section headers
  const green = c("32"); // commands / flags
  const yellow = c("33"); // values / placeholders
  const magenta = c("35"); // provider shortcuts
  const blue = c("34"); // env var names
  // Section header helper — a colored, underlined title with a leading rule mark.
  const h = (title: string) => bold(cyan(`▌ ${title}`));

  console.log(`
${bold("claudish")} ${dim("·")} Run Claude Code with any AI model
${dim("OpenRouter · Gemini · OpenAI · xAI · MiniMax · Kimi · GLM · Z.AI · Sakana · Poe · LiteLLM · Local")}

${h("USAGE")}
  ${green("claudish")}                                ${dim("# Interactive mode (default, model selector)")}
  ${green("claudish")} ${yellow("[OPTIONS] <claude-args...>")}     ${dim("# Single-shot mode (requires --model)")}
  ${green("claudish")} ${green("--team")} ${yellow("a,b,c")} ${yellow('"prompt"')}          ${dim("# Run models in parallel (magmux grid)")}
  ${green("claudish")} ${green("--team")} ${yellow("a,b,c")} ${green("-f")} ${yellow("input.md")}       ${dim("# Team mode with file input")}

${h("MODEL ROUTING")}
  ${bold("New syntax:")} ${yellow("provider@model[:concurrency]")}
    ${magenta("google@gemini-3-pro")}              ${dim("Direct Google API (explicit)")}
    ${magenta("openrouter@google/gemini-3-pro")}   ${dim("OpenRouter (explicit)")}
    ${magenta("oai@gpt-5.3")}                      ${dim("Direct OpenAI API (shortcut)")}
    ${magenta("ollama@llama3.2:3")}                ${dim("Local Ollama, 3 concurrent requests")}
    ${magenta("ollama@llama3.2:0")}                ${dim("Local Ollama, no limits")}

  ${bold("Provider shortcuts:")}
    ${magenta("g, gemini")}      ${dim("->")} Google Gemini       ${dim("google@gemini-3-pro")}
    ${magenta("oai")}            ${dim("->")} OpenAI Direct       ${dim("oai@gpt-5.3")}
    ${magenta("cx, codex")}      ${dim("->")} OpenAI Codex        ${dim("cx@gpt-5.3 (Responses API)")}
    ${magenta("or")}             ${dim("->")} OpenRouter          ${dim("or@openai/gpt-5.3")}
    ${magenta("x-ai, xai, grok")} ${dim("->")} xAI / Grok         ${dim("x-ai@grok-3")}
    ${magenta("mm, mmax")}       ${dim("->")} MiniMax Direct      ${dim("mm@MiniMax-M2.1")}
    ${magenta("mmc")}            ${dim("->")} MiniMax Coding      ${dim("mmc@MiniMax-M2.1")}
    ${magenta("kimi, moon")}     ${dim("->")} Kimi Direct         ${dim("kimi@kimi-k2-thinking-turbo")}
    ${magenta("kc")}             ${dim("->")} Kimi Coding         ${dim("kc@kimi-k2-thinking-turbo")}
    ${magenta("glm, zhipu")}     ${dim("->")} GLM Direct          ${dim("glm@glm-4.7")}
    ${magenta("gc")}             ${dim("->")} GLM Coding          ${dim("gc@glm-4.7")}
    ${magenta("z-ai, zai")}      ${dim("->")} Z.AI Direct         ${dim("z-ai@glm-4.7")}
    ${magenta("oc, llama, lc, meta")} ${dim("->")} OllamaCloud    ${dim("oc@llama-3.1")}
    ${magenta("zen")}            ${dim("->")} OpenCode Zen        ${dim("zen@grok-code")}
    ${magenta("zengo, zgo")}     ${dim("->")} OpenCode Zen Go     ${dim("zengo@grok-code")}
    ${magenta("v, vertex")}      ${dim("->")} Vertex AI           ${dim("v@gemini-2.5-flash")}
    ${magenta("poe")}            ${dim("->")} Poe                 ${dim("poe@GPT-4o")}
    ${magenta("litellm, ll")}    ${dim("->")} LiteLLM             ${dim("ll@gpt-4o (needs LITELLM_BASE_URL)")}
    ${magenta("ds")}             ${dim("->")} DeepSeek            ${dim("ds@deepseek-chat")}
    ${magenta("sakana, fugu")}   ${dim("->")} Sakana Fugu         ${dim("fugu@fugu-ultra")}
    ${magenta("sc")}             ${dim("->")} Sakana Subscription ${dim("sc@fugu-ultra")}
    ${magenta("ollama")}         ${dim("->")} Ollama (local)      ${dim("ollama@llama3.2")}
    ${magenta("lms, lmstudio")}  ${dim("->")} LM Studio (local)   ${dim("lms@qwen")}
    ${magenta("vllm")}           ${dim("->")} vLLM (local)        ${dim("vllm@model")}
    ${magenta("mlx")}            ${dim("->")} MLX (local)         ${dim("mlx@model")}

  ${bold("Native auto-detection")} ${dim("(when no provider specified):")}
    ${yellow("google/*, gemini-*")}      ${dim("->")} Google API
    ${yellow("openai/*, gpt-*, o1-*")}   ${dim("->")} OpenAI API
    ${yellow("x-ai/*, grok-*")}          ${dim("->")} xAI
    ${yellow("meta-llama/*, llama-*")}   ${dim("->")} OllamaCloud
    ${yellow("minimax/*, abab-*")}       ${dim("->")} MiniMax API
    ${yellow("moonshot/*, kimi-*")}      ${dim("->")} Kimi API
    ${yellow("zhipu/*, glm-*")}          ${dim("->")} GLM API
    ${yellow("sakana/*, fugu-*")}        ${dim("->")} Sakana Fugu
    ${yellow("poe:*")}                   ${dim("->")} Poe
    ${yellow("anthropic/*, claude-*")}   ${dim("->")} Native Anthropic
    ${yellow("(unknown vendor/)")}       ${dim("->")} Error (use openrouter@vendor/model)

  ${dim("A defaultProvider (config / --default-provider) catches bare names that match no rule.")}

${h("OPTIONS")}
  ${green("-i, --interactive")}        Run in interactive mode (default when no prompt given)
  ${green("-m, --model")} ${yellow("<model>")}      Model to use (required for single-shot mode)
  ${green("--profile")} ${yellow("<name>")}         Use named profile for model mapping (default profile if omitted)
  ${green("--default-provider")} ${yellow("<name>")} Fallback provider for bare model names (builtin or customEndpoints key)
                           ${dim("Precedence: this flag > CLAUDISH_DEFAULT_PROVIDER env > config.json")}
  ${green("--anthropic-api-billing")}  Use your real ANTHROPIC_API_KEY for native Claude models
                           ${dim("(metered API billing). Default: the key is hidden so Claude Code")}
                           ${dim("uses your claude.ai subscription. Env: CLAUDISH_ANTHROPIC_API_BILLING")}
                           ${dim("Config: anthropicApiBilling: true")}
  ${green("--config")} ${yellow("<file>")}          Use THIS config file for the run, fully replacing the machine
                           ${dim("global (~/.claudish/config.json) AND project (.claudish.json).")}
                           ${dim("A file naming no op:// source never touches 1Password (no prompt).")}
                           ${dim("Env vars still resolve first. Env: CLAUDISH_CONFIG")}
  ${green("--op")} ${yellow("<op://glob>")}         Load API keys from a 1Password item glob (SDK-based, no op CLI)
  ${green("--op")} ${yellow("<glob>")} ${green("--list")}      Preview which fields the glob would import (names only, no values)
  ${green("--op-env")} ${yellow("<id>")}            Load env vars from a 1Password Environment (highest priority)
  ${green("--port")} ${yellow("<port>")}            Proxy server port (default: random)
  ${green("-d, --debug-claudish")}     Enable claudish debug logging to file (logs/claudish_*.log)
                           ${dim('Always-on: CLAUDISH_DEBUG=1 env var or "debug": true in config.json')}
  ${green("--no-debug-claudish")}      Force debug logging off for this run (when globally enabled)
  ${green("--log-off")}                Disable always-on structural logging (~/.claudish/logs/)
  ${green("--log-diag")} ${yellow("<mode>")}        Diagnostic output: auto (default), logfile, off
                           ${dim('Also: CLAUDISH_DIAG_MODE env var or "diagMode" in config.json')}
  ${green("--log-level")} ${yellow("<level>")}      Log verbosity: debug (full), info (truncated), minimal (labels)
  ${green("-q, --quiet")}              Suppress [claudish] log messages (default in single-shot mode)
  ${green("-v, --verbose")}            Show [claudish] log messages (default in interactive mode)
  ${green("--json")}                   Output JSON for tool integration (implies --quiet)
  ${green("--stdin")}                  Read prompt from stdin (large prompts / piping)
  ${green("--free")}                   Show only FREE models in the interactive selector
  ${green("--monitor")}                Monitor mode - proxy to REAL Anthropic API and log traffic
  ${green("--advisor")} ${yellow('"m1,m2[:collector]"')}  Multi-model advisor replacement (implies --monitor)
  ${green("-y, --auto-approve")}       Skip permission prompts (--dangerously-skip-permissions)
  ${green("--no-auto-approve")}        Explicitly enable permission prompts (default)
  ${green("--dangerous")}              Pass --dangerouslyDisableSandbox to Claude Code
  ${green("--cost-track")}             Enable cost tracking for API usage
  ${green("--cost-audit")}             Show cost analysis report
  ${green("--cost-reset")}             Reset accumulated cost statistics
  ${green("--version")}                Show version information
  ${green("-h, --help")}               Show this help message
  ${green("--help-ai")}                Show AI agent usage guide (file-based patterns, sub-agents)
  ${green("--init")}                   Install Claudish skill in current project (.claude/skills/)
  ${green("--")}                       Separator: everything after passes directly to Claude Code

${h("MODEL DISCOVERY")}
  ${green("--models")}                              Top 100 ranked (Firebase + local providers)
  ${green("--models --provider")} ${yellow("<slug>")}                Filter the catalog to one provider
                                          ${dim("e.g. --provider opencode-zen, anthropic, openai")}
  ${green("--providers")}                           Every provider + active-model count
  ${green("-s, --models-search")} ${yellow("<query>")}             Fuzzy search: id, brand synonyms (chatgpt,
                                          ${dim("claude, grok), gateways (zen, oc, codex), caps")}
  ${green("--models-top")}                          Curated recommended models (flagship + fast)
  ${green("--probe")} ${yellow("<models...>")}                    Probe each provider in the fallback chain with
                                          ${dim("a real 1-token request (may incur tiny cost)")}
  ${green("--no-probe")}                            Skip live requests, show static chain only
  ${green("--probe-timeout")} ${yellow("<secs>")}                 Per-link timeout for live probes (default: 40)
  ${green("--models-refresh")}                      Force refresh the slim model catalog from Firebase
  ${green("--models-skip-update")}                  Skip the launcher catalog warm step (offline)
  ${green("--json")}                                JSON output (with --models / --models-top / --probe)

${h("TEAM MODE")}
  ${green("--team")} ${yellow("<models>")}           Run multiple models in parallel (comma-separated)
                           ${dim('Example: --team minimax-m2.5,kimi-k2.5 "prompt"')}
  ${green("--mode")} ${yellow("<mode>")}             Team mode: default (grid), interactive, json
  ${green("-f, --file")} ${yellow("<path>")}         Read prompt from file (use with --team or single-shot)

${h("MODEL MAPPING")} ${dim("(per-role override)")}
  ${green("--model-opus")} ${yellow("<model>")}      Model for Opus role (planning, complex tasks)
  ${green("--model-sonnet")} ${yellow("<model>")}    Model for Sonnet role (default coding)
  ${green("--model-haiku")} ${yellow("<model>")}     Model for Haiku role (fast tasks, background)
  ${green("--model-subagent")} ${yellow("<model>")}  Model for sub-agents (Task tool)

${h("SUBCOMMANDS")}
  ${green("claudish config")}                        Open the interactive config TUI (profiles,
                                          ${dim("providers, routing, 1Password)")}
  ${green("claudish providers")} ${yellow("[--json]")}             Show provider credential status (no key material)
  ${green("claudish quota")} ${yellow("[provider]")}              Show remaining quota/usage (alias: usage)
  ${green("claudish serve")} ${yellow("--port <n> --models <p>")}  Run the Claude Desktop redirect gateway
  ${green("claudish update")}                        Check for updates and install the latest version

  ${bold("Profiles:")}
    ${green("claudish init")} ${yellow("[--local|--global]")}        Setup wizard - create config + first profile
    ${green("claudish profile list")} ${yellow("[scope]")}          List all profiles (both scopes by default)
    ${green("claudish profile add")} ${yellow("[scope]")}           Add a new profile
    ${green("claudish profile remove")} ${yellow("[name] [scope]")}  Remove a profile
    ${green("claudish profile use")} ${yellow("[name] [scope]")}     Set default profile
    ${green("claudish profile show")} ${yellow("[name] [scope]")}    Show profile details
    ${green("claudish profile edit")} ${yellow("[name] [scope]")}    Edit a profile
    ${dim("scope = --local (.claudish.json) | --global (~/.claudish/config.json) | (prompted)")}

  ${bold("Authentication:")}
    ${green("claudish login")} ${yellow("[provider]")}              Login to an OAuth provider (interactive if omitted)
    ${green("claudish logout")} ${yellow("[provider]")}             Clear OAuth credentials
    ${dim("Providers: gemini, kimi")}

${h("1PASSWORD")} ${dim("(SDK-based — no op CLI needed for secrets)")}
  ${dim("Auth via OP_SERVICE_ACCOUNT_TOKEN, or OP_ACCOUNT / onepasswordAccount config (DesktopAuth).")}
  ${green("--op")} ${yellow("<glob> --list")}        Preview which fields a glob would import (names only)
  ${green("--op")} ${yellow("<glob>")} ${yellow("[...args]")}      Resolve a glob into env vars, then run a session
                           ${dim("Inline op import requires a GLOB (self-names via field labels)")}
                           ${dim('Example: claudish --op "op://Jack/Keys/**" --model gpt-4o "task"')}
  ${green("--op-env")} ${yellow("<id>")}             Load a 1Password Environment (highest-priority source)
  ${dim("Persistent setup (single refs, sets, environments, account): claudish config -> 1Password tab")}

${h("CLAUDE CODE FLAG PASSTHROUGH")}
  ${dim("Any unrecognized flag is forwarded to Claude Code. Claudish flags can appear in any order.")}
    ${green("claudish")} --model grok ${yellow("--agent test")} ${yellow('"task"')}        ${dim("# --agent passes through")}
    ${green("claudish")} --model grok ${yellow("--effort high")} --stdin ${yellow('"task"')}  ${dim("# --effort passes, --stdin stays")}
    ${green("claudish")} --model grok ${yellow("--permission-mode plan")} -i   ${dim("# works in interactive too")}
  ${dim("Use -- when a Claude Code flag value starts with '-':")}
    ${green("claudish")} --model grok ${green("--")} ${yellow('--system-prompt "-verbose mode" "task"')}

${h("CUSTOM MODELS & ENDPOINTS")}
  ${dim("Claudish accepts ANY valid model ID from the Firebase catalog, even if not in --models:")}
    ${green("claudish")} --model ${yellow("openrouter@your_provider/custom-model-123")} ${yellow('"task"')}
  ${dim("Named custom endpoints live in ~/.claudish/config.json under 'customEndpoints' and route via @:")}
    ${green("claudish")} --model ${yellow("my-vllm@llama3.1-70b")} ${yellow('"task"')}

${h("MODES")}
  ${green("•")} ${bold("Interactive")} ${dim("(default):")} shows model selector, starts a persistent session
  ${green("•")} ${bold("Single-shot")} ${dim("(--model):")} runs one task headless and exits

${h("NOTES")}
  ${yellow("•")} Permission prompts are ${bold("ENABLED")} by default (normal Claude Code behavior)
  ${yellow("•")} Use ${green("-y")} / ${green("--auto-approve")} to skip permission prompts
  ${yellow("•")} Model selector appears ONLY in interactive mode when ${green("--model")} not specified
  ${yellow("•")} ${green("--dangerous")} disables the sandbox — use with extreme caution

${h("ENVIRONMENT VARIABLES")}
  ${dim("Claudish auto-loads a .env file from the current directory.")}

  ${bold("Claude Code installation:")}
  ${blue("CLAUDE_PATH")}                     Custom path to Claude Code binary
                                  ${dim("Search: CLAUDE_PATH -> ~/.claude/local/claude -> PATH")}

  ${bold("API keys")} ${dim("(at least one required for cloud models):")}
  ${blue("OPENROUTER_API_KEY")}              OpenRouter (default backend)
  ${blue("GEMINI_API_KEY")}                  Google Gemini ${dim("(g@, gemini@; alias GOOGLE_API_KEY)")}
  ${blue("OPENAI_API_KEY")}                  OpenAI ${dim("(oai@)")}
  ${blue("OPENAI_CODEX_API_KEY")}            OpenAI Codex / Responses API ${dim("(cx@, codex@)")}
  ${blue("XAI_API_KEY")}                     xAI / Grok ${dim("(x-ai@, grok@)")}
  ${blue("MINIMAX_API_KEY")}                 MiniMax ${dim("(mm@, mmax@)")}
  ${blue("MINIMAX_CODING_API_KEY")}          MiniMax Coding Plan ${dim("(mmc@)")}
  ${blue("MOONSHOT_API_KEY")}                Kimi / Moonshot ${dim("(kimi@, moon@; alias KIMI_API_KEY)")}
  ${blue("KIMI_CODING_API_KEY")}             Kimi Coding Plan ${dim("(kc@)")}
  ${blue("ZHIPU_API_KEY")}                   GLM / Zhipu ${dim("(glm@, zhipu@; alias GLM_API_KEY)")}
  ${blue("GLM_CODING_API_KEY")}              GLM Coding Plan ${dim("(gc@; alias ZAI_CODING_API_KEY)")}
  ${blue("ZAI_API_KEY")}                     Z.AI ${dim("(z-ai@, zai@)")}
  ${blue("DEEPSEEK_API_KEY")}                DeepSeek ${dim("(ds@)")}
  ${blue("SAKANA_API_KEY")}                  Sakana Fugu ${dim("(sakana@, fugu@)")}
  ${blue("SAKANA_SUBSCRIPTION_API_KEY")}     Sakana Fugu Subscription ${dim("(sc@; separate subscription key)")}
  ${blue("OLLAMA_API_KEY")}                  OllamaCloud ${dim("(oc@, llama@)")}
  ${blue("OPENCODE_API_KEY")}                OpenCode Zen ${dim("(zen@; optional - free models work without it)")}
  ${blue("POE_API_KEY")}                     Poe ${dim("(poe@)")}
  ${blue("LITELLM_API_KEY")}                 LiteLLM ${dim("(litellm@, ll@; needs LITELLM_BASE_URL)")}
  ${blue("VERTEX_API_KEY")}                  Vertex AI Express ${dim("(v@)")}
  ${blue("VERTEX_PROJECT")}                  Vertex AI project ID ${dim("(OAuth mode, v@)")}
  ${blue("VERTEX_LOCATION")}                 Vertex AI region ${dim("(default: us-central1)")}
  ${blue("ANTHROPIC_API_KEY")}               Placeholder (prevents Claude Code dialog)
  ${blue("ANTHROPIC_AUTH_TOKEN")}            Placeholder (prevents Claude Code login screen)

  ${bold("Custom / base-URL overrides:")}
  ${blue("GEMINI_BASE_URL")}                 Custom Gemini endpoint
  ${blue("OPENAI_BASE_URL")}                 Custom OpenAI / Azure endpoint
  ${blue("MINIMAX_BASE_URL")}                Custom MiniMax endpoint
  ${blue("MOONSHOT_BASE_URL")}               Custom Kimi / Moonshot endpoint ${dim("(alias KIMI_BASE_URL)")}
  ${blue("ZHIPU_BASE_URL")}                  Custom GLM / Zhipu endpoint ${dim("(alias GLM_BASE_URL)")}
  ${blue("SAKANA_BASE_URL")}                 Custom Sakana endpoint ${dim("(default: https://api.sakana.ai)")}
  ${blue("LITELLM_BASE_URL")}                LiteLLM gateway base URL ${dim("(required for ll@)")}
  ${blue("OLLAMACLOUD_BASE_URL")}            OllamaCloud ${dim("(default: https://ollama.com)")}
  ${blue("OPENCODE_BASE_URL")}               OpenCode Zen ${dim("(default: https://opencode.ai/zen)")}

  ${bold("Local providers:")}
  ${blue("OLLAMA_BASE_URL")}                 Ollama server ${dim("(default: http://localhost:11434; alias OLLAMA_HOST)")}
  ${blue("LMSTUDIO_BASE_URL")}               LM Studio server ${dim("(default: http://localhost:1234)")}
  ${blue("VLLM_BASE_URL")}                   vLLM server ${dim("(default: http://localhost:8000)")}
  ${blue("MLX_BASE_URL")}                    MLX server ${dim("(default: http://127.0.0.1:8080)")}

  ${bold("Claudish settings:")}
  ${blue("CLAUDISH_MODEL")}                  Default model ${dim("(default: openai/gpt-5.3)")}
  ${blue("CLAUDISH_DEFAULT_PROVIDER")}       Fallback provider for bare names ${dim("(see --default-provider)")}
  ${blue("CLAUDISH_PORT")}                   Default proxy port
  ${blue("CLAUDISH_CONTEXT_WINDOW")}         Override context window size
  ${blue("CLAUDISH_DIAG_MODE")}              Diagnostic output: auto / logfile / off
  ${blue("CLAUDISH_DEBUG")}                  Always enable debug logging: 1 / true ${dim("(same as -d)")}
  ${blue("CLAUDISH_ANTHROPIC_API_BILLING")}  Bill native Claude to your API key ${dim("(see --anthropic-api-billing)")}
  ${blue("CLAUDISH_MCP_TOOLS")}              MCP tool gating: all / low-level / agentic / channel
  ${blue("CLAUDISH_MODEL_OPUS")}             Override model for Opus role
  ${blue("CLAUDISH_MODEL_SONNET")}           Override model for Sonnet role
  ${blue("CLAUDISH_MODEL_HAIKU")}            Override model for Haiku role
  ${blue("CLAUDISH_MODEL_SUBAGENT")}         Override model for sub-agents
  ${blue("NO_COLOR")}                        Set to disable colored output

  ${bold("1Password auth:")}
  ${blue("OP_SERVICE_ACCOUNT_TOKEN")}        Service-account token (preferred for headless)
  ${blue("OP_ACCOUNT")}                      Account URL for DesktopAuth ${dim("(e.g. my-team.1password.com)")}

${h("EXAMPLES")}
  ${dim("# Interactive (default) - model selector")}
  ${green("claudish")}
  ${green("claudish")} --free                          ${dim("# only FREE models")}

  ${dim("# Explicit provider routing")}
  ${green("claudish")} --model ${magenta("google@gemini-3-pro")} ${yellow('"implement auth"')}
  ${green("claudish")} --model ${magenta("oai@gpt-5.3")} ${yellow('"add tests for login"')}
  ${green("claudish")} --model ${magenta("openrouter@deepseek/deepseek-r1")} ${yellow('"unknown vendor"')}

  ${dim("# Native auto-detection (provider inferred from model name)")}
  ${green("claudish")} --model ${yellow("gpt-4o")} ${yellow('"routes to OpenAI"')}
  ${green("claudish")} --model ${yellow("gemini-2.5-pro")} ${yellow('"routes to Google"')}

  ${dim("# Per-role model mapping")}
  ${green("claudish")} --model-opus ${magenta("oai@gpt-5.3")} --model-sonnet ${magenta("google@gemini-3-pro")}

  ${dim("# stdin for large prompts (diffs, code review)")}
  ${dim("git diff |")} ${green("claudish")} --stdin --model ${magenta("oai@gpt-5.3")} ${yellow('"Review these changes"')}

  ${dim("# Local models with concurrency control")}
  ${green("claudish")} --model ${magenta("ollama@llama3.2:3")} ${yellow('"3 concurrent requests"')}
  ${green("claudish")} --model ${magenta("lms@qwen2.5-coder")} ${yellow('"LM Studio shortcut"')}
  ${green("claudish")} --model ${yellow('"http://localhost:8000/mistral"')} ${yellow('"any OpenAI-compatible URL"')}

  ${dim("# Autonomous (no prompts, no sandbox) — use with caution")}
  ${green("claudish")} -y --dangerous ${yellow('"refactor entire codebase"')}

${h("MORE INFO")}
  ${dim("GitHub:")}     ${blue("https://github.com/MadAppGang/claude-code")}
  ${dim("OpenRouter:")} ${blue("https://openrouter.ai")}
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
    console.log("\nAvailable models (type `claudish --models-top` for full table):\n");
    for (const model of basicModels) {
      const info = modelInfo[model];
      if (!info) continue;
      console.log(`  ${model}`);
      console.log(`    ${info.name} - ${info.description}`);
    }
    console.log("");
  } catch (error) {
    console.error(
      `Failed to load available models: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
